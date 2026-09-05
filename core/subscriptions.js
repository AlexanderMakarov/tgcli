/**
 * In-process event bus for message subscriptions.
 *
 * Deliberately holds no persistent state: the message archive is the durable
 * log, and each consumer owns its own cursor. A subscriber that disconnects
 * resumes by asking for everything after the last id it handled, which makes
 * reconnecting the same code path as connecting for the first time.
 */

/** Event types a caller may subscribe to. */
export const SUBSCRIBABLE_TYPES = Object.freeze(['message.new', 'message.edit']);

/** Does this event pass a subscriber's channel + type filter? */
export function matchesFilter(event, filter) {
  if (!filter.channels.has(event.channelId)) {
    return false;
  }
  return filter.types.has(event.type);
}

export class SubscriptionHub {
  constructor() {
    this.subscribers = new Set();
  }

  /** Register a handler; returns an idempotent unsubscribe function. */
  subscribe(filter, handler) {
    const entry = { filter, handler };
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }

  /**
   * Fan an event out to matching subscribers. A throwing subscriber must not
   * break its peers, and must never propagate into the ingest path that called
   * publish() — losing an archived message to a misbehaving consumer would be
   * far worse than dropping one delivery.
   */
  publish(event) {
    for (const entry of this.subscribers) {
      if (!matchesFilter(event, entry.filter)) {
        continue;
      }
      try {
        entry.handler(event);
      } catch (error) {
        console.error(`[subscriptions] subscriber failed: ${error?.message ?? error}`);
      }
    }
  }

  get size() {
    return this.subscribers.size;
  }
}

/**
 * Parse `?channels=&types=&since=` into a filter plus a replay cursor.
 *
 * Channel ids are used verbatim. They must be archive-form ("-100…" for
 * supergroups and channels, a plain id for DMs) — the same form
 * listActiveChannels and messagesList return. Deriving that form here is not
 * possible without guessing: prefixing every positive id with "-100" would
 * silently mis-route direct messages.
 */
export function parseSubscribeQuery(searchParams) {
  const rawChannels = (searchParams.get('channels') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!rawChannels.length) {
    return { ok: false, error: 'channels is required (comma-separated channel ids)' };
  }

  const channels = new Set(rawChannels);

  const rawTypes = (searchParams.get('types') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const types = new Set(rawTypes.length ? rawTypes : SUBSCRIBABLE_TYPES);
  for (const type of types) {
    if (!SUBSCRIBABLE_TYPES.includes(type)) {
      return { ok: false, error: `unknown event type: ${type}` };
    }
  }

  const rawSince = searchParams.get('since');
  let since = null;
  if (rawSince !== null && rawSince !== '') {
    since = Number(rawSince);
    if (!Number.isInteger(since) || since < 0) {
      return { ok: false, error: `since must be a non-negative integer, got: ${rawSince}` };
    }
  }

  return { ok: true, filter: { channels, types }, since };
}

/** Write one SSE frame. */
function writeEvent(res, { type, id, data }) {
  if (id !== undefined && id !== null) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Serve GET /subscribe as Server-Sent Events.
 *
 * Ordering is the whole point. The live listener is attached and buffered
 * BEFORE the archive replay runs; the buffer is then flushed with any id the
 * replay already sent filtered out. Replaying first and subscribing after
 * would silently drop every message that arrived in between — precisely the
 * window a reconnecting consumer is trying to close.
 */
export function handleSubscribeRequest({
  req,
  res,
  url,
  hub,
  replay,
  maxReplay = 500,
  heartbeatMs = 25_000,
}) {
  const parsed = parseSubscribeQuery(url.searchParams);
  if (!parsed.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: parsed.error }));
    return { close() {} };
  }

  const { filter, since } = parsed;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Node holds headers back until the first body write. A live-only
  // subscription may not write for hours, which leaves the client's request
  // promise unresolved and looking like a hang. Flush, then prime the stream
  // with a comment so intermediaries see bytes immediately.
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const sentIds = new Set();
  let buffered = [];
  let replaying = true;

  const deliver = (event) => {
    // An edit re-sends an id the consumer has already seen, by design; only
    // new-message duplicates from the replay/live overlap are suppressed.
    if (event.type === 'message.new' && sentIds.has(event.messageId)) {
      return;
    }
    sentIds.add(event.messageId);
    writeEvent(res, { type: event.type, id: event.messageId, data: event.message });
  };

  // 1. Attach and buffer FIRST.
  const unsubscribe = hub.subscribe(filter, (event) => {
    if (replaying) {
      buffered.push(event);
      return;
    }
    deliver(event);
  });

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, heartbeatMs);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) {
      res.end();
    }
  };

  req.on('close', close);
  req.on('error', close);

  // 2. Replay, then 3. flush the buffer minus what replay already covered.
  try {
    if (since !== null) {
      const rows = replay({
        channelIds: [...filter.channels],
        sinceMessageId: since,
        limit: maxReplay + 1,
      });

      if (rows.length > maxReplay) {
        const newest = rows[rows.length - 1];
        writeEvent(res, {
          type: 'gap',
          data: {
            reason: 'replay_limit_exceeded',
            maxReplay,
            sinceMessageId: since,
            newestMessageId: newest.messageId,
          },
        });
      } else {
        for (const row of rows) {
          sentIds.add(row.messageId);
          writeEvent(res, { type: 'message.new', id: row.messageId, data: row });
        }
      }
    }
  } catch (error) {
    console.error(`[subscriptions] replay failed: ${error?.message ?? error}`);
    writeEvent(res, { type: 'error', data: { message: 'replay failed' } });
  }

  replaying = false;
  const pending = buffered;
  buffered = [];
  for (const event of pending) {
    deliver(event);
  }

  return { close };
}

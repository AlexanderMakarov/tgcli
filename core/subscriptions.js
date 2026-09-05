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

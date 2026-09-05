import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { SubscriptionHub, handleSubscribeRequest } from '../core/subscriptions.js';

let server;
let hub;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

/** Start a server whose only route is /subscribe, and return its base URL. */
async function startServer({ replay = () => [], maxReplay = 500 } = {}) {
  hub = new SubscriptionHub();
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleSubscribeRequest({
      req,
      res,
      url,
      hub,
      replay,
      maxReplay,
      heartbeatMs: 50_000,
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Read SSE frames until `count` `data:` lines have arrived, then release the stream. */
async function readEvents(response, count, timeoutMs = 2000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const lines = frame.split('\n');
      const dataLine = lines.find((line) => line.startsWith('data:'));
      const eventLine = lines.find((line) => line.startsWith('event:'));
      if (dataLine) {
        events.push({
          type: eventLine ? eventLine.slice(6).trim() : null,
          data: JSON.parse(dataLine.slice(5).trim()),
        });
      }
    }
  }
  await reader.cancel();
  return events;
}

const archived = (id) => ({ channelId: '-1003713035210', messageId: id, text: `m${id}` });

describe('handleSubscribeRequest', () => {
  it('rejects a request with no channels param', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/subscribe`);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/channels/);
  });

  it('sends SSE headers', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/subscribe?channels=-1003713035210`);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(response.headers.get('cache-control')).toMatch(/no-cache/);
    await response.body.cancel();
  });

  it('replays archived messages past the cursor, ascending', async () => {
    const base = await startServer({
      replay: ({ sinceMessageId }) => [archived(12), archived(13)].filter((m) => m.messageId > sinceMessageId),
    });
    const response = await fetch(`${base}/subscribe?channels=-1003713035210&since=11`);
    const events = await readEvents(response, 2);

    expect(events.map((e) => e.data.messageId)).toEqual([12, 13]);
    expect(events[0].type).toBe('message.new');
  });

  it('does not replay when since is omitted', async () => {
    const base = await startServer({ replay: () => [archived(1), archived(2)] });
    const response = await fetch(`${base}/subscribe?channels=-1003713035210`);

    setTimeout(() => {
      hub.publish({ type: 'message.new', channelId: '-1003713035210', messageId: 99, message: archived(99) });
    }, 50);

    const events = await readEvents(response, 1);
    expect(events.map((e) => e.data.messageId)).toEqual([99]);
  });

  it('streams live events published after connect', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/subscribe?channels=-1003713035210`);

    setTimeout(() => {
      hub.publish({ type: 'message.new', channelId: '-1003713035210', messageId: 155, message: archived(155) });
      hub.publish({ type: 'message.edit', channelId: '-1003713035210', messageId: 155, message: archived(155) });
    }, 50);

    const events = await readEvents(response, 2);
    expect(events.map((e) => e.type)).toEqual(['message.new', 'message.edit']);
  });

  it('does not drop a message published during replay, and does not duplicate it', async () => {
    // The race this whole design exists for: replay is slow, a live message
    // lands mid-replay. It must be delivered exactly once.
    const base = await startServer({
      replay: ({ sinceMessageId }) => {
        hub.publish({ type: 'message.new', channelId: '-1003713035210', messageId: 20, message: archived(20) });
        hub.publish({ type: 'message.new', channelId: '-1003713035210', messageId: 21, message: archived(21) });
        return [archived(19), archived(20)].filter((m) => m.messageId > sinceMessageId);
      },
    });

    const response = await fetch(`${base}/subscribe?channels=-1003713035210&since=18`);
    const events = await readEvents(response, 3);

    expect(events.map((e) => e.data.messageId)).toEqual([19, 20, 21]);
  });

  it('emits a gap event instead of replaying more than maxReplay', async () => {
    const base = await startServer({
      maxReplay: 2,
      replay: () => [archived(1), archived(2), archived(3)],
    });
    const response = await fetch(`${base}/subscribe?channels=-1003713035210&since=0`);
    const events = await readEvents(response, 1);

    expect(events[0].type).toBe('gap');
    expect(events[0].data.newestMessageId).toBe(3);
  });

  it('unsubscribes when the client disconnects', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/subscribe?channels=-1003713035210`);
    expect(hub.size).toBe(1);

    await response.body.cancel();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hub.size).toBe(0);
  });
});

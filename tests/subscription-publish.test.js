import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MessageSyncService from '../message-sync-service.js';

let service;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-test-'));
  service = new MessageSyncService(null, { dbPath: path.join(tmpDir, 'messages.db') });
});

afterEach(() => {
  service?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed(channelId, messageId, text) {
  service.db.prepare(`
    INSERT INTO channels (channel_id, peer_title, sync_enabled)
    VALUES (?, ?, 1)
    ON CONFLICT(channel_id) DO NOTHING
  `).run(channelId, 'Test Chat');
  service.db.prepare(`
    INSERT INTO messages (channel_id, message_id, date, from_id, text, topic_id)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(channelId, messageId, 1757000000 + messageId, '1', text);
}

describe('MessageSyncService subscriptions', () => {
  it('exposes a SubscriptionHub', () => {
    expect(service.subscriptions).toBeDefined();
    expect(typeof service.subscriptions.publish).toBe('function');
  });

  it('publishes an event carrying the archived row shape', () => {
    const handler = vi.fn();
    service.subscriptions.subscribe(
      { channels: new Set(['-1003713035210']), types: new Set(['message.new']) },
      handler,
    );

    seed('-1003713035210', 200, 'Բարև');
    service._publishSubscriptionEvent('-1003713035210', 200, false);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe('message.new');
    expect(event.messageId).toBe(200);
    expect(event.message.text).toBe('Բարև');
  });

  it('publishes message.edit when isEdit is true', () => {
    const handler = vi.fn();
    service.subscriptions.subscribe(
      { channels: new Set(['-1003713035210']), types: new Set(['message.edit']) },
      handler,
    );

    seed('-1003713035210', 201, 'edited');
    service._publishSubscriptionEvent('-1003713035210', 201, true);

    expect(handler.mock.calls[0][0].type).toBe('message.edit');
  });

  it('does not throw when the message is not in the archive', () => {
    service.subscriptions.subscribe(
      { channels: new Set(['-1003713035210']), types: new Set(['message.new']) },
      () => {},
    );
    expect(() => service._publishSubscriptionEvent('-1003713035210', 999, false)).not.toThrow();
  });

  it('is a no-op with no subscribers', () => {
    seed('-1003713035210', 202, 'nobody listening');
    expect(() => service._publishSubscriptionEvent('-1003713035210', 202, false)).not.toThrow();
  });
});

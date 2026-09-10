const mtcuteClientCtor = vi.hoisted(() => vi.fn(function () {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
    onRawUpdate: { remove: vi.fn() },
  };
}));

vi.mock('@mtcute/node', () => ({
  TelegramClient: mtcuteClientCtor,
}));

vi.mock('@mtcute/core', () => ({
  InputMedia: {},
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import TelegramClient from '../telegram-client.js';
import MessageSyncService from '../message-sync-service.js';

/**
 * When a message was last edited is a different fact from when it was posted,
 * and only the former answers "is the translation I am reading current?".
 * mtcute exposes it as `Message.editDate`; these tests pin it all the way
 * through serialization, the archive and the subscription payload.
 */

function client() {
  return new TelegramClient(1, 'hash', '+10000000000', '/tmp/tgcli-edit-date.session', {
    disableUpdates: true,
  });
}

describe('_serializeMessage edit date', () => {
  it('carries editDate through as a unix timestamp', () => {
    const serialized = client()._serializeMessage({
      id: 42,
      date: new Date('2026-09-10T12:00:00Z'),
      editDate: new Date('2026-09-10T12:30:00Z'),
      text: 'Բարև',
    });

    expect(serialized.date).toBe(Math.floor(Date.UTC(2026, 8, 10, 12, 0, 0) / 1000));
    expect(serialized.edit_date).toBe(Math.floor(Date.UTC(2026, 8, 10, 12, 30, 0) / 1000));
  });

  it('reports a never-edited message as null, not as its post date', () => {
    const serialized = client()._serializeMessage({
      id: 42,
      date: new Date('2026-09-10T12:00:00Z'),
      editDate: null,
      text: 'Բարև',
    });

    expect(serialized.edit_date).toBeNull();
  });
});

describe('archived edit date', () => {
  let service;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-edit-date-'));
    service = new MessageSyncService(null, { dbPath: path.join(tmpDir, 'messages.db') });
  });

  afterEach(() => {
    service?.db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedChannel(channelId) {
    service.db.prepare(`
      INSERT INTO channels (channel_id, peer_title, sync_enabled)
      VALUES (?, ?, 1)
      ON CONFLICT(channel_id) DO NOTHING
    `).run(channelId, 'Test Chat');
  }

  it('stores edit_date and returns it as an ISO string', () => {
    seedChannel('-1003713035210');
    service.db.prepare(`
      INSERT INTO messages (channel_id, message_id, date, edit_date, from_id, text, topic_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run('-1003713035210', 300, 1757000000, 1757003600, '1', 'Բարև');

    const message = service.getArchivedMessage({ channelId: '-1003713035210', messageId: 300 });

    expect(message.date).toBe(new Date(1757000000 * 1000).toISOString());
    expect(message.editDate).toBe(new Date(1757003600 * 1000).toISOString());
  });

  it('reports editDate as null for a message that was never edited', () => {
    seedChannel('-1003713035210');
    service.db.prepare(`
      INSERT INTO messages (channel_id, message_id, date, from_id, text, topic_id)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run('-1003713035210', 301, 1757000000, '1', 'Բարև');

    const message = service.getArchivedMessage({ channelId: '-1003713035210', messageId: 301 });

    expect(message.editDate).toBeNull();
  });

  it('publishes editDate on the subscription event an edit produces', () => {
    const handler = vi.fn();
    service.subscriptions.subscribe(
      { channels: new Set(['-1003713035210']), types: new Set(['message.edit']) },
      handler,
    );

    seedChannel('-1003713035210');
    service.db.prepare(`
      INSERT INTO messages (channel_id, message_id, date, edit_date, from_id, text, topic_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run('-1003713035210', 302, 1757000000, 1757003600, '1', 'Բարև');

    service._publishSubscriptionEvent('-1003713035210', 302, true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].message.editDate).toBe(new Date(1757003600 * 1000).toISOString());
  });

  it('persists edit_date when an edit is archived', () => {
    seedChannel('-1003713035210');
    const record = service._buildMessageRecord('-1003713035210', {
      id: 303,
      date: 1757000000,
      edit_date: 1757003600,
      from_id: '1',
      text: 'Բարև',
    });
    service.upsertMessageStmt.run(record);

    const message = service.getArchivedMessage({ channelId: '-1003713035210', messageId: 303 });

    expect(message.editDate).toBe(new Date(1757003600 * 1000).toISOString());
  });
});

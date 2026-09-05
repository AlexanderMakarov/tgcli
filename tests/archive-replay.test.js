import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MessageSyncService from '../message-sync-service.js';

let service;
let tmpDir;

function seedMessage(db, { channelId, messageId, date, text }) {
  db.prepare(`
    INSERT INTO channels (channel_id, peer_title, sync_enabled)
    VALUES (?, ?, 1)
    ON CONFLICT(channel_id) DO NOTHING
  `).run(channelId, 'Test Chat');
  db.prepare(`
    INSERT INTO messages (channel_id, message_id, date, from_id, text, topic_id)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(channelId, messageId, date, '1', text);
}

// MessageSyncService is a DEFAULT export and its constructor is
// (telegramClient, { dbPath }) — it always opens a real file via
// new Database(path.resolve(dbPath)), so ':memory:' would resolve to a literal
// file named ':memory:'. Use a temp directory instead. telegramClient is null:
// none of the methods under test touch it.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-test-'));
  service = new MessageSyncService(null, { dbPath: path.join(tmpDir, 'messages.db') });
});

afterEach(() => {
  service?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('listArchivedMessagesSince', () => {
  it('returns only messages newer than the cursor, ascending', () => {
    const db = service.db;
    for (const id of [10, 11, 12, 13]) {
      seedMessage(db, { channelId: '-1003713035210', messageId: id, date: 1757000000 + id, text: `m${id}` });
    }

    const rows = service.listArchivedMessagesSince({
      channelIds: ['-1003713035210'],
      sinceMessageId: 11,
      limit: 100,
    });

    expect(rows.map((r) => r.messageId)).toEqual([12, 13]);
  });

  it('returns everything when the cursor is 0', () => {
    seedMessage(service.db, { channelId: '-1003713035210', messageId: 5, date: 1757000005, text: 'a' });

    const rows = service.listArchivedMessagesSince({
      channelIds: ['-1003713035210'],
      sinceMessageId: 0,
      limit: 100,
    });

    expect(rows.map((r) => r.messageId)).toEqual([5]);
  });

  it('filters by channel', () => {
    const db = service.db;
    seedMessage(db, { channelId: '-1003713035210', messageId: 1, date: 1757000001, text: 'ours' });
    seedMessage(db, { channelId: '-1009999999999', messageId: 2, date: 1757000002, text: 'theirs' });

    const rows = service.listArchivedMessagesSince({
      channelIds: ['-1003713035210'],
      sinceMessageId: 0,
      limit: 100,
    });

    expect(rows.map((r) => r.text)).toEqual(['ours']);
  });

  it('respects the limit, keeping the oldest of the pending messages', () => {
    const db = service.db;
    for (const id of [1, 2, 3, 4, 5]) {
      seedMessage(db, { channelId: '-1003713035210', messageId: id, date: 1757000000 + id, text: `m${id}` });
    }

    const rows = service.listArchivedMessagesSince({
      channelIds: ['-1003713035210'],
      sinceMessageId: 0,
      limit: 2,
    });

    expect(rows.map((r) => r.messageId)).toEqual([1, 2]);
  });

  it('returns an empty array when no channels are given', () => {
    const rows = service.listArchivedMessagesSince({ channelIds: [], sinceMessageId: 0, limit: 10 });
    expect(rows).toEqual([]);
  });
});

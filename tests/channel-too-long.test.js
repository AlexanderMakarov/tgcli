import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MessageSyncService from '../message-sync-service.js';

/**
 * Telegram sends `channelDifferenceTooLong` when the gap is too large to
 * express as a diff. mtcute hands us the BARE channel id (3713035210) while the
 * archive is keyed on the MARKED form (-1003713035210) — every other code path
 * gets the marked id from `message.chat.id`, which is exactly what an empty
 * diff does not have.
 */
const BARE_ID = 3713035210;
const MARKED_ID = '-1003713035210';

let service;
let tmpDir;
let telegramClient;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-toolong-'));
  telegramClient = {
    getMessagesByChannelId: vi.fn(async () => ({
      peerTitle: 'Test Chat',
      peerType: 'channel',
      messages: [],
    })),
    _serializeMessage: vi.fn(),
  };
  service = new MessageSyncService(telegramClient, { dbPath: path.join(tmpDir, 'messages.db') });
});

afterEach(() => {
  service?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedChannel(channelId, lastMessageId) {
  service.db.prepare(`
    INSERT INTO channels (channel_id, peer_title, peer_type, sync_enabled, last_message_id)
    VALUES (?, 'Test Chat', 'channel', 1, ?)
  `).run(channelId, lastMessageId);
}

function archivedIds(channelId) {
  return service.db
    .prepare('SELECT message_id FROM messages WHERE channel_id = ? ORDER BY message_id')
    .all(channelId)
    .map(row => row.message_id);
}

function liveMessages(ids) {
  return ids.map(id => ({ id, date: 1757000000 + id, text: `msg ${id}`, from: { id: 1 } }));
}

describe('_handleChannelTooLong', () => {
  it('runs the catch-up when the diff carries no messages', async () => {
    // The bug: this is CHANNEL_TOO_LONG's common shape, and it is precisely
    // when a full resync is most needed.
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId
      .mockResolvedValueOnce({ peerTitle: 'Test Chat', peerType: 'channel', messages: liveMessages([101, 102, 103]) })
      .mockResolvedValue({ peerTitle: 'Test Chat', peerType: 'channel', messages: [] });

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    expect(archivedIds(MARKED_ID)).toEqual([101, 102, 103]);
  });

  it('addresses the archive by its marked channel id, not the bare update id', async () => {
    // A catch-up keyed on the bare id finds no channel row and returns early —
    // silently, which is indistinguishable from the bug it is meant to fix.
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId
      .mockResolvedValueOnce({ peerTitle: 'Test Chat', peerType: 'channel', messages: liveMessages([101]) })
      .mockResolvedValue({ peerTitle: 'Test Chat', peerType: 'channel', messages: [] });

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    expect(telegramClient.getMessagesByChannelId).toHaveBeenCalled();
    expect(telegramClient.getMessagesByChannelId.mock.calls[0][0]).toBe(MARKED_ID);
    expect(service._getChannel(MARKED_ID).last_message_id).toBe(101);
  });

  it('advances the cursor so the next catch-up does not refetch', async () => {
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId
      .mockResolvedValueOnce({ peerTitle: 'Test Chat', peerType: 'channel', messages: liveMessages([101, 102]) })
      .mockResolvedValue({ peerTitle: 'Test Chat', peerType: 'channel', messages: [] });

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    expect(service._getChannel(MARKED_ID).last_message_id).toBe(102);
    // The first page starts from the stored cursor, not from zero.
    expect(telegramClient.getMessagesByChannelId.mock.calls[0][2]).toEqual({ minId: 100 });

    // A second TooLong resumes from the advanced cursor rather than refetching.
    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });
    expect(telegramClient.getMessagesByChannelId.mock.calls.at(-1)[2]).toEqual({ minId: 102 });
    expect(archivedIds(MARKED_ID)).toEqual([101, 102]);
  });

  it('skips a channel that is not synced', async () => {
    seedChannel(MARKED_ID, 100);
    service.db.prepare('UPDATE channels SET sync_enabled = 0 WHERE channel_id = ?').run(MARKED_ID);

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    expect(telegramClient.getMessagesByChannelId).not.toHaveBeenCalled();
  });

  it('does not reject when the catch-up fails, and says so', async () => {
    // Fire-and-forget swallowed this; an unhandled rejection can take the
    // process down and leaves the hole with nothing in the logs.
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId.mockRejectedValue(new Error('FLOOD_WAIT_420'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('FLOOD_WAIT_420');
    warn.mockRestore();
  });
});

describe('_handleChannelTooLong retry', () => {
  it('queues a durable retry when the catch-up dies partway', async () => {
    // TooLong fires when Telegram decides to — possibly never again for a quiet
    // channel — so a failed catch-up must leave something behind that will run.
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId.mockRejectedValue(new Error('FLOOD_WAIT_420'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    const jobs = service.listJobs({ channelId: MARKED_ID });
    expect(jobs).toHaveLength(1);
    // Either still queued or already claimed by the queue loop — both mean the
    // retry is live. What matters is that something exists to run it.
    expect(['pending', 'in_progress']).toContain(jobs[0].status);
    vi.restoreAllMocks();
  });

  it('coalesces repeated failures into one job rather than a queue of them', async () => {
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId.mockRejectedValue(new Error('FLOOD_WAIT_420'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 5; i += 1) {
      await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });
    }

    expect(service.listJobs({ channelId: MARKED_ID })).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('queues nothing when the catch-up succeeds', async () => {
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId
      .mockResolvedValueOnce({ peerTitle: 'Test Chat', peerType: 'channel', messages: liveMessages([101]) })
      .mockResolvedValue({ peerTitle: 'Test Chat', peerType: 'channel', messages: [] });

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    expect(service.listJobs({ channelId: MARKED_ID })).toHaveLength(0);
  });
});

describe('_handleChannelTooLong retry scope', () => {
  it('scopes the retry to syncing forward, not backfilling old history', async () => {
    // The queue's default depth is 1000 messages; a channel below that would
    // otherwise have the retry drag in history nobody asked for.
    seedChannel(MARKED_ID, 100);
    service.db.prepare(`
      INSERT INTO messages (channel_id, message_id, date, from_id, text, topic_id)
      VALUES (?, 100, 1757000100, '1', 'only one', NULL)
    `).run(MARKED_ID);
    telegramClient.getMessagesByChannelId.mockRejectedValue(new Error('FLOOD_WAIT_420'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    const job = service.listJobs({ channelId: MARKED_ID })[0];
    expect(job.target_message_count).toBe(1);   // == archived count, not 1000
    vi.restoreAllMocks();
  });
});

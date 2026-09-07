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

describe('reconcileChannelsAgainstLive', () => {
  it('advances a lagging archive and reports what it healed', async () => {
    seedChannel(MARKED_ID, 158);
    telegramClient.getMessagesByChannelId
      .mockResolvedValueOnce({ peerTitle: 'Test Chat', peerType: 'channel', messages: liveMessages([159, 160]) })
      .mockResolvedValue({ peerTitle: 'Test Chat', peerType: 'channel', messages: [] });

    const result = await service.reconcileChannelsAgainstLive([MARKED_ID]);

    expect(archivedIds(MARKED_ID)).toEqual([159, 160]);
    expect(result.healed).toEqual([{ channelId: MARKED_ID, from: 158, to: 160 }]);
    expect(result.failed).toEqual([]);
  });

  it('reports nothing healed when the archive is already level', async () => {
    // The common case, and it must cost exactly one live call and no writes.
    seedChannel(MARKED_ID, 160);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Test Chat', peerType: 'channel', messages: [],
    });

    const result = await service.reconcileChannelsAgainstLive([MARKED_ID]);

    expect(result.healed).toEqual([]);
    expect(telegramClient.getMessagesByChannelId).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing channel so the others still reconcile', async () => {
    seedChannel(MARKED_ID, 158);
    seedChannel('-100999', 10);
    telegramClient.getMessagesByChannelId.mockImplementation(async (channelId) => {
      if (channelId === MARKED_ID) throw new Error('FLOOD_WAIT_420');
      return { peerTitle: 'Other', peerType: 'channel', messages: liveMessages([11]) };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await service.reconcileChannelsAgainstLive([MARKED_ID, '-100999']);

    expect(result.failed).toEqual([MARKED_ID]);
    expect(result.healed).toEqual([{ channelId: '-100999', from: 10, to: 11 }]);
    warn.mockRestore();
  });

  it('skips a channel that is not synced', async () => {
    seedChannel(MARKED_ID, 158);
    service.db.prepare('UPDATE channels SET sync_enabled = 0 WHERE channel_id = ?').run(MARKED_ID);

    await service.reconcileChannelsAgainstLive([MARKED_ID]);

    expect(telegramClient.getMessagesByChannelId).not.toHaveBeenCalled();
  });

  it('gives up on a stuck channel instead of holding the subscription open', async () => {
    seedChannel(MARKED_ID, 158);
    telegramClient.getMessagesByChannelId.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await service.reconcileChannelsAgainstLive([MARKED_ID], { timeoutMs: 50 });

    expect(result.failed).toEqual([MARKED_ID]);
    expect(warn.mock.calls.flat().join(' ')).toContain('timed out');
    warn.mockRestore();
  });

  it('never throws, whatever the caller passes', async () => {
    await expect(service.reconcileChannelsAgainstLive([]))
      .resolves.toEqual({ healed: [], failed: [], skipped: [] });
    await expect(service.reconcileChannelsAgainstLive(['-100unknown']))
      .resolves.toEqual({ healed: [], failed: [], skipped: [] });
  });
});

describe('review fixes', () => {
  it('pages from the pre-diff cursor, not from the messages the diff carried', async () => {
    // The diff carries a channel's most RECENT messages, not the missing ones.
    // Archiving them first drags the cursor to the newest of them, so a
    // catch-up that pages from the cursor asks for messages AFTER the gap.
    // Cursor 100, realtime missed 101-497, diff brings 498-500.
    seedChannel(MARKED_ID, 100);
    const sync = vi.spyOn(service, '_syncNewerMessages').mockResolvedValue({});
    vi.spyOn(service, '_insertTooLongMessages').mockImplementation(() => {
      service._updateChannelCursors(MARKED_ID, { lastMessageId: 500, lastMessageDate: null });
    });

    await service._handleChannelTooLong({
      channelId: BARE_ID,
      diff: { messages: [{ _: 'message', id: 500 }] },
    });

    expect(sync).toHaveBeenCalledWith(MARKED_ID, { fromMessageId: 100 });
    vi.restoreAllMocks();
  });

  it('_syncNewerMessages honours a caller floor below the cursor', async () => {
    seedChannel(MARKED_ID, 500);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Test Chat', peerType: 'channel', messages: [],
    });

    await service._syncNewerMessages(MARKED_ID, { fromMessageId: 100 });

    expect(telegramClient.getMessagesByChannelId.mock.calls[0][2]).toEqual({ minId: 100 });
  });

  it('never pages further forward than the cursor when the floor is above it', async () => {
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Test Chat', peerType: 'channel', messages: [],
    });

    await service._syncNewerMessages(MARKED_ID, { fromMessageId: 900 });

    expect(telegramClient.getMessagesByChannelId.mock.calls[0][2]).toEqual({ minId: 100 });
  });

  it('falls back to the id conversion when a diff message has no resolvable peer', async () => {
    // mtcute throws building Message.chat for a raw message with no peerId.
    // That must not escape and cost us the catch-up entirely.
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Test Chat', peerType: 'channel', messages: [],
    });

    await service._handleChannelTooLong({
      channelId: BARE_ID,
      diff: { messages: [{ _: 'message', id: 500 }] },
    });

    expect(telegramClient.getMessagesByChannelId).toHaveBeenCalled();
    expect(telegramClient.getMessagesByChannelId.mock.calls[0][0]).toBe(MARKED_ID);
  });

  it('leaves an existing queued job alone instead of rewriting its depth', async () => {
    // addJob is an upsert keyed on channel: queueing over a user's deep
    // backfill would silently shrink it to our own depth.
    seedChannel(MARKED_ID, 100);
    service.addJob(MARKED_ID, { depth: 5000 });
    telegramClient.getMessagesByChannelId.mockRejectedValue(new Error('FLOOD_WAIT_420'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    const jobs = service.listJobs({ channelId: MARKED_ID });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].target_message_count).toBe(5000);
    vi.restoreAllMocks();
  });

  it('never queues a retry with the 1000-message default for an empty channel', async () => {
    seedChannel(MARKED_ID, 100);          // channel row, but no archived messages
    telegramClient.getMessagesByChannelId.mockRejectedValue(new Error('FLOOD_WAIT_420'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await service._handleChannelTooLong({ channelId: BARE_ID, diff: { messages: [] } });

    expect(service.listJobs({ channelId: MARKED_ID })[0].target_message_count).toBe(1);
    vi.restoreAllMocks();
  });

  it('reconciles from the subscriber floor so an interior hole is healed', async () => {
    // Realtime missed 159-160 but then archived 161, so the channel cursor
    // already sits above the hole. Only the subscriber's own cursor finds it.
    seedChannel(MARKED_ID, 161);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Test Chat', peerType: 'channel', messages: [],
    });

    await service.reconcileChannelsAgainstLive([{ channelId: MARKED_ID, sinceMessageId: 158 }]);

    expect(telegramClient.getMessagesByChannelId.mock.calls[0][2]).toEqual({ minId: 158 });
  });

  it('coalesces concurrent reconciles of the same channel into one live call', async () => {
    // /subscribe reconciles per connection; a reconnect loop or several
    // subscribers must not each fire their own call for the same work.
    seedChannel(MARKED_ID, 100);
    let resolveCall;
    telegramClient.getMessagesByChannelId.mockImplementation(
      () => new Promise((resolve) => { resolveCall = () => resolve({ peerTitle: 'C', peerType: 'channel', messages: [] }); }),
    );

    const first = service.reconcileChannelsAgainstLive([MARKED_ID]);
    const second = service.reconcileChannelsAgainstLive([MARKED_ID]);
    await new Promise((r) => setTimeout(r, 10));
    resolveCall();
    await Promise.all([first, second]);

    expect(telegramClient.getMessagesByChannelId).toHaveBeenCalledTimes(1);
  });

  it('stops reconciling when the overall budget runs out', async () => {
    // One budget for the pass, not one per channel: ten stuck channels must not
    // mean ten timeouts before the first replayed byte.
    seedChannel(MARKED_ID, 100);
    seedChannel('-100999', 10);
    telegramClient.getMessagesByChannelId.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const started = Date.now();
    const result = await service.reconcileChannelsAgainstLive([MARKED_ID, '-100999'], {
      timeoutMs: 5_000,
      budgetMs: 60,
    });
    const elapsed = Date.now() - started;

    // The guarantee is the budget, not which bucket each channel lands in:
    // once it expires the remaining channels are either skipped outright or
    // given whatever is left, so a channel can end up in either list depending
    // on how the clock falls. What must hold is that the pass returns on the
    // budget rather than on two full per-channel timeouts.
    expect(elapsed).toBeLessThan(2_000);
    expect([...result.failed, ...result.skipped].sort()).toEqual(['-100999', MARKED_ID].sort());
    expect(result.healed).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('channel title preservation', () => {
  it('does not overwrite a known title with the Unknown placeholder', async () => {
    // Telegram lookups return `displayName || 'Unknown'`, and that string is
    // truthy. Since the reconcile runs _syncNewerMessages on every /subscribe,
    // an unresolved peer would rewrite the real title on every connection.
    service.db.prepare(`
      INSERT INTO channels (channel_id, peer_title, peer_type, sync_enabled, last_message_id)
      VALUES (?, '1-1 դասարան_Էվրիկա', 'channel', 1, 100)
    `).run(MARKED_ID);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Unknown', peerType: 'channel', messages: [],
    });

    await service._syncNewerMessages(MARKED_ID);

    expect(service._getChannel(MARKED_ID).peer_title).toBe('1-1 դասարան_Էվրիկա');
  });

  it('still applies a real title, including a rename', async () => {
    seedChannel(MARKED_ID, 100);
    telegramClient.getMessagesByChannelId.mockResolvedValue({
      peerTitle: 'Renamed Chat', peerType: 'channel', messages: [],
    });

    await service._syncNewerMessages(MARKED_ID);

    expect(service._getChannel(MARKED_ID).peer_title).toBe('Renamed Chat');
  });

  it('keeps the stored title when a dialog refresh cannot resolve the peer', async () => {
    service.db.prepare(`
      INSERT INTO channels (channel_id, peer_title, peer_type, sync_enabled)
      VALUES (?, 'Real Title', 'channel', 1)
    `).run(MARKED_ID);

    service.upsertChannels([{ id: MARKED_ID, title: 'Unknown', type: 'channel' }]);

    expect(service._getChannel(MARKED_ID).peer_title).toBe('Real Title');
  });
});

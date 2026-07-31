# Target MCP Tool Schema (vNext)

This document defines the consolidated MCP tool surface. The goal is fewer tools, consistent filters, and a single API for archive/live/both.

## Shared types
- channelId: string | number (numeric ID or @username).
- userId: string | number (numeric user ID or @username).
- topicId: number (forum topic ID).
- source: "archive" | "live" | "both" (default: "archive").
- isoDate: ISO-8601 string (UTC preferred).
- limit: integer (tool-specific defaults).

## Auth / Health
### authStatus
- Purpose: report auth/session status.
- Params: none.
- Output: { authenticated, userId?, phone?, sessionPath?, lastLoginAt? }.

### serverStatus
- Purpose: diagnostics summary (realtime, queue, db, fts).
- Params: none.
- Output: { realtimeActive, queueSize, jobsInProgress, ftsEnabled, lastSyncAt }.

## Sync
### syncJobsList
- Params: status? (pending|in_progress|idle|error), channelId?, limit?
- Output: list of jobs.

### syncJobsAdd
- Params: channelId (required), depth? (default 1000), minDate? (ISO), enableRealtime? (default true)
- Output: job record.

### syncJobsRetry
- Params: jobId? | channelId? | allErrors? (boolean)
- Output: { updated, jobIds }.

### syncJobsCancel
- Params: jobId? | channelId?
- Output: { canceled, jobIds }.

### syncRealtimeSet
- Params: enabled (boolean)
- Output: { realtimeActive }.

## Channels
### channelsList
- Params: limit? (default 50), includeInactive? (default false)
- Output: list of local channel records.

### channelsSearch
- Params: query (string, required), limit? (default 100)
- Output: list of matching dialogs (live search).

### channelsGet
- Params: channelId (required)
- Output: channel record + sync fields.

### channelsSetSync
- Params: channelId (required), enabled (boolean)
- Output: { channelId, syncEnabled }.

## Metadata + Tags
### channelsMetadataGet
- Params: channelId (required)
- Output: { channelId, peerTitle, username, about, metadataUpdatedAt }.

### channelsMetadataRefresh
- Params: channelIds? (list), limit? (default 20), force? (boolean), onlyMissing? (boolean)
- Output: list of refreshed records.

### channelsTagsSet
- Params: channelId (required), tags (array, required), source? (default manual)
- Output: { channelId, tags }.

### channelsTagsList
- Params: channelId (required), source?
- Output: list of tags with confidence/source.

### channelsTagsSearch
- Params: tag (required), source?, limit? (default 100)
- Output: list of channels with that tag.

### channelsTagsAuto
- Params: channelIds? (list), limit? (default 50), source? (default auto), refreshMetadata? (default true)
- Output: list of channels + auto tags.

## Topics (Telegram forums)
### topicsList
- Params: channelId (required), limit? (default 100)
- Output: list of topics.

### topicsSearch
- Params: channelId (required), query (required), limit? (default 100)
- Output: list of topics.

## Messages
### messagesList
- Params:
  - channelId? (optional)
  - topicId? (optional)
  - source? (archive|live|both, default archive)
  - fromDate? (ISO)
  - toDate? (ISO)
  - limit? (default 50)
- Output: list of messages.

### messagesGet
- Params: channelId (required), messageId (required), source? (default archive)
- Output: message object.

### messagesContext
- Params: channelId (required), messageId (required), before? (default 20), after? (default 20), source? (default archive)
- Output: { before: [], target, after: [] }.

### messagesSearch
- Params:
  - query? (FTS query string)
  - regex? (optional regex filter)
  - source? (archive|live|both, default archive)
  - channelIds? (list)
  - topicId? (optional)
  - tags? (list of channel tags)
  - fromDate? (ISO)
  - toDate? (ISO)
  - limit? (default 100)
  - caseInsensitive? (boolean, default true)
- Output: list of messages + match/snippet when available.

### messagesListMyReacted
- Purpose: find messages the current user has reacted to, for reaction-driven wiki ingest (kbbuilder tgcli#1). Queries LIVE Telegram via mtcute — **never** the SQLite archive, which only covers a subset of channels.
- Params: fromDate? (ISO), toDate? (ISO), emoji? (default 👍, unicode string), limit? (default 50), channelId? (optional — restrict to a single dialog).
- Output: { source: "live", returned, messages }, where each message matches the `messagesList` live-source shape (`formatLiveMessage`) plus reactionEmoji, hasMedia (boolean), mediaKind (`media.type` or null), source: "live".
- **fromDate/toDate filter the MESSAGE's date, not when the reaction was added** — Telegram exposes no global "reacted since" index. A reaction added today on a message from six months ago will only surface if fromDate allows that older date.
- Mechanics: enumerates dialogs with `iterDialogs`, then walks each dialog's history newest-first with `iterHistory`, stopping that dialog's scan as soon as a message's date falls before `fromDate`. A message counts as "reacted" when its `reactions` include a `ReactionCount` with a non-null `order` (chosen_order) and a matching emoji. Reactions minimized by Telegram (`reactions.raw.min`, common on messages not authored by the current user) are refreshed via `getMessageReactions` before matching, since minimized entries omit the current user's own reaction order.
- Bounds: stops once `limit` matches are found; when `channelId` is omitted, scans at most 200 dialogs (oldest dialogs beyond that cutoff are not scanned — pass `channelId` to scan a specific dialog exhaustively instead); applies a small delay between dialogs to reduce `FLOOD_WAIT` risk; caps per-dialog history walking at 5000 messages as a safety net when no `fromDate` is given.
- Out of scope: does not index reactions from live updates (`onUpdate`) — this is a pull-scan-only tool, not a persistent reaction index.

### messagesSend
- Params: channelId (required), text (required), topicId?, replyToMessageId?
- Output: { messageId }.

### messagesSendFile
- Params: channelId (required), filePath (required), caption?, filename?, topicId?
- Output: { messageId }.

## Media
### mediaDownload
- Params: channelId (required), messageId (required), outputPath? (file or directory)
- Output: { path, bytes, mimeType, downloadedAt }.

## Contacts / Users
### contactsSearch
- Params: query (required), limit? (default 50)
- Output: list of contacts/users.

### contactsGet
- Params: userId (required)
- Output: contact record.

### contactsAliasSet
- Params: userId (required), alias (required)
- Output: { userId, alias }.

### contactsAliasRemove
- Params: userId (required)
- Output: { userId, removed: true }.

### contactsTagsAdd
- Params: userId (required), tags (array, required)
- Output: { userId, tags }.

### contactsTagsRemove
- Params: userId (required), tags (array, required)
- Output: { userId, tags }.

### contactsNotesSet
- Params: userId (required), notes (string)
- Output: { userId, notes }.

## Groups
### groupsList
- Params: query? (optional), limit? (default 100)
- Output: list of groups.

### groupsInfo
- Params: channelId (required)
- Output: group metadata and membership info.

### groupsRename
- Params: channelId (required), name (required)
- Output: { channelId, name }.

### groupsMembersAdd
- Params: channelId (required), userIds (array, required)
- Output: { channelId, failed }.

### groupsMembersRemove
- Params: channelId (required), userIds (array, required)
- Output: { channelId, removed, failed }.

### groupsInviteLinkGet
- Params: channelId (required)
- Output: invite link metadata.

### groupsInviteLinkRevoke
- Params: channelId (required)
- Output: invite link metadata.

### groupsJoin
- Params: invite (required)
- Output: group summary.

### groupsLeave
- Params: channelId (required)
- Output: { channelId, left: true }.

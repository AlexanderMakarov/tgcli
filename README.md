# tgcli

Telegram CLI with background sync and an optional MCP server for your personal account (MTProto, not bot API).

## Installation

```bash
npm install -g @alexandermakarov/tgcli
```

```bash
brew install AlexanderMakarov/tap/tgcli
```

## Authentication

Get Telegram API credentials:
1. Go to https://my.telegram.org/apps
2. Log in with your phone number
3. Create a new application
4. Copy `api_id` and `api_hash`

Then authenticate:

```bash
tgcli auth
```

## Quick start

```bash
tgcli auth
tgcli sync --follow
tgcli messages list --chat @username --limit 20
tgcli messages search "course" --chat @channel --source archive
tgcli send text --to @username --message "hello"
tgcli server
```

## Commands

```bash
tgcli auth           Authentication and session setup
tgcli config         View and edit config
tgcli sync           Archive backfill and realtime sync
tgcli server         Run background sync service (MCP optional); stop, restart, logs
tgcli service        Install/start/stop/status/logs for background service
tgcli channels       List/search channels
tgcli messages       List/search messages
tgcli send           Send text or files
tgcli media          Download media
tgcli topics         Forum topics
tgcli tags           Channel tags
tgcli metadata       Channel metadata cache
tgcli contacts       Contacts and people
tgcli groups         Group management
tgcli doctor         Diagnostics and sanity checks
tgcli store          Local archive maintenance (compact)
```

Commands run through `tgcli server`, which the CLI starts on demand. After an upgrade, the next command of any kind replaces a server the CLI started itself, as soon as its backfill queue is empty. A server you started yourself with `tgcli server` or `tgcli service` keeps running the old code until you restart it; the CLI warns about this on stderr. `tgcli server restart` restarts the server on the CLI's version, `tgcli server stop` stops it, and `tgcli server logs --follow` shows its log.

Use `tgcli [command] --help` for details. Add `--json` for machine-readable output.

Once a day tgcli checks npm for a newer release in the background and, at a terminal, prints one line on stderr with the upgrade command (`brew update && brew upgrade tgcli` or `npm i -g @alexandermakarov/tgcli`). Set `TGCLI_NO_UPDATE_CHECK=1` to turn it off; see [docs/cli.md](docs/cli.md#update-notice).

## MCP (optional)

Enable it via config:

```bash
tgcli config set mcp.enabled true
```

By default the server binds to `http://127.0.0.1:8080/mcp`. To change it:

```bash
tgcli config set mcp.host 127.0.0.1
tgcli config set mcp.port 8080
```

Then run `tgcli server` and point your client at the configured address.

## Subscriptions (`GET /subscribe`)

Stream new and edited messages as Server-Sent Events. Served by the MCP HTTP
server, alongside `/health` and `/mcp`.

```
GET /subscribe?channels=-1003713035210&types=message.new,message.edit&since=154
```

| Param | Meaning |
|---|---|
| `channels` | Comma-separated channel ids, optionally each with its own cursor as `id:since`. Required. Must be archive-form ids — the same form `listActiveChannels` and `messagesList` return (`-100…` for channels and supergroups, a plain id for DMs). |
| `types` | Comma-separated subset of `message.new`, `message.edit`. Defaults to both. |
| `since` | Default cursor for any channel given as a bare id. Omit for live-only. |

**Prefer per-channel cursors when watching more than one chat:**

```
GET /subscribe?channels=-1003713035210:158,-5508552085:58605
```

Telegram message ids are per-chat and can be wildly disjoint — a supergroup at 158 next to a basic group at 58605. With a single shared cursor the lowest one wins, so every other channel replays its entire history. That is not merely wasted bandwidth: those discarded rows count against `maxReplay`, so one channel can consume the whole replay budget and the channel that actually needed catching up gets a `gap` instead of its messages. Per-channel cursors give each channel its own budget, and a `gap` names the `channelId` it belongs to.

```
id: 155
event: message.new
data: {"channelId":"-1003713035210","messageId":155,"date":"…","text":"…"}

: ping
```

The `data` payload is the same shape `messagesList` returns, so one parser
serves both replay and live. It carries `editDate` (ISO) beside `date`, so a
`message.edit` event says *when* it was edited rather than only when it was
posted; `editDate` is `null` for a message nobody has edited, and for messages
archived before tgcli started recording it. A `: ping` comment every 25s keeps intermediaries
from idling the connection out. If more than 500 messages are pending for a
channel, a single `event: gap` is emitted for that channel instead of its
backlog, carrying `channelId` and the true newest message id so the consumer
can decide how to recover.

Delivery dedup is keyed by channel **and** message id, since ids are per-chat
and two watched channels can legitimately carry the same one.

tgcli keeps **no subscriber state**: the archive is the durable log and the
consumer owns its cursor, so reconnecting after a disconnect is the same code
path as connecting for the first time. Events are published only after a
message is durably written, and a message arriving mid-replay is delivered
exactly once.

## Configuration & Store

The tgcli store lives in the OS app-data directory and contains `config.json`, sessions, and `messages.db`.
Override the location with `TGCLI_STORE`.

### Shrinking `messages.db`

Each archived message keeps the full Telegram payload in `messages.raw_json`. Stores created before the compact `raw_json` format hold it about 1.5x larger than needed (binary fields were written as `{"0":1,"1":24,…}` index maps). Rewrite them once and return the space to the OS:

```bash
tgcli service stop        # compaction needs exclusive access to the store
tgcli store compact       # rewrites raw_json in batches, then VACUUMs
tgcli service start
```

`VACUUM` needs free disk of up to about twice the remaining data; the command checks this before starting. Use `--no-vacuum` to only rewrite rows. Expect a few minutes per million messages.

Legacy version: see `MIGRATION.md`.

## Development

Run it from a clone with Node 22: `npm ci`, then `node cli.js`. See `docs/development.md` for tests and for trying a change on your own account.

# Architecture

## The core constraint

Claude Code launches a channel by spawning the MCP server named in `.mcp.json`
as a **stdio subprocess of that session**. Three sessions launched with
`--dangerously-load-development-channels server:bridge` therefore spawn **three
separate processes** that share no memory.

So the "bridge" cannot be one MCP server. It is split:

- **The hub** (`src/hub.ts`) — a standalone, long-lived process started
  independently of any session. It is the real router and message bus, and the
  only component with visibility into all three sessions.
- **The channel adapter** (`src/channel-adapter.ts`) — the thin MCP server
  Claude Code actually spawns per session. It connects to the hub as an HTTP/SSE
  client: it pushes hub messages into its session as `<channel>` tags, and
  exposes a `send` tool that forwards outbound messages to the hub.

```
   ┌─────────────────┐   stdio    ┌──────────────────┐  HTTP POST /send
   │ Orchestrator    │◀──────────▶│ channel-adapter  │────────────────┐
   │ Claude session  │  <channel> │ (SESSION_ROLE=   │  SSE /events   │
   │ (human types    │   tags +   │  orchestrator)   │◀───────────────┤
   │  here)          │  send tool └──────────────────┘                │
   └─────────────────┘                                                │
   ┌─────────────────┐   stdio    ┌──────────────────┐                ▼
   │ Worker-1        │◀──────────▶│ channel-adapter  │◀───────▶┌──────────────┐
   │ Claude session  │            │ (worker-1)       │         │   hub.ts     │
   └─────────────────┘            └──────────────────┘         │ (standalone  │
   ┌─────────────────┐   stdio    ┌──────────────────┐         │  router +    │
   │ Worker-2        │◀──────────▶│ channel-adapter  │◀───────▶│  NDJSON log) │
   │ Claude session  │            │ (worker-2)       │         └──────────────┘
   └─────────────────┘            └──────────────────┘
```

## Channel mechanics

- A **channel** is an MCP server that declares
  `capabilities.experimental['claude/channel'] = {}`.
- To **push an event into a session**, the server emits a raw MCP notification:
  `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`.
  Claude Code renders it as
  `<channel source="bridge" ...meta>content</channel>` on the session's next turn.
  The method name must be exactly `notifications/claude/channel` — Claude Code
  registers its listener under that name and **silently drops** a notification
  with any other method (no error returned to the server).
- **Two-way**: the server also sets `capabilities.tools = {}` and registers a
  tool (here, `send`) via `ListToolsRequestSchema` + `CallToolRequestSchema`.
- **`meta` keys** must match `[A-Za-z0-9_]+` — hyphens in a *key* are silently
  dropped. The keys used here (`from`, `type`, `task_id`, `msg_id`) are all
  underscore-safe. *Values* may contain hyphens, so `from="worker-1"` is fine.
- The SDK's `Server` class is `@deprecated` in favour of `McpServer`. The adapter
  uses `Server` **deliberately** — channels need the raw `mcp.notification()`
  with a custom method, which the higher-level wrapper does not expose.

## Transport: HTTP POST + SSE

Chosen to mirror the official channels-reference webhook example and to add
**zero new dependencies** (`node:http` + `fetch` are built in). WebSockets would
add a dep with no benefit at N=3; Unix sockets would complicate the cross-process
story. Everything is localhost-only.

| Endpoint | Purpose |
|---|---|
| `GET /events?role=<role>` | long-lived SSE; one `data:` envelope per routed message |
| `POST /send` | body is a JSON envelope; hub validates and routes it |
| `GET /health` | `{ ok, roster, logPath }` for verification |

## The protocol

The single unit on the wire is the **Envelope** (`src/protocol.ts`):

```ts
{ v, id, ts, from, to, type, task_id, body }
```

- `from` / `to` ∈ `orchestrator | worker-1 | worker-2`; `to` may also be `all`.
- `from` is **stamped by the adapter** from `SESSION_ROLE` — a session cannot
  spoof another's identity, because the `send` tool ignores any client-supplied
  `from`.
- `type` ∈ `assign | ack | progress | result | question | answer | error | done`.
- `id` (`msg_id` in channel meta) is minted per-message by the sending adapter,
  enabling **dedupe** — delivery is at-least-once, not exactly-once, because of
  reconnect overlap.

### Message flow

```
Human ──goal──▶ Orchestrator
   │  mint task_id; decompose into EXACTLY 2 packages by the fixed rule
   ├──assign(task_id=T)──▶ worker-1
   └──assign(task_id=T)──▶ worker-2
                 worker-N ──ack──▶ orchestrator
                 worker-N works in its OWN workspace/ cwd
                 worker-N ──progress──▶ orchestrator        (optional)
                 worker-N ──question──▶ orchestrator ──answer──▶ worker-N  (optional)
                 worker-1 ──result──▶ orchestrator
                 worker-2 ──result──▶ orchestrator
   Orchestrator waits for BOTH results (N=2), then synthesizes ──▶ Human
   └──done(to=all)──▶ workers stand down                    (optional)
```

### Routing rules (hub)

- `to: "all"` → deliver to every role **except the sender**.
- unicast → deliver if `to !== from`.
- the hub **never echoes a message back to its sender** (`dropped-self-send`).
- no recipient connected → logged as `undeliverable`, not buffered.

## Filesystem isolation

`sessions/<role>/` is each Claude session's working directory: its own
`CLAUDE.md`, project `.mcp.json`, `settings.local.json`, and an isolated
`workspace/`. `node_modules/` lives at the repo root and resolves via Node's
parent-directory walk. The default demo scenario has the two workers write to
**disjoint** `workspace/findings.md` files, so there is no file-conflict risk.

## Logging discipline

- **The hub** writes every event (`route`, `deliver`, `subscribe`, `reject`,
  `undeliverable`, …) to `logs/hub-<ISO>.ndjson` and echoes to stderr, so its
  terminal is a live view and the NDJSON file is a full audit trail.
- **The adapter** logs **only to stderr**. Its stdout is the MCP JSON-RPC stream
  — a single stray write to stdout corrupts the protocol and `/mcp` reports
  "failed to connect". Claude Code captures adapter stderr to
  `~/.claude/debug/<session-id>.txt`.

## Documented extensions (not built)

These are deliberately left out to keep the sample minimal; each is a natural
next step.

- **Hub ring-buffer replay** — the hub keeps the last *N* envelopes per role and
  replays them to a late subscriber on `/events` connect. This removes the
  "all sessions up before the goal" requirement and makes the hub crash-tolerant.
- **Permission relay** — a worker that hits a permission prompt forwards it over
  the channel as a `question`, so the human at the orchestrator terminal can
  approve it, instead of the worker stalling. (The current design avoids this by
  pre-approving a scoped tool set in each worker's `settings.local.json`.)
- **Dynamic roster** — replace the fixed three-role enum with hub-side
  registration so the topology (number of workers, their names) is not hard-coded.

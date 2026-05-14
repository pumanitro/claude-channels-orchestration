/**
 * channel-adapter.ts — the per-session channel MCP server.
 *
 * Claude Code spawns ONE of these over stdio for each session (orchestrator,
 * worker-1, worker-2), selected by the SESSION_ROLE env var in that session's
 * .mcp.json. It is deliberately thin: all routing lives in the hub. This
 * process only
 *   1. declares the `claude/channel` capability + a `send` tool,
 *   2. subscribes to the hub's SSE stream and pushes each inbound envelope into
 *      the session as a <channel> tag (via a raw MCP notification),
 *   3. turns `send` tool calls into validated envelopes POSTed to the hub.
 *
 * stdout is the MCP JSON-RPC stream and is SACRED — every byte of logging here
 * goes to stderr (which Claude Code captures to ~/.claude/debug/<session-id>.txt).
 * A single console.log to stdout corrupts the protocol and /mcp reports the
 * server as "failed to connect".
 */

// Server is @deprecated in the SDK in favor of McpServer, but we need it on
// purpose: channels require a raw `mcp.notification()` with a custom method
// ('notifications/claude/channel') that the higher-level McpServer wrapper does
// not expose. Do not "fix" this import.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type Envelope,
  type Role,
  isRole,
  isAddress,
  isMessageType,
  MESSAGE_TYPES,
  ROLES,
  PROTOCOL_VERSION,
  newId,
  toChannelMeta,
} from './protocol.js';

// --- role + hub config ------------------------------------------------------
const ROLE = process.env.SESSION_ROLE;
const HUB_URL = (process.env.HUB_URL ?? 'http://127.0.0.1:4577').replace(/\/$/, '');
if (!isRole(ROLE)) {
  process.stderr.write(
    `bridge adapter: invalid SESSION_ROLE ${JSON.stringify(ROLE)} — expected one of ${ROLES.join(', ')}\n`,
  );
  process.exit(1);
}
const SELF: Role = ROLE;

const elog = (msg: string): void => {
  process.stderr.write(`[bridge:${SELF}] ${msg}\n`);
};

// --- MCP server -------------------------------------------------------------
const mcp = new Server(
  { name: 'bridge', version: '0.1.0' },
  {
    capabilities: {
      // declares this server as a Claude Code channel
      experimental: { 'claude/channel': {} },
      // declares the outbound `send` tool
      tools: {},
    },
    instructions:
      `You are the "${SELF}" session on the channels bridge. ` +
      `Inbound messages arrive as <channel source="bridge" from=.. type=.. task_id=.. msg_id=..>BODY</channel> tags. ` +
      `To send a message, call the "send" tool with { to, type, task_id, body } — your own role is stamped automatically, never pass "from". ` +
      `Follow the workflow in CLAUDE.md.`,
  },
);

// --- the `send` tool --------------------------------------------------------
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description:
        `Send a message to another session on the channels bridge. ` +
        `Your own role ("${SELF}") is stamped as "from" automatically.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            enum: [...ROLES, 'all'],
            description: 'recipient role, or "all" to broadcast to everyone but you',
          },
          type: {
            type: 'string',
            enum: MESSAGE_TYPES,
            description: 'message type',
          },
          task_id: {
            type: 'string',
            description: 'the task this message belongs to (orchestrator mints it)',
          },
          body: {
            type: 'string',
            description: 'human-readable payload; put large output in a workspace file instead',
          },
        },
        required: ['to', 'type', 'task_id', 'body'],
        additionalProperties: false,
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'send') {
    return { isError: true, content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }] };
  }
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  // Anti-spoof: ignore any client-supplied `from`; the adapter is the only
  // thing that may stamp it, and it always stamps SELF.
  if (!isAddress(args.to)) {
    return { isError: true, content: [{ type: 'text', text: `bad "to": ${String(args.to)}` }] };
  }
  if (!isMessageType(args.type)) {
    return { isError: true, content: [{ type: 'text', text: `bad "type": ${String(args.type)}` }] };
  }
  if (typeof args.task_id !== 'string' || !args.task_id) {
    return { isError: true, content: [{ type: 'text', text: '"task_id" must be a non-empty string' }] };
  }
  if (typeof args.body !== 'string') {
    return { isError: true, content: [{ type: 'text', text: '"body" must be a string' }] };
  }

  const env: Envelope = {
    v: PROTOCOL_VERSION,
    id: newId(SELF),
    ts: new Date().toISOString(),
    from: SELF,
    to: args.to,
    type: args.type,
    task_id: args.task_id,
    body: args.body,
  };

  try {
    const resp = await fetch(`${HUB_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      elog(`send rejected by hub: ${resp.status} ${detail}`);
      return {
        isError: true,
        content: [{ type: 'text', text: `hub rejected message: ${resp.status} ${detail}` }],
      };
    }
    elog(`sent ${env.type} -> ${env.to} (task ${env.task_id}, id ${env.id})`);
    return {
      content: [{ type: 'text', text: `sent ${env.type} to ${env.to} (msg_id ${env.id})` }],
    };
  } catch (err) {
    elog(`send failed — hub unreachable: ${String(err)}`);
    return {
      isError: true,
      content: [{ type: 'text', text: `hub unreachable at ${HUB_URL}: ${String(err)}` }],
    };
  }
});

// --- inbound: hub SSE -> <channel> tag --------------------------------------
function pushIntoSession(env: Envelope): void {
  // The core of the bridge: a raw MCP notification with the custom
  // 'notifications/claude/channel' method. Claude Code registers its listener
  // under exactly that method name — a notification with any other method is
  // dropped silently with no error. Claude Code renders this as a
  // <channel source="bridge" ...meta>content</channel> tag on the next turn.
  mcp
    .notification({
      method: 'notifications/claude/channel',
      params: {
        content: env.body,
        meta: toChannelMeta(env),
      },
    })
    .catch((err) => elog(`failed to push notification into session: ${String(err)}`));
  elog(`recv ${env.type} from ${env.from} (task ${env.task_id}, id ${env.id}) -> session`);
}

async function consumeHubStream(): Promise<void> {
  const resp = await fetch(`${HUB_URL}/events?role=${encodeURIComponent(SELF)}`, {
    headers: { Accept: 'text/event-stream' },
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`hub /events returned ${resp.status}`);
  }
  elog(`subscribed to hub ${HUB_URL} as ${SELF}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of resp.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE events are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue; // skip ':' comments / keepalives
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          pushIntoSession(JSON.parse(data) as Envelope);
        } catch (err) {
          elog(`failed to parse hub event: ${String(err)}`);
        }
      }
    }
  }
  // Stream ended cleanly (hub closed it) — let hubLoop reconnect.
  throw new Error('hub stream ended');
}

async function hubLoop(): Promise<void> {
  for (;;) {
    try {
      await consumeHubStream();
    } catch (err) {
      elog(`hub stream error: ${String(err)} — retrying in 1s`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- startup ----------------------------------------------------------------
// Connect the MCP transport FIRST so the stdio handshake with Claude Code
// completes even if the hub is down. Only then start the hub subscription loop.
await mcp.connect(new StdioServerTransport());
elog(`adapter up: role=${SELF} hub=${HUB_URL}`);
void hubLoop();

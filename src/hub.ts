/**
 * hub.ts — the standalone message router.
 *
 * This is a long-lived process started independently of any Claude session.
 * Each Claude session spawns its own channel-adapter (a thin stdio MCP server);
 * those adapters all connect here as HTTP/SSE clients. The hub is the only
 * component that sees all three sessions, so it is the only place routing can
 * happen.
 *
 * Transport: plain node:http — SSE for hub->adapter, POST for adapter->hub.
 *   GET  /events?role=<role>  long-lived SSE stream of routed envelopes
 *   POST /send                body is a JSON Envelope; hub validates + routes
 *   GET  /health              { ok, roster, logPath } for verification
 *
 * Durability: none, by design. The hub does not buffer. A session that connects
 * after a message was routed never sees it. See ARCHITECTURE.md for the
 * documented (unbuilt) ring-buffer replay extension.
 */

import http from 'node:http';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Envelope,
  type Role,
  ROLES,
  isRole,
  validateEnvelope,
} from './protocol.js';

const PORT = Number(process.env.HUB_PORT ?? 4577);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- NDJSON run log ---------------------------------------------------------
const LOG_DIR = join(REPO_ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = join(LOG_DIR, `hub-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const logStream: WriteStream = createWriteStream(LOG_PATH, { flags: 'a' });

function log(kind: string, data: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), kind, ...data };
  logStream.write(JSON.stringify(entry) + '\n');
  // Echo to stderr so the hub terminal is a live view of the conversation.
  process.stderr.write(`[hub] ${kind} ${JSON.stringify(data)}\n`);
}

// --- subscriber registry ----------------------------------------------------
const subscribers: Record<Role, Set<http.ServerResponse>> = {
  'orchestrator': new Set(),
  'worker-1': new Set(),
  'worker-2': new Set(),
};

const roster = (): Record<Role, number> => ({
  'orchestrator': subscribers['orchestrator'].size,
  'worker-1': subscribers['worker-1'].size,
  'worker-2': subscribers['worker-2'].size,
});

// --- routing ----------------------------------------------------------------
function deliver(to: Role, env: Envelope): void {
  const conns = subscribers[to];
  if (conns.size === 0) {
    log('undeliverable', { to, id: env.id, type: env.type });
    return;
  }
  const payload = `data: ${JSON.stringify(env)}\n\n`;
  for (const res of conns) res.write(payload);
  log('deliver', { to, id: env.id, type: env.type });
}

function route(env: Envelope): void {
  log('route', { ...env });
  if (env.to === 'all') {
    // broadcast to everyone EXCEPT the sender
    for (const r of ROLES) {
      if (r !== env.from) deliver(r, env);
    }
  } else if (env.to !== env.from) {
    deliver(env.to, env);
  } else {
    // the hub never echoes a message back to its sender
    log('dropped-self-send', { id: env.id, type: env.type });
  }
}

// --- HTTP server ------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  // --- GET /health ---
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, roster: roster(), logPath: LOG_PATH });
    return;
  }

  // --- GET /events?role=<role> ---
  if (req.method === 'GET' && url.pathname === '/events') {
    const role = url.searchParams.get('role');
    if (!isRole(role)) {
      sendJson(res, 400, { ok: false, error: `bad role: ${String(role)}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    subscribers[role].add(res);
    log('subscribe', { role, roster: roster() });

    // SSE keepalive so proxies / idle sockets don't drop the stream.
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(keepalive);
      subscribers[role].delete(res);
      log('unsubscribe', { role, roster: roster() });
    });
    return;
  }

  // --- POST /send ---
  if (req.method === 'POST' && url.pathname === '/send') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      return;
    }
    const reason = validateEnvelope(parsed);
    if (reason) {
      log('reject', { reason, payload: parsed });
      sendJson(res, 400, { ok: false, error: reason });
      return;
    }
    route(parsed as Envelope);
    sendJson(res, 202, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log('hub-listening', { port: PORT, logPath: LOG_PATH });
});

// Graceful shutdown — close SSE streams so adapters see EOF and reconnect-loop.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('hub-shutdown', { signal: sig });
    for (const r of ROLES) {
      for (const res of subscribers[r]) res.end();
    }
    server.close(() => {
      logStream.end(() => process.exit(0));
    });
  });
}

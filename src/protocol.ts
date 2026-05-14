/**
 * The predefined message protocol shared by the hub and every channel adapter.
 *
 * An Envelope is the single unit that travels: human -> orchestrator -> workers
 * -> orchestrator -> human. The hub routes envelopes; the adapter turns inbound
 * envelopes into <channel> tags and outbound `send` tool calls into envelopes.
 */

export const PROTOCOL_VERSION = 1;

export type Role = 'orchestrator' | 'worker-1' | 'worker-2';
/** `to` may also target every session except the sender. */
export type Address = Role | 'all';

export type MessageType =
  | 'assign'
  | 'ack'
  | 'progress'
  | 'result'
  | 'question'
  | 'answer'
  | 'error'
  | 'done';

export interface Envelope {
  /** protocol version — receivers reject anything that isn't PROTOCOL_VERSION */
  v: number;
  /** globally-unique message id, minted by the sending adapter (enables dedupe) */
  id: string;
  /** ISO timestamp, stamped by the sending adapter */
  ts: string;
  /** sender role — stamped by the adapter from SESSION_ROLE, never client-supplied */
  from: Role;
  /** recipient role, or 'all' for a broadcast to everyone but the sender */
  to: Address;
  type: MessageType;
  /** the unit of work this message belongs to — minted by the orchestrator */
  task_id: string;
  /** human-readable payload; large output belongs in a workspace file, not here */
  body: string;
}

export const ROLES: Role[] = ['orchestrator', 'worker-1', 'worker-2'];

export const MESSAGE_TYPES: MessageType[] = [
  'assign',
  'ack',
  'progress',
  'result',
  'question',
  'answer',
  'error',
  'done',
];

export const isRole = (x: unknown): x is Role =>
  typeof x === 'string' && (ROLES as string[]).includes(x);

export const isAddress = (x: unknown): x is Address =>
  x === 'all' || isRole(x);

export const isMessageType = (x: unknown): x is MessageType =>
  typeof x === 'string' && (MESSAGE_TYPES as string[]).includes(x);

/**
 * Structurally validate an unknown value as an Envelope.
 * Returns null when valid, or a human-readable reason string when not.
 */
export function validateEnvelope(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return 'not an object';
  const m = e as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION) return `bad protocol version: ${String(m.v)}`;
  if (typeof m.id !== 'string' || !m.id) return 'missing id';
  if (typeof m.ts !== 'string' || !m.ts) return 'missing ts';
  if (!isRole(m.from)) return `bad from: ${String(m.from)}`;
  if (!isAddress(m.to)) return `bad to: ${String(m.to)}`;
  if (!isMessageType(m.type)) return `bad type: ${String(m.type)}`;
  if (typeof m.task_id !== 'string') return 'task_id must be a string';
  if (typeof m.body !== 'string') return 'body must be a string';
  return null;
}

/**
 * Build the `meta` object attached to a <channel> tag.
 *
 * IMPORTANT: channel meta KEYS must match [A-Za-z0-9_]+ — hyphens in a key are
 * silently dropped by Claude Code. Keys here (from/type/task_id/msg_id) are all
 * underscore-safe. VALUES may contain hyphens, so `from: "worker-1"` is fine.
 */
export const toChannelMeta = (e: Envelope): Record<string, string> => ({
  from: e.from,
  type: e.type,
  task_id: e.task_id,
  msg_id: e.id,
});

/** Monotonic-ish id: role + timestamp + per-process sequence. */
let seq = 0;
export const newId = (role: Role): string =>
  `${role}-${Date.now()}-${seq++}`;

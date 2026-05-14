# Verified end-to-end run

**Status: working.** On **2026-05-14** the full orchestrator → 2 workers → orchestrator
loop ran clean over the channels bridge — every message routed, both workers
reacted to their `<channel>` tags, and the orchestrator synthesized the result.

## The goal given to the orchestrator

> Give both workers the same task: generate a random number ≠ 7. After you get a
> response from both, add the numbers and show me the sum.

## What happened

1. Orchestrator minted `task_id: T1`, sent an `assign` to each worker.
2. Both workers sent an `ack`, generated a number in their own `workspace/`
   (shell `$RANDOM` with a reject-if-7 loop), wrote detail to
   `workspace/findings.md`, and replied with a `result`.
3. Orchestrator waited for **both** results, summed them, printed the answer,
   and broadcast `done` so the workers stood down.

Result: **worker-1 → 13255**, **worker-2 → 136**, **sum = 13391** (both ≠ 7).

## Hub log (the full conversation, verbatim)

From `logs/hub-2026-05-14T19-25-00-638Z.ndjson` — every routed message, in order:

```
hub-listening  port 4577
subscribe      orchestrator   roster {orchestrator:1, worker-1:0, worker-2:0}
subscribe      worker-1       roster {orchestrator:1, worker-1:1, worker-2:0}
subscribe      worker-2       roster {orchestrator:1, worker-1:1, worker-2:1}
route+deliver  orchestrator -> worker-1   assign  T1   "Generate a single random integer that is NOT equal to 7..."
route+deliver  orchestrator -> worker-2   assign  T1   "Generate a single random integer that is NOT equal to 7..."
route+deliver  worker-2 -> orchestrator   ack     T1   "Started T1 — generating a random integer ≠ 7."
route+deliver  worker-1 -> orchestrator   ack     T1   "Started T1 — generating a random integer ≠ 7."
route+deliver  worker-2 -> orchestrator   result  T1   "136"
route+deliver  worker-1 -> orchestrator   result  T1   "13255 (random via shell $RANDOM with reject-if-7 loop; details in workspace/findings.md)"
route+deliver  orchestrator -> all        done    T1   "T1 complete — both results received and summed (13255 + 136 = 13391). Stand down."
```

No `reject` and no `undeliverable` lines — a clean run.

## The bug that was fixed first

The first attempt failed silently: the hub delivered both assigns, but the
workers never reacted. Cause — the adapter emitted the MCP notification with
method `notifications/channel`, but Claude Code registers its channel listener
under `notifications/claude/channel` and **silently drops** a notification with
any other method (no error returned). One-word fix in
`src/channel-adapter.ts`. See ARCHITECTURE.md → *Channel mechanics*.

## Reproducing it

Follow the 4-terminal runbook in [README.md](./README.md) (`sh scripts/start-all.sh`),
then give the orchestrator any compare/split goal. After a run, the workers'
detailed output is in `sessions/worker-1/workspace/findings.md` and
`sessions/worker-2/workspace/findings.md`, and the complete message trace is in
`logs/hub-<ISO>.ndjson`.

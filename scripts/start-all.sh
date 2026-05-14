#!/usr/bin/env sh
# Not a launcher — Claude Code sessions are interactive and each needs its own
# terminal. This just prints the 4-terminal runbook.
cat <<'EOF'
claude-channels-orchestration — 4-terminal runbook
==================================================

Run each line in its OWN terminal, in this order. Wait for the hub to print
"hub-listening" before starting the sessions.

  Terminal A (hub, start first, long-lived):
      sh scripts/start-hub.sh

  Terminal B (orchestrator — you type here):
      sh scripts/start-orchestrator.sh

  Terminal C (worker-1):
      sh scripts/start-worker.sh 1

  Terminal D (worker-2):
      sh scripts/start-worker.sh 2

All three sessions run with --dangerously-skip-permissions so tool calls never
pause for a prompt (the workers are unattended). The one-time dev-channel trust
prompt is separate and still appears once on first launch — accept it.

All three sessions must be up BEFORE you give the goal: the hub does not buffer
messages.

Then, in Terminal B, type a goal, e.g.:
      Compare REST vs GraphQL for a mobile app backend.

Verify the hub is healthy any time with:
      curl -s localhost:4577/health
EOF

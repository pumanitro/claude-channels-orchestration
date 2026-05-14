#!/usr/bin/env sh
# Terminal B — the orchestrator session. This is the ONLY session a human types
# into.
#
# Runs with --dangerously-skip-permissions so tool calls never pause for a
# prompt. The one-time dev-channel trust prompt (and the folder-trust prompt on
# a fresh checkout) is separate and still appears once on first launch.
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/sessions/orchestrator"
exec claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:bridge

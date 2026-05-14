#!/usr/bin/env sh
# Terminal C / D — a worker session. Usage: sh scripts/start-worker.sh <1|2>
# No human types here; the worker is purely reactive.
#
# Runs with --dangerously-skip-permissions so the unattended worker never
# stalls on a tool-permission prompt. The one-time dev-channel trust prompt
# (and the folder-trust prompt on a fresh checkout) is separate and still
# appears once on first launch.
set -e
N="$1"
if [ "$N" != "1" ] && [ "$N" != "2" ]; then
  echo "usage: sh scripts/start-worker.sh <1|2>" >&2
  exit 1
fi
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/sessions/worker-$N"
exec claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:bridge

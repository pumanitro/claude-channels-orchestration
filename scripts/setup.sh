#!/usr/bin/env sh
# One-time setup: install deps and create the gitignored runtime dirs.
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> npm install"
npm install

echo "==> creating runtime directories"
mkdir -p logs
mkdir -p sessions/orchestrator/workspace
mkdir -p sessions/worker-1/workspace
mkdir -p sessions/worker-2/workspace

echo "==> typecheck"
npm run typecheck

echo "Setup complete. Next: sh scripts/start-hub.sh (Terminal A)."

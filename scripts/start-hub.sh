#!/usr/bin/env sh
# Terminal A — the standalone message router. Start this FIRST and leave it
# running. Its terminal is a live view of every routed message.
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
exec npx tsx src/hub.ts

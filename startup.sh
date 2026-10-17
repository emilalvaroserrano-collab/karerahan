#!/bin/sh
# Preview: betting socket on 3001, app on 8080.
# Resolve the script's own directory so the same entrypoint works from the
# workspace root however it is mounted.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# :8081 is QA-only — a revive must never inherit a stale built-output preview.
node "$ROOT/scripts/preview.mjs" stop > /dev/null 2>&1 || true

if ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:3001/; then
  cd "$ROOT/karera/server"
  npm start > /tmp/karera-server.log 2>&1 &
fi
if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
  exit 0
fi
cd "$ROOT"
npm run dev > /tmp/karera-dev.log 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
    exit 0
  fi
  sleep 0.5
done
exit 1

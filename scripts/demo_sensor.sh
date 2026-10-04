#!/usr/bin/env bash
# One command for the sensor demo: engine (with the built-in Arduino bridge) + web app, opens the browser.
# Ctrl+C stops both. The Arduino can be plugged in before or after; the engine finds it (GET /node/status).
set -euo pipefail
# Own process group (Linux setsid), so Ctrl+C / kill stops exactly what this script started. macOS has no setsid;
# there the cleanup below falls back to killing the children it started.
if [ "${HEATTWIN_PGRP:-}" != "1" ] && command -v setsid >/dev/null; then HEATTWIN_PGRP=1 exec setsid --wait "$0" "$@"; fi
cd "$(dirname "$0")/.."
PORT="${HEATTWIN_PORT:-8010}"
export HEATTWIN_PORT="$PORT"

# Node ≥ 20 for Vite; use ~/.local/node22 when the system node is older.
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
  if [ -x "$HOME/.local/node22/bin/node" ]; then export PATH="$HOME/.local/node22/bin:$PATH"
  else echo "Node 20+ is required for the web app (found $(node --version 2>/dev/null || echo none))."; exit 1; fi
fi
[ -d web/node_modules ] || (cd web && npm install)

# Stop everything this script started (engine, npm, vite) — the whole process group.
cleanup() {
  trap - EXIT INT TERM
  if [ "${HEATTWIN_PGRP:-}" = "1" ]; then kill -- -$$ 2>/dev/null || true; return; fi
  for pid in ${WEB_PID:-} ${ENGINE_PID:-}; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# ROS-style PYTHONPATH entries break the venv; the engine needs only the repo.
env -u PYTHONPATH .venv/bin/python -m uvicorn engine.api:app --port "$PORT" --log-level warning &
ENGINE_PID=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "engine did not start"; exit 1; }
echo "engine up on :$PORT — sensor: $(curl -s http://127.0.0.1:$PORT/node/status)"

(cd web && npm run dev -- --strictPort) &
WEB_PID=$!
for _ in $(seq 1 60); do curl -sf http://localhost:5173 >/dev/null && break; sleep 0.5; done
if command -v xdg-open >/dev/null; then xdg-open http://localhost:5173 >/dev/null 2>&1 || true
elif command -v open >/dev/null; then open http://localhost:5173 || true; fi
echo
echo "HeatTwin is running at http://localhost:5173  (Ctrl+C to stop)"
echo "Keep your hands off the thermistor for ~5 s after the Arduino connects (it zeroes on the room)."
wait

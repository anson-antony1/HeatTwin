#!/usr/bin/env bash
# One command for the sensor demo: engine (with the built-in Arduino bridge) + web app, opens the browser.
# Ctrl+C stops both. The Arduino can be plugged in before or after; the engine finds it (GET /node/status).
# Runs in the terminal's own job (no setsid: a separate session would not receive Ctrl+C from the terminal).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${HEATTWIN_PORT:-8010}"
export HEATTWIN_PORT="$PORT"

# Refuse to start on top of a leftover run (a stray engine on the port gives "address already in use").
for p in "$PORT" 5173; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "Port $p is already in use — a previous HeatTwin run is probably still going."
    echo "Stop it with:  pkill -f 'uvicorn engine.api'; pkill -f vite      then run this again."
    exit 1
  fi
done
# The engine's built-in bridge defaults to FIELD mode (thermistor = air temperature, NWS for the rest). This script is the
# indoor globe-as-sun demo, so it asks for DEMO mode; set HEATTWIN_NODE_MODE=field to run field mode through it instead.
export HEATTWIN_NODE_MODE="${HEATTWIN_NODE_MODE:-demo}"

# Node ≥ 20 for Vite; use ~/.local/node22 when the system node is older.
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
  if [ -x "$HOME/.local/node22/bin/node" ]; then export PATH="$HOME/.local/node22/bin:$PATH"
  else echo "Node 20+ is required for the web app (found $(node --version 2>/dev/null || echo none))."; exit 1; fi
fi
[ -d web/node_modules ] || (cd web && npm install)

# Stop everything this script started (engine, npm, vite and their children), on Ctrl+C, kill or any exit.
killtree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do killtree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  trap - EXIT INT TERM
  for pid in ${WEB_PID:-} ${ENGINE_PID:-}; do killtree "$pid"; done
  wait 2>/dev/null || true
  echo "HeatTwin stopped."
}
trap cleanup EXIT
trap 'exit 130' INT TERM

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

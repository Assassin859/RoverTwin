#!/usr/bin/env bash
# Cold-start check for the demo laptop (macOS / Linux).
# Usage: from repo root  bash scripts/smoke.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== RoverTwin smoke =="
if [[ ! -d .venv ]]; then
  echo "Creating .venv…"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt
echo "pytest…"
python -m pytest -q

PORT=8765
python -m uvicorn backend.app:app --port "$PORT" >/tmp/rt_smoke_out.txt 2>/tmp/rt_smoke_err.txt &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

ok=0
for _ in $(seq 1 40); do
  sleep 0.25
  if curl -fsS "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
    ok=1
    break
  fi
done
if [[ "$ok" -ne 1 ]]; then
  echo "uvicorn failed to answer on :${PORT}" >&2
  cat /tmp/rt_smoke_err.txt >&2 || true
  exit 1
fi
echo "OK  pytest + http://127.0.0.1:${PORT}/api/state"

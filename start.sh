#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build -j4
if [[ ! -d frontend/node_modules ]]; then
  (cd frontend && npm install)
fi
./backend/build/saarathi_server &
BACKEND_PID=$!
trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT INT TERM
cd frontend
npm run dev

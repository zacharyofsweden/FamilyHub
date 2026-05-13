#!/usr/bin/env bash
# FamilyHub startup script — starts Kokoro TTS + local server + opens browser

KOKORO_DIR="$HOME/Documents/Obsidian/archive/Kokoro-TTS"
HUB_DIR="$HOME/FamilyHub"

echo "=== FamilyHub Startup ==="

# Start Kokoro TTS if not already running
if ! curl -s http://localhost:5002/openapi.json >/dev/null 2>&1; then
  echo "Starting Kokoro TTS on port 5002..."
  if [ -d "$KOKORO_DIR/kokoro_env" ]; then
    source "$KOKORO_DIR/kokoro_env/bin/activate"
  fi
  cd "$KOKORO_DIR"
  python3 -m uvicorn kokoro_api:app --host 127.0.0.1 --port 5002 &
  KOKORO_PID=$!
  echo "Kokoro PID: $KOKORO_PID"
  sleep 2
else
  echo "Kokoro TTS already running on port 5002"
fi

# Start FamilyHub server if not already running
if ! curl -s http://localhost:7890/ >/dev/null 2>&1; then
  echo "Starting FamilyHub server on port 7890..."
  cd "$HUB_DIR"
  node server.js &
  HUB_PID=$!
  echo "FamilyHub PID: $HUB_PID"
  sleep 1
else
  echo "FamilyHub already running on port 7890"
fi

echo "Opening http://localhost:7890 ..."
open http://localhost:7890

echo ""
echo "To stop: kill \$(lsof -ti:7890) \$(lsof -ti:5002)"

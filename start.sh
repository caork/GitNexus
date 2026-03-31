#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.gitnexus.pid"
LOG_FILE="$SCRIPT_DIR/.gitnexus.log"

# Already running?
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "GitNexus is already running (PID $(cat "$PID_FILE"))"
  echo "Open: http://localhost:${GITNEXUS_PORT:-4747}"
  exit 0
fi

# Build web UI if dist is missing or outdated
WEB_DIST="$SCRIPT_DIR/gitnexus-web/dist/index.html"
WEB_SRC="$SCRIPT_DIR/gitnexus-web/src"
if [ ! -f "$WEB_DIST" ] || [ "$WEB_SRC" -nt "$WEB_DIST" ]; then
  echo "Building web UI..."
  cd "$SCRIPT_DIR/gitnexus-web" && npm run build
  cd "$SCRIPT_DIR"
fi

echo "Starting GitNexus..."
node "$SCRIPT_DIR/gitnexus/dist/cli/index.js" serve \
  ${GITNEXUS_PORT:+--port "$GITNEXUS_PORT"} \
  ${GITNEXUS_HOST:+--host "$GITNEXUS_HOST"} \
  >> "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "  Started (PID $(cat "$PID_FILE"))"
  echo "  Open: http://localhost:${GITNEXUS_PORT:-4747}"
  echo "  Logs: $LOG_FILE"
  echo "  Stop: ./stop.sh"
else
  echo "Failed to start. Check logs: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi

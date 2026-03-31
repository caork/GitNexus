#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.gitnexus.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" && echo "Stopped GitNexus (PID $PID)"
  else
    echo "Process $PID is not running"
  fi
  rm -f "$PID_FILE"
else
  # Fallback: kill by port
  PID=$(lsof -ti ":${GITNEXUS_PORT:-4747}" 2>/dev/null)
  if [ -n "$PID" ]; then
    kill -TERM $PID && echo "Stopped GitNexus (PID $PID)"
  else
    echo "GitNexus is not running"
  fi
fi

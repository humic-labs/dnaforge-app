#!/bin/bash

LINES=${1:-50}
LOG_FILE="$HOME/Library/Application Support/DNAForge/logs/client.log"

if [ -f "$LOG_FILE" ]; then
  tail -n "$LINES" "$LOG_FILE"
else
  echo "Log file not found: $LOG_FILE"
  echo "Make sure the app has been running with DevConsoleCapture enabled."
fi

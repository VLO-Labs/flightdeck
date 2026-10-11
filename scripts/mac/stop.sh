#!/bin/bash
# Stops the local Flightdeck server (a chat turn in flight is marked "stopped" on next start).
PORT="${FLIGHTDECK_PORT:-8100}"
pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -z "$pids" ]; then echo "Flightdeck isn't running."; exit 0; fi
kill $pids && echo "Flightdeck stopped."

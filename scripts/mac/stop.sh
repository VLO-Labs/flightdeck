#!/bin/bash
# Stops Flightdeck: quits the app (which stops its server). Falls back to the process on the port.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$REPO/.env" ]; then set -a; . "$REPO/.env"; set +a; fi
PORT="${FLIGHTDECK_PORT:-8100}"
osascript -e 'if application id "com.vlolabs.flightdeck" is running then tell application id "com.vlolabs.flightdeck" to quit' 2>/dev/null
for _ in $(seq 1 30); do lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done
pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"
[ -n "$pids" ] && kill $pids
echo "Flightdeck stopped."

#!/bin/bash
# Installs (or updates) Flightdeck on this Mac as Flightdeck.app in /Applications
# (~/Applications if /Applications isn't writable).
#
#   App code   ~/Library/Application Support/Flightdeck/app   (a copy: chats that edit the Flightdeck
#                                                             repo can't change the running server)
#   Data       ~/Library/Application Support/Flightdeck/data  (SQLite + chat feeds)
#   Log        ~/Library/Logs/Flightdeck.log
#
# Flightdeck.app is a normal Mac app (scripts/mac/FlightdeckApp.swift): opening it starts the server
# on http://flightdeck.localhost:8100 and opens the browser; quitting it stops the server.
# Re-run this script after pulling changes; it quits and reopens a running app.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$HOME/Library/Application Support/Flightdeck"
APPS=/Applications; [ -w "$APPS" ] || APPS="$HOME/Applications"
APP_BUNDLE="$APPS/Flightdeck.app"
LOG="$HOME/Library/Logs/Flightdeck.log"
# Not 80: macOS lets an ordinary app take port 80 only on every interface (the LAN), never on
# loopback alone, and Flightdeck must stay loopback-only. scripts/mac/port80.sh forwards 80 → here.
PORT="${FLIGHTDECK_PORT:-8100}"
HOST_NAME="${FLIGHTDECK_HOST_NAME:-flightdeck.localhost}" # *.localhost needs no /etc/hosts entry
NODE="$(command -v node)" || { echo "node not found" >&2; exit 1; }
CLAUDE="$HOME/.local/bin/claude"
[ -x "$CLAUDE" ] || { echo "Claude Code not found at $CLAUDE (install it and run 'claude' once to log in)" >&2; exit 1; }

# Never under a busy server: updating replaces its files (node_modules included) and restarts it,
# which would end a chat turn or map refresh in flight. Claude runs as the server's child.
SERVER_PID="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$SERVER_PID" ] && pgrep -P "$SERVER_PID" -f claude >/dev/null 2>&1; then
  echo "! Flightdeck is busy (a chat turn or map refresh is running). Nothing was changed;" >&2
  echo "  run this again when it's idle." >&2
  exit 1
fi
WAS_RUNNING=""; [ -n "$SERVER_PID" ] && WAS_RUNNING=1
[ -n "$WAS_RUNNING" ] && { echo "→ quitting Flightdeck"; "$REPO/scripts/mac/stop.sh" >/dev/null; }

# Earlier installs: a copy in ~/Applications, and a launchd agent that ran the server.
[ "$APPS" = /Applications ] && rm -rf "$HOME/Applications/Flightdeck.app"
launchctl bootout "gui/$(id -u)/com.vlolabs.flightdeck" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.vlolabs.flightdeck.plist"

echo "→ copying the app to $HOME_DIR/app"
mkdir -p "$HOME_DIR/app" "$HOME_DIR/data" "$HOME/Library/Logs" "$APPS"
rsync -a --delete --exclude .git --exclude .env --exclude node_modules --exclude dist --exclude data "$REPO/" "$HOME_DIR/app/"
echo "→ installing dependencies and building"
(cd "$HOME_DIR/app" && npm ci --no-audit --no-fund --loglevel=error && npx vite build --logLevel error)

echo "→ building $APP_BUNDLE"
BUILD="$(mktemp -d)"
swiftc -O -o "$BUILD/Flightdeck" "$REPO/scripts/mac/FlightdeckApp.swift"
swift "$REPO/scripts/mac/icon.swift" "$BUILD/icon.png" 2>/dev/null
mkdir -p "$BUILD/Flightdeck.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon.png" --out "$BUILD/Flightdeck.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$BUILD/icon.png" --out "$BUILD/Flightdeck.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
mv "$BUILD/Flightdeck" "$APP_BUNDLE/Contents/MacOS/Flightdeck"
iconutil -c icns "$BUILD/Flightdeck.iconset" -o "$APP_BUNDLE/Contents/Resources/Flightdeck.icns"
rm -rf "$BUILD"
# FD* keys are the app's settings (read by FlightdeckApp.swift).
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Flightdeck</string>
  <key>CFBundleDisplayName</key><string>Flightdeck</string>
  <key>CFBundleIdentifier</key><string>com.vlolabs.flightdeck</string>
  <key>CFBundleExecutable</key><string>Flightdeck</string>
  <key>CFBundleIconFile</key><string>Flightdeck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>FDNode</key><string>$NODE</string>
  <key>FDAppDir</key><string>$HOME_DIR/app</string>
  <key>FDData</key><string>$HOME_DIR/data</string>
  <key>FDClaude</key><string>$CLAUDE</string>
  <key>FDPort</key><string>$PORT</string>
  <key>FDHost</key><string>$HOST_NAME</string>
  <key>FDLog</key><string>$LOG</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true # ad-hoc, so macOS treats it as one app
touch "$APP_BUNDLE"

[ -n "$WAS_RUNNING" ] && { echo "→ reopening Flightdeck"; open "$APP_BUNDLE"; }
echo "✓ Flightdeck installed: $APP_BUNDLE (or Spotlight: Flightdeck)."

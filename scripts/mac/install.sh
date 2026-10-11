#!/bin/bash
# Installs (or updates) Flightdeck on this Mac and creates ~/Applications/Flightdeck.app.
#
#   App code   ~/Library/Application Support/Flightdeck/app   (a copy: chats that edit the Flightdeck
#                                                             repo can't change the running server)
#   Data       ~/Library/Application Support/Flightdeck/data  (SQLite + chat feeds)
#   Log        ~/Library/Logs/Flightdeck.log
#
# Opening Flightdeck.app starts the server on http://flightdeck.localhost:8100 if it isn't running, then opens
# it in the browser. Re-run this script after pulling changes; it restarts a running server.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$HOME/Library/Application Support/Flightdeck"
APP_BUNDLE="$HOME/Applications/Flightdeck.app"
# Not 80: macOS lets an ordinary app take port 80 only on every interface (the LAN), never on
# loopback alone, and Flightdeck must stay loopback-only.
PORT="${FLIGHTDECK_PORT:-8100}"
HOST_NAME="${FLIGHTDECK_HOST_NAME:-flightdeck.localhost}" # *.localhost needs no /etc/hosts entry
NODE="$(command -v node)" || { echo "node not found" >&2; exit 1; }
CLAUDE="$HOME/.local/bin/claude"
[ -x "$CLAUDE" ] || { echo "Claude Code not found at $CLAUDE (install it and run 'claude' once to log in)" >&2; exit 1; }

echo "→ copying the app to $HOME_DIR/app"
mkdir -p "$HOME_DIR/app" "$HOME_DIR/data" "$HOME/Library/Logs" "$HOME/Applications"
rsync -a --delete --exclude .git --exclude .env --exclude node_modules --exclude dist --exclude data "$REPO/" "$HOME_DIR/app/"
echo "→ installing dependencies and building"
(cd "$HOME_DIR/app" && npm ci --no-audit --no-fund --loglevel=error && npx vite build --logLevel error)

echo "→ creating $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Flightdeck</string>
  <key>CFBundleIdentifier</key><string>com.vlolabs.flightdeck</string>
  <key>CFBundleExecutable</key><string>Flightdeck</string>
  <key>CFBundleIconFile</key><string>Flightdeck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
# The launcher: start the server unless it already answers, then open it. The server is detached,
# so it keeps running after the launcher exits (stop it with scripts/mac/stop.sh).
cat > "$APP_BUNDLE/Contents/MacOS/Flightdeck" <<LAUNCH
#!/bin/bash
URL="http://$HOST_NAME$([ "$PORT" = 80 ] || echo ":$PORT")"
export PATH="\$HOME/.local/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# An API key would silently replace the subscription login in \`claude -p\`.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
if ! curl -sf "\$URL/health" >/dev/null; then
  cd "$HOME_DIR/app" || exit 1
  FLIGHTDECK_PORT=$PORT FLIGHTDECK_DATA="$HOME_DIR/data" CLAUDE_BIN="$CLAUDE" \\
    nohup "$NODE" --import tsx src/server/main.ts >>"\$HOME/Library/Logs/Flightdeck.log" 2>&1 < /dev/null &
  disown
  for _ in \$(seq 1 50); do curl -sf "\$URL/health" >/dev/null && break; sleep 0.2; done
fi
# Without the port when scripts/mac/port80.sh has set up forwarding.
OPEN="\$URL"
curl -sf -m 1 "http://$HOST_NAME/health" >/dev/null && OPEN="http://$HOST_NAME"
open "\$OPEN"
LAUNCH
chmod +x "$APP_BUNDLE/Contents/MacOS/Flightdeck"

echo "→ drawing the icon"
ICON_TMP="$(mktemp -d)"
swift "$REPO/scripts/mac/icon.swift" "$ICON_TMP/icon.png" 2>/dev/null
mkdir -p "$ICON_TMP/Flightdeck.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_TMP/icon.png" --out "$ICON_TMP/Flightdeck.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON_TMP/icon.png" --out "$ICON_TMP/Flightdeck.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICON_TMP/Flightdeck.iconset" -o "$APP_BUNDLE/Contents/Resources/Flightdeck.icns"
rm -rf "$ICON_TMP"
touch "$APP_BUNDLE"

# Pick up the new code if the server was running.
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "→ restarting the running server"
  "$REPO/scripts/mac/stop.sh" >/dev/null
  open "$APP_BUNDLE"
fi
echo "✓ Flightdeck installed: open it from ~/Applications (or Spotlight: Flightdeck)."

#!/bin/bash
# Makes Flightdeck reachable without a port: http://flightdeck.localhost and http://flightdeck.vlolabs.
# Run once with sudo:   sudo ~/dev/vlolabs/flightdeck/scripts/mac/port80.sh        (undo: --remove)
#
# Flightdeck listens on 127.0.0.1:8100 only (macOS won't let an ordinary app take port 80 on loopback
# alone). This adds a pf rule that forwards loopback port 80 to it — loopback traffic only, so
# nothing on the network can reach it — loaded at boot by a LaunchDaemon. The rule lives under the
# com.apple/ anchor that macOS's stock /etc/pf.conf already loads, so pf.conf isn't edited.
# It also maps flightdeck.vlolabs to 127.0.0.1 in /etc/hosts (*.localhost needs no entry).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
ANCHOR=/etc/pf.anchors/com.vlolabs.flightdeck
PLIST=/Library/LaunchDaemons/com.vlolabs.flightdeck-port80.plist
NAME=com.apple/flightdeck
HOSTS_LINE="127.0.0.1 flightdeck.vlolabs # flightdeck"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout system "$PLIST" 2>/dev/null || true
  pfctl -a "$NAME" -F all 2>/dev/null || true
  rm -f "$ANCHOR" "$PLIST"
  sed -i '' '/# flightdeck$/d' /etc/hosts
  echo "Removed: port 80 forwarding and the flightdeck.vlolabs hosts entry."
  exit 0
fi

echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port 8100" > "$ANCHOR"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vlolabs.flightdeck-port80</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>/sbin/pfctl -a $NAME -f $ANCHOR &amp;&amp; /sbin/pfctl -E</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
chmod 644 "$ANCHOR" "$PLIST"
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
grep -q '# flightdeck$' /etc/hosts || echo "$HOSTS_LINE" >> /etc/hosts
dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true
sleep 1
pfctl -a "$NAME" -s nat 2>/dev/null | grep -q 8100 && echo "✓ port 80 → 8100 forwarding is active" || echo "! the pf rule didn't load; check: pfctl -a $NAME -s nat"
echo "✓ http://flightdeck.localhost and http://flightdeck.vlolabs"

#!/bin/bash
# Gives Flightdeck a port-less address, http://flightdeck.vlolabs, without touching anything else.
# Run once with sudo:   sudo ~/dev/vlolabs/flightdeck/scripts/mac/port80.sh        (undo: --remove)
#
#   - Flightdeck gets its own loopback address, 127.77.0.1, and flightdeck.vlolabs points at it
#     (/etc/hosts). 127.0.0.1:80 stays free for any other local app.
#   - A pf rule forwards 127.77.0.1:80 to 127.0.0.1:8101, a port Flightdeck opens only for this:
#     pf breaks direct connections to the port it forwards to, so it must not be 8100, which the
#     browser (http://flightdeck.localhost:8100) and Claude's hook use directly.
#   - Loopback only: nothing on the network can reach it. A LaunchDaemon re-applies it at boot.
#     The rule lives under the com.apple/ anchor the stock /etc/pf.conf already loads.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
IP=127.77.0.1
TARGET=8101
ANCHOR=/etc/pf.anchors/com.vlolabs.flightdeck
PLIST=/Library/LaunchDaemons/com.vlolabs.flightdeck-port80.plist
NAME=com.apple/flightdeck

remove() {
  launchctl bootout system "$PLIST" 2>/dev/null || true
  pfctl -a "$NAME" -F all 2>/dev/null || true
  ifconfig lo0 -alias "$IP" 2>/dev/null || true
  rm -f "$ANCHOR" "$PLIST"
  sed -i '' '/# flightdeck$/d' /etc/hosts
}

remove # also clears the first version, which forwarded 127.0.0.1:80 itself
if [ "${1:-}" = "--remove" ]; then
  dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true
  echo "Removed: flightdeck.vlolabs, its loopback address and the port 80 forwarding."
  exit 0
fi

echo "rdr pass on lo0 inet proto tcp from any to $IP port 80 -> 127.0.0.1 port $TARGET" > "$ANCHOR"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vlolabs.flightdeck-port80</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>/sbin/ifconfig lo0 alias $IP up &amp;&amp; /sbin/pfctl -a $NAME -f $ANCHOR &amp;&amp; /sbin/pfctl -E</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
chmod 644 "$ANCHOR" "$PLIST"
launchctl bootstrap system "$PLIST"
echo "$IP flightdeck.vlolabs # flightdeck" >> /etc/hosts
dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true
sleep 1
ifconfig lo0 | grep -q "inet $IP " && echo "✓ $IP is up on loopback" || echo "! $IP isn't on lo0"
pfctl -a "$NAME" -s nat 2>/dev/null | grep -q "$TARGET" && echo "✓ $IP:80 → 127.0.0.1:$TARGET" || echo "! the pf rule didn't load; check: pfctl -a $NAME -s nat"
echo "✓ http://flightdeck.vlolabs (and http://flightdeck.localhost:8100 directly)"

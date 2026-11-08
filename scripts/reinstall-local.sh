#!/usr/bin/env bash
# Rebuild the runtime, install the native-messaging host, and reload the
# unpacked extension.
#
# The runtime binary embeds a digest of the extension's runtime assets
# (crates/navichrome-runtime/build.rs), and the native host refuses to pair with
# an extension whose assets do not match. Editing background.js or lib/* and
# reloading Chrome alone therefore leaves the host refusing every pairing, so
# this script does all three steps in the order that keeps them consistent.
#
# Usage:
#   scripts/reinstall-local.sh                # rebuild + install the host
#   scripts/reinstall-local.sh <extension-id> # ... and reload the extension
#
# The extension id is on its card in chrome://extensions. Reloading through
# dev-reload.html releases every paired session; rediscover tabs afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_ID="${1:-}"
HOST_BIN="${NAVICHROME_NATIVE_HOST_BIN:-$HOME/.navichrome/bin/navichrome}"

cargo build --locked --release -p navichrome-runtime --manifest-path "$ROOT/Cargo.toml"

if [ ! -d "$(dirname "$HOST_BIN")" ]; then
  echo "Native host directory $(dirname "$HOST_BIN") does not exist; pass NAVICHROME_NATIVE_HOST_BIN." >&2
  exit 1
fi
if [ "$ROOT/target/release/navichrome" -ef "$HOST_BIN" ]; then
  echo "Native host already installed: $HOST_BIN"
else
  cp "$ROOT/target/release/navichrome" "$HOST_BIN"
  echo "Installed native host: $HOST_BIN"
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "Now reload the extension in chrome://extensions, or rerun with its id to reload it from disk."
  exit 0
fi

PAGE="chrome-extension://$EXTENSION_ID/dev-reload.html?close=1"
BRIDGE_PROBE_PAGE="chrome-extension://$EXTENSION_ID/popup.html?bridge_probe=1"
if ! command -v node >/dev/null 2>&1; then
  echo "Cannot verify the reloaded native bridge because Node.js is unavailable." >&2
  exit 1
fi
NAVICHROME_PREVIOUS_HOST_ID="$(node -e 'try{const value=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(typeof value.host_id==="string")process.stdout.write(value.host_id)}catch{}' "$HOME/.navichrome/native-tabs.json")"
NAVICHROME_RELOAD_STARTED_AT_MS="$(node -p 'Date.now()')"
if command -v open >/dev/null 2>&1; then
  open -g -a "Google Chrome" "$PAGE"
  open -g -a "Google Chrome" "$BRIDGE_PROBE_PAGE"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PAGE"
  xdg-open "$BRIDGE_PROBE_PAGE"
else
  echo "Open $PAGE in Chrome to reload the extension." >&2
  exit 0
fi
echo "Asked Chrome to reload $EXTENSION_ID and wake its native bridge"
INVENTORY="$HOME/.navichrome/native-tabs.json"
DEADLINE=$((SECONDS + 30))
while (( SECONDS < DEADLINE )); do
  if node -e 'const fs=require("node:fs"),p=process.argv[1],started=Number(process.argv[2]),previous=process.argv[3];try{const s=fs.statSync(p),v=JSON.parse(fs.readFileSync(p,"utf8")),age=Math.floor(Date.now()/1000)-v.last_seen_unix;process.exit(s.mtimeMs>started&&/^[0-9a-f]{32}$/i.test(v.host_id)&&v.host_id!==previous&&Array.isArray(v.tabs)&&age>=0&&age<=15?0:1)}catch{process.exit(1)}' "$INVENTORY" "$NAVICHROME_RELOAD_STARTED_AT_MS" "$NAVICHROME_PREVIOUS_HOST_ID" >/dev/null 2>&1; then
    echo "Native tab inventory refreshed after extension reload."
    exit 0
  fi
  sleep 1
done
echo "Chrome accepted the reload request, but the native tab inventory did not refresh within 30 seconds. Open the NaviChrome popup and choose Reload bridge, then rediscover tabs." >&2
exit 1

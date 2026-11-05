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

PAGE="chrome-extension://$EXTENSION_ID/dev-reload.html"
if command -v open >/dev/null 2>&1; then
  open -g -a "Google Chrome" "$PAGE"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PAGE"
else
  echo "Open $PAGE in Chrome to reload the extension." >&2
  exit 0
fi
echo "Asked Chrome to reload $EXTENSION_ID"

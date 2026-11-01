#!/usr/bin/env bash
# Rebuild the runtime, install the native-messaging host, and reload the
# unpacked extension.
#
# The runtime binary embeds a digest of the extension's runtime assets
# (crates/controlla-runtime/build.rs), and the native host refuses to pair with
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
HOST_BIN="${CONTROLLA_NATIVE_HOST_BIN:-$HOME/.chrome-controlla/bin/controlla}"

cargo build --locked --release -p controlla-runtime --manifest-path "$ROOT/Cargo.toml"

if [ ! -d "$(dirname "$HOST_BIN")" ]; then
  echo "Native host directory $(dirname "$HOST_BIN") does not exist; pass CONTROLLA_NATIVE_HOST_BIN." >&2
  exit 1
fi
cp "$ROOT/target/release/controlla" "$HOST_BIN"
echo "Installed native host: $HOST_BIN"

if [ -z "$EXTENSION_ID" ]; then
  echo "Now reload the extension in chrome://extensions, or rerun with its id to reload it from disk."
  exit 0
fi

PAGE="chrome-extension://$EXTENSION_ID/dev-reload.html"
if command -v open >/dev/null 2>&1; then
  open -a "Google Chrome" "$PAGE"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PAGE"
else
  echo "Open $PAGE in Chrome to reload the extension." >&2
  exit 0
fi
echo "Asked Chrome to reload $EXTENSION_ID"

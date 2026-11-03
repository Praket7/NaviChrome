#!/bin/sh
set -eu
cargo build --locked --release -p navichrome-runtime
mkdir -p packages/navichrome/bin
if [ -f target/release/navichrome.exe ]; then
    cp target/release/navichrome.exe packages/navichrome/bin/navichrome-core.exe
    cp target/release/navichrome-v2.exe packages/navichrome/bin/navichrome-v2-core.exe
else
    cp target/release/navichrome packages/navichrome/bin/navichrome-core
    cp target/release/navichrome-v2 packages/navichrome/bin/navichrome-v2-core
    chmod 755 packages/navichrome/bin/navichrome packages/navichrome/bin/navichrome-core packages/navichrome/bin/navichrome-v2-core
fi
node scripts/stage-npm-package.mjs

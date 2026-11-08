import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('reinstall reloads the supplied extension without bringing Chrome to the foreground', () => {
  const temp = mkdtempSync(join(tmpdir(), 'navichrome-reinstall-'));
  try {
    const shims = join(temp, 'bin');
    const hostDir = join(temp, 'native-host');
    const openArgs = join(temp, 'open-args');
    mkdirSync(shims);
    mkdirSync(hostDir);
    writeFileSync(join(shims, 'cargo'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(shims, 'open'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OPEN_ARGS"\n');
    chmodSync(join(shims, 'cargo'), 0o755);
    chmodSync(join(shims, 'open'), 0o755);

    execFileSync('/bin/bash', [join(root, 'scripts/reinstall-local.sh'), 'agefmpphbpkiklipjpgbffjjhkmlhifd'], {
      cwd: root,
      env: { ...process.env, PATH: `${shims}:/usr/bin:/bin`, OPEN_ARGS: openArgs, NAVICHROME_NATIVE_HOST_BIN: join(hostDir, 'navichrome') },
      stdio: 'pipe',
    });

    assert.deepEqual(readFileSync(openArgs, 'utf8').trim().split('\n'), [
      '-g', '-a', 'Google Chrome', 'chrome-extension://agefmpphbpkiklipjpgbffjjhkmlhifd/dev-reload.html?close=1',
    ]);
    assert.equal(readFileSync(join(hostDir, 'navichrome')).length, readFileSync(join(root, 'target/release/navichrome')).length);

    execFileSync('/bin/bash', [join(root, 'scripts/reinstall-local.sh'), 'agefmpphbpkiklipjpgbffjjhkmlhifd'], {
      cwd: root,
      env: { ...process.env, PATH: `${shims}:/usr/bin:/bin`, OPEN_ARGS: openArgs, NAVICHROME_NATIVE_HOST_BIN: join(root, 'target/release/navichrome') },
      stdio: 'pipe',
    });
    assert.deepEqual(readFileSync(openArgs, 'utf8').trim().split('\n'), [
      '-g', '-a', 'Google Chrome', 'chrome-extension://agefmpphbpkiklipjpgbffjjhkmlhifd/dev-reload.html?close=1',
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

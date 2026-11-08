import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('Cargo dev and test profiles avoid giant incremental caches and debug binaries', async () => {
  const manifest = await readFile(resolve(root, 'Cargo.toml'), 'utf8');
  for (const profile of ['dev', 'test']) {
    const start = manifest.indexOf(`[profile.${profile}]`);
    assert.notEqual(start, -1, `missing explicit ${profile} profile`);
    const next = manifest.indexOf('\n[', start + 1);
    const block = manifest.slice(start, next < 0 ? manifest.length : next);
    assert.match(block, /^incremental\s*=\s*false$/m, `${profile} retains Cargo incremental cache files`);
    assert.match(block, /^debug\s*=\s*0$/m, `${profile} retains large debug symbols`);
  }
});

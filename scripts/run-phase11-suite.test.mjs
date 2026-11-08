import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configuredAdapterIds, createCleanCandidateSnapshot, EXTENSION_BUILD_PATH, hashDirectory, parseAdapterVersions, requireCleanTree, verifyAdapterVersions } from './run-phase11-suite.mjs';

test('recorded adapter identities must match the pinned client and runtime bytes', () => {
  const hash='a'.repeat(64);
  assert.doesNotThrow(()=>verifyAdapterVersions({'controlla':`sha256:${hash}`,'playwright-mcp':'0.0.83'},hash));
  assert.throws(()=>verifyAdapterVersions({'controlla':`sha256:${hash}`,'playwright-mcp':'1.0.0'},hash));
  assert.throws(()=>verifyAdapterVersions({'controlla':'0.1.0','playwright-mcp':'0.0.83'},hash));
});

test('configured run requires versions only for the selected candidate and baselines', () => {
  assert.deepEqual(configuredAdapterIds('controlla', 'playwright-mcp'), ['controlla','playwright-mcp']);
  assert.throws(() => configuredAdapterIds('controlla', 'controlla'), /baseline/);
});

test('adapter provenance requires explicit exact versions for every configured client', () => {
  assert.throws(() => parseAdapterVersions('', ['one']), /must provide exact observed versions/);
  assert.throws(() => parseAdapterVersions('{"one":"local-command-adapter-v1"}', ['one']), /exact observed client adapter version required/);
  assert.deepEqual(parseAdapterVersions('{"one":"2.7.1"}', ['one']), { one: '2.7.1' });
});

test('qualified convenience run requires a clean Git tree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-clean-tree-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline'], { cwd: dir });
    assert.match(requireCleanTree(dir), /^[a-f0-9]{40}$/);
    await writeFile(join(dir, 'untracked.txt'), 'dirty');
    assert.throws(() => requireCleanTree(dir), /requires a clean Git tree/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dirty checkout snapshots tracked and untracked changes into a clean candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-dirty-snapshot-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await writeFile(join(dir, 'keep.txt'), 'before');
    await writeFile(join(dir, 'remove.txt'), 'remove');
    execFileSync('git', ['add', 'keep.txt', 'remove.txt'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'], { cwd: dir });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    await writeFile(join(dir, 'keep.txt'), 'after');
    await rm(join(dir, 'remove.txt'));
    await writeFile(join(dir, 'new.txt'), 'new');

    const snapshot = await createCleanCandidateSnapshot(dir);
    try {
      assert.equal(snapshot.baseSha, base);
      assert.match(snapshot.patchSha256, /^[a-f0-9]{64}$/);
      assert.notEqual(snapshot.patchSha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      assert.match(requireCleanTree(snapshot.root), /^[a-f0-9]{40}$/);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: snapshot.root, encoding: 'utf8' }).trim(), base);
      assert.equal(await readFile(join(snapshot.root, 'keep.txt'), 'utf8'), 'after');
      assert.equal(await readFile(join(snapshot.root, 'new.txt'), 'utf8'), 'new');
      await assert.rejects(() => readFile(join(snapshot.root, 'remove.txt')));
      assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'after');
      assert.throws(() => requireCleanTree(dir), /requires a clean Git tree/);
    } finally {
      await snapshot.cleanup();
    }
    assert.ok(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('extension build hash covers every asset path and content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-assets-'));
  try {
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'manifest.json'), '{}');
    await writeFile(join(dir, 'nested', 'background.js'), 'first');
    const first = await hashDirectory(dir);
    await writeFile(join(dir, 'nested', 'background.js'), 'second');
    assert.notEqual(await hashDirectory(dir), first);
    await writeFile(join(dir, 'nested', 'new.js'), 'new asset');
    assert.notEqual(await hashDirectory(dir), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configured benchmark hashes the shipped NaviChrome extension directory', async () => {
  const root = new URL('..', import.meta.url).pathname;
  assert.equal(EXTENSION_BUILD_PATH, 'extensions/navichrome');
  assert.match(await hashDirectory(join(root, EXTENSION_BUILD_PATH)), /^[a-f0-9]{64}$/);
});

test('extension hash framing distinguishes embedded NULs from separate files', async () => {
  const left=await mkdtemp(join(tmpdir(),'phase11-hash-left-'));
  const right=await mkdtemp(join(tmpdir(),'phase11-hash-right-'));
  try {
    await writeFile(join(left,'a'),Buffer.from('x\0b\0y'));
    await writeFile(join(right,'a'),Buffer.from('x'));
    await writeFile(join(right,'b'),Buffer.from('y'));
    assert.notEqual(await hashDirectory(left),await hashDirectory(right));
  } finally { await rm(left,{recursive:true,force:true}); await rm(right,{recursive:true,force:true}); }
});

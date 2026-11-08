import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('reinstall reloads the supplied extension without bringing Chrome to the foreground', () => {
  const temp = mkdtempSync(join(tmpdir(), 'navichrome-reinstall-'));
  try {
    const shims = join(temp, 'bin');
    const home = join(temp, 'home');
    const hostDir = join(temp, 'native-host');
    const openArgs = join(temp, 'open-args');
    const openCount = join(temp, 'open-count');
    mkdirSync(shims);
    mkdirSync(join(home, '.navichrome'), {recursive:true});
    mkdirSync(hostDir);
    writeFileSync(join(shims, 'cargo'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(shims, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$OPEN_ARGS"\nCOUNT=$(cat "$OPEN_COUNT" 2>/dev/null || echo 0)\nCOUNT=$((COUNT + 1))\nprintf '%s' "$COUNT" > "$OPEN_COUNT"\nif [ $((COUNT % 2)) -eq 0 ]; then ( sleep 1; node -e 'const fs=require("node:fs"),p=process.argv[1],v=JSON.parse(fs.readFileSync(p,"utf8"));v.last_seen_unix=Math.floor(Date.now()/1000);fs.writeFileSync(p,JSON.stringify(v))' "$HOME/.navichrome/native-tabs.json"; sleep 1; node -e 'const fs=require("node:fs"),p=process.argv[1];fs.writeFileSync(p,JSON.stringify({host_id:Date.now().toString(16).padStart(32,"0"),last_seen_unix:Math.floor(Date.now()/1000),tabs:[]}))' "$HOME/.navichrome/native-tabs.json" ) </dev/null >/dev/null 2>&1 & fi\n`);
    chmodSync(join(shims, 'cargo'), 0o755);
    chmodSync(join(shims, 'open'), 0o755);
    writeFileSync(join(home, '.navichrome/native-tabs.json'), JSON.stringify({host_id:'0'.repeat(32),last_seen_unix:Math.floor(Date.now()/1000)-30,tabs:[]}));

    const started = performance.now();
    const firstRun = execFileSync('/bin/bash', [join(root, 'scripts/reinstall-local.sh'), 'agefmpphbpkiklipjpgbffjjhkmlhifd'], {
      cwd: root,
      env: { ...process.env, HOME:home, PATH: `${shims}:${dirname(process.execPath)}:/usr/bin:/bin`, OPEN_ARGS: openArgs, OPEN_COUNT:openCount, NAVICHROME_NATIVE_HOST_BIN: join(hostDir, 'navichrome') },
      stdio: 'pipe',
    });
    assert.ok(performance.now()-started >= 1800, 'waits for a new native host instead of accepting a fresh heartbeat from the old host');
    assert.match(firstRun.toString(), /Native tab inventory refreshed/);

    const expectedOpenArgs = [
      '-g', '-a', 'Google Chrome', 'chrome-extension://agefmpphbpkiklipjpgbffjjhkmlhifd/dev-reload.html?close=1',
      '-g', '-a', 'Google Chrome', 'chrome-extension://agefmpphbpkiklipjpgbffjjhkmlhifd/popup.html?bridge_probe=1',
    ];
    assert.deepEqual(readFileSync(openArgs, 'utf8').trim().split('\n'), expectedOpenArgs);
    assert.equal(readFileSync(join(hostDir, 'navichrome')).length, readFileSync(join(root, 'target/release/navichrome')).length);

    const secondRun = execFileSync('/bin/bash', [join(root, 'scripts/reinstall-local.sh'), 'agefmpphbpkiklipjpgbffjjhkmlhifd'], {
      cwd: root,
      env: { ...process.env, HOME:home, PATH: `${shims}:${dirname(process.execPath)}:/usr/bin:/bin`, OPEN_ARGS: openArgs, OPEN_COUNT:openCount, NAVICHROME_NATIVE_HOST_BIN: join(root, 'target/release/navichrome') },
      stdio: 'pipe',
    });
    assert.match(secondRun.toString(), /Native tab inventory refreshed/);
    assert.deepEqual(readFileSync(openArgs, 'utf8').trim().split('\n'), [...expectedOpenArgs,...expectedOpenArgs]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('background bridge probe wakes the native service without reading browser tabs and closes its tab', async () => {
  const source = readFileSync(join(root, 'extensions/navichrome/popup.js'), 'utf8');
  let poll;
  let nativeStatusCalls = 0;
  let removedTabId;
  const removed = new Promise(resolve => { removedTabId = resolve; });
  const elements = new Map(['tabs','status','native-status','native-tabs'].map(id => [id, { textContent:'', addEventListener() {}, querySelectorAll:() => [] }]));
  const context = {
    URLSearchParams,
    location:{search:'?bridge_probe=1'},
    document:{querySelector:selector => elements.get(selector.slice(1)) ?? {addEventListener() {}, querySelectorAll:() => [], append() {}}},
    chrome:{
      runtime:{sendMessage:async message => { assert.equal(message.type,'native-status'); nativeStatusCalls++; return {connected:nativeStatusCalls>1}; }},
      tabs:{
        getCurrent(callback) { callback({id:731}); },
        async remove(tabId) { removedTabId(tabId); },
        async query() { throw new Error('bridge probe must not read user tab inventory'); },
      },
    },
    setInterval(callback) { poll=callback; return 1; },
    clearInterval() {},
    window:{addEventListener() {}},
  };
  vm.runInNewContext(source, context, {filename:'popup.js'});
  await new Promise(resolve => setImmediate(resolve));
  await poll();
  assert.equal(await removed,731);
  assert.equal(nativeStatusCalls,2);
});

test('dev reload clears native reconnect backoff before reloading the extension', async () => {
  const previous = Object.fromEntries(['chrome','document','location','window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const events = [];
  const button = { disabled:false, addEventListener(_name, callback) { this.callback=callback; } };
  const nodes = { status:{ dataset:{}, textContent:'' }, detail:{ textContent:'' }, reload:button };
  globalThis.document = { title:'', getElementById:id => nodes[id] };
  globalThis.location = { search:'?auto=0&close=1' };
  globalThis.window = { close() { events.push('close'); } };
  globalThis.chrome = {
    storage:{ session:{ async get() { return {}; }, async set() { return true; }, async remove(key) { events.push(`remove:${key}`); } } },
    runtime:{ reload() { events.push('reload'); } },
  };
  try {
    await import(`${pathToFileURL(join(root,'extensions/navichrome/dev-reload.js')).href}?test=${Date.now()}`);
    await button.callback();
    assert.deepEqual(events,['remove:nativeReconnectAttempts','reload','close']);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  }
});

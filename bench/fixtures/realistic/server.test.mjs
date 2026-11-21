import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

test('same task has isolated acceptance state for concurrent run ids', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phase11-run-isolation-'));
  const token = 'phase11-test-oracle-token';
  const taskId = 'form-guarded-fill';
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify({ [taskId]: {
    task_id: taskId, run_id: 'legacy-run', events: [], completed: true,
    form: { name: 'legacy', notes: 'preserved' }, persisted: true,
  } }));
  const child = spawn(process.execPath, ['bench/fixtures/realistic/server.mjs', '--port=0'], {
    env: { ...process.env, PHASE11_ORACLE_TOKEN: token, PHASE11_STATE_FILE: statePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  });

  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server startup timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.slice(0, end)).base_url); } catch (error) { reject(error); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture server exited ${code}`)); });
  });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const legacy = await fetch(`${base}/__state?task_id=${taskId}&run_id=legacy-run`, { headers });
  assert.equal((await legacy.json()).form.name, 'legacy', 'previous single-run state keys migrate to run-scoped state');
  const run = async (runId) => {
    const acceptance = { kind: 'form', name: runId, notes: `notes-${runId}` };
    const reset = await fetch(`${base}/__reset`, {
      method: 'POST', headers, body: JSON.stringify({ task_id: taskId, run_id: runId, acceptance }),
    });
    assert.equal(reset.status, 200);
    return acceptance;
  };
  const first = await run('run-one');
  const second = await run('run-two');

  for (const [runId, acceptance] of [['run-one', first], ['run-two', second]]) {
    const saved = await fetch(`${base}/accept/form?task=${taskId}&run=${runId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: acceptance.name, notes: acceptance.notes }),
    });
    assert.equal(saved.status, 200, `run ${runId} must not be overwritten by another concurrent run`);
    const state = await fetch(`${base}/__state?task_id=${taskId}&run_id=${runId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.form.name, acceptance.name);
    const page = await fetch(`${base}/registration-form?task=${taskId}&run=${runId}`);
    assert.match(await page.text(), new RegExp(`const run=${JSON.stringify(runId)}`));
  }
});

test('slow-media scenario exposes form controls before its delayed asset completes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phase11-slow-media-'));
  const child = spawn(process.execPath, ['bench/fixtures/realistic/server.mjs', '--port=0'], {
    env: { ...process.env, PHASE11_STATE_FILE: join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server startup timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.slice(0, end)).base_url); } catch (error) { reject(error); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture server exited ${code}`)); });
  });
  const page = await fetch(`${base}/registration-form?task=slow-media-early-form&scenario=form_ready_before_slow_media_completes&run=slow-run`);
  const html = await page.text();
  const controls = html.indexOf('id="name"');
  const slowAsset = html.indexOf('id="slow-media"');
  assert.ok(controls >= 0 && slowAsset > controls, 'the form must appear in the document before the slow resource');
  const started = performance.now();
  const response = await fetch(`${base}/slow-media?task=slow-media-early-form&run=slow-run`);
  assert.equal(response.status, 200);
  assert.ok(performance.now() - started >= 200, 'the media response must remain delayed');
});

test('five-field workflow fixture renders and persists all five form values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phase11-five-field-'));
  const token = 'phase11-five-field-token';
  const taskId = 'five-field-single-workflow';
  const runId = 'five-field-run';
  const child = spawn(process.execPath, ['bench/fixtures/realistic/server.mjs', '--port=0'], {
    env: { ...process.env, PHASE11_ORACLE_TOKEN: token, PHASE11_STATE_FILE: join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server startup timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; const end = output.indexOf('\n'); if (end < 0) return; clearTimeout(timer); try { resolve(JSON.parse(output.slice(0, end)).base_url); } catch (error) { reject(error); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture server exited ${code}`)); });
  });
  const acceptance = {kind:'form',name:'Benchmark User',email:'benchmark@example.invalid',company:'NaviChrome',role:'QA',notes:'Persisted benchmark form'};
  const headers = {authorization:`Bearer ${token}`,'content-type':'application/json'};
  const reset = await fetch(`${base}/__reset`, {method:'POST',headers,body:JSON.stringify({task_id:taskId,run_id:runId,acceptance})});
  assert.equal(reset.status,200);
  const page = await fetch(`${base}/registration-form?task=${taskId}&scenario=five_fields_one_workflow&run=${runId}`);
  const html = await page.text();
  for (const field of ['name','email','company','role','notes']) assert.match(html,new RegExp(`name="${field}"`));
  const saved = await fetch(`${base}/accept/form?task=${taskId}&run=${runId}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:acceptance.name,email:acceptance.email,company:acceptance.company,role:acceptance.role,notes:acceptance.notes})});
  assert.equal(saved.status,200);
  const state = await fetch(`${base}/__state?task_id=${taskId}&run_id=${runId}`,{headers:{authorization:`Bearer ${token}`}});
  assert.deepEqual((await state.json()).form,acceptance);
});

test('50k extraction fixture renders 50000 rows and a run-bound nonce on the target row', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phase11-50k-extraction-'));
  const token = 'phase11-50k-test-token';
  const taskId = '50k-node-targeted-control';
  const runId = 'wide-run';
  const child = spawn(process.execPath, ['bench/fixtures/realistic/server.mjs', '--port=0'], {
    env: { ...process.env, PHASE11_ORACLE_TOKEN: token, PHASE11_STATE_FILE: join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server startup timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.slice(0, end)).base_url); } catch (error) { reject(error); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture server exited ${code}`)); });
  });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const reset = await fetch(`${base}/__reset`, { method:'POST', headers, body:JSON.stringify({task_id:taskId,run_id:runId,acceptance:{kind:'extraction',row:'record-42',status:'older'}}) });
  assert.equal(reset.status, 200);
  const state = await fetch(`${base}/__state?task_id=${taskId}&run_id=${runId}`, {headers:{authorization:`Bearer ${token}`}}).then(response=>response.json());
  assert.match(state.extraction_nonce, /^[a-f0-9]{32}$/);
  const html = await fetch(`${base}/records-table?task=${taskId}&scenario=50000_nodes_one_requested_control&run=${runId}`).then(response=>response.text());
  assert.equal((html.match(/<tr>/g) ?? []).length, 50000);
  assert.ok(html.includes(`<td>record-42</td><td>older</td><td>${state.extraction_nonce}</td>`));
});

test('newest-ranking fixture exposes 50 timestamped candidates and a run-bound winner nonce', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phase11-ranking-fixture-'));
  const token = 'phase11-ranking-test-token';
  const taskId = 'newest-ranking-50-candidates';
  const runId = 'rank-run';
  const child = spawn(process.execPath, ['bench/fixtures/realistic/server.mjs', '--port=0'], {
    env: { ...process.env, PHASE11_ORACLE_TOKEN: token, PHASE11_STATE_FILE: join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server startup timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; const end = output.indexOf('\n'); if (end < 0) return; clearTimeout(timer); try { resolve(JSON.parse(output.slice(0, end)).base_url); } catch (error) { reject(error); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture server exited ${code}`)); });
  });
  const acceptance = {kind:'ranking',row:'record-42',published_at:'2024-01-01T23:59:00Z'};
  const headers = {authorization:`Bearer ${token}`,'content-type':'application/json'};
  const reset = await fetch(`${base}/__reset`, {method:'POST',headers,body:JSON.stringify({task_id:taskId,run_id:runId,acceptance})});
  assert.equal(reset.status,200);
  const page = await fetch(`${base}/records-table?task=${taskId}&scenario=50_candidates_staged_freshness_frontier&run=${runId}`);
  const html = await page.text();
  const rows = [...html.matchAll(/<tr><td>(record-\d+)<\/td><td>([^<]+)<\/td><td>([^<]*)<\/td><\/tr>/g)].map(match=>({row:match[1],published_at:match[2],nonce:match[3]}));
  assert.equal(rows.length,50);
  const winner=rows.reduce((best,row)=>Date.parse(row.published_at)>Date.parse(best.published_at)?row:best);
  assert.equal(winner.row,'record-42');
  assert.equal(winner.published_at,acceptance.published_at);
  assert.match(winner.nonce,/^[a-f0-9]{32}$/);
  assert.ok(rows.filter(row=>row.row!=='record-42').every(row=>row.nonce===''));
  const state=await fetch(`${base}/__state?task_id=${taskId}&run_id=${runId}`,{headers:{authorization:`Bearer ${token}`}});
  assert.equal((await state.json()).extraction_nonce,winner.nonce);
});

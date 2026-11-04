#!/usr/bin/env node
// Real-Chrome Phase 12 workload runner.
//
// The runner drives only the public six-tool MCP surface. Every mutation is
// accepted by the fixture server, not by the acting tool receipt. A row is
// successful only when both the tool completed and the independent state match
// passed.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { createMcpStdioClient } from './mcp-stdio-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const TASK_FILE = resolve(here, '../tasks/phase12-workloads.json');
const DEFAULT_BINARY = resolve(root, 'target/release/navichrome-v2');
const DEFAULT_CHROME = process.env.NAVICHROME_CHROME_EXECUTABLE ?? process.env.NAVICHROME_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_OUTPUT = resolve(root, 'target/verification', `phase12-workloads-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);

function option(name, fallback) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function validateWorkloadManifest(manifest) {
  const failures = [];
  if (manifest?.schema !== 'phase12-workloads-v1') failures.push('schema must be phase12-workloads-v1');
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  if (tasks.length === 0) failures.push('at least one task is required');
  const ids = new Set();
  for (const task of tasks) {
    if (typeof task?.id !== 'string' || !/^[a-z0-9-]{3,80}$/.test(task.id)) failures.push(`invalid task id ${task?.id}`);
    else if (ids.has(task.id)) failures.push(`duplicate task id ${task.id}`);
    else ids.add(task.id);
    for (const field of ['category', 'capability', 'fixture']) {
      if (typeof task?.[field] !== 'string' || task[field].length === 0) failures.push(`${task?.id ?? 'task'} needs ${field}`);
    }
  }
  return { pass: failures.length === 0, failures, tasks };
}

async function startFixture() {
  const oracleToken = randomUUID();
  const child = spawn(process.execPath, [resolve(root, 'bench/fixtures/phase12/server.mjs'), '--port=0'], {
    env: { ...process.env, PHASE12_ORACLE_TOKEN: oracleToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const baseUrl = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('phase12 fixture did not start')), 15_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split('\n').find((entry) => entry.includes('"base_url"'));
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        resolveUrl(parsed.base_url);
      } catch { /* wait for the complete line */ }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`phase12 fixture exited ${code}: ${output.slice(-800)}`));
    });
  });
  return { child, baseUrl, oracleToken };
}

async function resetTask(baseUrl, oracleToken, taskId, runId, acceptance) {
  const response = await fetch(`${baseUrl}/__reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${oracleToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, run_id: runId, acceptance }),
  });
  if (!response.ok) throw new Error(`reset failed for ${taskId}: ${response.status}`);
}

async function readTask(baseUrl, oracleToken, taskId, runId) {
  const response = await fetch(`${baseUrl}/__state?task_id=${encodeURIComponent(taskId)}&run_id=${encodeURIComponent(runId)}`, {
    headers: { authorization: `Bearer ${oracleToken}` },
  });
  if (!response.ok) throw new Error(`state read failed for ${taskId}: ${response.status}`);
  return response.json();
}

function openUrl(baseUrl, fixture, taskId, runId) {
  return `${baseUrl}/${fixture}?task=${encodeURIComponent(taskId)}&run=${encodeURIComponent(runId)}`;
}

async function open(call, url, mode = 'background', readySelector = 'h1') {
  const opened = await call('browser', {
    action: 'open',
    url,
    idempotency_key: `phase12-workload-${randomUUID()}`,
    mode,
    ...(mode === 'background' ? { target_policy: 'create_background_window' } : {}),
    ready_when: { kind: 'selector', selector: readySelector },
  });
  if (!opened?.session_id || !opened?.tab_id) throw new Error(`open failed: ${JSON.stringify(opened).slice(0, 1000)}`);
  return opened;
}

async function release(call, sessionId) {
  if (!sessionId) return null;
  try {
    return await call('browser', { action: 'release', session_id: sessionId });
  } catch (error) {
    return { status: 'release_error', reason: String(error).slice(0, 300) };
  }
}

async function runTaskProgram(call, sessionId, tabId, steps, { evidence = false } = {}) {
  return call('browser', {
    action: 'task',
    session_id: sessionId,
    chrome_tab_id: tabId,
    task_program: { steps },
    ...(evidence ? { max_bytes: 200_000, max_bytes_reason: 'phase12 workload step receipts' } : {}),
  });
}

function completed(result) {
  return result?.status === 'completed' || result?.status === 'verified' || result?.verified === true;
}

async function typingRow(call, fixture, task, body) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'editor', text: body });
  const opened = await open(call, openUrl(fixture.baseUrl, 'typing', task.id, runId), task.mode ?? 'background');
  // Fast key events are trusted foreground input. Opening a foreground tab
  // does not focus its window on every desktop session, so activate the exact
  // owned tab before measuring the key path.
  const activation = task.mode === 'foreground'
    ? await call('browser', {
      action: 'activate',
      session_id: opened.session_id,
      chrome_tab_id: opened.tab_id,
      mode: 'foreground',
      idempotency_key: `phase12-activate-${runId}`,
    })
    : null;
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Typing editor', role: 'textbox', save_as: 'editor' },
    { kind: 'type', reference: '$editor', expected_value: '', value: body, typing_mode: task.typing_mode },
    { kind: 'find', query: 'Save text', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const persisted = state?.persisted === true && state?.editor?.text === body;
  const cleanup = await release(call, opened.session_id);
  return {
    success: completed(result) && persisted,
    client_completed: completed(result),
    persisted,
    commands: 3,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, receipts: result?.receipts?.length ?? null, detail: result ? { reason_code: result.reason_code ?? null, reason: result.reason ?? null, next_action: result.next_action ?? null, failed_operation: result.failed_operation ?? null, raw_receipts: Array.isArray(result.receipts) ? result.receipts.slice(0, 4) : null } : null, activation: activation ? { status: activation.status, presentation_verified: activation.presentation_verified ?? null, window_focused: activation.window_focused ?? null } : null, chars: body.length, text_sha256: sha256(body), cleanup },
  };
}

async function spaRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'form', ...task.expected });
  const opened = await open(call, openUrl(fixture.baseUrl, 'spa', task.id, runId));
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Name', role: 'input', save_as: 'name' },
    { kind: 'fill', reference: '$name', expected_value: '', value: 'Before rerender' },
    { kind: 'find', query: 'Rerender target', role: 'button', save_as: 'rerender' },
    { kind: 'click', reference: '$rerender', predicate: { kind: 'text_present', scope: '#status', text: 'Rerendered' } },
    // A rerender replaces the node and invalidates the semantic mirror. Take
    // the fresh observation the public task contract requires before reusing
    // the same name and role, rather than resolving the detached node.
    { kind: 'observe' },
    { kind: 'find', query: 'Name', role: 'input', save_as: 'name2' },
    { kind: 'fill', reference: '$name2', expected_value: 'Before rerender', value: task.expected.name },
    { kind: 'find', query: 'Save form', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const persisted = state?.persisted === true && state?.form?.name === task.expected.name && state?.form?.notes === task.expected.notes;
  const cleanup = await release(call, opened.session_id);
  return {
    success: completed(result) && persisted,
    client_completed: completed(result),
    persisted,
    commands: 3,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, receipts: result?.receipts?.length ?? null, detail: result ? { reason_code: result.reason_code ?? null, reason: result.reason ?? null, next_action: result.next_action ?? null, failed_operation: result.failed_operation ?? null, raw_receipts: Array.isArray(result.receipts) ? result.receipts.slice(0, 4) : null } : null, state: state?.form ?? null, cleanup },
  };
}

async function childRow(call, fixture, task, body) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'child', text: body });
  const opened = await open(call, openUrl(fixture.baseUrl, 'child', task.id, runId));
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Child editor', role: 'textbox', save_as: 'editor' },
    { kind: 'type', reference: '$editor', expected_value: '', value: body, typing_mode: 'block' },
    { kind: 'find', query: 'Save child', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const persisted = state?.persisted === true && state?.child?.text === body;
  const cleanup = await release(call, opened.session_id);
  return {
    success: completed(result) && persisted,
    client_completed: completed(result),
    persisted,
    commands: 3,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, receipts: result?.receipts?.length ?? null, chars: body.length, text_sha256: sha256(body), cleanup },
  };
}

async function backgroundFormRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'form', ...task.expected });
  const opened = await open(call, openUrl(fixture.baseUrl, 'background', task.id, runId));
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Name', role: 'input', save_as: 'name' },
    { kind: 'fill', reference: '$name', expected_value: '', value: task.expected.name },
    { kind: 'find', query: 'Notes', role: 'textbox', save_as: 'notes' },
    { kind: 'fill', reference: '$notes', expected_value: '', value: task.expected.notes },
    { kind: 'find', query: 'Save form', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const persisted = state?.persisted === true && state?.form?.name === task.expected.name && state?.form?.notes === task.expected.notes;
  const cleanup = await release(call, opened.session_id);
  return {
    success: completed(result) && persisted,
    client_completed: completed(result),
    persisted,
    commands: 3,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, receipts: result?.receipts?.length ?? null, detail: result ? { reason_code: result.reason_code ?? null, reason: result.reason ?? null, next_action: result.next_action ?? null, failed_operation: result.failed_operation ?? null, raw_receipts: Array.isArray(result.receipts) ? result.receipts.slice(0, 4) : null } : null, state: state?.form ?? null, cleanup },
  };
}

async function headlessRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'headless' });
  const url = openUrl(fixture.baseUrl, task.fixture, task.id, runId);
  const result = await call('browser', {
    action: 'task',
    mode: 'headless',
    release_after_task: true,
    task: { kind: 'research', urls: [url], selector: task.selector, goal: 'Read the exact headless parity fact.' },
  });
  const receipt = Array.isArray(result?.receipts) ? result.receipts.find((entry) => entry.kind === 'extract') : null;
  const extracted = String(receipt?.snippet ?? '');
  const success = (result?.status === 'completed' || result?.status === 'verified') && extracted.includes(task.expected_text);
  return {
    success,
    client_completed: result?.status === 'completed' || result?.status === 'verified',
    persisted: success,
    commands: 1,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, receipt_count: result?.receipts?.length ?? null, snippet_sha256: sha256(extracted), released: result?.private_session_released ?? null },
  };
}

async function interferenceRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'interference' });
  const opened = await open(call, openUrl(fixture.baseUrl, 'interference', task.id, runId), 'foreground');
  const activation = await call('browser', {
    action: 'activate',
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    mode: 'foreground',
    idempotency_key: `phase12-activate-${runId}`,
  });
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Arm interference', role: 'button', save_as: 'arm' },
    { kind: 'click', reference: '$arm', predicate: { kind: 'text_present', scope: '#status', text: 'Armed' } },
    { kind: 'observe' },
    { kind: 'find', query: 'Safe field', role: 'input', save_as: 'safe' },
    { kind: 'type', reference: '$safe', expected_value: '', value: task.value, typing_mode: 'fast_keys' },
  ]);
  await sleep(200);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const interference = state?.interference ?? {};
  const trap = String(interference.trap ?? '');
  const safe = String(interference.safe ?? '');
  const interfered = interference.interfered === true;
  const success = state?.persisted === true && interfered && trap.length === 0;
  const cleanup = await release(call, opened.session_id);
  return {
    success,
    client_completed: completed(result),
    persisted: state?.persisted === true && trap.length === 0,
    commands: 5,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: {
      status: result?.status,
      reason_code: result?.reason_code ?? null,
      safe_length: safe.length,
      trap_length: trap.length,
      interfered,
      activation: activation ? { status: activation.status, window_focused: activation.window_focused ?? null } : null,
      cleanup,
    },
  };
}

async function researchRow(call, fixture, task) {
  const runId = randomUUID();
  const facts = Array.from({ length: task.pages }, (_, index) => `citation-fact-${String(index + 1).padStart(2, '0')}`);
  const urls = facts.map((_, index) => `${fixture.baseUrl}/research-page?index=${index}&task=${encodeURIComponent(task.id)}&run=${encodeURIComponent(runId)}`);
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'research', pages: task.pages });
  const batches = [];
  for (let start = 0; start < urls.length; start += 5) {
    batches.push(await call('browser', {
      action: 'task',
      mode: 'headless',
      release_after_task: true,
      task: { kind: 'research', urls: urls.slice(start, start + 5), selector: '#fact', goal: 'Read all ten citation facts with their exact page URLs.' },
      max_bytes: 200_000,
      max_bytes_reason: 'ten-page citation evidence needs bounded URL-backed snippets',
    }, 120_000));
  }
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const receipts = batches.flatMap((result) => Array.isArray(result?.receipts) ? result.receipts : []);
  const evidence = JSON.stringify(receipts);
  const factsFound = facts.filter((fact) => evidence.includes(fact)).length;
  const urlsFound = facts.filter((_, index) => evidence.includes(`index=${index}`)).length;
  const seen = Array.isArray(state?.research_seen) ? state.research_seen : [];
  const success = batches.every((result) => completed(result)) && factsFound === task.pages && urlsFound === task.pages && seen.length === task.pages;
  return {
    success,
    client_completed: batches.every((result) => completed(result)),
    persisted: seen.length === task.pages,
    commands: batches.length,
    actions: receipts.length,
    proof: {
      status: batches.map((result) => result?.status),
      receipt_count: receipts.length,
      facts_found: factsFound,
      urls_found: urlsFound,
      pages_seen: seen.slice().sort((a, b) => a - b),
      released: batches.every((result) => result?.private_session_released === true),
    },
  };
}

async function longformRow(call, fixture, task) {
  const runId = randomUUID();
  const expected = task.expected;
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'draft' });
  const opened = await open(call, openUrl(fixture.baseUrl, 'longform', task.id, runId));
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Full name', role: 'input', save_as: 'name' },
    { kind: 'fill', reference: '$name', expected_value: '', value: expected.full_name },
    { kind: 'find', query: 'Mailing address', role: 'textbox', save_as: 'address' },
    { kind: 'fill', reference: '$address', expected_value: '', value: expected.address },
    { kind: 'find', query: 'Continue', role: 'button', save_as: 'continue' },
    { kind: 'click', reference: '$continue', predicate: { kind: 'text_present', scope: '#status', text: 'Step 2' } },
    { kind: 'observe' },
    { kind: 'find', query: 'Email', role: 'input', save_as: 'email' },
    { kind: 'fill', reference: '$email', expected_value: '', value: expected.email },
    { kind: 'find', query: 'Save draft', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Draft saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Draft saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const draft = state?.draft ?? {};
  const persisted = state?.persisted === true && state?.submitted !== true && draft.full_name === expected.full_name && draft.address === expected.address && draft.email === expected.email;
  const cleanup = await release(call, opened.session_id);
  return {
    success: completed(result) && persisted,
    client_completed: completed(result),
    persisted,
    commands: 6,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, reason_code: result?.reason_code ?? null, draft_present: Object.keys(draft).length > 0, submitted: state?.submitted ?? null, cleanup },
  };
}

function firstReference(value) {
  if (typeof value === 'string') return value.startsWith('@') ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = firstReference(item); if (found) return found; }
    return null;
  }
  if (value && typeof value === 'object') {
    if (typeof value.reference === 'string' && value.reference.startsWith('@')) return value.reference;
    for (const item of Object.values(value)) { const found = firstReference(item); if (found) return found; }
  }
  return null;
}

async function artifactRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'artifacts' });
  const opened = await open(call, openUrl(fixture.baseUrl, 'artifacts', task.id, runId), 'background');
  const snapshot = await call('snapshot', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    selector: '#download',
    max_bytes: 200_000,
    max_bytes_reason: 'phase12 artifact transfer needs one download reference',
  });
  const reference = firstReference(snapshot);
  if (!reference) throw new Error(`artifact snapshot had no reference: ${JSON.stringify(snapshot).slice(0, 800)}`);
  const download = await call('browser', {
    action: 'task',
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    task: {
      kind: 'download',
      reference,
      source: 'page_fetch',
    },
    max_bytes: 200_000,
    max_bytes_reason: 'phase12 artifact download receipt',
  }, 60_000);
  const artifactHandle = download?.artifact_handle
    ?? download?.receipts?.find((entry) => entry.kind === 'download')?.artifact_handle
    ?? null;
  if (!artifactHandle) throw new Error(`download did not return an artifact handle: ${JSON.stringify(download).slice(0, 1000)}`);
  const result = await call('workflow', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    max_bytes: 200_000,
    max_bytes_reason: 'phase12 artifact upload step receipts',
    steps: [
      { kind: 'find', query: 'Choose file', role: 'button', save_as: 'choose' },
      {
        kind: 'upload',
        artifact_handle: artifactHandle,
        trigger_reference: '$choose',
        acceptance: { kind: 'text_present', scope: '#status', text: 'Uploaded' },
        persisted: { kind: 'text_present', scope: '#persisted', text: 'Stored' },
        account_marker: ['#account', 'phase12-owner'],
      },
    ],
  }, 90_000);
  await sleep(100);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const cleanup = await release(call, opened.session_id);
  const accepted = state?.artifact_upload?.filename === 'phase12-artifact.txt'
    && state?.artifact_upload?.text === 'phase12-artifact-v1\n';
  const receipts = Array.isArray(result?.receipts) ? result.receipts : [];
  const success = completed(download) && completed(result) && state?.download_seen === true && state?.persisted === true && accepted;
  return {
    success,
    client_completed: completed(result),
    persisted: state?.persisted === true && accepted,
    commands: 5,
    actions: receipts.length,
    proof: {
      status: result?.status,
      reason_code: result?.reason_code ?? null,
      reason: result?.reason ?? null,
      download_seen: state?.download_seen === true,
      download: { status: download?.status ?? null, artifact_handle: artifactHandle, reason_code: download?.reason_code ?? null },
      upload: state?.artifact_upload ?? null,
      upload_status: result?.status ?? null,
      receipts: receipts.map((receipt) => ({ kind: receipt.kind, status: receipt.status, verified: receipt.verified ?? null, reason_code: receipt.reason_code ?? null })),
      cleanup,
    },
  };
}

async function warmSkillRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'warm-skill' });
  const pageUrl = (index) => `${fixture.baseUrl}/research-page?index=${index}&task=${encodeURIComponent(task.id)}&run=${encodeURIComponent(runId)}`;
  const opened = [];
  const openPage = async (index) => {
    const page = await open(call, pageUrl(index), 'background');
    opened.push(page);
    return page;
  };
  const closePage = async (page) => {
    if (!page) return null;
    const result = await release(call, page.session_id);
    opened.splice(opened.indexOf(page), 1);
    return result;
  };
  const first = await openPage(0);
  const context = await call('browser', {
    action: 'skill',
    skill_action: 'inspect_context',
    session_id: first.session_id,
    chrome_tab_id: first.tab_id,
  });
  const skillId = `phase12-warm-${runId.slice(0, 8)}`;
  const intent = sha256(JSON.stringify({ kind: 'research', selector: '#fact' }));
  const definition = {
    skill_id: skillId,
    schema_version: 1,
    site_scope: context.site_scope,
    intent_fingerprint: intent,
    parameter_names: [],
    preconditions: ['live_document_identity', 'current_structure'],
    workflow: {
      steps: [
        { kind: 'navigate', url: pageUrl(0) },
        { kind: 'extract', selector: '#fact', max_items: 1, max_bytes: 4096 },
        { kind: 'verify', predicate: { kind: 'url', equals: pageUrl(0) } },
      ],
    },
    postconditions: ['verified_task_outcome'],
    structural_signatures: [context.structural_signature],
    version: 1,
  };
  const registered = await call('browser', {
    action: 'skill',
    skill_action: 'register',
    session_id: first.session_id,
    chrome_tab_id: first.tab_id,
    skill_definition: definition,
  });
  const predicateFor = (index) => ({ kind: 'text_present', scope: '#fact', text: `citation-fact-0${index + 1}` });
  const training = [];
  for (const index of [0, 1]) {
    const page = index === 0 ? first : await openPage(index);
    const entry = await call('browser', {
      action: 'skill',
      skill_action: 'training_success',
      session_id: page.session_id,
      chrome_tab_id: page.tab_id,
      skill_id: skillId,
      skill_predicate: predicateFor(index),
    });
    training.push({ status: entry?.status ?? null, reason: entry?.reason ?? null, record: entry?.record ? { status: entry.record.status, training: entry.record.training_input_signatures?.length ?? null } : null });
    await closePage(page);
  }
  const validationPage = await openPage(2);
  const validation = await call('browser', {
    action: 'skill',
    skill_action: 'validation_success',
    session_id: validationPage.session_id,
    chrome_tab_id: validationPage.tab_id,
    skill_id: skillId,
    skill_predicate: predicateFor(2),
  });
  const qualification = await call('browser', {
    action: 'skill',
    skill_action: 'qualify',
    session_id: validationPage.session_id,
    chrome_tab_id: validationPage.tab_id,
    skill_id: skillId,
    skill_predicate: predicateFor(2),
    expires_at_ms: Date.now() + 5 * 60_000,
  });
  await closePage(validationPage);
  const finalPage = await openPage(3);
  const final = await call('browser', {
    action: 'task',
    session_id: finalPage.session_id,
    chrome_tab_id: finalPage.tab_id,
    task: { kind: 'research', urls: [pageUrl(3)], selector: '#fact', goal: 'Read the exact warm-skill fact from the replay page.', tab_ids: [finalPage.tab_id] },
    max_bytes: 200_000,
    max_bytes_reason: 'phase12 warm skill replay evidence',
  }, 90_000);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  await closePage(finalPage);
  const replayRoute = final?.route === 'qualified_skill'
    || (Array.isArray(final?.receipts) && final.receipts.some((receipt) => receipt?.route === 'qualified_skill'));
  const replayTier = final?.execution_route?.tier === 'qualified_skill';
  const success = registered?.status === 'candidate'
    && training.every((entry) => entry.status === 'recorded')
    && validation?.status === 'recorded'
    && qualification?.status === 'qualified'
    && completed(final)
    && replayRoute
    && replayTier
    && Array.isArray(state?.research_seen) && state.research_seen.includes(3);
  const cleanup = await Promise.all(opened.map((page) => release(call, page.session_id)));
  return {
    success,
    client_completed: completed(final),
    persisted: Array.isArray(state?.research_seen) && state.research_seen.includes(3),
    commands: 11,
    actions: 3,
    proof: {
      inspect: { site_scope: context?.site_scope ?? null, structural_signature: context?.structural_signature ?? null },
      register: registered?.status ?? null,
      training,
      validation: { status: validation?.status ?? null, reason: validation?.reason ?? null },
      qualification: { status: qualification?.status ?? null, reason: qualification?.reason ?? null },
      intent,
      final: { status: final?.status ?? null, route: final?.route ?? null, replay_route: replayRoute, replay_tier: replayTier, skill_replays: final?.skill_replays ?? null, skill_fallback_reason: final?.skill_fallback_reason ?? null, receipts: Array.isArray(final?.receipts) ? final.receipts : null, execution_route: final?.execution_route ? { tier: final.execution_route.tier ?? null, intent_fingerprint: final.execution_route.intent_fingerprint ?? null, reason: final.execution_route.reason ?? null, skill_fallback_reason: final.execution_route.skill_fallback_reason ?? null } : null },
      research_seen: state?.research_seen ?? null,
      cleanup,
    },
  };
}

async function webmcpRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'webmcp' });
  const present = await open(call, openUrl(fixture.baseUrl, 'webmcp', task.id, runId), 'background', '#webmcp-ready');
  const snapshot = (opened) => call('snapshot', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    selector: 'h1',
    max_bytes: 200_000,
    max_bytes_reason: 'phase12 WebMCP route needs a fresh page-tool snapshot',
  });
  await snapshot(present);
  // The provider does not expose page_tools in background mode, but the
  // typed page_tool route itself performs discovery and invocation. The tool
  // receipt is not treated as acceptance; the fixture endpoint below is.
  const invoked = await call('act', {
    session_id: present.session_id,
    chrome_tab_id: present.tab_id,
    action: 'page_tool',
    page_tool_name: 'record_lookup',
    page_tool_input: { id: task.record_id },
  }).catch((error) => { throw new Error(`webmcp page_tool failed: ${error}`); });
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const presentOk = invoked?.status === 'dispatched'
    && invoked?.result === task.record_id
    && state?.webmcp?.id === task.record_id && state?.webmcp?.tool === 'record_lookup';

  const absent = await open(call, openUrl(fixture.baseUrl, 'webmcp-absent', task.id, runId), 'background', '#webmcp-ready');
  await snapshot(absent);
  const fallback = await call('act', {
    session_id: absent.session_id,
    chrome_tab_id: absent.tab_id,
    action: 'page_tool',
    page_tool_name: 'record_lookup',
    page_tool_input: { id: task.record_id },
  });
  const fallbackOk = fallback?.status === 'not_dispatched' && fallback?.fallback === 'semantic_ui';
  const cleanup = await Promise.all([release(call, present.session_id), release(call, absent.session_id)]);
  return {
    success: presentOk && fallbackOk,
    client_completed: presentOk && fallbackOk,
    persisted: state?.webmcp?.id === task.record_id,
    commands: 6,
    actions: 2,
    proof: {
      invocation: { status: invoked?.status ?? null, result: invoked?.result ?? null, reason: invoked?.reason ?? null, receipt: invoked ?? null },
      fallback: { status: fallback?.status, fallback: fallback?.fallback ?? null, reason: fallback?.reason ?? null },
      accepted: state?.webmcp ?? null,
      cleanup,
    },
  };
}

async function authRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'auth' });
  const opened = await open(call, openUrl(fixture.baseUrl, 'auth', task.id, runId));
  const first = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Sign in', role: 'button', save_as: 'signin' },
    { kind: 'click', reference: '$signin', predicate: { kind: 'text_present', scope: '#status', text: 'Signed in' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Signed in' } },
  ]);
  const afterLogin = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const second = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'observe' },
    { kind: 'find', query: 'Save session', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Session saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Session saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const success = completed(first) && completed(second) && afterLogin?.authenticated === true && state?.authenticated === true && state?.saved === true && state?.authenticated_persisted === true;
  const cleanup = await release(call, opened.session_id);
  return {
    success,
    client_completed: completed(first) && completed(second),
    persisted: state?.saved === true,
    commands: 6,
    actions: (Array.isArray(first?.receipts) ? first.receipts.length : 0) + (Array.isArray(second?.receipts) ? second.receipts.length : 0),
    proof: { login_status: first?.status, save_status: second?.status, authenticated: state?.authenticated ?? null, saved: state?.saved ?? null, cleanup },
  };
}

async function shadowRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'shadow' });
  const opened = await open(call, openUrl(fixture.baseUrl, 'shadow', task.id, runId));
  const result = await runTaskProgram(call, opened.session_id, opened.tab_id, [
    { kind: 'find', query: 'Deep shadow editor', role: 'input', save_as: 'editor' },
    { kind: 'fill', reference: '$editor', expected_value: '', value: task.value },
    { kind: 'find', query: 'Save shadow', role: 'button', save_as: 'save' },
    { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
    { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
  ]);
  const state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
  const persisted = state?.persisted === true && state?.shadow?.text === task.value;
  const cleanup = await release(call, opened.session_id);
  return {
    success: completed(result) && persisted,
    client_completed: completed(result),
    persisted,
    commands: 4,
    actions: Array.isArray(result?.receipts) ? result.receipts.length : null,
    proof: { status: result?.status, reason_code: result?.reason_code ?? null, text_length: String(state?.shadow?.text ?? '').length, cleanup },
  };
}

async function nestedRow(call, fixture, task) {
  const runId = randomUUID();
  await resetTask(fixture.baseUrl, fixture.oracleToken, task.id, runId, { kind: 'nested' });
  const opened = await open(call, openUrl(fixture.baseUrl, 'nested', task.id, runId));
  const result = await call('workflow', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    max_bytes: 200_000,
    max_bytes_reason: 'phase12 nested-frame step receipts',
    steps: [
      { kind: 'find', query: 'Nested editor', role: 'input', save_as: 'editor' },
      { kind: 'type', reference: '$editor', expected_value: '', value: task.value, typing_mode: 'block' },
      { kind: 'find', query: 'Save nested', role: 'button', save_as: 'save' },
      { kind: 'click', reference: '$save', outcome: { kind: 'text', selector: '#status', text: 'Saved' } },
      { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
    ],
  });
  let state = null;
  let persisted = false, clicked = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    state = await readTask(fixture.baseUrl, fixture.oracleToken, task.id, runId);
    persisted = state?.persisted === true && state?.nested?.text === task.value;
    clicked = state?.nested_clicked === true && state?.nested_click?.text === task.value;
    if (persisted && clicked) break;
    await sleep(50);
  }
  const cleanup = await release(call, opened.session_id);
  const receipts = Array.isArray(result?.receipts) ? result.receipts : [];
  return {
    success: completed(result) && persisted && clicked,
    client_completed: completed(result),
    persisted,
    clicked,
    commands: 5,
    actions: receipts.length,
    proof: {
      status: result?.status,
      reason_code: result?.reason_code ?? null,
      reason: result?.reason ?? null,
      text_length: String(state?.nested?.text ?? '').length,
      clicked: state?.nested_clicked === true,
      pointers: Array.isArray(state?.nested_pointers) ? state.nested_pointers : [],
      receipts: receipts.map((receipt) => ({ step: receipt.step, status: receipt.status, reason_code: receipt.reason_code, reason: receipt.reason, reference: receipt.reference })),
      cleanup,
    },
  };
}

export async function runWorkloads({ binary = DEFAULT_BINARY, output = DEFAULT_OUTPUT, verbose = true } = {}) {
  const manifest = JSON.parse(await readFile(TASK_FILE, 'utf8'));
  const validation = validateWorkloadManifest(manifest);
  if (!validation.pass) throw new Error(validation.failures.join('\n'));
  const fixture = await startFixture();
  const client = createMcpStdioClient({ binary, stateDir: resolve('/tmp', `navichrome-phase12-workloads-${randomUUID()}`), name: 'phase12-workloads', env: { ...process.env, NAVICHROME_CHROME_EXECUTABLE: DEFAULT_CHROME } });
  const results = [];
  let callCount = 0;
  try {
    await client.initialize();
    const call = (tool, args, timeoutMs) => {
      callCount += 1;
      return client.call(tool, args, timeoutMs);
    };
    const only = option('only')?.split(',').map((value) => value.trim()).filter(Boolean);
    const selected = only?.length ? manifest.tasks.filter((task) => only.includes(task.id)) : manifest.tasks;
    if (selected.length === 0) throw new Error('no workload rows selected');
    for (const task of selected) {
      if (verbose) console.log(`RUN ${task.id}`);
      const started = Date.now();
      try {
        let outcome;
        if (task.fixture === 'typing') outcome = await typingRow(call, fixture, task, 'A'.repeat(task.characters));
        else if (task.fixture === 'spa') outcome = await spaRow(call, fixture, task);
        else if (task.fixture === 'child') outcome = await childRow(call, fixture, task, 'B'.repeat(task.characters));
        else if (task.fixture === 'background') outcome = await backgroundFormRow(call, fixture, task);
        else if (task.fixture === 'headless') outcome = await headlessRow(call, fixture, task);
        else if (task.fixture === 'interference') outcome = await interferenceRow(call, fixture, task);
        else if (task.fixture === 'research') outcome = await researchRow(call, fixture, task);
        else if (task.fixture === 'longform') outcome = await longformRow(call, fixture, task);
        else if (task.fixture === 'auth') outcome = await authRow(call, fixture, task);
        else if (task.fixture === 'webmcp') outcome = await webmcpRow(call, fixture, task);
        else if (task.fixture === 'artifacts') outcome = await artifactRow(call, fixture, task);
        else if (task.fixture === 'warm-skill') outcome = await warmSkillRow(call, fixture, task);
        else if (task.fixture === 'shadow') outcome = await shadowRow(call, fixture, task);
        else if (task.fixture === 'nested') outcome = await nestedRow(call, fixture, task);
        else throw new Error(`unsupported fixture ${task.fixture}`);
        results.push({
          id: task.id,
          category: task.category,
          capability: task.capability,
          success: outcome.success,
          client_completed: outcome.client_completed,
          persisted: outcome.persisted,
          commands: outcome.commands,
          actions: outcome.actions,
          wall_ms: Date.now() - started,
          failure: outcome.success ? null : 'independent postcondition mismatch',
          proof: outcome.proof,
        });
        if (verbose) console.log(`${outcome.success ? 'PASS' : 'FAIL'} ${task.id} ${Date.now() - started}ms`);
      } catch (error) {
        results.push({
          id: task.id,
          category: task.category,
          capability: task.capability,
          success: false,
          client_completed: false,
          persisted: false,
          commands: null,
          actions: null,
          wall_ms: Date.now() - started,
          failure: String(error).slice(0, 1200),
        });
        if (verbose) console.log(`ERROR ${task.id}: ${error?.stack ?? String(error)}`);
      }
    }
    const passed = results.filter((row) => row.success).length;
    const report = {
      version: 1,
      kind: 'phase12_workloads',
      generated_at_iso: new Date().toISOString(),
      environment: {
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        binary_sha256: sha256(await readFile(binary)),
        fixture: 'bench/fixtures/phase12/server.mjs',
        fixture_revision: 'phase12-workloads-v1',
      },
      summary: {
        tasks: results.length,
        passed,
        failed: results.length - passed,
        success_rate: results.length === 0 ? 0 : passed / results.length,
        mcp_calls: callCount,
        total_wall_ms: results.reduce((total, row) => total + row.wall_ms, 0),
      },
      results,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    return { report, output };
  } finally {
    await client.close();
    fixture.child.kill('SIGTERM');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkloads({ binary: option('binary', DEFAULT_BINARY), output: option('output', DEFAULT_OUTPUT) })
    .then(({ report, output }) => {
      console.log(JSON.stringify({ summary: report.summary, output }, null, 2));
      setImmediate(() => process.exit(report.summary.failed > 0 ? 1 : 0));
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      setImmediate(() => process.exit(1));
    });
}

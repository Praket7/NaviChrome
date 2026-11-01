#!/usr/bin/env node
// Phase 12 concurrency qualification.
//
// The suite drives independent real Chrome tabs through the public six-tool
// MCP surface. Every tab writes a unique pair of form values, then the fixture
// server - not the acting adapter - decides whether the write landed in the
// correct task scope. A value that appears under another tab's task is a
// wrong-target event, not a timing result.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';

import { createMcpStdioClient } from './mcp-stdio-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const DEFAULT_BINARY = resolve(root, 'target/release/controlla-v2');
const DEFAULT_OUTPUT = resolve(root, 'bench/reports', `phase12-concurrency-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);

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

async function startFixtureServer() {
  const oracleToken = randomUUID();
  const child = spawn(process.execPath, [resolve(root, 'bench/fixtures/realistic/server.mjs'), '--port=0'], {
    env: {
      ...process.env,
      PHASE11_STATE_FILE: resolve(root, `.phase12-concurrency-state-${randomUUID()}.json`),
      PHASE11_ORACLE_TOKEN: oracleToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = await new Promise((resolveUrl, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('fixture server did not become ready'));
    }, 15_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (!line.includes('"base_url"')) continue;
        try {
          const parsed = JSON.parse(line);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveUrl(parsed.base_url);
        } catch { /* wait for a complete line */ }
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error(`fixture server exited ${code}: ${output.slice(-800)}`));
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
  if (!response.ok) throw new Error(`fixture reset failed for ${taskId}: ${response.status}`);
  return response.json();
}

async function readTask(baseUrl, oracleToken, taskId, runId) {
  const response = await fetch(`${baseUrl}/__state?task_id=${encodeURIComponent(taskId)}&run_id=${encodeURIComponent(runId)}`, {
    headers: { authorization: `Bearer ${oracleToken}` },
  });
  if (!response.ok) throw new Error(`fixture state read failed for ${taskId}: ${response.status}`);
  return response.json();
}

async function openForm(call, baseUrl, taskId, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const opened = await call('browser', {
        action: 'open',
        url: `${baseUrl}/fixture/registration-form?task=${encodeURIComponent(taskId)}&tab=${label}`,
        idempotency_key: `phase12-concurrency-${taskId}-${randomUUID()}`,
        mode: 'background',
        target_policy: 'create_background_window',
        ready_when: { kind: 'url_prefix', prefix: baseUrl },
      });
      if (opened.session_id && opened.tab_id) return opened;
      lastError = JSON.stringify(opened).slice(0, 600);
    } catch (error) {
      lastError = String(error).slice(0, 600);
    }
    await sleep(2000);
  }
  throw new Error(`open failed for ${taskId}: ${lastError}`);
}

async function fillForm(call, sessionId, tabId, name, notes) {
  const result = await call('browser', {
    action: 'task',
    session_id: sessionId,
    chrome_tab_id: tabId,
    task_program: {
      steps: [
        { kind: 'find', query: 'Name', role: 'input', save_as: 'name' },
        { kind: 'fill', reference: '$name', expected_value: '', value: name },
        { kind: 'find', query: 'Notes', role: 'textbox', save_as: 'notes' },
        { kind: 'fill', reference: '$notes', expected_value: '', value: notes },
      ],
    },
    max_bytes: 120_000,
    max_bytes_reason: 'retain exact verified field receipts for concurrency evidence',
  });
  const receipts = Array.isArray(result.receipts) ? result.receipts : [];
  const fills = receipts.filter((receipt) => receipt.step === 'fill');
  return {
    status: result.status,
    receipts,
    verified: fills.length === 2 && fills.every((receipt) => receipt.status === 'verified' && receipt.verified === true),
  };
}

async function saveForm(call, sessionId, tabId) {
  const snapshot = await call('snapshot', {
    session_id: sessionId,
    chrome_tab_id: tabId,
    goal: { query: 'Save form', roles: ['button'] },
    max_items: 5,
    max_text_chars: 80,
    max_bytes: 120_000,
    max_bytes_reason: 'acquire the form save control',
  });
  const save = (snapshot.items ?? []).find((item) => item.role === 'button' && /save form/i.test(String(item.name ?? '')));
  if (!save) return { status: 'not_dispatched', reason_code: 'save_control_missing' };
  return call('act', {
    session_id: sessionId,
    chrome_tab_id: tabId,
    action: 'click',
    reference: save.reference,
    outcome: { kind: 'text', selector: '#status', text: 'Saved' },
    max_bytes: 12_000,
    max_bytes_reason: 'retain the save verification receipt',
  });
}

async function runTab(call, baseUrl, oracleToken, index, label) {
  const taskId = `phase12-concurrency-${label}-${index}`;
  const runId = `run-${randomUUID()}`;
  const name = `Concurrent Name ${label} ${index}`;
  const notes = `Concurrent Notes ${label} ${index}`;
  await resetTask(baseUrl, oracleToken, taskId, runId, { kind: 'form', name, notes });
  const opened = await openForm(call, baseUrl, taskId, label);
  const startedAt = Date.now();
  const filled = await fillForm(call, opened.session_id, opened.tab_id, name, notes);
  const saved = await saveForm(call, opened.session_id, opened.tab_id);
  const persisted = await readTask(baseUrl, oracleToken, taskId, runId);
  const endedAt = Date.now();
  const serverAccepted = persisted?.form?.name === name && persisted?.form?.notes === notes && persisted?.persisted === true;
  const wrongTarget = persisted !== null && !serverAccepted && (persisted?.form !== undefined);
  await call('browser', { action: 'release', session_id: opened.session_id }).catch(() => null);
  return {
    index,
    task_id: taskId,
    run_id: runId,
    session_id: opened.session_id,
    tab_id: opened.tab_id,
    start_ms: startedAt,
    end_ms: endedAt,
    wall_ms: endedAt - startedAt,
    fill_status: filled.status,
    fill_verified: filled.verified,
    save_status: saved.status,
    save_reason_code: saved.reason_code ?? null,
    application_accepted: serverAccepted && saved.status === 'verified',
    wrong_target: wrongTarget,
    server_state: persisted === null ? null : {
      persisted: persisted.persisted === true,
      form_name_sha256: persisted.form?.name ? sha256(persisted.form.name) : null,
      form_notes_sha256: persisted.form?.notes ? sha256(persisted.form.notes) : null,
    },
    expected_sha256: { name: sha256(name), notes: sha256(notes) },
    calls: 3,
  };
}

function peakOverlap(rows) {
  const events = [];
  for (const row of rows) {
    events.push({ at: row.start_ms, delta: 1 });
    events.push({ at: row.end_ms, delta: -1 });
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

export async function runConcurrency({ binary = DEFAULT_BINARY, tabs = 8, processes = 2, output = DEFAULT_OUTPUT, verbose = true } = {}) {
  const fixture = await startFixtureServer();
  const client = createMcpStdioClient({ binary, stateDir: resolve('/tmp', `controlla-phase12-concurrency-${randomUUID()}`) });
  const rows = [];
  let multiProcess = null;
  const log = (...args) => { if (verbose) console.log(...args); };
  try {
    await client.initialize();
    const call = (tool, args, timeoutMs) => client.call(tool, args, timeoutMs);
    const labels = Array.from({ length: tabs }, (_, index) => `intra-${index + 1}`);
    log(`opening ${tabs} independent tabs`);
    const opened = await Promise.all(labels.map((label, index) => runTab(call, fixture.baseUrl, fixture.oracleToken, index, label)));
    rows.push(...opened);
    const accepted = rows.filter((row) => row.application_accepted).length;
    const wrongTargets = rows.filter((row) => row.wrong_target).length;
    const summary = {
      tabs,
      accepted,
      wrong_target_events: wrongTargets,
      peak_overlap: peakOverlap(opened),
      serial_sum_ms: opened.reduce((total, row) => total + row.wall_ms, 0),
      wall_ms: Math.max(...opened.map((row) => row.end_ms)) - Math.min(...opened.map((row) => row.start_ms)),
      all_verified: accepted === tabs,
      all_clean: wrongTargets === 0,
    };
    if (processes > 1) {
      log(`running ${processes} independent MCP processes`);
      const clients = Array.from({ length: processes }, () => createMcpStdioClient({
        binary,
        stateDir: resolve('/tmp', `controlla-phase12-multiprocess-${randomUUID()}`),
        name: 'phase12-concurrency-multiprocess',
      }));
      try {
        await Promise.all(clients.map((entry) => entry.initialize()));
        const processRows = await Promise.all(clients.map((entry, index) => runTab(
          (tool, args, timeoutMs) => entry.call(tool, args, timeoutMs),
          fixture.baseUrl,
          fixture.oracleToken,
          index,
          `process-${index + 1}`,
        ).catch((error) => ({
          index,
          task_id: `phase12-concurrency-process-${index + 1}`,
          start_ms: Date.now(),
          end_ms: Date.now(),
          wall_ms: 0,
          application_accepted: false,
          wrong_target: false,
          error: String(error).slice(0, 800),
        }))));
        const processAccepted = processRows.filter((row) => row.application_accepted).length;
        multiProcess = {
          processes,
          accepted: processAccepted,
          wrong_target_events: processRows.filter((row) => row.wrong_target).length,
          peak_overlap: peakOverlap(processRows.filter((row) => Number.isFinite(row.wall_ms))),
          all_verified: processAccepted === processes,
          all_clean: processRows.every((row) => row.wrong_target === false),
          rows: processRows,
        };
      } finally {
        await Promise.all(clients.map((entry) => entry.close()));
      }
    }
    const report = {
      version: 1,
      kind: 'phase12_concurrency',
      generated_at_iso: new Date().toISOString(),
      environment: {
        platform: `${process.platform}-${process.arch}`,
        binary_sha256: sha256(await readFile(binary)),
        tabs,
        processes,
        fixture: 'bench/fixtures/realistic/server.mjs',
      },
      summary,
      multi_process: multiProcess,
      rows,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    log(JSON.stringify({ ...summary, multi_process: multiProcess && {
      processes: multiProcess.processes,
      accepted: multiProcess.accepted,
      peak_overlap: multiProcess.peak_overlap,
      all_verified: multiProcess.all_verified,
      all_clean: multiProcess.all_clean,
      errors: multiProcess.rows.map((row) => row.error).filter(Boolean),
    } }));
    log(`wrote ${output}`);
    return report;
  } finally {
    await client.close();
    fixture.child.kill('SIGTERM');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tabs = Math.max(1, Math.min(16, Number(option('tabs', '8'))));
  const processes = Math.max(1, Math.min(8, Number(option('processes', '2'))));
  const binary = option('binary', DEFAULT_BINARY);
  const output = resolve(option('output', DEFAULT_OUTPUT));
  runConcurrency({ binary, tabs, processes, output })
    .then((report) => {
      if (!report.summary.all_verified || !report.summary.all_clean) process.exitCode = 1;
    })
    .catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}

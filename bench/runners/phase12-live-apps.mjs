#!/usr/bin/env node
// Live installed-Chrome qualification runner for the Phase 12 application
// matrix. It records only what the public six-tool surface actually proved.
//
// Run:
//   node bench/runners/phase12-live-apps.mjs --rows=google-docs-type-1000,react-form
//
// The runner never turns a tool acknowledgement into application acceptance.
// Google Docs is accepted only when the text survives an exact-URL reopen and
// the document's own copy path returns it. The React form is accepted only
// when the page reports its own saved status.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';

import { createMcpStdioClient } from './mcp-stdio-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const matrixPath = resolve(here, '../tasks/phase12-installed-apps.json');
const DEFAULT_BINARY = resolve(root, 'target/release/controlla-v2');
const DEFAULT_EVIDENCE = resolve(root, 'bench/reports', `phase12-evidence-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);

const BLOCKED = {
  'word-web-type-1000': 'no signed-in Microsoft Word for Web surface was available to this runner',
  codemirror: 'the checkout has no installed CodeMirror instance; the deterministic editor-ladder test is not a live application qualification',
  monaco: 'the checkout has no installed Monaco instance; no live application acceptance was observed',
  'contenteditable-ime': 'fixture-only row; the live runner does not claim an installed application',
  'cross-origin-iframe-form': 'fixture-only row; the live runner does not claim an installed application',
  'virtualized-table': 'fixture-only row; the live runner does not claim an installed application',
  'canvas-drag-zoom': 'fixture-only row; the live runner does not claim an installed application',
  'human-interference': 'fixture-only row; the live runner does not claim an installed application',
};

function option(name, fallback) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function textBody(chars, prefix) {
  const line = `${prefix} the quick brown fox jumps over the lazy dog while the clock keeps time. `;
  let body = '';
  let lineNumber = 1;
  while (body.length < chars) body += `Line ${lineNumber++}: ${line}\n`;
  return body.slice(0, chars);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toolMetrics(receipt) {
  return receipt?.metrics && typeof receipt.metrics === 'object' ? receipt.metrics : {};
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function findEditor(call, session, tab) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const snapshot = await call('snapshot', {
      session_id: session,
      chrome_tab_id: tab,
      goal: { query: 'Document content', roles: ['textbox'] },
      max_items: 40,
    });
    const editor = (snapshot.items ?? []).find((item) => item.role === 'textbox');
    if (editor) return { snapshot, editor };
    await sleep(1200);
  }
  return { snapshot: null, editor: null };
}

async function openDocs(call, label, mode = 'background') {
  const key = `phase12-docs-${label}-${randomUUID()}`;
  let opened = await call('browser', {
    action: 'open',
    url: 'https://docs.google.com/document/create',
    idempotency_key: key,
    mode,
    ...(mode === 'background' ? { target_policy: 'create_background_window' } : {}),
    ready_when: { kind: 'url_prefix', prefix: 'https://docs.google.com/document/d/' },
  });
  if (opened.status === 'error' && /timed out|pairing/i.test(String(opened.reason ?? ''))) {
    opened = await call('browser', {
      action: 'open',
      url: 'https://docs.google.com/document/create',
      idempotency_key: key,
      mode,
      target_policy: 'create_background_window',
      ready_when: { kind: 'url_prefix', prefix: 'https://docs.google.com/document/d/' },
    });
  }
  if (!opened.session_id || !opened.tab_id) throw new Error(`Docs open failed: ${JSON.stringify(opened).slice(0, 1200)}`);
  await sleep(4000);
  return opened;
}

async function typeIntoEditor(call, session, tab, body) {
  let typed = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    attempts += 1;
    const { editor } = await findEditor(call, session, tab);
    if (!editor) throw new Error('Docs editor was not observed');
    typed = await call('act', {
      session_id: session,
      chrome_tab_id: tab,
      action: 'type',
      reference: editor.reference,
      expected_value: '',
      value: body,
      typing_mode: 'block',
      timeout_ms: 240_000,
      max_bytes: 32_768,
      max_bytes_reason: 'retain native-host and auto-attach counters for live qualification evidence',
    });
    if (typed.status !== 'not_dispatched' || typed.reason_code !== 'target_replaced') break;
    await sleep(700);
  }
  return { typed, attempts };
}

async function verifyText(call, session, tab, text) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const verified = await call('verify', {
      session_id: session,
      chrome_tab_id: tab,
      predicate: { kind: 'text_present', text },
    });
    if (verified.status === 'passed' || verified.verified === true) return verified;
    await sleep(900);
  }
  return call('verify', {
    session_id: session,
    chrome_tab_id: tab,
    predicate: { kind: 'text_present', text },
  });
}

async function textAbsent(call, session, tab, text, query) {
  const state = await call('snapshot', {
    session_id: session,
    chrome_tab_id: tab,
    goal: { query },
    max_items: 20,
    max_text_chars: 120,
    max_bytes: 200_000,
    max_bytes_reason: 'prove a replaced or undone editor marker is no longer rendered',
  });
  return !(state.items ?? []).some((item) => String(item.text ?? item.name ?? '').includes(text));
}

async function cleanup(call, session, tab) {
  const proofs = {};
  try {
    proofs.close_owned = await call('browser', {
      action: 'close_owned',
      session_id: session,
      chrome_tab_id: tab,
      mode: 'background',
    });
  } catch (error) {
    proofs.close_owned_error = String(error).slice(0, 400);
  }
  try {
    proofs.release = await call('browser', { action: 'release', session_id: session });
  } catch (error) {
    proofs.release_error = String(error).slice(0, 400);
  }
  return proofs;
}

async function runDocsType(call, row) {
  const marker = `Phase12 live docs ${Date.now()}`;
  const body = `${marker}\n${textBody(1000, 'Qualification')}`;
  const opened = await openDocs(call, 'type');
  const started = Date.now();
  const { typed, attempts } = await typeIntoEditor(call, opened.session_id, opened.tab_id, body);
  const elapsed = Date.now() - started;
  const reopened = await call('browser', {
    action: 'open',
    url: opened.url,
    idempotency_key: `phase12-docs-type-reopen-${randomUUID()}`,
    session_id: opened.session_id,
    mode: 'background',
  });
  await sleep(1500);
  const persisted = await verifyText(call, opened.session_id, reopened.tab_id ?? opened.tab_id, marker);
  const metrics = toolMetrics(typed);
  const nativeMessages = numberOrNull(metrics.native_host_messages_sent);
  const autoAttach = numberOrNull(metrics.auto_attach_calls);
  const cdpMethods = metrics.cdp_methods && typeof metrics.cdp_methods === 'object' ? metrics.cdp_methods : null;
  const bodyChars = [...body].length;
  const assertions = {
    exact_text: persisted.status === 'passed' || persisted.verified === true,
    one_model_call: attempts === 1 && typed.status === 'verified',
    one_native_text_transaction: typed.bulk_insert === true,
    // The public receipt does not expose a per-character counter, but it does
    // expose total native messages. A per-character implementation needs at
    // least one message per character; fewer than a quarter proves it did not.
    per_character_native_requests: nativeMessages !== null && nativeMessages < bodyChars / 4,
    // Target.setAutoAttach would appear in the per-call CDP method inventory.
    // The counter itself is omitted when zero, so absence from the inventory is
    // the strongest available proof that the warm route did not toggle it.
    auto_attach_toggles_warm: autoAttach === 0 || (autoAttach === null && cdpMethods !== null && !Object.hasOwn(cdpMethods, 'Target.setAutoAttach')),
  };
  const proof = {
    row: row.id,
    marker_sha256: sha256(marker),
    body_chars: [...body].length,
    completed_chars: typed.completed_chars,
    status: typed.status,
    typing_mode: typed.typing_mode,
    bulk_insert: typed.bulk_insert === true,
    verification: typed.verification,
    elapsed_ms: elapsed,
    attempts,
    native_host_messages_sent: nativeMessages,
    auto_attach_calls: autoAttach,
    cdp_methods: cdpMethods,
    reopen_reused_tab: reopened.tab_id === opened.tab_id,
    reopened_url_sha256: sha256(opened.url),
    persisted_status: persisted.status,
    persisted_verification: persisted.verification ?? null,
    assertions,
    cleanup: await cleanup(call, opened.session_id, reopened.tab_id ?? opened.tab_id),
  };
  return {
    application_accepted: assertions.exact_text,
    client_completed: typed.status === 'verified' && reopened.tab_id === opened.tab_id,
    assertions_passed: Object.values(assertions).every(Boolean),
    proof,
  };
}

async function freshEditor(call, session, tab, label) {
  const { editor } = await findEditor(call, session, tab);
  if (!editor) throw new Error(`Docs editor was not observed before ${label}`);
  return editor;
}

async function runDocsEdit(call, row) {
  const originalMarker = `Phase12 original ${Date.now()}`;
  const replacementMarker = `Phase12 replacement ${Date.now()}`;
  const appendMarker = `Phase12 append ${Date.now()}`;
  const opened = await openDocs(call, 'edit', 'foreground');
  const original = await typeIntoEditor(call, opened.session_id, opened.tab_id, `${originalMarker}\n${textBody(240, 'Original')}`);
  const selectEditor = await freshEditor(call, opened.session_id, opened.tab_id, 'select all');
  const selected = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'press',
    reference: selectEditor.reference,
    key: 'Meta+A',
    timeout_ms: 30_000,
  });
  const replaceEditor = await freshEditor(call, opened.session_id, opened.tab_id, 'replacement');
  const replaced = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'type',
    reference: replaceEditor.reference,
    expected_value: '',
    value: `${replacementMarker}\n${textBody(240, 'Replacement')}`,
    typing_mode: 'block',
    timeout_ms: 240_000,
  });
  const replacementVisible = await verifyText(call, opened.session_id, opened.tab_id, replacementMarker);
  const originalGone = await textAbsent(call, opened.session_id, opened.tab_id, originalMarker, 'Phase12 original');
  const undoEditor = await freshEditor(call, opened.session_id, opened.tab_id, 'undo');
  const undo = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'press',
    reference: undoEditor.reference,
    key: 'Meta+Z',
    timeout_ms: 30_000,
  });
  const originalVisible = await verifyText(call, opened.session_id, opened.tab_id, originalMarker);
  const replacementGone = await textAbsent(call, opened.session_id, opened.tab_id, replacementMarker, 'Phase12 replacement');
  const endEditor = await freshEditor(call, opened.session_id, opened.tab_id, 'caret end');
  const end = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'press',
    reference: endEditor.reference,
    key: 'Meta+ArrowDown',
    timeout_ms: 30_000,
  });
  const appendEditor = await freshEditor(call, opened.session_id, opened.tab_id, 'append');
  const appended = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'type',
    reference: appendEditor.reference,
    expected_value: '',
    value: appendMarker,
    typing_mode: 'block',
    timeout_ms: 120_000,
  });
  const appendVisible = await verifyText(call, opened.session_id, opened.tab_id, appendMarker);
  const writesVerified = [original.typed.status, replaced.status, appended.status].every((status) => status === 'verified');
  const shortcutsDispatched = [selected.status, undo.status, end.status].every((status) => status === 'dispatched' || status === 'verified');
  const assertions = {
    exact_text_after_each_step: writesVerified && shortcutsDispatched && originalGone && replacementGone
      && (replacementVisible.status === 'passed' || replacementVisible.verified === true)
      && (originalVisible.status === 'passed' || originalVisible.verified === true)
      && (appendVisible.status === 'passed' || appendVisible.verified === true),
    // Select-all removed the original marker, undo restored it, and the append
    // left both the restored paragraph and the appended marker present.
    selection_anchor_preserved: originalGone && replacementGone
      && (originalVisible.status === 'passed' || originalVisible.verified === true)
      && (appendVisible.status === 'passed' || appendVisible.verified === true),
  };
  const proof = {
    row: row.id,
    original_marker_sha256: sha256(originalMarker),
    replacement_marker_sha256: sha256(replacementMarker),
    append_marker_sha256: sha256(appendMarker),
    statuses: {
      original: original.typed.status,
      select_all: selected.status,
      replace: replaced.status,
      replacement_visible: replacementVisible.status,
      original_absent_after_replace: originalGone,
      undo: undo.status,
      original_restored: originalVisible.status,
      replacement_absent_after_undo: replacementGone,
      move_to_end: end.status,
      append: appended.status,
      append_visible: appendVisible.status,
    },
    assertions,
    cleanup: await cleanup(call, opened.session_id, opened.tab_id),
  };
  return {
    application_accepted: assertions.exact_text_after_each_step,
    client_completed: writesVerified && shortcutsDispatched,
    assertions_passed: Object.values(assertions).every(Boolean),
    proof,
  };
}

async function startFixtureServer() {
  const oracleToken = randomUUID();
  const child = spawn(process.execPath, [resolve(root, 'bench/fixtures/realistic/server.mjs'), '--port=0'], {
    env: {
      ...process.env,
      PHASE11_STATE_FILE: resolve(root, `.phase12-live-state-${randomUUID()}.json`),
      PHASE11_ORACLE_TOKEN: oracleToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = await new Promise((resolveUrl, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server did not become ready')), 15_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split('\n').find((entry) => entry.includes('"base_url"'));
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        resolveUrl(parsed.base_url);
      } catch {
        // wait for a complete line
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited ${code}: ${output.slice(-1200)}`));
    });
  });
  return { child, baseUrl, oracleToken };
}

async function resetFixture(baseUrl, oracleToken, taskId, runId, acceptance) {
  const response = await fetch(`${baseUrl}/__reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${oracleToken}` },
    body: JSON.stringify({ task_id: taskId, run_id: runId, acceptance }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`fixture reset failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function readFixtureState(baseUrl, oracleToken, taskId, runId) {
  const response = await fetch(`${baseUrl}/__state?task_id=${encodeURIComponent(taskId)}&run_id=${encodeURIComponent(runId)}`, {
    headers: { authorization: `Bearer ${oracleToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`fixture state failed: ${response.status}`);
  return response.json();
}

async function runReactForm(call, row) {
  const { child, baseUrl, oracleToken } = await startFixtureServer();
  let opened = null;
  try {
    const task = `phase12-react-form-${Date.now()}`;
    const runId = randomUUID();
    const acceptance = {
      kind: 'form',
      name: 'Phase12 Benchmark User',
      notes: 'Persisted by the live qualification runner',
    };
    await resetFixture(baseUrl, oracleToken, task, runId, acceptance);
    const url = `${baseUrl}/registration-form?task=${encodeURIComponent(task)}`;
    opened = await call('browser', {
      action: 'open',
      url,
      idempotency_key: `phase12-react-form-${randomUUID()}`,
      mode: 'background',
      target_policy: 'create_background_window',
      ready_when: { kind: 'selector', selector: '#registration-form' },
    });
    if (!opened.session_id || !opened.tab_id) throw new Error(`React form open failed: ${JSON.stringify(opened).slice(0, 1000)}`);
    const taskProgram = {
      steps: [
        // Each find is consumed immediately: a later observation can invalidate
        // an earlier semantic reference, so the program never carries one
        // across an unrelated find.
        { kind: 'find', query: 'Name', role: 'input', save_as: 'name' },
        { kind: 'fill', reference: '$name', expected_value: '', value: 'Phase12 Benchmark User' },
        { kind: 'find', query: 'Notes', role: 'textbox', save_as: 'notes' },
        { kind: 'fill', reference: '$notes', expected_value: '', value: 'Persisted by the live qualification runner' },
        { kind: 'find', query: 'Save form', role: 'button', save_as: 'save' },
        { kind: 'click', reference: '$save', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
        { kind: 'verify', predicate: { kind: 'text_present', scope: '#status', text: 'Saved' } },
      ],
    };
    const mutation = await call('browser', {
      action: 'task',
      session_id: opened.session_id,
      chrome_tab_id: opened.tab_id,
      task_program: taskProgram,
      max_bytes: 32_768,
      max_bytes_reason: 'retain per-step fill and postcondition receipts for live qualification evidence',
    });
    const filledName = { status: mutation.status };
    const filledNotes = { status: mutation.status };
    const clicked = { status: mutation.status, reason_code: mutation.reason_code ?? null };
    let statusVisible = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      statusVisible = await call('verify', {
        session_id: opened.session_id,
        chrome_tab_id: opened.tab_id,
        predicate: { kind: 'text_present', scope: '#status', text: 'Saved' },
      });
      if (statusVisible.status === 'passed' || statusVisible.verified === true) break;
      await sleep(400);
    }
    const state = await readFixtureState(baseUrl, oracleToken, task, runId).catch(() => null);
    const persisted = state?.persisted === true
      && state?.form?.kind === 'form'
      && state.form.name === acceptance.name
      && state.form.notes === acceptance.notes;
    const fillReceipts = Array.isArray(mutation.receipts)
      ? mutation.receipts.filter((receipt) => receipt.step === 'fill')
      : [];
    const fillVerified = fillReceipts.length === 2 && fillReceipts.every((receipt) => receipt.status === 'verified' && receipt.verified === true);
    const assertions = {
      react_state_accepts_value: fillVerified,
      postcondition_verified: persisted,
    };
    const proof = {
      row: row.id,
      fixture_url_sha256: sha256(url),
      acceptance_sha256: sha256(acceptance),
      mutation_status: mutation.status,
      mutation_receipts: Array.isArray(mutation.receipts) ? mutation.receipts.map((receipt) => ({ status: receipt.status, action: receipt.action, step: receipt.step, reason_code: receipt.reason_code ?? null })).slice(0, 8) : null,
      fill_verified: fillVerified,
      click_status: clicked.status,
      click_reason_code: clicked.reason_code ?? null,
      status_verification: statusVisible.status,
      oracle_state: state === null ? null : { persisted: state.persisted === true, form_kind: state.form?.kind ?? null, form_sha256: state.form ? sha256(state.form) : null },
      assertions,
      cleanup: await cleanup(call, opened.session_id, opened.tab_id),
    };
    return {
      application_accepted: assertions.postcondition_verified,
      client_completed: fillVerified,
      assertions_passed: Object.values(assertions).every(Boolean),
      proof,
    };
  } finally {
    child.kill('SIGTERM');
  }
}

async function openGmail(call, label) {
  let opened = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      opened = await call('browser', {
        action: 'open',
        url: 'https://mail.google.com/mail/u/0/#drafts',
        idempotency_key: `phase12-gmail-${label}-${randomUUID()}`,
        mode: 'background',
        target_policy: 'create_background_window',
        ready_when: { kind: 'url_prefix', prefix: 'https://mail.google.com/' },
      });
    } catch (error) {
      lastError = String(error).slice(0, 800);
      await sleep(2500);
      continue;
    }
    if (opened.session_id && opened.tab_id) break;
    lastError = JSON.stringify(opened).slice(0, 800);
    await sleep(2500);
  }
  if (!opened?.session_id || !opened?.tab_id) throw new Error(`Gmail open failed after retries: ${lastError}`);
  return opened;
}

async function runGmailCompose(call, row) {
  const opened = await openGmail(call, 'compose');
  await sleep(3000);
  const snapshot = await call('snapshot', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    goal: { query: 'Compose', roles: ['button'] },
    max_items: 60,
  });
  const compose = (snapshot.items ?? []).find((item) => item.role === 'button' && /compose/i.test(String(item.name ?? '')));
  if (!compose) {
    return {
      blocked_reason: 'Gmail showed no Compose control; the signed-in draft surface was unavailable',
      proof: { row: row.id, url_sha256: sha256(String(opened.url ?? '')), compose_button_observed: false, cleanup: await cleanup(call, opened.session_id, opened.tab_id) },
    };
  }
  const openedCompose = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'click',
    reference: compose.reference,
    max_bytes: 8192,
    max_bytes_reason: 'retain the compose transition receipt',
  });
  // A click without a caller predicate can only prove that the DOM event ran.
  // Reconcile the retained unknown lease with a read-only positive predicate.
  const reconciled = await call('verify', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    predicate: { kind: 'text_present', text: 'Compose' },
    reconcile_unknown: true,
  });
  await sleep(3000);
  const subject = `Phase12 qualification ${Date.now()}`;
  const body = 'Draft body for the send-free live qualification.';
  const program = {
    steps: [
      { kind: 'find', query: 'To recipients', role: 'combobox', save_as: 'to' },
      { kind: 'fill', reference: '$to', expected_value: '', value: 'phase12.qualification@example.com' },
      { kind: 'find', query: 'Subject', role: 'input', save_as: 'subject' },
      { kind: 'fill', reference: '$subject', expected_value: '', value: subject },
      { kind: 'find', query: 'Message Body', role: 'textbox', save_as: 'body' },
      { kind: 'type', reference: '$body', expected_value: '', value: body },
    ],
  };
  const drafted = await call('browser', {
    action: 'task',
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    task_program: program,
    max_bytes: 200_000,
    max_bytes_reason: 'retain the send-free compose receipts and exact field verification',
  });
  const receipts = Array.isArray(drafted.receipts) ? drafted.receipts : [];
  const fillReceipts = receipts.filter((receipt) => receipt.step === 'fill' || receipt.step === 'type');
  const fillsVerified = fillReceipts.length === 3 && fillReceipts.every((receipt) => receipt.status === 'verified' && receipt.verified === true);
  if (!fillsVerified) {
    return {
      blocked_reason: `Gmail compose fields were not all verified (task ${drafted.status})`,
      proof: {
        row: row.id,
        subject_sha256: sha256(subject),
        draft_status: drafted.status,
        draft_receipts: receipts.map((receipt) => ({ step: receipt.step, status: receipt.status, reason_code: receipt.reason_code ?? null, verified: receipt.verified ?? null })).slice(0, 12),
        cleanup: await cleanup(call, opened.session_id, opened.tab_id),
      },
    };
  }
  await sleep(2000);
  const saveSnapshot = await call('snapshot', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    goal: { query: 'Save & close', roles: ['button'] },
    max_items: 5,
    max_text_chars: 80,
    max_bytes: 200_000,
    max_bytes_reason: 'acquire the compose save control after autosave settles',
  });
  const save = (saveSnapshot.items ?? []).find((item) => item.role === 'button' && /save.*close/i.test(String(item.name ?? '')));
  if (!save) {
    return {
      blocked_reason: 'Gmail compose did not expose a Save & close control after the verified field writes',
      proof: { row: row.id, subject_sha256: sha256(subject), cleanup: await cleanup(call, opened.session_id, opened.tab_id) },
    };
  }
  const saved = await call('act', {
    session_id: opened.session_id,
    chrome_tab_id: opened.tab_id,
    action: 'click',
    reference: save.reference,
    max_bytes: 8192,
    max_bytes_reason: 'retain the compose save receipt',
  });
  const saveVerified = await verifyText(call, opened.session_id, opened.tab_id, subject);
  const firstCleanup = await cleanup(call, opened.session_id, opened.tab_id);
  const reopened = await openGmail(call, 'persist');
  let persisted = false;
  let persistedItems = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(2500);
    const state = await call('snapshot', {
      session_id: reopened.session_id,
      chrome_tab_id: reopened.tab_id,
      goal: { query: 'Phase12 qualification' },
      max_items: 6,
      max_text_chars: 120,
      max_bytes: 200_000,
      max_bytes_reason: 'independently verify the persisted draft in a new tab',
    });
    persistedItems = state.items ?? [];
    persisted = persistedItems.some((item) => String(item.text ?? item.name ?? '').includes(subject));
    if (persisted) break;
  }
  const noSend = !receipts.some((receipt) => /send/i.test(String(receipt.step ?? ''))) && !/send/i.test(String(save.name ?? ''));
  const assertions = {
    recipient_resolved: fillReceipts.some((receipt) => receipt.step === 'fill' && receipt.status === 'verified'),
    subject_exact: fillReceipts.filter((receipt) => receipt.step === 'fill').length === 2 && fillReceipts.filter((receipt) => receipt.step === 'fill').every((receipt) => receipt.status === 'verified'),
    body_exact: fillReceipts.some((receipt) => receipt.step === 'type' && receipt.status === 'verified'),
    draft_persisted_after_reopen: persisted,
    no_send_dispatched: noSend,
  };
  const proof = {
    row: row.id,
    url_sha256: sha256(String(opened.url ?? '')),
    compose_button_observed: true,
    compose_click_status: openedCompose.status,
    compose_click_reason: openedCompose.reason_code ?? null,
    reconcile_status: reconciled.status,
    subject_sha256: sha256(subject),
    body_sha256: sha256(body),
    draft_status: drafted.status,
    draft_receipts: receipts.map((receipt) => ({ step: receipt.step, status: receipt.status, reason_code: receipt.reason_code ?? null, verified: receipt.verified ?? null })).slice(0, 12),
    save_click_status: saved.status,
    save_click_reason: saved.reason_code ?? null,
    save_verification_status: saveVerified.status,
    reopened_draft_visible: persisted,
    reopened_items: persistedItems.map((item) => ({ role: item.role, name_sha256: sha256(String(item.name ?? '')), ref: item.reference })).slice(0, 6),
    assertions,
    cleanup: { compose: firstCleanup, verification: await cleanup(call, reopened.session_id, reopened.tab_id) },
  };
  return {
    application_accepted: persisted && noSend,
    client_completed: drafted.status === 'completed' && saveVerified.status === 'passed',
    assertions_passed: Object.values(assertions).every(Boolean),
    proof,
  };
}

export async function runLiveQualification({ rows, binary = DEFAULT_BINARY, stateDir, evidenceOut = DEFAULT_EVIDENCE, verbose = true }) {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const chosen = rows?.length ? matrix.rows.filter((row) => rows.includes(row.id)) : matrix.rows;
  if (!chosen.length) throw new Error('no matrix rows selected');
  await mkdir(dirname(evidenceOut), { recursive: true });
  const client = createMcpStdioClient({ binary, stateDir: stateDir ?? resolve('/tmp', `controlla-phase12-${randomUUID()}`) });
  const results = [];
  const blocked = [];
  const log = (...args) => { if (verbose) console.log(...args); };
  try {
    await client.initialize();
    const call = (tool, args, timeoutMs) => client.call(tool, args, timeoutMs);
    for (const row of chosen) {
      log(`RUN ${row.id}`);
      try {
        let outcome;
        if (row.id === 'google-docs-type-1000') outcome = await runDocsType(call, row);
        else if (row.id === 'google-docs-replace-append-undo') outcome = await runDocsEdit(call, row);
        else if (row.id === 'react-form') outcome = await runReactForm(call, row);
        else if (row.id === 'gmail-compose') outcome = await runGmailCompose(call, row);
        else outcome = { blocked_reason: BLOCKED[row.id] ?? 'no live runner is implemented for this row' };
        if (outcome.blocked_reason) {
          blocked.push({ id: row.id, reason: outcome.blocked_reason, proof: outcome.proof });
          log(`BLOCKED ${row.id}: ${outcome.blocked_reason}`);
          continue;
        }
        const result = {
          id: row.id,
          application_accepted: outcome.application_accepted === true,
          client_completed: outcome.client_completed === true,
          assertions_passed: outcome.assertions_passed === true,
          evidence_hash: `sha256:${sha256(outcome.proof)}`,
          controlla_version: '0.1.0',
          recorded_at_ms: Date.now(),
          evidence_kind: 'live',
          proof: outcome.proof,
        };
        results.push(result);
        log(`${result.assertions_passed ? 'QUALIFIED' : 'UNQUALIFIED'} ${row.id}`);
      } catch (error) {
        blocked.push({ id: row.id, reason: `live runner error: ${String(error).slice(0, 800)}` });
        log(`ERROR ${row.id}: ${String(error).slice(0, 800)}`);
      }
    }
  } finally {
    await client.close();
  }
  const evidence = {
    version: 1,
    kind: 'phase12_evidence',
    generated_at_ms: Date.now(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      binary_sha256: sha256(await readFile(binary)),
      binary_path: resolve(binary),
    },
    results,
    blocked,
  };
  await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, evidenceOut, summary: { rows: chosen.length, results: results.length, qualified: results.filter((row) => row.assertions_passed && row.application_accepted).length, blocked: blocked.length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = option('rows')?.split(',').map((value) => value.trim()).filter(Boolean);
  const binary = option('binary', DEFAULT_BINARY);
  const stateDir = option('state-dir');
  const evidenceOut = option('evidence-out', DEFAULT_EVIDENCE);
  const result = await runLiveQualification({ rows, binary, stateDir, evidenceOut });
  console.log(JSON.stringify({ summary: result.summary, evidence_out: result.evidenceOut }, null, 2));
  if (process.argv.includes('--require-qualified') && result.summary.blocked > 0) {
    console.error('Phase 12 qualification is incomplete; blocked or unqualified rows stay unclaimed.');
    process.exitCode = 1;
  }
}

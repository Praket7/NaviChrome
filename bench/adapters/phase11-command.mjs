#!/usr/bin/env node
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../runners/phase11-public-readonly-pilot.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const commandStarted = process.hrtime.bigint();
const adapter = process.argv[2];
const sourceRefs={'controlla-1':'62e6407d0e75b83a1be8d69468476601a6e6da37','controlla-2-pre-stage2':'406b9d9794d6cb59dc75d22c7e6fe7a8554b1e67'}; const source_ref=sourceRefs[adapter] ?? null;
const allowed = new Set(['controlla','controlla-1','controlla-2-pre-stage2','playwright-mcp','chrome-devtools-mcp','agent-browser','browser-use','stagehand']);
if (!allowed.has(adapter)) throw new Error(`unknown adapter ${adapter}`);
const chunks=[]; let inputBytes=0; for await (const chunk of process.stdin) { inputBytes+=chunk.length; if(inputBytes>65536) throw new Error('request too large'); chunks.push(chunk); } const input=JSON.parse(Buffer.concat(chunks).toString());
const id=input.task_id; const mode=input.mode; const executionMode=input.execution_mode;
const defaults={adapter,source_ref,task_id:id,mode,execution_mode:executionMode,concurrency:input.concurrency,success:false,independently_verified_success:false,wall_ms:null,model_round_trips:null,model_tokens:null,mcp_calls:null,browser_ops:null,observation_bytes:null,screenshot_bytes:null,retries:null,recovery_events:null,cache_status:null,verification_ms:null,cpu_ms:null,peak_rss_bytes:null,focus_disruptions:null,clipboard_disruptions:null,human_interventions:null,severe_wrong_target_events:null,authority_violations:null,silent_stale_mutations:null,external_controlla_calls:null,model_turns:null,model_visible_observations:null,internal_model_calls:null,model_visible_calls:null,browser_commands:null,native_host_commands:null,cdp_commands:null,full_ax_reads:null,frame_tree_reads:null,target_rebinds:null,automatic_recoveries:null,user_visible_recoveries:null,application_accepted:null,input_commands:null,verification_reads:null,auto_attach_calls:null,browser_cdp_commands:null,host_round_trips:null,native_host_messages_sent:null,native_host_messages_received:null,schema_bytes:null,prompt_input_bytes:null,tool_input_bytes:null,output_bytes:null,unknown_delivery_count:null,fallback_count:null,timeout_count:null,cleanup_completed:null,cleanup_outcome:null};
const output=(fields={})=>{const result={...defaults,...fields}; if(result.wall_ms===null) result.wall_ms=Number(process.hrtime.bigint()-commandStarted)/1e6; result.metric_evidence=Object.fromEntries(contract.measurement_metric_fields.map(field=>[field,{provenance:contract.measurement_metric_provenance[field],...(result[field]===null||result[field]===undefined?{missing_reason:field==='success'||field==='independently_verified_success'?'unsupported_task_or_uninstrumented_adapter':'not reported by this adapter command'}:{})}])); console.log(JSON.stringify(result));};

const contract=JSON.parse(await readFile(resolve(root,'bench/runners/adapter-contract.json'),'utf8'));
if (executionMode !== 'headless') { output({runner_error:'real adapter smoke currently supports headless execution only; foreground/background bindings require a headed Chrome display harness'}); process.exit(0); }
const fixtureKind = id === 'form-guarded-fill' && input.task_class === 'forms' ? 'form' : id === 'guarded-upload' && input.task_class === 'upload' ? 'upload' : id === 'structured-extraction' && input.task_class === 'extraction' ? 'extraction' : null;
if (['controlla','playwright-mcp'].includes(adapter) && fixtureKind && !input.scenario && mode === 'cold_browser' && input.concurrency === 1) {
  const base = new URL(process.env.PHASE11_FIXTURE_BASE_URL ?? '');
  const url = new URL(input.fixture_url);
  const bytes = Buffer.from('Controlla benchmark\n');
  const expected = fixtureKind === 'form' ? {kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'} : fixtureKind === 'upload' ? {kind:'upload',filename:'benchmark.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')} : {kind:'extraction',row:'record-42',status:'older'};
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || url.origin !== base.origin || url.username || url.password || url.pathname !== (fixtureKind === 'form' ? '/registration-form' : fixtureKind === 'upload' ? '/file-input' : '/records-table') || [...url.searchParams.keys()].join(',') !== 'task' || url.searchParams.get('task') !== id || !input.acceptance || Object.keys(input.acceptance).length !== Object.keys(expected).length || Object.entries(expected).some(([key,value])=>input.acceptance[key]!==value)) throw new Error('adapter requires the exact disposable loopback fixture and acceptance');
  const binary = process.env.PHASE11_CONTROLLA_BINARY;
  const chrome = process.env.PHASE11_CHROME_PATH;
  if (!chrome || adapter === 'controlla' && !binary) throw new Error('configured Chrome and Controlla binary paths are required');
  const dir = await mkdtemp(join(tmpdir(), 'controlla-phase11-form-'));
  try {
    const state = join(dir, 'state');
    await mkdir(state);
    const configured = setup(adapter, chrome, binary, state);
    const directCli = adapter === 'playwright-mcp' ? process.env.PHASE11_PLAYWRIGHT_MCP_CLI : undefined;
    if (directCli) {
      if (!isAbsolute(directCli) || basename(directCli) !== 'cli.js') throw new Error('Playwright MCP CLI must be an absolute cli.js path');
      const pkg = JSON.parse(await readFile(join(dirname(directCli), 'package.json'), 'utf8'));
      if (pkg.name !== '@playwright/mcp' || pkg.version !== '0.0.83') throw new Error('Playwright MCP CLI package is not the pinned version');
      configured.config.push('-c',`mcp_servers.playwright-mcp.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.playwright-mcp.args=${JSON.stringify([directCli,'--browser','chrome','--headless','--isolated','--executable-path',chrome])}`);
    }
    let file = join(dir,'benchmark.txt');
    if (fixtureKind === 'upload') { await writeFile(file,bytes,{flag:'wx'}); file = await realpath(file); }
    const extractionSelector = '#records tbody tr:nth-child(42)';
    const extractionFunction = `() => { const row = document.querySelector('${extractionSelector}'); return row ? {url:location.href, value:Array.from(row.querySelectorAll('td'), cell => cell.textContent.trim()).join('|')} : null; }`;
    const controllaUploadGoal = [
      `Call browser action=artifact_register with arguments {"session_id":"<returned session_id>","chrome_tab_id":"<returned chrome_tab_id>","filename":"benchmark.txt","file_path":"${file}","allow_local_file_path":true}. Do not reconstruct or send the file contents.`,
      `Use its artifact_handle in browser action=task with arguments {"session_id":"<returned session_id>","chrome_tab_id":"<returned chrome_tab_id>","task":{"kind":"upload","artifact_handle":"<returned artifact_handle>","selector":"#upload","account_marker":["h1","Controlla Phase 11 · guarded-upload"]}}. Omit unused optional properties; do not send null.`,
      'A task result with status=incomplete and one receipt showing status=selected and chrome_selected_file=true is an intermediate selection. Confirm the selected receipt matches the benchmark filename, size, and SHA-256, then continue.',
      'Call workflow with arguments {"session_id":"<returned session_id>","chrome_tab_id":"<returned chrome_tab_id>","steps":[{"kind":"find","query":"Register upload","role":"button","match_mode":"exact","max_matches":1,"selector":"#upload-action","save_as":"register_upload"},{"kind":"click","reference":"$register_upload","outcome":{"kind":"text","selector":"#status","text":"Upload saved"}}]}. Require workflow status=completed and a verified click receipt, then stop: do not click again or repeat the action.',
      'If a tool returns status=error with reason_code=invalid_tool_request and dispatch_may_have_occurred=false, follow next_action and correct the named argument once. For unknown or possibly dispatched writes, verify read-only and never replay.',
    ].join(' ');
    const formGoal = adapter === 'controlla'
      ? 'Call snapshot once with arguments {"session_id":"<returned session_id>","chrome_tab_id":"<returned chrome_tab_id>","goal":{"query":"Name, Notes, and Save form controls on the current registration form"}}. If it returns status=error with reason_code=invalid_tool_request and dispatch_may_have_occurred=false, follow next_action and correct the snapshot arguments once. Use its fresh @c references for those controls. Then call browser action=task with arguments {"session_id":"<returned session_id>","chrome_tab_id":"<returned chrome_tab_id>","release_after_task":true,"task":{"kind":"form_draft","fields":[{"reference":"<Name @cN>","expected_value":"","value":"Benchmark User"},{"reference":"<Notes @cN>","expected_value":"","value":"Persisted benchmark form"}],"save_without_submit":true,"save_control":{"reference":"<Save form @cN>","confirmation_selector":"#status","confirmation_text":"Saved"}}}. Require the verified save result and private_session_released:true. Do not call act or use a target argument.'
      : 'Call browser_snapshot once. For browser_fill_form, use each snapshot ref ID as target without the @ prefix and without adding its label (for example @e6 -> e6); pass fields [{"target":"eN","name":"Name","type":"textbox","value":"Benchmark User"},{"target":"eN","name":"Notes","type":"textbox","value":"Persisted benchmark form"}]. Click Save form with browser_click using its exact ref ID without @, wait for visible text Saved with browser_wait_for, require success.';
    const goal = fixtureKind === 'extraction' ? (adapter === 'controlla' ? `Use the one-call private headless browser task with arguments {\"action\":\"task\",\"mode\":\"headless\",\"release_after_task\":true,\"task\":{\"kind\":\"research\",\"urls\":[\"${url.href}\"],\"selector\":\"${extractionSelector}\"}} and read the row snippet.` : `Use browser_evaluate with this exact function: ${extractionFunction}`) : fixtureKind === 'form' ? formGoal : adapter === 'controlla' ? controllaUploadGoal : `Call browser_snapshot and use the fresh reference for the file input with browser_click to open its file chooser. Then call browser_file_upload with the synthetic file path ${file}. Call browser_snapshot again, use its fresh reference for Register upload with browser_click, then call browser_wait_for with text "Upload saved" and require it to succeed.`;
    const route = adapter !== 'controlla' ? 'Start an isolated headless browser session.' : fixtureKind === 'extraction' ? 'Do not launch a separate session.' : `Start with browser action=launch with mode=headless and url=${url.href}. Use its returned session_id and target_ids[0] as chrome_tab_id; it is already at the fixture URL, so skip browser action=open and any separate navigation task.`;
    const cleanup = adapter === 'controlla' ? fixtureKind === 'form' ? 'After a successful form task require private_session_released:true. If the snapshot still fails after its one correction, release the session with browser action=release and require released:true before returning FAILED.' : fixtureKind === 'extraction' ? 'the task result must include private_session_released:true' : 'release the private session with browser action=release and require released:true' : 'close the browser with browser_close';
    const finalInstruction = fixtureKind === 'extraction' ? 'You must make the browser call exactly once and wait for its result before returning. If it succeeds, read the one extract receipt snippet and return exactly its three cells joined by |: record-42|older| followed by the observed 32-character lowercase hexadecimal nonce. Do not infer the nonce or add commentary. Otherwise return exactly FAILED.' : 'Return exactly DONE if every step succeeded, otherwise return exactly FAILED.';
    const prompt = `Use only ${configured.server} browser tools. ${route} ${adapter === 'controlla' ? '' : `Navigate once to ${url.href}. `}${goal} Then ${cleanup}. Do not use shell commands, web search, direct HTTP requests, or other tools. ${finalInstruction}`;
    const args = ['exec','--ephemeral','--json','--ignore-user-config','--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins','--disable','remote_plugin','--approve-for-me','-c','web_search="disabled"','--skip-git-repo-check','-m',process.env.PHASE11_MODEL ?? 'gpt-6-luna','-C',dir,...configured.config,'-c',`mcp_servers.${configured.server}.startup_timeout_sec=120`,prompt];
    const env = Object.fromEntries(['PATH','HOME','USER','SHELL','TMPDIR','TEMP','TMP','LANG','LC_ALL','CODEX_HOME','SSL_CERT_FILE','SYSTEMROOT','USERPROFILE','APPDATA','LOCALAPPDATA'].filter(key=>process.env[key] !== undefined).map(key=>[key,process.env[key]]));
    const events = []; let text = '', stderr = '', oversized = false, timedOut = false;
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(process.env.PHASE11_CODEX_PATH ?? 'codex', args, {cwd:dir,env,detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe']});
      const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      process.once('SIGTERM', stop);
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(Number(input.deadline_ms) || 60000, 600000) - 1000));
      child.stdout.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 4_000_000) { oversized = true; stop(); } });
      child.stderr.on('data', chunk => { if (Buffer.byteLength(stderr) < 16_384) stderr += chunk.toString().slice(0, 16_384 - stderr.length); });
      child.once('error', error => { clearTimeout(timer); process.removeListener('SIGTERM', stop); reject(error); });
      child.once('close', code => { clearTimeout(timer); process.removeListener('SIGTERM', stop); stop(); resolveRun(code); });
    });
    let malformed = false;
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch { malformed = true; } }
    const calls = events.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call');
    const codexEvents = [...new Set(events.flatMap(event => [event.type, event.item?.type].filter(type => typeof type === 'string' && /^[a-zA-Z0-9_.-]{1,48}$/.test(type))))].sort().slice(0, 5);
    const errorText = [...events.filter(event => ['turn.failed','error'].includes(event.type)).map(event => [event.error?.message, event.message].filter(value => typeof value === 'string').join(' ')), stderr].join(' ');
    const hostFailure = result !== 0 || events.some(event => ['turn.failed','error'].includes(event.type));
    const codexErrorClass = !hostFailure ? null : /rate.?limit|too many requests/i.test(errorText) ? 'rate_limit'
      : /quota|insufficient.?quota|billing/i.test(errorText) ? 'quota'
      : /auth|unauthorized|forbidden|credential/i.test(errorText) ? 'authentication'
      : /context.?length|token.?limit/i.test(errorText) ? 'context_limit'
      : /mcp.{0,40}(start|connect|initializ)|initializ.{0,40}mcp/i.test(errorText) ? 'mcp_startup'
      : /timeout|timed out|deadline/i.test(errorText) ? 'timeout'
      : /overload|unavailable|5\d\d/i.test(errorText) ? 'provider_unavailable'
      : /network|connection|transport|reset by peer|dns/i.test(errorText) ? 'transport'
      : 'unclassified_host_failure';
    const decoded = event => {
      const result = event.item?.result;
      let value = result?.structured_content ?? result?.structuredContent;
      if (!value) {
        const text = result?.content?.find?.(entry => entry.type === 'text')?.text;
        if (text) { try { value = JSON.parse(text); } catch {} }
        else if (result && typeof result === 'object' && !Array.isArray(result.content)) value = result;
      }
      return value;
    };
    const selectionOnly = event => {
      const item = event.item, value = decoded(event), receipt = value?.receipts?.[0];
      const selected = receipt?.files?.files?.[0];
      return adapter === 'controlla' && fixtureKind === 'upload' && item?.tool === 'browser' && item.arguments?.task?.kind === 'upload' && value?.status === 'incomplete' && value.receipts?.length === 1 && receipt?.status === 'selected' && receipt.chrome_selected_file === true && selected?.filename === expected.filename && selected?.size === expected.size && selected?.sha256 === expected.sha256;
    };
    const callSucceeded = event => {
      const item = event.item, result = item?.result;
      if (item?.status !== 'completed' || item?.error || !result || typeof result !== 'object' || result.isError || result.is_error) return false;
      if (selectionOnly(event)) return true;
      const value = decoded(event);
      return typeof value?.status !== 'string' || !/(?:error|fail|blocked|not_dispatched|unknown|incomplete|inconclusive|unverified|uncertain)/i.test(value.status);
    };
    const lastCall = calls.at(-1);
    const launch = adapter === 'controlla' ? calls.find(event => event.item?.server === configured.server && event.item?.tool === 'browser' && event.item.arguments?.action === 'launch' && callSucceeded(event)) : null;
    const sessionId = launch ? decoded(launch)?.session_id : null;
    const lastResult = lastCall && decoded(lastCall);
    const cleanupCompleted = adapter === 'controlla'
      ? Boolean(lastCall?.item?.server === configured.server && callSucceeded(lastCall) && (sessionId && lastCall.item.arguments?.session_id === sessionId && (lastCall.item.arguments?.action === 'release' && lastResult?.released === true || lastCall.item.arguments?.action === 'task' && lastCall.item.arguments?.release_after_task === true && lastResult?.private_session_released === true) || !sessionId && fixtureKind === 'extraction' && lastCall.item.arguments?.action === 'task' && lastCall.item.arguments?.mode === 'headless' && lastCall.item.arguments?.release_after_task === true && lastCall.item.arguments?.task?.kind === 'research' && lastResult?.private_session_released === true))
      : lastCall?.item?.server === configured.server && lastCall.item?.tool === 'browser_close' && callSucceeded(lastCall);
    const cleanupOutcome = cleanupCompleted ? adapter === 'controlla' ? 'private_session_released' : 'browser_close_acknowledged' : 'missing_or_unverified';
    const intended = calls.filter(event => event.item?.server === configured.server && callSucceeded(event));
    const unrelated = events.some(event => ['item.started','item.completed'].includes(event.type) && (['command_execution','web_search'].includes(event.item?.type) || event.item?.type === 'mcp_tool_call' && event.item?.server !== configured.server));
    const final = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item?.text?.trim();
    const selectionIndexes = calls.flatMap((event, index) => selectionOnly(event) ? [index] : []);
    const selectionIndex = selectionIndexes[0] ?? -1;
    const selectionArgs = selectionIndex < 0 ? null : calls[selectionIndex].item.arguments;
    const uploadConfirmationStatus = (() => {
      if (adapter !== 'controlla' || fixtureKind !== 'upload') return null;
      if (selectionIndexes.length !== 1) return selectionIndexes.length ? 'selection_duplicated' : 'selection_missing';
      if (!selectionArgs?.session_id || !selectionArgs?.chrome_tab_id) return 'selection_identity_missing';
      let matchingSteps = false;
      let mismatch = 'workflow_contract_mismatch';
      for (const event of calls.slice(selectionIndex + 1)) {
        const item = event.item, args = item?.arguments;
        if (item?.server !== configured.server || !(item.tool === 'workflow' || item.tool === 'browser' && args?.action === 'task')) continue;
        if (args?.session_id !== selectionArgs.session_id || args?.chrome_tab_id !== selectionArgs.chrome_tab_id) continue;
        const steps = Array.isArray(args.steps) ? args.steps : Array.isArray(args.program) ? args.program.filter(op => op?.op === 'step').map(op => op.step) : [];
        if (steps.length !== 2 || steps[0]?.kind !== 'find' || steps[0].query !== 'Register upload' || steps[0].role !== 'button' || steps[0].match_mode !== 'exact' || steps[0].max_matches !== 1 || steps[0].selector !== '#upload-action' || steps[0].save_as !== 'register_upload'
          || steps[1]?.kind !== 'click' || steps[1].reference !== '$register_upload' || steps[1].outcome?.kind !== 'text' || steps[1].outcome.selector !== '#status' || steps[1].outcome.text !== 'Upload saved') continue;
        matchingSteps = true;
        const value = decoded(event), workflow = value?.workflow ?? value;
        if (value?.status !== 'completed') { mismatch = 'workflow_not_completed'; continue; }
        if (workflow?.status !== 'completed') { mismatch = 'workflow_receipt_not_completed'; continue; }
        const clickReceipt = workflow.receipts?.find(receipt => receipt.step === 'click');
        if (!clickReceipt) { mismatch = 'click_receipt_missing'; continue; }
        if (clickReceipt.status !== 'verified') { mismatch = 'click_receipt_status_unverified'; continue; }
        if (Object.hasOwn(clickReceipt, 'verified') && clickReceipt.verified !== true) { mismatch = 'click_receipt_flag_mismatch'; continue; }
        return 'verified';
      }
      return matchingSteps ? mismatch : 'workflow_contract_mismatch';
    })();
    const selectionConfirmed = adapter !== 'controlla' || fixtureKind !== 'upload' || uploadConfirmationStatus === 'verified';
    const extractionPattern = /^record-42\|older\|[a-f0-9]{32}$/;
    const observed = fixtureKind === 'extraction' && extractionPattern.test(final ?? '') && calls.filter(event => event.item?.server === configured.server && callSucceeded(event)).some(event => {
      const item = event.item, value = decoded(event);
      if (adapter === 'controlla') return item.tool === 'browser' && item.arguments?.task?.kind === 'research' && item.arguments.task.selector === extractionSelector && item.arguments.task.urls?.length === 1 && item.arguments.task.urls[0] === url.href && value?.status === 'completed' && value.receipts?.some(receipt => receipt.kind === 'extract' && receipt.url === url.href && typeof receipt.snippet === 'string' && receipt.snippet.trim().split(/\s+/).join('|') === final);
      if (item.tool !== 'browser_evaluate' || item.arguments?.function !== extractionFunction) return false;
      return item.result?.content?.some?.(entry => {
        if (entry.type !== 'text') return false;
        const match = /^### Result\s*\n([\s\S]*?)\n(?:###|$)/.exec(entry.text);
        if (!match) return false;
        try { const result = JSON.parse(match[1]); return result.url === url.href && result.value === final; } catch { return false; }
      }) === true;
    });
    const extracted = observed ? final : null;
    const success = result === 0 && !oversized && !malformed && intended.length > 0 && intended.length === calls.length && !unrelated && selectionConfirmed && cleanupCompleted && (fixtureKind === 'extraction' ? observed : final === 'DONE');
    const failedEvent = calls.find(event => !callSucceeded(event));
    const failedCall = failedEvent?.item;
    const failedTool = /^[a-zA-Z0-9_-]{1,80}$/.test(failedCall?.tool ?? '') ? failedCall.tool : 'unknown';
    const failedAction = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(failedCall?.arguments?.action ?? '') ? failedCall.arguments.action : null;
    const failedResult = failedEvent && decoded(failedEvent);
    const failureStatus = typeof failedResult?.status === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(failedResult.status) ? failedResult.status : null;
    const failureReason = typeof failedResult?.reason_code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(failedResult.reason_code) ? failedResult.reason_code : null;
    const reason = failedResult?.reason_code;
    const safeReason = typeof reason === 'string' && /^[a-z0-9_]{1,80}$/.test(reason) ? ` (${reason})` : '';
    const failure = oversized || malformed ? 'Codex host returned invalid or oversized event output' : timedOut ? 'Codex host timed out' : result !== 0 ? `Codex host exited with code ${result ?? 'unknown'}` : unrelated ? 'Codex host used an unrelated tool' : calls.length === 0 ? 'Codex host made no MCP calls' : intended.length !== calls.length ? `Codex host MCP call failed: ${failedTool}${safeReason}` : !cleanupCompleted ? 'Codex host did not confirm browser cleanup' : 'Codex host did not report task completion';
    const failedArgs = failedCall?.arguments ?? {};
    const failedVerification = failedResult?.verification ?? {};
    const diagnosticErrorText = [failedCall?.error?.message, failedResult?.reason, failedResult?.error]
      .filter(value=>typeof value==='string').join(' ').toLowerCase();
    const diagnosticErrorKind = /\b(missing|required)\b/.test(diagnosticErrorText) ? 'missing_or_required'
      : /\b(invalid|malformed)\b/.test(diagnosticErrorText) ? 'invalid'
      : /\b(unknown|unsupported)\b/.test(diagnosticErrorText) ? 'unknown_or_unsupported' : null;
    const diagnosticErrorFields = ['action','session_id','chrome_tab_id','filename','bytes','bytes_base64','artifact_handle','reference','expected_label','outcome','task','selector','max_bytes_reason']
      .filter(field=>new RegExp(`\\b${field}\\b`).test(diagnosticErrorText));
    const failureDiagnostic = failedEvent ? {
      tool: failedTool,
      action: failedAction,
      status: failureStatus,
      reason_code: failureReason,
      error_kind: diagnosticErrorKind,
      error_fields: diagnosticErrorFields,
      argument_types: Object.fromEntries(Object.entries(failedArgs).sort(([a],[b])=>a.localeCompare(b)).slice(0,24).map(([key,value])=>[key,value===null?'null':Array.isArray(value)?'array':typeof value])),
      outcome_kind: typeof failedArgs.outcome?.kind === 'string' && /^[a-z_]{1,32}$/.test(failedArgs.outcome.kind) ? failedArgs.outcome.kind : null,
      task_kind: typeof failedArgs.task?.kind === 'string' && /^[a-z_]{1,32}$/.test(failedArgs.task.kind) ? failedArgs.task.kind : null,
      task_field_count: Array.isArray(failedArgs.task?.fields) ? failedArgs.task.fields.length : null,
      save_control_present: Boolean(failedArgs.task?.save_control),
      expected_label_present: typeof failedArgs.expected_label === 'string' && failedArgs.expected_label.length > 0,
      reference_kind: typeof failedArgs.reference === 'string' ? failedArgs.reference.startsWith('@c') ? '@c' : failedArgs.reference.startsWith('@e') ? '@e' : 'other' : null,
      artifact_payload: failedArgs.action === 'artifact_register' && fixtureKind === 'upload' ? {
        filename_matches_expected: failedArgs.filename === expected.filename,
        file_path_matches_fixture: failedArgs.file_path === file,
        allow_local_file_path: failedArgs.allow_local_file_path === true,
        base64_length: typeof failedArgs.bytes_base64 === 'string' ? failedArgs.bytes_base64.length : null,
        base64_valid: typeof failedArgs.bytes_base64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(failedArgs.bytes_base64),
        base64_matches_expected: failedArgs.bytes_base64 === bytes.toString('base64'),
      } : null,
      dispatch_acknowledged: typeof failedResult?.dispatch_acknowledged === 'boolean' ? failedResult.dispatch_acknowledged : null,
      dispatch_may_have_occurred: typeof failedResult?.dispatch_may_have_occurred === 'boolean' ? failedResult.dispatch_may_have_occurred : null,
      verification_status: typeof failedVerification.status === 'string' && /^[a-z_]{1,32}$/.test(failedVerification.status) ? failedVerification.status : null,
      verification_attempts: Number.isSafeInteger(failedVerification.attempts) && failedVerification.attempts >= 0 ? failedVerification.attempts : null,
      text_present: typeof failedVerification.observed?.text_present === 'boolean' ? failedVerification.observed.text_present : null,
    } : undefined;
    const finalKind = final === undefined ? 'missing' : final === 'DONE' ? 'done' : final === 'FAILED' ? 'failed' : 'other';
    output({success, cleanup_completed:cleanupCompleted, cleanup_outcome:cleanupOutcome, mcp_calls:calls.length, model_turns:events.filter(event => event.type === 'turn.started').length, codex_event_types:codexEvents.join(','), codex_final_kind:finalKind, codex_error_class:success ? null : failedEvent ? 'mcp_tool_failure' : codexErrorClass ?? 'actor_incomplete', codex_failed_tool:failedEvent ? failedTool : null, codex_failed_action:failedEvent ? failedAction : null, codex_tool_failure_status:failureStatus, codex_tool_failure_reason:failureReason, codex_failure_diagnostic:failureDiagnostic, codex_turn_failed:events.some(event => event.type === 'turn.failed'), ...(fixtureKind === 'upload' ? {upload_confirmation_status:uploadConfirmationStatus} : {}), ...(fixtureKind === 'extraction' && extracted ? {extraction_value:extracted} : {}), runner_error:success ? undefined : failure});
  } finally { await rm(dir,{recursive:true,force:true}); }
  process.exit(0);
}
output({runner_error:`convenience adapter is unqualified for task ${id}: the fixture event log is not an independent task acceptance oracle`});
process.exit(0);

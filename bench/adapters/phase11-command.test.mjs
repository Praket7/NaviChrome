import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapterContract, validateAdapterResult } from '../runners/phase11-runner.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const adapterPath = resolve(root, 'bench/adapters/phase11-command.mjs');

test('unsupported adapter task classes report missing evidence and leave safety counters unknown', async () => {
  const input = { task_id: 'eight-tab-pressure', task_class: 'concurrent_tabs', mode: 'cold_browser', execution_mode: 'headless', concurrency: 1 };
  const output = await invoke(input);
  assert.match(output.runner_error, /not an independent task acceptance oracle/);
  for (const field of ['focus_disruptions', 'clipboard_disruptions', 'human_interventions', 'severe_wrong_target_events', 'authority_violations', 'silent_stale_mutations']) {
    assert.equal(output[field], null, `${field} is uninstrumented and must remain missing`);
    assert.ok(output.metric_evidence[field].missing_reason);
  }
  assert.equal(output.success, false);
  assert.equal(output.independently_verified_success, false);
  assert.doesNotThrow(() => validateAdapterResult(output, awaitContract, {
    adapter: 'playwright-mcp', task_id: input.task_id, mode: input.mode,
    execution_mode: input.execution_mode, concurrency: input.concurrency,
  }));
});

const awaitContract = await loadAdapterContract();

function invoke(input) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [adapterPath, 'playwright-mcp'], {
      cwd: root, env: { ...process.env, PHASE11_FIXTURE_BASE_URL: 'http://127.0.0.1:1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(stderr || `adapter exited ${code}`));
      try { resolveOutput(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('generic extraction is unqualified without independent fixture acceptance', async () => {
  const output = await invoke({ task_id:'50k-node-targeted-control', task_class:'extraction', mode:'cold_browser', execution_mode:'headless', concurrency:1 });
  assert.equal(output.success,false);
  assert.equal(output.independently_verified_success,false);
  assert.match(output.runner_error,/not an independent task acceptance oracle/);
});

test('extraction actor requires an exact bound observed row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-extraction-'));
  try {
    const executable=join(dir,'codex');
    const input={task_id:'structured-extraction',task_class:'extraction',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/records-table?task=structured-extraction',acceptance:{kind:'extraction',row:'record-42',status:'older'},deadline_ms:60000};
    const nonce='a'.repeat(32), answer=`record-42|older|${nonce}`;
    for (const scenario of ['valid','wrong_url','no_observation','wrong_final','no_tool_call']) {
      const url=scenario==='wrong_url'?'http://127.0.0.1:1234/other':input.fixture_url;
      const task={type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'task',mode:'headless',release_after_task:true,task:{kind:'research',selector:'#records tbody tr:nth-child(42)',urls:[input.fixture_url]}},result:{structured_content:{status:'completed',private_session_released:true,receipts:scenario==='no_observation'?[]:[{kind:'extract',url,snippet:'record-42 older '+nonce}]}}}};
      const events=[{type:'turn.started'},...(scenario==='no_tool_call'?[]:[task]),{type:'item.completed',item:{type:'agent_message',text:scenario==='wrong_final'?'record-42|older':scenario==='no_tool_call'?'FAILED':answer}}];
      await writeFile(executable, `#!/usr/bin/env node\nconst prompt=process.argv.at(-1); if (!prompt.includes('one-call private headless') || !prompt.includes('"action":"task","mode":"headless","release_after_task":true') || !prompt.includes('one extract receipt snippet') || !prompt.includes('Do not infer the nonce') || !prompt.includes('exactly once and wait for its result before returning') || prompt.includes('browser action=launch')) process.exit(9);\nfor(const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));\n`,{mode:0o755});
      const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
      assert.equal(output.success,scenario==='valid');
      assert.equal(output.independently_verified_success,false);
      assert.equal(output.cleanup_completed,scenario!=='no_tool_call');
      assert.equal(output.cleanup_outcome,scenario==='no_tool_call'?'missing_or_unverified':'private_session_released');
      assert.equal(output.codex_final_kind,scenario==='valid'?'other':scenario==='no_tool_call'?'failed':'other');
      assert.equal(output.model_turns,1);
      if (scenario==='no_tool_call') {
        assert.equal(output.mcp_calls,0);
        assert.doesNotMatch(JSON.stringify(output),/record-42\|older|[a-f0-9]{32}/);
      }
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('cold adapter distinguishes host exit from deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-host-failure-'));
  try {
    const executable = join(dir, 'codex');
    const input = {task_id:'form-guarded-fill', task_class:'forms', mode:'cold_browser', execution_mode:'headless', concurrency:1, fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill', acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'}, deadline_ms:3000};
    for (const [script, expected] of [['process.exit(7);', 'Codex host exited with code 7'], ['setInterval(() => {}, 1000);', 'Codex host timed out']]) {
      await writeFile(executable, `#!/usr/bin/env node\n${script}\n`, {mode:0o755});
      const output = await new Promise((resolveOutput, reject) => {
        const child = spawn(process.execPath, [adapterPath, 'playwright-mcp'], {cwd:root, env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome'}, stdio:['pipe','pipe','pipe']});
        let stdout='', stderr=''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
        child.once('error', reject); child.once('close', code => code === 0 ? resolveOutput(JSON.parse(stdout)) : reject(new Error(stderr))); child.stdin.end(JSON.stringify(input));
      });
      assert.equal(output.runner_error, expected);
    }
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('cold adapter retains bounded Codex failure diagnostics without raw error text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-host-diagnostic-'));
  try {
    const executable = join(dir, 'codex');
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'turn.failed',error:{message:'429 rate limit: private provider detail'}}));\nconsole.error('rate limit: private provider detail');\nprocess.exit(1);\n`, {mode:0o755});
    const input = {task_id:'form-guarded-fill',task_class:'forms',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill',acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'},deadline_ms:3000};
    const output = await new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, [adapterPath, 'playwright-mcp'], {cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome'},stdio:['pipe','pipe','pipe']});
      let stdout='', stderr=''; child.stdout.on('data',chunk=>stdout+=chunk); child.stderr.on('data',chunk=>stderr+=chunk);
      child.once('error',reject); child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr))); child.stdin.end(JSON.stringify(input));
    });
    assert.equal(output.codex_error_class, 'rate_limit');
    assert.equal(output.codex_turn_failed, true);
    assert.ok(output.codex_event_types.includes('turn.failed'));
    assert.doesNotMatch(JSON.stringify(output), /private provider detail/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('failed MCP diagnostics retain a bounded redacted receipt and argument shape', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-action-diagnostic-'));
  try {
    const executable=join(dir,'codex');
    const events=[
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'launch'},result:{structured_content:{session_id:'s',target_ids:['t']}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'act',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t',reference:'@c3',action:'click',outcome:{kind:'text',selector:'#status',text:'private body'}},result:{structured_content:{status:'unknown',reason_code:'outcome_not_observed',dispatch_may_have_occurred:true,verification:{status:'not_observed',attempts:4,observed:{text_present:false}}}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'release',session_id:'s'},result:{structured_content:{released:true}}}},
      {type:'item.completed',item:{type:'agent_message',text:'FAILED'}},
    ];
    await writeFile(executable, `#!/usr/bin/env node\nfor(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,{mode:0o755});
    const input={task_id:'guarded-upload',task_class:'upload',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/file-input?task=guarded-upload',acceptance:{kind:'upload',filename:'benchmark.txt',size:20,sha256:'e6cd2f3dd6fbc01ec2f9b8f1578535ab325cd7a884a14d1170cb50dc744a0231'},deadline_ms:60000};
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.codex_failed_tool,'act');
    assert.equal(output.codex_failed_action,'click');
    assert.equal(output.mcp_calls,3,'observed MCP call counts remain available when the action fails');
    assert.deepEqual(output.codex_failure_diagnostic,{
      tool:'act', action:'click', status:'unknown', reason_code:'outcome_not_observed',
      error_kind:null, error_fields:[],
      argument_types:{action:'string',chrome_tab_id:'string',outcome:'object',reference:'string',session_id:'string'},
      outcome_kind:'text', task_kind:null, task_field_count:null, save_control_present:false,
      expected_label_present:false, reference_kind:'@c', artifact_payload:null,
      dispatch_acknowledged:null, dispatch_may_have_occurred:true, verification_status:'not_observed',
      verification_attempts:4, text_present:false,
    });
    assert.doesNotMatch(JSON.stringify(output),/private body|@c3/);
    assert.doesNotThrow(()=>validateAdapterResult(output,awaitContract,{adapter:'controlla',task_id:input.task_id,mode:input.mode,execution_mode:input.execution_mode,concurrency:input.concurrency}));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('artifact registration diagnostics report byte and filename matches without retaining contents', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-artifact-diagnostic-'));
  try {
    const executable=join(dir,'codex');
    const input={task_id:'guarded-upload',task_class:'upload',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/file-input?task=guarded-upload',acceptance:{kind:'upload',filename:'benchmark.txt',size:20,sha256:'e6cd2f3dd6fbc01ec2f9b8f1578535ab325cd7a884a14d1170cb50dc744a0231'},deadline_ms:60000};
    const events=[
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'launch'},result:{structured_content:{session_id:'s',target_ids:['t']}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'artifact_register',session_id:'s',chrome_tab_id:'t',filename:'private.txt',bytes_base64:Buffer.from('private body').toString('base64')},error:{message:'invalid field bytes_base64 private body'},result:{structured_content:{status:'error',reason_code:'invalid_tool_request'}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'release',session_id:'s'},result:{structured_content:{released:true}}}},
      {type:'item.completed',item:{type:'agent_message',text:'FAILED'}},
    ];
    await writeFile(executable, `#!/usr/bin/env node\nfor(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,{mode:0o755});
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.deepEqual(output.codex_failure_diagnostic.artifact_payload,{filename_matches_expected:false,file_path_matches_fixture:false,allow_local_file_path:false,base64_length:16,base64_valid:true,base64_matches_expected:false});
    assert.equal(output.codex_failure_diagnostic.error_kind,'invalid');
    assert.deepEqual(output.codex_failure_diagnostic.error_fields,['bytes_base64']);
    assert.doesNotMatch(JSON.stringify(output),/private body|private\.txt|cHJpdmF0ZSBib2R5/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('cold form adapter requires browser-close acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-host-test-'));
  try {
    const executable = join(dir, 'codex');
    const actorScript = cleanup => `#!/usr/bin/env node\nconst prompt=process.argv.at(-1); if (process.env.PHASE11_ORACLE_TOKEN || process.env.PHASE11_STATE_FILE || process.env.PRIVATE_SENTINEL || !['shell_tool','unified_exec','apps','plugins','remote_plugin','--approve-for-me','mcp_servers.playwright-mcp.startup_timeout_sec=120'].every(x=>process.argv.includes(x)) || !['browser_snapshot','browser_fill_form','browser_click','browser_wait_for','browser_close','fields','target','Save form','without the @ prefix','@e6 -> e6'].every(x=>prompt.includes(x))) process.exit(9);\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_navigate',status:'completed',result:{content:[{type:'text',text:'ok'}]}}}));\n${cleanup ? "console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_close',status:'completed',result:{content:[{type:'text',text:'closed'}]}}}));" : ''}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DONE'}}));\n`;
    const input = { task_id:'form-guarded-fill', task_class:'forms', mode:'cold_browser', execution_mode:'headless', concurrency:1, fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill', acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'}, deadline_ms:60000 };
    for (const cleanup of [true,false]) {
      await writeFile(executable, actorScript(cleanup), {mode:0o755});
      const output = await new Promise((resolveOutput, reject) => {
        const child = spawn(process.execPath, [adapterPath, 'playwright-mcp'], {cwd:root, env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_ORACLE_TOKEN:'secret',PHASE11_STATE_FILE:'secret',PRIVATE_SENTINEL:'secret'}, stdio:['pipe','pipe','pipe']});
        let stdout='', stderr=''; child.stdout.on('data',chunk=>stdout+=chunk); child.stderr.on('data',chunk=>stderr+=chunk);
        child.once('error',reject); child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr))); child.stdin.end(JSON.stringify(input));
      });
      assert.equal(output.success, cleanup);
      assert.equal(output.independently_verified_success, false);
      assert.equal(output.cleanup_completed, cleanup);
      assert.equal(output.cleanup_outcome, cleanup ? 'browser_close_acknowledged' : 'missing_or_unverified');
      if (cleanup) assert.equal(output.mcp_calls, 2);
      else assert.equal(output.runner_error, 'Codex host did not confirm browser cleanup');
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('cold form adapter refuses non-loopback fixture URLs before spawning', async () => {
  const input = {task_id:'form-guarded-fill', task_class:'forms', mode:'cold_browser', execution_mode:'headless', concurrency:1, fixture_url:'https://example.com/registration-form?task=form-guarded-fill', acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'}};
  const code = await new Promise((resolveCode, reject) => {
    const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234'},stdio:['pipe','ignore','ignore']});
    child.once('error',reject); child.once('close',resolveCode); child.stdin.end(JSON.stringify(input));
  });
  assert.notEqual(code,0);
});

test('cold upload adapter launches a client without claiming server acceptance', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-upload-test-'));
  try {
    const executable=join(dir,'codex');
    await writeFile(executable, `#!/usr/bin/env node\nif (!process.argv.at(-1).includes('Call browser_snapshot') || !process.argv.at(-1).includes('browser_wait_for') || !process.argv.at(-1).includes('browser_close')) process.exit(9);\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_file_upload',status:'completed',result:{content:[{type:'text',text:'ok'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_close',status:'completed',result:{content:[{type:'text',text:'closed'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DONE'}}));\n`, {mode:0o755});
    const input={task_id:'guarded-upload',task_class:'upload',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/file-input?task=guarded-upload',acceptance:{kind:'upload',filename:'benchmark.txt',size:20,sha256:'e6cd2f3dd6fbc01ec2f9b8f1578535ab325cd7a884a14d1170cb50dc744a0231'},deadline_ms:60000};
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,true,JSON.stringify(output));
    assert.equal(output.independently_verified_success,false);
    assert.equal(output.cleanup_completed,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Playwright actor can launch the verified pinned local CLI directly', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-playwright-cli-test-'));
  try {
    const cli=join(dir,'cli.js'), executable=join(dir,'codex');
    await writeFile(join(dir,'package.json'),JSON.stringify({name:'@playwright/mcp',version:'0.0.83'}));
    await writeFile(cli,'');
    await writeFile(executable, `#!/usr/bin/env node\nif (!process.argv.some(x=>x.includes(${JSON.stringify(cli)}))) process.exit(9);\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_navigate',status:'completed',result:{content:[{type:'text',text:'ok'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_close',status:'completed',result:{content:[{type:'text',text:'closed'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DONE'}}));\n`,{mode:0o755});
    const input={task_id:'form-guarded-fill',task_class:'forms',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill',acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'},deadline_ms:60000};
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_PLAYWRIGHT_MCP_CLI:cli},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,true);
    assert.equal(output.cleanup_completed,true);
    await writeFile(join(dir,'package.json'),JSON.stringify({name:'@playwright/mcp',version:'0.0.84'}));
    const code=await new Promise((resolveCode,reject)=>{const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_PLAYWRIGHT_MCP_CLI:cli},stdio:['pipe','ignore','ignore']});child.once('error',reject);child.once('close',resolveCode);child.stdin.end(JSON.stringify(input));});
    assert.notEqual(code,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('an incomplete browser call cannot claim actor success', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-incomplete-test-'));
  try {
    const executable=join(dir,'codex');
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_navigate',status:'completed',result:{content:[{type:'text',text:'ok'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_close',status:'completed',result:{content:[{type:'text',text:'closed'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'FAILED'}}));\n`, {mode:0o755});
    const input={task_id:'form-guarded-fill',task_class:'forms',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill',acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'},deadline_ms:60000};
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,false);
    assert.equal(output.runner_error,'Codex host did not report task completion');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('malformed client output cannot claim actor success', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-malformed-test-'));
  try {
    const executable=join(dir,'codex');
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log('not-json');\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_navigate',status:'completed',result:{content:[{type:'text',text:'ok'}]}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DONE'}}));\n`,{mode:0o755});
    const input={task_id:'form-guarded-fill',task_class:'forms',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill',acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'},deadline_ms:60000};
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,false);
    assert.equal(output.runner_error,'Codex host returned invalid or oversized event output');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('not-dispatched browser calls remain unqualified and identify the tool', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-failed-call-test-'));
  try {
    const executable=join(dir,'codex');
    const input={task_id:'form-guarded-fill',task_class:'forms',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill',acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'},deadline_ms:60000};
    for (const result of [{structured_content:{status:'not_dispatched'}},{structuredContent:{status:'completed_unverified'}},{content:[{type:'text',text:'{"status":"unknown"}'}]},{isError:true},{status:'incomplete'},{structured_content:{status:'not_dispatched',reason_code:'unsafe_page'}},{structured_content:{status:'not_dispatched',reason_code:'sensitive text'}}]) {
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'playwright-mcp',tool:'browser_close',status:'completed',result:${JSON.stringify(result)}}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DONE'}}));\n`,{mode:0o755});
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'playwright-mcp'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,false);
    assert.equal(output.runner_error,`Codex host MCP call failed: browser_close${result.structured_content?.reason_code === 'unsafe_page' ? ' (unsafe_page)' : ''}`);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Controlla form actor releases its private headless session with the task', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-controlla-route-test-'));
  try {
    const executable=join(dir,'codex');
    await writeFile(executable, `#!/usr/bin/env node\nconst prompt=process.argv.at(-1); if (!prompt.includes('launch with mode=headless and url=') || !prompt.includes('skip browser action=open and any separate navigation task') || prompt.includes('"kind":"research"') || !prompt.includes('browser action=task') || !['form_draft','save_without_submit','save_control','expected_value','confirmation_selector','"goal":{"query":"Name, Notes, and Save form controls','release_after_task":true','dispatch_may_have_occurred=false','correct the snapshot arguments once','If the snapshot still fails after its one correction','release the session with browser action=release'].every(x=>prompt.includes(x)) || prompt.includes('act with target')) process.exit(9);\nconst events=[{type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'launch'},result:{structured_content:{session_id:'s',target_ids:['t']}}}},{type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'snapshot',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t'},result:{structured_content:{status:'completed'}}}},{type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'task',session_id:'s',chrome_tab_id:'t',release_after_task:true,task:{kind:'form_draft'}},result:{structured_content:{status:'completed',private_session_released:true}}}},{type:'item.completed',item:{type:'agent_message',text:'DONE'}}]; for(const e of events) console.log(JSON.stringify(e));\n`,{mode:0o755});
    const input={task_id:'form-guarded-fill',task_class:'forms',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/registration-form?task=form-guarded-fill',acceptance:{kind:'form',name:'Benchmark User',notes:'Persisted benchmark form'},deadline_ms:60000};
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,true,JSON.stringify({runner_error:output.runner_error,codex_error_class:output.codex_error_class,codex_failed_tool:output.codex_failed_tool}));
    assert.equal(output.independently_verified_success,false);
    assert.equal(output.cleanup_completed,true);
    assert.equal(output.cleanup_outcome,'private_session_released');

    const failedSnapshots=[1,2].map(attempt=>({type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'snapshot',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t',max_items:attempt},result:{structured_content:{status:'error',reason_code:'invalid_tool_request',dispatch_may_have_occurred:false,next_action:'correct_snapshot_argument_once'}}}}));
    const failureEvents=[{type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'launch'},result:{structured_content:{session_id:'s',target_ids:['t']}}}},...failedSnapshots,{type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'release',session_id:'s'},result:{structured_content:{released:true}}}},{type:'item.completed',item:{type:'agent_message',text:'FAILED'}}];
    await writeFile(executable, `#!/usr/bin/env node\nfor(const event of ${JSON.stringify(failureEvents)}) console.log(JSON.stringify(event));\n`,{mode:0o755});
    const failedOutput=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(failedOutput.success,false);
    assert.equal(failedOutput.mcp_calls,4);
    assert.equal(failedOutput.cleanup_completed,true,'the failed-snapshot branch must release its session before reporting failure');
    assert.equal(failedOutput.cleanup_outcome,'private_session_released');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Controlla upload submission runs as one targeted verified workflow', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-selection-test-'));
  try {
    const executable=join(dir,'codex');
    const input={task_id:'guarded-upload',task_class:'upload',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/file-input?task=guarded-upload',acceptance:{kind:'upload',filename:'benchmark.txt',size:20,sha256:'e6cd2f3dd6fbc01ec2f9b8f1578535ab325cd7a884a14d1170cb50dc744a0231'},deadline_ms:60000};
    const selected={type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t',task:{kind:'upload'}},result:{structured_content:{status:'incomplete',receipts:[{status:'selected',chrome_selected_file:true,files:{files:[input.acceptance]}}]}}}};
    const workflow={type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'workflow',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t',steps:[{kind:'find',query:'Register upload',role:'button',match_mode:'exact',max_matches:1,selector:'#upload-action',save_as:'register_upload'},{kind:'click',reference:'$register_upload',outcome:{kind:'text',selector:'#status',text:'Upload saved'}}]},result:{structured_content:{status:'completed',receipts:[{step:'find',status:'found'},{step:'click',status:'verified'}]}}}};
    const browserWorkflow={...workflow,item:{...workflow.item,tool:'browser',arguments:{...workflow.item.arguments,action:'task'},result:{structured_content:{status:'completed',action:'task',workflow:{status:'completed',receipts:[{step:'find',status:'found'},{step:'click',status:'verified'}]}}}}};
    const programWorkflow={...workflow,item:{...workflow.item,arguments:{...workflow.item.arguments,steps:undefined,program:workflow.item.arguments.steps.map(step=>({op:'step',step}))}}};
    for (const scenario of ['no_selection','missing','wrong_tab','wrong_label','unverified','click_status','click_flag','duplicate','verified','browser_wrapper','program_wrapper']) {
      const followup = scenario === 'wrong_tab' ? {...workflow,item:{...workflow.item,arguments:{...workflow.item.arguments,chrome_tab_id:'other'}}}
        : scenario === 'wrong_label' ? {...workflow,item:{...workflow.item,arguments:{...workflow.item.arguments,steps:[{...workflow.item.arguments.steps[0],query:'Upload'},workflow.item.arguments.steps[1]]}}}
          : scenario === 'unverified' ? {...workflow,item:{...workflow.item,result:{structured_content:{status:'unknown',receipts:[{step:'find',status:'found',verified:false},{step:'click',status:'unknown',verified:false}]}}}}
            : scenario === 'click_status' ? {...workflow,item:{...workflow.item,result:{structured_content:{status:'completed',receipts:[{step:'find',status:'found',verified:false},{step:'click',status:'unknown',verified:false}]}}}}
              : scenario === 'click_flag' ? {...workflow,item:{...workflow.item,result:{structured_content:{status:'completed',receipts:[{step:'find',status:'found',verified:false},{step:'click',status:'verified',verified:false}]}}}}
            : scenario === 'browser_wrapper' ? browserWorkflow
              : scenario === 'program_wrapper' ? programWorkflow : workflow;
      const launch={type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'launch'},result:{structured_content:{session_id:'s',target_ids:['t']}}}};
      const release={type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'release',session_id:'s'},result:{structured_content:{released:true}}}};
      const events=[launch,...(scenario === 'no_selection'?[]:[selected]),...(scenario === 'duplicate'?[selected]:[]),...(scenario === 'missing'?[]:[followup]),release,{type:'item.completed',item:{type:'agent_message',text:'DONE'}}];
      await writeFile(executable, `#!/usr/bin/env node\nconst prompt=process.argv.at(-1); if (!prompt.includes('workflow') || !prompt.includes('"kind":"find"') || !prompt.includes('"kind":"click"') || !prompt.includes('"reference":"$register_upload"') || prompt.includes('snapshot with only session_id') || prompt.includes('Call act with arguments')) process.exit(9);\nfor(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,{mode:0o755});
      const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
      assert.equal(output.success,['verified','browser_wrapper','program_wrapper'].includes(scenario),`${scenario}: ${JSON.stringify(Object.fromEntries(['success','mcp_calls','cleanup_completed','codex_error_class','codex_failed_tool','codex_final_kind','codex_turn_failed','runner_error'].map(key=>[key,output[key]])))}`);
      assert.equal(output.independently_verified_success,false);
      assert.equal(output.cleanup_completed,true);
      assert.equal(output.cleanup_outcome,'private_session_released');
      if (scenario === 'verified' || scenario === 'browser_wrapper' || scenario === 'program_wrapper') assert.equal(output.upload_confirmation_status,'verified');
      if (scenario === 'unverified') assert.equal(output.upload_confirmation_status,'workflow_not_completed');
      if (scenario === 'click_status') assert.equal(output.upload_confirmation_status,'click_receipt_status_unverified');
      if (scenario === 'click_flag') assert.equal(output.upload_confirmation_status,'click_receipt_flag_mismatch');
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Controlla upload prompt omits null optionals and continues after an incomplete selection receipt', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phase11-upload-prompt-test-'));
  try {
    const executable=join(dir,'codex');
    const input={task_id:'guarded-upload',task_class:'upload',mode:'cold_browser',execution_mode:'headless',concurrency:1,fixture_url:'http://127.0.0.1:1234/file-input?task=guarded-upload',acceptance:{kind:'upload',filename:'benchmark.txt',size:20,sha256:'e6cd2f3dd6fbc01ec2f9b8f1578535ab325cd7a884a14d1170cb50dc744a0231'},deadline_ms:60000};
    const events=[
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'launch'},result:{structured_content:{session_id:'s',target_ids:['t']}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t',task:{kind:'upload'}},result:{structured_content:{status:'incomplete',receipts:[{status:'selected',chrome_selected_file:true,files:{files:[input.acceptance]}}]}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'workflow',status:'completed',arguments:{session_id:'s',chrome_tab_id:'t',steps:[{kind:'find',query:'Register upload',role:'button',match_mode:'exact',max_matches:1,selector:'#upload-action',save_as:'register_upload'},{kind:'click',reference:'$register_upload',outcome:{kind:'text',selector:'#status',text:'Upload saved'}}]},result:{structured_content:{status:'completed',receipts:[{step:'find',status:'found',verified:false},{step:'click',status:'verified',verified:true}]}}}},
      {type:'item.completed',item:{type:'mcp_tool_call',server:'chrome-controlla',tool:'browser',status:'completed',arguments:{action:'release',session_id:'s'},result:{structured_content:{released:true}}}},
      {type:'item.completed',item:{type:'agent_message',text:'DONE'}},
    ];
    await writeFile(executable, `#!/usr/bin/env node\nconst fs=require('node:fs'),prompt=process.argv.at(-1),file=/"file_path":"([^"]+)"/.exec(prompt)?.[1]; if (!file || fs.realpathSync(file)!==file || ['"trigger_reference":null','"acceptance":null','"persisted":null'].some(x=>prompt.includes(x)) || !prompt.includes('"file_path":"/') || !prompt.includes('"allow_local_file_path":true') || prompt.includes('bytes_base64') || !prompt.includes('status=incomplete') || !prompt.includes('continue') || !prompt.includes('"kind":"find"') || !prompt.includes('"kind":"click"') || !prompt.includes('"reference":"$register_upload"') || !prompt.includes('do not click again') || !prompt.includes('dispatch_may_have_occurred=false')) process.exit(9);\nfor(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,{mode:0o755});
    const output=await new Promise((resolveOutput,reject)=>{const child=spawn(process.execPath,[adapterPath,'controlla'],{cwd:root,env:{...process.env,PHASE11_FIXTURE_BASE_URL:'http://127.0.0.1:1234',PHASE11_CODEX_PATH:executable,PHASE11_CHROME_PATH:'/chrome',PHASE11_CONTROLLA_BINARY:'/controlla'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolveOutput(JSON.parse(stdout)):reject(new Error(stderr)));child.stdin.end(JSON.stringify(input));});
    assert.equal(output.success,true);
    assert.equal(output.cleanup_completed,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { validAcceptance } from '../../adapters/phase11-verifier-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const statePath = resolve(process.env.PHASE11_STATE_FILE ?? resolve(root, '.phase11-state.json'));
const port = Number(process.env.PHASE11_PORT ?? process.argv.find(v => v.startsWith('--port='))?.slice(7) ?? 0);
const tasks = new Map();
const token = process.env.PHASE11_ORACLE_TOKEN;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const privileged = req => Boolean(token && req.headers.authorization === `Bearer ${token}`);
async function body(req, limit=65536) { const chunks=[]; let size=0; for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('body too large');chunks.push(chunk);}return Buffer.concat(chunks); }
let queue=Promise.resolve();
function serialized(fn){ const next=queue.then(fn);queue=next.catch(()=>{});return next; }

const classes = new Map([
  ['forms', ['registration-form','rich-editor-1000-char-fastkeys','slow-media-early-form','root-1000-char-transaction','contenteditable-ime-unicode']],
  ['extraction', ['structured-extraction','50k-node-targeted-control','newest-ranking-50-candidates','on-demand-frame-escalation']],
  ['multitab', ['two-tab-compare','eight-tab-pressure']],
  ['spa', ['spa-document-change','stale-after-navigation','service-worker-restart-between-observation-action']],
  ['visual_canvas', ['canvas-targeted-probe','seven-slide-capture-manifest']],
  ['virtual_list', ['virtual-list-find','virtual-list-1000-rows']],
  ['upload', ['guarded-upload','artifact-register-4mb','artifact-register-10mb']],
  ['repeated_workflow', ['repeat-qualified-flow','five-field-single-workflow']],
  ['interference', ['human-edit-race','react-rerender-target','human-interference-rebase','same-tab-read-plus-mutation']],
  ['long_workflow', ['bounded-long-flow']],
  ['concurrent_tabs', ['eight-tab-pressure','same-tab-concurrent-reads']],
  ['cross_origin_oopif', ['cross-site-oopif-target','child-frame-1000-char-transaction']],
  ['download_upload', ['download-register-upload']],
]);

const stateKey = (taskId, runId) => JSON.stringify([taskId, runId]);
function taskState(id, runId) {
  return tasks.get(stateKey(id, runId)) ?? { task_id: id, run_id: runId || null, events: [], completed: false, reset_at: Date.now() };
}
async function persist() { await mkdir(dirname(statePath), { recursive: true }); await writeFile(statePath+'.tmp', JSON.stringify(Object.fromEntries(tasks), null, 2), {mode:0o600}); await rename(statePath+'.tmp',statePath); }
async function load() { try { const raw = JSON.parse(await readFile(statePath, 'utf8')); for (const [k,v] of Object.entries(raw)) tasks.set(typeof v?.run_id === 'string' ? stateKey(v.task_id ?? k, v.run_id) : k,v); } catch {} }
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, {'content-type':'application/json','content-length':Buffer.byteLength(body)}); res.end(body); }
function page(taskId, fixture, scenario, extractionNonce, runId) {
  const title = `Controlla Phase 11 · ${taskId}`;
  const wideExtraction = taskId === '50k-node-targeted-control' && scenario === '50000_nodes_one_requested_control';
  const newestRanking = taskId === 'newest-ranking-50-candidates' && scenario === '50_candidates_staged_freshness_frontier';
  const fiveFieldForm = taskId === 'five-field-single-workflow' && scenario === 'five_fields_one_workflow';
  const richScenario = /1000_char|ime_unicode/.test(scenario);
  const interferenceScenario = /focus_scroll_rerender|human_interference/.test(scenario);
  const slowMedia = taskId === 'slow-media-early-form' && scenario === 'form_ready_before_slow_media_completes'
    ? `<img id="slow-media" src="/slow-media?task=${encodeURIComponent(taskId)}&run=${encodeURIComponent(runId)}" alt="Delayed fixture image">`
    : '';
  const rows = Array.from({length: fixture === 'records-table' && wideExtraction ? 50000 : 50}, (_, i) => newestRanking
    ? `<tr><td>record-${i + 1}</td><td>${i === 41 ? '2024-01-01T23:59:00Z' : new Date(Date.UTC(2023, 11, 1, 0, i)).toISOString().replace('.000Z','Z')}</td><td>${i === 41 ? extractionNonce : ''}</td></tr>`
    : `<tr><td>record-${i + 1}</td><td>${i % 2 ? 'older' : 'current'}</td>${(taskId === 'structured-extraction' || wideExtraction) && i === 41 ? `<td>${extractionNonce}</td>` : ''}</tr>`).join('');
  const action = `Complete ${taskId}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:32px}#scroll{height:220px;overflow:auto;border:1px solid #888}canvas{border:1px solid #888;width:500px;height:140px}label,button,input{margin:8px;padding:8px}iframe{width:400px;height:100px}</style></head><body>
<h1>${title}</h1><p data-testid="fixture-description">Controlled benchmark fixture for ${fixture}.</p>
<form id="registration-form"><label>Name <input id="name" name="name"></label>${fiveFieldForm?'<label>Email <input id="email" name="email" type="email"></label><label>Company <input id="company" name="company"></label><label>Role <input id="role" name="role"></label>':''}<label>Notes <textarea id="notes" name="notes"></textarea></label><button type="submit">Save form</button></form>${slowMedia}
<div id="records"><table><tbody>${rows}</tbody></table><button id="extract">Read requested record</button></div>
<div id="tabs"><a href="/fixture/${fixture}?task=${encodeURIComponent(taskId)}&tab=one">Tab one</a> <a href="/fixture/${fixture}?task=${encodeURIComponent(taskId)}&tab=two">Tab two</a></div>
<div id="spa"><button id="route">Navigate SPA route</button><output id="route-output"></output></div>
<canvas id="canvas" width="500" height="140"></canvas><button id="canvas-action">Probe canvas target</button>
<div id="scroll">${Array.from({length:1000},(_,i)=>`<div class="row">virtual-row-${i+1}</div>`).join('')}</div>
<input id="upload" type="file"><button id="upload-action">Register upload</button>
<div id="editor" contenteditable="true" role="textbox" aria-label="Editable benchmark content">Editable benchmark content</div>
<div id="ime-editor" contenteditable="true" role="textbox" aria-label="IME benchmark editor"></div>
<label>Root text field <textarea id="root-editor-textarea" aria-label="Root editor textarea"></textarea></label>
<iframe id="rich-child" title="child editor frame" src="/rich-editor-frame?task=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}"></iframe>
<iframe title="child frame" src="/frame?task=${encodeURIComponent(taskId)}"></iframe>
<button id="focus-elsewhere" type="button">Focus elsewhere</button>
<button id="rerender-target" type="button">Rerender target</button>
<button id="complete" data-task="${taskId}">${action}</button><output id="status" aria-live="polite"></output>
<script>
const task=${JSON.stringify(taskId)}; const run=${JSON.stringify(runId)}; const fixture=${JSON.stringify(fixture)}; const scenario=${JSON.stringify(scenario)}; const richScenario=${JSON.stringify(richScenario || interferenceScenario)};
async function save(path,data){const r=await fetch(path+'?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});document.querySelector('#status').textContent=r.ok?'Saved':'Save failed';return r.ok;}
async function event(kind, extra={}){document.querySelector('#status').textContent=kind; await fetch('/__event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task_id:task,kind,fixture,...extra})});}
document.querySelector('#registration-form').addEventListener('submit',e=>{e.preventDefault(); save('/accept/form',Object.fromEntries(new FormData(e.currentTarget)));});
document.querySelector('#extract').onclick=()=>event('extracted',{count:1});
document.querySelector('#route').onclick=()=>{history.pushState({},'',location.pathname+'?task='+encodeURIComponent(task)+'&route=next'); document.querySelector('#route-output').textContent='route=next'; event('spa_navigated');};
document.querySelector('#canvas-action').onclick=()=>event('canvas_probed');
document.querySelector('#upload-action').onclick=async()=>{const f=document.querySelector('#upload').files[0];if(!f)return;const r=await fetch('/accept/upload?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run)+'&filename='+encodeURIComponent(f.name),{method:'POST',body:f});document.querySelector('#status').textContent=r.ok?'Upload saved':'Upload failed';};
document.querySelector('#complete').onclick=()=>event('completed',{completed:true});
document.querySelector('#focus-elsewhere').onclick=()=>document.querySelector('#name').focus();
document.querySelector('#rerender-target').onclick=()=>{const field=document.querySelector('#name');const next=field.cloneNode(true);next.value=field.value;field.replaceWith(next);};
for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])document.querySelector('#ime-editor').addEventListener(type,e=>event('ime_'+type,{data:e.data??null}));
if(richScenario){const persist=(source,text)=>save('/accept/editor',{kind:'editor',source,text,length:text.length});window.__controllaFixture={readRoot:()=>document.querySelector('#editor').innerText,readIme:()=>document.querySelector('#ime-editor').innerText,readChild:()=>document.querySelector('#rich-child').contentDocument?.querySelector('#child-editor')?.innerText??null,persistRoot:()=>persist('root',document.querySelector('#editor').innerText),persistIme:()=>persist('ime',document.querySelector('#ime-editor').innerText),persistChild:()=>persist('child',document.querySelector('#rich-child').contentDocument?.querySelector('#child-editor')?.innerText??'')};}
window.addEventListener('scroll',()=>event('scrolled',{scrollY:scrollY}));
</script></body></html>`;
}

await load();
const server = createServer(async (req,res) => {
 try {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/__health') return json(res,200,{ok:true,service:'realistic-fixture'});
  if (url.pathname === '/__state' || url.pathname === '/__reset') {
    if (!privileged(req)) return json(res,403,{ok:false});
    if (req.method==='POST' && url.pathname==='/__reset') {
      const input=JSON.parse((await body(req)).toString());
      if(!identifier(input.task_id)||!identifier(input.run_id)||(input.acceptance!==undefined&&!validAcceptance(input.acceptance))) return json(res,400,{ok:false});
      const key=stateKey(input.task_id,input.run_id);
      await serialized(async()=>{if(!tasks.has(key)&&tasks.size>=256)tasks.delete(tasks.keys().next().value);const state={task_id:input.task_id,run_id:input.run_id,acceptance:input.acceptance,events:[],persisted:true,...(['structured-extraction','50k-node-targeted-control','newest-ranking-50-candidates'].includes(input.task_id)?{extraction_nonce:randomBytes(16).toString('hex')}:{})};tasks.set(key,state);try{await persist();}catch(error){tasks.delete(key);throw error;}});
      return json(res,200,{ok:true,task_id:input.task_id,run_id:input.run_id});
    }
    if(req.method==='GET' && url.pathname==='/__state') {
      await queue; const state=tasks.get(stateKey(url.searchParams.get('task_id'),url.searchParams.get('run_id')));
      return json(res,200,state??null);
    }
    return json(res,405,{ok:false});
  }
  if(req.method==='POST' && url.pathname==='/__event') { await body(req);return json(res,202,{ok:true,diagnostic_only:true}); }  if (req.method === 'POST' && ['/accept/form','/accept/upload','/accept/editor'].includes(url.pathname)) {
    const bytes=await body(req,url.pathname.endsWith('/form')?32768:12*1024*1024); const id=url.searchParams.get('task'); const run=url.searchParams.get('run');
    return await serialized(async()=>{
      const key=stateKey(id,run);const current=tasks.get(key);if(!current)return json(res,409,{ok:false});
      const kind=url.pathname.endsWith('/form')?'form':url.pathname.endsWith('/editor')?'editor':'upload';
      const value=kind==='form'?{kind,...JSON.parse(bytes.toString())}:kind==='editor'?{kind,...JSON.parse(bytes.toString())}:{kind,filename:url.searchParams.get('filename'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      if(value.kind!==kind || !validAcceptance(value))return json(res,400,{ok:false});
      const next={...current,[kind]:value,persisted:true};tasks.set(key,next);
      try{await persist();}catch(error){tasks.set(key,{...current,persisted:false});return json(res,500,{ok:false});}
      return json(res,200,{ok:true});
    });
  }
  if (req.method === 'GET' && url.pathname === '/slow-media') {
    const taskId=url.searchParams.get('task'); const runId=url.searchParams.get('run');
    if (taskId!=='slow-media-early-form' || !identifier(runId)) return json(res,404,{ok:false});
    await new Promise(resolvePromise=>setTimeout(resolvePromise,300));
    res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
  if (req.method === 'GET' && url.pathname === '/frame') { const id=url.searchParams.get('task');if(!identifier(id))return json(res,400,{ok:false});return res.end(`<html><body><p>Independent child frame for ${id}</p></body></html>`); }
  if (req.method === 'GET' && url.pathname === '/rich-editor-frame') { const id=url.searchParams.get('task');if(!identifier(id))return json(res,400,{ok:false});return res.end(`<html><body><div id="child-editor" contenteditable="true" role="textbox" aria-label="Child editor">${url.searchParams.get('scenario')?.includes('1000_char')?'':'Child editor ready'}</div><textarea id="child-textarea" aria-label="Child textarea"></textarea><script>window.__controllaFrameFixture={read:()=>document.querySelector('#child-editor').innerText};</script></body></html>`); }
  if (req.method === 'GET' && (url.pathname.startsWith('/fixture/') || ['registration-form','records-table','paired-tabs','spa-router','canvas-widget','virtual-list','file-input','workflow-suite','slide-deck'].includes(url.pathname.replace(/^\//,'')))) { const fixture=url.pathname.replace(/^\/|\/$/g,'').replace(/^fixture\//,''); const taskId=url.searchParams.get('task') ?? fixture; const runId=url.searchParams.get('run') ?? ''; if(!identifier(taskId)||!identifier(fixture)||(runId&&!identifier(runId)))return json(res,400,{ok:false}); const current=taskState(taskId,runId); return res.end(page(taskId, fixture, url.searchParams.get('scenario') ?? '', current.extraction_nonce ?? '', current.run_id??'')); }
  res.writeHead(404); res.end('not found');
 } catch { if(!res.headersSent)json(res,400,{ok:false,error:'invalid or oversized request'});else res.end(); }
});
server.listen(port,'127.0.0.1',()=>{const address=server.address(); console.log(JSON.stringify({ok:true,base_url:`http://127.0.0.1:${address.port}`}));});

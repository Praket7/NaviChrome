#!/usr/bin/env node
// Dedicated Phase 12 workload fixture. Every mutating row writes an acceptance
// record to this server; the runner reads it back through the separate oracle
// endpoint. A tool receipt alone cannot qualify a row.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.PHASE12_PORT ?? process.argv.find((value) => value.startsWith('--port='))?.slice(7) ?? 0);
const token = process.env.PHASE12_ORACLE_TOKEN ?? randomUUID();
const tasks = new Map();
const authSessions = new Map();

const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
};
const body = async (req, limit = 65536) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const cookie = (req, name) => {
  const raw = req.headers.cookie ?? '';
  for (const entry of raw.split(';')) {
    const [key, ...rest] = entry.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
};
const query = (url) => ({
  task: url.searchParams.get('task') ?? 'default',
  run: url.searchParams.get('run') ?? 'default',
});
const currentTask = (taskId, runId) => {
  const record = tasks.get(taskId);
  return record?.run_id === runId ? record : null;
};

function shell(title, content, task, run, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:32px}label,input,textarea,button{display:block;margin:8px 0;padding:8px}iframe{width:520px;height:180px}output{display:block;margin-top:12px;font-weight:600}</style></head><body><h1>${title}</h1>${content}<output id="status" aria-live="polite"></output><script>
const task=${JSON.stringify(task)}, run=${JSON.stringify(run)};
async function save(kind, value) {
  const response = await fetch('/accept/'+kind+'?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  document.querySelector('#status').textContent = response.ok ? 'Saved' : 'Save failed';
  return response.ok;
}
${extra}
</script></body></html>`;
}

function framePage(content, task = 'default', run = 'default', extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Phase 12 nested frame</title><style>body{font:16px system-ui;margin:16px}label,input,button{display:block;margin:6px 0;padding:6px}output{display:block;margin-top:8px}</style></head><body>${content}<script>const task=${JSON.stringify(task)},run=${JSON.stringify(run)};document.addEventListener('pointerdown',e=>fetch('/accept/nested-pointer?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:'outer',x:e.clientX,y:e.clientY,target:e.target?.id||e.target?.tagName})}).catch(()=>{}),true);${extra}</script></body></html>`;
}

function page(kind, task, run, req) {
  if (kind === 'typing') {
    return shell('Phase 12 typing workload', '<textarea id="editor" aria-label="Typing editor" style="min-height:120px;width:100%"></textarea><button id="save" type="button">Save text</button>', task, run,
      `document.querySelector('#save').onclick=()=>save('editor',{text:document.querySelector('#editor').value});`);
  }
  if (kind === 'form' || kind === 'background') {
    return shell('Phase 12 form workload', '<label>Name <input id="name" aria-label="Name"></label><label>Notes <textarea id="notes" aria-label="Notes"></textarea></label><button id="save" type="button">Save form</button>', task, run,
      `document.querySelector('#save').onclick=()=>save('form',{name:document.querySelector('#name').value,notes:document.querySelector('#notes').value});`);
  }
  if (kind === 'spa') {
    return shell('Phase 12 SPA workload', '<label>Name <input id="name" aria-label="Name"></label><button id="rerender" type="button">Rerender target</button><button id="save" type="button">Save form</button>', task, run,
      `document.querySelector('#rerender').onclick=()=>{const field=document.querySelector('#name');const next=field.cloneNode(true);next.value=field.value;next.setAttribute('value',field.value);field.replaceWith(next);document.querySelector('#status').textContent='Rerendered';};
       document.querySelector('#save').onclick=()=>save('form',{name:document.querySelector('#name').value,notes:'spa'});`);
  }
  if (kind === 'child') {
    const child = `<!doctype html><html><body><div id="editor" contenteditable="true" role="textbox" aria-label="Child editor" style="min-height:80px;border:1px solid #888"></div><button id="save" type="button">Save child</button><script>
      const task=${JSON.stringify(task)}, run=${JSON.stringify(run)};
      document.querySelector('#save').onclick=async()=>{const r=await fetch('/accept/child?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.querySelector('#editor').innerText})});parent.document.querySelector('#status').textContent=r.ok?'Saved':'Save failed';};
    </script></body></html>`;
    return shell('Phase 12 child-frame workload', `<iframe id="child" title="Child editor frame" srcdoc="${child.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`, task, run);
  }
  if (kind === 'headless') {
    return shell('Phase 12 headless workload', '<p id="fact">headless-parity-fact</p>', task, run);
  }
  if (kind === 'records') {
    return shell('Phase 12 research workload', '<table><tbody><tr><td>record-41</td><td>current</td></tr><tr id="fact"><td>record-42</td><td>older</td><td>phase12-citation-fact</td></tr></tbody></table>', task, run);
  }
  if (kind === 'longform') {
    return shell('Phase 12 long-form workload',
      '<section id="step1"><label>Full name <input id="fullName" aria-label="Full name"></label><label>Mailing address <textarea id="address" aria-label="Mailing address"></textarea></label><button id="continue" type="button">Continue</button></section>' +
      '<section id="step2" hidden><label>Email <input id="email" aria-label="Email"></label><button id="saveDraft" type="button">Save draft</button><button id="submit" type="button">Submit application</button></section>',
      task, run,
      `const step1=document.querySelector('#step1'),step2=document.querySelector('#step2');
       document.querySelector('#continue').onclick=()=>{step1.hidden=true;step2.hidden=false;document.querySelector('#status').textContent='Step 2';};
       document.querySelector('#saveDraft').onclick=async()=>{const r=await fetch('/accept/draft?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({full_name:document.querySelector('#fullName').value,address:document.querySelector('#address').value,email:document.querySelector('#email').value,submitted:false})});document.querySelector('#status').textContent=r.ok?'Draft saved':'Draft failed';};
       document.querySelector('#submit').onclick=async()=>{const r=await fetch('/accept/submit?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({submitted:true})});document.querySelector('#status').textContent=r.ok?'Submitted':'Submit failed';};`);
  }
  if (kind === 'interference') {
    return shell('Phase 12 interference workload',
      '<label>Safe field <input id="safe" aria-label="Safe field"></label><label>Trap field <input id="trap" aria-label="Trap field"></label><button id="arm" type="button">Arm interference</button>',
      task, run,
      `const safe=document.querySelector('#safe'),trap=document.querySelector('#trap');let armed=false;
       document.querySelector('#arm').onclick=()=>{armed=true;document.querySelector('#status').textContent='Armed';};
       safe.addEventListener('keydown',()=>{if(!armed)return;armed=false;trap.focus();document.querySelector('#status').textContent='Interfered';fetch('/accept/interference?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({safe:safe.value,trap:trap.value,interfered:true})}).catch(()=>{});});`);
  }
  if (kind === 'shadow') {
    return shell('Phase 12 shadow DOM workload', '<shadow-outer></shadow-outer>', task, run,
      `class ShadowInner extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;const root=this.attachShadow({mode:'open'});root.innerHTML='<label>Deep shadow editor <input id="deep" aria-label="Deep shadow editor"></label>';}}
       customElements.define('shadow-inner',ShadowInner);
       class ShadowOuter extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;const root=this.attachShadow({mode:'open'});root.innerHTML='<shadow-inner></shadow-inner><button id="save" type="button">Save shadow</button>';root.querySelector('#save').onclick=()=>save('shadow',{text:root.querySelector('shadow-inner').shadowRoot.querySelector('#deep').value});}}
       customElements.define('shadow-outer',ShadowOuter);`);
  }
  if (kind === 'nested') {
    return shell('Phase 12 nested-frame workload', `<iframe id="nested" title="Nested frame" style="width:600px;height:520px" src="/nested-outer?task=${encodeURIComponent(task)}&run=${encodeURIComponent(run)}"></iframe>`, task, run,
      `document.addEventListener('pointerdown',e=>fetch('/accept/nested-pointer?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:'root',x:e.clientX,y:e.clientY,target:e.target?.id||e.target?.tagName})}).catch(()=>{}),true);`);
  }
  if (kind === 'artifacts') {
    return shell('Phase 12 artifact transfer workload',
      '<p id="account">phase12-owner</p><a id="download" href="/artifact/phase12.txt?task=' + encodeURIComponent(task) + '&run=' + encodeURIComponent(run) + '" download="phase12-artifact.txt">Download artifact</a><input id="upload" type="file" aria-label="Upload artifact"><button id="choose" type="button">Choose file</button><p id="persisted"></p>',
      task, run,
      `const upload=document.querySelector('#upload');document.querySelector('#choose').onclick=()=>upload.click();upload.onchange=async()=>{const file=upload.files?.[0];if(!file)return;const text=await file.text();const response=await fetch('/accept/artifact-upload?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:file.name,size:file.size,text})});const ok=response.ok;document.querySelector('#status').textContent=ok?'Uploaded':'Upload failed';if(ok)document.querySelector('#persisted').textContent='Stored';};`);
  }
  if (kind === 'webmcp') {
    return shell('Phase 12 WebMCP workload', '<p id="tool-state">No page tool called</p>', task, run,
      `const webmcpTool={name:'record_lookup',description:'Look up one record through the page-owned typed tool.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}};
       const modelContext={getTools:async()=>[webmcpTool],executeTool:async(tool,input)=>{const value=typeof input==='string'?JSON.parse(input):input;const response=await fetch('/accept/webmcp?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool:tool?.name||'',id:value?.id||'',value:value?.value??null})});document.querySelector('#tool-state').textContent=response.ok?'Tool saved':'Tool failed';return response.ok?value?.id||'ok':'error';}};
       try{Object.defineProperty(document,'modelContext',{configurable:true,value:modelContext});}catch{document.modelContext=modelContext;}
       const ready=document.createElement('div');ready.id='webmcp-ready';document.body.append(ready);`);
  }
  if (kind === 'webmcp-absent') {
    return shell('Phase 12 WebMCP fallback workload', '<p id="tool-state">No page tool exposed</p>', task, run,
      `const ready=document.createElement('div');ready.id='webmcp-ready';document.body.append(ready);`);
  }
  if (kind === 'auth') {
    const sid = cookie(req, 'phase12_session');
    const session = sid ? authSessions.get(sid) : null;
    const signedIn = session?.task === task && session?.run === run;
    return shell('Phase 12 authenticated workload',
      `<p id="secret" aria-label="Session secret" ${signedIn ? '' : 'hidden'}>member-${String(run).slice(0, 8)}</p><button id="signin" type="button" ${signedIn ? 'hidden' : ''}>Sign in</button><button id="saveSession" type="button" ${signedIn ? '' : 'hidden'}>Save session</button>`,
      task, run,
      `const signin=document.querySelector('#signin'),saveSession=document.querySelector('#saveSession'),secret=document.querySelector('#secret');
       signin.onclick=async()=>{const r=await fetch('/auth/login?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',credentials:'same-origin'});if(r.ok){signin.hidden=true;secret.hidden=false;saveSession.hidden=false;document.querySelector('#status').textContent='Signed in';}else document.querySelector('#status').textContent='Sign in failed';};
       saveSession.onclick=async()=>{const r=await fetch('/auth/save?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',credentials:'same-origin'});document.querySelector('#status').textContent=r.ok?'Session saved':'Session failed';};`);
  }
  return null;
}

function researchPage(index, task, run, record) {
  const number = String(index + 1).padStart(2, '0');
  if (record) {
    record.research_seen = [...new Set([...(record.research_seen ?? []), index])].sort((a, b) => a - b);
  }
  // Every research page shares one semantic structure so a qualified skill can
  // replay on a later page. Only the extracted fact differs per index; a
  // per-index heading would change the runtime's role/name structural
  // signature and correctly quarantine the skill as structural drift.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Citation page</title></head><body><h1>Research page</h1><p id="fact">citation-fact-${number}</p></body></html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/__health') return json(res, 200, { ok: true, service: 'phase12-workload-fixture' });
    if (url.pathname === '/__reset' || url.pathname === '/__state') {
      if (!token || req.headers.authorization !== `Bearer ${token}`) return json(res, 403, { ok: false });
      if (req.method === 'POST' && url.pathname === '/__reset') {
        const input = JSON.parse((await body(req)).toString());
        if (!validId(input.task_id) || !validId(input.run_id) || (input.acceptance !== undefined && (typeof input.acceptance !== 'object' || input.acceptance === null))) return json(res, 400, { ok: false });
        tasks.set(input.task_id, { task_id: input.task_id, run_id: input.run_id, acceptance: input.acceptance ?? null, persisted: false, authenticated: false, saved: false, submitted: false, research_seen: [], nested_pointers: [], webmcp: null, artifact_upload: null, download_seen: false });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/__state') {
        const state = tasks.get(url.searchParams.get('task_id'));
        return json(res, 200, state?.run_id === url.searchParams.get('run_id') ? state : null);
      }
      return json(res, 405, { ok: false });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/accept/')) {
      const kind = url.pathname.slice('/accept/'.length);
      const { task, run } = query(url);
      const current = currentTask(task, run);
      if (!current || !['editor', 'form', 'child', 'draft', 'interference', 'shadow', 'nested', 'nested-click', 'nested-pointer', 'webmcp', 'artifact-upload'].includes(kind)) return json(res, 409, { ok: false });
      const value = JSON.parse((await body(req, 128 * 1024)).toString());
      if (kind === 'draft') {
        if (value.submitted === true) return json(res, 400, { ok: false });
        current.draft = value;
        current.submitted = false;
      } else if (kind === 'interference') {
        current.interference = value;
      } else if (kind === 'nested-click') {
        current.nested_click = value;
        current.nested_clicked = true;
      } else if (kind === 'nested-pointer') {
        current.nested_pointers = [...(current.nested_pointers ?? []), value].slice(-20);
      } else if (kind === 'webmcp') {
        current.webmcp = value;
      } else if (kind === 'artifact-upload') {
        if (value.filename !== 'phase12-artifact.txt' || value.text !== 'phase12-artifact-v1\n') return json(res, 400, { ok: false });
        current.artifact_upload = value;
      } else {
        current[kind] = value;
      }
      current.persisted = true;
      tasks.set(task, current);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const { task, run } = query(url);
      const current = currentTask(task, run);
      if (!current) return json(res, 409, { ok: false });
      const sid = randomUUID();
      authSessions.set(sid, { task, run });
      current.authenticated = true;
      tasks.set(task, current);
      return json(res, 200, { ok: true }, { 'set-cookie': `phase12_session=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (req.method === 'POST' && url.pathname === '/auth/save') {
      const { task, run } = query(url);
      const current = currentTask(task, run);
      const session = authSessions.get(cookie(req, 'phase12_session'));
      if (!current || session?.task !== task || session?.run !== run) return json(res, 403, { ok: false });
      current.authenticated = true;
      current.authenticated_persisted = true;
      current.saved = true;
      tasks.set(task, current);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      if (url.pathname === '/artifact/phase12.txt') {
        const { task, run } = query(url);
        const current = currentTask(task, run);
        if (!current) return json(res, 404, { ok: false });
        current.download_seen = true;
        tasks.set(task, current);
        const payload = Buffer.from('phase12-artifact-v1\n');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="phase12-artifact.txt"', 'content-length': payload.length });
        return res.end(payload);
      }
      if (url.pathname === '/research-page') {
        const { task, run } = query(url);
        const index = Number(url.searchParams.get('index'));
        if (!Number.isInteger(index) || index < 0 || index > 9) return json(res, 404, { ok: false });
        const record = currentTask(task, run);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(researchPage(index, task, run, record));
      }
      if (url.pathname === '/nested-outer') {
        const { task, run } = query(url);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(framePage(`<iframe id="inner" title="Nested inner frame" style="width:560px;height:420px" src="/nested-inner?task=${encodeURIComponent(task)}&run=${encodeURIComponent(run)}"></iframe>`, task, run));
      }
      if (url.pathname === '/nested-inner') {
        const { task, run } = query(url);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(shell('Phase 12 nested inner frame',
          '<label>Nested editor <input id="nestedEditor" aria-label="Nested editor"></label><button id="saveNested" type="button">Save nested</button>',
          task, run,
          `const nestedEditor=document.querySelector('#nestedEditor');let nestedSaveTimer=null;document.addEventListener('pointerdown',e=>fetch('/accept/nested-pointer?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:'inner',x:e.clientX,y:e.clientY,target:e.target?.id||e.target?.tagName})}).catch(()=>{}),true);nestedEditor.addEventListener('input',()=>{clearTimeout(nestedSaveTimer);nestedSaveTimer=setTimeout(()=>fetch('/accept/nested?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:nestedEditor.value})}).catch(()=>{}),40);});document.querySelector('#saveNested').onclick=async()=>{const r=await fetch('/accept/nested-click?task='+encodeURIComponent(task)+'&run='+encodeURIComponent(run),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.querySelector('#nestedEditor').value})});const result=r.ok?'Saved':'Save failed';document.querySelector('#status').textContent=result;window.top.document.querySelector('#status').textContent=result;};`));
      }
      const key = url.pathname.replace(/^\//, '');
      const { task, run } = query(url);
      const html = page(key, task, run, req);
      if (html) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
    }
    res.writeHead(404);
    res.end('not found');
  } catch {
    if (!res.headersSent) json(res, 400, { ok: false, error: 'invalid request' });
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ ok: true, base_url: `http://127.0.0.1:${address.port}`, oracle_token: token }));
});

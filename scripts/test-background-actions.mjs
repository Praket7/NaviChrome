import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../crates/controlla-runtime/src/shared_page/background_action.js', import.meta.url), 'utf8');
const guardSource = readFileSync(new URL('../crates/controlla-runtime/src/shared_page/guard.js', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.CONTROLLA_CHROME ? { executablePath: process.env.CONTROLLA_CHROME } : { channel: 'chrome' }) }); });
after(async () => { await browser?.close(); });
async function run(html, action, expected, value, setup = '') {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(async ({ source, action, expected, value, setup }) => {
      const retained = { nodes: [document.querySelector('#target')] };
      if (setup) new Function(setup)();
      const result = await new Function(`return (${source})`)().call(retained, 0, action, expected, value, null);
      return { result, value: document.querySelector('#target')?.value, events: window.events || [] };
    }, { source, action, expected, value, setup });
  } finally { await page.close(); }
}
test('labelled fields verify exact value including whitespace', async () => {
  const actual = await run('<input id="target" aria-label="Name" value="old">', 'fill', 'old', ' new  value ');
  assert.equal(actual.result.verified, true);
  assert.equal(actual.result.after, ' new  value ');
});
test('stale expected value prevents overwrite', async () => {
  const actual = await run('<input id="target" value="human edit">', 'fill', 'old', 'new');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.value, 'human edit');
  assert.equal(actual.result.reason, 'same_field_conflict');
});
test('replacement with identical identity is rebound to the live control', async () => {
  const actual = await run('<input id="target" aria-label="Name" value="old">', 'fill', 'old', 'new',
    'document.querySelector("#target").outerHTML = \'<input id="target" aria-label="Name" value="old">\'');
  assert.equal(actual.result.rebound, true);
  assert.equal(actual.result.dispatched, true);
  assert.equal(actual.value, 'new');
});
test('rebinding refuses when two live controls share the identity', async () => {
  const actual = await run('<input id="target" aria-label="Name" value="old">', 'fill', 'old', 'new',
    'document.querySelector("#target").outerHTML = \'<div><input aria-label="Name" value="old"></div><div><input aria-label="Name" value="old"></div>\'');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.result.reason, 'target_replaced');
});
test('live password transition refuses before reading a secret', async () => {
  const actual = await run('<input id="target" value="synthetic-secret">', 'fill', '', 'new',
    'document.querySelector("#target").type="password"');
  assert.equal(actual.result.dispatched, false);
  assert.equal(JSON.stringify(actual.result).includes('synthetic-secret'), false);
});
test('changed readback after events remains a dispatched mutation', async () => {
  const actual = await run('<input id="target" value="old">', 'fill', 'old', 'new',
    'document.querySelector("#target").addEventListener("input", e => e.target.value="server correction")');
  assert.equal(actual.result.dispatched, true);
  assert.equal(actual.result.verified, false);
  assert.equal(actual.value, 'server correction');
});
test('select verifies value rather than concatenated option labels', async () => {
  const actual = await run('<select id="target"><option value="a">First</option><option value="b">Second</option></select>', 'select', 'a', 'b');
  assert.equal(actual.result.verified, true);
  assert.equal(actual.result.after, 'b');
});
test('missing select option refuses without clearing selection', async () => {
  const actual = await run('<select id="target"><option value="a">First</option></select>', 'select', 'a', 'absent');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.value, 'a');
});
test('double click delivers click click dblclick in order', async () => {
  const actual = await run('<button id="target">Open</button>', 'double_click', null, null,
    'window.events=[];for(const type of ["click","dblclick"])document.querySelector("#target").addEventListener(type,e=>window.events.push(e.type))');
  assert.deepEqual(actual.events, ['click', 'click', 'dblclick']);
  assert.equal(actual.result.dispatched, true);
});
test('sensitive transition during input hides post-dispatch value', async () => {
  const actual = await run('<input id="target" value="old">', 'fill', 'old', 'new',
    'document.querySelector("#target").addEventListener("input", e=>{e.target.type="password";e.target.value="synthetic-secret"})');
  assert.equal(actual.result.dispatched, true);
  assert.equal(JSON.stringify(actual.result).includes('synthetic-secret'), false);
});

async function runWithLabel(html, action, label) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(async ({ source, action, label }) => {
      const retained = { nodes: [document.querySelector('#target')] };
      const result = await new Function(`return (${source})`)().call(retained, 0, action, null, null, null, null, label);
      return { result };
    }, { source, action, label });
  } finally { await page.close(); }
}
test('background activation presses the control whose words the click named', async () => {
  const actual = await runWithLabel('<button id="target">Insert</button>', 'click', 'Insert');
  assert.equal(actual.result.dispatched, true);
  assert.equal(actual.result.ok, true);
});
test('background activation refuses when the named words are absent', async () => {
  const actual = await runWithLabel('<button id="target">Insert</button>', 'click', 'Paste');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.result.reason, 'label_not_under_pointer');
});
test('background activation accepts a named ancestor control', async () => {
  const actual = await runWithLabel('<div aria-label="Insert image"><button id="target"><span>+</span></button></div>', 'click', 'insert image');
  assert.equal(actual.result.dispatched, true);
  assert.equal(actual.result.ok, true);
});

async function runPointerGuard(html, { label = null } = {}) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(({ source, label }) => {
      const target = document.querySelector('#target');
      const nameOf = n => (n?.getAttribute?.('aria-label') || n?.innerText || n?.textContent || '').replace(/\s+/g, ' ').trim();
      const retained = {
        nodes: [target],
        items: [{ tag: target.tagName.toLowerCase(), role: target.getAttribute('role') || 'button', name: nameOf(target), raw_value: '', href: null, source_frame: 'main' }],
        name: nameOf,
        raw: n => (typeof n?.value === 'string' ? n.value : ''),
        visible: n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; },
      };
      const guard = new Function('__UNSAFE__', `return (${source})`)(false);
      return guard.call(retained, 0, { kind: 'focused' }, { label });
    }, { source: guardSource, label });
  } finally { await page.close(); }
}
const OVERLAY = '<button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Insert</button><div id="menu" role="menuitem" style="position:absolute;left:100px;top:100px;width:120px;height:40px;z-index:10">Image</div>';
test('pointer guard passes a menu the agent just opened when its words are under the pointer', async () => {
  const checked = await runPointerGuard(OVERLAY, { label: 'Image' });
  assert.equal(checked.ok, true);
});
test('pointer guard refuses when the named words are not under the pointer', async () => {
  const checked = await runPointerGuard(OVERLAY, { label: 'Insert' });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'label_not_under_pointer');
});
test('pointer guard still reports a real obstruction when no words are named', async () => {
  const checked = await runPointerGuard(OVERLAY);
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'obscured');
});

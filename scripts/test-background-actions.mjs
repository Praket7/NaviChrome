import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../crates/navichrome-runtime/src/shared_page/background_action.js', import.meta.url), 'utf8');
const guardSource = readFileSync(new URL('../crates/navichrome-runtime/src/shared_page/guard.js', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NAVICHROME_CHROME ? { executablePath: process.env.NAVICHROME_CHROME } : { channel: 'chrome' }) }); });
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

async function runWithLabel(html, action, label, setup = '', authority = null) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(async ({ source, action, label, setup, authority }) => {
      const target = document.querySelector('#target');
      const role = target.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'input', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[target.tagName] || 'control');
      Object.defineProperty(target, '__navichromeIdentity', { configurable: true, value: {
        tag: target.tagName.toLowerCase(), role, name: (target.getAttribute('aria-label') || target.innerText || target.getAttribute('alt') || Array.from(target.labels || []).map(item => item.innerText).join(' ') || target.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
        href: target.tagName === 'A' ? target.href : null, type: typeof target.type === 'string' ? target.type : null,
        test_id: target.getAttribute('data-testid') || target.getAttribute('data-test') || target.getAttribute('data-qa') || null,
        id: target.id || null,
      } });
      const retained = { nodes: [target] };
      window.events = [];
      target.addEventListener('click', () => window.events.push('click'));
      if (setup) new Function(setup)();
      const result = await new Function(`return (${source})`)().call(retained, 0, action, null, null, null, null, label, authority);
      return { result, events: window.events };
    }, { source, action, label, setup, authority });
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
test('background activation refuses when a connected target changes its observed name', async () => {
  const actual = await runWithLabel('<button id="target">Send</button>', 'click', 'Send', 'document.querySelector("#target").textContent = "Delete"');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.result.reason, 'target_identity_changed');
  assert.deepEqual(actual.events, []);
});
test('background activation refuses when an overlay covers the observed target', async () => {
  const actual = await runWithLabel('<button id="target">Send</button>', 'click', 'Send', 'const o=document.createElement("div");o.id="overlay";Object.assign(o.style,{position:"fixed",inset:"0",zIndex:"99",background:"transparent"});document.body.append(o)');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.result.reason, 'obscured');
  assert.deepEqual(actual.events, []);
});
test('consequential activation requires exact page authority before dispatch', async () => {
  const html = '<div id="account">Signed in as praketg1@gmail.com</div><div id="recipient">praket.gauri1234@gmail.com</div><div id="subject">NaviChrome test</div><button id="target">Send</button>';
  const missing = await runWithLabel(html, 'click', 'Send');
  assert.equal(missing.result.dispatched, false);
  assert.equal(missing.result.reason, 'mutation_authority_required');
  assert.deepEqual(missing.events, []);
  const authority = {
    action: 'send',
    account: { selector: '#account', expected: 'Signed in as praketg1@gmail.com' },
    destination: { selector: '#recipient', expected: 'praket.gauri1234@gmail.com' },
    objects: [{ selector: '#subject', expected: 'NaviChrome test' }],
  };
  const allowed = await runWithLabel(html, 'click', 'Send', '', authority);
  assert.equal(allowed.result.dispatched, true);
  assert.deepEqual(allowed.events, ['click']);
  const wrongDestination = await runWithLabel(html.replace('praket.gauri1234@gmail.com', 'other@example.test'), 'click', 'Send', '', authority);
  assert.equal(wrongDestination.result.dispatched, false);
  assert.equal(wrongDestination.result.reason, 'mutation_destination_mismatch');
  assert.deepEqual(wrongDestination.events, []);
});
test('consequential action uses its first verb and carried authority does not block compose', async () => {
  const html = '<div id="account">Signed in as praketg1@gmail.com</div><div id="recipient">praket.gauri1234@gmail.com</div><div id="subject">NaviChrome test</div><button id="target">Send message</button>';
  const authority = {
    action: 'send',
    account: { selector: '#account', expected: 'Signed in as praketg1@gmail.com' },
    destination: { selector: '#recipient', expected: 'praket.gauri1234@gmail.com' },
    objects: [{ selector: '#subject', expected: 'NaviChrome test' }],
  };
  const sent = await runWithLabel(html, 'click', 'Send message', '', authority);
  assert.equal(sent.result.dispatched, true);
  const compose = await runWithLabel(html.replace('Send message', 'Compose'), 'click', 'Compose', '', authority);
  assert.equal(compose.result.dispatched, true);
});

async function runPointerGuard(html, { label = null, authority = null } = {}) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(({ source, label, authority }) => {
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
      return guard.call(retained, 0, { kind: 'focused' }, { label, authority });
    }, { source: guardSource, label, authority });
  } finally { await page.close(); }
}
const OVERLAY = '<button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Insert</button><div id="menu" role="menuitem" style="position:absolute;left:100px;top:100px;width:120px;height:40px;z-index:10">Image</div>';
test('pointer guard passes a menu the agent just opened when its words are under the pointer', async () => {
  const checked = await runPointerGuard(OVERLAY, { label: 'Image' });
  assert.equal(checked.ok, true);
});
test('pointer guard reports an overlay when the named target is covered', async () => {
  const checked = await runPointerGuard(OVERLAY, { label: 'Insert' });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'obscured');
});
test('pointer guard still reports a real obstruction when no words are named', async () => {
  const checked = await runPointerGuard(OVERLAY);
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'obscured');
});
test('pointer guard requires exact account, destination, and object for Send', async () => {
  const html = '<div id="account">Signed in as praketg1@gmail.com</div><div id="recipient">praket.gauri1234@gmail.com</div><div id="subject">NaviChrome test</div><button id="target">Send</button>';
  const authority = {
    action: 'send',
    account: { selector: '#account', expected: 'Signed in as praketg1@gmail.com' },
    destination: { selector: '#recipient', expected: 'praket.gauri1234@gmail.com' },
    objects: [{ selector: '#subject', expected: 'NaviChrome test' }],
  };
  const missing = await runPointerGuard(html, { label: 'Send' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'mutation_authority_required');
  const allowed = await runPointerGuard(html, { label: 'Send', authority });
  assert.equal(allowed.ok, true);
  const wrongRecipient = await runPointerGuard(html.replace('praket.gauri1234@gmail.com', 'other@example.test'), { label: 'Send', authority });
  assert.equal(wrongRecipient.ok, false);
  assert.equal(wrongRecipient.reason, 'mutation_destination_mismatch');
});
test('pointer guard reports an obstruction before missing send authority', async () => {
  const html = '<button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Send</button><div id="overlay" style="position:absolute;left:100px;top:100px;width:120px;height:40px;z-index:10">Overlay</div>';
  const checked = await runPointerGuard(html, { label: 'Send' });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, 'obscured');
});
test('pointer guard canonicalizes consequential verbs and ignores authority for benign labels', async () => {
  const html = '<div id="account">Signed in as praketg1@gmail.com</div><div id="recipient">praket.gauri1234@gmail.com</div><div id="subject">NaviChrome test</div><button id="target">Send message</button>';
  const authority = {
    action: 'send',
    account: { selector: '#account', expected: 'Signed in as praketg1@gmail.com' },
    destination: { selector: '#recipient', expected: 'praket.gauri1234@gmail.com' },
    objects: [{ selector: '#subject', expected: 'NaviChrome test' }],
  };
  assert.equal((await runPointerGuard(html, { label: 'Send message', authority })).ok, true);
  assert.equal((await runPointerGuard(html.replace('Send message', 'Compose'), { label: 'Compose', authority })).ok, true);
});

const registrySource = readFileSync(new URL('../crates/navichrome-runtime/src/shared_page/background_action_registry.js', import.meta.url), 'utf8');
const snapshotSource = readFileSync(new URL('../crates/navichrome-runtime/src/shared_page/snapshot.js', import.meta.url), 'utf8');

async function runRegistryAction(html, label) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(async ({ actionSource, registrySource, label }) => {
      const target = document.querySelector('#target');
      let clicks = 0;
      target.addEventListener('click', () => { clicks += 1; });
      target.__navichromeIdentity = { tag: 'button', role: 'button', name: 'Image', href: null, type: 'submit', test_id: null, id: 'target', path: null, section: null };
      globalThis.__navichromeSnapshots = { 'tok:1': [target] };
      const expression = registrySource
        .replace('__TOKEN__', JSON.stringify('tok:1'))
        .replaceAll('__INDEX__', '0')
        .replace('__ACTION_NAME__', JSON.stringify('click'))
        .replace('__EXPECTED__', 'null')
        .replace('__NEXT__', 'null')
        .replace('__KEY__', 'null')
        .replace('__OUTCOME__', 'null')
        .replace('__LABEL__', JSON.stringify(label))
        .replace('__AUTHORITY__', 'null')
        .replace('__ACTION__', () => actionSource);
      return { result: await new Function(`return ${expression}`)(), clicks };
    }, { actionSource: source, registrySource, label });
  } finally { await page.close(); }
}

test('registry re-materializes a retained control without its CDP object id', async () => {
  const actual = await runRegistryAction('<button id="target" style="width:120px;height:40px">Image</button>', 'Image');
  assert.equal(actual.result.dispatched, true);
  assert.equal(actual.clicks, 1);
});

test('registry action still refuses words that are not on the re-materialized control', async () => {
  const actual = await runRegistryAction('<button id="target" style="width:120px;height:40px">Image</button>', 'Insert');
  assert.equal(actual.result.dispatched, false);
  assert.equal(actual.result.reason, 'label_not_under_pointer');
  assert.equal(actual.clicks, 0);
});

async function runScopedSnapshot(html, selector) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(({ source, selector }) => {
      try {
        const snapshot = new Function(`return (${source})`)().call(null, {
          selector, token: 't1', max_items: 50, max_text_chars: 2000, max_bytes: 32000,
          href_hint: null, goal: null, max_scan_nodes: 4000,
        });
        return { ok: true, names: snapshot.public.items.map(item => item.name) };
      } catch (error) {
        return { ok: false, error: String(error.message) };
      }
    }, { source: snapshotSource, selector });
  } finally { await page.close(); }
}

test('scoped snapshot finds a menu inside a shadow root', async () => {
  const actual = await runScopedSnapshot(
    '<div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML="<div role=\\"menu\\"><button role=\\"menuitem\\">Make a copy</button></div>";</script>',
    '[role="menu"]');
  assert.equal(actual.ok, true);
  assert.ok(actual.names.includes('Make a copy'), JSON.stringify(actual.names));
});

test('scoped snapshot names an unmatched selector instead of failing opaquely', async () => {
  const actual = await runScopedSnapshot('<main><button>One</button></main>', '[role="menu"]');
  assert.equal(actual.ok, false);
  assert.match(actual.error, /matched no element/);
});

test('scoped snapshot names an ambiguous selector with its match count', async () => {
  const actual = await runScopedSnapshot(
    '<div role="menu"><button role="menuitem">One</button></div><div role="menu"><button role="menuitem">Two</button></div>',
    '[role="menu"]');
  assert.equal(actual.ok, false);
  assert.match(actual.error, /matched 2 elements/);
});

async function runSnapshotPage(html, overrides = {}) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(({ source, overrides }) => {
      try {
        const snapshot = new Function(`return (${source})`)().call(null, {
          selector: null, token: 't1', max_items: 50, max_text_chars: 1000, max_bytes: 32000,
          href_hint: null, goal: null, max_scan_nodes: 4000, ...overrides,
        });
        return { ok: true, public: snapshot.public };
      } catch (error) {
        return { ok: false, error: String(error.message) };
      }
    }, { source: snapshotSource, overrides });
  } finally { await page.close(); }
}

test('offscreen preloaded dialog is not the active modal', async () => {
  const actual = await runSnapshotPage(
    '<div role="dialog" aria-modal="true" style="position:fixed;left:-10000px;top:-10000px;width:600px;height:400px">' +
      '<button>Open a file</button><button>Recent</button></div>' +
    '<main><button>Keep me</button></main>');
  assert.equal(actual.ok, true);
  assert.equal(actual.public.modal_count, 0);
  const names = actual.public.items.map(item => item.name);
  assert.ok(names.includes('Keep me'), JSON.stringify(names));
  assert.ok(!names.includes('Open a file'), JSON.stringify(names));
  assert.ok(!actual.public.text.includes('Open a file'), actual.public.text);
});

test('aria-hidden dialog is not counted as visible', async () => {
  const actual = await runSnapshotPage(
    '<div role="dialog" aria-modal="true" aria-hidden="true" style="position:fixed;left:8px;top:8px;width:300px;height:200px">' +
      '<button>Dormant action</button></div><button>Keep me</button>');
  assert.equal(actual.public.modal_count, 0);
  const names = actual.public.items.map(item => item.name);
  assert.ok(!names.includes('Dormant action'), JSON.stringify(names));
});

test('a visible dialog is still counted and its controls come first', async () => {
  const actual = await runSnapshotPage(
    '<div role="dialog" aria-modal="true" style="position:fixed;left:8px;top:8px;width:300px;height:200px">' +
      '<button>Save changes</button></div><button>Background action</button>');
  assert.equal(actual.public.modal_count, 1);
  assert.equal(actual.public.items[0].name, 'Save changes');
  assert.equal(actual.public.items[0].in_modal, true);
  assert.equal(actual.public.modal_items, 1);
  assert.equal(actual.public.modal_first, true);
});

test('an offscreen dialog cannot exhaust the scan budget ahead of the page', async () => {
  const filler = Array.from({ length: 5000 }, (_, index) => `<button>Offscreen ${index}</button>`).join('');
  const actual = await runSnapshotPage(
    `<div role="dialog" aria-modal="true" style="position:fixed;left:-10000px;top:-10000px;width:600px;height:400px">${filler}</div>` +
    '<button>Keep me</button>', { max_scan_nodes: 4000, max_items: 10 });
  assert.equal(actual.public.modal_count, 0);
  const names = actual.public.items.map(item => item.name);
  assert.ok(names.includes('Keep me'), JSON.stringify(names));
  assert.ok(!actual.public.search_budget_exhausted, JSON.stringify(actual.public.incomplete_reasons));
});

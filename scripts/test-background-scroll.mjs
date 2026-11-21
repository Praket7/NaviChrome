import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../crates/navichrome-runtime/src/shared_page/background_scroll.js', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.NAVICHROME_CHROME ? { executablePath: process.env.NAVICHROME_CHROME } : { channel: 'chrome' }) }); });
after(async () => { await browser?.close(); });

async function run(html, { target = null, point = null, deltaX = 0, deltaY = 0 }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.setContent(html);
    return await page.evaluate(({ source, target, point, deltaX, deltaY }) => {
      const fn = new Function(`return (${source})`)();
      return fn(typeof target === 'string' ? document.querySelector(target) : target, deltaX, deltaY, point);
    }, { source, target, point, deltaX, deltaY });
  } finally { await page.close(); }
}

test('scroll without a semantic target moves the nested editor under the viewport point', async () => {
  const result = await run('<style>body{margin:0}.editor-scroll{height:260px;width:500px;overflow:auto;margin:100px auto}.page{height:1200px}</style><div class="editor-scroll"><div class="page" id="page">Document canvas</div></div>', { point: { x: 450, y: 200 }, deltaY: 300 });
  assert.equal(result.status, 'verified');
  assert.equal(result.target.id, 'page');
  assert.equal(result.scroller.class_name, 'editor-scroll');
  assert.ok(result.scroller.after > result.scroller.before);
  assert.equal(result.root.after.y, result.root.before.y);
});

test('viewport-center fallback scrolls the root when no nested scroller owns the point', async () => {
  const result = await run('<style>body{height:2400px}</style><main id="target">Page</main>', { deltaY: 240 });
  assert.equal(result.status, 'verified');
  assert.equal(result.scroller.kind, 'root');
  assert.ok(result.root.after.y > result.root.before.y);
});

test('semantic scroll target walks up to its nearest scrollable ancestor', async () => {
  const result = await run('<style>.outer{height:220px;overflow:auto}.inner{height:900px}</style><div class="outer"><div class="inner" id="target">target</div></div>', { target: '#target', deltaY: 180 });
  assert.equal(result.status, 'verified');
  assert.equal(result.scroller.class_name, 'outer');
  assert.equal(result.delta.y, 180);
});

test('a native semantic reference is re-resolved by exact observed identity', async () => {
  const result = await run('<style>.outer{height:220px;overflow:auto}.inner{height:900px}</style><div class="outer"><div class="inner" id="target" role="region" aria-label="Document page">target</div></div>', {
    target: { id: 'target', tag: 'div', role: 'region', name: 'Document page', href: null }, deltaY: 180,
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.target.id, 'target');
  assert.equal(result.scroller.class_name, 'outer');
});

test('a changed semantic target is refused before scrolling', async () => {
  const result = await run('<div id="target" aria-label="Different page">page</div>', {
    target: { id: 'target', tag: 'div', role: '', name: 'Original page', href: null }, deltaY: 180,
  });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason_code, 'stale_scroll_target');
});

test('a point inside a frame never falls back to scrolling the outer page', async () => {
  const result = await run('<style>body{height:2400px}iframe{width:500px;height:300px}</style><iframe srcdoc="<div style=\'height:1600px\'>frame content</div>"></iframe>', {
    point: { x: 400, y: 200 }, deltaY: 180,
  });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason_code, 'frame_scroll_requires_fresh_frame_reference');
  assert.equal(result.dispatch_may_have_occurred, false);
});

test('scroll reports inconclusive when the target cannot move on the requested axis', async () => {
  const result = await run('<div id="target" style="height:30px">fixed</div>', { target: '#target', deltaY: 120 });
  assert.equal(result.status, 'not_dispatched');
  assert.equal(result.reason_code, 'no_scrollable_target');
  assert.equal(result.dispatch_may_have_occurred, false);
});

test('scroll verification requires movement in the requested direction', async () => {
  const result = await run('<style>.editor-scroll{height:200px;overflow:auto}.page{height:1200px}</style><div class="editor-scroll"><div class="page" id="page">Document canvas</div></div>', { target: '#page', deltaY: -300 });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.reason_code, 'scroll_offset_unchanged');
  assert.equal(result.dispatch_acknowledged, true);
  assert.equal(result.dispatch_may_have_occurred, true);
});

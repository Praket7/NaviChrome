import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(
  new URL('../crates/navichrome-browser/src/observe.rs', import.meta.url),
  'utf8',
);

function extractionScript(config) {
  const functionStart = source.indexOf('fn extraction_page_script');
  assert.ok(functionStart >= 0, 'extraction_page_script must exist');
  const start = source.indexOf('r#"', functionStart);
  const end = source.indexOf('"#,', start);
  assert.ok(start >= 0 && end > start, 'extraction script raw string must be present');
  const raw = source
    .slice(start + 3, end)
    .replaceAll('{{', '{')
    .replaceAll('}}', '}');
  assert.ok(raw.includes('{config}'), 'extraction script config placeholder must be present');
  return raw.replace('{config}', JSON.stringify(config));
}

const config = {
  container: '#list',
  record: '.row',
  fields: { id: '.id', name: '.name', value: '.value' },
  account: ['#account', 'live-test'],
  terminal: null,
  expand: null,
  maxRecords: 5000,
  maxScanNodes: 65536,
  maxTextChars: 100,
  maxBytes: 8192,
};

const rowCount = 1600;
const html = `<!doctype html><style>#list{height:400px;overflow:auto}.row{display:block}</style>` +
  `<div id="account">live-test</div>` +
  `<div id="list">${Array.from({ length: rowCount }, (_, index) =>
    `<div class="row"><span class="id">id-${index}</span><span class="name">Name ${index}</span><span class="value">${'x'.repeat(80)}</span></div>`,
  ).join('')}</div>`;

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NAVICHROME_CHROME
      ? { executablePath: process.env.NAVICHROME_CHROME }
      : { channel: 'chrome' }),
  });
});
after(async () => {
  await browser?.close();
});

test('extraction respects the byte cap and the linear trim beats repeated serialization', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const result = await page.evaluate(extractionScript(config));

    assert.ok(Array.isArray(result.items), 'extraction must return items');
    assert.ok(result.items.length > 0, 'extraction must retain at least one row');
    assert.ok(result.items.length < rowCount, 'extraction must trim the oversized result');
    assert.equal(result.limited, true, 'extraction must report the trim');
    assert.ok(
      Buffer.byteLength(JSON.stringify(result), 'utf8') <= config.maxBytes,
      `extraction exceeded the byte cap: ${Buffer.byteLength(JSON.stringify(result), 'utf8')}`,
    );
    assert.equal(result.items[0].id, 'id-0', 'extraction must keep the first row');

    const benchmark = await page.evaluate(({ items, maxBytes }) => {
      const encoder = new TextEncoder();
      const envelope = rows => ({
        items: rows,
        end: false,
        before: 0,
        after: 0,
        account: true,
        limited: false,
        missingFields: [],
        clipped: false,
        scrollSettled: true,
      });
      const legacyTrim = rows => {
        const next = envelope([...rows]);
        while (encoder.encode(JSON.stringify(next)).length > maxBytes && next.items.length) {
          next.items.pop();
          next.limited = true;
        }
        return next;
      };
      const linearTrim = rows => {
        const next = envelope([...rows]);
        const sizes = rows.map(item => encoder.encode(JSON.stringify(item)).length + 1);
        const baseBytes = encoder.encode(JSON.stringify({ ...next, items: [] })).length;
        let totalBytes = baseBytes + sizes.reduce((sum, size) => sum + size, 0) +
          Math.max(0, sizes.length - 1);
        while (totalBytes > maxBytes && next.items.length) {
          next.items.pop();
          const removedSize = sizes.pop();
          totalBytes -= removedSize + (next.items.length ? 1 : 0);
          next.limited = true;
        }
        return next;
      };
      const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      const measure = fn => {
        const samples = [];
        for (let index = 0; index < 7; index += 1) {
          const started = performance.now();
          fn(items);
          samples.push(performance.now() - started);
        }
        return median(samples);
      };

      // Warm both shapes before measuring.
      legacyTrim(items);
      linearTrim(items);
      const legacyMs = measure(legacyTrim);
      const linearMs = measure(linearTrim);
      return {
        legacyMs,
        linearMs,
        legacyCount: legacyTrim(items).items.length,
        linearCount: linearTrim(items).items.length,
      };
    }, {
      items: Array.from({ length: rowCount }, (_, index) => ({
        id: `id-${index}`,
        name: `Name ${index}`,
        value: 'x'.repeat(80),
      })),
      maxBytes: config.maxBytes,
    });

    assert.equal(benchmark.linearCount, benchmark.legacyCount, 'trim algorithms must retain the same rows');
    assert.ok(benchmark.legacyCount > 0 && benchmark.legacyCount < rowCount, 'benchmark must exercise trimming');
    console.log(JSON.stringify({
      rows: rowCount,
      retained: result.items.length,
      trimRetained: benchmark.linearCount,
      legacyTrimMs: Number(benchmark.legacyMs.toFixed(2)),
      linearTrimMs: Number(benchmark.linearMs.toFixed(2)),
      speedup: Number((benchmark.legacyMs / benchmark.linearMs).toFixed(1)),
    }));
    assert.ok(
      benchmark.linearMs < benchmark.legacyMs,
      `linear trim (${benchmark.linearMs.toFixed(2)}ms) did not beat repeated serialization (${benchmark.legacyMs.toFixed(2)}ms)`,
    );
  } finally {
    await page.close();
  }
});

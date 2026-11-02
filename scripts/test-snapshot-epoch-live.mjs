import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const runtime = readFileSync(
  new URL('../crates/controlla-runtime/src/mcp/v2.rs', import.meta.url),
  'utf8',
);
const snapshotSource = readFileSync(
  new URL('../crates/controlla-runtime/src/shared_page/snapshot.js', import.meta.url),
  'utf8',
);

const epochStart = runtime.indexOf('const SNAPSHOT_EPOCH_EXPRESSION: &str = r#"');
assert.ok(epochStart >= 0, 'SNAPSHOT_EPOCH_EXPRESSION must be present');
const expressionStart = epochStart + 'const SNAPSHOT_EPOCH_EXPRESSION: &str = r#"'.length;
const expressionEnd = runtime.indexOf('"#;', expressionStart);
assert.ok(expressionEnd > expressionStart, 'epoch expression must be terminated');
const epochExpression = runtime.slice(expressionStart, expressionEnd);

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CONTROLLA_CHROME
      ? { executablePath: process.env.CONTROLLA_CHROME }
      : { channel: 'chrome' }),
  });
});
after(async () => {
  await browser?.close();
});

test('the Rust epoch reader observes the production snapshot mutation clock', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button>One</button>');
    const config = {
      selector: 'body',
      token: 'epoch-test',
      max_items: 20,
      max_text_chars: 0,
      max_bytes: 8192,
      max_scan_nodes: 1000,
    };
    await page.evaluate(({ source, config }) => {
      return new Function(`return (${source})`)()(config);
    }, { source: snapshotSource, config });
    const before = await page.evaluate(epochExpression);
    assert.equal(typeof before.semantic_revision, 'number');
    assert.ok(before.focus !== undefined);
    assert.ok(before.selection !== undefined);
    assert.ok(before.viewport !== undefined);

    await page.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Later';
      document.body.append(button);
    });
    await page.waitForTimeout(30);
    const afterEpoch = await page.evaluate(epochExpression);

    assert.ok(
      afterEpoch.semantic_revision > before.semantic_revision,
      `mutation did not advance the epoch: ${before.semantic_revision} -> ${afterEpoch.semantic_revision}`,
    );
    assert.equal(afterEpoch.focus, before.focus);
    assert.equal(afterEpoch.selection, before.selection);
    console.log(JSON.stringify({
      before: before.semantic_revision,
      after: afterEpoch.semantic_revision,
    }));
  } finally {
    await page.close();
  }
});

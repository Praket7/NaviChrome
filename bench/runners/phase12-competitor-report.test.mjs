import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReport } from './phase12-competitor-report.mjs';

const adapters = ['controlla', 'stagehand', 'playwright-mcp', 'browser-use', 'chrome-devtools-mcp', 'agent-browser'];

function pilot(overrides = {}) {
  return {
    status: 'completed',
    release_claim_eligible: false,
    environment: { machine: 'test-arm64', chrome_version: 'Chrome 1', model: 'model', controlla_binary_sha256: 'a'.repeat(64) },
    task: { id: 'read-only', url: 'https://example.test/' },
    pairs: Array.from({ length: 3 }, (_, index) => ({
      replicate: index + 1,
      ...Object.fromEntries(adapters.map((adapter) => [adapter, {
        prompt_hash: `${adapter}-prompt`,
        independently_verified_success: true,
        process_spawn_to_independent_verification_ms: 1000 + index,
        successful_browser_tool_calls: 1,
        input_tokens: 100,
      }])),
    })),
    ...overrides,
  };
}

test('a complete six-adapter pilot still cannot unlock a broad claim', () => {
  const report = buildReport(pilot(), { sourcePath: 'pilot.json' });
  assert.equal(report.claimEligible, false);
  assert.equal(Object.keys(report.summary).length, 6);
  assert.ok(report.claimReasons.includes('the pilot scope is one read-only task; the full Phase 12 workload matrix was not run'));
  assert.equal(report.pilot_leader, 'controlla-v3');
});

test('a missing adapter blocks the matched set', () => {
  const incomplete = pilot();
  for (const pair of incomplete.pairs) delete pair['browser-use'];
  const report = buildReport(incomplete, { sourcePath: 'pilot.json' });
  assert.equal(report.claimEligible, false);
  assert.equal(Object.keys(report.summary).length, 5);
  assert.ok(report.claimReasons.some((reason) => reason.includes('six-adapter matched set is incomplete')));
});

test('a partial pilot is rejected', () => {
  const report = buildReport(pilot({ status: 'running', pairs: [] }), { sourcePath: 'pilot.json' });
  assert.ok(report.claimReasons.includes('pilot is not completed'));
  assert.equal(report.pairs, 0);
});

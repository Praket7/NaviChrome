import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateWorkloadManifest } from './phase12-workloads.mjs';

const manifest = JSON.parse(await readFile(new URL('../tasks/phase12-workloads.json', import.meta.url), 'utf8'));

test('phase12 workload manifest is bounded and executable', () => {
  const result = validateWorkloadManifest(manifest);
  assert.equal(result.pass, true, result.failures.join('\n'));
  assert.ok(result.tasks.length >= 5);
  assert.equal(new Set(result.tasks.map((task) => task.id)).size, result.tasks.length);
});

test('phase12 workload manifest rejects duplicate and malformed rows', () => {
  const result = validateWorkloadManifest({
    schema: 'phase12-workloads-v1',
    tasks: [
      { id: 'valid-row', category: 'typing', capability: 'x', fixture: 'typing' },
      { id: 'valid-row', category: 'typing', capability: 'x', fixture: 'typing' },
      { id: 'Bad ID', category: '', capability: 'x' },
    ],
  });
  assert.equal(result.pass, false);
  assert.match(result.failures.join('\n'), /duplicate task id/);
  assert.match(result.failures.join('\n'), /invalid task id/);
});

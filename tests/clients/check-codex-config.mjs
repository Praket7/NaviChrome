import assert from 'node:assert/strict';
import path from 'node:path';
import { generateCodexCommand } from '../../integrations/codex-config.mjs';

const binary = '/opt/navichrome/navichrome';
const state = '/var/lib/navichrome';
const command = generateCodexCommand(binary, state);
assert.equal(
  command,
  `codex mcp add navichrome --env 'NAVICHROME_STATE_DIR=${path.join(state, 'codex')}' -- '/opt/navichrome/navichrome' mcp\ncodex mcp get navichrome --json`,
);
assert.match(command, /^codex mcp add navichrome --env /);
assert.match(command, / -- '\/opt\/navichrome\/navichrome' mcp$/m);
assert.match(command, /codex mcp get navichrome --json$/m);
const quoted = generateCodexCommand("/tmp/agent's $(touch nope)/navichrome", '/tmp/state with spaces');
assert.ok(quoted.includes("'/tmp/agent'\"'\"'s $(touch nope)/navichrome'"));
assert.ok(quoted.includes(`'NAVICHROME_STATE_DIR=${path.join('/tmp/state with spaces', 'codex')}'`));
assert.throws(() => generateCodexCommand('navichrome', state), /absolute paths/);
console.log('Codex CLI stdio registration is isolated, shell-quoted, and matches current codex mcp add syntax.');

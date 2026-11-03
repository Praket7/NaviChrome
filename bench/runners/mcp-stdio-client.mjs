// Minimal MCP stdio client for benchmark and live-qualification runners.
//
// It deliberately exposes only initialize + tools/call. The harnesses that use
// it are testing the public six-tool surface, not the transport.
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 600_000;

export function parseToolResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (result.structured_content !== undefined) return result.structured_content;
    if (Array.isArray(result.content)) {
      const text = result.content.map((part) => part?.text ?? '').join('');
      if (text) {
        try { return JSON.parse(text); } catch { return { raw: text }; }
      }
    }
  }
  return result;
}

export function createMcpStdioClient({
  binary,
  stateDir,
  env = process.env,
  initializeTimeoutMs = 60_000,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  name = 'phase12-live',
}) {
  const child = spawn(binary, ['mcp'], {
    env: { ...env, ...(stateDir ? { NAVICHROME_STATE_DIR: stateDir } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-32_000);
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  child.on('error', (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  });
  child.on('close', (code) => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP server exited ${code}${stderr ? `: ${stderr.slice(-1200)}` : ''}`));
    }
    pending.clear();
  });

  function rpc(method, params, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(`MCP server is closed${stderr ? `: ${stderr.slice(-1200)}` : ''}`));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function initialize() {
    const result = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name, version: '1' },
    }, initializeTimeoutMs);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return result;
  }

  async function call(tool, args, timeoutMs = defaultTimeoutMs) {
    const result = await rpc('tools/call', { name: tool, arguments: args }, timeoutMs);
    if (result?.isError || result?.is_error) {
      throw new Error(`tool ${tool} failed: ${JSON.stringify(result).slice(0, 2000)}`);
    }
    return parseToolResult(result);
  }

  async function close() {
    if (closed) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        resolve();
      }, 1500);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!closed) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  return {
    initialize,
    call,
    close,
    get stderr() { return stderr; },
    get pid() { return child.pid; },
  };
}

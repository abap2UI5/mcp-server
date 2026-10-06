// The server lives exactly as long as its client (server.mjs shutdown).
//
// It used to stop only on SIGINT/SIGTERM. An MCP client ends a stdio session
// by closing the pipe, and under npx a SIGTERM reaches npm rather than this
// process - so the server, its Chromium and the express backend outlived
// every session, and the next session's `backend start` met a stale backend
// on the port. Sibling-free: every checkout env var points nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOPE = '/nonexistent-a2ui5-lifecycle';

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SAMPLES_CONTROLS_HOME: NOPE, SAMPLES_HOME: NOPE, SAMPLES_STACK_HOME: NOPE, A2UI5_HOME: NOPE,
      AI_VIEW_CHECK_HOME: NOPE, APP_TEMPLATE_HOME: NOPE, DOCS_HOME: NOPE, A2UI5_MCP_REMOTE: '0',
    },
  });
  let out = '';
  const initialized = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (/"id":1\b/.test(out)) resolve();
    });
  });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lifecycle', version: '0' } },
  }) + '\n');
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, initialized, exited };
}

const within = (p, ms, what) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)),
]);

test('the server exits when the client closes stdin', async () => {
  const { child, initialized, exited } = startServer();
  try {
    await within(initialized, 15000, 'initialize');
    child.stdin.end();
    const { code } = await within(exited, 10000, 'exit after stdin closed');
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the server exits when the client stops reading its stdout', async () => {
  const { child, initialized, exited } = startServer();
  try {
    await within(initialized, 15000, 'initialize');
    // the reading end is gone, stdin stays open: the next answer hits EPIPE
    child.stdout.destroy();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const { code } = await within(exited, 10000, 'exit after stdout broke');
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the server exits on SIGHUP, like SIGINT and SIGTERM', { skip: process.platform === 'win32' && 'no SIGHUP on Windows' }, async () => {
  const { child, initialized, exited } = startServer();
  try {
    await within(initialized, 15000, 'initialize');
    child.kill('SIGHUP');
    const { code } = await within(exited, 10000, 'exit after SIGHUP');
    assert.equal(code, 0, 'a handled SIGHUP is a clean shutdown, not a kill');
  } finally {
    child.kill('SIGKILL');
  }
});

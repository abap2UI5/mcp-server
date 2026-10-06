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
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOPE = '/nonexistent-a2ui5-lifecycle';

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SAMPLES_CONTROLS_HOME: NOPE, SAMPLES_HOME: NOPE, SAMPLES_STACK_HOME: NOPE, A2UI5_HOME: NOPE,
      AI_VIEW_CHECK_HOME: NOPE, APP_TEMPLATE_HOME: NOPE, DOCS_HOME: NOPE, A2UI5_MCP_REMOTE: '0',
      ...extraEnv,
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

/* A client that goes away while `backend start` is still booting the
 * backend: the child is only tracked once it says "Listening on", so the
 * shutdown's stop found nothing to kill and the server exited with the child
 * still booting - which then listened, an orphan holding the port. A fake
 * checkout whose express.mjs listens after a delay. */
test('a shutdown during a backend start leaves no backend behind', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lifecycle-'));
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.mkdirSync(path.join(a2, 'node', 'output'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'output', 'init.mjs'), '');
  const pidFile = path.join(base, 'backend.pid');
  fs.writeFileSync(
    path.join(a2, 'node', 'srv', 'express.mjs'),
    `import http from 'http';
     import fs from 'fs';
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, () => console.log('Listening on ' + process.env.PORT)), 1500);`,
  );
  const PORT = 3925;
  const { child, initialized, exited } = startServer({ A2UI5_HOME: a2, A2UI5_MCP_PORT: String(PORT), A2UI5_MCP_BACKEND: '' });
  let pid = null;
  try {
    await within(initialized, 15000, 'initialize');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backend', arguments: { action: 'start' } } }) + '\n');
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    child.stdin.end(); // the client goes away mid-start
    await within(exited, 10000, 'exit after stdin closed');
    await new Promise((r) => setTimeout(r, 2000)); // past the moment it would have listened
    const listening = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 500 }, (r) => {
        r.destroy();
        resolve(true);
      }).on('error', () => resolve(false));
    });
    assert.equal(listening, false, 'the backend whose start the shutdown cut short listened anyway, as an orphan');
  } finally {
    child.kill('SIGKILL');
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone, as it should be
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

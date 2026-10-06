// Client-side cancellation reaches the spawned child: when the client sends
// notifications/cancelled for an in-flight tools/call, the SDK aborts the
// request's signal, and the server kills the child's process tree instead of
// letting a build keep transpiling under a request nobody is waiting for.
// Sibling-free: fake repos with a scripted e2e-build that heartbeats a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a cancelled build_backend kills the build child', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-cancel-'));
  const demokit = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(demokit, 'scripts'), { recursive: true });
  const beat = path.join(base, 'heartbeat.txt');
  // a build that heartbeats every 150ms for up to 20s - killed, the file stops
  fs.writeFileSync(
    path.join(demokit, 'scripts', 'e2e-build.mjs'),
    `import fs from 'fs';
     let n = 0;
     const iv = setInterval(() => {
       fs.appendFileSync(${JSON.stringify(beat)}, 'beat ' + ++n + '\\n');
       console.log('building step ' + n);
       if (n >= 130) { clearInterval(iv); process.exit(0); }
     }, 150);`,
  );
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');

  const p = spawn('node', [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      AI_DEMOKIT_HOME: demokit,
      // the older var on purpose; a surrounding SAMPLES_CONTROLS_HOME would
      // outrank it (newest-first, first SET wins), so it is cleared
      SAMPLES_CONTROLS_HOME: '',
      /* the build log goes to the test's own dir, not the user's
       * <tmp>/abap2ui5-mcp-screenshots (a live server's build_log reads
       * it), and no app-template mirror is fetched into the user's cache */
      A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'),
      A2UI5_MCP_REMOTE: '0',
      A2UI5_HOME: a2,
    },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 20000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = buf
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .find(pred);
        if (hit) {
          clearInterval(iv);
          res(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error(`timeout; got: ${buf.slice(-500)}`));
        }
      }, 50);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cancel', version: '0' } } });
    await until((m) => m.id === 1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'build_backend', arguments: { mode: 'full' }, _meta: { progressToken: 'tok-c' } } });
    // the build is demonstrably running before it is cancelled
    await until((m) => m.method === 'notifications/progress');
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user changed their mind' } });
    // the tree dies: the heartbeat stops within a moment of the cancel
    await sleep(700);
    const size1 = fs.statSync(beat).size;
    await sleep(700);
    const size2 = fs.statSync(beat).size;
    assert.equal(size2, size1, 'the build child kept writing after the client cancelled the request');
  } finally {
    p.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* A build_backend call that the in-flight build of another mode refuses must
 * refuse BEFORE it stops the running backend: it used to stop it first, so
 * the call that built nothing still took the app down. */
test('a build_backend refused for a build in progress leaves the backend running', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-buildconflict-'));
  const demokit = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(demokit, 'scripts'), { recursive: true });
  // a full build that runs for up to 20 s
  fs.writeFileSync(
    path.join(demokit, 'scripts', 'e2e-build.mjs'),
    `let n = 0;
     const iv = setInterval(() => {
       console.log('building step ' + ++n);
       if (n >= 130) { clearInterval(iv); process.exit(0); }
     }, 150);`,
  );
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.mkdirSync(path.join(a2, 'node', 'output'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'output', 'init.mjs'), '');
  fs.writeFileSync(
    path.join(a2, 'node', 'srv', 'express.mjs'),
    `import http from 'http';
     http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, () => console.log('Listening on ' + process.env.PORT));`,
  );

  const p = spawn('node', [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      AI_DEMOKIT_HOME: demokit,
      SAMPLES_CONTROLS_HOME: '',
      A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'),
      A2UI5_MCP_REMOTE: '0',
      A2UI5_MCP_BACKEND: '',
      A2UI5_MCP_PORT: '3921',
      A2UI5_HOME: a2,
    },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 20000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = buf.split('\n').filter(Boolean).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        }).filter(Boolean).find(pred);
        if (hit) {
          clearInterval(iv);
          res(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error(`timeout; got: ${buf.slice(-500)}`));
        }
      }, 50);
    });
  const call = async (id, name, args, extra = {}) => {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...extra } });
    return until((m) => m.id === id);
  };
  const body = (r) => r.result.content[0].text;

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'conflict', version: '0' } } });
    await until((m) => m.id === 1);
    // the full build is running ...
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'build_backend', arguments: { mode: 'full' }, _meta: { progressToken: 'tok-f' } } });
    await until((m) => m.method === 'notifications/progress');
    // ... and the backend is (re)started beside it
    const started = await call(3, 'backend', { action: 'start' });
    assert.equal(JSON.parse(body(started)).running, true, body(started));
    // a build of another mode is refused ...
    const refused = await call(4, 'build_backend', { mode: 'prebuilt' });
    assert.equal(refused.result.isError, true);
    assert.match(body(refused), /build in progress \(full\)/);
    // ... and has not stopped the backend
    const status = await call(5, 'backend', { action: 'status' });
    assert.equal(JSON.parse(body(status)).running, true, `the refused build stopped the backend: ${body(status)}`);
  } finally {
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'test over' } });
    p.stdin.end();
    await new Promise((r) => {
      p.on('exit', r);
      setTimeout(() => {
        p.kill();
        r();
      }, 5000);
    });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Lifecycle of the express backend child (lib/runtime.mjs): the stale-exit
// guard and the single-flight start. Sibling-free - the env vars point at a
// fake abap2UI5 checkout whose express.mjs is a tiny real HTTP server, so the
// tests exercise the actual spawn/listen/kill path without a transpiled
// backend. A file of its own because the port is fixed at module load
// (A2UI5_MCP_PORT), so it has to be set before lib/runtime.mjs is imported -
// node --test runs each file in its own process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 3917; // out of the way of the default 3000 and anything parallel

// A stand-in express.mjs: listens on PORT, says "Listening on" the way the
// real shim does, and on SIGTERM frees the port at once but keeps the PROCESS
// alive for a moment - which is exactly the window the stale-exit bug needed:
// a killed child whose exit event arrives after the next backend is live.
const FAKE_EXPRESS = `
import http from 'http';
import fs from 'fs';
const s = http.createServer((req, res) => res.end('ok'));
const listen = () => s.listen(process.env.PORT, () => {
  if (process.env.BOOT_MARKER) fs.appendFileSync(process.env.BOOT_MARKER, process.pid + '\\n');
  console.log('Listening on ' + process.env.PORT);
});
s.on('error', (e) => {
  if (e.code === 'EADDRINUSE') setTimeout(listen, 100);
  else throw e;
});
listen();
process.on('SIGTERM', () => {
  s.close();
  setTimeout(() => process.exit(0), 1000);
});
`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-backend-'));
const a2 = path.join(base, 'abap2UI5');
fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
fs.mkdirSync(path.join(a2, 'node', 'output'), { recursive: true });
fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), FAKE_EXPRESS);
fs.writeFileSync(path.join(a2, 'node', 'output', 'init.mjs'), ''); // backendBuilt()
const marker = path.join(base, 'boots.txt');

process.env.A2UI5_MCP_PORT = String(PORT);
process.env.A2UI5_HOME = a2;
process.env.BOOT_MARKER = marker;

const { startBackend, stopBackend, backendStatus } = await import('../lib/runtime.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = () =>
  new Promise((resolve) => {
    const req = http.get({ port: PORT, path: '/', timeout: 500 }, (r) => {
      r.destroy();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });

test('two concurrent starts spawn one backend, not two on one port', async () => {
  fs.writeFileSync(marker, '');
  const [a, b] = await Promise.all([startBackend(), startBackend()]);
  assert.equal(a.running, true);
  assert.equal(b.running, true);
  const boots = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean);
  assert.equal(boots.length, 1, `expected one spawned backend, saw pids: ${boots.join(', ')}`);
  await stopBackend();
});

test('a stale child exiting late does not orphan the live backend', async () => {
  await startBackend();
  assert.equal(backendStatus().running, true);
  // kill the first child; its listener closes now, its exit event comes later
  await stopBackend();
  await sleep(150);
  // a NEW backend is live before the old child's process has fully exited
  await startBackend();
  assert.equal(backendStatus().running, true);
  // now the old child's exit event lands - it must not clear the live slot
  await sleep(1400);
  assert.equal(backendStatus().running, true,
    'the stale exit cleared the live server reference (the orphan bug)');
  // and because the reference survived, stop still reaches the live child
  await stopBackend();
  assert.equal(backendStatus().running, false);
  await sleep(1400); // let the killed child free the port
  assert.equal(await portOpen(), false, 'the backend survived stopBackend as an orphan');
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

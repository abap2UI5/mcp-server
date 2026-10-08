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
let stopping = false; // a SIGTERM before the delayed listen: never listens
// HOST as the framework's express.mjs reads it: unset binds every interface
const listen = () => !stopping && s.listen(process.env.PORT, process.env.HOST, () => {
  if (process.env.BOOT_MARKER) fs.appendFileSync(process.env.BOOT_MARKER, process.pid + '\\n');
  if (process.env.ADDRESS_MARKER) fs.writeFileSync(process.env.ADDRESS_MARKER, s.address().address);
  console.log('Listening on ' + process.env.PORT);
});
s.on('error', (e) => {
  if (e.code === 'EADDRINUSE') setTimeout(listen, 100);
  else throw e;
});
if (process.env.ENV_MARKER) fs.writeFileSync(process.env.ENV_MARKER, JSON.stringify({ allowedHosts: process.env.ALLOWED_HOSTS ?? null, port: process.env.PORT }));
if (process.env.SAY_LISTENING_AND_EXIT) {
  // express 5's app.listen over a port in use: the callback runs with the
  // error, the host prints its line, and the process ends with nothing bound
  console.log('Listening on ' + process.env.PORT);
  process.exit(0);
}
setTimeout(listen, Number(process.env.LISTEN_DELAY_MS || 0));
process.on('SIGTERM', () => {
  stopping = true;
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

const { startBackend, stopBackend, backendStatus, backendEnv } = await import('../lib/runtime.mjs');

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

/* The framework's node/srv/express.mjs binds every interface without HOST,
 * so a checkout's dev backend - any deployed app, run by whoever reaches the
 * port - was reachable from the LAN; the npm host binds 127.0.0.1. A HOST the
 * user's environment exports (a host name) must not decide it either. */
test('the checkout backend is started on the loopback interface only', async () => {
  const address = path.join(base, 'address.txt');
  process.env.ADDRESS_MARKER = address;
  process.env.HOST = '0.0.0.0';
  try {
    await startBackend();
    assert.equal(fs.readFileSync(address, 'utf8'), '127.0.0.1');
  } finally {
    await stopBackend();
    delete process.env.ADDRESS_MARKER;
    delete process.env.HOST;
    await sleep(1400); // let the killed child free the port
  }
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

/* A node that cannot be spawned (the program gone - a node upgrade under a
 * running server): spawn emits 'error' and no 'exit', which used to be an
 * uncaught exception and a 30 s wait for a start that had already failed.
 * The backend is spawned with this server's own node (process.execPath), so
 * an empty PATH - a desktop client starts its servers with a minimal one -
 * no longer is that case. */
test('a backend that cannot be spawned fails the start at once, with the reason', async () => {
  const savedPath = process.env.PATH;
  const savedExec = process.execPath;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-nopath-'));
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    process.env.PATH = empty;
    const st = await startBackend();
    assert.equal(st.running, true, 'no node on the PATH: the server\'s own node starts the backend');
    await stopBackend();
    await sleep(1400); // let the killed child free the port
    process.execPath = path.join(empty, 'no-such-node');
    const t0 = Date.now();
    await assert.rejects(startBackend(), /could not be started \(.*no-such-node\).*ENOENT/);
    assert.ok(Date.now() - t0 < 10000, `the start failed only after ${Date.now() - t0} ms`);
    assert.equal(uncaught.length, 0, `uncaught: ${uncaught.map(String).join(', ')}`);
    assert.equal(backendStatus().running, false);
  } finally {
    process.execPath = savedExec;
    process.env.PATH = savedPath;
    process.off('uncaughtException', onUncaught);
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

/* ALLOWED_HOSTS=* switches the framework express.mjs' DNS-rebinding guard
 * off; one the user's shell exports must not reach the dev backend. */
test('the backend child never inherits ALLOWED_HOSTS', async () => {
  const envMarker = path.join(base, 'env.json');
  process.env.ENV_MARKER = envMarker;
  process.env.ALLOWED_HOSTS = '*';
  try {
    await startBackend();
    assert.deepEqual(JSON.parse(fs.readFileSync(envMarker, 'utf8')), { allowedHosts: null, port: String(PORT) });
  } finally {
    await stopBackend();
    delete process.env.ENV_MARKER;
    delete process.env.ALLOWED_HOSTS;
    await sleep(1400);
  }
  assert.deepEqual(backendEnv({ allowed_hosts: '*', Allowed_Hosts: 'x', KEEP: '1', PORT: '1' }, { port: 9, host: '127.0.0.1' }),
    { KEEP: '1', PORT: '9', HOST: '127.0.0.1' }, 'any spelling - Windows reads environment names case-insensitively');
});

/* Express 5 calls app.listen's callback with the bind error: a backend over a
 * port somebody else holds said "Listening on" and exited, and the port wait
 * was answered by the other process - the app tools then talked to it. */
test('a backend that exits right after "Listening on" fails the start; the port\'s owner is not taken for it', async () => {
  const blocker = http.createServer((req, res) => setTimeout(() => res.end('somebody else'), 400));
  await new Promise((r) => blocker.listen(PORT, '127.0.0.1', r));
  process.env.SAY_LISTENING_AND_EXIT = '1';
  try {
    await assert.rejects(startBackend(), /exited \(0\) right after it said it was listening - port \d+ is answered by another process/);
    assert.equal(backendStatus().running, false);
  } finally {
    delete process.env.SAY_LISTENING_AND_EXIT;
    await new Promise((r) => blocker.close(r));
  }
});

/* A stop during a start: the child is `server` only once it listens, so
 * stopBackend() had nothing to kill - the server's shutdown exited with the
 * child still booting (an orphan holding the port), and `backend stop`
 * answered "not running" while the start went on to listen. Every stop
 * reaches it now, and the start says it was stopped. */
test('a stop kills a backend that has not listened yet, and the start says so', async () => {
  process.env.LISTEN_DELAY_MS = '700';
  try {
    const start = startBackend();
    start.catch(() => {});
    await sleep(250); // spawned, not listening yet
    await stopBackend();
    await assert.rejects(start, /the backend start was stopped .* before it listened/);
    await sleep(900); // past the moment it would have listened
    assert.equal(await portOpen(), false, 'the backend whose start was cut short listened anyway, as an orphan');
    assert.equal(backendStatus().running, false);
  } finally {
    delete process.env.LISTEN_DELAY_MS;
    await stopBackend();
  }
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

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
// the test's switches, from a file beside this one: the backend child sees
// only the allowlisted environment (lib/runtime.mjs appChildEnv)
const K = (() => { try { return JSON.parse(fs.readFileSync(new URL('./knobs.json', import.meta.url), 'utf8')); } catch { return {}; } })();
const s = http.createServer((req, res) => res.end('ok'));
let stopping = false; // a SIGTERM before the delayed listen: never listens
// HOST as the framework's express.mjs reads it: unset binds every interface
const listen = () => !stopping && s.listen(process.env.PORT, process.env.HOST, () => {
  if (K.BOOT_MARKER) fs.appendFileSync(K.BOOT_MARKER, process.pid + '\\n');
  if (K.ADDRESS_MARKER) fs.writeFileSync(K.ADDRESS_MARKER, s.address().address);
  console.log('Listening on ' + process.env.PORT);
});
s.on('error', (e) => {
  if (e.code === 'EADDRINUSE') setTimeout(listen, 100);
  else throw e;
});
if (K.ENV_MARKER) fs.writeFileSync(K.ENV_MARKER, JSON.stringify({ allowedHosts: process.env.ALLOWED_HOSTS ?? null, port: process.env.PORT, env: process.env }));
if (K.SAY_LISTENING_AND_EXIT) {
  // express 5's app.listen over a port in use: the callback runs with the
  // error, the host prints its line, and the process ends with nothing bound
  // (EXIT_AFTER_MS: a boot that crashes a moment after it said so)
  console.log('Listening on ' + process.env.PORT);
  if (K.EXIT_AFTER_MS) setTimeout(() => process.exit(0), Number(K.EXIT_AFTER_MS));
  else process.exit(0);
}
setTimeout(listen, Number(K.LISTEN_DELAY_MS || 0));
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
const knobFile = path.join(a2, 'node', 'srv', 'knobs.json');
const knobs = {};
/* A switch of the fake backend's: written to knobs.json beside it, since the
 * child no longer inherits this process' environment wholesale. */
const setKnob = (k, v) => {
  knobs[k] = v;
  fs.writeFileSync(knobFile, JSON.stringify(knobs));
};
const clearKnob = (k) => {
  delete knobs[k];
  fs.writeFileSync(knobFile, JSON.stringify(knobs));
};
setKnob('BOOT_MARKER', marker);

const { startBackend, stopBackend, backendStatus, backendEnv, backendTiming, runApp, interactApp, browserOpen } = await import('../lib/runtime.mjs');

/* Turned down for the dozen fake backends this file starts: the liveness
 * wait (500 ms a start) and the port poll (300 ms a miss) are the start's,
 * not the fake's. The late-exit case below uses the value in force. */
backendTiming.livenessMs = 300; // 150 was too close under load: the late exit's event has to land inside it
backendTiming.portPollMs = 25;
const LIVENESS_MS = backendTiming.livenessMs;

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
/* Instead of a fixed sleep after every stop (1.4 s each, six of them): the
 * port is free as soon as the killed fake closed its listener, and its
 * process (which lingers a second after that, on purpose - see FAKE_EXPRESS)
 * is waited for by pid where a test needs its exit to have landed. */
const until = async (cond, what, ms = 5000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`${what} did not happen within ${ms} ms`);
    await sleep(20);
  }
};
const portFree = () => until(async () => !(await portOpen()), 'the port being freed');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const bootedPids = () => fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).map(Number);
const exited = async (pid) => {
  await until(() => !alive(pid), `pid ${pid} exiting`);
  await sleep(50); // its exit event in this process lands a moment after the process is gone
};

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
  setKnob('ADDRESS_MARKER', address);
  process.env.HOST = '0.0.0.0';
  try {
    await startBackend();
    assert.equal(fs.readFileSync(address, 'utf8'), '127.0.0.1');
  } finally {
    await stopBackend();
    clearKnob('ADDRESS_MARKER');
    delete process.env.HOST;
    await portFree();
  }
});

test('a stale child exiting late does not orphan the live backend', async () => {
  fs.writeFileSync(marker, '');
  await startBackend();
  assert.equal(backendStatus().running, true);
  const [old] = bootedPids();
  // kill the first child; its listener closes now, its exit event comes later
  await stopBackend();
  await portFree();
  assert.equal(alive(old), true, 'the fake lingers after it freed the port - the window the bug needs');
  // a NEW backend is live before the old child's process has fully exited
  await startBackend();
  assert.equal(backendStatus().running, true);
  // now the old child's exit event lands - it must not clear the live slot
  await exited(old);
  assert.equal(backendStatus().running, true,
    'the stale exit cleared the live server reference (the orphan bug)');
  // and because the reference survived, stop still reaches the live child
  const [, live] = bootedPids();
  await stopBackend();
  assert.equal(backendStatus().running, false);
  await exited(live);
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
    await portFree();
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
  setKnob('ENV_MARKER', envMarker);
  process.env.ALLOWED_HOSTS = '*';
  try {
    await startBackend();
    const seen = JSON.parse(fs.readFileSync(envMarker, 'utf8'));
    assert.deepEqual({ allowedHosts: seen.allowedHosts, port: seen.port }, { allowedHosts: null, port: String(PORT) });
  } finally {
    await stopBackend();
    clearKnob('ENV_MARKER');
    delete process.env.ALLOWED_HOSTS;
    await portFree();
  }
  assert.deepEqual(backendEnv({ allowed_hosts: '*', Allowed_Hosts: 'x', PATH: '/bin', PORT: '1' }, { port: 9, host: '127.0.0.1' }),
    { PATH: '/bin', PORT: '9', HOST: '127.0.0.1' }, 'any spelling - Windows reads environment names case-insensitively');
});

/* A child that boots or tests an app can reach process.env through
 * open-abap's @KERNEL escape; it gets an ALLOWLIST of the environment, so
 * neither the secrets this server defines (the GitHub token, the system-mode
 * SAP credentials) nor any the user's shell exports (cloud keys, npm tokens)
 * reach it - while what Node, the runtime and an app's outbound HTTP need
 * stays, in any spelling. */
test('a child that runs the app gets the allowlisted environment only', async () => {
  const { appChildEnv } = await import('../lib/runtime.mjs');
  const decoys = {
    GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh2', github_token: 'lower', NPM_TOKEN: 'npm', NODE_AUTH_TOKEN: 'na',
    AWS_SECRET_ACCESS_KEY: 'aws', AWS_ACCESS_KEY_ID: 'id', ANTHROPIC_API_KEY: 'k', DATABASE_URL: 'pg://u:p@h/db',
    A2UI5_MCP_SYSTEM_PASSWORD: 'pw', A2UI5_MCP_SYSTEM_PASSWORD_CMD: 'cmd', A2UI5_MCP_SYSTEM_USER: 'u', A2UI5_MCP_SYSTEM_URL: 'https://sap',
    SSH_AUTH_SOCK: '/tmp/agent', ALLOWED_HOSTS: '*', NODE_TLS_REJECT_UNAUTHORIZED: '0', KEEP: '1',
  };
  const needed = {
    PATH: '/bin', HOME: '/home/u', TMPDIR: '/tmp/u', TZ: 'Europe/Berlin', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8',
    NODE_OPTIONS: '--max-old-space-size=4096', NODE_EXTRA_CA_CERTS: '/ca.pem', HTTPS_PROXY: 'http://proxy:8080', no_proxy: 'localhost',
    SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\u',
  };
  const env = backendEnv({ ...decoys, ...needed }, { port: 9, host: '127.0.0.1' });
  assert.deepEqual(env, { ...needed, PORT: '9', HOST: '127.0.0.1' }, 'exactly the allowlist, any spelling, plus the port and the bind');
  assert.deepEqual(appChildEnv({ ...decoys, ...needed }), needed, 'appChildEnv on its own adds no PORT/HOST');
});

/* The same, measured in the spawned child itself: a parent environment full
 * of decoys, and the backend sees none of them. */
test('the spawned backend sees none of a polluted parent environment', async () => {
  const envMarker = path.join(base, 'env-polluted.json');
  setKnob('ENV_MARKER', envMarker);
  const decoys = { AWS_SECRET_ACCESS_KEY: 'aws', NPM_TOKEN: 'npm', GITHUB_TOKEN: 'gh', A2UI5_MCP_SYSTEM_PASSWORD: 'pw', SOME_APP_SECRET: 's' };
  Object.assign(process.env, decoys);
  try {
    await startBackend();
    const seen = JSON.parse(fs.readFileSync(envMarker, 'utf8')).env;
    for (const k of Object.keys(decoys)) assert.equal(seen[k], undefined, `${k} reached the backend child`);
    assert.equal(seen.PATH, process.env.PATH, 'PATH is passed');
    assert.equal(seen.PORT, String(PORT));
    assert.equal(seen.HOST, '127.0.0.1');
  } finally {
    await stopBackend();
    clearKnob('ENV_MARKER');
    for (const k of Object.keys(decoys)) delete process.env[k];
    await portFree();
  }
});

/* Express 5 calls app.listen's callback with the bind error: a backend over a
 * port somebody else holds said "Listening on" and exited, and the port wait
 * was answered by the other process - the app tools then talked to it. */
test('a backend that exits right after "Listening on" fails the start; the port\'s owner is not taken for it', async () => {
  const blocker = http.createServer((req, res) => setTimeout(() => res.end('somebody else'), 400));
  await new Promise((r) => blocker.listen(PORT, '127.0.0.1', r));
  setKnob('SAY_LISTENING_AND_EXIT', '1');
  try {
    await assert.rejects(startBackend(), /exited \(0\) right after it said it was listening - port \d+ is answered by another process/);
    assert.equal(backendStatus().running, false);
  } finally {
    clearKnob('SAY_LISTENING_AND_EXIT');
    await new Promise((r) => blocker.close(r));
  }
});

/* The port's owner answering AT ONCE: the port wait's first GET came back
 * before the child's exit was seen, and two starts in three reported
 * "running" - the test above only passed because its blocker answers late.
 * The child must outlive LIVENESS_MS past its "Listening on". */
test('a port owner that answers at once does not hide a backend that exits after "Listening on"', async () => {
  const blocker = http.createServer((req, res) => res.end('somebody else'));
  await new Promise((r) => blocker.listen(PORT, '127.0.0.1', r));
  setKnob('SAY_LISTENING_AND_EXIT', '1');
  try {
    for (const after of ['', '', '', '50', String(LIVENESS_MS - 150)]) {
      setKnob('EXIT_AFTER_MS', after);
      await assert.rejects(startBackend(), /exited \(0\) right after it said it was listening/, `exit after ${after || 0} ms`);
      assert.equal(backendStatus().running, false);
    }
  } finally {
    clearKnob('SAY_LISTENING_AND_EXIT');
    clearKnob('EXIT_AFTER_MS');
    await new Promise((r) => blocker.close(r));
  }
});

/* A stop during a start: the child is `server` only once it listens, so
 * stopBackend() had nothing to kill - the server's shutdown exited with the
 * child still booting (an orphan holding the port), and `backend stop`
 * answered "not running" while the start went on to listen. Every stop
 * reaches it now, and the start says it was stopped. */
test('a stop kills a backend that has not listened yet, and the start says so', async () => {
  setKnob('LISTEN_DELAY_MS', '700');
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
    clearKnob('LISTEN_DELAY_MS');
    await stopBackend();
  }
});

/* A2UI5_MCP_OFFLINE with no local @openui5 packages: every CDN request would
 * be the hermetic 404, and run_app launched a browser, booted the backend
 * and waited its whole timeout (60 s) to say so. The answer is given at
 * once, with the report's words, before either. */
test('run_app and interact_app answer at once offline without UI5 to serve, before any browser or backend', async () => {
  const saved = { OFFLINE: process.env.A2UI5_MCP_OFFLINE, CORPUS: process.env.SAMPLES_CONTROLS_HOME, DEMOKIT: process.env.AI_DEMOKIT_HOME };
  process.env.A2UI5_MCP_OFFLINE = '1';
  process.env.SAMPLES_CONTROLS_HOME = path.join(base, 'no-corpus');
  delete process.env.AI_DEMOKIT_HOME;
  try {
    const t0 = Date.now();
    const res = await runApp({ className: 'zcl_offline', timeoutMs: 60000 });
    assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms`);
    assert.equal(res.booted, false);
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /^UI5 did not load, so no app could boot: https:\/\/sdk\.openui5\.org\/resources\/sap-ui-core\.js - would be answered HTTP 404 \(A2UI5_MCP_OFFLINE is set and there are no local @openui5 packages\), so it was not requested\./);
    assert.match(res.errors[0], /A2UI5_MCP_OFFLINE is set, which answers every CDN request with a 404 - unset it, or run npm ci in samples-controls/);
    assert.equal(res.base64, null);
    assert.equal(res.screenshotPath, null);
    assert.equal(browserOpen(), false, 'no browser launched');
    assert.equal(backendStatus().running, false, 'no backend started');
    const it = await interactApp({ className: 'zcl_offline', actions: [{ action: 'click', id: 'go' }] });
    assert.equal(it.ok, false);
    assert.deepEqual(it.actions, []);
    assert.equal(it.notPerformed, 1);
    assert.equal(it.errors[0], res.errors[0]);
    assert.equal(browserOpen(), false);
  } finally {
    if (saved.OFFLINE === undefined) delete process.env.A2UI5_MCP_OFFLINE;
    else process.env.A2UI5_MCP_OFFLINE = saved.OFFLINE;
    if (saved.CORPUS === undefined) delete process.env.SAMPLES_CONTROLS_HOME;
    else process.env.SAMPLES_CONTROLS_HOME = saved.CORPUS;
    if (saved.DEMOKIT !== undefined) process.env.AI_DEMOKIT_HOME = saved.DEMOKIT;
  }
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

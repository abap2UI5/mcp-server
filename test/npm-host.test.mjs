// The npm backend's host (lib/npm-host.mjs) as startBackend runs it, and the
// server's gates for the npm backend over stdio. The port is fixed at module
// load (A2UI5_MCP_PORT), so this is a file of its own, like
// test/backend.test.mjs; ports from the 44xx range. Against the fake release
// of test/helpers/npm-fixture.mjs: its serve() answers with the classes
// registered at that moment, which is how a GET proves that the host
// imported the dev apps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeRelease, fakeTemplate, APP, TESTS, VERSION } from './helpers/npm-fixture.mjs';

const PORT = 4431;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-npm-host-'));
const workspace = path.join(base, 'workspace');
Object.assign(process.env, {
  A2UI5_MCP_PORT: String(PORT),
  A2UI5_MCP_BACKEND: 'npm',
  A2UI5_MCP_WORKSPACE: workspace,
  A2UI5_MCP_RUNTIME_VERSION: VERSION,
  SAMPLES_CONTROLS_HOME: path.join(base, 'no-corpus'),
  APP_TEMPLATE_HOME: fakeTemplate(path.join(base, 'app-template')),
  A2UI5_MCP_REMOTE: '0',
  A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'),
});
delete process.env.AI_DEMOKIT_HOME;

const { startBackend, stopBackend, backendStatus, buildBackend, deployApp } = await import('../lib/runtime.mjs');

const get = (port = PORT) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});

test('run_app\'s backend on the package: the host boots it, accelerates it and serves the dev apps', async () => {
  const dir = fakeRelease(workspace, { accelerate: true });
  deployApp({ className: 'zcl_hosted', source: APP('zcl_hosted'), testclasses: TESTS() });
  await assert.rejects(startBackend(), /backend not built — call build_backend first \(it installs @abap2ui5\/node-runtime/);
  const built = await buildBackend({ mode: 'auto' });
  assert.equal(built.ok, true, built.tail);
  try {
    const st = await startBackend();
    assert.equal(st.backend, 'npm');
    assert.equal(st.running, true);
    assert.equal(st.runtimeDir, dir);
    assert.match(st.host, /@abap2ui5\/node-runtime 1\.145\.0 .*1 dev module\(s\) \(zcl_hosted\.clas\.mjs\); accelerate: on; compression: not offered by this release/);
    const page = JSON.parse((await get()).body);
    assert.ok(page.classes.includes('ZCL_HOSTED'), `the dev app is registered: ${page.classes}`);
    assert.ok(page.classes.includes('CX_ROOT'), 'the package\'s own cx_root, which the dev module imported through the export');
    assert.equal(page.accelerated, true);
    assert.equal(page.boots, 2, 'apps/init.mjs initialized, serve() asked again - the package\'s initialize is idempotent, the fake counts');
  } finally {
    await stopBackend();
  }
  assert.equal(backendStatus().running, false);
});

test('a release that exports compress gets it in front of the handler; one without accelerate boots without', async () => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fakeRelease(workspace, { accelerate: false, compress: true });
  deployApp({ className: 'zcl_hosted', source: APP('zcl_hosted') });
  assert.equal((await buildBackend({ mode: 'auto' })).ok, true);
  try {
    const st = await startBackend();
    assert.match(st.host, /accelerate: not exported by this release; compression: on/);
    const res = await get();
    assert.equal(res.headers['x-fake-compress'], 'yes', 'the middleware ran');
    assert.equal(JSON.parse(res.body).accelerated, false);
  } finally {
    await stopBackend();
  }
});

/* The server's gates over stdio: with the npm backend in use, the tools that
 * used to demand a framework checkout answer for the npm backend instead - a
 * boot before a build names build_backend and the package, not a clone. */
test('the tools answer for the npm backend, not with "abap2UI5 checkout not found"', async () => {
  fs.rmSync(workspace, { recursive: true, force: true });
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, A2UI5_MCP_PORT: String(PORT + 1) },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (id, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === id);
      if (hit) { clearInterval(iv); resolve(hit); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`no answer to ${id}`)); }
    }, 50);
  });
  const call = async (id, name, args = {}) => {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return (await until(id)).result;
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'npm-host', version: '0' } } });
    await until(1);
    const unit = await call(2, 'run_unit_tests', { class_name: 'zcl_x' });
    assert.equal(unit.isError, true);
    assert.match(unit.content[0].text, /backend not built — call build_backend \(it installs @abap2ui5\/node-runtime/);
    assert.doesNotMatch(unit.content[0].text, /checkout not found/);
    const start = await call(3, 'backend', { action: 'start' });
    assert.equal(start.isError, true);
    assert.match(start.content[0].text, /call build_backend first/);
    const status = JSON.parse((await call(4, 'setup_status')).content[0].text);
    assert.equal(status.backend.kind, 'npm');
    assert.equal(status.sandbox.kind, 'npm');
    assert.match(status.backend.npm.nextBuild[0], /install @abap2ui5\/node-runtime@1\.145\.0/);
    const read = await call(5, 'read_app', { class_name: 'zcl_x' });
    assert.match(read.content[0].text, /no dev app 'zcl_x' in the dev sandbox/);
  } finally {
    p.kill();
  }
});

/* 127.0.0.1 is reachable from every browser page on this machine: through
 * DNS rebinding a page reads the dev backend's answers as a same-origin page,
 * and any page can post to it blind. The host answered both - its framework
 * checks no Host and no Origin. It serves loopback names and loopback pages
 * only now, on both serve paths (the release's serve(), the compress app). */
test('the host refuses a request addressed to another name or sent from another page', async () => {
  const { startHost, loopbackRequest } = await import('../lib/npm-host.mjs');
  for (const compress of [false, true]) {
    const ws = path.join(base, `rebind-${compress}`);
    const dir = fakeRelease(ws, { compress });
    const { server } = await startHost({ dir, port: 0 });
    const port = server.address().port;
    const ask = (headers) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers, timeout: 5000 }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    try {
      assert.equal(await ask({}), 200, 'the app tools: Host 127.0.0.1, no Origin');
      assert.equal(await ask({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }), 200, 'run_app\'s Chromium (BACKEND_HOST)');
      assert.equal(await ask({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 200, 'a page the user opens at localhost');
      assert.equal(await ask({ Host: `rebound.example:${port}` }), 403, 'a rebound name');
      assert.equal(await ask({ Origin: 'http://evil.example' }), 403, 'a page of another site');
      assert.equal(await ask({ Origin: 'null' }), 403, 'a sandboxed frame or a file: page');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
  assert.equal(loopbackRequest({ host: '[::1]:3000', origin: 'https://[::1]:3000' }), true);
  assert.equal(loopbackRequest({ host: 'LOCALHOST' }), true);
  assert.equal(loopbackRequest({}), false, 'no Host at all');
  assert.equal(loopbackRequest({ host: '127.0.0.1.rebound.example' }), false);
  assert.equal(loopbackRequest({ host: '127.0.0.1', origin: 'file:///x' }), false);
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// The app_* tools against a REAL transpiled backend: @abap2ui5/node-runtime
// from the registry (the npm backend, the way a fresh machine gets it), an
// app class with a form, a table with a row action and a selection, and a
// popup (test/fixtures/agent-app/zcl_agent_mcp.clas.abap), and one with a
// SelectDialog value help and a MessagePopover (zcl_agent_mcp_pick) deployed and built,
// then operated through the wire protocol - first through lib/appclient.mjs,
// then through the server itself over stdio (app_list, app_start, app_act,
// app_describe), so the tool wiring is proven on the same build.
//
// OPT-IN under A2UI5_MCP_NETWORK_TESTS=1 (ci.yml sets it), and SKIPPED BY
// ITSELF even then when the npm registry or GitHub cannot be reached (and
// with A2UI5_MCP_SKIP_NETWORK_TESTS=1), exactly like
// test/npm-integration.test.mjs, whose gate this is. A workspace of its own
// (a temp dir); with npm's cache warm from that test the install is seconds.
// A2UI5_MCP_TEST_RUNTIME_TGZ runs it on a local build of the package, as
// that test does (test/helpers/local-runtime.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installLocalRuntime } from './helpers/local-runtime.mjs';

const PORT = 4451;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILE = path.join(ROOT, 'test', 'fixtures', 'agent-app', 'zcl_agent_mcp.clas.abap');
const PICK_FILE = path.join(ROOT, 'test', 'fixtures', 'agent-app', 'zcl_agent_mcp_pick.clas.abap');

function reachable() {
  if (process.env.A2UI5_MCP_SKIP_NETWORK_TESTS) return 'A2UI5_MCP_SKIP_NETWORK_TESTS is set';
  // opt-in: the registry loop is 20 s and more per test, and a local `npm test` is the sibling-free suite (ci.yml sets it)
  if (!process.env.A2UI5_MCP_NETWORK_TESTS) return 'A2UI5_MCP_NETWORK_TESTS is not set';
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', '@abap2ui5/node-runtime', 'version', '--json'], {
    encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32',
  });
  if (npm.status !== 0) return `the npm registry cannot be reached (${(npm.stderr || npm.error || '').toString().trim().split('\n').pop()})`;
  const git = spawnSync('git', ['ls-remote', 'https://github.com/open-abap/open-abap-core', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  if (git.status !== 0) return `GitHub cannot be reached with git (${(git.stderr || git.error || '').toString().trim().split('\n').pop()})`;
  return null;
}

const skip = reachable();

/** A minimal MCP client over the server's stdio. */
function stdioServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (waiting.has(m.id)) {
          waiting.get(m.id)(m);
          waiting.delete(m.id);
        }
      } catch {
        /* a log line */
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, call, close: () => p.kill() };
}

test('app_start / app_act / app_describe operate a real app on @abap2ui5/node-runtime', { skip: skip || false, timeout: 15 * 60_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-agent-it-'));
  const saved = { ...process.env };
  const env = {
    A2UI5_MCP_PORT: String(PORT),
    A2UI5_MCP_BACKEND: 'npm',
    A2UI5_MCP_WORKSPACE: path.join(base, 'workspace'),
    SAMPLES_CONTROLS_HOME: path.join(base, 'no-corpus'),
    A2UI5_MCP_REMOTE: '0',
  };
  Object.assign(process.env, env);
  delete process.env.A2UI5_MCP_RUNTIME_VERSION;
  delete process.env.AI_DEMOKIT_HOME;
  // A2UI5_MCP_TEST_RUNTIME_TGZ: a local build of the package instead of the registry's
  const { lintCliVersion } = await import('../lib/npm-backend.mjs');
  Object.assign(env, await installLocalRuntime(env.A2UI5_MCP_WORKSPACE, { cli: lintCliVersion().version }));
  Object.assign(process.env, env);
  const rt = await import('../lib/runtime.mjs');
  const { createAppClient } = await import('../lib/appclient.mjs');
  const log = [];
  try {
    rt.deployApp({ className: 'zcl_agent_mcp', source: fs.readFileSync(APP_FILE, 'utf8') });
    rt.deployApp({ className: 'zcl_agent_mcp_pick', source: fs.readFileSync(PICK_FILE, 'utf8') });
    const built = await rt.buildBackend({ mode: 'auto', withLint: false, onLine: (l) => log.push(l) });
    assert.equal(built.ok, true, `build:\n${built.tail}\n${log.slice(-20).join('\n')}`);
    assert.ok(rt.builtAppClasses().some((a) => a.app === 'ZCL_AGENT_MCP' && a.source === 'dev'), 'app_list sees the dev app');

    await rt.startBackend();
    const client = createAppClient({ baseUrl: rt.backendBaseUrl(), generation: rt.backendGeneration });
    let s = await client.start('zcl_agent_mcp');
    assert.equal(s.app, 'ZCL_AGENT_MCP');
    assert.equal(s.title, 'Agent test app');
    assert.deepEqual(s.fields.map((f) => `${f.id}:${f.label}:${f.kind}${f.required ? '*' : ''}`), ['f1:Customer:text*', 'f2:Express:boolean', 'f3:Priority:choice']);
    assert.deepEqual(s.fields[2].values, [{ key: 'A', text: 'High' }, { key: 'B', text: 'Normal' }]);
    assert.deepEqual(s.actions.map((a) => `${a.event}:${a.scope}`), ['ROW:row', 'SAVE:screen', 'DELETE:screen', 'ASK:screen']);
    assert.deepEqual(s.tables[0].editableCells, ['QTY', 'SELKZ']);

    // fill the form and save: the values travel as the model delta
    s = await client.act(s.session, { values: { f1: 'ACME', Express: true, '/PRIORITY': 'A' }, event: 'SAVE' });
    assert.deepEqual(s.messages.filter((m) => m.source === 'toast').map((m) => m.text), ['saved ACME express=X priority=A']);
    assert.ok(s.texts.includes('Result: saved ACME express=X priority=A'), JSON.stringify(s.texts));

    // a row action: ${NAME} of row 2; a cell edit rides along
    s = await client.act(s.session, { values: { '/ROWS/1/QTY': 7 }, event: 'ROW', row: 2 });
    assert.ok(s.texts.includes('Result: row gamma'), JSON.stringify(s.texts));
    assert.equal(s.tables[0].rows[1].QTY, 7);

    // select a row and delete it
    s = await client.act(s.session, { values: { 't1/0/SELKZ': true }, event: 'DELETE' });
    assert.deepEqual(s.tables[0].rows.map((r) => r.NAME), ['beta', 'gamma']);

    // the popup: its close button is the browser-only close, then confirm
    s = await client.act(s.session, { event: 'ASK' });
    assert.equal(s.layer, 'popup');
    assert.deepEqual(s.actions.map((a) => a.event), ['CONFIRM', '@CLOSE_POPUP']);
    s = await client.act(s.session, { event: '@CLOSE_POPUP' });
    assert.equal(s.layer, 'main');
    s = await client.act(s.session, { event: 'ASK' });
    s = await client.act(s.session, { event: 'CONFIRM' });
    assert.equal(s.layer, 'main');
    assert.ok(s.texts.includes('Result: confirmed'), JSON.stringify(s.texts));

    // a SelectDialog value help: search through args, pick a row with `row`
    let p = await client.start('zcl_agent_mcp_pick');
    assert.deepEqual(p.messages, [{ type: 'warning', text: 'pick a customer', source: 'popover' }], 'the MessagePopover in dependents');
    p = await client.act(p.session, { event: 'VH' });
    assert.equal(p.layer, 'popup');
    assert.equal(p.title, 'Customers');
    assert.deepEqual([p.tables[0].control, p.tables[0].selectionMode, p.tables[0].selectionField, p.tables[0].rowCount], ['sap.m.SelectDialog', 'Single', 'SELKZ', 3]);
    assert.deepEqual(p.actions.map((a) => `${a.event}:${a.scope}`), ['SEARCH:screen', 'PICKED:row', 'CANCEL:screen']);
    await assert.rejects(client.act(p.session, { event: 'PICKED' }), /picks a row of table t1 \(3 rows\) - pass `row` \(0-2\)/);
    p = await client.act(p.session, { event: 'SEARCH', args: ['mm'] });
    assert.deepEqual(p.tables[0].rows.map((r) => r.TITLE), ['gamma']);
    p = await client.act(p.session, { event: 'PICKED', row: 0 });
    assert.equal(p.layer, 'main');
    assert.equal(p.fields[0].value, 'gamma', 'selectedItem.getTitle() of the picked row');
    assert.deepEqual(p.messages, [{ type: 'success', text: 'picked gamma selected gamma', source: 'popover' }], 'the pick selected SELKZ of that row');

    // the same app through the server's tools, on the build above - the
    // server starts a backend of its own, so this process's goes first (and
    // a session of it is gone with it, which the client says)
    await rt.stopBackend();
    assert.throws(() => client.describe(s.session), /stopped or restarted - its drafts are gone/);
    const srv = stdioServer({ ...process.env, ...env });
    try {
      await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-it', version: '0' } });
      const list = await srv.call('app_list', { filter: 'agent' });
      assert.deepEqual(JSON.parse(list.content[0].text).apps, [{ app: 'ZCL_AGENT_MCP', source: 'dev' }, { app: 'ZCL_AGENT_MCP_PICK', source: 'dev' }]);
      const started = await srv.call('app_start', { app: 'zcl_agent_mcp', values: { f1: 'Tool' } });
      assert.ok(!started.isError, started.content[0].text);
      const snap = JSON.parse(started.content[0].text);
      assert.deepEqual(snap.pending, ['/NAME']);
      const refused = await srv.call('app_act', { session: snap.session, event: 'NOPE' });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /allowed events: ROW \(a1 "Pick", row action of t1\), SAVE/);
      const saved2 = JSON.parse((await srv.call('app_act', { session: snap.session, event: 'SAVE' })).content[0].text);
      assert.ok(saved2.messages.some((m) => m.source === 'toast' && m.text === 'saved Tool express= priority=B'), JSON.stringify(saved2.messages));
      const described = JSON.parse((await srv.call('app_describe', { session: saved2.session })).content[0].text);
      assert.equal(described.session, saved2.session);
      // the pick through app_act
      const pick0 = JSON.parse((await srv.call('app_start', { app: 'zcl_agent_mcp_pick' })).content[0].text);
      const pick1 = JSON.parse((await srv.call('app_act', { session: pick0.session, event: 'VH' })).content[0].text);
      const noRow = await srv.call('app_act', { session: pick1.session, event: 'PICKED' });
      assert.equal(noRow.isError, true);
      assert.match(noRow.content[0].text, /picks a row of table t1 \(3 rows\) - pass `row` \(0-2\)/);
      const pick2 = JSON.parse((await srv.call('app_act', { session: pick1.session, event: 'PICKED', row: 1 })).content[0].text);
      assert.equal(pick2.fields[0].value, 'beta');
      assert.deepEqual(pick2.messages.map((m) => m.text), ['picked beta selected beta']);
    } finally {
      srv.close();
    }
  } finally {
    await rt.stopBackend().catch(() => {});
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

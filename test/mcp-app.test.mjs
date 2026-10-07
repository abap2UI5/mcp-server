// The app tools' MCP Apps screen (lib/mcp-app.mjs, lib/mcp-app-view.mjs):
// the ui:// resource is listed and readable without any checkout, its HTML is
// one self-contained document the spec's default CSP runs (no external URL,
// no network API, no eval), the tools declare it only when the client
// advertises the extension (or A2UI5_MCP_UI says so), and the page's bridge
// emits app_act calls that the agent client accepts and sends EXACTLY as the
// agent's own recorded acts - the recorded sessions of test/fixtures/agent
// are replayed with every act built by the page's own buildActCall. A last
// test runs the real page in headless Chromium under the spec's CSP, with a
// host page speaking the postMessage protocol (skipped without a Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP_SCREEN_URI, UI_MIME, UI_EXTENSION, UI_TOOLS, APP_SCREEN_META,
  uiMode, clientRendersUi, uiEnabled, toolsWithUi, appScreenHtml, viewModuleSource,
} from '../lib/mcp-app.mjs';
import {
  buildActCall, editsFromForm, renderScreen, createBridge, snapshotOf, errorOf, boxChoices,
  escapeHtml, contextText, CALLABLE_TOOLS, UI_PROTOCOL_VERSION,
} from '../lib/mcp-app-view.mjs';
import { RESOURCES, readResource } from '../lib/resources.mjs';
import { TOOLS } from '../lib/tools.mjs';
import { FIXTURES, fixture, replayClient, actionOf, targetOf } from './helpers/agent-replay.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADVERTISED = { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } } };

/** Every snapshot of a fixture, replayed with the agent's own acts. */
async function snapshotsOf(name) {
  const { client } = replayClient(name);
  const out = [];
  let snap = null;
  for (const step of fixture(name).steps) {
    snap = step.op === 'start' ? await client.start(step.arg) : await client.act(snap.session, step.arg);
    out.push(snap);
  }
  return out;
}

// ------------------------------------------------------- the resource ----

test('the UI resource is listed with the MCP Apps mime type and reads as one HTML document', () => {
  const listed = RESOURCES.find((r) => r.uri === APP_SCREEN_URI);
  assert.ok(listed, 'ui://abap2ui5/app-screen must be in resources/list');
  assert.match(APP_SCREEN_URI, /^ui:\/\//, 'MCP Apps resources use the ui:// scheme');
  assert.equal(listed.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(listed._meta, APP_SCREEN_META);
  const read = readResource(APP_SCREEN_URI);
  assert.equal(read.contents.length, 1);
  const [c] = read.contents;
  assert.equal(c.uri, APP_SCREEN_URI);
  assert.equal(c.mimeType, UI_MIME);
  assert.deepEqual(c._meta, { ui: { prefersBorder: true } });
  assert.equal(c._meta.ui.csp, undefined, 'no csp declared: the host applies the restrictive default, which is all the page needs');
  assert.match(c.text, /^<!doctype html>\n<html lang="en">/);
  assert.match(c.text, /<\/html>\n$/);
  assert.equal(c.text, appScreenHtml());
});

test('the page is self-contained: no external URL, no network API, no eval, nothing that breaks the inline script', () => {
  const html = appScreenHtml();
  const src = viewModuleSource();
  assert.ok(!/https?:\/\//i.test(html), 'no absolute URL anywhere in the document');
  assert.ok(!/\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(html.replace(/\/\*[\s\S]*?\*\//g, '')), 'no protocol-relative URL');
  assert.ok(!/<(link|iframe|object|embed|base|img)\b/i.test(html), 'no element that loads anything');
  assert.ok(!/\s(src|href)\s*=/i.test(html), 'no src or href attribute');
  assert.ok(!/@import|url\(/i.test(html), 'no stylesheet import or url()');
  assert.equal((html.match(/<script\b/g) || []).length, 1, 'one inline script');
  assert.match(html, /<script type="module">\n/);
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /\beval\s*\(/, /new Function/, /sendBeacon/, /\bimport\s*\(/, /^\s*import\s/m]) {
    assert.ok(!banned.test(src), `the page module must not use ${banned}`);
  }
  assert.ok(!/<\/script/i.test(src), 'the module is inlined: it must not close the script element');
  assert.ok(!src.includes('<!--'), 'an HTML comment opener is a syntax error in a module script');
  assert.match(html, /\nboot\(window\);\n<\/script>/);
});

// ---------------------------------------------------- tool declaration ----

test('A2UI5_MCP_UI and the client capability decide whether the app tools declare the screen', () => {
  assert.equal(uiMode({}), 'auto');
  assert.equal(uiMode({ A2UI5_MCP_UI: 'on' }), 'on');
  assert.equal(uiMode({ A2UI5_MCP_UI: 'OFF' }), 'off');
  assert.equal(uiMode({ A2UI5_MCP_UI: 'banana' }), 'auto');
  assert.equal(clientRendersUi(ADVERTISED), true);
  assert.equal(clientRendersUi({ extensions: { [UI_EXTENSION]: { mimeTypes: ['text/html+skybridge'] } } }), false, 'another profile is not ours');
  assert.equal(clientRendersUi({}), false);
  assert.equal(clientRendersUi(undefined), false);
  assert.equal(uiEnabled(ADVERTISED, {}), true);
  assert.equal(uiEnabled({}, {}), false);
  assert.equal(uiEnabled({}, { A2UI5_MCP_UI: 'on' }), true);
  assert.equal(uiEnabled(ADVERTISED, { A2UI5_MCP_UI: 'off' }), false);
});

test('with the UI on, exactly the three app tools carry _meta.ui.resourceUri (and the legacy flat key); TOOLS is untouched', () => {
  const before = JSON.stringify(TOOLS);
  assert.equal(toolsWithUi(TOOLS, false), TOOLS);
  const tools = toolsWithUi(TOOLS, true);
  assert.equal(JSON.stringify(TOOLS), before);
  for (const t of tools) {
    if (UI_TOOLS.includes(t.name)) {
      assert.deepEqual(t._meta.ui, { resourceUri: APP_SCREEN_URI, visibility: ['model', 'app'] });
      assert.equal(t._meta['ui/resourceUri'], APP_SCREEN_URI);
    } else {
      assert.equal(t._meta, undefined, `${t.name} renders no screen`);
    }
  }
  assert.deepEqual(UI_TOOLS.filter((n) => TOOLS.some((t) => t.name === n)), UI_TOOLS);
  for (const n of UI_TOOLS) {
    const f = TOOLS.find((t) => t.name === n).inputSchema.properties.format;
    assert.deepEqual(f.enum, ['snapshot', 'adaptive-card'], `${n} takes the format argument`);
  }
});

// ------------------------------------------------------ the bridge logic ----

test('every recorded act, built by the page from the snapshot on screen, sends exactly the recorded request', async () => {
  let viaPage = 0;
  for (const name of FIXTURES) {
    const { client, sent, exchanges } = replayClient(name);
    let snap = null;
    for (const step of fixture(name).steps) {
      if (step.op === 'start') {
        snap = await client.start(step.arg);
        continue;
      }
      const a = step.arg;
      // explicit args are values only a browser computes - the page has no
      // way to supply them; the agent's call keeps the replay in sync
      if (a.args) {
        snap = await client.act(snap.session, a);
        continue;
      }
      const action = actionOf(snap, a.event, a.row);
      assert.ok(action, `${name}: no action ${a.event} on the screen`);
      const values = {};
      for (const [k, v] of Object.entries(a.values || {})) {
        const t = targetOf(snap, k);
        assert.ok(t, `${name}: no target ${k}`);
        values[t.kind === 'field' ? t.field.id : t.path] = v;
      }
      const call = buildActCall(snap, { action: action.id, values, row: a.row });
      assert.equal(call.name, 'app_act');
      assert.equal(call.arguments.session, snap.session);
      const { session, max_rows: maxRows, ...rest } = call.arguments;
      snap = await client.act(session, { ...rest, maxRows });
      viaPage++;
    }
    assert.equal(sent.length, exchanges.length, `${name}: every recorded request was sent`);
  }
  assert.ok(viaPage >= 15, `the page path covered ${viaPage} acts`);
});

test('the page refuses what the snapshot does not allow - before anything is posted', async () => {
  const [, snap] = await snapshotsOf('popup-009');
  const [start] = await snapshotsOf('form-381');
  assert.throws(() => buildActCall(null, { action: 'a1' }), /no app screen/);
  assert.throws(() => buildActCall(start, { action: 'a999' }), /not an action of this screen/);
  const disabled = { ...start, actions: start.actions.map((a, i) => (i === 0 ? { ...a, enabled: false } : a)) };
  assert.throws(() => buildActCall(disabled, { action: start.actions[0].id }), /is disabled/);
  const fixed = start.fields.find((f) => !f.editable) || { id: 'fX' };
  const withFixed = start.fields.some((f) => !f.editable) ? start : { ...start, fields: [...start.fields, { id: 'fX', label: 'fixed', editable: false, kind: 'text', path: '/X', name: 'X' }] };
  assert.throws(() => buildActCall(withFixed, { action: start.actions[0].id, values: { [fixed.id]: 'x' } }), /not editable/);
  assert.throws(() => buildActCall(start, { action: start.actions[0].id, values: { '/NOPE': 1 } }), /no field id and no table cell/);
  const choice = start.fields.find((f) => f.kind === 'choice' && Array.isArray(f.values) && f.editable);
  assert.ok(choice, 'form-381 has a choice field');
  assert.throws(() => buildActCall(start, { action: start.actions[0].id, values: { [choice.id]: 'not-a-key' } }), /not one of its values/);
  const screenAction = start.actions.find((a) => a.scope === 'screen');
  assert.throws(() => buildActCall(start, { action: screenAction.id, row: 0 }), /no row action/);
  // the value-help popup: a table with a selection field
  const t = snap.tables[0];
  assert.throws(() => buildActCall(snap, { action: snap.actions[0].id, values: { [`${t.path}/${t.rowCount}/${t.selectionField}`]: true } }), /does not exist/);
  assert.throws(() => buildActCall(snap, { action: snap.actions[0].id, values: { [`${t.path}/0/NOT_A_COLUMN`]: true } }), /not editable/);
  const ok = buildActCall(snap, { action: snap.actions[0].id, values: { [`${t.path}/2/${t.selectionField}`]: true }, maxRows: 5 });
  assert.deepEqual(ok.arguments, { session: snap.session, event: snap.actions[0].id, values: { [`${t.path}/2/${t.selectionField}`]: true }, max_rows: 5 });
});

test('a message box close action becomes one button per choice, its "$action" argument the choice', () => {
  const box = { id: 'a2', event: 'CLOSED', args: ['$action'], label: 'close message box (YES | NO)', control: 'sap.m.MessageBox', trigger: 'close', enabled: true, scope: 'screen', layer: 'main' };
  const snap = { snapshotVersion: 1, session: 'S1', app: 'Z', title: '', layer: 'main', fields: [], actions: [box], tables: [], messages: [{ type: 'info', text: 'sure?', source: 'box' }], texts: [], unsupported: [] };
  assert.deepEqual(boxChoices(box), ['YES', 'NO']);
  assert.deepEqual(boxChoices({ ...box, label: 'close message box' }), ['OK']);
  assert.deepEqual(boxChoices({ id: 'a1', args: [] }), []);
  assert.deepEqual(buildActCall(snap, { action: 'a2', choice: 'NO' }).arguments, { session: 'S1', event: 'a2', args: ['NO'] });
  assert.deepEqual(buildActCall(snap, { action: 'a2' }).arguments.args, ['YES'], 'no choice: the first, as app_act defaults');
  assert.throws(() => buildActCall(snap, { action: 'a2', choice: 'MAYBE' }), /not one of YES, NO/);
  const html = renderScreen({ snapshot: snap, canAct: true });
  assert.match(html, /data-action="a2" data-choice="YES"/);
  assert.match(html, /data-action="a2" data-choice="NO"/);
});

test('editsFromForm keeps only what the user changed', async () => {
  const [snap] = await snapshotsOf('form-381');
  const entries = snap.fields.filter((f) => f.editable).map((f) => ({ key: f.id, value: f.kind === 'boolean' ? Boolean(f.value) : f.value ?? '' }));
  assert.deepEqual(editsFromForm(snap, entries), {}, 'an untouched form sends nothing');
  const text = snap.fields.find((f) => f.kind === 'text' && f.editable);
  const changed = entries.map((e) => (e.key === text.id ? { ...e, value: 'typed' } : e));
  assert.deepEqual(editsFromForm(snap, changed), { [text.id]: 'typed' });
});

test('an untouched choice without a matching key and an unchecked box with an ABAP value send nothing', () => {
  const fields = [
    { id: 'f1', path: '/C', name: 'C', label: 'C', kind: 'choice', value: '', editable: true, values: [{ key: 'DE', text: 'Germany' }, { key: 'FR', text: 'France' }] },
    { id: 'f2', path: '/R', name: 'R', label: 'R', kind: 'choice', value: -1, editable: true, values: [{ key: '0', text: 'a' }, { key: '1', text: 'b' }] },
    { id: 'f3', path: '/B', name: 'B', label: 'B', kind: 'boolean', value: null, editable: true },
    { id: 'f4', path: '/X', name: 'X', label: 'X', kind: 'boolean', value: 'X', editable: true },
  ];
  const snap = { snapshotVersion: 1, session: 'S1', app: 'Z', title: '', layer: 'main', fields, actions: [], tables: [], messages: [], texts: [], unsupported: [] };
  const html = renderScreen({ snapshot: snap, canAct: true });
  assert.match(html, /<select id="in-f1"[^>]*><option value="" selected hidden><\/option><option value="DE">/, 'the empty key is the shown option, not Germany');
  assert.match(html, /<option value="-1" selected hidden><\/option>/);
  assert.deepEqual(editsFromForm(snap, [{ key: 'f1', value: '' }, { key: 'f2', value: '-1' }, { key: 'f3', value: false }, { key: 'f4', value: true }]), {});
  assert.deepEqual(editsFromForm(snap, [{ key: 'f3', value: true }, { key: 'f4', value: false }]), { f3: true, f4: false });
});

test('message box choices with parentheses stay whole', () => {
  const box = { id: 'a2', event: 'CLOSED', args: ['$action'], label: 'close message box (Save (draft) | Discard)' };
  assert.deepEqual(boxChoices(box), ['Save (draft)', 'Discard']);
});

test('renderScreen shows every field, action and table of each recorded screen, and escapes every value', async () => {
  for (const name of FIXTURES) {
    for (const snap of await snapshotsOf(name)) {
      const html = renderScreen({ snapshot: snap, canAct: true });
      for (const f of snap.fields) assert.ok(html.includes(`data-field="${f.id}"`), `${name}: field ${f.id}`);
      for (const a of snap.actions) assert.ok(html.includes(`data-action="${a.id}"`), `${name}: action ${a.id}`);
      for (const t of snap.tables) assert.ok(html.includes(`aria-label="${escapeHtml(t.label || t.name)}"`), `${name}: table ${t.id}`);
      assert.ok(!/<script/i.test(html), `${name}: no script in the rendered screen`);
    }
  }
  const evil = {
    snapshotVersion: 1, session: '"><script>x</script>', app: '<img src=x onerror=alert(1)>', title: '<b>t</b>', layer: 'main',
    fields: [{ id: 'f1', path: '/A', name: 'A', label: '<i>l</i>', control: 'sap.m.Input', kind: 'text', value: '"><script>', required: false, editable: true, layer: 'main' }],
    actions: [{ id: 'a1', event: 'E', args: [], label: '<u>go</u>', control: 'sap.m.Button', trigger: 'press', enabled: true, scope: 'screen', layer: 'main' }],
    tables: [], messages: [{ type: 'error', text: '<svg onload=x>', source: 'strip' }], texts: ['<marquee>'], unsupported: ['<iframe>'],
  };
  const html = renderScreen({ snapshot: evil, error: '<script>e</script>', canAct: true });
  assert.ok(!/<(script|img|svg|marquee|iframe|b|i|u)\b/i.test(html), html);
  assert.match(html, /&lt;script&gt;/);
});

test('the bridge: initialize handshake, tool-result rendering, app_act through the host, model context after the act', async () => {
  const [first, second] = await snapshotsOf('form-381');
  const posted = [];
  const views = [];
  const bridge = createBridge({ post: (m) => posted.push(m), render: (v) => views.push(v) });
  const started = bridge.start();
  const init = posted.shift();
  assert.equal(init.method, 'ui/initialize');
  assert.equal(init.params.protocolVersion, UI_PROTOCOL_VERSION);
  assert.deepEqual(init.params.appInfo, { name: 'abap2ui5-app-screen', version: '1' });
  assert.ok(init.params.appCapabilities);
  bridge.handle({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: UI_PROTOCOL_VERSION, hostInfo: { name: 'test' }, hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'dark' } } });
  await started;
  assert.deepEqual(posted.shift(), { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });

  bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { app: 'z2ui5_cl_smp_app_381', max_rows: 7 } } });
  bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(first) }] } });
  assert.equal(views.at(-1).snapshot.session, first.session);

  // a refused intent posts nothing and says why
  await bridge.act({ action: 'a999' });
  assert.equal(posted.length, 0);
  assert.match(views.at(-1).error, /not an action/);

  const text = first.fields.find((f) => f.kind === 'text' && f.editable);
  const show = first.actions.find((a) => a.event === 'SHOW');
  const acting = bridge.act({ action: show.id, values: { [text.id]: 'hi' } });
  const callMsg = posted.shift();
  assert.equal(callMsg.method, 'tools/call');
  assert.deepEqual(callMsg.params, { name: 'app_act', arguments: { session: first.session, event: show.id, values: { [text.id]: 'hi' }, max_rows: 7 } });
  assert.equal(views.at(-1).busy, true);
  // a second act while the first runs is refused locally
  await bridge.act({ action: show.id });
  assert.equal(posted.length, 0, 'one act at a time');
  bridge.handle({ jsonrpc: '2.0', id: callMsg.id, result: { content: [{ type: 'text', text: JSON.stringify(second) }] } });
  await acting;
  assert.equal(views.at(-1).snapshot.session, second.session);
  assert.equal(views.at(-1).busy, false);
  const ctx = posted.shift();
  assert.equal(ctx.method, 'ui/update-model-context');
  assert.match(ctx.params.content[0].text, new RegExp(`session ${second.session}`));
  assert.match(ctx.params.content[0].text, /app_act/);

  // an error result is shown verbatim and keeps the screen
  const again = bridge.act({ action: second.actions[0].id });
  const c2 = posted.shift();
  bridge.handle({ jsonrpc: '2.0', id: c2.id, result: { isError: true, content: [{ type: 'text', text: 'no action <x>' }] } });
  await again;
  assert.equal(views.at(-1).error, 'no action <x>');
  assert.equal(views.at(-1).snapshot.session, second.session);

  // refresh is app_describe of the current session; nothing else is callable
  const r = bridge.refresh();
  const c3 = posted.shift();
  assert.deepEqual(c3.params, { name: 'app_describe', arguments: { session: second.session } });
  bridge.handle({ jsonrpc: '2.0', id: c3.id, result: { content: [{ type: 'text', text: JSON.stringify(second) }] } });
  await r;
  assert.deepEqual(CALLABLE_TOOLS, ['app_act', 'app_describe']);

  // teardown and ping are answered
  bridge.handle({ jsonrpc: '2.0', id: 99, method: 'ui/resource-teardown', params: { reason: 'x' } });
  assert.deepEqual(posted.shift(), { jsonrpc: '2.0', id: 99, result: {} });
});

test('the bridge acts only when the host proxies tool calls (serverTools)', async () => {
  const [first] = await snapshotsOf('form-381');
  const posted = [];
  const views = [];
  const bridge = createBridge({ post: (m) => posted.push(m), render: (v) => views.push(v) });
  const started = bridge.start();
  const init = posted.shift();
  bridge.handle({ jsonrpc: '2.0', id: init.id, result: { hostCapabilities: {}, hostContext: {} } });
  await started;
  posted.length = 0;
  bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(first) }] } });
  assert.match(renderScreen(views.at(-1)), /does not let the page call tools/);
  await bridge.act({ action: first.actions[0].id });
  assert.equal(posted.length, 0);
  assert.match(views.at(-1).error, /does not let the page call tools/);
});

test('snapshotOf / errorOf read tool results the way the host delivers them', () => {
  const snap = { snapshotVersion: 1, session: 'S' };
  assert.deepEqual(snapshotOf({ content: [{ type: 'text', text: JSON.stringify(snap) }] }), snap);
  assert.deepEqual(snapshotOf({ structuredContent: snap, content: [] }), snap);
  assert.equal(snapshotOf({ content: [{ type: 'text', text: 'backend not built' }] }), null);
  assert.equal(snapshotOf({ isError: true, content: [{ type: 'text', text: JSON.stringify(snap) }] }), null);
  assert.equal(errorOf({ isError: true, content: [{ type: 'text', text: 'boom' }] }), 'boom');
  assert.equal(errorOf({ content: [] }), null);
  assert.match(contextText({ name: 'app_act', arguments: { session: 'S', event: 'a1' } }, { app: 'Z', session: 'T', layer: 'main', title: 'X', messages: [{ type: 'error', text: 'bad' }] }), /session T[\s\S]*error: bad/);
});

// ------------------------------------------------------ over stdio ----

function boot(env = {}) {
  const p = spawn('node', [path.join(ROOT, 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (id, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === id);
      if (hit) { clearInterval(iv); res(hit); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${id}`)); }
    }, 30);
  });
  return { p, send, until };
}

async function toolsListed(capabilities, env) {
  const s = boot(env);
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 't', version: '0' } } });
    await s.until(1);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = (await s.until(2)).result.tools;
    s.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: APP_SCREEN_URI } });
    const read = await s.until(3);
    s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'app_describe', arguments: { session: 'X', format: 'card' } } });
    const badFormat = await s.until(4);
    return { list, read, badFormat };
  } finally {
    s.p.kill();
  }
}

test('over stdio: the screen is declared for a client that advertises MCP Apps, and readable for every client', async () => {
  const withUi = await toolsListed(ADVERTISED, { A2UI5_MCP_UI: '' });
  for (const n of UI_TOOLS) assert.equal(withUi.list.find((t) => t.name === n)._meta.ui.resourceUri, APP_SCREEN_URI);
  assert.equal(withUi.read.result.contents[0].mimeType, UI_MIME);
  assert.match(withUi.read.result.contents[0].text, /^<!doctype html>/);
  assert.deepEqual(withUi.read.result.contents[0]._meta, APP_SCREEN_META);
  assert.equal(withUi.badFormat.result.isError, true);
  assert.match(withUi.badFormat.result.content[0].text, /unknown format 'card'/);

  const plain = await toolsListed({}, { A2UI5_MCP_UI: '' });
  for (const t of plain.list) assert.equal(t._meta, undefined, `${t.name} without the capability carries no UI metadata`);
  assert.equal(plain.read.result.contents[0].uri, APP_SCREEN_URI, 'the resource reads without the capability too');

  const forced = await toolsListed({}, { A2UI5_MCP_UI: 'on' });
  assert.equal(forced.list.find((t) => t.name === 'app_act')._meta.ui.resourceUri, APP_SCREEN_URI);
});

// ------------------------------------------------- the page in a browser ----

async function browserOrNull() {
  const { chromium } = await import('playwright');
  const candidates = [process.env.A2UI5_MCP_CHROMIUM, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  try {
    return await chromium.launch();
  } catch {
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      try {
        return await chromium.launch({ executablePath: c });
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/* The spec's restrictive default CSP (no `_meta.ui.csp`), as the sandbox applies it. */
const DEFAULT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'";

const HOST = (first, second) => `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
<iframe id="view" src="/view" sandbox="allow-scripts" style="width:800px;height:600px"></iframe>
<script>
  window.calls = []; window.contexts = []; window.sizes = 0;
  const FIRST = ${JSON.stringify(JSON.stringify(first))};
  const SECOND = ${JSON.stringify(JSON.stringify(second))};
  const frame = document.getElementById('view');
  const send = (m) => frame.contentWindow.postMessage(m, '*');
  window.addEventListener('message', (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m.method === 'ui/initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: 'test-host', version: '0' }, hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'dark' } } });
    else if (m.method === 'ui/notifications/initialized') {
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { app: 'z2ui5_cl_smp_app_381' } } });
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: FIRST }] } });
    } else if (m.method === 'tools/call') {
      window.calls.push(m.params);
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: SECOND }] } });
    } else if (m.method === 'ui/update-model-context') {
      window.contexts.push(m.params);
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    } else if (m.method === 'ui/notifications/size-changed') window.sizes++;
  });
</script></body></html>`;

test('the real page in Chromium under the default CSP: renders the snapshot, a click is one app_act through the host, no request leaves', async (t) => {
  const browser = await browserOrNull();
  if (!browser) {
    t.skip('no Chromium for Playwright on this machine');
    return;
  }
  const [first, second] = await snapshotsOf('form-381');
  const srv = http.createServer((req, res) => {
    if (req.url === '/view') res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': DEFAULT_CSP }).end(appScreenHtml());
    else if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(HOST(first, second));
    else res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const page = await browser.newPage();
  const problems = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('request', (r) => requests.push(r.url()));
  try {
    await page.goto(`${base}/`);
    const view = page.frameLocator('#view');
    const text = first.fields.find((f) => f.kind === 'text' && f.editable);
    const show = first.actions.find((a) => a.event === 'SHOW');
    await view.locator(`[data-field="${text.id}"]`).fill('typed in the chat');
    await view.locator(`button[data-action="${show.id}"]`).click();
    await page.waitForFunction(() => window.calls.length === 1 && window.contexts.length === 1, null, { timeout: 10000 });
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls[0].name, 'app_act');
    assert.equal(calls[0].arguments.session, first.session);
    assert.equal(calls[0].arguments.event, show.id);
    assert.equal(calls[0].arguments.values[text.id], 'typed in the chat');
    for (const k of Object.keys(calls[0].arguments.values)) assert.ok(first.fields.some((f) => f.id === k && f.editable), `only edited, editable fields go out (${k})`);
    await view.locator('code', { hasText: second.session }).waitFor({ timeout: 10000 });
    assert.equal(await view.locator('html').getAttribute('data-theme'), 'dark', 'the host theme is applied');
    assert.ok(await page.evaluate(() => window.sizes) >= 1, 'the page reports its size');
    assert.deepEqual(problems, [], 'no CSP violation, no script error');
    assert.deepEqual(requests.map((u) => new URL(u).pathname).sort(), ['/', '/view'], 'the page loads nothing else');
  } finally {
    await browser.close();
    srv.close();
  }
});

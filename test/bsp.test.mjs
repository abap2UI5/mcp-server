import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bspRoots, bspIndex, bspKey, bspNames, bspRouteHandler, isBspUrl, BSP_SIBLINGS } from '../lib/bsp.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-'));
  const src = path.join(root, 'src', '01');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'z2ui5_cci.wapa.xml'), '<abapGit/>');
  fs.writeFileSync(path.join(src, 'z2ui5_cci.wapa.cc_-scaninput.js'), 'sap.ui.define([], function () {});');
  fs.writeFileSync(path.join(src, 'z2ui5_cci.wapa.cc_-lib_-gauge.min.js'), '/* lib */');
  fs.writeFileSync(path.join(src, 'z2ui5_cci.wapa.index.html'), '<html></html>');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'zzz.wapa.a.js'), 'ignored');
  return root;
}

test('the index maps the WAPA files by BSP and path, in lower case', () => {
  const root = fixture();
  const index = bspIndex([root]);
  assert.deepEqual([...index.keys()].sort(), ['z2ui5_cci/cc/lib/gauge.min.js', 'z2ui5_cci/cc/scaninput.js', 'z2ui5_cci/index.html']);
  assert.deepEqual(bspNames(index), ['z2ui5_cci']);
});

test('a BSP URL becomes its key, case-insensitive; anything else is null', () => {
  assert.equal(bspKey('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/ScanInput.js'), 'z2ui5_cci/cc/scaninput.js');
  assert.equal(bspKey('http://localhost:3000/sap/bc/ui5_ui5/sap/Z2UI5_CCI/cc/ScanInput.js?x=1'), 'z2ui5_cci/cc/scaninput.js');
  assert.equal(bspKey('http://localhost:3000/sap/bc/z2ui5?app_start=zcl_x'), null);
  // the URL parser resolves dot segments first, and the key only ever names an index entry
  assert.equal(bspKey('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/../secret'), null);
  assert.equal(bspKey('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/%2e%2e/x.js'), 'z2ui5_cci/x.js');
  assert.equal(bspKey('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/%2e%2e%2f..%2fx.js'), null);
  assert.equal(bspKey('not a url'), null);
  assert.equal(isBspUrl(new URL('http://h/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/a.js')), true);
});

function fakeRoute(url) {
  const calls = { continued: false, fulfilled: null };
  return {
    calls,
    request: () => ({ url: () => url }),
    continue: async () => { calls.continued = true; },
    fulfill: async (r) => { calls.fulfilled = r; },
  };
}

test('the handler serves a carried file, 404s a missing one of a carried BSP, passes the rest on', async () => {
  const handler = bspRouteHandler(bspIndex([fixture()]));

  const hit = fakeRoute('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/ScanInput.js');
  await handler(hit);
  assert.equal(hit.calls.fulfilled.status, 200);
  assert.match(hit.calls.fulfilled.contentType, /javascript/);
  assert.equal(String(hit.calls.fulfilled.body), 'sap.ui.define([], function () {});');

  const miss = fakeRoute('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/Nothing.js');
  await handler(miss);
  assert.equal(miss.calls.fulfilled.status, 404);

  const other = fakeRoute('http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_other/a.js');
  await handler(other);
  assert.equal(other.calls.continued, true);

  assert.deepEqual(handler.served, ['z2ui5_cci/cc/scaninput.js']);
  assert.deepEqual(handler.missed, ['z2ui5_cci/cc/nothing.js']);
});

test('roots: the variable is authoritative, else the working directory and the addon siblings', () => {
  const a = fixture();
  const b = fixture();
  const env = { A2UI5_MCP_BSP_DIRS: [a, path.join(a, 'missing'), b].join(path.delimiter) };
  assert.deepEqual(bspRoots({ env, cwd: '/' }), [a, b]);

  const server = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const here = path.join(server, 'mcp-server');
  fs.mkdirSync(here);
  fs.mkdirSync(path.join(server, BSP_SIBLINGS[0]));
  assert.deepEqual(bspRoots({ env: {}, cwd: a, serverRoot: here }), [a, path.join(server, BSP_SIBLINGS[0])]);
});

test('a BSP no root carries is told once and passed on', async () => {
  const told = [];
  const handler = bspRouteHandler(new Map(), { onUnserved: (name, key) => told.push([name, key]) });
  for (const f of ['ScanInput.js', 'FloorPlan.js']) {
    const r = fakeRoute(`http://localhost:3000/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/${f}`);
    await handler(r);
    assert.equal(r.calls.continued, true);
  }
  assert.deepEqual(told, [['z2ui5_cci', 'z2ui5_cci/cc/scaninput.js']]);
});

test('a page is served as a system serves it: the padding off; a binary file as it is', async () => {
  const { bspBody, bspAnswer } = await import('../lib/bsp.mjs');
  // the blank before the line break inside the template literal is gone, as on a system
  const padded = 'const a = `x '.padEnd(255) + '\n' + 'y`;'.padEnd(255);
  assert.equal(String(bspBody('z/a.js', Buffer.from(padded))), 'const a = `x\ny`;');
  const png = Buffer.from([0x89, 0x50, 0x20, 0x20, 0x0a, 0x20]);
  assert.deepEqual(bspBody('z/a.png', png), png);

  const root = fixture();
  fs.writeFileSync(path.join(root, 'src', '01', 'z2ui5_cci.wapa.cc_-pad.js'), 'x();'.padEnd(255) + '\n' + 'y();'.padEnd(255));
  const index = bspIndex([root]);
  const hit = bspAnswer(index, 'http://h/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/Pad.js');
  assert.equal(hit.status, 200);
  assert.equal(String(hit.body), 'x();\ny();');
  assert.equal(bspAnswer(index, 'http://h/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/none.js').status, 404);
  assert.equal(bspAnswer(index, 'http://h/sap/bc/ui5_ui5/sap/z2ui5_xyz/a.js'), null, 'a BSP nobody carries goes on to the backend');
});

test('a folder deploy_folder deployed is a root after the configured ones', async () => {
  const { registerBspRoot, clearBspRoots } = await import('../lib/bsp.mjs');
  const a = fixture();
  const deployed = fixture();
  try {
    registerBspRoot(deployed);
    registerBspRoot(deployed);
    assert.deepEqual(bspRoots({ env: { A2UI5_MCP_BSP_DIRS: a }, cwd: '/' }), [a, deployed]);
  } finally {
    clearBspRoots();
  }
  assert.deepEqual(bspRoots({ env: { A2UI5_MCP_BSP_DIRS: a }, cwd: '/' }), [a]);
});

test('the npm host answers BSP files itself, to any browser, and passes the rest on', async () => {
  const { hostBspServer } = await import('../lib/npm-host.mjs');
  const serve = hostBspServer([fixture()]);
  const hit = serve('/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/ScanInput.js?v=1');
  assert.equal(hit.status, 200);
  assert.match(hit.type, /javascript/);
  assert.equal(serve('/sap/bc/z2ui5?app_start=zcl_x'), null);
  assert.equal(serve('/sap/bc/ui5_ui5/sap/z2ui5_other/a.js'), null);
  assert.equal(hostBspServer([])('/sap/bc/ui5_ui5/sap/z2ui5_cci/cc/ScanInput.js'), null);
});

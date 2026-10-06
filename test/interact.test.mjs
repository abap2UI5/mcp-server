// The pure halves of the three tools that reach past the boot: the action
// script interact_app performs (lib/interact.mjs), the unit-test runner's
// output run_unit_tests parses, and the prebuilt download build_backend
// unpacks - the last one against a tarball built here and served by a local
// http server, so the test never leaves the machine. Sibling-free, apart from
// the one live section at the end, which skips without a built framework
// backend next to this checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { parseActions, cssAttr, ACTIONS, MAX_ACTIONS } from '../lib/interact.mjs';
import { parseUnitOutput, downloadPrebuilt, prebuiltUrl, prebuiltManifest, RUNNER_LOOP, runUnitTests, backendBuilt, PREBUILT_MAX_BYTES } from '../lib/runtime.mjs';
import { resolveA2UI5 } from '../lib/repos.mjs';
import { TOOLS } from '../lib/tools.mjs';

// ---------------------------------------------------------- parseActions ----

test('parseActions normalises a valid script and refuses every malformed one with a sentence', () => {
  const steps = parseActions([
    { action: 'fill', id: 'name', value: 'World' },
    { action: 'click', text: 'Save' },
    { action: 'press', key: 'Enter' },
    { action: 'wait' },
    { action: 'wait', ms: 1200 },
    { action: 'wait', selector: '.sapMMessageToast' },
    { action: 'FILL', selector: 'input', value: '', commit: false },
  ]);
  assert.deepEqual(steps, [
    { action: 'fill', id: 'name', value: 'World', commit: true },
    { action: 'click', text: 'Save' },
    { action: 'press', key: 'Enter' },
    { action: 'wait', ms: 500 },
    { action: 'wait', ms: 1200 },
    { action: 'wait', selector: '.sapMMessageToast' },
    { action: 'fill', selector: 'input', value: '', commit: false },
  ]);
  const refuse = (actions, re) => assert.throws(() => parseActions(actions), re);
  refuse(undefined, /pass `actions`/);
  refuse([], /pass `actions`/);
  refuse('click', /pass `actions`/);
  refuse(Array.from({ length: MAX_ACTIONS + 1 }, () => ({ action: 'wait' })), /at most 30 actions/);
  refuse(['click'], /action 0: must be an object/);
  refuse([{ action: 'hover', id: 'x' }], /unknown action 'hover'/);
  refuse([{ action: 'click' }], /click needs id, selector or text/);
  refuse([{ action: 'click', id: 'a', text: 'b' }], /ONE of id, selector or text/);
  refuse([{ action: 'fill', id: 'a' }], /fill needs `value`/);
  refuse([{ action: 'fill', id: 'a', value: 5 }], /`value` must be a string/);
  refuse([{ action: 'press' }], /press needs `key`/);
  refuse([{ action: 'wait', ms: 0 }], /between 1 and 10000/);
  refuse([{ action: 'wait', ms: 60000 }], /between 1 and 10000/);
  refuse([{ action: 'click', id: 'x'.repeat(201) }], /longer than 200/);
});

test('the tool schema and the parser agree on the action names', () => {
  const tool = TOOLS.find((t) => t.name === 'interact_app');
  assert.deepEqual(tool.inputSchema.properties.actions.items.properties.action.enum, ACTIONS);
});

test('cssAttr escapes what would end an attribute selector early', () => {
  assert.equal(cssAttr('plain-id_1'), 'plain-id_1');
  assert.equal(cssAttr('a"b\\c'), 'a\\"b\\\\c');
});

// ------------------------------------------------------- parseUnitOutput ----

test('parseUnitOutput reads the runner: ran, skipped, and the failure that stopped it', () => {
  const out = [
    'ZCL_APP_001: running ltcl_app->test_init',
    'ZCL_APP_001: running ltcl_app->test_save, skipped due to configuration',
    'Z2UI5_CL_UTIL: running ltcl_time_ops->diff_seconds, skipped due to risk level CRITICAL',
    'ZCL_APP_001: running ltcl_app->test_nav',
    'Error: Different Values, expected "Saved, World", got "Saved, "',
    '    at assert_equals (...)',
  ].join('\n');
  const failed = parseUnitOutput(out, 1);
  assert.equal(failed.ok, false);
  assert.equal(failed.ran, 2);
  assert.equal(failed.skipped, 2);
  assert.equal(failed.tests.length, 4);
  assert.equal(failed.tests[1].skipped, 'due to configuration');
  assert.equal(failed.failed.method, 'test_nav');
  assert.match(failed.failed.error, /^Error: Different Values/);
  const green = parseUnitOutput(out.split('\n').slice(0, 4).join('\n'), 0);
  assert.equal(green.ok, true);
  assert.equal(green.failed, null);
  // a run that died before any test: nothing ran, no failing test to name
  const dead = parseUnitOutput('SyntaxError: unexpected token', 1);
  assert.equal(dead.ran, 0);
  assert.equal(dead.failed, null);
});

/* The generated runner prints "<OBJ>: running <class>-><method>" AFTER the
 * test class's constructor and setup ran (and class_setup runs before any
 * such line of its class), so a failing setup or class_setup used to be
 * pinned on the test whose line came last: another class's PASSING test was
 * reported failed, and the class whose fixture failed looked like one without
 * test methods. The stack names the fixture that threw (these are the
 * shapes the published runtime prints). */
const APPS = 'file:///ws/runtime/1.145.0/apps';
test('a failing setup or class_setup is the failure of its own class, not of the test before it', () => {
  const setupNext = parseUnitOutput([
    'ZCL_R3_UA: running ltcl_ok->passes',
    '<ref *1> cx_sy_zerodivide [Error]',
    '    at throwError (/ws/runtime/1.145.0/node_modules/@abaplint/runtime/build/src/throw_error.js:15:15)',
    '    at Object.divide (/ws/runtime/1.145.0/node_modules/@abaplint/runtime/build/src/operators/divide.js:29:42)',
    `    at #setup (${APPS}/zcl_r3_ub.clas.testclasses.mjs:36:31)`,
    `    at run (${APPS}/index.mjs:38:84) {`,
    '}',
  ].join('\n'), 1);
  assert.equal(setupNext.failed.object, 'ZCL_R3_UB', 'the class whose setup threw');
  assert.equal(setupNext.failed.method, 'setup');
  assert.equal(setupNext.failed.fixture, true);
  assert.match(setupNext.failed.error, /cx_sy_zerodivide/);
  assert.deepEqual(setupNext.tests.map((t) => t.method), ['passes'], 'the passing test stays a passing test');

  const classSetup = parseUnitOutput([
    '<ref *1> cx_sy_zerodivide [Error]',
    `    at ltcl_x.class_setup (${APPS}/zcl_r3_ue.clas.testclasses.mjs:31:26)`,
    `    at run (${APPS}/index-mcp-zcl_r3_ue.mjs:31:50) {`,
  ].join('\n'), 1);
  assert.deepEqual([classSetup.failed.object, classSetup.failed.localClass, classSetup.failed.method], ['ZCL_R3_UE', 'ltcl_x', 'class_setup']);

  // a second method's setup, in the same class: not the first method's failure either
  const sameClass = parseUnitOutput([
    'ZCL_A: running ltcl_a->first',
    'Error: boom',
    `    at ltcl_a.setup (${APPS}/zcl_a.clas.testclasses.mjs:9:11)`,
  ].join('\n'), 1);
  assert.deepEqual([sameClass.failed.object, sameClass.failed.method, sameClass.failed.fixture], ['ZCL_A', 'setup', true]);

  // a failure inside the test - an assertion, or a helper of the test class - stays the test's
  const assertion = parseUnitOutput([
    'ZCL_R3_UC: running ltcl_x->t1',
    '<ref *1> kernel_cx_assert [Error]',
    '    at cl_abap_unit_assert.assert_equals (file:///ws/runtime/1.145.0/node_modules/@abap2ui5/node-runtime/output/cl_abap_unit_assert.clas.mjs:412:32)',
    `    at async #t1 (${APPS}/zcl_r3_uc.clas.testclasses.mjs:24:5)`,
    `    at async run (${APPS}/index-mcp-zcl_r3_uc.mjs:46:9) {`,
  ].join('\n'), 1);
  assert.deepEqual([assertion.failed.object, assertion.failed.method, assertion.failed.fixture], ['ZCL_R3_UC', 't1', undefined]);
  const helper = parseUnitOutput([
    'ZCL_A: running ltcl_a->first',
    'Error: boom',
    `    at #build_client (${APPS}/zcl_a.clas.testclasses.mjs:40:11)`,
    `    at async #first (${APPS}/zcl_a.clas.testclasses.mjs:12:5)`,
  ].join('\n'), 1);
  assert.equal(helper.failed.method, 'first');
  // no stack at all: as before, the test that was running
  assert.equal(parseUnitOutput('ZCL_A: running ltcl_a->first\nError: boom', 1).failed.method, 'first');
});

test('run_unit_tests names the class whose setup failed deep in the code under test', { skip: process.platform === 'win32' && 'POSIX paths in the fake runner' }, async () => {
  /* A runner of the transpiler's shape: the running line after the setup.
   * ZCL_B's setup calls 20 levels deep into its class under test - past V8's
   * default of ten frames, which would cut the #setup frame off the stack
   * and with it the attribution. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-runner-'));
  const apps = path.join(dir, 'apps-unit-x');
  fs.mkdirSync(apps);
  try {
    fs.writeFileSync(path.join(apps, 'init.mjs'), '');
    fs.writeFileSync(path.join(apps, 'zcl_b.clas.mjs'), 'export async function deep(n) { if (!n) throw new Error("deep boom"); await deep(n - 1); }\n');
    fs.writeFileSync(path.join(apps, 'zcl_a.clas.testclasses.mjs'), 'export class ltcl_a { async constructor_() { return this; } async passes() {} }\n');
    fs.writeFileSync(path.join(apps, 'zcl_b.clas.testclasses.mjs'), 'import { deep } from "./zcl_b.clas.mjs";\nexport class ltcl_b { async constructor_() { return this; } async setup() { await deep(20); } async first() {} }\n');
    fs.writeFileSync(path.join(apps, 'index.mjs'), [
      'import "./init.mjs";',
      'function getData() {',
      '  const ret = [];',
      '  ret.push({objectName: "ZCL_A", localClass: "ltcl_a", methods: [{"name":"passes","skip":false}], filename: "./zcl_a.clas.testclasses.mjs"});',
      '  ret.push({objectName: "ZCL_B", localClass: "ltcl_b", methods: [{"name":"first","skip":false}], filename: "./zcl_b.clas.testclasses.mjs"});',
      '  return ret;',
      '}',
      'async function run() {',
      `  ${RUNNER_LOOP}`,
      '    const imported = await import(st.filename);',
      '    const localClass = imported[st.localClass];',
      '    for (const m of st.methods) {',
      '      const prefix = st.objectName + ": running " + st.localClass + "->" + m.name;',
      '      const test = await (new localClass()).constructor_();',
      '      if (test.setup) await test.setup();',
      '      console.log(prefix);',
      '      await test[m.name]();',
      '    }',
      '  }',
      '}',
      'run().then(() => process.exit(0)).catch((err) => { console.log(err); process.exit(1); });',
    ].join('\n'));
    const res = await runUnitTests({ classNames: ['zcl_a', 'zcl_b'], appsDir: apps });
    assert.equal(res.ok, false);
    assert.deepEqual(res.tests.map((t) => `${t.object} ${t.method}`), ['ZCL_A passes']);
    assert.equal(res.failed && res.failed.object, 'ZCL_B', JSON.stringify(res.failed));
    assert.equal(res.failed.method, 'setup');
    assert.match(res.failed.error, /deep boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner loop this server filters on is the one the transpiler writes', () => {
  /* The line is @abaplint/transpiler's unit_test.js template, quoted here so a
   * template change upstream fails this test rather than silently costing
   * every filtered run its filter (run_unit_tests then runs the whole tree
   * and says so). */
  assert.equal(RUNNER_LOOP, 'for (const st of getData()) {');
});

// ------------------------------------------------------ downloadPrebuilt ----

const HAVE_TAR = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A checkout-shaped temp dir with a package.json version and (as the served
 *  archive) node/output, node/downport, node/deps and a manifest. */
function fakeCheckoutAndArchive(version, { manifest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-prebuilt-test-'));
  const a2 = path.join(root, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node_modules', 'express'), { recursive: true }); // no npm ci in a test
  fs.writeFileSync(path.join(a2, 'package.json'), JSON.stringify({ name: 'abap2UI5', version }));
  fs.mkdirSync(path.join(a2, 'node/output'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node/output/stale.mjs'), 'stale'); // a previous build's leftover
  const src = path.join(root, 'src');
  for (const d of ['node/output', 'node/downport', 'node/deps/open-abap-core/src']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'node/output/init.mjs'), 'export const init = 1;');
  fs.writeFileSync(path.join(src, 'node/output/index.mjs'), `${RUNNER_LOOP}}`);
  fs.writeFileSync(path.join(src, 'node/downport/z2ui5_cl_x.clas.abap'), 'CLASS z2ui5_cl_x DEFINITION.');
  fs.writeFileSync(path.join(src, 'node/deps/open-abap-core/src/x.clas.abap'), '');
  if (manifest) {
    fs.writeFileSync(path.join(src, 'backend-manifest.json'), JSON.stringify({ version, commit: 'abc123', builtAt: '2026-09-19T00:00:00Z', contents: ['node/downport', 'node/output', 'node/deps'] }));
  }
  const tar = path.join(root, `backend-${version}.tar.gz`);
  execFileSync('tar', ['-czf', tar, '-C', src, '.']);
  return { root, a2, tar };
}

function serve(file, { status = 200, chunked = false } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (status !== 200 || !fs.existsSync(file)) {
        res.writeHead(status === 200 ? 404 : status).end('nope');
        return;
      }
      const body = fs.readFileSync(file);
      // chunked: no content-length, the size is only known by reading it
      res.writeHead(200, { 'content-type': 'application/gzip', ...(chunked ? {} : { 'content-length': body.length }) }).end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/backend.tar.gz` }));
  });
}

test('prebuiltUrl follows the framework release, or the override', () => {
  assert.equal(prebuiltUrl('1.144.0'), 'https://github.com/abap2UI5/abap2UI5/releases/download/1.144.0/backend-1.144.0.tar.gz');
  process.env.A2UI5_MCP_PREBUILT_URL = 'http://example.test/x.tar.gz';
  try {
    assert.equal(prebuiltUrl('1.144.0'), 'http://example.test/x.tar.gz');
  } finally {
    delete process.env.A2UI5_MCP_PREBUILT_URL;
  }
});

test('downloadPrebuilt unpacks the archive over the old build and reads the manifest', { skip: !HAVE_TAR && 'needs tar on PATH' }, async () => {
  const { root, a2, tar } = fakeCheckoutAndArchive('1.144.0');
  const { srv, url } = await serve(tar);
  process.env.A2UI5_MCP_PREBUILT_URL = url;
  const lines = [];
  try {
    const res = await downloadPrebuilt({ a2, onLine: (l) => lines.push(l), timeoutMs: 60000 });
    assert.equal(res.ok, true, lines.join('\n'));
    assert.equal(res.manifest.commit, 'abc123');
    assert.ok(fs.existsSync(path.join(a2, 'node/output/init.mjs')));
    assert.ok(fs.existsSync(path.join(a2, 'node/downport/z2ui5_cl_x.clas.abap')));
    assert.ok(fs.existsSync(path.join(a2, 'node/deps/open-abap-core/src')));
    assert.ok(!fs.existsSync(path.join(a2, 'node/output/stale.mjs')), 'the previous build is removed before unpacking');
    assert.equal(prebuiltManifest(a2).version, '1.144.0');
    assert.ok(lines.some((l) => /fetching http:\/\/127\.0\.0\.1/.test(l)));
    assert.ok(lines.some((l) => /unpacked into/.test(l)));
    assert.ok(!fs.existsSync(path.join(a2, 'node_modules', 'express', 'package.json')), 'npm ci is skipped when express is there');
  } finally {
    delete process.env.A2UI5_MCP_PREBUILT_URL;
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('downloadPrebuilt reports a missing asset and a manifest-less archive instead of throwing', { skip: !HAVE_TAR && 'needs tar on PATH' }, async () => {
  const missing = fakeCheckoutAndArchive('9.9.9');
  const { srv, url } = await serve(missing.tar, { status: 404 });
  process.env.A2UI5_MCP_PREBUILT_URL = url;
  const lines = [];
  try {
    const res = await downloadPrebuilt({ a2: missing.a2, onLine: (l) => lines.push(l), timeoutMs: 60000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'HTTP 404');
    assert.ok(lines.some((l) => /carries no backend-9\.9\.9\.tar\.gz/.test(l)), lines.join('\n'));
    assert.ok(fs.existsSync(path.join(missing.a2, 'node/output/stale.mjs')), 'a failed download leaves the previous build alone');
  } finally {
    srv.close();
    fs.rmSync(missing.root, { recursive: true, force: true });
  }
  const bare = fakeCheckoutAndArchive('1.0.0', { manifest: false });
  const served = await serve(bare.tar);
  process.env.A2UI5_MCP_PREBUILT_URL = served.url;
  try {
    const res = await downloadPrebuilt({ a2: bare.a2, onLine: () => {}, timeoutMs: 60000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no manifest');
  } finally {
    delete process.env.A2UI5_MCP_PREBUILT_URL;
    served.srv.close();
    fs.rmSync(bare.root, { recursive: true, force: true });
  }
});

/* The download was bounded by the build timeout only: a proxy or mirror
 * answering with an endless body filled the temp disk for half an hour. It
 * stops at PREBUILT_MAX_BYTES (200 MB, the real asset is 2.7 MB) - a
 * declared size over it is refused unread, a streamed one cut - and the
 * previous build stays. */
test('downloadPrebuilt stops at the size cap and leaves the previous build alone', { skip: !HAVE_TAR && 'needs tar on PATH' }, async () => {
  assert.equal(PREBUILT_MAX_BYTES, 200 * 1024 * 1024);
  for (const chunked of [false, true]) {
    const { root, a2, tar } = fakeCheckoutAndArchive('1.144.0');
    const size = fs.statSync(tar).size;
    const { srv, url } = await serve(tar, { chunked });
    process.env.A2UI5_MCP_PREBUILT_URL = url;
    const lines = [];
    try {
      const over = await downloadPrebuilt({ a2, onLine: (l) => lines.push(l), timeoutMs: 60000, maxBytes: size - 1 });
      assert.equal(over.ok, false, `chunked ${chunked}: ${lines.join('\n')}`);
      assert.match(over.reason, /the answer for http:\/\/127\.0\.0\.1:\d+\/backend\.tar\.gz is larger than/);
      assert.ok(lines.some((l) => /prebuilt backend: the answer for .* is larger than .* stopped reading it/.test(l)), lines.join('\n'));
      assert.ok(fs.existsSync(path.join(a2, 'node/output/stale.mjs')), 'the previous build is left alone');
      assert.ok(!fs.existsSync(path.join(a2, 'backend-manifest.json')));
      // exactly at the cap is still the archive
      const fits = await downloadPrebuilt({ a2, onLine: () => {}, timeoutMs: 60000, maxBytes: size });
      assert.equal(fits.ok, true);
    } finally {
      delete process.env.A2UI5_MCP_PREBUILT_URL;
      srv.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('downloadPrebuilt is cancelled by the signal', { skip: !HAVE_TAR && 'needs tar on PATH' }, async () => {
  const { root, a2, tar } = fakeCheckoutAndArchive('1.144.0');
  const { srv, url } = await serve(tar);
  process.env.A2UI5_MCP_PREBUILT_URL = url;
  try {
    const ac = new AbortController();
    ac.abort();
    const res = await downloadPrebuilt({ a2, onLine: () => {}, signal: ac.signal, timeoutMs: 60000 });
    assert.equal(res.ok, false);
    assert.equal(res.aborted, true);
  } finally {
    delete process.env.A2UI5_MCP_PREBUILT_URL;
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- live unit tests ----

/* The one section that needs a sibling: a framework checkout with a built
 * backend (node/output/index.mjs). Skipped elsewhere; in a workspace where
 * the framework was transpiled it proves the filtered runner end to end on a
 * class the framework itself ships tests for. */
const A2 = resolveA2UI5({ local: true });
const HAVE_BUILT = Boolean(A2 && backendBuilt() && fs.existsSync(path.join(A2, 'node/output/index.mjs')));

test('run_unit_tests runs one object\'s test classes in the transpiled backend', { skip: !HAVE_BUILT && 'no built framework backend next to this checkout' }, async () => {
  const res = await runUnitTests({ className: 'z2ui5_cl_pop_to_confirm' });
  assert.equal(res.filtered, true);
  assert.equal(res.class, 'Z2UI5_CL_POP_TO_CONFIRM');
  assert.equal(res.ok, true, JSON.stringify(res.failed));
  assert.ok(res.ran > 0);
  assert.ok(res.tests.every((t) => t.object === 'Z2UI5_CL_POP_TO_CONFIRM'));
  assert.ok(!fs.existsSync(path.join(A2, 'node/output/index-mcp-z2ui5_cl_pop_to_confirm.mjs')), 'the filtered runner is removed again');
  const none = await runUnitTests({ className: 'zcl_no_such_app' });
  assert.equal(none.tests.length, 0);
  assert.equal(none.ok, true);
});

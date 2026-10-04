// The whole loop on the npm backend, for real: @abap2ui5/node-runtime from the
// registry (its latest release, the way a fresh machine gets it), the
// transpiler and abaplint it pins, open-abap-core fetched with git at the
// release's commit - then a hello-world app with a test class: deploy + lint,
// build, its unit tests, the backend booted, an HTTP GET of the page and a
// POST roundtrip that starts the app and returns its view.
//
// SKIPPED BY ITSELF when the npm registry or GitHub cannot be reached (and
// with A2UI5_MCP_SKIP_NETWORK_TESTS=1): everything else in `npm test` is
// network-free, this is the one test that proves the recipe against what is
// actually published. It uses a workspace of its own (a temp dir), so it
// installs cold every run; npm's own cache makes the second run cheaper.
// What it cannot see is the page RENDERING in a browser - that needs the UI5
// CDN (run_app's half); the GET and the POST are the backend's half.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeTemplate } from './helpers/npm-fixture.mjs';

const PORT = 4441;

function reachable() {
  if (process.env.A2UI5_MCP_SKIP_NETWORK_TESTS) return 'A2UI5_MCP_SKIP_NETWORK_TESTS is set';
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', '@abap2ui5/node-runtime', 'version', '--json'], {
    encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32',
  });
  if (npm.status !== 0) return `the npm registry cannot be reached (${(npm.stderr || npm.error || '').toString().trim().split('\n').pop()})`;
  const git = spawnSync('git', ['ls-remote', 'https://github.com/open-abap/open-abap-core', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  if (git.status !== 0) return `GitHub cannot be reached with git (${(git.stderr || git.error || '').toString().trim().split('\n').pop()})`;
  return null;
}

const skip = reachable();

const APP_SOURCE = `CLASS zcl_hello_mcp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
ENDCLASS.

CLASS zcl_hello_mcp IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    IF client->check_on_init( ).
      name = \`World\`.
      DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
          )->ele( n  = \`View\`
                  ns = \`mvc\`
              )->a( n = \`xmlns\`     v = \`sap.m\`
              )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
              )->ele( \`Page\`
                  )->a( n = \`title\` v = \`Hello from the MCP loop\`
                  )->tag( \`Input\`
                      )->a( n = \`value\` v = client->_bind( name ) ).
      client->view_display( view->stringify( ) ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
`;

const TEST_SOURCE = `CLASS ltd_client DEFINITION FINAL FOR TESTING.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_client PARTIALLY IMPLEMENTED.
    DATA views TYPE string_table.
ENDCLASS.

CLASS ltd_client IMPLEMENTATION.
  METHOD z2ui5_if_client~check_on_init.
    result = abap_true.
  ENDMETHOD.
  METHOD z2ui5_if_client~view_display.
    APPEND val TO views.
  ENDMETHOD.
  METHOD z2ui5_if_client~_bind.
    result = \`{/NAME}\`.
  ENDMETHOD.
ENDCLASS.

CLASS ltcl_hello DEFINITION FINAL FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS first_call_displays_the_view FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_hello IMPLEMENTATION.
  METHOD first_call_displays_the_view.
    DATA(app) = NEW zcl_hello_mcp( ).
    DATA(client) = NEW ltd_client( ).
    app->z2ui5_if_app~main( client ).
    cl_abap_unit_assert=>assert_equals( exp = 1
                                        act = lines( client->views ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( client->views[ 1 ] CS \`Hello from the MCP loop\` ) ).
    cl_abap_unit_assert=>assert_equals( exp = \`World\`
                                        act = app->name ).
  ENDMETHOD.
ENDCLASS.
`;

test('deploy, build, unit tests, boot and a roundtrip on the published @abap2ui5/node-runtime', { skip: skip || false, timeout: 15 * 60_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-npm-it-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    A2UI5_MCP_PORT: String(PORT),
    A2UI5_MCP_BACKEND: 'npm',
    A2UI5_MCP_WORKSPACE: path.join(base, 'workspace'),
    SAMPLES_CONTROLS_HOME: path.join(base, 'no-corpus'),
    APP_TEMPLATE_HOME: fakeTemplate(path.join(base, 'app-template')),
    A2UI5_MCP_REMOTE: '0',
    A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'),
  });
  delete process.env.A2UI5_MCP_RUNTIME_VERSION;
  delete process.env.AI_DEMOKIT_HOME;
  delete process.env.A2UI5_MCP_OFFLINE;
  const rt = await import('../lib/runtime.mjs');
  const npm = await import('../lib/npm-backend.mjs');
  const timings = {};
  const timed = async (label, fn) => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings[label] = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
    }
  };
  const log = [];
  try {
    // deploy + the lint a real project runs - which installs the runtime (cold)
    rt.deployApp({ className: 'zcl_hello_mcp', source: APP_SOURCE, testclasses: TEST_SOURCE });
    const lint = await timed('lint, installing the runtime (cold)', () => rt.lintApp('zcl_hello_mcp', { onLine: (l) => log.push(l) }));
    assert.equal(lint.ok, true, `lint: ${JSON.stringify(lint.issues)}\n${log.slice(-20).join('\n')}`);

    const built = await timed('build_backend (open-abap-core fetched, transpile)', () => rt.buildBackend({ mode: 'auto', onLine: (l) => log.push(l) }));
    assert.equal(built.ok, true, `build:\n${built.tail}`);
    assert.equal(built.mode, 'npm');
    const status = npm.npmStatus();
    t.diagnostic(`release ${status.version} (${status.versionSource}), transpiler ${status.transpiler}, express ${status.express}, abaplint ${status.abaplintCli.version}, open-abap-core ${status.openAbapCore.sha} (${status.openAbapCore.source})`);
    const apps = fs.readdirSync(npm.appsDir(status.dir));
    assert.deepEqual(apps.filter((f) => f.endsWith('.mjs')).sort(), ['index.mjs', 'init.mjs', 'zcl_hello_mcp.clas.mjs', 'zcl_hello_mcp.clas.testclasses.mjs']);

    const unit = await timed('run_unit_tests', () => rt.runUnitTests({ className: 'zcl_hello_mcp' }));
    assert.equal(unit.ok, true, `unit: ${JSON.stringify(unit)}`);
    assert.deepEqual(unit.tests.map((x) => `${x.object} ${x.localClass}->${x.method}`), ['ZCL_HELLO_MCP ltcl_hello->first_call_displays_the_view']);

    const warm = await timed('build_backend again (warm: transpile only)', () => rt.buildBackend({ mode: 'auto' }));
    assert.equal(warm.ok, true, warm.tail);

    await timed('backend start', () => rt.startBackend());
    try {
      const page = await fetch(`http://127.0.0.1:${PORT}/`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /z2ui5/, 'the framework\'s page');
      const post = await fetch(`http://127.0.0.1:${PORT}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: { S_FRONT: { ORIGIN: `http://127.0.0.1:${PORT}`, PATHNAME: '/', SEARCH: '?app_start=zcl_hello_mcp' } } }),
      });
      const answer = await post.json();
      assert.equal(answer.S_FRONT.APP, 'ZCL_HELLO_MCP', JSON.stringify(answer).slice(0, 400));
      assert.match(JSON.stringify(answer), /Hello from the MCP loop/, 'the app\'s view came back');
      assert.equal(answer.MODEL && answer.MODEL.NAME, 'World', 'and its bound data');
    } finally {
      await rt.stopBackend();
    }
    t.diagnostic(`timings: ${JSON.stringify(timings)}`);
  } finally {
    await rt.stopBackend().catch(() => {});
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* A sandbox table, for real: test/fixtures/table-app is a project with a
 * transparent table (ZMCP_NOTE), a data element and a class whose unit test
 * INSERTs two rows and SELECTs them back. abap2ui5-unit deploys it on the
 * published package - the table must exist in the runtime's database before
 * the class runs, which only apps/init.mjs's CREATE TABLE makes true. */
test('a sandbox table: abap2ui5-unit runs a class that INSERTs into and SELECTs from it', { skip: skip || false, timeout: 15 * 60_000 }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-npm-tabl-'));
  try {
    const project = path.join(base, 'project');
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'table-app'), project, { recursive: true });
    const env = { ...process.env, A2UI5_MCP_BACKEND: 'npm', A2UI5_MCP_WORKSPACE: path.join(base, 'workspace'), A2UI5_MCP_REMOTE: '0', SAMPLES_CONTROLS_HOME: path.join(base, 'no-corpus') };
    delete env.A2UI5_MCP_RUNTIME_VERSION;
    const run = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-unit.mjs'), 'src', '--json'], {
      cwd: project, env, encoding: 'utf8', timeout: 14 * 60_000,
    });
    assert.equal(run.status, 0, `abap2ui5-unit exited ${run.status}:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr + run.stdout, /creates the table\(s\) zmcp_note at boot/);
    const report = JSON.parse(run.stdout);
    const tests = report.results.flatMap((r) => r.tests || []);
    assert.deepEqual(tests.map((t) => `${t.object} ${t.localClass}->${t.method} ${t.ok === false ? 'FAIL' : 'ok'}`), ['ZCL_MCP_NOTES ltcl_notes->insert_and_select ok']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

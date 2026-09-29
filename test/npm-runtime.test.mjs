// The npm backend wired into the tools (lib/runtime.mjs): which backend is in
// use, the sandbox's third home, the lint against the package's downport/,
// build_backend on the package, the unit tests of the dev apps alone, and
// what setup_status says. Against the fake workspace of
// test/helpers/npm-fixture.mjs - nothing reaches the registry or git (the real
// loop is test/npm-integration.test.mjs). A2UI5_MCP_BACKEND=npm chooses the
// npm backend even though this repository's siblings may carry a framework
// checkout; the release is pinned, so no registry is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideBackend, backendKind, sandbox, deployApp, removeApp, readAppSource, listDevApps, lintApp, buildBackend,
  backendBuilt, runUnitTests, setupStatus, backendStatus, frameworkLintConfig, npmLintTarget, npmModeProblem, planBuild,
} from '../lib/runtime.mjs';
import { resetNpmBackend, appsDir } from '../lib/npm-backend.mjs';
import { fakeRelease, fakeTemplate, APP, TESTS, VERSION, CORE_SHA } from './helpers/npm-fixture.mjs';

const ENV = [
  'A2UI5_MCP_BACKEND', 'A2UI5_MCP_WORKSPACE', 'A2UI5_MCP_RUNTIME_VERSION', 'A2UI5_HOME', 'SAMPLES_CONTROLS_HOME',
  'AI_DEMOKIT_HOME', 'APP_TEMPLATE_HOME', 'A2UI5_MCP_REMOTE', 'A2UI5_MCP_OFFLINE', 'LINT_RECORD', 'A2UI5_MCP_SCREENSHOT_DIR',
];

function withNpm(fn, { install = true } = {}) {
  return async (t) => {
    const saved = Object.fromEntries(ENV.map((v) => [v, process.env[v]]));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-npm-rt-'));
    const workspace = path.join(root, 'workspace');
    process.env.A2UI5_MCP_BACKEND = 'npm';
    process.env.A2UI5_MCP_WORKSPACE = workspace;
    process.env.A2UI5_MCP_RUNTIME_VERSION = VERSION;
    process.env.SAMPLES_CONTROLS_HOME = path.join(root, 'no-corpus');
    process.env.APP_TEMPLATE_HOME = fakeTemplate(path.join(root, 'app-template'));
    process.env.A2UI5_MCP_REMOTE = '0';
    process.env.A2UI5_MCP_SCREENSHOT_DIR = path.join(root, 'shots'); // the build log lands here
    delete process.env.AI_DEMOKIT_HOME;
    delete process.env.A2UI5_MCP_OFFLINE;
    resetNpmBackend();
    const dir = install ? fakeRelease(workspace) : path.join(workspace, 'runtime', VERSION);
    try {
      await fn(t, { root, workspace, dir });
    } finally {
      resetNpmBackend();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('which backend: a checkout wins, a broken A2UI5_HOME is reported, nothing at all is the npm backend', () => {
  assert.equal(decideBackend({ checkout: true }), 'checkout');
  assert.equal(decideBackend({}), 'npm', 'no checkout, nothing configured: the package, not a clone');
  assert.equal(decideBackend({ envSet: true }), 'missing', 'A2UI5_HOME pointing nowhere is never built around');
  assert.equal(decideBackend({ preference: 'npm', checkout: true }), 'npm', 'A2UI5_MCP_BACKEND=npm beside a checkout');
  assert.equal(decideBackend({ preference: 'npm', envSet: true }), 'npm');
  assert.equal(decideBackend({ preference: 'clone' }), 'clone', 'the old default, chosen explicitly');
  assert.equal(decideBackend({ preference: 'clone', checkout: true }), 'checkout', 'once cloned, the clone is a checkout');
});

/* Which build a mode asks for, per backend - the resolution order of
 * build_backend in one table. What is there: `npm` - nothing (the npm
 * backend is in use); `checkout` - a framework checkout, built or not;
 * `missing` - A2UI5_HOME pointing nowhere; `clone` - A2UI5_MCP_BACKEND=clone
 * and nothing cloned yet. */
test('build_backend\'s modes resolve per backend: npm by default, the clone only when asked, the checkout as before', () => {
  const at = {
    npm: { kind: 'npm', canClone: true },
    checkout: { kind: 'checkout', a2: '/co/abap2UI5' },
    built: { kind: 'checkout', a2: '/co/abap2UI5', canIncrement: true },
    missing: { kind: 'missing', envName: 'A2UI5_HOME' },
    clone: { kind: 'clone', canClone: true },
  };
  const plan = (mode, where, extra = {}) => planBuild({ mode, ...at[where], ...extra });
  // auto
  assert.deepEqual(plan('auto', 'npm'), { effective: 'npm' }, 'nothing there: the package, not a clone');
  assert.deepEqual(plan('auto', 'checkout'), { effective: 'prebuilt' });
  assert.deepEqual(plan('auto', 'built'), { effective: 'incremental' });
  assert.deepEqual(plan('auto', 'clone'), { effective: 'prebuilt' }, 'A2UI5_MCP_BACKEND=clone: the old default, which clones');
  assert.equal(plan('auto', 'missing').effective, 'full', 'A2UI5_HOME pointing nowhere is never built around');
  assert.match(plan('auto', 'missing').problem, /a full build runs samples-controls/);
  assert.deepEqual(plan('auto', 'missing', { corpus: '/co/samples-controls' }), { effective: 'full' });
  // npm
  assert.deepEqual(plan('npm', 'npm'), { effective: 'npm' });
  assert.match(plan('npm', 'checkout').problem, /\/co\/abap2UI5 is the backend in use.*A2UI5_MCP_BACKEND=npm/);
  assert.match(plan('npm', 'missing').problem, /A2UI5_HOME is set and points at no abap2UI5 checkout/);
  assert.match(plan('npm', 'clone').problem, /A2UI5_MCP_BACKEND=clone chooses the framework clone/);
  // incremental
  assert.deepEqual(plan('incremental', 'npm'), { effective: 'npm' }, 'the npm build is incremental by nature');
  assert.deepEqual(plan('incremental', 'built'), { effective: 'incremental' });
  assert.match(plan('incremental', 'checkout').problem, /needs a prior build/);
  assert.match(plan('incremental', 'missing').problem, /abap2UI5 checkout not found \(A2UI5_HOME is set/);
  // prebuilt and transpile: the explicit ways to the clone
  assert.deepEqual(plan('prebuilt', 'npm'), { effective: 'prebuilt' }, 'clones, then downloads the asset');
  assert.deepEqual(plan('transpile', 'npm'), { effective: 'transpile' }, 'clones, then builds the framework');
  assert.deepEqual(plan('transpile', 'checkout'), { effective: 'transpile' });
  assert.match(plan('prebuilt', 'missing').problem, /checkout not found/);
  assert.match(plan('transpile', 'missing').problem, /checkout not found/);
  // full is the corpus' script, whatever else is there
  assert.match(plan('full', 'npm').problem, /a full build runs samples-controls/);
  assert.deepEqual(plan('full', 'built', { corpus: '/co/samples-controls' }), { effective: 'full' });
});

test('the npm sandbox is the workspace\'s, and deploy, list, read and remove work in it', withNpm(async (t, { workspace, dir }) => {
  assert.equal(backendKind(), 'npm');
  const box = sandbox();
  assert.deepEqual(box, { kind: 'npm', root: workspace, dir: path.join(workspace, 'sandbox') });
  const res = deployApp({ className: 'zcl_npm_app', source: APP('zcl_npm_app'), testclasses: TESTS() });
  assert.equal(res.abapPath, path.join(workspace, 'sandbox', 'zcl_npm_app.clas.abap'));
  assert.deepEqual(listDevApps(), ['zcl_npm_app']);
  const read = readAppSource('zcl_npm_app');
  assert.equal(read.found, true);
  assert.equal(read.staleInBackend, null, 'nothing built on the release yet: unknown, not fresh');
  // a build older than the deploy: stale; newer: carried
  fs.mkdirSync(appsDir(dir), { recursive: true });
  const init = path.join(appsDir(dir), 'init.mjs');
  fs.writeFileSync(init, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(init, old, old);
  assert.equal(readAppSource('zcl_npm_app').staleInBackend, true);
  const newer = new Date(Date.now() + 60_000);
  fs.utimesSync(init, newer, newer);
  assert.equal(readAppSource('zcl_npm_app').staleInBackend, false);
  assert.equal(removeApp('zcl_npm_app'), 3);
  assert.deepEqual(listDevApps(), []);
}));

test('the npm sandbox lints with app-template\'s config against the release\'s downport/', withNpm(async (t, { root, workspace }) => {
  const record = path.join(root, 'lint.json');
  process.env.LINT_RECORD = record;
  deployApp({ className: 'zcl_lint_me', source: APP('zcl_lint_me') });
  const res = await lintApp('zcl_lint_me');
  assert.equal(res.ok, true, JSON.stringify(res));
  const { cwd, config } = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(workspace), 'the config sits in, and abaplint runs from, the workspace');
  assert.equal(config.global.files, '/sandbox/**/*.*');
  assert.deepEqual(config.dependencies, [{ folder: `/runtime/${VERSION}/node_modules/@abap2ui5/node-runtime/downport`, files: '/**/*.*' }]);
  assert.equal(config.rules.object_naming.clas, '^[ZY]');
  assert.equal(config.syntax.version, 'v750', 'the rest is the template\'s');
  assert.ok(!fs.existsSync(path.join(workspace, '.abaplint-mcp-dev.jsonc')), 'the config is removed after the lint');
  // the pure half
  const target = npmLintTarget({ root: '/ws', dir: '/ws/sandbox' }, `/ws/runtime/${VERSION}`);
  assert.deepEqual(target, { files: '/sandbox/**/*.*', folder: `/runtime/${VERSION}/node_modules/@abap2ui5/node-runtime/downport` });
  assert.deepEqual(frameworkLintConfig('{"rules":{}}', target).dependencies, [{ folder: target.folder, files: '/**/*.*' }]);
}));

test('without the runtime installed the lint says what is missing instead of guessing', { skip: process.platform === 'win32' && 'a POSIX npm stand-in' }, withNpm(async () => {
  // pinned to a release that is not installed, with the registry unreachable through a failing npm
  process.env.A2UI5_MCP_RUNTIME_VERSION = '1.145.1';
  deployApp({ className: 'zcl_lint_me', source: APP('zcl_lint_me') });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-nonpm-'));
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho \'{"error":{"code":"ENOTFOUND","summary":"getaddrinfo ENOTFOUND registry.npmjs.org"}}\'\nexit 1\n');
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    const res = await lintApp('zcl_lint_me');
    assert.equal(res.ok, false);
    assert.equal(res.issues[0].rule, 'runtime-missing');
    assert.match(res.issues[0].message, /@abap2ui5\/node-runtime@1\.145\.1 could not be looked up: getaddrinfo ENOTFOUND/);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}));

test('build_backend on the package: the sandbox transpiled, the dev tests run alone, a removed app pruned', withNpm(async (t, { workspace, dir }) => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a'), testclasses: TESTS() });
  deployApp({ className: 'zcl_npm_b', source: APP('zcl_npm_b'), testclasses: TESTS(true) });
  assert.equal(backendBuilt(), false);
  const lines = [];
  const res = await buildBackend({ mode: 'auto', onLine: (l) => lines.push(l) });
  assert.equal(res.ok, true, res.tail);
  assert.equal(res.mode, 'npm', 'auto, with the npm backend in use');
  assert.equal(res.runtime, VERSION);
  assert.ok(lines.some((l) => /@abap2ui5\/node-runtime 1\.145\.0 \(A2UI5_MCP_RUNTIME_VERSION\)/.test(l)), lines.join('\n'));
  assert.equal(backendBuilt(), true);
  const apps = fs.readdirSync(appsDir(dir)).sort();
  assert.ok(apps.includes('zcl_npm_a.clas.mjs') && apps.includes('zcl_npm_b.clas.testclasses.mjs'), apps.join(', '));
  assert.ok(!apps.includes('cx_root.clas.mjs') && !apps.includes('z2ui5_cl_util.clas.mjs'), 'no library output in apps/');
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'runtime', 'current.json'), 'utf8')).version, VERSION);
  assert.equal(readAppSource('zcl_npm_a').staleInBackend, false);

  // one class: the runner filtered to it, on the package's runtime
  const one = await runUnitTests({ className: 'zcl_npm_a' });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.filtered, true);
  assert.deepEqual(one.tests.map((x) => `${x.object} ${x.localClass}->${x.method}`), ['ZCL_NPM_A ltcl->check']);
  // the other one fails, with the assertion's text
  const two = await runUnitTests({ className: 'zcl_npm_b' });
  assert.equal(two.ok, false);
  assert.equal(two.failed.object, 'ZCL_NPM_B');
  assert.match(two.failed.error, /assert_equals failed: exp 1 act 2/);
  // all of them: the dev apps' tests only - there is no framework suite in apps/
  const all = await runUnitTests({});
  assert.deepEqual([...new Set(all.tests.map((x) => x.object))].sort(), ['ZCL_NPM_A', 'ZCL_NPM_B']);
  assert.ok(!fs.readdirSync(appsDir(dir)).some((f) => f.startsWith('index-mcp-')), 'the filtered runner copy is removed');

  // incremental is the npm build too; a removed app leaves apps/
  removeApp('zcl_npm_b');
  const again = await buildBackend({ mode: 'incremental' });
  assert.equal(again.ok, true, again.tail);
  assert.equal(again.mode, 'npm');
  assert.ok(!fs.readdirSync(appsDir(dir)).some((f) => f.startsWith('zcl_npm_b')));

  // a class the transpiler rejects: the build fails with the message, the last good apps/ stays served
  deployApp({ className: 'zcl_npm_c', source: `${APP('zcl_npm_c')}\n* BROKEN` });
  const broken = await buildBackend({ mode: 'auto' });
  assert.equal(broken.ok, false);
  assert.match(broken.tail, /check_syntax, Method "nope" not found/);
  assert.ok(fs.existsSync(path.join(appsDir(dir), 'zcl_npm_a.clas.mjs')));
}));

test('mode npm is refused while a framework checkout is the backend, and says how to choose it', withNpm(async (t, { root }) => {
  delete process.env.A2UI5_MCP_BACKEND;
  const a2 = path.join(root, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');
  process.env.A2UI5_HOME = a2;
  assert.equal(backendKind(), 'checkout');
  const res = await buildBackend({ mode: 'npm' });
  assert.equal(res.ok, false);
  assert.match(res.tail, /is the backend in use.*A2UI5_MCP_BACKEND=npm/);
  assert.equal(sandbox().kind, 'framework', 'the checkout keeps its own sandbox');
  process.env.A2UI5_HOME = path.join(root, 'nowhere');
  assert.equal(backendKind(), 'missing');
  assert.match(npmModeProblem(), /A2UI5_HOME is set and points at no abap2UI5 checkout/);
  assert.throws(() => sandbox(), /no dev sandbox.*unset it to deploy into the npm backend's sandbox/);
}));

test('setup_status reports the npm backend: release, workspace, tools, open-abap-core, the next build', withNpm(async (t, { workspace, dir }) => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a') });
  let st = setupStatus();
  assert.equal(st.sandbox.kind, 'npm');
  assert.equal(st.backend.kind, 'npm');
  assert.equal(st.backend.preference, 'A2UI5_MCP_BACKEND=npm');
  const npm = st.backend.npm;
  assert.equal(npm.package, '@abap2ui5/node-runtime');
  assert.equal(npm.version, VERSION);
  assert.equal(npm.versionSource, 'A2UI5_MCP_RUNTIME_VERSION');
  assert.equal(npm.workspace, workspace);
  assert.equal(npm.dir, dir);
  assert.equal(npm.installed, true);
  assert.equal(npm.transpiler, '2.13.91');
  assert.equal(npm.express, '5.2.1');
  assert.deepEqual(npm.abaplintCli, { version: '2.120.60', source: 'installed' });
  assert.deepEqual(npm.openAbapCore, { sha: CORE_SHA, source: 'known', fetched: true });
  assert.deepEqual(npm.installedReleases, [VERSION]);
  assert.equal(npm.apps, null, 'nothing built yet');
  assert.equal(npm.nextBuild.length, 1, npm.nextBuild.join('\n'));
  assert.match(npm.nextBuild[0], /transpile the 1 dev object\(s\)/);
  assert.equal(st.backend.built, false);
  assert.equal(typeof st.programs.npm, 'boolean');

  await buildBackend({ mode: 'auto' });
  st = setupStatus();
  assert.equal(st.backend.built, true);
  assert.equal(st.backend.unitTestRunner, true);
  assert.deepEqual(st.backend.npm.apps.modules, ['zcl_npm_a.clas.mjs']);
  assert.equal(backendStatus().backend, 'npm');
  assert.equal(backendStatus().runtime, VERSION);
}));

test('setup_status before anything is installed says what the first build will do', withNpm(async () => {
  delete process.env.A2UI5_MCP_RUNTIME_VERSION;
  const npm = setupStatus().backend.npm;
  assert.equal(npm.version, null);
  assert.match(npm.versionSource, /next build asks the registry/);
  assert.equal(npm.installed, false);
  assert.match(npm.nextBuild[0], /ask the registry for @abap2ui5\/node-runtime's latest release.*--ignore-scripts, exact versions, a lockfile/);
  assert.match(npm.nextBuild[1], /fetch open-abap-core at the commit the release records/);
}, { install: false }));

/* abap2ui5-unit on the npm backend, as the CLI a project's CI runs. It used
 * to deploy each class through deploy_app's gate: a class that is not an app
 * (a helper, a model) was refused as "does not implement z2ui5_if_app", its
 * tests never ran - and the run exited 0; an interface or a local-class
 * include was never deployed at all, so a class using one failed the
 * transpile. And it shared the MCP server's sandbox: a half-written app an
 * agent had deployed there failed a developer's `npm run test:unit`, and the
 * run deleted the session's copy of every class it had tested. */
test('abap2ui5-unit tests every class and interface of the project, in a sandbox of its own', withNpm(async (t, { root, workspace }) => {
  const { spawnSync } = await import('node:child_process');
  const repo = path.join(root, 'project');
  const src = path.join(repo, 'src');
  fs.mkdirSync(src, { recursive: true });
  // an app with a passing test, a helper that is no app with a failing one,
  // an interface, a local-class include
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.abap'), APP('zcl_proj_app'));
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.testclasses.abap'), TESTS());
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.locals_imp.abap'), 'CLASS lcl_local DEFINITION. ENDCLASS. CLASS lcl_local IMPLEMENTATION. ENDCLASS.');
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.xml'), '<?xml version="1.0"?><abapGit/>');
  fs.writeFileSync(path.join(src, 'zcl_proj_helper.clas.abap'), 'CLASS zcl_proj_helper DEFINITION PUBLIC. ENDCLASS. CLASS zcl_proj_helper IMPLEMENTATION. ENDCLASS.');
  fs.writeFileSync(path.join(src, 'zcl_proj_helper.clas.testclasses.abap'), TESTS(true));
  fs.writeFileSync(path.join(src, 'zif_proj_thing.intf.abap'), 'INTERFACE zif_proj_thing PUBLIC. ENDINTERFACE.');
  // what an MCP session has in the shared sandbox: an unfinished app, and its own copy of the project's app
  deployApp({ className: 'zcl_wip', source: `${APP('zcl_wip')}\n* BROKEN` });
  deployApp({ className: 'zcl_proj_app', source: APP('zcl_proj_app') });
  const box = path.join(workspace, 'sandbox');
  const before = Object.fromEntries(fs.readdirSync(box).map((f) => [f, fs.readFileSync(path.join(box, f), 'utf8')]));

  const res = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'ci-unit.mjs'), 'src', '--json'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env },
  });
  const report = JSON.parse(res.stdout || 'null');
  assert.ok(report, `no report:\n${res.stderr}`);
  const byClass = Object.fromEntries(report.results.map((r) => [r.cls, r]));
  assert.equal(byClass.zcl_proj_helper.deployError, undefined, 'a class that is no app is deployed like any other');
  assert.equal(byClass.zcl_proj_helper.tests.length, 1, 'and its tests run');
  assert.equal(byClass.zcl_proj_helper.failed.object, 'ZCL_PROJ_HELPER');
  assert.equal(byClass.zcl_proj_app.tests.length, 1);
  assert.equal(byClass.zcl_proj_app.failed, null);
  assert.equal(res.status, 1, `a failing test fails the run\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /zcl_wip/, 'the MCP session\'s unfinished app is not the project\'s');
  // the MCP sandbox is exactly as it was, and nothing of the run is left behind
  assert.deepEqual(Object.fromEntries(fs.readdirSync(box).map((f) => [f, fs.readFileSync(path.join(box, f), 'utf8')])), before);
  assert.deepEqual(fs.readdirSync(workspace).filter((f) => /^unit-/.test(f)), [], 'the run\'s own sandbox is removed');
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'runtime', VERSION)).filter((f) => /^(apps-unit-|\.apps-|\.staging-)/.test(f)), []);
}));

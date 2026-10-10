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
  npmPreferenceProblem, startBackend, buildLog, builtAppClasses,
} from '../lib/runtime.mjs';
import { resetNpmBackend, appsDir, downportDir } from '../lib/npm-backend.mjs';
import { fakeRelease, fakeTemplate, APP, TESTS, VERSION, CORE_SHA } from './helpers/npm-fixture.mjs';

const ENV = [
  'A2UI5_MCP_BACKEND', 'A2UI5_MCP_WORKSPACE', 'A2UI5_MCP_RUNTIME_VERSION', 'A2UI5_HOME', 'SAMPLES_CONTROLS_HOME',
  'AI_DEMOKIT_HOME', 'APP_TEMPLATE_HOME', 'A2UI5_MCP_REMOTE', 'A2UI5_MCP_OFFLINE', 'LINT_RECORD', 'A2UI5_MCP_SCREENSHOT_DIR',
];

function withNpm(fn, { install = true, release = {} } = {}) {
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
    const dir = install ? fakeRelease(workspace, release) : path.join(workspace, 'runtime', VERSION);
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
  /* a class deployed with its includes (migrate_report's deploy, an
   * abap2ui5-unit run) goes whole - an include left behind was still an
   * object of the next build - and a class whose name merely starts the
   * same stays */
  deployApp({ className: 'zcl_npm_app', source: APP('zcl_npm_app') });
  deployApp({ className: 'zcl_npm_app2', source: APP('zcl_npm_app2') });
  for (const inc of ['locals_imp', 'locals_def', 'macros']) fs.writeFileSync(path.join(box.dir, `zcl_npm_app.clas.${inc}.abap`), '*\n');
  assert.equal(removeApp('zcl_npm_app'), 5);
  assert.deepEqual(fs.readdirSync(box.dir).filter((f) => f.startsWith('zcl_npm_app.')), []);
  assert.deepEqual(listDevApps(), ['zcl_npm_app2']);
  removeApp('zcl_npm_app2');
}));

test('a dev app named like one of the framework\'s own objects is refused, not built as a second copy', withNpm(async (t, { dir }) => {
  // the release's downport/ is the list of what the framework itself defines
  fs.writeFileSync(path.join(downportDir(dir), '02', 'z2ui5_cl_ui5_app_hi_world.clas.abap'), 'CLASS z2ui5_cl_ui5_app_hi_world DEFINITION PUBLIC. ENDCLASS.\n');
  assert.throws(
    () => deployApp({ className: 'z2ui5_cl_ui5_app_hi_world', source: APP('z2ui5_cl_ui5_app_hi_world') }),
    /z2ui5_cl_ui5_app_hi_world is the framework's own class .*second copy/s,
  );
  assert.throws(() => deployApp({ className: 'Z2UI5_IF_APP', source: APP('z2ui5_if_app') }), /z2ui5_if_app is the framework's own/);
  assert.deepEqual(listDevApps(), [], 'nothing written for a refused name');
  // an ordinary name still deploys
  deployApp({ className: 'zcl_hi_world', source: APP('zcl_hi_world') });
  assert.deepEqual(listDevApps(), ['zcl_hi_world']);
}));

test('a framework class that reached the sandbox without the deploy gate fails the build, named', withNpm(async (t, { dir }) => {
  /* deploy_app refuses one only once a release is installed, and
   * migrate_report deployed without asking: the build refuses it for
   * every writer */
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a') });
  fs.writeFileSync(path.join(sandbox().dir, 'z2ui5_if_app.intf.abap'), 'INTERFACE z2ui5_if_app PUBLIC. ENDINTERFACE.\n');
  const res = await buildBackend({ mode: 'auto' });
  assert.equal(res.ok, false);
  assert.match(res.tail, /z2ui5_if_app\.intf is the framework's own - .*remove_app z2ui5_if_app/);
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

/* buildNpm "never rejects", and build_backend records every build for
 * build_log through that: a workspace whose open-abap-core/ or sandbox the
 * build could not write threw out of it instead - the build was answered
 * with a bare ENOTDIR / EEXIST and build_log kept the previous build. */
test('a workspace the build cannot write into fails the build with a reason, recorded for build_log', withNpm(async (t, { workspace }) => {
  // open-abap-core/ is a file: the fetch's temporary directory cannot be made
  fs.rmSync(path.join(workspace, 'open-abap-core'), { recursive: true, force: true });
  fs.writeFileSync(path.join(workspace, 'open-abap-core'), 'a file where the directory belongs');
  const core = await buildBackend({ mode: 'npm' });
  assert.equal(core.ok, false);
  assert.match(core.tail, /open-abap-core: .*cannot be written: ENOTDIR/);
  assert.equal(buildLog({ tail: 5 }).ok, false, 'the failed build is the one build_log answers for');
  // the sandbox is a file: the transpile's input cannot be prepared
  fs.rmSync(path.join(workspace, 'open-abap-core'));
  fakeRelease(workspace);
  fs.rmSync(path.join(workspace, 'sandbox'), { recursive: true, force: true });
  fs.writeFileSync(path.join(workspace, 'sandbox'), 'a file where the sandbox belongs');
  const box = await buildBackend({ mode: 'npm' });
  assert.equal(box.ok, false);
  assert.match(box.tail, /the build could not write its files: EEXIST/);
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

  /* nothing changed since that build: no transpile, the stop the server
   * hands in as beforeBuild is never called (the backend and the app
   * sessions on it stand), apps/ is not swapped, and the answer says so */
  const initBefore = fs.statSync(path.join(appsDir(dir), 'init.mjs'));
  let stops = 0;
  const quiet = [];
  const same = await buildBackend({ mode: 'auto', onLine: (l) => quiet.push(l), beforeBuild: async () => { stops += 1; } });
  assert.equal(same.ok, true, same.tail);
  assert.equal(same.unchanged, true, 'the same sandbox against the same release is the build that is there');
  assert.equal(same.runtime, VERSION);
  assert.equal(stops, 0, 'the backend is not stopped for a build that does not happen');
  assert.ok(!quiet.some((l) => /objects written to disk/.test(l)), 'the transpiler did not run');
  assert.ok(quiet.some((l) => /nothing changed since the last build/.test(l)), quiet.join('\n'));
  const initAfter = fs.statSync(path.join(appsDir(dir), 'init.mjs'));
  assert.deepEqual([initAfter.mtimeMs, initAfter.ino], [initBefore.mtimeMs, initBefore.ino], 'apps/ was not swapped');
  // a changed class is a change: the backend is stopped and the sandbox transpiled again
  deployApp({ className: 'zcl_npm_a', source: `${APP('zcl_npm_a')}\n* edited`, testclasses: TESTS() });
  const edited = await buildBackend({ mode: 'auto', beforeBuild: async () => { stops += 1; } });
  assert.equal(edited.ok, true, edited.tail);
  assert.equal(edited.unchanged, undefined, 'an edit is built');
  assert.equal(stops, 1, 'and the backend stopped once for it');
  assert.ok(fs.statSync(path.join(appsDir(dir), 'init.mjs')).ino !== initBefore.ino, 'a fresh apps/');

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

/* @abaplint/transpiler-cli 2.14 writes a folder per origin: the sandbox in
 * project/, open-abap-core in a folder of its own, imported by a relative
 * path into it. apps/ stays flat, the imports go to the package's module in
 * ITS folder (by the package's own own-apps.mjs), the runner runs the tests
 * from apps/. */
test('a folder-layout release (transpiler 2.14): apps/ flat, imports on the package\'s folders, the runner on apps/', withNpm(async (t, { dir }) => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a'), testclasses: TESTS() });
  deployApp({ className: 'zcl_npm_b', source: APP('zcl_npm_b'), testclasses: TESTS(true) });
  const lines = [];
  const res = await buildBackend({ mode: 'auto', onLine: (l) => lines.push(l) });
  assert.equal(res.ok, true, `${res.tail}\n${lines.join('\n')}`);
  const apps = fs.readdirSync(appsDir(dir)).sort();
  assert.deepEqual(apps.filter((f) => f.endsWith('.mjs')), ['index.mjs', 'init.mjs', 'zcl_npm_a.clas.mjs', 'zcl_npm_a.clas.testclasses.mjs', 'zcl_npm_b.clas.mjs', 'zcl_npm_b.clas.testclasses.mjs']);
  assert.ok(!apps.includes('project') && !apps.includes('open-abap-core'), 'no output folder in apps/');
  const mod = fs.readFileSync(path.join(appsDir(dir), 'zcl_npm_a.clas.mjs'), 'utf8');
  assert.match(mod, /await import\("@abap2ui5\/node-runtime\/output\/open-abap-core\/cx_root\.clas\.mjs"\)/);
  assert.doesNotMatch(mod, /"\.\.\//, 'no import into another folder of the staging');
  const runner = fs.readFileSync(path.join(appsDir(dir), 'index.mjs'), 'utf8');
  assert.match(runner, /filename: "\.\/zcl_npm_a\.clas\.testclasses\.mjs"/, 'the runner names the test modules beside it');
  assert.doesNotMatch(runner, /\.\/project\//);
  assert.match(fs.readFileSync(path.join(appsDir(dir), 'init.mjs'), 'utf8'), /await import\("\.\/zcl_npm_a\.clas\.mjs"\);\nawait import\("\.\/zcl_npm_b\.clas\.mjs"\);/, 'the boot order out of init.mjs\'s ./project/ imports');
  assert.ok(builtAppClasses().some((a) => a.app === 'Z2UI5_CL_POP_FAKE' && a.source === 'framework'), 'app_list finds the framework\'s apps in output/project/');
  /* and answers the next call from memory: the class modules are read once
   * per build (apps/init.mjs is the key), not on every app_list */
  const before = builtAppClasses();
  const realRead = fs.readFileSync;
  const modulesRead = [];
  fs.readFileSync = function (file, ...rest) {
    if (String(file).endsWith('.clas.mjs')) modulesRead.push(String(file));
    return realRead.call(fs, file, ...rest);
  };
  try {
    assert.deepEqual(builtAppClasses(), before);
    assert.deepEqual(modulesRead, [], 'an unchanged build reads no class module');
    // a new build (apps/ swapped in whole: a new init.mjs) is scanned again
    const init = path.join(appsDir(dir), 'init.mjs');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(init, later, later);
    assert.deepEqual(builtAppClasses(), before);
    assert.ok(modulesRead.some((f) => f.endsWith('zcl_npm_a.clas.mjs')), 'a changed build record re-reads the dev modules');
    assert.ok(!modulesRead.some((f) => f.includes(`${path.sep}output${path.sep}`)), 'and only them - the package\'s output/ did not change');
  } finally {
    fs.readFileSync = realRead;
  }

  const one = await runUnitTests({ className: 'zcl_npm_a' });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.deepEqual(one.tests.map((x) => `${x.object} ${x.localClass}->${x.method}`), ['ZCL_NPM_A ltcl->check']);
  const two = await runUnitTests({ className: 'zcl_npm_b' });
  assert.equal(two.ok, false);
  assert.match(two.failed.error, /assert_equals failed/);
}, { release: { layout: 'folders' } }));

test('a transpiler whose layout is not the package\'s fails the build, named, and leaves apps/ alone', withNpm(async () => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a') });
  const res = await buildBackend({ mode: 'auto' });
  assert.equal(res.ok, false);
  assert.match(res.tail, /the transpiler wrote a folders output, and @abap2ui5\/node-runtime 1\.145\.0's output\/ is flat - the transpiler installed in .* is not the one the release was built with/);
  assert.equal(backendBuilt(), false);
}, { release: { layout: 'flat', transpilerLayout: 'folders' } }));

test('a folder-layout release without setup/own-apps.mjs fails the build instead of guessing its folders', withNpm(async () => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a') });
  const res = await buildBackend({ mode: 'auto' });
  assert.equal(res.ok, false);
  assert.match(res.tail, /writes its output\/ in a folder per origin and carries no setup\/own-apps\.mjs/);
}, { release: { layout: 'folders', ownApps: false } }));

/* app_start (or backend start) during build_backend booted the output
 * from before the build, and the build then reported built while that
 * process went on serving the old classes. */
test('a backend start while build_backend runs is refused with the reason', withNpm(async () => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a') });
  const build = buildBackend({ mode: 'auto' });
  await assert.rejects(startBackend(), /build_backend is running/);
  assert.equal((await build).ok, true);
}));

/* The filtered runner copy was named after the selection alone
 * (`index-mcp-selection.mjs` for any set of classes): two run_unit_tests
 * calls at once over different sets wrote the same file, and the first
 * child loaded the SECOND call's filter - it answered with tests nobody
 * asked it for - while the first call to finish deleted the file under the
 * other. Each run writes a copy of its own now. */
test('two concurrent unit runs over different class sets each run their own set', withNpm(async () => {
  deployApp({ className: 'zcl_npm_a', source: APP('zcl_npm_a'), testclasses: TESTS() });
  deployApp({ className: 'zcl_npm_b', source: APP('zcl_npm_b'), testclasses: TESTS() });
  deployApp({ className: 'zcl_npm_c', source: APP('zcl_npm_c'), testclasses: TESTS() });
  const built = await buildBackend({ mode: 'auto' });
  assert.equal(built.ok, true, built.tail);
  const [ab, bc] = await Promise.all([
    runUnitTests({ classNames: ['zcl_npm_a', 'zcl_npm_b'] }),
    runUnitTests({ classNames: ['zcl_npm_b', 'zcl_npm_c'] }),
  ]);
  const objects = (r) => [...new Set(r.tests.map((x) => x.object))].sort();
  assert.deepEqual(objects(ab), ['ZCL_NPM_A', 'ZCL_NPM_B'], JSON.stringify(ab));
  assert.deepEqual(objects(bc), ['ZCL_NPM_B', 'ZCL_NPM_C'], JSON.stringify(bc));
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

/* A2UI5_MCP_BACKEND=npm makes the package the backend in use even beside a
 * checkout. mode npm was refused while a CHECKOUT is in use ("would build a
 * backend nothing serves") - but the mirror case went through: under the npm
 * preference, modes prebuilt, transpile and full built (or cloned and built)
 * a checkout's backend that run_app, run_unit_tests and backend start then
 * ignored, and build_backend reported `built: true` while run_app answered
 * "backend not built". */
test('under A2UI5_MCP_BACKEND=npm a checkout build is refused as the backend nothing serves', { skip: process.platform === 'win32' && 'npm scripts of a fake checkout' }, withNpm(async (t, { root }) => {
  const a2 = path.join(root, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');
  fs.mkdirSync(path.join(a2, 'node_modules', '@abaplint', 'transpiler-cli'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'package.json'), JSON.stringify({
    name: 'abap2ui5', version: '1.145.0',
    scripts: {
      downport: 'node -e ""',
      auto_transpile: 'node -e "require(\'fs\').mkdirSync(\'node/output\',{recursive:true});require(\'fs\').writeFileSync(\'node/output/init.mjs\',\'\')"',
    },
  }));
  process.env.A2UI5_HOME = a2;
  assert.equal(backendKind(), 'npm', 'the preference wins over the checkout');
  for (const mode of ['transpile', 'prebuilt', 'full']) {
    const res = await buildBackend({ mode });
    assert.equal(res.ok, false, `${mode}: ${res.tail}`);
    assert.match(res.tail, /A2UI5_MCP_BACKEND=npm/, mode);
    assert.match(res.tail, /nothing serves/, mode);
  }
  assert.ok(!fs.existsSync(path.join(a2, 'node', 'output')), 'the checkout was not built');
  // the pure half: the preference is what decides, not the kind alone
  assert.match(planBuild({ mode: 'prebuilt', kind: 'npm', a2, preference: 'npm' }).problem, /nothing serves/);
  assert.match(npmPreferenceProblem({ mode: 'transpile', a2: null, preference: 'npm' }), /a framework clone into a backend nothing serves/);
  assert.equal(npmPreferenceProblem({ mode: 'auto', a2, preference: 'npm' }), null);
  assert.equal(npmPreferenceProblem({ mode: 'prebuilt', a2, preference: 'clone' }), null);
  assert.deepEqual(planBuild({ mode: 'prebuilt', kind: 'npm', canClone: true }), { effective: 'prebuilt' }, 'without the preference prebuilt is the way to the clone, which is then served');
}));

/* abap2ui5-unit installs a release without the lint's abaplint; the next
 * build_backend (and the next deploy_app's lint) install it - an npm
 * install setup_status' nextBuild left out, as it left out the reinstall
 * after app-template moved its pin. */
test('setup_status names the lint\'s abaplint install the next build makes', withNpm(async (t, { dir }) => {
  const markerFile = path.join(dir, '.abap2ui5-mcp-runtime.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  delete marker.dependencies['@abaplint/cli'];
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  fs.rmSync(path.join(dir, 'node_modules', '@abaplint', 'cli'), { recursive: true });
  let steps = setupStatus().backend.npm.nextBuild;
  assert.ok(steps.some((s) => /install the lint's @abaplint\/cli 2\.120\.60/.test(s)), steps.join('\n'));
  // installed, but app-template pins another version now
  marker.dependencies['@abaplint/cli'] = '2.120.59';
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  steps = setupStatus().backend.npm.nextBuild;
  assert.ok(steps.some((s) => /@abaplint\/cli 2\.120\.60.*2\.120\.59 is installed/.test(s)), steps.join('\n'));
  // at the pin: nothing to install
  marker.dependencies['@abaplint/cli'] = '2.120.60';
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  assert.ok(!setupStatus().backend.npm.nextBuild.some((s) => /abaplint/.test(s)));
}));

/* run_unit_tests answered a class whose class_setup threw - no test line,
 * the failure known - with "no test class of X in the built backend -
 * deploy_app with testclasses": an agent redeployed a class that had its
 * tests all along. The empty-tests hint is for a run that passed. */
test('run_unit_tests names a failing class_setup instead of calling the tests missing', withNpm(async () => {
  const { spawn } = await import('node:child_process');
  deployApp({ className: 'zcl_npm_cs', source: APP('zcl_npm_cs'), testclasses: `${TESTS()} SETUP_THROWS` });
  deployApp({ className: 'zcl_npm_none', source: APP('zcl_npm_none') });
  assert.equal((await buildBackend({ mode: 'auto' })).ok, true);
  const p = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env } });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (id) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === id);
      if (hit) { clearInterval(iv); resolve(hit); } else if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error(`no answer to ${id}`)); }
    }, 50);
  });
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'npm-rt', version: '0' } } });
    await until(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_unit_tests', arguments: { class_name: 'zcl_npm_cs' } } });
    const cs = JSON.parse((await until(2)).result.content[0].text);
    assert.equal(cs.ok, false);
    assert.deepEqual([cs.failed.object, cs.failed.method, cs.failed.fixture], ['ZCL_NPM_CS', 'class_setup', true]);
    assert.match(cs.hint, /ZCL_NPM_CS's test class failed in its class_setup/);
    assert.doesNotMatch(cs.hint, /no test class/);
    // a class that really has no tests keeps its hint
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_unit_tests', arguments: { class_name: 'zcl_npm_none' } } });
    const none = JSON.parse((await until(3)).result.content[0].text);
    assert.match(none.hint, /no test class of ZCL_NPM_NONE in the built backend/);
  } finally {
    p.kill();
  }
}));

/* A2UI5_MCP_WORKSPACE was used as given. Relative (a project's .mcp.json,
 * a CI env), every path the npm backend hands a child that runs in ANOTHER
 * directory resolved twice: the lint's abaplint and the transpiler were
 * "Cannot find module .../ws/runtime/1.145.0/ws/runtime/...", the build's
 * input and output folders pointed into the runtime directory. The
 * workspace is resolved once, against the directory the server runs in. */
test('a relative A2UI5_MCP_WORKSPACE is the workspace under the server\'s directory', withNpm(async (t, { root }) => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    process.env.A2UI5_MCP_WORKSPACE = 'workspace';
    assert.equal(sandbox().dir, path.join(fs.realpathSync(root), 'workspace', 'sandbox'));
    deployApp({ className: 'zcl_npm_rel', source: APP('zcl_npm_rel'), testclasses: TESTS() });
    const lint = await lintApp('zcl_npm_rel');
    assert.equal(lint.ok, true, JSON.stringify(lint.issues));
    const built = await buildBackend({ mode: 'auto' });
    assert.equal(built.ok, true, built.tail);
    const unit = await runUnitTests({ className: 'zcl_npm_rel' });
    assert.equal(unit.ok, true, JSON.stringify(unit));
    assert.equal(unit.tests.length, 1);
  } finally {
    process.chdir(cwd);
  }
}));

// The npm backend (lib/npm-backend.mjs): @abap2ui5/node-runtime from the
// registry instead of a framework clone. Network-free: the registry answers
// through an injected `view`, npm and git are recording stand-ins on PATH, and
// the transpiler is a script in a fake runtime directory - so what is pinned
// here is the server's side of the contract: which release, what is installed
// with which flags, which commit of open-abap-core, and what apps/ ends up
// holding. The real loop is test/npm-integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRuntimePin, compareVersions, openAbapCoreOf, transpilerOf, expressRangeOf, cliVersionOf, desiredDeps,
  installSpecs, devObjects, devOutputFiles, rewriteImports, strayImports, bootOrder, appsInitSource, transpileConfig,
  selectRuntimeVersion, installedRuntimes, currentRuntimeVersion, ensureRuntime, ensureOpenAbapCore, buildApps,
  runtimeDir, runtimeBase, npmSandboxDir, openAbapCoreDir, appsDir, downportDir, npmCommand, resetNpmBackend,
  RUNTIME_PKG, RUNTIME_MARKER, BUILD_RECORD, KNOWN_OPEN_ABAP_CORE, ABAPLINT_CLI_FALLBACK, EXPRESS_FALLBACK_RANGE,
} from '../lib/npm-backend.mjs';

const POSIX = process.platform !== 'win32';
const META_145 = {
  version: '1.145.0',
  abap2ui5: { commit: 'e0c54eb93a66596a8b261df88caa4bd3e4d7a6e4', transpiler: '2.13.91' },
  peerDependencies: { express: '^5.0.0' },
  dependencies: { '@abaplint/runtime': '2.13.91', '@abaplint/database-sqlite': '2.13.83' },
};

/* A workspace of its own per test: A2UI5_MCP_WORKSPACE decides every path of
 * the npm backend, and the pin/offline/template variables are cleared so the
 * surrounding shell cannot decide a test. */
const ENV = ['A2UI5_MCP_WORKSPACE', 'A2UI5_MCP_RUNTIME_VERSION', 'A2UI5_MCP_OFFLINE', 'APP_TEMPLATE_HOME', 'PATH', 'A2UI5_MCP_REMOTE'];
function withWorkspace(fn) {
  return async (t) => {
    const saved = Object.fromEntries(ENV.map((v) => [v, process.env[v]]));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-npm-'));
    process.env.A2UI5_MCP_WORKSPACE = path.join(ws, 'workspace');
    delete process.env.A2UI5_MCP_RUNTIME_VERSION;
    delete process.env.A2UI5_MCP_OFFLINE;
    process.env.A2UI5_MCP_REMOTE = '0'; // no template mirror download from a unit test
    process.env.APP_TEMPLATE_HOME = path.join(ws, 'no-template');
    resetNpmBackend();
    try {
      await fn(t, { ws, workspace: process.env.A2UI5_MCP_WORKSPACE });
    } finally {
      resetNpmBackend();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(ws, { recursive: true, force: true });
    }
  };
}

// ------------------------------------------------------------------ pure ----

test('the release pin is a plain X.Y.Z or nothing', () => {
  assert.deepEqual(readRuntimePin({}), {});
  assert.deepEqual(readRuntimePin({ A2UI5_MCP_RUNTIME_VERSION: ' 1.145.0 ' }), { value: '1.145.0' });
  assert.deepEqual(readRuntimePin({ A2UI5_MCP_RUNTIME_VERSION: 'latest' }), { invalid: 'latest' });
  assert.deepEqual(readRuntimePin({ A2UI5_MCP_RUNTIME_VERSION: '../../etc' }), { invalid: '../../etc' }, 'it becomes a directory name');
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0, 'numeric, not lexical');
  assert.equal(compareVersions('1.145.0', '1.145.0'), 0);
  assert.ok(compareVersions('1.144.1', '1.145.0') < 0);
});

test('open-abap-core: the package\'s record, then the known releases, then nothing', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(openAbapCoreOf({ abap2ui5: { openAbapCore: sha } }, '1.146.0'), { sha, source: 'package' });
  // 1.145.0 was published before the field existed: abap2UI5's fetch-deps.mjs at tag 1.145.0 pins b2d219df
  assert.deepEqual(openAbapCoreOf(META_145, '1.145.0'), { sha: 'b2d219df61f8c077df7a038bc43d168f9f280fbf', source: 'known' });
  assert.equal(KNOWN_OPEN_ABAP_CORE['1.145.0'], 'b2d219df61f8c077df7a038bc43d168f9f280fbf');
  assert.deepEqual(openAbapCoreOf({ abap2ui5: { openAbapCore: null } }, '1.146.0'), { sha: null, source: 'unknown' });
  // a record that is not a commit is not trusted (it becomes a path and a git argument)
  assert.deepEqual(openAbapCoreOf({ abap2ui5: { openAbapCore: '--upload-pack=x' } }, '1.145.0').source, 'known');
});

test('the transpiler is the one the package names, else its runtime pin; express follows the peer range', () => {
  assert.deepEqual(transpilerOf(META_145), { version: '2.13.91', source: 'package' });
  assert.deepEqual(transpilerOf({ dependencies: { '@abaplint/runtime': '2.13.80' } }), { version: '2.13.80', source: '@abaplint/runtime pin' });
  assert.equal(transpilerOf({ abap2ui5: { transpiler: '^2' } }), null);
  assert.equal(expressRangeOf(META_145), '^5.0.0');
  assert.equal(expressRangeOf({ peerDependencies: { express: '^4.21.0 || ^5.0.0' } }), '^4.21.0 || ^5.0.0');
  assert.equal(expressRangeOf({}), EXPRESS_FALLBACK_RANGE);
  assert.equal(expressRangeOf({ peerDependencies: { express: '^5 & calc' } }), EXPRESS_FALLBACK_RANGE, 'nothing a shell could read reaches the command line');
});

test('the lint\'s abaplint is app-template\'s pin: its lockfile, its package.json, then the fallback', () => {
  const lock = JSON.stringify({ packages: { 'node_modules/@abaplint/cli': { version: '2.120.61' } } });
  assert.deepEqual(cliVersionOf({ lockText: lock, pkgText: '{}' }), { version: '2.120.61', source: 'app-template package-lock.json' });
  assert.deepEqual(cliVersionOf({ lockText: null, pkgText: '{"devDependencies":{"@abaplint/cli":"^2.120.60"}}' }), { version: '2.120.60', source: 'app-template package.json' });
  const none = cliVersionOf({ lockText: 'not json', pkgText: null });
  assert.equal(none.version, ABAPLINT_CLI_FALLBACK);
  assert.match(none.source, /fallback/);
});

test('an install asks only for what package.json does not already record', () => {
  const desired = desiredDeps({ version: '1.145.0', meta: META_145, cli: '2.120.60' });
  assert.deepEqual(desired, {
    [RUNTIME_PKG]: '1.145.0', '@abaplint/transpiler-cli': '2.13.91', express: '^5.0.0', '@abaplint/cli': '2.120.60',
  });
  assert.deepEqual(installSpecs(desired, {}), [
    `${RUNTIME_PKG}@1.145.0`, '@abaplint/transpiler-cli@2.13.91', 'express@^5.0.0', '@abaplint/cli@2.120.60',
  ]);
  // express recorded exact by the first install stays; a new template pin is the one spec
  assert.deepEqual(installSpecs(desired, { [RUNTIME_PKG]: '1.145.0', '@abaplint/transpiler-cli': '2.13.91', express: '5.2.1', '@abaplint/cli': '2.120.59' }), ['@abaplint/cli@2.120.60']);
  assert.throws(() => desiredDeps({ version: '1.145.0', meta: {} }), /names no transpiler/);
  assert.equal(desiredDeps({ version: '1.145.0', meta: META_145 })['@abaplint/cli'], undefined, 'no lint, no abaplint');
});

test('the sandbox\'s objects and exactly their output files', () => {
  const objects = devObjects(['zcl_a.clas.abap', 'zcl_a.clas.xml', 'zcl_a.clas.testclasses.abap', 'ZIF_B.intf.abap', 'package.devc.xml', 'README.md']);
  assert.deepEqual(objects, ['zcl_a.clas', 'zif_b.intf']);
  const out = devOutputFiles([
    'zcl_a.clas.mjs', 'zcl_a.clas.mjs.map', 'zcl_a.clas.testclasses.mjs', 'zcl_a.clas.locals.mjs', 'zcl_ab.clas.mjs',
    'zif_b.intf.mjs', 'cx_root.clas.mjs', 'init.mjs', 'index.mjs', 'zcl_a.clas.abap',
  ], objects);
  assert.deepEqual(out, ['zcl_a.clas.locals.mjs', 'zcl_a.clas.mjs', 'zcl_a.clas.mjs.map', 'zcl_a.clas.testclasses.mjs', 'zif_b.intf.mjs']);
});

test('imports of framework modules point at the package, dev modules stay beside each other', () => {
  const local = new Set(['zcl_a.clas.mjs', 'zcl_a.clas.locals.mjs']);
  const src = [
    'await import("./zcl_a.clas.locals.mjs");',
    'const {cx_root} = await import("./cx_root.clas.mjs");',
    'const {$ui2$cl_json} = await import("./%23ui2%23cl_json.clas.mjs");',
    '  const {zcl_a} = await import("./zcl_a.clas.mjs");',
    'import "./z2ui5_if_app.intf.mjs";',
    'const text = \'call import("./not_code.mjs") in a string\';',
    'const zlib = await import("zlib");',
  ].join('\n');
  const out = rewriteImports(src, local).split('\n');
  assert.equal(out[0], 'await import("./zcl_a.clas.locals.mjs");');
  assert.equal(out[1], `const {cx_root} = await import("${RUNTIME_PKG}/output/cx_root.clas.mjs");`);
  assert.equal(out[2], `const {$ui2$cl_json} = await import("${RUNTIME_PKG}/output/%23ui2%23cl_json.clas.mjs");`);
  assert.equal(out[3], '  const {zcl_a} = await import("./zcl_a.clas.mjs");');
  assert.equal(out[4], `import "${RUNTIME_PKG}/output/z2ui5_if_app.intf.mjs";`);
  assert.equal(out[5], 'const text = \'call import("./not_code.mjs") in a string\';', 'mid-line text is data, not an import');
  assert.equal(out[6], 'const zlib = await import("zlib");');
  // what the rewrite does not know is reported, not left to fail at boot
  assert.deepEqual(strayImports(rewriteImports(src, local), local), ['not_code.mjs']);
  assert.deepEqual(strayImports('x = await import("./zcl_a.clas.mjs")', local), []);
});

test('the boot imports the dev modules in the transpiler\'s order and says whether it accelerates', () => {
  const init = [
    'await initializeABAP();',
    'await import("./cx_root.clas.mjs");',
    'await import("./zcl_b.clas.mjs");',
    'await import("./zif_c.intf.mjs");',
    'await import("./zcl_a.clas.mjs"); ',
  ].join('\n');
  assert.deepEqual(bootOrder(init, ['zcl_a.clas.mjs', 'zcl_b.clas.mjs', 'zcl_d.clas.mjs']), ['zcl_b.clas.mjs', 'zcl_a.clas.mjs', 'zcl_d.clas.mjs']);
  assert.deepEqual(bootOrder('', ['zcl_b.clas.mjs', 'zcl_a.clas.mjs']), ['zcl_a.clas.mjs', 'zcl_b.clas.mjs']);
  const boot = appsInitSource(['zcl_b.clas.mjs', 'zcl_a.clas.mjs'], { version: '1.145.0' });
  assert.match(boot, new RegExp(`import \\* as runtime from "${RUNTIME_PKG.replace('/', '\\/')}";`));
  assert.match(boot, /await runtime\.initialize\(\);[\s\S]*typeof runtime\.accelerate === "function"[\s\S]*await import\("\.\/zcl_b\.clas\.mjs"\);\nawait import\("\.\/zcl_a\.clas\.mjs"\);/);
  assert.ok(boot.indexOf('initialize()') < boot.indexOf('accelerate()'), 'initialize, then accelerate, then the apps');
});

test('the transpile reads the sandbox and takes the package and open-abap-core as libraries', () => {
  const cfg = transpileConfig({ inputDir: '/ws/sandbox', outputDir: '/ws/runtime/1.145.0/.staging-x', downportRel: 'node_modules/@abap2ui5/node-runtime/downport', coreRel: '../../open-abap-core/abc' });
  assert.deepEqual(cfg.libs, [{ folder: 'node_modules/@abap2ui5/node-runtime/downport', files: '/**/*.*' }, { folder: '../../open-abap-core/abc' }]);
  assert.equal(cfg.write_unit_tests, true);
  assert.equal(cfg.options.ignoreSyntaxCheck, false, 'the app is type-checked against the framework');
  assert.equal(cfg.options.unknownTypes, 'runtimeError', 'the framework\'s own setting');
  const filter = new RegExp(cfg.input_filter[0], 'i');
  for (const f of ['/ws/sandbox/zcl_a.clas.abap', '/ws/sandbox/zcl_a.clas.xml', '/ws/sandbox/zcl_a.clas.testclasses.abap', '/ws/sandbox/zif_b.intf.abap']) assert.ok(filter.test(f), f);
  for (const f of ['/ws/sandbox/README.md', '/ws/sandbox/package.devc.xml']) assert.ok(!filter.test(f), f);
});

test('npm is run without a shell, except on Windows where the arguments are quoted for cmd.exe', () => {
  const c = npmCommand(['install', 'express@^4.21.0 || ^5.0.0']);
  if (POSIX) assert.deepEqual(c, { cmd: 'npm', args: ['install', 'express@^4.21.0 || ^5.0.0'], shell: false });
  else assert.deepEqual(c.args, ['install', '"express@^4.21.0 || ^5.0.0"']);
  /* The Windows decisions, on every platform: npm is a .cmd script there,
   * which spawn runs only through cmd.exe (and Node joins the arguments
   * with spaces into ONE command line) - so every argument carrying a
   * space or a character cmd.exe reads (^ is its escape, | & < > ( ) are
   * operators) is double-quoted, inside which cmd.exe takes them
   * literally; a double quote cannot be escaped for cmd.exe and is dropped. */
  const win = npmCommand([
    'install', '--ignore-scripts', '--save-exact', `${RUNTIME_PKG}@1.145.0`, '@abaplint/transpiler-cli@2.13.91',
    'express@^5.0.0', 'express@^4.21.0 || ^5.0.0', 'express@>=5.0.0 <6', 'a"b&c',
  ], 'win32');
  assert.equal(win.cmd, 'npm.cmd');
  assert.equal(win.shell, true);
  assert.deepEqual(win.args, [
    'install', '--ignore-scripts', '--save-exact', `${RUNTIME_PKG}@1.145.0`, '@abaplint/transpiler-cli@2.13.91',
    '"express@^5.0.0"', '"express@^4.21.0 || ^5.0.0"', '"express@>=5.0.0 <6"', '"ab&c"',
  ]);
  assert.deepEqual(npmCommand(['view', `${RUNTIME_PKG}@latest`, 'version', '--json'], 'win32').args, ['view', `${RUNTIME_PKG}@latest`, 'version', '--json'], 'nothing to quote');
  assert.deepEqual(npmCommand(['install', 'express@^5.0.0'], 'darwin'), { cmd: 'npm', args: ['install', 'express@^5.0.0'], shell: false }, 'no shell anywhere else');
  // and nothing reaches that command line unvalidated: a version is X.Y.Z, a range a range
  assert.equal(expressRangeOf({ peerDependencies: { express: '^5 %PATH%' } }), EXPRESS_FALLBACK_RANGE, '%VAR% expands even inside quotes');
  assert.equal(readRuntimePin({ A2UI5_MCP_RUNTIME_VERSION: '1.145.0 & calc' }).invalid, '1.145.0 & calc');
});

// ------------------------------------------------------------ the release ----

const viewOf = (answers, calls = []) => async (spec) => {
  calls.push(spec);
  const a = answers[spec];
  if (!a) return { ok: false, error: 'getaddrinfo ENOTFOUND registry.npmjs.org' };
  return a;
};

function fakeInstalled(version) {
  const dir = runtimeDir(version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RUNTIME_MARKER), '{}');
  return dir;
}

test('the release: the pin, else the registry\'s latest (cached), else the newest installed', withWorkspace(async () => {
  const calls = [];
  const view = viewOf({ [`${RUNTIME_PKG}@latest`]: { ok: true, meta: { ...META_145, version: '1.146.0' } } }, calls);
  process.env.A2UI5_MCP_RUNTIME_VERSION = '1.145.0';
  assert.deepEqual(await selectRuntimeVersion({ view }), { version: '1.145.0', source: 'A2UI5_MCP_RUNTIME_VERSION' });
  assert.equal(calls.length, 0, 'a pin asks nobody');
  process.env.A2UI5_MCP_RUNTIME_VERSION = 'next';
  assert.match((await selectRuntimeVersion({ view })).error, /not a release version/);
  delete process.env.A2UI5_MCP_RUNTIME_VERSION;

  const first = await selectRuntimeVersion({ view });
  assert.equal(first.version, '1.146.0');
  assert.equal(first.meta.abap2ui5.transpiler, '2.13.91', 'the answer carries what the install needs');
  const again = await selectRuntimeVersion({ view });
  assert.equal(again.version, '1.146.0');
  assert.match(again.source, /asked/);
  assert.equal(calls.length, 1, 'the second call is answered from the cache');

  // a day later, with the registry unreachable: the newest installed release
  fakeInstalled('1.145.0');
  fakeInstalled('1.144.9');
  const later = Date.now() + 2 * 24 * 60 * 60_000;
  const offline = await selectRuntimeVersion({ view: viewOf({}), now: later });
  assert.equal(offline.version, '1.145.0');
  assert.match(offline.source, /newest installed.*ENOTFOUND/);
  assert.deepEqual(installedRuntimes(), ['1.145.0', '1.144.9']);

  // A2UI5_MCP_OFFLINE never asks
  process.env.A2UI5_MCP_OFFLINE = '1';
  const quiet = [];
  assert.equal((await selectRuntimeVersion({ view: viewOf({}, quiet) })).version, '1.145.0');
  assert.equal(quiet.length, 0);
}));

test('nothing installed and no registry: a sentence, never a guess', withWorkspace(async () => {
  const res = await selectRuntimeVersion({ view: viewOf({}) });
  assert.match(res.error, /no @abap2ui5\/node-runtime is installed.*A2UI5_MCP_RUNTIME_VERSION/);
}));

test('the release in use: the pin, the last build, the newest installed', withWorkspace(async () => {
  assert.equal(currentRuntimeVersion(), null);
  fakeInstalled('1.145.0');
  assert.deepEqual(currentRuntimeVersion(), { version: '1.145.0', source: 'the newest installed' });
  fakeInstalled('1.146.0');
  fs.writeFileSync(path.join(runtimeBase(), 'current.json'), JSON.stringify({ version: '1.145.0' }));
  assert.deepEqual(currentRuntimeVersion(), { version: '1.145.0', source: 'the last build' });
  process.env.A2UI5_MCP_RUNTIME_VERSION = '1.147.0';
  assert.deepEqual(currentRuntimeVersion(), { version: '1.147.0', source: 'A2UI5_MCP_RUNTIME_VERSION' });
}));

test('the workspace layout: one directory per release, the sandbox and open-abap-core beside them', withWorkspace(async (t, { workspace }) => {
  assert.equal(runtimeDir('1.145.0'), path.join(workspace, 'runtime', '1.145.0'));
  assert.equal(npmSandboxDir(), path.join(workspace, 'sandbox'), 'outside runtime/: a new release keeps the deployed apps');
  assert.equal(openAbapCoreDir('b'.repeat(40)), path.join(workspace, 'open-abap-core', 'b'.repeat(40)));
  assert.equal(appsDir(runtimeDir('1.145.0')), path.join(workspace, 'runtime', '1.145.0', 'apps'));
  assert.equal(downportDir(runtimeDir('1.145.0')), path.join(workspace, 'runtime', '1.145.0', 'node_modules', '@abap2ui5', 'node-runtime', 'downport'));
}));

// ------------------------------------------------------------- the install ----

/* npm, recorded: every call's arguments go to a log; `install` creates a
 * package.json per spec in node_modules (the package also gets output/init.mjs)
 * and records the exact version in the directory's package.json, the way
 * --save-exact does. */
function fakeNpm(bin, log) {
  const script = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] !== 'install') process.exit(0);
const pkgFile = path.join(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
for (const spec of args.filter((a) => !a.startsWith('-') && a !== 'install')) {
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  let version = spec.slice(at + 1);
  if (!/^\\d/.test(version)) version = '5.2.1';
  const dir = path.join(process.cwd(), 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, abap2ui5: { transpiler: '2.13.91' } }));
  if (name === '@abap2ui5/node-runtime') { fs.mkdirSync(path.join(dir, 'output'), { recursive: true }); fs.writeFileSync(path.join(dir, 'output', 'init.mjs'), ''); }
  pkg.dependencies[name] = version;
}
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), '{}');
`;
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), script);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
}

test('the install: exact versions, --ignore-scripts, a lockfile, and nothing twice', { skip: !POSIX && 'a POSIX npm stand-in' }, withWorkspace(async (t, { ws }) => {
  const bin = path.join(ws, 'bin');
  const log = path.join(ws, 'npm.log');
  fakeNpm(bin, log);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  // app-template, as the lint reads its pin
  const template = path.join(ws, 'app-template');
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, 'abaplint.jsonc'), '{}'); // the probe that makes it a template checkout
  fs.writeFileSync(path.join(template, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@abaplint/cli': { version: '2.120.60' } } }));
  process.env.APP_TEMPLATE_HOME = template;

  const lines = [];
  const res = await ensureRuntime({ version: '1.145.0', meta: META_145, onLine: (l) => lines.push(l) });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.installed, true);
  assert.deepEqual(res.cli, { version: '2.120.60', source: 'app-template package-lock.json' });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, fs.realpathSync(runtimeDir('1.145.0')));
  for (const flag of ['install', '--ignore-scripts', '--save-exact']) assert.ok(calls[0].args.includes(flag), flag);
  assert.deepEqual(calls[0].args.filter((a) => a.includes('@')).sort(), [
    '@abap2ui5/node-runtime@1.145.0', '@abaplint/cli@2.120.60', '@abaplint/transpiler-cli@2.13.91', 'express@^5.0.0',
  ]);
  assert.ok(fs.existsSync(path.join(runtimeDir('1.145.0'), RUNTIME_MARKER)), 'a complete install is marked');
  assert.deepEqual(installedRuntimes(), ['1.145.0']);
  assert.ok(lines.some((l) => /installed in/.test(l)), lines.join('\n'));

  // complete: no npm at all
  const again = await ensureRuntime({ version: '1.145.0', meta: META_145 });
  assert.equal(again.ok, true);
  assert.equal(again.installed, false);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);

  // the template moves its pin: only the lint's abaplint is installed again
  fs.writeFileSync(path.join(template, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@abaplint/cli': { version: '2.120.61' } } }));
  const bumped = await ensureRuntime({ version: '1.145.0', meta: META_145 });
  assert.equal(bumped.ok, true, bumped.reason);
  const last = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.deepEqual(last.args.filter((a) => a.includes('@')), ['@abaplint/cli@2.120.61']);

  // two callers at once: one npm after the other, never two over one node_modules
  fs.rmSync(path.join(runtimeDir('1.145.0'), RUNTIME_MARKER));
  const both = await Promise.all([ensureRuntime({ version: '1.145.0', meta: META_145 }), ensureRuntime({ version: '1.145.0', meta: META_145, withLint: false })]);
  assert.ok(both.every((r) => r.ok));
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3, 'the second caller found the directory complete');
}));

test('a release the registry does not have is reported as missing', withWorkspace(async () => {
  const res = await ensureRuntime({ version: '1.144.0', view: viewOf({ [`${RUNTIME_PKG}@1.144.0`]: { ok: false, missing: true, error: 'E404' } }) });
  assert.equal(res.ok, false);
  assert.equal(res.missing, true);
  assert.match(res.reason, /the registry has no @abap2ui5\/node-runtime@1\.144\.0/);
  assert.equal((await ensureRuntime({ version: '../x' })).ok, false, 'a version is never a path');
}));

// --------------------------------------------------------- open-abap-core ----

function fakeGit(bin, log, { head }) {
  const script = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === 'checkout') { fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), 'src', 'cl_x.clas.abap'), ''); }
if (args[0] === 'rev-parse') console.log(${JSON.stringify(head)});
if (args[0] === 'ls-remote') console.log(${JSON.stringify(head)} + '\\tHEAD');
`;
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'), script);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
}

test('open-abap-core is fetched at the commit, verified, and shared by sha', { skip: !POSIX && 'a POSIX git stand-in' }, withWorkspace(async (t, { ws }) => {
  const sha = KNOWN_OPEN_ABAP_CORE['1.145.0'];
  const bin = path.join(ws, 'bin');
  const log = path.join(ws, 'git.log');
  fakeGit(bin, log, { head: sha });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const res = await ensureOpenAbapCore({ sha });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.dir, openAbapCoreDir(sha));
  assert.ok(fs.existsSync(path.join(res.dir, 'src', 'cl_x.clas.abap')));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
  assert.deepEqual(calls.map((a) => a[0]), ['init', 'fetch', 'checkout', 'rev-parse']);
  assert.deepEqual(calls[1], ['fetch', '--quiet', '--depth', '1', 'https://github.com/open-abap/open-abap-core', sha]);
  assert.deepEqual(fs.readdirSync(path.dirname(res.dir)), [sha], 'no temporary directory left behind');
  assert.equal((await ensureOpenAbapCore({ sha })).fetched, false, 'shared: the second release on that sha fetches nothing');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 4);

  // a checkout that is not the commit asked for is refused, and nothing is kept
  const other = 'c'.repeat(40);
  const wrong = await ensureOpenAbapCore({ sha: other });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /checked out b2d219df/);
  assert.ok(!fs.existsSync(openAbapCoreDir(other)));
  assert.equal((await ensureOpenAbapCore({ sha: '--upload-pack=touch x' })).ok, false, 'a sha is never an option');

  // a release that records nothing: HEAD, resolved to a sha first and said so
  const lines = [];
  const floating = await ensureOpenAbapCore({ sha: null, onLine: (l) => lines.push(l) });
  assert.equal(floating.sha, sha);
  assert.match(floating.source, /floating HEAD/);
  assert.ok(lines.some((l) => /records no commit/.test(l)));
}));

// ---------------------------------------------------------------- the build ----

/* A transpiler stand-in: reads the config it is given, checks the libraries
 * are there, and writes what the real one writes for each input object -
 * the module with its cx_root import, a testclasses module - plus the
 * dependency output the real one cannot be told to leave out, a runner and
 * an init.mjs. */
const FAKE_TRANSPILER = `
const fs = require('fs'); const path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const lib of cfg.libs) if (!fs.existsSync(path.join(process.cwd(), lib.folder))) { console.log('Error: Library folder not found: ' + lib.folder); process.exit(1); }
const filter = new RegExp(cfg.input_filter[0], 'i');
const files = fs.readdirSync(cfg.input_folder).filter((f) => filter.test(path.join(cfg.input_folder, f)));
if (files.some((f) => fs.readFileSync(path.join(cfg.input_folder, f), 'utf8').includes('BROKEN'))) { console.log('Error: check_syntax, Method "nope" not found, zcl_broken.clas.abap:3'); process.exit(1); }
const objs = [...new Set(files.map((f) => f.split('.').slice(0, 2).join('.')))];
const out = cfg.output_folder;
fs.writeFileSync(path.join(out, 'cx_root.clas.mjs'), 'export class cx_root {}');
let runner = 'import "./init.mjs";\\nfunction getData() {\\n  const ret = [];\\n';
let init = 'await initializeABAP();\\nawait import("./cx_root.clas.mjs");\\n';
for (const o of objs) {
  fs.writeFileSync(path.join(out, o + '.mjs'), 'const {cx_root} = await import("./cx_root.clas.mjs");\\nclass x {}\\n');
  fs.writeFileSync(path.join(out, o + '.mjs.map'), '{}');
  init += 'await import("./' + o + '.mjs");\\n';
  if (files.includes(o + '.testclasses.abap')) {
    fs.writeFileSync(path.join(out, o + '.testclasses.mjs'), 'const {x} = await import("./' + o + '.mjs");\\nconst {cx_root} = await import("./cx_root.clas.mjs");\\n');
    runner += '  ret.push({objectName: "' + o.split('.')[0].toUpperCase() + '", localClass: "ltcl", methods: [], filename: "./' + o + '.testclasses.mjs"});\\n';
  }
}
runner += '  return ret;\\n}\\nasync function run() {\\n  for (const st of getData()) {\\n  }\\n}\\n';
fs.writeFileSync(path.join(out, 'index.mjs'), runner);
fs.writeFileSync(path.join(out, 'init.mjs'), init);
console.log(objs.length + 1 + ' objects written to disk');
`;

function fakeRuntime(version) {
  const dir = runtimeDir(version);
  const cli = path.join(dir, 'node_modules', '@abaplint', 'transpiler-cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@abaplint/transpiler-cli', bin: { abap_transpile: './abap_transpile' } }));
  fs.writeFileSync(path.join(cli, 'abap_transpile'), FAKE_TRANSPILER);
  fs.mkdirSync(downportDir(dir), { recursive: true });
  const core = openAbapCoreDir(KNOWN_OPEN_ABAP_CORE['1.145.0']);
  fs.mkdirSync(path.join(core, 'src'), { recursive: true });
  return { dir, core };
}

test('the build keeps only the dev apps, points their imports at the package, and prunes a removed app', withWorkspace(async () => {
  const { dir, core } = fakeRuntime('1.145.0');
  const box = npmSandboxDir();
  fs.mkdirSync(box, { recursive: true });
  for (const f of ['zcl_a.clas.abap', 'zcl_a.clas.xml', 'zcl_a.clas.testclasses.abap', 'zcl_b.clas.abap', 'zcl_b.clas.xml']) fs.writeFileSync(path.join(box, f), '* source');
  fs.writeFileSync(path.join(box, 'README.md'), 'not an object');

  const lines = [];
  const res = await buildApps({ dir, version: '1.145.0', inputDir: box, coreDir: core, onLine: (l) => lines.push(l) });
  assert.equal(res.ok, true, `${res.reason}\n${lines.join('\n')}`);
  assert.deepEqual(res.objects, ['zcl_a.clas', 'zcl_b.clas']);
  assert.deepEqual(res.tests, ['ZCL_A']);
  const apps = appsDir(dir);
  assert.deepEqual(fs.readdirSync(apps).sort(), [
    BUILD_RECORD, 'index.mjs', 'init.mjs', 'zcl_a.clas.mjs', 'zcl_a.clas.mjs.map', 'zcl_a.clas.testclasses.mjs', 'zcl_b.clas.mjs', 'zcl_b.clas.mjs.map',
  ], 'no framework module, no dependency output');
  assert.match(fs.readFileSync(path.join(apps, 'zcl_a.clas.mjs'), 'utf8'), /await import\("@abap2ui5\/node-runtime\/output\/cx_root\.clas\.mjs"\)/);
  assert.match(fs.readFileSync(path.join(apps, 'zcl_a.clas.testclasses.mjs'), 'utf8'), /await import\("\.\/zcl_a\.clas\.mjs"\)/, 'a dev module finds its class beside it');
  assert.match(fs.readFileSync(path.join(apps, 'index.mjs'), 'utf8'), /import "\.\/init\.mjs";/, 'the runner boots through apps/init.mjs');
  const init = fs.readFileSync(path.join(apps, 'init.mjs'), 'utf8');
  assert.match(init, /await import\("\.\/zcl_a\.clas\.mjs"\);\nawait import\("\.\/zcl_b\.clas\.mjs"\);/);
  const record = JSON.parse(fs.readFileSync(path.join(apps, BUILD_RECORD), 'utf8'));
  assert.equal(record.runtime, '1.145.0');
  assert.deepEqual(record.testObjects, ['ZCL_A']);
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('.staging-') || f.startsWith('.apps-')), 'no staging left behind');

  // zcl_b removed from the sandbox: the next build has no trace of it
  fs.rmSync(path.join(box, 'zcl_b.clas.abap'));
  fs.rmSync(path.join(box, 'zcl_b.clas.xml'));
  const again = await buildApps({ dir, version: '1.145.0', inputDir: box, coreDir: core });
  assert.equal(again.ok, true, again.reason);
  assert.ok(!fs.readdirSync(apps).some((f) => f.startsWith('zcl_b')), fs.readdirSync(apps).join(', '));
}));

test('a class the transpiler rejects fails the build with its message, and the last good apps/ stays', withWorkspace(async () => {
  const { dir, core } = fakeRuntime('1.145.0');
  const box = npmSandboxDir();
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(path.join(box, 'zcl_a.clas.abap'), '* fine');
  assert.equal((await buildApps({ dir, version: '1.145.0', inputDir: box, coreDir: core })).ok, true);
  fs.writeFileSync(path.join(box, 'zcl_broken.clas.abap'), 'BROKEN');
  const res = await buildApps({ dir, version: '1.145.0', inputDir: box, coreDir: core });
  assert.equal(res.ok, false);
  assert.match(res.reason, /exited 1:\nError: check_syntax, Method "nope" not found/);
  assert.ok(fs.existsSync(path.join(appsDir(dir), 'zcl_a.clas.mjs')), 'a failed build leaves the served apps alone');
  // and a runtime without its transpiler says so rather than asking npx
  fs.rmSync(path.join(dir, 'node_modules', '@abaplint'), { recursive: true });
  assert.match((await buildApps({ dir, version: '1.145.0', inputDir: box, coreDir: core })).reason, /abap_transpile is not installed.*build_backend installs it/);
}));

// The dev sandbox's second home (lib/runtime.mjs sandbox): with no corpus
// checkout, deploy_app writes into the framework checkout's node/zz_dev and
// lints with app-template's config retargeted at it - the lint a real project
// runs. Sibling-free: the "framework checkout" is a temp dir carrying the probe
// file, pointed at through A2UI5_HOME (authoritative, so no mirror and no
// sibling guess interferes), and the corpus env var points nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandbox, deployApp, removeApp, readAppSource, listDevApps, frameworkLintConfig, corpusLintConfig,
  FRAMEWORK_SANDBOX, frameworkCloneDir, setupStatus, syncDevCopies, buildBackend, DEV_COPIES, CHECKOUT_BUILD_RECORD,
} from '../lib/runtime.mjs';
import { workspaceRoot, resolveA2UI5 } from '../lib/repos.mjs';

const ENV = ['A2UI5_HOME', 'SAMPLES_CONTROLS_HOME', 'AI_DEMOKIT_HOME', 'A2UI5_MCP_WORKSPACE', 'APP_TEMPLATE_HOME', 'A2UI5_MCP_SCREENSHOT_DIR'];

function withFakeFramework(fn) {
  return async (t) => {
    const saved = Object.fromEntries(ENV.map((v) => [v, process.env[v]]));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-sandbox-test-'));
    const a2 = path.join(root, 'abap2UI5');
    fs.mkdirSync(path.join(a2, 'node/srv'), { recursive: true });
    fs.writeFileSync(path.join(a2, 'node/srv/express.mjs'), '// probe');
    fs.writeFileSync(path.join(a2, 'package.json'), '{"name":"abap2UI5","version":"1.144.0"}');
    process.env.A2UI5_HOME = a2;
    process.env.SAMPLES_CONTROLS_HOME = path.join(root, 'no-corpus');
    // a build's last-build.json stays here, not in the user's <tmp> default
    process.env.A2UI5_MCP_SCREENSHOT_DIR = path.join(root, 'shots');
    delete process.env.AI_DEMOKIT_HOME;
    try {
      await fn(t, { root, a2 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

const APP = 'CLASS zcl_probe DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES z2ui5_if_app. ENDCLASS.\nCLASS zcl_probe IMPLEMENTATION. METHOD z2ui5_if_app~main. ENDMETHOD. ENDCLASS.';
const TESTS = 'CLASS ltcl DEFINITION FINAL FOR TESTING RISK LEVEL HARMLESS DURATION SHORT. ENDCLASS.';

test('without a corpus the sandbox is the framework checkout\'s node/zz_dev', withFakeFramework(async (t, { a2 }) => {
  assert.equal(resolveA2UI5({ local: true }), a2);
  const box = sandbox();
  assert.equal(box.kind, 'framework');
  assert.equal(box.root, a2);
  assert.equal(box.dir, path.join(a2, ...FRAMEWORK_SANDBOX));

  const res = deployApp({ className: 'zcl_probe', source: APP, testclasses: TESTS, description: 'probe' });
  assert.equal(res.abapPath, path.join(box.dir, 'zcl_probe.clas.abap'));
  assert.equal(res.testclassesPath, path.join(box.dir, 'zcl_probe.clas.testclasses.abap'));
  const xml = fs.readFileSync(path.join(box.dir, 'zcl_probe.clas.xml'), 'utf8');
  assert.equal(xml.charCodeAt(0), 0xfeff, 'the sidecar carries the BOM abapGit and xml_bom expect');
  assert.match(xml, /<CLSNAME>ZCL_PROBE<\/CLSNAME>/);
  assert.match(xml, /<WITH_UNIT_TESTS>X<\/WITH_UNIT_TESTS>/);
  assert.deepEqual(listDevApps(), ['zcl_probe'], 'the test include is not listed as an app of its own');
  const read = readAppSource('zcl_probe');
  assert.equal(read.testclasses, true);
  assert.equal(read.staleInBackend, null, 'no built backend to compare against');

  // a redeploy without tests drops the include and the sidecar flag
  deployApp({ className: 'zcl_probe', source: APP });
  assert.ok(!fs.existsSync(res.testclassesPath));
  assert.doesNotMatch(fs.readFileSync(path.join(box.dir, 'zcl_probe.clas.xml'), 'utf8'), /WITH_UNIT_TESTS/);
  assert.equal(removeApp('zcl_probe'), 2);
  assert.deepEqual(listDevApps(), []);
}));

test('deployApp refuses test classes that are not test classes, and non-string ones', withFakeFramework(async () => {
  assert.throws(() => deployApp({ className: 'zcl_probe', source: APP, testclasses: APP }), /does not define a test class/);
  assert.throws(() => deployApp({ className: 'zcl_probe', source: APP, testclasses: 42 }), /must be a string/);
  // an empty string means "none" - the same as leaving it out
  const res = deployApp({ className: 'zcl_probe', source: APP, testclasses: '   ' });
  assert.equal(res.testclassesPath, null);
  removeApp('zcl_probe');
}));

test('with neither checkout the sandbox names both ways in', withFakeFramework(async (t, { root }) => {
  process.env.A2UI5_HOME = path.join(root, 'no-framework');
  assert.throws(() => sandbox(), /no dev sandbox.*SAMPLES_CONTROLS_HOME.*A2UI5_HOME/);
  assert.throws(() => deployApp({ className: 'zcl_probe', source: APP }), /no dev sandbox/);
}));

test('frameworkLintConfig retargets app-template\'s config at the sandbox with the framework as the dependency', () => {
  const template = `{
    // the template's own comments survive stripJsonc
    "global": { "files": "/src/**/*.*", "exclude": ["something"] },
    "dependencies": [{ "url": "https://github.com/abap2UI5/abap2UI5", "branch": "1.144.0", "files": "/src/**/*.*" }],
    "syntax": { "version": "v750", "errorNamespace": "^(Z|Y)" },
    "rules": { "check_syntax": true, "object_naming": { "patternKind": "required", "clas": "^ZCL_|^ZCX_", "intf": "^ZIF_" } }
  }`;
  const cfg = frameworkLintConfig(template);
  assert.equal(cfg.global.files, '/node/zz_dev/**/*.*');
  assert.equal(cfg.global.exclude, undefined);
  assert.deepEqual(cfg.dependencies, [{ folder: '/src', files: '/**/*.*' }]);
  assert.equal(cfg.syntax.version, 'v750', 'everything else is the template\'s decision');
  assert.equal(cfg.rules.check_syntax, true);
  assert.equal(cfg.rules.object_naming.clas, '^[ZY]', 'the customer namespace, like the corpus config');
  assert.equal(cfg.rules.object_naming.patternKind, 'required');
  // a template without object_naming stays without it
  assert.equal(frameworkLintConfig('{"rules":{}}').rules.object_naming, undefined);
});

test('corpusLintConfig relaxes the corpus config exactly as before', () => {
  const cfg = corpusLintConfig('{"global":{"exclude":["zz_dev","other"]},"rules":{"object_naming":{"clas":"^Z2UI5_CL_SMPC_","intf":"^Z2UI5_IF_"}}}');
  assert.deepEqual(cfg.global.exclude, ['other']);
  assert.equal(cfg.rules.object_naming.clas, '^[ZY]');
  assert.equal(cfg.rules.object_naming.intf, '^[ZY]');
});

test('the framework clone lands in the workspace, which the env var moves', () => {
  const saved = process.env.A2UI5_MCP_WORKSPACE;
  try {
    delete process.env.A2UI5_MCP_WORKSPACE;
    assert.equal(workspaceRoot(), path.join(os.homedir(), '.abap2ui5-mcp'));
    assert.equal(frameworkCloneDir(), path.join(os.homedir(), '.abap2ui5-mcp', 'abap2UI5'));
    process.env.A2UI5_MCP_WORKSPACE = '/somewhere/else';
    assert.equal(frameworkCloneDir(), path.join('/somewhere/else', 'abap2UI5'));
  } finally {
    if (saved === undefined) delete process.env.A2UI5_MCP_WORKSPACE;
    else process.env.A2UI5_MCP_WORKSPACE = saved;
  }
});

test('setupStatus reports the framework sandbox and the fake checkout', withFakeFramework(async (t, { a2 }) => {
  const st = setupStatus();
  assert.equal(st.repos.a2ui5.local, a2);
  assert.equal(st.repos.a2ui5.env, 'A2UI5_HOME');
  assert.equal(st.repos.corpus.missing, true);
  assert.match(st.repos.corpus.hint, /SAMPLES_CONTROLS_HOME is set/);
  assert.equal(st.sandbox.kind, 'framework');
  assert.deepEqual(st.sandbox.deployedApps, []);
  assert.equal(st.backend.checkout, a2);
  assert.equal(st.backend.built, false);
  assert.equal(st.backend.cloneTarget, frameworkCloneDir());
  assert.ok(st.settings.timeouts.A2UI5_MCP_UNIT_TIMEOUT_MS > 0);
}));

// ------------------------------------------------------ the CI unit runner ----

import { execFileSync as run } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frameworkPinOf, collectObjects, writeObjects, parseArgs, renderSummary, staleWorkspaceClone, chooseBackend } from '../scripts/ci-unit.mjs';
import { filteredRunner, RUNNER_LOOP } from '../lib/runtime.mjs';

test('the CI runner reads the project\'s framework pin, collects classes, interfaces, tables and data elements with all their files, and renders', () => {
  assert.equal(frameworkPinOf('{ "dependencies": [ { "url": "https://github.com/abap2UI5/abap2UI5", "branch": "1.144.0", "files": "/src/**/*.*" } ] }'), '1.144.0');
  assert.equal(frameworkPinOf('{ "dependencies": [ { "url": "https://github.com/abap2UI5/abap2UI5.git", "branch": "main" } ] }'), null, 'a branch name is not a release pin');
  assert.equal(frameworkPinOf('{ "dependencies": [ { "url": "https://github.com/other/repo", "branch": "1.0.0" } ] }'), null);
  assert.equal(frameworkPinOf('not json'), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-ci-unit-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'zcl_a.clas.abap'), 'CLASS zcl_a');
    fs.writeFileSync(path.join(root, 'src', 'zcl_a.clas.testclasses.abap'), 'CLASS ltcl FOR TESTING');
    fs.writeFileSync(path.join(root, 'src', 'zcl_a.clas.xml'), '<x/>');
    fs.writeFileSync(path.join(root, 'src', 'sub', 'zcl_b.clas.abap'), 'CLASS zcl_b');
    fs.writeFileSync(path.join(root, 'src', 'zif_x.intf.abap'), 'INTERFACE');
    fs.writeFileSync(path.join(root, 'src', 'zif_x.intf.xml'), '<x/>');
    fs.writeFileSync(path.join(root, 'src', 'sub', 'zcl_b.clas.locals_imp.abap'), 'CLASS lcl_b');
    fs.writeFileSync(path.join(root, 'src', 'zcl_orphan.clas.xml'), '<x/>'); // a sidecar without its source is no object
    fs.writeFileSync(path.join(root, 'src', 'package.devc.xml'), '<x/>');
    // a table and a data element are their XML alone
    fs.writeFileSync(path.join(root, 'src', 'zmcp_note.tabl.xml'), '<x/>');
    fs.writeFileSync(path.join(root, 'src', 'sub', 'zmcp_note_text.dtel.xml'), '<x/>');
    const objects = collectObjects([path.join(root, 'src')]).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(objects.map((o) => [o.name, o.type, o.testclasses, o.files.map((f) => f.name).sort()]), [
      ['zcl_a', 'clas', true, ['zcl_a.clas.abap', 'zcl_a.clas.testclasses.abap', 'zcl_a.clas.xml']],
      ['zcl_b', 'clas', false, ['zcl_b.clas.abap', 'zcl_b.clas.locals_imp.abap']],
      ['zif_x', 'intf', false, ['zif_x.intf.abap', 'zif_x.intf.xml']],
      ['zmcp_note', 'tabl', false, ['zmcp_note.tabl.xml']],
      ['zmcp_note_text', 'dtel', false, ['zmcp_note_text.dtel.xml']],
    ]);
    fs.rmSync(path.join(root, 'src', 'zmcp_note.tabl.xml'));
    fs.rmSync(path.join(root, 'src', 'sub', 'zmcp_note_text.dtel.xml'));

    // written under the sandbox's name gate: a namespaced object or one that is there twice is refused, the rest copied as it is
    fs.writeFileSync(path.join(root, 'src', '#ns#cl_y.clas.abap'), 'CLASS /ns/cl_y');
    fs.mkdirSync(path.join(root, 'src', 'again'));
    fs.writeFileSync(path.join(root, 'src', 'again', 'zif_x.intf.abap'), 'INTERFACE again');
    const box = path.join(root, 'box');
    const { written, errors } = writeObjects(collectObjects([path.join(root, 'src')]), box);
    assert.deepEqual(Object.keys(errors).sort(), ['#ns#cl_y', 'zif_x']);
    assert.match(errors['#ns#cl_y'], /invalid class name/);
    assert.match(errors.zif_x, /zif_x\.intf\.abap is there twice/);
    assert.deepEqual(fs.readdirSync(box).sort(), ['zcl_a.clas.abap', 'zcl_a.clas.testclasses.abap', 'zcl_a.clas.xml', 'zcl_b.clas.abap', 'zcl_b.clas.locals_imp.abap']);
    assert.equal(written.length, 5);
    assert.equal(fs.readFileSync(path.join(box, 'zcl_a.clas.xml'), 'utf8'), '<x/>', 'the project\'s own sidecar, not a generated one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const opts = parseArgs(['src', 'more', '--class', 'ZCL_A', '--framework', '1.144.0', '--json', '--keep']);
  assert.deepEqual(opts.paths, ['src', 'more']);
  assert.deepEqual(opts.classes, ['zcl_a']);
  assert.equal(opts.framework, '1.144.0');
  assert.equal(opts.json && opts.keep, true);
  assert.deepEqual(parseArgs([]).paths, ['src']);
  assert.throws(() => parseArgs(['--framework']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);

  const md = renderSummary({
    framework: '1.144.0',
    mode: 'incremental',
    results: [
      { cls: 'zcl_a', testclasses: true, tests: [{ localClass: 'ltcl', method: 'ok_one' }, { localClass: 'ltcl', method: 'bad_one' }], failed: { localClass: 'ltcl', method: 'bad_one', error: 'Error: boom' } },
      { cls: 'zcl_b', testclasses: false },
      { cls: 'zcl_c', testclasses: true, deployError: 'source does not implement z2ui5_if_app' },
    ],
  });
  assert.match(md, /## abap2UI5 unit tests \(framework 1\.144\.0, backend: incremental\)/);
  assert.match(md, /- ok  ZCL_A ltcl->ok_one/);
  assert.match(md, /- \*\*FAIL\*\*  ZCL_A ltcl->bad_one/);
  assert.match(md, /Error: boom/);
  assert.match(md, /ZCL_B: no test include/);
  assert.match(md, /ZCL_C\*\*: not deployed - source does not implement/);
  assert.match(md, /2 test method\(s\) ran, 2 class\(es\) failing/);
  // a setup that threw before its class's first test: the class fails, with the fixture named
  const fixture = renderSummary({
    framework: '1.145.0',
    mode: 'npm',
    results: [{ cls: 'zcl_d', testclasses: true, tests: [], failed: { object: 'ZCL_D', localClass: null, method: 'setup', fixture: true, error: 'cx_sy_zerodivide' } }],
  });
  assert.match(fixture, /- \*\*FAIL\*\*  ZCL_D setup \(the test class's setup, before its test method ran\)/);
  assert.doesNotMatch(fixture, /found no test method/);
  assert.match(fixture, /1 class\(es\) failing/);
  /* The runner stops at the first failure: a class after the failing one
   * printed no test, and was reported as having "no test method" - a
   * false diagnosis in every CI summary with two test classes and a red one */
  const stopped = renderSummary({
    framework: '1.145.0',
    mode: 'npm',
    results: [
      { cls: 'zcl_e', testclasses: true, tests: [{ localClass: 'ltcl', method: 'bad' }], failed: { object: 'ZCL_E', localClass: 'ltcl', method: 'bad', error: 'boom' } },
      { cls: 'zcl_f', testclasses: true, tests: [], failed: null, notRun: 'the runner stops at the first failure (ZCL_E), and this class\'s tests had not started' },
    ],
  });
  assert.match(stopped, /\*\*ZCL_F\*\*: not run - the runner stops at the first failure \(ZCL_E\)/);
  assert.doesNotMatch(stopped, /found no test method/);
  assert.match(stopped, /1 test method\(s\) ran, 1 class\(es\) failing/);
});

/* abap2ui5-unit runs on the npm package by default: a checkout somebody
 * named is used as it is, the clone an earlier version made in the workspace
 * only when the clone is asked for - so a CI cache or a developer's machine
 * that still carries one does not fall back to the slow path by accident. */
test('the CI runner takes the npm package unless a checkout is named or the clone is asked for', () => {
  const cloneDir = path.join('/ws', 'abap2UI5');
  assert.equal(chooseBackend({ cloneDir }), 'npm', 'nothing there: the package');
  assert.equal(chooseBackend({ a2: cloneDir, cloneDir }), 'npm', 'the workspace clone of an earlier version is not a choice');
  assert.equal(chooseBackend({ a2: cloneDir, cloneDir, requested: 'clone' }), 'checkout', '--backend clone uses it');
  assert.equal(chooseBackend({ requested: 'clone', cloneDir }), 'clone', '--backend clone without one clones');
  assert.equal(chooseBackend({ a2: '/home/me/abap2UI5', cloneDir }), 'checkout', 'a sibling is somebody\'s checkout');
  assert.equal(chooseBackend({ a2: cloneDir, cloneDir, envSet: true }), 'checkout', 'A2UI5_HOME naming the clone is a choice');
  assert.equal(chooseBackend({ envSet: true, cloneDir }), 'missing', 'A2UI5_HOME pointing nowhere');
  assert.equal(chooseBackend({ a2: '/home/me/abap2UI5', cloneDir, requested: 'npm' }), 'npm', '--backend npm beside a checkout');

  assert.equal(parseArgs(['--backend', 'npm']).backend, 'npm');
  assert.equal(parseArgs(['--backend', 'clone', 'src']).backend, 'clone');
  assert.throws(() => parseArgs(['--backend', 'docker']), /--backend is npm or clone/);
  assert.equal(parseArgs(['--framework', 'main']).framework, 'main', 'a branch still reaches the clone path');
  assert.match(renderSummary({ framework: '1.145.0', mode: 'npm', results: [] }), /framework 1\.145\.0, backend: @abap2ui5\/node-runtime/);
});

test('the abap2ui5-unit bin runs when invoked through npm\'s bin symlink', () => {
  /* npm installs a bin as node_modules/.bin/<name> -> the script; process.argv[1]
   * then carries the LINK. The main guard used to compare that plain path with
   * the module's real one and never matched, so the bin exited 0 having done
   * nothing. Skipped where a symlink cannot be made (Windows without the
   * privilege). */
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-unit.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-bin-'));
  try {
    const link = path.join(dir, 'abap2ui5-unit');
    try {
      fs.symlinkSync(script, link);
    } catch {
      return; // no symlinks here: nothing to prove
    }
    const out = run(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.match(out, /^abap2ui5-unit/, 'the usage, from the header comment - without the shebang');
    assert.equal(run(process.execPath, [link, '--print-pin'], { encoding: 'utf8', cwd: dir }), '\n', 'no abaplint.jsonc here: an empty pin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CI runner replaces its own workspace clone when it is not at the pin, and nothing else', () => {
  const cloneDir = path.join('/ws', 'abap2UI5');
  assert.equal(staleWorkspaceClone({ a2: cloneDir, have: '1.143.0', pin: '1.144.0', cloneDir, envSet: false }), true);
  assert.equal(staleWorkspaceClone({ a2: cloneDir, have: '1.144.0', pin: '1.144.0', cloneDir, envSet: false }), false, 'at the pin: kept');
  assert.equal(staleWorkspaceClone({ a2: cloneDir, have: '1.143.0', pin: null, cloneDir, envSet: false }), false, 'no pin: whatever is there');
  assert.equal(staleWorkspaceClone({ a2: '/elsewhere/abap2UI5', have: '1.143.0', pin: '1.144.0', cloneDir, envSet: false }), false, 'a sibling is somebody else\'s checkout');
  assert.equal(staleWorkspaceClone({ a2: cloneDir, have: '1.143.0', pin: '1.144.0', cloneDir, envSet: true }), false, 'A2UI5_HOME pointing at it is a choice');
  assert.equal(staleWorkspaceClone({ a2: null, have: null, pin: '1.144.0', cloneDir, envSet: false }), false);
});

test('filteredRunner narrows the generated runner to the named objects, or refuses an unknown shape', () => {
  const src = `import "./init.mjs";\nasync function run() {\n  ${RUNNER_LOOP}\n  }\n}`;
  const out = filteredRunner(src, ['zcl_a', 'ZCL_B']);
  assert.match(out, /getData\(\)\.filter\(\(st\) => \["ZCL_A","ZCL_B"\]\.includes\(st\.objectName\)\)/);
  assert.equal(filteredRunner('for (const x of getData()) {', ['zcl_a']), null);
});

/* The incremental build copied the sandbox into node/downport and never took
 * anything back out: a removed app stayed there (build_backend kept
 * transpiling it, or kept failing on it), a redeploy without testclasses left
 * the old include running, and abap2ui5-unit left every class it tested in a
 * developer's checkout. node/downport also holds the framework's OWN files
 * at its root, so only what the manifest says this server copied is ever
 * removed. */
const appNamed = (cls) => APP.replace(/zcl_probe/g, cls);

test('dev-app copies in node/downport follow the sandbox, and nothing else there is touched', withFakeFramework(async (t, { a2 }) => {
  const down = path.join(a2, 'node', 'downport');
  fs.mkdirSync(down, { recursive: true });
  fs.writeFileSync(path.join(down, 'zcl_sicf.clas.abap'), '* the framework\'s own');
  fs.writeFileSync(path.join(down, 'package.devc.xml'), '<framework/>');
  // a copy an older server left behind, identical to what is deployed: adopted
  deployApp({ className: 'zcl_old', source: appNamed('zcl_old') });
  fs.copyFileSync(path.join(sandbox().dir, 'zcl_old.clas.abap'), path.join(down, 'zcl_old.clas.abap'));

  deployApp({ className: 'zcl_a', source: appNamed('zcl_a'), testclasses: TESTS });
  deployApp({ className: 'zcl_b', source: appNamed('zcl_b') });
  fs.writeFileSync(path.join(sandbox().dir, 'package.devc.xml'), '<sandbox/>');
  const first = syncDevCopies(a2);
  assert.ok(first.copied.includes('zcl_a.clas.testclasses.abap'));
  assert.ok(!first.copied.includes('package.devc.xml'), 'the sandbox package is not an app');
  assert.equal(fs.readFileSync(path.join(down, 'package.devc.xml'), 'utf8'), '<framework/>');
  const owned = JSON.parse(fs.readFileSync(path.join(down, DEV_COPIES), 'utf8')).files;
  assert.ok(owned.includes('zcl_old.clas.abap'), 'the identical leftover is adopted');
  assert.ok(!owned.includes('zcl_sicf.clas.abap'));

  // redeploy without tests: the include goes from downport too
  deployApp({ className: 'zcl_a', source: appNamed('zcl_a') });
  const second = syncDevCopies(a2);
  assert.deepEqual(second.removed, ['zcl_a.clas.testclasses.abap']);
  assert.ok(!fs.existsSync(path.join(down, 'zcl_a.clas.testclasses.abap')));
  assert.ok(fs.existsSync(path.join(down, 'zcl_a.clas.abap')));

  // remove_app takes the copies out at once, no build needed
  removeApp('zcl_b');
  removeApp('zcl_old');
  for (const f of ['zcl_b.clas.abap', 'zcl_b.clas.xml', 'zcl_old.clas.abap']) assert.ok(!fs.existsSync(path.join(down, f)), f);

  // a framework file a dev app overwrote is not the server's to delete
  deployApp({ className: 'zcl_sicf', source: appNamed('zcl_sicf') });
  syncDevCopies(a2);
  removeApp('zcl_sicf');
  assert.ok(fs.existsSync(path.join(down, 'zcl_sicf.clas.abap')), 'not in the manifest: left alone');
  assert.ok(!fs.existsSync(path.join(down, 'zcl_sicf.clas.xml')), 'the sidecar it brought along is removed');

  removeApp('zcl_a');
  assert.ok(!fs.existsSync(path.join(down, DEV_COPIES)), 'nothing left to track: no manifest');
  assert.deepEqual(fs.readdirSync(down).sort(), ['package.devc.xml', 'zcl_sicf.clas.abap']);
}));

test('an incremental build after remove_app no longer transpiles the removed class', withFakeFramework(async (t, { root, a2 }) => {
  // a prior build, the framework's own libs present, and a transpiler that
  // records what node/downport held when it ran
  for (const d of ['node/downport', 'node/output', 'node/setup', 'node/deps/open-abap-core']) fs.mkdirSync(path.join(a2, d), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node/output/init.mjs'), '');
  fs.writeFileSync(path.join(a2, 'node/setup/abap_transpile.json'), JSON.stringify({
    input_folder: 'node/downport', output_folder: 'node/output', libs: [{ url: 'https://github.com/open-abap/open-abap-core', folder: '/node/deps/open-abap-core' }],
  }));
  const cli = path.join(a2, 'node_modules/@abaplint/transpiler-cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ bin: { abap_transpile: './abap_transpile' } }));
  fs.writeFileSync(path.join(cli, 'abap_transpile'), "console.log('INPUT ' + require('fs').readdirSync('node/downport').filter((f) => !f.startsWith('.')).sort().join(','));");

  deployApp({ className: 'zcl_keep', source: appNamed('zcl_keep') });
  deployApp({ className: 'zcl_gone', source: appNamed('zcl_gone'), testclasses: TESTS });
  const one = await buildBackend({ mode: 'incremental' });
  assert.equal(one.ok, true, one.tail);
  assert.match(one.tail, /INPUT .*zcl_gone\.clas\.testclasses\.abap/);

  removeApp('zcl_gone');
  const two = await buildBackend({ mode: 'incremental' });
  assert.equal(two.ok, true, two.tail);
  assert.match(two.tail, /INPUT zcl_keep\.clas\.abap,zcl_keep\.clas\.xml$/m);
  assert.ok(!fs.existsSync(path.join(a2, 'e2e-transpile.json')), 'the temporary config is gone');
  assert.ok(fs.existsSync(path.join(root, 'shots', 'last-build.json')), 'the build log stays in the test\'s own dir');

  /* nothing changed since: the record in node/output carries this
   * fingerprint, the transpiler is not run, the backend is not stopped */
  assert.ok(fs.existsSync(path.join(a2, 'node/output', CHECKOUT_BUILD_RECORD)), 'the build is recorded');
  let stops = 0;
  const three = await buildBackend({ mode: 'incremental', beforeBuild: async () => { stops += 1; } });
  assert.equal(three.ok, true, three.tail);
  assert.equal(three.unchanged, true);
  assert.doesNotMatch(three.tail, /INPUT /, 'the transpiler did not run');
  assert.equal(stops, 0);
  // the framework's sources moved (a pull): built again
  fs.writeFileSync(path.join(a2, 'node/downport/z2ui5_cl_new.clas.abap'), 'CLASS z2ui5_cl_new DEFINITION.');
  const four = await buildBackend({ mode: 'incremental', beforeBuild: async () => { stops += 1; } });
  assert.equal(four.ok, true, four.tail);
  assert.equal(four.unchanged, undefined);
  assert.match(four.tail, /INPUT /);
  assert.equal(stops, 1);
  // and a redeployed class is a change of the sandbox
  deployApp({ className: 'zcl_keep', source: `${appNamed('zcl_keep')}\n* edited` });
  const five = await buildBackend({ mode: 'incremental', beforeBuild: async () => { stops += 1; } });
  assert.equal(five.unchanged, undefined);
  assert.equal(stops, 2);
  // node/output replaced behind the record's back (a prebuilt download): the record is stale
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(a2, 'node/output/init.mjs'), later, later);
  const six = await buildBackend({ mode: 'incremental', beforeBuild: async () => { stops += 1; } });
  assert.equal(six.unchanged, undefined, 'another init.mjs than the record names is not this build');
  assert.equal(stops, 3);
}));

test('syncDevCopies leaves a copy that already holds the sandbox\'s bytes untouched', withFakeFramework(async (t, { a2 }) => {
  const down = path.join(a2, 'node', 'downport');
  fs.mkdirSync(down, { recursive: true });
  deployApp({ className: 'zcl_a', source: appNamed('zcl_a') });
  const first = syncDevCopies(a2);
  assert.deepEqual(first.changed.sort(), ['zcl_a.clas.abap', 'zcl_a.clas.xml']);
  const copy = path.join(down, 'zcl_a.clas.abap');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(copy, old, old);
  const second = syncDevCopies(a2);
  assert.deepEqual(second.changed, [], 'identical bytes: nothing written');
  assert.ok(second.copied.includes('zcl_a.clas.abap'), 'still synced, still owned');
  assert.ok(Math.abs(fs.statSync(copy).mtimeMs - old.getTime()) < 10, 'the copy keeps its mtime');
  deployApp({ className: 'zcl_a', source: `${appNamed('zcl_a')}\n* edited` });
  const third = syncDevCopies(a2);
  assert.deepEqual(third.changed, ['zcl_a.clas.abap'], 'a changed source is written, its unchanged sidecar is not');
}));

/* The first build on a checkout downloads the framework's prebuilt backend,
 * which carries the FRAMEWORK - no dev app is in it. build_backend's auto
 * (and verify_app's build stage) answered built and pointed at run_app, and
 * the deployed app was then "not in the system" (app_start: HTTP 500,
 * app_list: nothing) until a second build_backend made the incremental one.
 * Now auto goes on into that incremental build in the same call; an explicit
 * prebuilt stays the framework alone and names the apps it left out. */
test('a first auto build on a checkout transpiles the deployed apps on top of the prebuilt backend', { skip: process.platform === 'win32' && 'tar and POSIX stand-ins' }, withFakeFramework(async (t, { root, a2 }) => {
  const { execFileSync } = await import('node:child_process');
  const http = await import('node:http');
  fs.mkdirSync(path.join(a2, 'node_modules', 'express'), { recursive: true }); // no npm ci in a test
  fs.mkdirSync(path.join(a2, 'node/setup'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node/setup/abap_transpile.json'), JSON.stringify({
    input_folder: 'node/downport', output_folder: 'node/output', libs: [{ url: 'https://github.com/open-abap/open-abap-core', folder: '/node/deps/open-abap-core' }],
  }));
  const cli = path.join(a2, 'node_modules/@abaplint/transpiler-cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ bin: { abap_transpile: './abap_transpile' } }));
  fs.writeFileSync(path.join(cli, 'abap_transpile'), "console.log('INPUT ' + require('fs').readdirSync('node/downport').filter((f) => !f.startsWith('.')).sort().join(','));");
  // the release asset: the framework transpiled, nothing of the sandbox
  const src = path.join(root, 'asset');
  for (const d of ['node/output', 'node/downport', 'node/deps/open-abap-core/src']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'node/output/init.mjs'), 'export const init = 1;');
  fs.writeFileSync(path.join(src, 'node/downport/z2ui5_cl_x.clas.abap'), 'CLASS z2ui5_cl_x DEFINITION.');
  fs.writeFileSync(path.join(src, 'backend-manifest.json'), JSON.stringify({ version: '1.144.0', commit: 'abc123', builtAt: '2026-09-19T00:00:00Z', contents: ['node/downport', 'node/output', 'node/deps'] }));
  const tar = path.join(root, 'backend.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', src, '.']);
  const srv = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/gzip' }).end(fs.readFileSync(tar)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.A2UI5_MCP_PREBUILT_URL = `http://127.0.0.1:${srv.address().port}/backend.tar.gz`;
  const savedBackend = process.env.A2UI5_MCP_BACKEND;
  delete process.env.A2UI5_MCP_BACKEND;
  try {
    deployApp({ className: 'zcl_probe', source: APP });

    // explicit prebuilt: the framework alone, the deployed app named as left out
    const alone = await buildBackend({ mode: 'prebuilt' });
    assert.equal(alone.ok, true, alone.tail);
    assert.equal(alone.mode, 'prebuilt');
    assert.deepEqual(alone.devAppsNotBuilt, ['zcl_probe']);
    assert.doesNotMatch(alone.tail, /INPUT/, 'no transpile ran');

    // auto on a checkout with no prior build: prebuilt, then the incremental build of the sandbox
    fs.rmSync(path.join(a2, 'node/output'), { recursive: true, force: true });
    const auto = await buildBackend({ mode: 'auto' });
    assert.equal(auto.ok, true, auto.tail);
    assert.equal(auto.mode, 'prebuilt+incremental');
    assert.equal(auto.devAppsNotBuilt, undefined);
    assert.match(auto.tail, /incremental build of the 1 deployed dev app\(s\) on top of it: zcl_probe/);
    assert.match(auto.tail, /INPUT .*zcl_probe\.clas\.abap/, 'the deployed app was transpiled into the backend');

    // nothing deployed: auto is the prebuilt alone, as before
    removeApp('zcl_probe');
    fs.rmSync(path.join(a2, 'node/output'), { recursive: true, force: true });
    const bare = await buildBackend({ mode: 'auto' });
    assert.equal(bare.ok, true, bare.tail);
    assert.equal(bare.mode, 'prebuilt');
    assert.doesNotMatch(bare.tail, /INPUT/);
  } finally {
    delete process.env.A2UI5_MCP_PREBUILT_URL;
    if (savedBackend !== undefined) process.env.A2UI5_MCP_BACKEND = savedBackend;
    srv.close();
  }
}));

test('two dev apps deployed without a description do not share one', withFakeFramework(async () => {
  // abaplint's identical_descriptions (on in app-template's config) failed
  // every second app while the default was the constant 'MCP dev app'
  deployApp({ className: 'zcl_one', source: appNamed('zcl_one') });
  deployApp({ className: 'zcl_two', source: appNamed('zcl_two') });
  const desc = (c) => /<DESCRIPT>([^<]*)<\/DESCRIPT>/.exec(fs.readFileSync(path.join(sandbox().dir, `${c}.clas.xml`), 'utf8'))[1];
  assert.notEqual(desc('zcl_one'), desc('zcl_two'));
  assert.match(desc('zcl_one'), /zcl_one/);
  deployApp({ className: 'zcl_one', source: appNamed('zcl_one'), description: 'Sales <orders> & more' });
  assert.equal(desc('zcl_one'), 'Sales  orders    more', 'a given description is kept, XML-safe');
  removeApp('zcl_one');
  removeApp('zcl_two');
}));

/* The customer namespace is not the dev apps' alone: the framework's z2ui5_*
 * classes are in it, and so is zcl_sicf, the ICF handler in node/srv every
 * host boots - the incremental build would copy a dev app of that name over
 * the framework's own output. */
test('a dev app is never named like the framework\'s or the corpus\' own objects, and is no clash with itself', withFakeFramework(async (t, { root, a2 }) => {
  fs.mkdirSync(path.join(a2, 'src', '02'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'src', '02', 'z2ui5_cl_app_hello_world.clas.abap'), '');
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'zcl_sicf.clas.abap'), '');
  assert.throws(() => deployApp({ className: 'zcl_sicf', source: appNamed('zcl_sicf') }),
    /zcl_sicf is the framework's own class \(.*node[\\/]srv[\\/]zcl_sicf\.clas\.abap\).*second copy/s);
  assert.throws(() => deployApp({ className: 'Z2UI5_CL_APP_HELLO_WORLD', source: appNamed('z2ui5_cl_app_hello_world') }),
    /z2ui5_cl_app_hello_world is the framework's own class/);
  assert.deepEqual(listDevApps(), [], 'nothing written for a refused name');
  deployApp({ className: 'zcl_probe', source: APP });
  deployApp({ className: 'zcl_probe', source: APP });

  // the corpus: its own samples count, and so does the framework beside it -
  // its src/zz_dev, the sandbox itself, does not
  const corpus = path.join(root, 'samples-controls');
  fs.mkdirSync(path.join(corpus, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'scripts', 'e2e-build.mjs'), '// probe');
  fs.mkdirSync(path.join(corpus, 'src', '01'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'src', '01', 'z2ui5_cl_demo_app_001.clas.abap'), '');
  process.env.SAMPLES_CONTROLS_HOME = corpus;
  assert.equal(sandbox().kind, 'corpus');
  assert.throws(() => deployApp({ className: 'z2ui5_cl_demo_app_001', source: appNamed('z2ui5_cl_demo_app_001') }),
    /z2ui5_cl_demo_app_001 is samples-controls' own class/);
  assert.throws(() => deployApp({ className: 'zcl_sicf', source: appNamed('zcl_sicf') }), /the framework's own class/);
  deployApp({ className: 'zcl_probe', source: APP });
  deployApp({ className: 'zcl_probe', source: APP });
  assert.deepEqual(listDevApps(), ['zcl_probe']);
}));

/* GitHub's releases/latest is the NEWEST release, and the framework publishes
 * each version twice: X.Y.Z (with the prebuilt backend asset) and, seconds
 * later, its 7.02 downport X.Y.Z-702. "latest" was the downport, so the clone
 * got downported sources no backend asset exists for. */
test('the framework clone takes the highest plain X.Y.Z release, never the -702 downport', async () => {
  const { latestPlainRelease, cloneFramework } = await import('../lib/runtime.mjs');
  const releases = [
    { tag_name: '1.145.0-702' }, { tag_name: '1.145.0' }, { tag_name: '1.144.1-702' }, { tag_name: '1.144.1' },
    { tag_name: '1.146.0', draft: true }, { tag_name: '1.147.0', prerelease: true }, { tag_name: '1.99.9' }, { tag_name: 'v1.100.0' },
  ];
  assert.equal(latestPlainRelease(releases), '1.145.0');
  assert.equal(latestPlainRelease([{ tag_name: '1.9.0' }, { tag_name: '1.10.0' }]), '1.10.0', 'numeric, not lexical');
  assert.equal(latestPlainRelease([{ tag_name: '1.145.0-702' }]), null);
  assert.equal(latestPlainRelease(null), null);

  // and cloneFramework asks the LIST, then clones exactly that tag - git is a
  // recording stand-in on PATH, so nothing reaches the network
  if (process.platform === 'win32') return;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-clone-'));
  const bin = path.join(ws, 'bin');
  fs.mkdirSync(bin);
  const record = path.join(ws, 'git-args.txt');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" > ${JSON.stringify(record)}\nexit 1\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const saved = { A2UI5_MCP_WORKSPACE: process.env.A2UI5_MCP_WORKSPACE, PATH: process.env.PATH };
  process.env.A2UI5_MCP_WORKSPACE = path.join(ws, 'workspace');
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  try {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(releases) };
    };
    const res = await cloneFramework({ fetchImpl, onLine: () => {} });
    assert.equal(res.ok, false, 'the stand-in git clones nothing');
    assert.ok(asked[0].includes('/releases?'), `the release list is asked, not releases/latest: ${asked[0]}`);
    assert.match(fs.readFileSync(record, 'utf8'), /--branch 1\.145\.0 /);
    // a release list over the text cap is not read: the default branch then
    const lines = [];
    const huge = async () => new Response('[]', { headers: { 'content-length': String(64 * 1048576) } });
    await cloneFramework({ fetchImpl: huge, onLine: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /latest release could not be looked up \(the answer for .* is larger than 8 MB/.test(l)), lines.join('\n'));
    assert.doesNotMatch(fs.readFileSync(record, 'utf8'), /--branch/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

/* action.yml's run: blocks are shell scripts the runner builds by PASTING
 * every `${{ ... }}` expression into the text before bash parses it:
 * `set -- ${{ inputs.paths }}` ran a `paths` of `src; exit 0 #` as code -
 * the step passed without running a test. Inputs reach a script through
 * `env:` only, and what the scripts write to $GITHUB_OUTPUT (a cache key)
 * is reduced to a name. */
const ACTION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'action.yml');
function runBlocks(yml) {
  const blocks = [];
  const lines = yml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && m[2] !== '|' && m[2] !== '>') {
      blocks.push(m[2]);
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) body.push(lines[j]);
    blocks.push(body.join('\n'));
  }
  return blocks;
}

test('action.yml never pastes an expression into a shell script', () => {
  const blocks = runBlocks(fs.readFileSync(ACTION, 'utf8'));
  assert.ok(blocks.length >= 2, 'the pin step and the test step');
  for (const b of blocks) assert.doesNotMatch(b, /\$\{\{/, `a run: block with an expression in it:\n${b}`);
});

test('action.yml\'s pin step writes one sane pin and backend, whatever the inputs hold', { skip: process.platform === 'win32' && 'bash' }, () => {
  const pinStep = runBlocks(fs.readFileSync(ACTION, 'utf8'))[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-action-'));
  try {
    const out = path.join(dir, 'output');
    fs.writeFileSync(out, '');
    run('bash', ['-c', pinStep], {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_OUTPUT: out,
        GITHUB_ACTION_PATH: path.dirname(ACTION),
        A2UI5_UNIT_FRAMEWORK: '1.145.0\nbackend=evil',
        A2UI5_UNIT_BACKEND: 'npm x',
      },
    });
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['pin=1.145.0_backend_evil', 'backend=npm_x']);
    // no input and no pin in the project: the week's latest
    fs.writeFileSync(out, '');
    run('bash', ['-c', pinStep], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_ACTION_PATH: path.dirname(ACTION), A2UI5_UNIT_FRAMEWORK: '', A2UI5_UNIT_BACKEND: '' } });
    const [pin, backend] = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.match(pin, /^pin=latest-\d{4}-\d{2}$/);
    assert.equal(backend, 'backend=npm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* abap2ui5-unit on a checkout somebody named (--home): every class and
 * interface into its dev sandbox, the incremental build, the tests - and
 * exactly the files it wrote taken out of the sandbox and node/downport
 * again, an MCP session's app beside them left alone. The transpiler is a
 * stand-in that writes a runner of the generated shape over node/downport. */
test('abap2ui5-unit on a named checkout deploys every object and takes exactly those out again', { skip: process.platform === 'win32' && 'POSIX stand-ins' }, withFakeFramework(async (t, { root, a2 }) => {
  const { spawnSync } = await import('node:child_process');
  for (const d of ['node/downport', 'node/output', 'node/setup', 'node/deps/open-abap-core']) fs.mkdirSync(path.join(a2, d), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node/output/init.mjs'), '');
  fs.writeFileSync(path.join(a2, 'node/downport/zcl_sicf.clas.abap'), '* the framework\'s own');
  fs.writeFileSync(path.join(a2, 'node/setup/abap_transpile.json'), JSON.stringify({
    input_folder: 'node/downport', output_folder: 'node/output', libs: [{ url: 'https://github.com/open-abap/open-abap-core', folder: '/node/deps/open-abap-core' }],
  }));
  const cli = path.join(a2, 'node_modules/@abaplint/transpiler-cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ bin: { abap_transpile: './abap_transpile' } }));
  fs.writeFileSync(path.join(cli, 'abap_transpile'), `
const fs = require('fs'); const path = require('path');
const down = 'node/downport'; const out = 'node/output';
const tests = fs.readdirSync(down).filter((f) => f.endsWith('.clas.testclasses.abap'));
let data = '';
for (const f of tests) {
  const o = f.replace('.testclasses.abap', '');
  const fail = fs.readFileSync(path.join(down, f), 'utf8').includes('FAIL');
  fs.writeFileSync(path.join(out, o + '.testclasses.mjs'), 'export class ltcl { async constructor_() { return this; } async check() { ' + (fail ? 'throw new Error("assert_equals failed");' : '') + ' } }\\n');
  data += '  ret.push({objectName: "' + o.split('.')[0].toUpperCase() + '", localClass: "ltcl", methods: [{"name":"check"}], filename: "./' + o + '.testclasses.mjs"});\\n';
}
fs.writeFileSync(path.join(out, 'index.mjs'), 'import "./init.mjs";\\nfunction getData() {\\n  const ret = [];\\n' + data + '  return ret;\\n}\\nasync function run() {\\n  for (const st of getData()) {\\n    const localClass = (await import(st.filename))[st.localClass];\\n    for (const m of st.methods) {\\n      const test = await (new localClass()).constructor_();\\n      console.log(st.objectName + ": running " + st.localClass + "->" + m.name);\\n      await test[m.name]();\\n    }\\n  }\\n}\\nrun().then(() => process.exit(0)).catch((err) => { console.log(err); process.exit(1); });\\n');
fs.writeFileSync(path.join(out, 'init.mjs'), '');
fs.appendFileSync('inputs.log', fs.readdirSync(down).filter((f) => !f.startsWith('.')).sort().join(',') + '\\n');
`);
  // an MCP session's app in the checkout's sandbox
  deployApp({ className: 'zcl_session', source: appNamed('zcl_session') });
  const repo = path.join(root, 'project');
  const src = path.join(repo, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.abap'), appNamed('zcl_proj_app'));
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.testclasses.abap'), TESTS);
  fs.writeFileSync(path.join(src, 'zcl_proj_app.clas.locals_imp.abap'), 'CLASS lcl DEFINITION. ENDCLASS.');
  fs.writeFileSync(path.join(src, 'zcl_proj_helper.clas.abap'), 'CLASS zcl_proj_helper DEFINITION PUBLIC. ENDCLASS.');
  fs.writeFileSync(path.join(src, 'zcl_proj_helper.clas.testclasses.abap'), `${TESTS} " FAIL`);
  fs.writeFileSync(path.join(src, 'zif_proj_thing.intf.abap'), 'INTERFACE zif_proj_thing PUBLIC. ENDINTERFACE.');
  // after the failing class in the runner's order: never reached
  fs.writeFileSync(path.join(src, 'zcl_proj_zlast.clas.abap'), 'CLASS zcl_proj_zlast DEFINITION PUBLIC. ENDCLASS.');
  fs.writeFileSync(path.join(src, 'zcl_proj_zlast.clas.testclasses.abap'), TESTS);
  const box = sandbox().dir;
  const before = fs.readdirSync(box).sort();

  const res = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-unit.mjs'), 'src', '--home', a2, '--json'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, A2UI5_MCP_BACKEND: '' },
  });
  const report = JSON.parse(res.stdout || 'null');
  assert.ok(report, res.stderr);
  assert.equal(report.backend, 'checkout');
  const inputs = fs.readFileSync(path.join(a2, 'inputs.log'), 'utf8').trim().split('\n').pop();
  assert.match(inputs, /zcl_proj_app\.clas\.locals_imp\.abap.*zcl_proj_helper\.clas\.testclasses\.abap.*zif_proj_thing\.intf\.abap/, 'every file of every object was transpiled');
  const byClass = Object.fromEntries(report.results.map((r) => [r.cls, r]));
  assert.equal(byClass.zcl_proj_helper.failed.object, 'ZCL_PROJ_HELPER');
  assert.equal(byClass.zcl_proj_app.failed, null);
  assert.equal(byClass.zcl_proj_app.notRun, undefined, 'it ran, before the failure');
  assert.deepEqual(byClass.zcl_proj_zlast.tests, []);
  assert.match(byClass.zcl_proj_zlast.notRun, /the runner stops at the first failure \(ZCL_PROJ_HELPER\)/);
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(fs.readdirSync(box).sort(), before, 'the session\'s app stays, the project\'s files are gone');
  assert.ok(!fs.readdirSync(path.join(a2, 'node/downport')).some((f) => f.startsWith('zcl_proj_') || f.startsWith('zif_proj_')), 'no copy of the project left in node/downport');
  assert.ok(fs.existsSync(path.join(a2, 'node/downport/zcl_sicf.clas.abap')), 'the framework\'s own file stays');
}));

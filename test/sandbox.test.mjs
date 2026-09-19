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
  FRAMEWORK_SANDBOX, frameworkCloneDir, setupStatus,
} from '../lib/runtime.mjs';
import { workspaceRoot, resolveA2UI5 } from '../lib/repos.mjs';

const ENV = ['A2UI5_HOME', 'SAMPLES_CONTROLS_HOME', 'AI_DEMOKIT_HOME', 'A2UI5_MCP_WORKSPACE', 'APP_TEMPLATE_HOME'];

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

import { frameworkPinOf, collectClasses, parseArgs, renderSummary } from '../scripts/ci-unit.mjs';
import { filteredRunner, RUNNER_LOOP } from '../lib/runtime.mjs';

test('the CI runner reads the project\'s framework pin, collects classes with their test includes, and renders', () => {
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
    const classes = collectClasses([path.join(root, 'src')]).sort((a, b) => a.cls.localeCompare(b.cls));
    assert.deepEqual(classes.map((c) => [c.cls, Boolean(c.testclasses)]), [['zcl_a', true], ['zcl_b', false]]);
    assert.equal(classes[0].testclasses, 'CLASS ltcl FOR TESTING');
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
});

test('filteredRunner narrows the generated runner to the named objects, or refuses an unknown shape', () => {
  const src = `import "./init.mjs";\nasync function run() {\n  ${RUNNER_LOOP}\n  }\n}`;
  const out = filteredRunner(src, ['zcl_a', 'ZCL_B']);
  assert.match(out, /getData\(\)\.filter\(\(st\) => \["ZCL_A","ZCL_B"\]\.includes\(st\.objectName\)\)/);
  assert.equal(filteredRunner('for (const x of getData()) {', ['zcl_a']), null);
});

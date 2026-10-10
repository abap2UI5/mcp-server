// The warm lint (lib/lint-host.mjs + lib/lint-worker.mjs): one long-lived
// child keeps an @abaplint/core registry with the dependency folder parsed,
// and a lint since then only replaces the sandbox's changed files. Against a
// FAKE @abaplint/core (a CommonJS stand-in that counts what the worker asks
// of it and answers one finding per file carrying FINDME), so the suite
// needs no abaplint; the same worker was run against the real core by hand
// (the findings are the CLI's, byte for byte - lib/lint-host.mjs says why
// the two must agree). Sibling-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintWarm, closeLintWorker, coreForCli, sandboxGlobDir, dependencyFolders, dependencyKey, warmLintEnabled } from '../lib/lint-host.mjs';
import { fakeRelease, fakeTemplate, APP, VERSION } from './helpers/npm-fixture.mjs';

/* The fake core: the API surface the worker uses, nothing more. A file whose
 * text carries FINDME is one finding; DEPS answers how many dependency files
 * the registry holds and how often addDependencies ran in this process;
 * SLOW blocks findIssues for seconds (the timeout test); CRASH exits the
 * worker (the fallback test). */
const FAKE_CORE = `
let adds = 0;
class Position { constructor(r, c) { this.r = r; this.c = c; } getRow() { return this.r; } getCol() { return this.c; } }
class MemoryFile { constructor(f, raw) { this.f = f; this.raw = raw; } getFilename() { return this.f; } getRaw() { return this.raw; } }
class Issue {
  constructor(file, key, message, severity) { this.file = file; this.key = key; this.message = message; this.severity = severity; }
  getMessage() { return this.message; } getKey() { return this.key; } getFilename() { return this.file; }
  getStart() { return new Position(1, 1); } getEnd() { return new Position(1, 6); } getSeverity() { return this.severity; }
}
class Config { constructor(json) { this.cfg = JSON.parse(json); } get() { return this.cfg; } }
class Registry {
  static abaplintVersion() { return '9.9.9'; }
  constructor(cfg) { this.cfg = cfg; this.deps = new Map(); this.files = new Map(); }
  addDependencies(files) { adds += 1; for (const f of files) this.deps.set(f.getFilename(), f.getRaw()); }
  addFile(f) { this.files.set(f.getFilename(), f.getRaw()); }
  updateFile(f) { this.files.set(f.getFilename(), f.getRaw()); }
  removeFile(f) { this.files.delete(f.getFilename()); }
  parse() {}
  findIssues() {
    const out = [];
    for (const [file, raw] of this.files) {
      if (raw.includes('CRASH')) process.exit(3);
      if (raw.includes('SLOW')) { const t = Date.now(); while (Date.now() - t < 5000) { /* busy */ } }
      if (raw.includes('FINDME')) out.push(new Issue(file, 'findme', 'found FINDME', 'Error'));
      if (raw.includes('DEPS')) out.push(new Issue(file, 'deps', 'deps:' + this.deps.size + ' adds:' + adds, 'Info'));
    }
    return out;
  }
}
module.exports = { Registry, Config, MemoryFile, Issue, Position };
`;

function fakeRoot({ cli = '9.9.9', core = '9.9.9', loadable = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lint-worker-'));
  const nm = path.join(base, 'node_modules', '@abaplint');
  fs.mkdirSync(path.join(nm, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'cli', 'package.json'), JSON.stringify({ name: '@abaplint/cli', version: cli, bin: { abaplint: './abaplint' } }));
  if (core) {
    fs.mkdirSync(path.join(nm, 'core'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'core', 'package.json'), JSON.stringify({ name: '@abaplint/core', version: core, ...(loadable ? { main: 'index.js' } : {}) }));
    if (loadable) fs.writeFileSync(path.join(nm, 'core', 'index.js'), FAKE_CORE);
  }
  fs.mkdirSync(path.join(base, 'dep', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(base, 'dep', 'z2ui5_if_app.intf.abap'), 'INTERFACE z2ui5_if_app PUBLIC. ENDINTERFACE.');
  fs.writeFileSync(path.join(base, 'dep', 'sub', 'z2ui5_cl_util.clas.abap'), 'CLASS z2ui5_cl_util DEFINITION PUBLIC. ENDCLASS.');
  fs.writeFileSync(path.join(base, 'dep', 'README.md'), 'one dot: not a lintable file, as the CLI skips it');
  fs.mkdirSync(path.join(base, 'sandbox'));
  return base;
}

const CONFIG = {
  global: { files: '/sandbox/**/*.*' },
  dependencies: [{ folder: '/dep', files: '/**/*.*' }],
  syntax: { version: 'v750', errorNamespace: '^(Z|Y)' },
  rules: { check_syntax: true },
};

const lint = (base, extra = {}) => lintWarm({ binRoot: base, base, config: CONFIG, sandboxDir: path.join(base, 'sandbox'), timeoutMs: 20000, ...extra });
const posix = (p) => p.split(path.sep).join('/');

test.after(async () => { await closeLintWorker(); });

test('the worker parses the dependency folder once and answers the CLI\'s JSON shape', async () => {
  const base = fakeRoot();
  try {
    await closeLintWorker();
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.abap'), 'CLASS zcl_a. FINDME DEPS');
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.xml'), '<xml/>');
    const first = await lint(base);
    assert.equal(first.used, true, first.why);
    assert.equal(first.ok, true);
    assert.equal(first.reparsed, true, 'a fresh worker parses the dependencies');
    assert.equal(first.dependencyFiles, 2, 'two lintable dependency files, the README left out like the CLI does');
    // the shape: exactly the keys and nesting abaplint --format json writes
    assert.deepEqual(first.issues.map((i) => Object.keys(i).sort()), [
      ['description', 'end', 'file', 'key', 'severity', 'start'],
      ['description', 'end', 'file', 'key', 'severity', 'start'],
    ]);
    assert.deepEqual(first.issues[0], {
      description: 'found FINDME', key: 'findme', file: posix(path.join(base, 'sandbox', 'zcl_a.clas.abap')),
      start: { row: 1, col: 1 }, end: { row: 1, col: 6 }, severity: 'Error',
    });
    assert.equal(first.issues[1].description, 'deps:2 adds:1');

    // the second lint: no dependency parse, the same answer
    const second = await lint(base);
    assert.equal(second.reparsed, false, 'the dependencies stay parsed');
    assert.equal(second.dependencyFiles, null);
    assert.deepEqual(second.issues, first.issues);
    assert.equal(second.issues[1].description, 'deps:2 adds:1', 'addDependencies ran once in the worker');

    // a sandbox edit is seen, still without a dependency parse; a removed file is gone
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.abap'), 'CLASS zcl_a. DEPS');
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_b.clas.abap'), 'CLASS zcl_b. FINDME');
    const edited = await lint(base);
    assert.equal(edited.reparsed, false);
    assert.deepEqual(edited.issues.map((i) => [path.basename(i.file), i.key]), [['zcl_a.clas.abap', 'deps'], ['zcl_b.clas.abap', 'findme']]);
    fs.rmSync(path.join(base, 'sandbox', 'zcl_b.clas.abap'));
    const removed = await lint(base);
    assert.deepEqual(removed.issues.map((i) => i.key), ['deps']);
    assert.equal(removed.issues[0].description, 'deps:2 adds:1');

    // the dependency folder changed (a pull, a new release's downport): parsed again
    fs.writeFileSync(path.join(base, 'dep', 'z2ui5_cl_new.clas.abap'), 'CLASS z2ui5_cl_new DEFINITION PUBLIC. ENDCLASS.');
    const pulled = await lint(base);
    assert.equal(pulled.reparsed, true);
    assert.equal(pulled.dependencyFiles, 3);
    assert.equal(pulled.issues[0].description, 'deps:3 adds:2');
    // and a changed config is another registry
    const other = await lint(base, { config: { ...CONFIG, syntax: { ...CONFIG.syntax, version: 'v702' } } });
    assert.equal(other.reparsed, true);
    assert.equal((await lint(base, { config: { ...CONFIG, syntax: { ...CONFIG.syntax, version: 'v702' } } })).reparsed, false);
  } finally {
    await closeLintWorker();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the worker is not used when it cannot stand in for the CLI, and says why', async () => {
  const roots = [];
  try {
    const noCore = fakeRoot({ core: null });
    roots.push(noCore);
    const r1 = await lint(noCore);
    assert.equal(r1.used, false);
    assert.match(r1.why, /no @abaplint\/core installed beside the @abaplint\/cli 9\.9\.9/);

    const mismatch = fakeRoot({ core: '9.9.8' });
    roots.push(mismatch);
    const r2 = await lint(mismatch);
    assert.equal(r2.used, false);
    assert.match(r2.why, /@abaplint\/core 9\.9\.8 is not the @abaplint\/cli 9\.9\.9's version/);
    assert.deepEqual(coreForCli(mismatch).ok, false);

    const base = fakeRoot();
    roots.push(base);
    assert.equal((await lint(base, { env: { A2UI5_MCP_LINT_WORKER: '0' } })).why, 'A2UI5_MCP_LINT_WORKER=0');
    assert.equal(warmLintEnabled({}), true);
    assert.equal(warmLintEnabled({ A2UI5_MCP_LINT_WORKER: 'off' }), false);
    // config shapes the worker does not mirror: the CLI runs them as before
    const excluded = await lint(base, { config: { ...CONFIG, global: { files: '/sandbox/**/*.*', exclude: ['x'] } } });
    assert.match(excluded.why, /exclude list/);
    const cloned = await lint(base, { config: { ...CONFIG, dependencies: [{ url: 'https://github.com/abap2UI5/abap2UI5', files: '/src/**/*.*' }] } });
    assert.match(cloned.why, /the CLI would clone it/);
    const corpus = await lint(base, { config: { ...CONFIG, global: { files: '/src/**/*.*' } } });
    assert.match(corpus.why, /not the sandbox/);
    const many = await lint(base, { config: { ...CONFIG, global: { files: ['/sandbox/**/*.*', '/more/**/*.*'] } } });
    assert.match(many.why, /global\.files the worker does not mirror/);
    // the pure halves
    assert.equal(sandboxGlobDir('/sandbox/**/*.*'), 'sandbox');
    assert.equal(sandboxGlobDir('/node/zz_dev/**/*.*'), 'node/zz_dev');
    assert.equal(sandboxGlobDir('/src/**/*.abap'), null);
    assert.deepEqual(dependencyFolders(CONFIG, '/ws').folders, [path.resolve('/ws', 'dep')]);
    assert.match(dependencyFolders({ global: { useApackDependencies: true }, dependencies: [{ folder: '/x' }] }, '/ws').why, /apack/);
    // a core that cannot be loaded is a worker that answers no result: the CLI's turn, and the next lint tries again
    const broken = fakeRoot({ loadable: false });
    roots.push(broken);
    const r3 = await lint(broken);
    assert.equal(r3.used, false);
    assert.match(r3.why, /Cannot find module|@abaplint\/core/);
  } finally {
    await closeLintWorker();
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  }
});

test('dependencyKey moves with the folder\'s files, the config and the core version', () => {
  const base = fakeRoot();
  try {
    const folders = [path.join(base, 'dep')];
    const k1 = dependencyKey({ config: CONFIG, folders, coreVersion: '9.9.9' });
    assert.equal(dependencyKey({ config: CONFIG, folders, coreVersion: '9.9.9' }), k1, 'stable over an unchanged folder');
    assert.notEqual(dependencyKey({ config: CONFIG, folders, coreVersion: '9.9.10' }), k1);
    assert.notEqual(dependencyKey({ config: { ...CONFIG, rules: {} }, folders, coreVersion: '9.9.9' }), k1);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(base, 'dep', 'z2ui5_if_app.intf.abap'), later, later);
    assert.notEqual(dependencyKey({ config: CONFIG, folders, coreVersion: '9.9.9' }), k1, 'a touched file is a change');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a timeout and a cancel kill the worker and are answered as such; the next lint starts afresh', async () => {
  const base = fakeRoot();
  try {
    await closeLintWorker();
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.abap'), 'CLASS zcl_a. SLOW');
    const t0 = Date.now();
    const slow = await lint(base, { timeoutMs: 300 });
    assert.equal(slow.used, true);
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - t0 < 4000, 'killed at the timeout, not waited out');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const cancelled = await lint(base, { signal: ac.signal, timeoutMs: 20000 });
    assert.equal(cancelled.aborted, true);
    const already = new AbortController();
    already.abort();
    assert.equal((await lint(base, { signal: already.signal })).aborted, true, 'an aborted signal lints nothing');

    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.abap'), 'CLASS zcl_a. FINDME');
    const fresh = await lint(base);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.reparsed, true, 'a fresh worker after the kill');
    assert.equal(fresh.issues.length, 1);

    // a worker that dies mid-lint hands the call to the CLI; the one after runs warm again
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.abap'), 'CLASS zcl_a. CRASH');
    const crashed = await lint(base);
    assert.equal(crashed.used, false);
    assert.match(crashed.why, /the lint worker exited/);
    fs.writeFileSync(path.join(base, 'sandbox', 'zcl_a.clas.abap'), 'CLASS zcl_a. FINDME');
    assert.equal((await lint(base)).issues.length, 1);
  } finally {
    await closeLintWorker();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* Through lintApp on the npm backend: the fixture's release with a WORKING
 * fake core beside its abaplint - the lint runs warm, the recording CLI
 * stand-in is never spawned, and the answer has deploy_app's lint shape. */
test('lintApp on the npm backend runs warm when the release has the cli\'s core, the CLI otherwise', async () => {
  const ENV = ['A2UI5_MCP_BACKEND', 'A2UI5_MCP_WORKSPACE', 'A2UI5_MCP_RUNTIME_VERSION', 'A2UI5_HOME', 'SAMPLES_CONTROLS_HOME',
    'AI_DEMOKIT_HOME', 'APP_TEMPLATE_HOME', 'A2UI5_MCP_REMOTE', 'A2UI5_MCP_OFFLINE', 'LINT_RECORD', 'A2UI5_MCP_LINT_WORKER'];
  const saved = Object.fromEntries(ENV.map((v) => [v, process.env[v]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lint-warm-'));
  const workspace = path.join(root, 'workspace');
  const { resetNpmBackend } = await import('../lib/npm-backend.mjs');
  const { deployApp, lintApp } = await import('../lib/runtime.mjs');
  try {
    process.env.A2UI5_MCP_BACKEND = 'npm';
    process.env.A2UI5_MCP_WORKSPACE = workspace;
    process.env.A2UI5_MCP_RUNTIME_VERSION = VERSION;
    process.env.SAMPLES_CONTROLS_HOME = path.join(root, 'no-corpus');
    process.env.APP_TEMPLATE_HOME = fakeTemplate(path.join(root, 'app-template'));
    process.env.A2UI5_MCP_REMOTE = '0';
    process.env.LINT_RECORD = path.join(root, 'lint.json');
    delete process.env.AI_DEMOKIT_HOME;
    delete process.env.A2UI5_HOME;
    delete process.env.A2UI5_MCP_LINT_WORKER;
    resetNpmBackend();
    await closeLintWorker();
    const dir = fakeRelease(workspace);
    const core = path.join(dir, 'node_modules', '@abaplint', 'core');
    fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@abaplint/core', version: '2.120.60', main: 'index.js' }));
    fs.writeFileSync(path.join(core, 'index.js'), FAKE_CORE);

    deployApp({ className: 'zcl_warm', source: `${APP('zcl_warm')}\n* FINDME DEPS` });
    const lines = [];
    const res = await lintApp('zcl_warm', { onLine: (l) => lines.push(l) });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.deepEqual(res.issues.map((i) => [i.rule, i.message, i.line]), [['findme', 'found FINDME', 1], ['deps', 'deps:1 adds:1', 1]]);
    assert.equal(res.totalRepoIssues, 2);
    assert.ok(lines.some((l) => /abaplint 2\.120\.60 \(warm\): 1 dependency file\(s\) parsed/.test(l)), lines.join('\n'));
    assert.ok(!fs.existsSync(process.env.LINT_RECORD), 'the CLI stand-in did not run');
    assert.ok(!fs.existsSync(path.join(workspace, '.abaplint-mcp-dev.jsonc')), 'the config is removed after the lint');
    const again = await lintApp('zcl_warm', { onLine: (l) => lines.push(l) });
    assert.equal(again.totalRepoIssues, 2);
    assert.ok(lines.filter((l) => /\(warm\)/.test(l)).pop().startsWith("abaplint 2.120.60 (warm): 2 sandbox file"), `no dependency parse the second time:\n${lines.join("\n")}`);

    // switched off: the CLI, recorded
    process.env.A2UI5_MCP_LINT_WORKER = '0';
    const cli = await lintApp('zcl_warm', { onLine: (l) => lines.push(l) });
    assert.equal(cli.ok, true, 'the recording stand-in answers clean');
    assert.ok(fs.existsSync(process.env.LINT_RECORD), 'the CLI ran');
    assert.ok(lines.some((l) => /A2UI5_MCP_LINT_WORKER=0 - running the CLI/.test(l)));
  } finally {
    await closeLintWorker();
    resetNpmBackend();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

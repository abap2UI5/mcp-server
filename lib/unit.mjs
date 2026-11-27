/*
 * unit - run_unit_tests (split out of lib/runtime.mjs, which re-exports it):
 * the runner the transpiler writes, filtered to the classes asked for, and
 * its output read into tests, failures and fixtures.
 */
import fs from 'fs';
import path from 'path';
import { timeoutOf, spawnWithTimeout, timedOutError } from './spawn.mjs';
import { appsDir, appsBuilt, RUNTIME_PKG } from './npm-backend.mjs';
import { a2Local, backendKind, npmRuntimeDir } from './sandbox.mjs';
import { classNameOf } from './deploy.mjs';
import { backendBuilt, building, whileBuilding } from './build.mjs';
import { appChildEnv } from './backend-process.mjs';

// ------------------------------------------------------------ unit tests ----

/* The runner the transpiler writes beside the backend (`write_unit_tests` in
 * the framework's abap_transpile.json): node/output/index.mjs, which runs
 * EVERY test class of the transpiled tree. It takes no filter, so the one
 * class an agent asks about is run by writing a sibling of the runner whose
 * loop is filtered on `objectName` - the runner is generated text with one
 * loop line, and the patch is refused (falling back to the unfiltered run)
 * when that line is not where the template put it. */
export const RUNNER_LOOP = 'for (const st of getData()) {';
const RUNNING_LINE = /^([A-Z0-9_\/]+): running ([A-Za-z0-9_]+)->([A-Za-z0-9_]+)(, skipped .*)?$/;

/* A frame of a test include's module in the stack the runner prints with a
 * failure: `at [async ][new ][<class>.][#]<method> (<dir>/<object>.clas.testclasses.mjs:L:C)`. */
const TEST_FRAME = /^\s*at (?:async )?(new )?(?:([A-Za-z0-9_$]+)\.)?#?([A-Za-z0-9_$]+) \((?:[^()]*[\\/])?([^\\/()]+)\.clas\.testclasses\.mjs:\d+:\d+\)\s*\{?\s*$/;

/* What a test class runs BEFORE the runner prints a test's "running" line:
 * class_setup ahead of the class's first line, the constructor and setup
 * ahead of each method's. A failure in one of them belongs to the test that
 * had not started - never to the one whose line was printed last. */
const BEFORE_THE_LINE = new Set(['class_setup', 'constructor', 'constructor_', 'setup']);

/** A failure in a test class's fixture, read off the stack: `{ object,
 *  localClass, method, fixture: true }`, or null when the test that was
 *  running is on the stack (its own failure) or no fixture is. Pure. */
function fixtureFailure(lines, last) {
  const frames = [];
  for (const line of lines) {
    const m = TEST_FRAME.exec(line);
    if (!m) continue;
    let object = m[4];
    try {
      object = decodeURIComponent(object);
    } catch {
      /* not escaped */
    }
    frames.push({ object: object.replace(/#/g, '/').toUpperCase(), localClass: m[1] ? m[3] : (m[2] || null), method: m[1] ? 'constructor' : m[3] });
  }
  if (last && frames.some((f) => f.object === last.object && f.method.toLowerCase() === last.method.toLowerCase())) return null;
  const f = frames.find((x) => BEFORE_THE_LINE.has(x.method.toLowerCase()));
  return f ? { ...f, fixture: true } : null;
}

/** The runner's output as test results: what ran, what was skipped, and the
 *  failing test with its error when the run stopped - or, when the stack
 *  says a test class's class_setup, constructor or setup threw, that
 *  class's fixture (`fixture: true`). Pure, for the tests. */
export function parseUnitOutput(stdout, code) {
  const tests = [];
  let last = null;
  const after = [];
  for (const line of String(stdout).split('\n')) {
    const m = RUNNING_LINE.exec(line.trim());
    if (m) {
      last = { object: m[1], localClass: m[2], method: m[3], ...(m[4] ? { skipped: m[4].replace(/^, skipped /, '') } : {}) };
      tests.push(last);
      after.length = 0;
    } else if (line.trim()) {
      after.push(line);
    }
  }
  const ran = tests.filter((t) => !t.skipped);
  let failed = null;
  if (code !== 0) {
    const error = after.join('\n').trim().slice(0, 2000);
    const fixture = fixtureFailure(after, last);
    if (fixture) failed = { ...fixture, error };
    else if (last && !last.skipped) failed = { ...last, error };
  }
  return { ok: code === 0, ran: ran.length, skipped: tests.length - ran.length, tests, failed };
}

/**
 * Run the transpiled ABAP Unit tests: all of them, or the test classes of
 * one object. Needs a built backend. Resolves with the parsed results (see
 * parseUnitOutput) plus how the run ended.
 */
/** The generated runner's text, filtered to the objects named (upper case).
 *  Pure; null when the runner has not got the loop line the filter hooks. */
export function filteredRunner(src, names) {
  if (!src.includes(RUNNER_LOOP)) return null;
  const set = JSON.stringify(names.map((n) => String(n).toUpperCase()));
  return src.replace(RUNNER_LOOP, `for (const st of getData().filter((st) => ${set}.includes(st.objectName))) {`);
}

let runnerCopies = 0;

export async function runUnitTests({ className, classNames, signal, onLine, appsDir: ownApps = null } = {}) {
  /* Where the runner is. A checkout: node/output/index.mjs, the transpiler's
   * runner over the WHOLE tree, the framework's own suite included. The npm
   * backend: apps/index.mjs, the runner the transpiler wrote for the dev apps
   * alone (it lists no library object's tests) - booted through apps/init.mjs
   * on the package's runtime. The package's own output/index.mjs is the
   * framework's suite and is never run here. `appsDir` names another build
   * of the npm backend's (abap2ui5-unit builds a project into a directory of
   * its own inside the runtime directory). */
  let base;
  /* This server's own node on every path: a bare `node` is whichever the
   * PATH a desktop client hands its servers finds first - none at all, or
   * an older one than the server runs on. */
  const node = process.execPath;
  /* A run during build_backend loaded the output the build is replacing -
   * on the npm backend apps/ is swapped for the fresh build at its end, so
   * the runner could read the old half of a module graph and the new half
   * of another. Refused as a backend start is. (`appsDir` is a build of the
   * caller's own, which no build_backend touches.) */
  if (building && !ownApps) throw new Error(whileBuilding('run the unit tests', 'the tests would run the output the build is replacing'));
  if (ownApps) {
    if (!fs.existsSync(path.join(ownApps, 'init.mjs'))) throw new Error(`no build in ${ownApps} - build it first`);
    base = { cwd: path.dirname(ownApps), out: ownApps };
  } else if (backendKind() === 'npm') {
    const dir = npmRuntimeDir();
    if (!dir || !appsBuilt(dir)) throw new Error(`backend not built — call build_backend (it installs ${RUNTIME_PKG} and transpiles the deployed apps) before run_unit_tests`);
    base = { cwd: dir, out: appsDir(dir) };
  } else {
    const a2 = a2Local();
    if (!a2) throw new Error('abap2UI5 checkout not found — clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server or point A2UI5_HOME at an existing checkout');
    if (!backendBuilt()) throw new Error('backend not built — call build_backend (mode prebuilt or full the first time) before run_unit_tests');
    base = { cwd: a2, out: path.join(a2, 'node/output') };
  }
  const runner = path.join(base.out, 'index.mjs');
  if (!fs.existsSync(runner)) {
    throw new Error(`the built backend has no ${runner} — it was transpiled without write_unit_tests; run build_backend again`);
  }
  const wanted = [...(classNames || []), ...(className ? [className] : [])].map((c) => classNameOf(c).toUpperCase());
  const cls = wanted.length === 1 ? wanted[0] : null;
  let entry = runner;
  let tmpEntry = null;
  let filtered = false;
  if (wanted.length) {
    const patched = filteredRunner(fs.readFileSync(runner, 'utf8'), wanted);
    if (patched) {
      /* A name of this RUN's: it used to be the selection's alone, and two
       * runs at once over different class sets wrote one file - the first
       * child loaded the second call's filter, and the first call to finish
       * deleted the file under the other. Beside the runner, for its
       * relative imports. */
      runnerCopies += 1;
      tmpEntry = path.join(base.out, `index-mcp-${(cls || 'selection').toLowerCase()}-${process.pid}-${runnerCopies}.mjs`);
      fs.writeFileSync(tmpEntry, patched);
      entry = tmpEntry;
      filtered = true;
    } else if (onLine) {
      onLine('the generated runner has an unexpected shape — running every test and filtering the report');
    }
  }
  let spawned;
  try {
    /* V8 keeps ten frames of a stack by default, and a failure a few calls
     * deep in the code under test loses the test class's frame - which is
     * what tells a failing setup from a failing test (parseUnitOutput). */
    spawned = await spawnWithTimeout(node, ['--stack-trace-limit=100', entry], { cwd: base.cwd, timeoutMs: timeoutOf('A2UI5_MCP_UNIT_TIMEOUT_MS'), signal, onLine, env: appChildEnv() });
  } finally {
    if (tmpEntry) fs.rmSync(tmpEntry, { force: true });
  }
  const { code, stdout, stderr, timedOut, aborted } = spawned;
  if (aborted) return { ok: false, aborted: true, class: cls, ran: 0, tests: [], error: 'run_unit_tests cancelled by the client — the runner\'s process tree was killed' };
  if (timedOut) return { ok: false, timedOut: true, class: cls, ran: 0, tests: [], error: timedOutError('the unit test runner', 'A2UI5_MCP_UNIT_TIMEOUT_MS') };
  const parsed = parseUnitOutput(stdout, code);
  if (wanted.length && !filtered) {
    parsed.tests = parsed.tests.filter((t) => wanted.includes(t.object));
    parsed.ran = parsed.tests.filter((t) => !t.skipped).length;
    parsed.skipped = parsed.tests.length - parsed.ran;
    if (parsed.failed && !wanted.includes(parsed.failed.object)) parsed.failed = null;
  }
  return {
    ...parsed,
    class: cls,
    ...(wanted.length > 1 ? { classes: wanted } : {}),
    filtered,
    ...(code !== 0 && !parsed.failed ? { error: (stderr || stdout).trim().slice(-2000) } : {}),
  };
}

#!/usr/bin/env node
/*
 * abap2ui5-unit — the ABAP Unit tests of an app repository, run in the
 * transpiled backend without a SAP system. For CI, and for a terminal.
 *
 *   npx -p @abap2ui5/mcp-server abap2ui5-unit [paths...] [--framework <X.Y.Z>]
 *                                [--backend npm|clone] [--home <abap2UI5 checkout>]
 *                                [--class <name>]... [--json] [--keep] [--print-pin]
 *
 * What it does, in the order the MCP tools do it, with the same code
 * (lib/runtime.mjs - nothing here is a second implementation):
 *
 *   1. the framework, at the release the project PINS - the `branch` of the
 *      abap2UI5 dependency in its abaplint.jsonc, which is the framework the
 *      project's own lint already assumes - unless --framework (or, on the
 *      npm backend, A2UI5_MCP_RUNTIME_VERSION) names another:
 *        npm (the default)  @abap2ui5/node-runtime at that release (the
 *                           registry's latest when nothing pins one),
 *                           installed once into ~/.abap2ui5-mcp
 *                           (A2UI5_MCP_WORKSPACE) with the transpiler it
 *                           names - no framework checkout, no clone, none of
 *                           the framework's devDependencies;
 *        a checkout         --home or A2UI5_HOME (or a sibling of this
 *                           package) - used as it is, as before;
 *        clone              --backend clone (A2UI5_MCP_BACKEND=clone): the
 *                           release cloned into the workspace and its backend
 *                           downloaded or built - the path before the npm
 *                           package existed, and the one taken by itself when
 *                           the registry has no package for the pinned
 *                           release (older than 1.145.0);
 *   2. every class and interface under the paths (default src) - each with
 *      all of its files as the repository carries them: the source, the XML,
 *      the test include, the local-class includes - and every table (TABL)
 *      and data element (DTEL) is deployed and
 *      transpiled. On the npm backend into a sandbox and a build of this
 *      run's own (the workspace's unit-* and the runtime's apps-unit-*), the
 *      classes alone against the package, seconds; on a checkout into its
 *      dev sandbox, incrementally;
 *   3. the classes that carry tests (all of them, or the --class ones) are
 *      run through the generated runner, filtered to exactly them;
 *   4. the report: one line per test method, the first failure with its
 *      error, a GitHub step summary when GITHUB_STEP_SUMMARY is set, --json
 *      for the whole structure on stdout. Exit 1 on a failing test, 2 on a
 *      failed build, a class that would not transpile or an object that
 *      could not be deployed (a namespaced name), 0 otherwise.
 *
 * What it deliberately does not do: lint (the project's own abaplint job
 * does that, against the same pin) and boot (run_app needs a browser; the
 * unit tests need none). A class without a test include is deployed - a
 * class under test may call it - and not run. A class is a class here, app
 * or not: deploy_app's "implements z2ui5_if_app" gate is for an agent's app,
 * and it used to refuse every helper class - whose tests then never ran,
 * with the run still exiting 0.
 *
 * It needs nothing installed beside Node: no dependency of this package is
 * imported on this path (the GitHub Action runs it without an npm ci).
 *
 * The deployed objects are removed again unless --keep is given. On the npm
 * backend that is this run's own sandbox and build, which is also why an MCP
 * session's sandbox on the same machine is neither built with the project
 * (an unfinished app there used to fail `npm run test:unit`) nor emptied of
 * the classes the run tested. On a checkout they go from its sandbox AND
 * from the node/downport copies the transpile read (remove_app's own path),
 * so a developer's framework checkout builds what it built before; its last
 * build's output keeps this run's classes until the next build.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildBackend, runUnitTests, cloneFramework, frameworkCloneDir, readVersion, stripJsonc, backendBuilt,
  backendPreference, backendKind, classNameOf, sandbox, syncDevCopies,
} from '../lib/runtime.mjs';
import { resolveA2UI5, explicitEnv, workspaceRoot } from '../lib/repos.mjs';
import { prepareRuntime, readRuntimePin, buildNpm } from '../lib/npm-backend.mjs';

const TOOL = 'abap2ui5-unit';

// ------------------------------------------------------------- pure half ----

/** The release tag the project pins the framework at, out of its
 *  abaplint.jsonc: the `branch` of the dependency whose url names
 *  abap2UI5/abap2UI5. Null when unpinned or absent. */
export function frameworkPinOf(abaplintJsonc) {
  let cfg;
  try {
    cfg = JSON.parse(stripJsonc(abaplintJsonc));
  } catch {
    return null;
  }
  const dep = (cfg.dependencies || []).find((d) => /github\.com\/abap2ui5\/abap2ui5(\.git)?\/?$/i.test(String(d.url || '')));
  const branch = dep && dep.branch;
  return typeof branch === 'string' && /^\d+\.\d+\.\d+$/.test(branch) ? branch : null;
}

/* A file of an ABAP object the way abapGit names it:
 * `<name>.<clas|intf>[.<include>].<abap|xml>` - the source, the XML sidecar
 * and a class's includes (testclasses, locals_imp, locals_def, macros) - or
 * `<name>.<tabl|dtel>.xml`, a database table (or structure) and a data
 * element, which are their XML alone. The backend creates a deployed
 * transparent table at boot, so a class under test can read and write it. */
const OBJECT_FILE = /^([^.\s]+)\.(clas|intf|tabl|dtel)(?:\.([a-z_]+))?\.(abap|xml)$/i;
const XML_ONLY = new Set(['tabl', 'dtel']);

/** Every class, interface, table and data element under the paths, each
 *  with all of its files: `{ name, type, files: [{ path, name }],
 *  testclasses, conflict? }`. An object is there when its source
 *  (`<name>.<type>.abap`; `<name>.<tabl|dtel>.xml`) is; `conflict`
 *  says it is there twice. */
export function collectObjects(paths) {
  const objects = new Map();
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p).sort()) {
        if (e === 'node_modules' || e.startsWith('.')) continue;
        walk(path.join(p, e));
      }
      return;
    }
    const m = OBJECT_FILE.exec(path.basename(p));
    if (!m) return;
    const [name, type, include, ext] = [m[1].toLowerCase(), m[2].toLowerCase(), m[3] && m[3].toLowerCase(), m[4].toLowerCase()];
    const key = `${name}.${type}`;
    if (!objects.has(key)) objects.set(key, { name, type, files: [], testclasses: false });
    const o = objects.get(key);
    const file = [name, type, include, ext].filter(Boolean).join('.');
    if (o.files.some((f) => f.name === file)) o.conflict = `${file} is there twice (${o.files.find((f) => f.name === file).path} and ${p})`;
    else o.files.push({ path: p, name: file });
    if (type === 'clas' && include === 'testclasses' && ext === 'abap') o.testclasses = true;
  };
  for (const p of paths) walk(path.resolve(p));
  return [...objects.values()].filter((o) => o.files.some((f) => f.name === `${o.name}.${o.type}.${XML_ONLY.has(o.type) ? 'xml' : 'abap'}`));
}

/** Copy the objects' files into `dir`, each object under the sandbox's name
 *  gate (a name that is a path, or a namespaced one, is refused): the paths
 *  written, and per object the reason it was not. */
export function writeObjects(objects, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const errors = {};
  for (const o of objects) {
    try {
      if (o.conflict) throw new Error(o.conflict);
      classNameOf(o.name);
      for (const f of o.files) {
        const dst = path.join(dir, f.name);
        fs.copyFileSync(f.path, dst);
        written.push(dst);
      }
    } catch (e) {
      errors[o.name] = String(e.message);
    }
  }
  return { written, errors };
}

/** The parsed arguments; throws on a bad one. */
export function parseArgs(argv) {
  const opts = { paths: [], classes: [], framework: null, home: null, backend: null, json: false, keep: false, help: false, printPin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--print-pin') opts.printPin = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--framework' || a === '--home' || a === '--class' || a === '--backend') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error(`${a} needs a value`);
      if (a === '--class') opts.classes.push(v.toLowerCase());
      else if (a === '--backend') {
        if (v !== 'npm' && v !== 'clone') throw new Error(`--backend is npm or clone, not ${v}`);
        opts.backend = v;
      } else opts[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (!opts.paths.length) opts.paths = ['src'];
  return opts;
}

/** Which backend a run takes. `requested`: --backend, else A2UI5_MCP_BACKEND.
 *  A checkout somebody named (--home, A2UI5_HOME, a sibling) is used as it is;
 *  the clone THIS script makes in the workspace only when the clone is
 *  asked for - by default the run is on the npm package, whatever an earlier
 *  version left in the workspace. Pure. */
export function chooseBackend({ requested = null, a2 = null, cloneDir, envSet = false }) {
  if (requested === 'npm') return 'npm';
  if (a2 && (envSet || requested === 'clone' || path.resolve(a2) !== path.resolve(cloneDir))) return 'checkout';
  if (envSet) return 'missing';
  return requested === 'clone' ? 'clone' : 'npm';
}

/** Is the resolved framework checkout the clone THIS script makes, at another
 *  release than the project pins? Then it is replaced rather than used: the
 *  workspace clone resolves as a sibling candidate, so "unset A2UI5_HOME" is
 *  no way to a clone of the pin - only re-cloning is. A checkout somebody
 *  else provided (a sibling, an env var) is never replaced. Pure. */
export function staleWorkspaceClone({ a2, have, pin, cloneDir, envSet }) {
  if (!a2 || !pin || envSet) return false;
  if (path.resolve(a2) !== path.resolve(cloneDir)) return false;
  return have !== pin;
}

/** The markdown the step summary and the terminal share. */
export function renderSummary({ framework, mode, results }) {
  const lines = [`## abap2UI5 unit tests (framework ${framework}, backend: ${mode === 'npm' ? '@abap2ui5/node-runtime' : mode})`, ''];
  let ran = 0;
  let failed = 0;
  for (const r of results) {
    if (r.deployError) {
      lines.push(`- **${r.cls.toUpperCase()}**: not deployed - ${r.deployError}`);
      failed++;
      continue;
    }
    if (!r.testclasses) {
      lines.push(`- ${r.cls.toUpperCase()}: no test include (deployed for the classes that call it)`);
      continue;
    }
    const tests = r.tests || [];
    ran += tests.filter((t) => !t.skipped).length;
    if (!tests.length && !r.failed) {
      lines.push(`- **${r.cls.toUpperCase()}**: a test include, but the runner found no test method - is the local class FOR TESTING?`);
      continue;
    }
    for (const t of tests) {
      const mark = r.failed && !r.failed.fixture && r.failed.method === t.method && r.failed.localClass === t.localClass ? 'FAIL' : (t.skipped ? 'skip' : 'ok');
      lines.push(`- ${mark === 'FAIL' ? '**FAIL**' : mark}  ${r.cls.toUpperCase()} ${t.localClass}->${t.method}${t.skipped ? ` (${t.skipped})` : ''}`);
    }
    // a class_setup, constructor or setup that threw: before the test it belongs to had begun
    if (r.failed && r.failed.fixture) {
      lines.push(`- **FAIL**  ${r.cls.toUpperCase()} ${r.failed.localClass ? `${r.failed.localClass}->` : ''}${r.failed.method} (the test class's ${r.failed.method}, before its test method ran)`);
    }
    if (r.failed) {
      failed++;
      lines.push('', '```', r.failed.error || '(no error text)', '```', '');
    }
  }
  lines.push('', `${ran} test method(s) ran, ${failed} class(es) failing`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- main ----

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`${TOOL}: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  const log = (line) => console.error(`${TOOL}: ${line}`);

  // 1. the framework
  const projectPin = fs.existsSync('abaplint.jsonc') ? frameworkPinOf(fs.readFileSync('abaplint.jsonc', 'utf8')) : null;
  const pin = opts.framework || projectPin;
  if (opts.printPin) {
    // for the action's cache key: the pin, or nothing (the key then says latest)
    console.log(pin || '');
    return 0;
  }
  if (opts.home) process.env.A2UI5_HOME = path.resolve(opts.home);
  let requested = opts.backend || backendPreference();
  /* The npm package has releases only; a branch (`--framework main`) can
   * only be cloned. */
  if (opts.framework && !/^\d+\.\d+\.\d+$/.test(opts.framework) && requested !== 'clone') {
    if (requested === 'npm') {
      log(`--framework ${opts.framework} is not a release (X.Y.Z), and @abap2ui5/node-runtime has releases only`);
      return 2;
    }
    log(`--framework ${opts.framework} is not a release - taking the framework clone (@abap2ui5/node-runtime has releases only)`);
    requested = 'clone';
    process.env.A2UI5_MCP_BACKEND = 'clone';
  }
  let backend = chooseBackend({
    requested, a2: resolveA2UI5({ local: true }), cloneDir: frameworkCloneDir(), envSet: Boolean(explicitEnv('a2ui5')),
  });
  if (backend === 'missing') {
    log(`${explicitEnv('a2ui5')} is set and does not point at an abap2UI5 checkout`);
    return 2;
  }
  let a2 = null;
  let release = null;
  if (backend === 'npm') {
    /* This run's backend, whatever else the workspace holds (a clone an
     * earlier version made resolves as a checkout otherwise), at the
     * release the project pins: --framework, else A2UI5_MCP_RUNTIME_VERSION,
     * else the abaplint.jsonc pin, else the registry's latest. */
    process.env.A2UI5_MCP_BACKEND = 'npm';
    const want = opts.framework || readRuntimePin().value || projectPin || null;
    if (want) process.env.A2UI5_MCP_RUNTIME_VERSION = want;
    const rt = await prepareRuntime({ withLint: false, onLine: log });
    if (!rt.ok && rt.missing && !requested) {
      log(`the registry has no @abap2ui5/node-runtime@${want || 'latest'} (the package exists from 1.145.0 on) - taking the framework clone instead; --backend clone does that directly`);
      process.env.A2UI5_MCP_BACKEND = 'clone';
      backend = 'clone';
    } else if (!rt.ok) {
      log(`@abap2ui5/node-runtime could not be installed: ${rt.reason}`);
      return 2;
    } else {
      release = rt.version;
      log(`framework: @abap2ui5/node-runtime ${rt.version} in ${rt.dir}`);
    }
  }
  let built = { mode: 'npm' };
  if (backend !== 'npm') {
    a2 = resolveA2UI5({ local: true });
    if (a2 && staleWorkspaceClone({ a2, have: readVersion(a2), pin, cloneDir: frameworkCloneDir(), envSet: Boolean(explicitEnv('a2ui5')) })) {
      // this script's own clone, on another release than the pin: cloneFramework replaces it
      a2 = null;
    }
    if (a2) {
      const have = readVersion(a2);
      if (pin && have && have !== pin) log(`using ${a2} (abap2UI5 ${have}) although the project pins ${pin} - point A2UI5_HOME elsewhere or unset it to run on the pinned release`);
      else log(`framework: ${a2} (abap2UI5 ${have || '?'})`);
    } else {
      const cloned = await cloneFramework({ onLine: log, tag: pin });
      if (!cloned.ok) {
        log(`could not clone the framework into ${frameworkCloneDir()}`);
        return 2;
      }
      a2 = cloned.dir;
    }

    // 2. the backend
    built = await buildBackend({ mode: 'auto', onLine: (l) => { if (!/^\s*$/.test(l)) log(l); } });
    if (!built.ok) {
      log(`the backend could not be built (mode ${built.mode}):\n${built.tail}`);
      return 2;
    }
    if (!backendBuilt()) {
      log('the backend is not built after the build - see the lines above');
      return 2;
    }
  }

  // 3. deploy, transpile, run
  const objects = collectObjects(opts.paths);
  const classes = objects.filter((o) => o.type === 'clas');
  if (!classes.length) {
    log(`no *.clas.abap under ${opts.paths.join(', ')}`);
    return 2;
  }
  const unknown = opts.classes.filter((n) => !classes.some((c) => c.name === n));
  if (unknown.length) {
    log(`--class ${unknown.join(', ')}: no such class under ${opts.paths.join(', ')}`);
    return 2;
  }
  /* Every object is deployed - a class under test may use any of them;
   * --class narrows the tests that RUN. On the npm backend into a sandbox
   * and a build of this run's own; on a checkout into its dev sandbox. */
  let box;
  let appsName = null;
  let appsPath = null;
  if (backend === 'npm') {
    fs.mkdirSync(workspaceRoot(), { recursive: true });
    // with this process's pid: a run killed before its finally is swept by the next build
    box = fs.mkdtempSync(path.join(workspaceRoot(), `unit-${process.pid}-`));
    appsName = `apps-${path.basename(box)}`;
  } else {
    box = sandbox().dir;
  }
  const { written, errors } = writeObjects(objects, box);
  const results = classes.map((c) => ({ cls: c.name, testclasses: c.testclasses, ...(errors[c.name] ? { deployError: errors[c.name] } : {}) }));
  for (const o of objects) if (o.type !== 'clas' && errors[o.name]) results.push({ cls: o.name, deployError: errors[o.name] });
  // an object that cannot be deployed is a class whose tests cannot run: never a green run
  let exit = Object.keys(errors).length ? 2 : 0;
  for (const [name, why] of Object.entries(errors)) log(`${name} not deployed: ${why}`);
  const narrate = (l) => { if (/^(open-abap-core|transpile|npm build):|error|Error|exited/.test(l)) log(l); };
  try {
    if (backend === 'npm') {
      /* The one build of the run: open-abap-core at the release's commit
       * (fetched once), the classes transpiled against the package - the
       * framework itself is never transpiled here. */
      const res = await buildNpm({ inputDir: box, appsName, withLint: false, onLine: narrate });
      built = { ok: res.ok, mode: 'npm', runtime: res.version };
      if (res.dir) appsPath = path.join(res.dir, appsName);
      if (!res.ok) {
        log(`the project's classes did not transpile:\n${res.reason}`);
        return 2;
      }
    } else {
      const inc = await buildBackend({ mode: 'incremental', withLint: false, onLine: narrate });
      if (!inc.ok) {
        log(`the deployed classes did not transpile:\n${inc.tail}`);
        return 2;
      }
    }
    const withTests = classes
      .filter((c) => c.testclasses && !errors[c.name] && (!opts.classes.length || opts.classes.includes(c.name)))
      .map((c) => c.name);
    if (withTests.length) {
      const run = await runUnitTests({ classNames: withTests, ...(appsPath ? { appsDir: appsPath } : {}) });
      if (run.aborted || run.timedOut) {
        log(run.error);
        return 2;
      }
      for (const r of results) {
        if (!withTests.includes(r.cls)) continue;
        r.tests = run.tests.filter((t) => t.object === r.cls.toUpperCase());
        r.failed = run.failed && run.failed.object === r.cls.toUpperCase() ? run.failed : null;
      }
      if (!run.ok) exit = Math.max(exit, 1);
      if (!run.ok && !run.failed && run.error) log(`the runner failed outside a test:\n${run.error}`);
    } else {
      log('no class carries a *.clas.testclasses.abap - nothing to run');
    }
  } finally {
    if (opts.keep) {
      log(`--keep: the deployed objects stay in ${box}${appsPath ? `, their build in ${appsPath}` : ''}`);
    } else if (backend === 'npm') {
      fs.rmSync(box, { recursive: true, force: true });
      if (appsPath) fs.rmSync(appsPath, { recursive: true, force: true });
    } else {
      for (const f of written) fs.rmSync(f, { force: true });
      if (a2 && backendKind() === 'checkout') syncDevCopies(a2, { copy: false });
    }
  }

  // 4. the report
  const framework = backend === 'npm' ? (built.runtime || release) : (readVersion(a2) || pin);
  const summary = renderSummary({ framework: framework || '?', mode: built.mode, results });
  if (opts.json) {
    console.log(JSON.stringify({
      ok: exit === 0,
      framework,
      backend: backend === 'npm' ? 'npm' : 'checkout',
      ...(backend === 'npm' ? { runtime: `@abap2ui5/node-runtime@${framework}` } : { checkout: a2 }),
      mode: built.mode,
      results,
    }, null, 2));
  } else console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  return exit;
}

/* Run as a program, not when imported by a test. Compared by REAL path: npm
 * installs the bin as a symlink (node_modules/.bin/abap2ui5-unit), which is
 * what process.argv[1] carries, while import.meta.url is the resolved file -
 * a plain path comparison made the bin exit 0 without doing anything. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`${TOOL}: ${(e && e.stack) || e}`);
    process.exit(2);
  });
}

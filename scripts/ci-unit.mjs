#!/usr/bin/env node
/*
 * abap2ui5-unit — the ABAP Unit tests of an app repository, run in the
 * transpiled backend without a SAP system. For CI, and for a terminal.
 *
 *   npx -p @abap2ui5/mcp-server abap2ui5-unit [paths...] [--framework <tag>]
 *                                [--home <abap2UI5 checkout>] [--class <name>]...
 *                                [--json] [--keep] [--print-pin]
 *
 * What it does, in the order the MCP tools do it, with the same code
 * (lib/runtime.mjs - nothing here is a second implementation):
 *
 *   1. the framework: an abap2UI5 checkout named by --home or A2UI5_HOME, a
 *      sibling, or the one this script clones into ~/.abap2ui5-mcp
 *      (A2UI5_MCP_WORKSPACE) at the release the project PINS - the `branch`
 *      of the abap2UI5 dependency in its abaplint.jsonc, which is the
 *      framework the project's own lint already assumes - or --framework;
 *   2. the backend: build_backend mode auto - the release's prebuilt asset
 *      when there is one, the framework's own transpile (a few minutes)
 *      otherwise, incremental on a later run;
 *   3. every *.clas.abap under the paths (default src) is deployed into the
 *      framework sandbox with its *.clas.testclasses.abap, the sandbox is
 *      transpiled incrementally, and the classes that carry tests are run
 *      through the generated runner, filtered to exactly them;
 *   4. the report: one line per test method, the first failure with its
 *      error, a GitHub step summary when GITHUB_STEP_SUMMARY is set, --json
 *      for the whole structure on stdout. Exit 1 on a failing test, 2 on a
 *      failed build or a class that would not transpile, 0 otherwise.
 *
 * What it deliberately does not do: lint (the project's own abaplint job
 * does that, against the same pin) and boot (run_app needs a browser; the
 * unit tests need none). A class without a test include is deployed - a
 * class under test may call it - and not run.
 *
 * The deployed classes are removed again unless --keep is given, so a
 * developer's framework checkout is left as it was found.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildBackend, deployApp, removeApp, runUnitTests, cloneFramework, frameworkCloneDir, readVersion,
  stripJsonc, backendBuilt,
} from '../lib/runtime.mjs';
import { resolveA2UI5, explicitEnv } from '../lib/repos.mjs';

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

/** Every class under the paths: { cls, source, testclasses|null, file }. */
export function collectClasses(paths) {
  const out = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        if (e === 'node_modules' || e.startsWith('.')) continue;
        walk(path.join(p, e));
      }
      return;
    }
    if (!/\.clas\.abap$/.test(p) || /\.clas\.testclasses\.abap$/.test(p)) return;
    const cls = path.basename(p).replace(/\.clas\.abap$/, '').toLowerCase();
    const testFile = p.replace(/\.clas\.abap$/, '.clas.testclasses.abap');
    out.push({
      cls,
      file: p,
      source: fs.readFileSync(p, 'utf8'),
      testclasses: fs.existsSync(testFile) ? fs.readFileSync(testFile, 'utf8') : null,
    });
  };
  for (const p of paths) walk(path.resolve(p));
  return out;
}

/** The parsed arguments; throws on a bad one. */
export function parseArgs(argv) {
  const opts = { paths: [], classes: [], framework: null, home: null, json: false, keep: false, help: false, printPin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--print-pin') opts.printPin = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--framework' || a === '--home' || a === '--class') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error(`${a} needs a value`);
      if (a === '--class') opts.classes.push(v.toLowerCase());
      else opts[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (!opts.paths.length) opts.paths = ['src'];
  return opts;
}

/** The markdown the step summary and the terminal share. */
export function renderSummary({ framework, mode, results }) {
  const lines = [`## abap2UI5 unit tests (framework ${framework}, backend: ${mode})`, ''];
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
    if (!tests.length) {
      lines.push(`- **${r.cls.toUpperCase()}**: a test include, but the runner found no test method - is the local class FOR TESTING?`);
      continue;
    }
    for (const t of tests) {
      const mark = r.failed && r.failed.method === t.method && r.failed.localClass === t.localClass ? 'FAIL' : (t.skipped ? 'skip' : 'ok');
      lines.push(`- ${mark === 'FAIL' ? '**FAIL**' : mark}  ${r.cls.toUpperCase()} ${t.localClass}->${t.method}${t.skipped ? ` (${t.skipped})` : ''}`);
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
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\n/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  const log = (line) => console.error(`${TOOL}: ${line}`);

  // 1. the framework
  const pin = opts.framework
    || (fs.existsSync('abaplint.jsonc') ? frameworkPinOf(fs.readFileSync('abaplint.jsonc', 'utf8')) : null);
  if (opts.printPin) {
    // for the action's cache key: the pin, or nothing (the key then says latest)
    console.log(pin || '');
    return 0;
  }
  if (opts.home) process.env.A2UI5_HOME = path.resolve(opts.home);
  let a2 = resolveA2UI5({ local: true });
  if (a2) {
    const have = readVersion(a2);
    if (pin && have && have !== pin) log(`using ${a2} (abap2UI5 ${have}) although the project pins ${pin} - point A2UI5_HOME elsewhere or unset it to get a clone of the pin`);
    else log(`framework: ${a2} (abap2UI5 ${have || '?'})`);
  } else if (explicitEnv('a2ui5')) {
    log(`${explicitEnv('a2ui5')} is set and does not point at an abap2UI5 checkout`);
    return 2;
  } else {
    const cloned = await cloneFramework({ onLine: log, tag: pin });
    if (!cloned.ok) {
      log(`could not clone the framework into ${frameworkCloneDir()}`);
      return 2;
    }
    a2 = cloned.dir;
  }

  // 2. the backend
  const built = await buildBackend({ mode: 'auto', onLine: (l) => { if (!/^\s*$/.test(l)) log(l); } });
  if (!built.ok) {
    log(`the backend could not be built (mode ${built.mode}):\n${built.tail}`);
    return 2;
  }
  if (!backendBuilt()) {
    log('the backend is not built after the build - see the lines above');
    return 2;
  }

  // 3. deploy, transpile, run
  const classes = collectClasses(opts.paths).filter((c) => !opts.classes.length || opts.classes.includes(c.cls));
  if (!classes.length) {
    log(`no *.clas.abap under ${opts.paths.join(', ')}`);
    return 2;
  }
  const results = classes.map((c) => ({ cls: c.cls, testclasses: Boolean(c.testclasses) }));
  const deployed = [];
  for (const [i, c] of classes.entries()) {
    try {
      deployApp({ className: c.cls, source: c.source, testclasses: c.testclasses || undefined, description: `${TOOL}: ${path.basename(c.file)}` });
      deployed.push(c.cls);
    } catch (e) {
      results[i].deployError = String(e.message);
    }
  }
  let exit = 0;
  try {
    const inc = await buildBackend({ mode: 'incremental', onLine: (l) => { if (/error|Error|exited/.test(l)) log(l); } });
    if (!inc.ok) {
      log(`the deployed classes did not transpile:\n${inc.tail}`);
      return 2;
    }
    const withTests = classes.filter((c, i) => c.testclasses && !results[i].deployError).map((c) => c.cls);
    if (withTests.length) {
      const run = await runUnitTests({ classNames: withTests });
      if (run.aborted || run.timedOut) {
        log(run.error);
        return 2;
      }
      for (const r of results) {
        if (!r.testclasses || r.deployError) continue;
        r.tests = run.tests.filter((t) => t.object === r.cls.toUpperCase());
        r.failed = run.failed && run.failed.object === r.cls.toUpperCase() ? run.failed : null;
      }
      if (!run.ok) exit = 1;
      if (!run.ok && !run.failed && run.error) log(`the runner failed outside a test:\n${run.error}`);
    } else {
      log('no class carries a *.clas.testclasses.abap - nothing to run');
    }
  } finally {
    if (!opts.keep) for (const cls of deployed) removeApp(cls);
  }

  // 4. the report
  const summary = renderSummary({ framework: readVersion(a2) || pin || '?', mode: built.mode, results });
  if (opts.json) console.log(JSON.stringify({ ok: exit === 0, framework: readVersion(a2), checkout: a2, mode: built.mode, results }, null, 2));
  else console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`${TOOL}: ${(e && e.stack) || e}`);
    process.exit(2);
  });
}

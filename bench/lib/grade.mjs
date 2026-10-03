// The grader: one directory of agent output in, one verdict out.
//
//   deliverable  the classes the task names exist and implement z2ui5_if_app
//   abaplint     app-template's abaplint.jsonc, unchanged except that the
//                framework dependency is the pinned release cloned locally
//                (the template asks abaplint to clone the same tag itself)
//   lint         @abap2ui5/linter's static gate, app-template's
//                abap2ui5lint.jsonc (failOn warning, chain-house-layout on)
//   render       the same run's render gate: every view the classes build is
//                reconstructed and loaded with XMLView.create in headless
//                Chromium; a class whose view cannot be reconstructed has not
//                been rendered, and does not pass
//   expect       the task's expect.json against the reconstructed views
//
// The first four are exactly what `npm run check` in a project made from the
// template decides. Errors of the harness itself (a crashed abaplint, a
// linter usage error, no browser) are `infraError`, never an agent failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declaresApp } from '@abap2ui5/linter';
import { severityRank } from '@abap2ui5/linter/findings';
import { analyze, evaluate } from './expect.mjs';
import { ensureFramework, ensureTemplate, frameworkRefOf, templateLintConfig } from './pins.mjs';
import { BENCH_DIR, run, walk } from './util.mjs';

const ABAPGIT_FILE = /^[a-z0-9_/]+\.(clas|intf)(\.(testclasses|locals_imp|locals_def|macros|definitions|implementations))?\.(abap|xml)$/i;
const bin = (...p) => path.join(BENCH_DIR, 'node_modules', ...p);
const ABAPLINT = bin('@abaplint', 'cli', 'abaplint');
const LINTER = bin('@abap2ui5', 'linter', 'cli.mjs');

/* abaplint rules about the abapGit METADATA rather than the code: the
 * .clas.xml sidecar is missing, has no BOM, or names another class. The
 * report shows abaplint with and without them, because they are the part an
 * agent without the template's conventions cannot know from ABAP alone. */
export const METADATA_RULES = new Set(['xml_bom', 'xml_consistency', 'description_empty']);

/** Which files of `dir` are the agent's abapGit objects. When the same file
 *  name occurs twice, the copy under a `src` directory wins. */
export function collectObjects(dir) {
  const files = walk(dir).filter((f) => ABAPGIT_FILE.test(path.basename(f)));
  const byName = new Map();
  const notes = [];
  for (const f of files) {
    const name = path.basename(f).toLowerCase();
    const prev = byName.get(name);
    if (!prev) { byName.set(name, f); continue; }
    const inSrc = (p) => p.split('/').includes('src');
    if (inSrc(f) && !inSrc(prev)) byName.set(name, f);
    notes.push(`duplicate ${name}: graded ${byName.get(name)}, ignored ${byName.get(name) === f ? prev : f}`);
  }
  return { files: [...byName.entries()].map(([name, rel]) => ({ name, rel })), notes };
}

let pinsPromise = null;
/** The pinned template + framework, resolved once per process. */
export function pins({ template } = {}) {
  if (!pinsPromise) {
    pinsPromise = (async () => {
      const templateDir = await ensureTemplate({ override: template });
      const frameworkRef = frameworkRefOf(templateDir);
      const frameworkDir = await ensureFramework(frameworkRef);
      return { templateDir, frameworkRef, frameworkDir };
    })();
  }
  return pinsPromise;
}

function stage(dir, objects, { templateDir, frameworkDir }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abap2ui5-bench-grade-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  for (const o of objects) fs.copyFileSync(path.join(dir, o.rel), path.join(src, path.basename(o.rel)));
  // the package the template ships; abapGit needs one, and the agent was
  // never asked for it
  if (!fs.existsSync(path.join(src, 'package.devc.xml'))) {
    fs.copyFileSync(path.join(templateDir, 'src', 'package.devc.xml'), path.join(src, 'package.devc.xml'));
  }
  fs.symlinkSync(frameworkDir, path.join(tmp, 'deps'), 'dir');
  const cfg = templateLintConfig(templateDir);
  cfg.global = { ...(cfg.global || {}), files: '/src/**/*.*' };
  cfg.dependencies = (cfg.dependencies || []).map((d) => (/abap2UI5\/abap2UI5/i.test(d.url || '')
    ? { folder: '/deps', files: d.files || '/src/**/*.*' }
    : d));
  fs.writeFileSync(path.join(tmp, 'abaplint.json'), JSON.stringify(cfg, null, 2));
  fs.copyFileSync(path.join(templateDir, 'abap2ui5lint.jsonc'), path.join(tmp, 'abap2ui5lint.jsonc'));
  return tmp;
}

async function runAbaplint(tmp) {
  const r = await run(process.execPath, [ABAPLINT, 'abaplint.json', '-f', 'json'], { cwd: tmp, timeoutMs: 5 * 60 * 1000 });
  let issues;
  try { issues = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch {
    return { infraError: `abaplint produced no JSON (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${(r.stderr || r.stdout).slice(-600)}` };
  }
  const list = issues.map((i) => ({
    rule: i.key,
    file: path.relative(tmp, i.file).split(path.sep).join('/'),
    line: i.start && i.start.row,
    message: i.description,
  }));
  const code = list.filter((i) => !METADATA_RULES.has(i.rule) && !i.file.endsWith('.xml'));
  return { pass: list.length === 0, codePass: code.length === 0, count: list.length, issues: list.slice(0, 50) };
}

async function runLinter(tmp) {
  const r = await run(process.execPath, [LINTER, 'src', '--config', 'abap2ui5lint.jsonc', '--format', 'json', '--no-progress', '--no-annotate', '--no-stats', '--no-badge'], {
    cwd: tmp,
    timeoutMs: 10 * 60 * 1000,
  });
  if (r.code === 2 || r.timedOut) return { infraError: `linter exit ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).slice(-800)}` };
  let json;
  try { json = JSON.parse(r.stdout); } catch {
    return { infraError: `linter produced no JSON (exit ${r.code}): ${(r.stderr || r.stdout).slice(-600)}` };
  }
  return { json, stderr: r.stderr };
}

/** Grade one directory. `task` is { id, expect } (expect may be {}). */
export async function gradeDir(dir, task, { template } = {}) {
  const started = Date.now();
  const expect = task.expect || {};
  const p = await pins({ template });
  const { files, notes } = collectObjects(dir);
  const result = {
    task: task.id,
    level: expect.level || null,
    dir,
    files: files.map((f) => f.rel),
    notes,
    checks: {},
    pass: false,
    lintRenderClean: false,
    infraError: null,
  };

  // deliverable
  const sources = {};
  for (const f of files) {
    const m = /^([a-z0-9_]+)\.clas\.abap$/.exec(f.name);
    if (m) sources[m[1]] = fs.readFileSync(path.join(dir, f.rel), 'utf8');
  }
  const wanted = (expect.classes || []).map((c) => c.toLowerCase());
  const deliverableErrors = [];
  for (const cls of wanted) {
    if (!sources[cls]) deliverableErrors.push(`${cls}.clas.abap not found`);
    else if (!declaresApp(sources[cls])) deliverableErrors.push(`${cls} does not implement z2ui5_if_app`);
  }
  if (Object.keys(sources).length === 0) deliverableErrors.push('no .clas.abap file delivered');
  result.checks.deliverable = { pass: deliverableErrors.length === 0, errors: deliverableErrors };

  if (files.length === 0) {
    for (const k of ['abaplint', 'lint', 'render', 'expect']) result.checks[k] = { pass: false, errors: ['nothing delivered'] };
    result.durationMs = Date.now() - started;
    return result;
  }

  const tmp = stage(dir, files, p);
  try {
    const [al, li] = await Promise.all([runAbaplint(tmp), runLinter(tmp)]);
    if (al.infraError) result.infraError = al.infraError;
    result.checks.abaplint = al.infraError ? { pass: false, errors: [al.infraError] } : al;

    if (li.infraError) {
      result.infraError = result.infraError || li.infraError;
      result.checks.lint = { pass: false, errors: [li.infraError] };
      result.checks.render = { pass: false, errors: [li.infraError] };
    } else {
      const failOn = li.json.failOn || 'warning';
      const fails = (sev) => failOn !== 'never' && severityRank(sev) >= severityRank(failOn);
      const findings = [];
      const renderErrors = [];
      const perClass = {};
      for (const res of li.json.results || []) {
        const cls = path.basename(res.file || '').replace(/\.clas\.abap$/i, '').toLowerCase();
        for (const f of res.findings || []) {
          if (fails(f.severity)) findings.push({ file: res.file, rule: f.type, severity: f.severity, line: f.line, message: f.message });
        }
        for (const e of res.renderErrors || []) renderErrors.push({ file: res.file, message: e });
        perClass[cls] = { documents: res.stats ? res.stats.documents : 0, rendered: res.stats ? res.stats.rendered : 0, skippedRender: !!res.skippedRender };
      }
      result.checks.lint = { pass: findings.length === 0, count: findings.length, findings: findings.slice(0, 50) };
      const renderProblems = renderErrors.map((e) => `${e.file}: ${e.message}`);
      for (const cls of wanted.length ? wanted : Object.keys(sources)) {
        if (!sources[cls]) continue;
        const pc = perClass[cls];
        if (!pc || pc.documents === 0) renderProblems.push(`${cls}: no view could be reconstructed, so none was rendered (raw XML strings and the frozen z2ui5_cl_xml_view are not render-checked)`);
        else if (pc.rendered < pc.documents) renderProblems.push(`${cls}: ${pc.documents} document(s) built, ${pc.rendered} rendered`);
      }
      if (/render runtime|linter-render|chromium/i.test(li.stderr || '') && renderErrors.length === 0 && Object.values(perClass).every((c) => c.rendered === 0)) {
        result.infraError = result.infraError || `render gate did not run: ${li.stderr.slice(-400)}`;
      }
      result.checks.render = { pass: renderProblems.length === 0, errors: renderProblems.slice(0, 30), perClass };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const analysis = analyze(sources);
  const ev = evaluate(expect, analysis);
  result.checks.expect = { pass: ev.pass, failures: ev.failures, controls: ev.controls };

  const c = result.checks;
  result.lintRenderClean = !!(c.deliverable.pass && c.abaplint.pass && c.lint.pass && c.render.pass);
  result.pass = result.lintRenderClean && c.expect.pass;
  result.durationMs = Date.now() - started;
  return result;
}

/** One line per check, for a terminal. */
export function summaryLine(g) {
  const mark = (k) => `${k}:${g.checks[k] ? (g.checks[k].pass ? 'ok' : 'FAIL') : '-'}`;
  return `${g.task.padEnd(26)} ${g.pass ? 'PASS' : 'FAIL'}  ${['deliverable', 'abaplint', 'lint', 'render', 'expect'].map(mark).join(' ')}${g.infraError ? '  [infra error]' : ''}`;
}

/** The first few reasons a grade failed, for a terminal. */
export function failureReasons(g, max = 6) {
  const out = [];
  if (g.infraError) out.push(`infra: ${g.infraError}`);
  const c = g.checks;
  for (const e of (c.deliverable && c.deliverable.errors) || []) out.push(`deliverable: ${e}`);
  for (const i of (c.abaplint && c.abaplint.issues) || []) out.push(`abaplint ${i.rule} ${i.file}:${i.line} ${i.message}`);
  for (const f of (c.lint && c.lint.findings) || []) out.push(`lint ${f.rule} ${f.file}:${f.line} ${f.message}`);
  for (const e of (c.render && c.render.errors) || []) out.push(`render ${e}`);
  for (const e of (c.expect && c.expect.failures) || []) out.push(`expect ${e}`);
  return out.slice(0, max);
}

/*
 * migrate — a classic ABAP report as an abap-cloud-gui report class, by
 * report2cloud (abap2UI5-addons/abap-cloud-gui, tools/report2cloud).
 *
 * report2cloud is not on npm: it lives in the abap-cloud-gui repository, next
 * to the report runtime (src/01) whose API it writes against, and it parses
 * with the @abaplint/core of that checkout's node_modules - the version its
 * own gates lint the generated classes with. So it is read the way every
 * other sibling is read here (lib/repos.mjs resolveCloudGui: ABAP_CLOUD_GUI_HOME,
 * else ../abap-cloud-gui) and imported in-process from there - never copied,
 * never a second implementation. A checkout without `npm ci` is reported as
 * such (the import of @abaplint/core fails), not as a converter error.
 *
 * The converter's contract (tools/report2cloud/lib/*.mjs, the compatibility
 * surface in AGENTS.md): `convert(source, { file, className, textpool })`
 * answers { ok, className, programName, files, draft, refusals, todos,
 * release, notes }, `parseTextpool(xml)` reads the .prog.xml text pool and
 * `migrationReport(result, { source, texts })` writes the markdown report.
 *
 * deployFiles( ) is the deploy half of `migrate_report { deploy: true }`: a
 * converted class inherits from z2ui5_cl_cgui_report and calls the popups, so
 * it is written into the dev sandbox together with src/01 of the checkout -
 * its classes, interfaces, tables and data elements - and the popups the
 * report runtime uses (the set abap-cloud-gui's unit.yaml deploys) - every
 * file of each object, as abap2ui5-unit writes them.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { resolveCloudGui } from './repos.mjs';
import { resolvedInside } from './remote.mjs';

/** The converter's modules, relative to the checkout. */
export const REPORT2CLOUD = {
  convert: 'tools/report2cloud/lib/convert.mjs',
  textpool: 'tools/report2cloud/lib/textpool.mjs',
  report: 'tools/report2cloud/lib/report.mjs',
};

/** The popups src/01 calls - the set abap-cloud-gui's unit.yaml deploys. */
export const POPUP_FILES = [
  'src/00',
  'src/z2ui5_cl_popup_get_range.clas.abap',
  'src/z2ui5_cl_popup_to_confirm.clas.abap',
  'src/z2ui5_cl_popup_to_select.clas.abap',
  'src/z2ui5_cl_popup_input_val.clas.abap',
];

/** Raised for a setup problem (checkout missing, npm ci not run) - the tool
 *  answers it as the setup message it is. */
export class SetupError extends Error {}

/** The program name of a report source: REPORT / PROGRAM <name>, or null. Pure. */
export function programNameOf(source) {
  const m = /^\s*(?:REPORT|PROGRAM)\s+([\w/]+)/im.exec(String(source || '').replace(/^\s*\*.*$/gm, ''));
  return m ? m[1].toLowerCase() : null;
}

/** A class name report2cloud may be given: the ABAP name rules, 30 chars. Pure. */
export function validTargetClass(name) {
  return typeof name === 'string' && /^[a-z/][a-z0-9_/]*$/i.test(name) && name.length <= 30;
}

/** Raised when the report carries the transpiler's code escape - the tool
 *  refuses it (transpilerHazards). */
export class KernelEscapeError extends Error {}

/** One line of ABAP with its comment removed: a `*` in column 1 is a whole
 *  line of comment, a `"` outside a literal starts one. The three literal
 *  kinds ('...', `...`, |...|) are skipped so a quote inside one is no
 *  comment; '' and `` are their escaped quotes, and both run back into the
 *  same literal. Pure. */
export function codeOfLine(line) {
  if (line.startsWith('*')) return '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '|') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"') {
      return line.slice(0, i);
    } else if (c === "'" || c === '`' || c === '|') {
      quote = c;
    }
  }
  return line;
}

/**
 * The places a report would run as JavaScript once transpiled, by line.
 *
 * `kernel`: a character literal that starts with `@KERNEL ` - open-abap's
 * escape. The transpiler copies the rest of `WRITE '@KERNEL <js>'.` into the
 * generated module VERBATIM, as code: on an SAP system the statement writes
 * a line of text, on the backend it is JavaScript with this user's
 * privileges. No classic report has a reason to write that text, so one
 * that does was written for the transpiled target - and migrate_report
 * refuses it. report2cloud happens to rewrite a plain WRITE into a method
 * call (the literal becomes harmless data), but it copies a refused
 * statement into `partial`'s draft as it is, and local classes verbatim:
 * the escape survives there, and a later deploy runs it. Matched
 * case-insensitively and with any blank after it, in every literal outside
 * comments - wider than the transpiler's exact `'@KERNEL ` on purpose.
 *
 * `dynamicWhere`: `LOOP AT ... WHERE (<condition>)`. @abaplint/runtime
 * evaluates a dynamic WHERE condition with eval() after rewriting the
 * comparisons it recognises - whatever else the string holds runs as
 * JavaScript (`table_line EQ table_line OR (globalThis.x=1)` sets x). It is
 * ordinary ABAP, so it is flagged, not refused: a condition built from a
 * selection-screen field is code injection on the backend that runs the
 * migrated app. Pure.
 */
export function transpilerHazards(source) {
  const lines = String(source || '').split(/\r?\n/);
  const code = lines.map(codeOfLine);
  const kernel = [];
  code.forEach((l, i) => {
    for (const m of l.matchAll(/'@KERNEL\s/gi)) kernel.push({ row: i + 1, col: m.index + 1, text: lines[i].trim().slice(0, 120) });
  });
  const joined = code.join('\n');
  const dynamicWhere = [];
  for (const m of joined.matchAll(/\bLOOP\s+AT\s[^.]*?\bWHERE\s*\(/gi)) {
    const before = joined.slice(0, m.index);
    const row = before.split('\n').length;
    dynamicWhere.push({ row, col: m.index - before.lastIndexOf('\n'), text: lines[row - 1].trim().slice(0, 120) });
  }
  return { kernel, dynamicWhere };
}

/** The refusal for `@KERNEL` literals at `places` of `file`. */
function kernelRefusal(file, places, where = 'the report') {
  return new KernelEscapeError(`refusing to convert: ${where} contains open-abap's @KERNEL escape - `
    + places.slice(0, 5).map((p) => `${p.file || file}:${p.row}:${p.col} ${p.text}`).join('; ')
    + (places.length > 5 ? ` (+${places.length - 5} more)` : '')
    + '. On an SAP system `WRITE \'@KERNEL ...\'` writes a line of text; transpiled for the backend it runs the rest of the literal as '
    + 'JavaScript with your user\'s privileges, and no classic report has a reason to contain it. Nothing was converted or written. '
    + 'Remove the statement - or, if the text itself is wanted, split the literal (\'@\' && \'KERNEL ...\') so it is data again.');
}

/** report2cloud's modules from the checkout, or a SetupError naming the fix. */
export async function loadReport2cloud(dir = resolveCloudGui()) {
  if (!dir) throw new SetupError('abap-cloud-gui checkout not found');
  const mods = {};
  for (const [k, rel] of Object.entries(REPORT2CLOUD)) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) {
      throw new SetupError(`the abap-cloud-gui checkout at ${dir} has no ${rel} - report2cloud arrived after its first release; git pull there`);
    }
    try {
      mods[k] = await import(pathToFileURL(file).href);
    } catch (e) {
      if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
        throw new SetupError(`report2cloud in ${dir} cannot load its dependencies (${String(e.message).split('\n')[0]}) - run \`npm ci\` in ${dir}`);
      }
      throw e;
    }
  }
  if (typeof mods.convert.convert !== 'function' || typeof mods.textpool.parseTextpool !== 'function' || typeof mods.report.migrationReport !== 'function') {
    throw new SetupError(`report2cloud in ${dir} does not export convert / parseTextpool / migrationReport - its contract changed; update mcp-server or the checkout`);
  }
  return { dir, ...mods.convert, ...mods.textpool, ...mods.report };
}

/**
 * Convert a report. `source` the .prog.abap text, `textsXml` its .prog.xml
 * (the text pool: selection texts, text symbols, title), `className` the
 * target class (default: report2cloud's, zcl_ + the report name).
 * Resolves { ok, className, program, file, files, report, refusals, todos,
 * release, notes, warnings, draft? }; `files` is empty when refused -
 * `partial` hands the draft over then, with the refused statements marked.
 * Throws a KernelEscapeError for a report that carries open-abap's code
 * escape (transpilerHazards) - before report2cloud runs.
 */
export async function migrateReport({ source, textsXml, className, partial = false, dir } = {}) {
  const program = programNameOf(source);
  const file = `${program || 'zreport'}.prog.abap`;
  /* refused before report2cloud runs: nothing is converted, nothing written */
  const hazards = transpilerHazards(source);
  if (hazards.kernel.length) throw kernelRefusal(file, hazards.kernel);
  const r2c = await loadReport2cloud(dir);
  const textpool = textsXml ? r2c.parseTextpool(textsXml) : undefined;
  const result = r2c.convert(source, { file, ...(className ? { className } : {}), ...(textpool ? { textpool } : {}) });
  /* and the converter's output, the files and the draft alike - whatever a
   * converter rule may assemble, no escape leaves this tool */
  const produced = Object.entries({ ...(result.files || {}), ...(result.draft || {}) })
    .flatMap(([name, text]) => transpilerHazards(text).kernel.map((k) => ({ ...k, file: name })));
  if (produced.length) throw kernelRefusal(file, produced, 'report2cloud\'s output');
  const report = r2c.migrationReport(result, { source: file, ...(textsXml ? { texts: `${program || 'zreport'}.prog.xml` } : {}) });
  const at = (x) => `${file}:${x.row}:${x.col}`;
  return {
    ok: result.ok,
    className: result.className,
    program: result.programName,
    file,
    converter: r2c.dir,
    files: result.files,
    ...(partial && !result.ok ? { draft: result.draft } : {}),
    report,
    refusals: result.refusals.map((x) => ({ at: at(x), message: x.message })),
    todos: result.todos.map((x) => ({ ...(x.row ? { at: at(x) } : {}), message: x.message })),
    release: result.release,
    notes: result.notes,
    warnings: hazards.dynamicWhere.map((x) => ({
      at: `${file}:${x.row}:${x.col}`,
      message: `${x.text} - a dynamic WHERE condition is evaluated as JavaScript by the transpiled runtime (@abaplint/runtime eval()s what it does not rewrite): `
        + 'built from a selection-screen field or any other input, it is code injection on the backend that runs this app. '
        + 'Build the condition from fixed field names, or replace it with a static WHERE.',
    })),
  };
}

/** The popups checkout: POPUPS_HOME, else .deps/popups of the abap-cloud-gui
 *  checkout (its unit.yaml clones it there), else ../popups beside either
 *  checkout, else its build/popups. Null when none is there. */
export function resolvePopups(cloudGui = resolveCloudGui(), env = process.env) {
  const probe = (d) => d && fs.existsSync(path.join(d, 'src', 'z2ui5_cl_popup_to_select.clas.abap'));
  if (env.POPUPS_HOME) return probe(env.POPUPS_HOME) ? path.resolve(env.POPUPS_HOME) : null;
  const cands = cloudGui
    ? [path.join(cloudGui, '.deps', 'popups'), path.join(cloudGui, '..', 'popups'), path.join(cloudGui, 'build', 'popups')]
    : [];
  return cands.find(probe) ? path.resolve(cands.find(probe)) : null;
}

/* Classes, interfaces - and the tables and data elements of the report
 * runtime's stores (z2ui5_cgui_var, z2ui5_cgui_lay and their DTELs): the
 * backend creates the sandbox's tables at boot. */
const OBJECT_FILE = /^[a-z0-9_]+\.(clas|intf|tabl|dtel)(\.[a-z_]+)?\.(abap|xml)$/i;

/** Every file of the objects under `p` (a directory, or a .clas.abap whose
 *  sidecar and includes come along) - test includes left out. */
function objectFiles(p) {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isDirectory()) {
    return fs.readdirSync(p).sort().filter((f) => OBJECT_FILE.test(f) && !f.endsWith('.testclasses.abap')).map((f) => path.join(p, f));
  }
  const m = /^(.*)\.clas\.abap$/.exec(path.basename(p));
  if (!m) return [p];
  return fs.readdirSync(path.dirname(p)).sort()
    .filter((f) => f.startsWith(`${m[1]}.clas.`) && !f.endsWith('.testclasses.abap'))
    .map((f) => path.join(path.dirname(p), f));
}

/**
 * Write a converted class (`files`: { name: text }) into the sandbox
 * directory `dir`, with src/01 of the checkout and the popups it calls.
 * `classNameOf` is the sandbox's name gate. Returns { written, support }.
 */
export function deployFiles({ files, dir, cloudGui, popups, classNameOf }) {
  const support = [...objectFiles(path.join(cloudGui, 'src', '01')), ...POPUP_FILES.flatMap((p) => objectFiles(path.join(popups, p)))];
  /* every name through the gate before the first file is written: a class
   * name the sandbox refuses (a namespaced /abc/cl_x, which report2cloud
   * accepts) used to throw only after the support classes were copied in -
   * a refused deploy that still left the next build's input changed */
  for (const f of support) classNameOf(path.basename(f).split('.')[0]);
  for (const name of Object.keys(files)) classNameOf(name.split('.')[0]);
  fs.mkdirSync(dir, { recursive: true });
  /* every target stays inside the sandbox: the names passed classNameOf, but
   * a symbolic link already in the sandbox (a checkout is untrusted content)
   * would make copyFileSync/writeFileSync clobber the file it points at
   * (lib/remote.mjs resolvedInside) */
  const dst = (name) => {
    const at = path.join(dir, name);
    if (!resolvedInside(dir, at)) {
      throw new Error(`refusing to write ${name} - it resolves, through a symbolic link, outside the dev sandbox ${dir}`);
    }
    return at;
  };
  const written = [];
  for (const f of support) {
    const at = dst(path.basename(f));
    fs.copyFileSync(f, at);
    written.push(at);
  }
  for (const [name, text] of Object.entries(files)) {
    const at = dst(name);
    fs.writeFileSync(at, text);
    written.push(at);
  }
  return { written, support: [...new Set(support.map((f) => path.basename(f).split('.')[0]))] };
}

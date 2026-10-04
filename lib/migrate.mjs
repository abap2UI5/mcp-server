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
 * release, notes, draft? }; `files` is empty when refused - `partial` hands
 * the draft over then, with the refused statements marked.
 */
export async function migrateReport({ source, textsXml, className, partial = false, dir } = {}) {
  const r2c = await loadReport2cloud(dir);
  const program = programNameOf(source);
  const file = `${program || 'zreport'}.prog.abap`;
  const textpool = textsXml ? r2c.parseTextpool(textsXml) : undefined;
  const result = r2c.convert(source, { file, ...(className ? { className } : {}), ...(textpool ? { textpool } : {}) });
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
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const f of support) {
    classNameOf(path.basename(f).split('.')[0]);
    const dst = path.join(dir, path.basename(f));
    fs.copyFileSync(f, dst);
    written.push(dst);
  }
  for (const [name, text] of Object.entries(files)) {
    classNameOf(name.split('.')[0]);
    const dst = path.join(dir, name);
    fs.writeFileSync(dst, text);
    written.push(dst);
  }
  return { written, support: [...new Set(support.map((f) => path.basename(f).split('.')[0]))] };
}

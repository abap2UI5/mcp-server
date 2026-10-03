/* add_agent_setup - the agent setup of abap2UI5/app-template, added to a
 * project that already exists.
 *
 * scaffold_app answers "what does a NEW project look like" and writes nothing:
 * the agent writes the files it hands back. Most abap2UI5 projects never
 * started from the template, though - they are an abapGit repository with a
 * src/ folder - and the template's agent setup (AGENTS.md, the four skills,
 * the MCP registration, the permission allowlist) plus the two gates and the
 * CI job it tells an agent to run are worth as much there. Adding them is a
 * MERGE with what the project has, which needs the project's files, so this
 * one reads and writes the project directory itself.
 *
 * WHAT is added is not decided here. app-template's `template.json` says it
 * under `agentSetup`: the files, which two of them are merged rather than
 * copied, and which text in them names the source folder. This module
 * executes that key exactly as the template's own executor does -
 * `npm create abap2ui5-app -- --agent-setup`, create/agent-setup.mjs - so an
 * agent asking this server gets what a human running that command gets.
 * test/agent-setup.test.mjs holds the two planners against each other when an
 * app-template checkout is beside this repository. The three rules that make
 * writing into somebody's repository safe are that file's, carried over:
 *
 *   a file the project has is NEVER overwritten. It is skipped and named;
 *   a second run over a finished setup changes nothing.
 *
 *   the files under `agentSetup.merge` (package.json, .gitignore) only ever
 *   GAIN entries; every entry the project has keeps its value, and each one
 *   kept on a value that differs from the template's is named.
 *
 *   src/ is the template's folder, not necessarily the project's: the
 *   project's .abapgit.xml STARTING_FOLDER decides, and the files
 *   `agentSetup.sourceFolder` names are pointed there.
 *
 * And the server's own, on top, because the paths come from a file in another
 * repository (a checkout, or the GitHub mirror) and the directory from an
 * agent: every path passes the mirror's whitelist (`safeRelPath`), must be a
 * file the template lists as shared and none it lists as named, must not lie
 * in the project's source folder, and must not leave the project through a
 * symbolic link. Everything is decided before anything is written, so a
 * refusal leaves the project as it was.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { safeRelPath } from './remote.mjs';

/** `<STARTING_FOLDER>/abap/src/</STARTING_FOLDER>` -> `abap/src`; '' for the
 *  repository root; null when the file says nothing. */
export function startingFolder(abapgitXml) {
  const m = /<STARTING_FOLDER>([^<]*)<\/STARTING_FOLDER>/.exec(abapgitXml || '');
  if (!m) return null;
  return m[1].trim().replace(/^\/+|\/+$/g, '');
}

/** One file's text with the template's source folder replaced by the
 *  project's, inside the first occurrence of each edit's `text` only. */
export function adaptSourceFolder(rel, text, sourceFolder, folder) {
  if (!sourceFolder || folder === sourceFolder.placeholder) return text;
  let out = text;
  for (const edit of sourceFolder.edits || []) {
    if (edit.file !== rel) continue;
    const at = out.indexOf(edit.text);
    if (at === -1) continue;
    const replaced = edit.text.replace(sourceFolder.placeholder, () => folder);
    out = out.slice(0, at) + replaced + out.slice(at + edit.text.length);
  }
  return out;
}

/** The indentation a JSON file is written with, so a merge does not reformat
 *  somebody's package.json from four spaces to two. */
function indentOf(text) {
  return /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
}

/**
 * package.json, merged: every entry under `keys` the project lacks is added,
 * every entry it has keeps its value (a devDependency it lists under
 * dependencies counts as present). Returns the new text (null when nothing
 * was added), what was added, and what was kept on a different value. Throws
 * when either side is not JSON.
 */
export function mergePackageJson(existingText, templateText, keys) {
  const tpl = JSON.parse(templateText);
  const pkg = JSON.parse(existingText);
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('not a JSON object');
  const added = [];
  const kept = [];
  for (const key of keys) {
    const want = tpl[key];
    if (!want || typeof want !== 'object') continue;
    for (const [name, value] of Object.entries(want)) {
      const have = pkg[key]?.[name] ?? (key === 'devDependencies' ? pkg.dependencies?.[name] : undefined);
      if (have === undefined) {
        pkg[key] = { ...(pkg[key] || {}), [name]: value };
        added.push(`${key}.${name}`);
      } else if (have !== value) {
        kept.push({ entry: `${key}.${name}`, have, want: value });
      }
    }
  }
  if (!added.length) return { text: null, added, kept };
  const eol = existingText.endsWith('\n') || !existingText.length ? '\n' : '';
  return { text: JSON.stringify(pkg, null, indentOf(existingText)) + eol, added, kept };
}

/** `node_modules`, `/node_modules`, `node_modules/` - one pattern to a reader. */
const normalisePattern = (line) => line.trim().replace(/^\/+|\/+$/g, '');

/**
 * .gitignore, merged: the template's patterns the project does not ignore yet
 * are appended, each block with the comment lines above it in the template.
 * Returns the new text (null when nothing was missing) and the patterns added.
 */
export function mergeLines(existingText, templateText) {
  const have = new Set(existingText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map(normalisePattern));
  const out = [];
  const added = [];
  let comments = [];
  let fresh = true;
  for (const line of templateText.split(/\r?\n/)) {
    if (!line.trim()) {
      comments = [];
      fresh = true;
      continue;
    }
    if (line.trim().startsWith('#')) {
      comments.push(line);
      continue;
    }
    if (have.has(normalisePattern(line))) continue;
    if (fresh && out.length) out.push('');
    out.push(...comments, line);
    comments = [];
    fresh = false;
    added.push(line.trim());
  }
  if (!added.length) return { text: null, added };
  let text = existingText;
  if (text.length && !text.endsWith('\n')) text += '\n';
  if (text.length) text += '\n';
  return { text: `${text}${out.join('\n')}\n`, added };
}

/** The npm package name a project without a package.json gets: the
 *  directory's, in the characters npm accepts. */
export function packageNameFor(dir) {
  return path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'abap2ui5-app';
}

/** Where the project's classes are, and how that was decided. */
export function sourceFolderOf(dir, placeholder) {
  const xmlPath = path.join(dir, '.abapgit.xml');
  if (!fs.existsSync(xmlPath)) {
    return { folder: placeholder, from: `no .abapgit.xml - assuming ${placeholder}/` };
  }
  const folder = startingFolder(fs.readFileSync(xmlPath, 'utf8'));
  if (folder === null) return { folder: placeholder, from: `.abapgit.xml names no STARTING_FOLDER - assuming ${placeholder}/` };
  return { folder, from: '.abapgit.xml STARTING_FOLDER' };
}

/** Is `child` the directory `parent` or inside it? Both absolute. */
const within = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const lexists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Why `dir` is not a directory this tool may write into - or null.
 *
 * An existing directory only (a new project is scaffold_app's), never the
 * file system root or the home directory itself (a package.json and a .claude/
 * there configure every project below it), never this server's own
 * installation, the template it reads from or the mirror cache. A directory
 * the agent did not NAME - the server's working directory, the default - has
 * to look like a project as well: an MCP client may start the server
 * anywhere, and "set up this project" must not land in whatever that was.
 */
export function agentTargetProblem(dir, { defaulted = false, forbidden = [] } = {}) {
  if (!fs.existsSync(dir)) return `${dir} does not exist - add_agent_setup adds to an existing project; for a new one call scaffold_app`;
  if (!fs.statSync(dir).isDirectory()) return `${dir} exists and is not a directory`;
  const real = fs.realpathSync(dir);
  if (real === path.parse(real).root) return `${dir} is the file system root - pass the project's directory as project_dir`;
  let home = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch { /* no home directory */ }
  if (home && real === home) return `${dir} is the home directory, not a project - pass the project's directory as project_dir`;
  for (const { dir: other, what } of forbidden) {
    if (!other || !fs.existsSync(other)) continue;
    if (within(fs.realpathSync(other), real)) return `${dir} is ${what}, not a project - pass the project's directory as project_dir`;
  }
  if (defaulted && !['.git', '.abapgit.xml', 'package.json'].some((m) => lexists(path.join(dir, m)))) {
    return `the server's working directory ${dir} does not look like a project (no .git, .abapgit.xml or package.json) - `
      + 'pass the project\'s directory as project_dir';
  }
  return null;
}

/**
 * The paths `agentSetup.files` names, checked before anything is read or
 * written. A path that fails is a template this server will not execute -
 * thrown, so the whole call refuses and the project stays untouched.
 */
export function checkSetupPaths(spec, folder) {
  const shared = new Set(spec.files?.shared || []);
  const named = new Set(spec.files?.named || []);
  for (const rel of Object.keys(spec.agentSetup.files)) {
    if (safeRelPath(rel) !== rel) {
      throw new Error(`template.json's agentSetup names '${String(rel).slice(0, 120)}', which is not a plain path inside the project`);
    }
    if (named.has(rel) || !shared.has(rel)) {
      throw new Error(`template.json's agentSetup names ${rel}, which is not one of the template's shared files - `
        + 'an agent setup takes shared files only');
    }
    if (folder && (rel === folder || rel.startsWith(folder + '/'))) {
      throw new Error(`template.json's agentSetup names ${rel}, inside the project's source folder ${folder}/ - `
        + 'this tool never writes there');
    }
  }
}

/** Does writing `rel` stay inside `dir` - the nearest existing ancestor of
 *  the target, symbolic links resolved, still under the project? */
function staysInside(dir, rel) {
  const root = fs.realpathSync(dir);
  let at = path.dirname(path.join(dir, rel));
  while (!fs.existsSync(at)) at = path.dirname(at);
  return within(root, fs.realpathSync(at));
}

/**
 * The whole agent setup for `dir`, decided and not written: one action per
 * file - `add` (bytes to write), `merge` (bytes to write over the project's,
 * with what was added), `skip` (the project has it, or has everything the
 * merge would add) - plus the warnings. `read(rel)` answers the template
 * file's bytes. The same shape and decisions as create/agent-setup.mjs'
 * planAgentSetup, plus the path checks above.
 */
export async function planAgentSetup(spec, read, dir) {
  const setup = spec.agentSetup;
  const placeholder = setup.sourceFolder?.placeholder ?? 'src';
  const warnings = [];
  let { folder, from } = sourceFolderOf(dir, placeholder);
  const declared = folder;
  if (folder === '') {
    warnings.push(`.abapgit.xml's STARTING_FOLDER is the repository root - the gates were left pointing at ${placeholder}/; `
      + 'set abaplint.jsonc\'s global.files and abap2ui5lint.jsonc\'s paths to your classes by hand');
    folder = placeholder;
  }
  if (!fs.existsSync(path.join(dir, folder))) {
    warnings.push(`${folder}/ does not exist - the gates are configured for it and will find no classes there`);
  }
  checkSetupPaths(spec, declared);

  const actions = [];
  for (const rel of Object.keys(setup.files)) {
    const target = path.join(dir, rel);
    const merge = setup.merge?.[rel];
    if (lexists(target) && fs.lstatSync(target).isSymbolicLink()) {
      actions.push({ path: rel, kind: 'skip', detail: 'a symbolic link - left as it is' });
      if (merge) warnings.push(`${rel} is a symbolic link - not merged; add the template's ${merge.how === 'json' ? 'entries' : 'patterns'} by hand`);
      continue;
    }
    if (!staysInside(dir, rel)) {
      actions.push({ path: rel, kind: 'skip', detail: 'its folder leads outside the project through a symbolic link - left alone' });
      warnings.push(`${rel} was not written: a folder on its way is a symbolic link out of the project`);
      continue;
    }
    const exists = fs.existsSync(target);
    if (exists && !merge) {
      actions.push({ path: rel, kind: 'skip', detail: 'already there - left as it is' });
      continue;
    }
    const bytes = await read(rel);
    const adapted = adaptSourceFolder(rel, bytes.toString('utf8'), setup.sourceFolder, folder);
    const changed = adapted !== bytes.toString('utf8');
    const folderNote = changed ? `sources: ${folder}/` : '';

    if (!exists && merge?.how === 'json') {
      // the entries a merge would add, under the project's own name - not the
      // template's file, whose license and description are the template's
      const base = `${JSON.stringify({ name: packageNameFor(dir), private: true }, null, 2)}\n`;
      const result = mergePackageJson(base, adapted, merge.keys);
      actions.push({ path: rel, kind: 'add', bytes: Buffer.from(result.text ?? base, 'utf8'), detail: folderNote });
      continue;
    }
    if (!exists) {
      actions.push({ path: rel, kind: 'add', bytes: changed ? Buffer.from(adapted, 'utf8') : bytes, detail: folderNote });
      continue;
    }

    const existing = fs.readFileSync(target, 'utf8');
    if (merge.how === 'json') {
      let result;
      try {
        result = mergePackageJson(existing, adapted, merge.keys);
      } catch (err) {
        throw new Error(`${rel} is not valid JSON (${err.message}) - fix it, or move it aside and re-run`);
      }
      for (const k of result.kept) {
        warnings.push(`${rel}: kept your ${k.entry} ${JSON.stringify(k.have)} - the template has ${JSON.stringify(k.want)}`);
      }
      if (!result.text) {
        actions.push({ path: rel, kind: 'skip', detail: `already has every entry of ${merge.keys.join(', ')}` });
      } else {
        const counts = merge.keys
          .map((key) => [key, result.added.filter((a) => a.startsWith(`${key}.`)).length])
          .filter(([, n]) => n)
          .map(([key, n]) => `+${n} ${key}`);
        actions.push({ path: rel, kind: 'merge', bytes: Buffer.from(result.text, 'utf8'), detail: counts.join(', '), added: result.added });
      }
    } else if (merge.how === 'lines') {
      const result = mergeLines(existing, adapted);
      if (!result.text) actions.push({ path: rel, kind: 'skip', detail: 'already ignores everything the template does' });
      else actions.push({ path: rel, kind: 'merge', bytes: Buffer.from(result.text, 'utf8'), detail: `+ ${result.added.join(' ')}`, added: result.added });
    } else {
      throw new Error(`template.json's agentSetup.merge asks for "${merge.how}" on ${rel}, which this server cannot do - update it`);
    }
  }

  for (const [rel, variants] of Object.entries(setup.existingVariants?.files ?? {})) {
    for (const v of variants) {
      if (fs.existsSync(path.join(dir, v)) && actions.find((a) => a.path === rel)?.kind === 'add') {
        warnings.push(`this project has ${v}, and now ${rel} as well - \`npm run check:abap\` and the pin check read ${rel}; `
          + `move your rules into it and delete ${v}, or keep both on purpose`);
      }
    }
  }
  return { folder, from, actions, warnings };
}

/** Writes the plan's `add` and `merge` actions - and nothing outside `dir`,
 *  whatever a path says (the last line of defence behind checkSetupPaths). */
export function writePlan(dir, actions) {
  const root = path.resolve(dir);
  for (const a of actions) {
    if (a.kind === 'skip') continue;
    const at = path.resolve(root, a.path);
    if (!within(root, at) || at === root) throw new Error(`refusing to write '${a.path}' outside ${root}`);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, a.bytes);
  }
}

/**
 * The offline half of `npm run check:pin` over the finished project, by the
 * template checkout's own scripts/check-pin.mjs - only when the project's
 * copy is byte for byte that file (never somebody else's code), and only from
 * a LOCAL checkout: code is imported from a checkout here, never from the
 * mirror. A project that kept its own AGENTS.md or abaplint.jsonc usually
 * names no pin there, and check.yml's first step would fail on its first push.
 */
export async function pinProblems(dir, templateRoot) {
  const mine = path.join(dir, 'scripts/check-pin.mjs');
  const theirs = path.join(templateRoot, 'scripts/check-pin.mjs');
  try {
    if (!fs.existsSync(mine) || !fs.existsSync(theirs) || !fs.readFileSync(mine).equals(fs.readFileSync(theirs))) return [];
    const url = `${pathToFileURL(theirs).href}?mtime=${fs.statSync(theirs).mtimeMs}`;
    const { readPinSites } = await import(url);
    return readPinSites(dir).problems;
  } catch {
    return [];
  }
}

/** The pin problems as the one warning the create package prints. */
export function pinWarning(problems, ownsCheckPin) {
  const who = ownsCheckPin
    ? '`npm run check:pin` (the first step of check.yml) and `npm run doctor` would fail as things stand:'
    : '`npm run doctor` would report the framework pin as FAIL (your own check:pin script is not affected):';
  return `${who} ${problems.map((p) => p.replace(/\s*\n\s*/g, ' ')).join('; ')} - abaplint.jsonc's "branch" is the framework pin `
    + '(a release tag such as "1.145.0", not a branch) and every other place that names a release has to agree with it; '
    + 'scripts/check-pin.mjs lists the places';
}

/** What to do after the files are there - the create package's next steps,
 *  as lines an agent can run. */
export function agentSetupNextSteps({ folder, wroteAgents }) {
  const next = [
    'npm install - both gates; it writes package-lock.json: commit it, check.yml runs npm ci',
    'npx playwright install chromium - once; only the render gate needs a browser',
    `npm run check - abaplint + abap2UI5-linter over ${folder}/`,
    'npm run doctor - when something above does not look right',
  ];
  if (wroteAgents) {
    next.push('AGENTS.md\'s first section ("This repository") describes a project made from the template - zcl_app_001 in src/. '
      + 'Rewrite it for this project and keep everything from "1. The model in one paragraph" down: that half is the '
      + 'app-building reference, the same for every abap2UI5 app.');
  }
  return next;
}

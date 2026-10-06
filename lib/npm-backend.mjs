/*
 * npm-backend — the expensive half without a framework checkout: the
 * published npm package @abap2ui5/node-runtime instead of a git clone of
 * abap2UI5 plus `npm ci` of its devDependencies.
 *
 * WHY. With no checkout, build_backend used to shallow-clone the framework
 * into the workspace and run `npm ci` there - the framework's whole
 * development toolchain (Playwright, @ui5/cli, eslint, c8, terser; 186 MB of
 * node_modules measured for 1.145.0) - only to get the transpiler and
 * abaplint, and then download the release's backend-<version>.tar.gz. Every
 * CI run of every app repository paid that through abap2ui5-unit, and so did
 * every VS Code user. @abap2ui5/node-runtime carries exactly what the loop
 * needs, from ONE release commit: output/ (the framework, transpiled; its
 * init.mjs boots it), downport/ (the same commit's ABAP, to transpile apps
 * against), srv/host.mjs (initialize, createHandler, createApp, serve) and
 * in its package.json the transpiler version that wrote output/
 * (`abap2ui5.transpiler`).
 *
 * THE WORKSPACE (A2UI5_MCP_WORKSPACE, default ~/.abap2ui5-mcp):
 *
 *   runtime/<version>/            one directory per framework release
 *     package.json + package-lock.json   exact versions, lockfile integrity:
 *                                 @abap2ui5/node-runtime, express (a version
 *                                 its peer range accepts), the transpiler
 *                                 the package names, and @abaplint/cli at
 *                                 app-template's pin for the lint
 *     node_modules/               installed with --ignore-scripts
 *     apps/                       the transpiled DEV APPS - and nothing else:
 *                                 their modules, the unit-test runner the
 *                                 transpiler generated for them (index.mjs)
 *                                 and init.mjs, the boot both the runner and
 *                                 the host import
 *     .abap2ui5-mcp-runtime.json  written after a complete install
 *   runtime/current.json          the release the last build used
 *   runtime/registry.json         the registry's latest, cached a day
 *   open-abap-core/<sha>/         the standard library the transpile
 *                                 type-checks against, at the commit the
 *                                 package was built with - fetched with git,
 *                                 shared by every release built on that sha
 *   sandbox/                      the dev apps' sources (deploy_app writes
 *                                 here) - outside runtime/, so a new release
 *                                 keeps every deployed app
 *
 * THE BUILD transpiles only the sandbox. The transpiler has no option to
 * leave its libraries out of the output - it transpiles and writes every
 * dependency object as well (737 objects for one app class, measured) - so
 * it writes into a staging directory, and apps/ receives only the files of
 * the sandbox's own objects. Their imports of framework and open-abap-core
 * modules (`await import("./cx_root.clas.mjs")`) are rewritten to the
 * package's public `./output/*` export: a SECOND copy of cx_root would
 * register itself over the package's in abap.Classes, and every
 * `e instanceof abap.Classes['CX_ROOT']` the framework's CATCH compiles to
 * would then fail for exceptions of the first. apps/ is rebuilt whole on
 * every build, which is also what takes a removed app out of it. A
 * sandbox's database tables (TABL) are created by apps/init.mjs at boot,
 * from the CREATE TABLE statements the transpiler wrote for them (see
 * tableSchema); a sandbox without tables boots exactly as before.
 *
 * Nothing here imports lib/runtime.mjs (which imports this module): the
 * child-process helpers come from lib/spawn.mjs.
 */
import fs from 'fs';
import path from 'path';
import { workspaceRoot, resolveAppTemplate } from './repos.mjs';
import { remoteTtlMs } from './remote.mjs';
import { spawnWithTimeout, localBin, missingBinMessage, timedOutError } from './spawn.mjs';

export const RUNTIME_PKG = '@abap2ui5/node-runtime';
export const OPEN_ABAP_CORE_URL = 'https://github.com/open-abap/open-abap-core';

/* The open-abap-core commit each release was built with, for the releases
 * whose package.json does not record it yet (`abap2ui5.openAbapCore`
 * arrives with the release after 1.145.0). 1.145.0: abap2UI5's
 * node/setup/fetch-deps.mjs at tag 1.145.0 (commit e0c54eb9, the package's
 * `abap2ui5.commit`) pins b2d219df. A release in neither place is
 * type-checked against open-abap-core's current HEAD, resolved to a sha
 * first and said so. */
export const KNOWN_OPEN_ABAP_CORE = {
  '1.145.0': 'b2d219df61f8c077df7a038bc43d168f9f280fbf',
};

/* The lint's abaplint when app-template's pin cannot be read (no checkout,
 * no mirror, a lockfile without the entry): the version the template's
 * lockfile pinned when this line was written. */
export const ABAPLINT_CLI_FALLBACK = '2.120.60';

/* The express major the first release's peer range names; used only when a
 * package declares no peer at all. */
export const EXPRESS_FALLBACK_RANGE = '^5.0.0';

export const RUNTIME_MARKER = '.abap2ui5-mcp-runtime.json';
export const APPS_DIR = 'apps';
export const BUILD_RECORD = '.abap2ui5-mcp-build.json';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/* What a peer range may contain before it goes onto an npm command line: a
 * semver range and nothing a shell could read (Windows runs npm through
 * cmd.exe). Anything else falls back to EXPRESS_FALLBACK_RANGE. */
const RANGE_RE = /^[\^~<>=|\s\d.x*-]+$/;

// ------------------------------------------------------------ the layout ----

export const runtimeBase = () => path.join(workspaceRoot(), 'runtime');
export const runtimeDir = (version) => path.join(runtimeBase(), version);
export const npmSandboxDir = () => path.join(workspaceRoot(), 'sandbox');
export const openAbapCoreDir = (sha) => path.join(workspaceRoot(), 'open-abap-core', sha);
export const appsDir = (dir) => path.join(dir, APPS_DIR);
const pkgDir = (dir) => path.join(dir, 'node_modules', ...RUNTIME_PKG.split('/'));
export const downportDir = (dir) => path.join(pkgDir(dir), 'downport');
const registryCacheFile = () => path.join(runtimeBase(), 'registry.json');
const currentFile = () => path.join(runtimeBase(), 'current.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- pure half ----

/** A2UI5_MCP_RUNTIME_VERSION: `{ value }` for a plain X.Y.Z, `{ invalid }`
 *  for anything else, `{}` when unset. Pure. */
export function readRuntimePin(env = process.env) {
  const raw = String(env.A2UI5_MCP_RUNTIME_VERSION || '').trim();
  if (!raw) return {};
  return VERSION_RE.test(raw) ? { value: raw } : { invalid: raw };
}

/** Numeric X.Y.Z order; negative when a < b. Pure. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** The open-abap-core commit a release was built with: the package's own
 *  record, then the table above. `{ sha: null }` when neither knows. Pure. */
export function openAbapCoreOf(meta, version) {
  const recorded = meta && meta.abap2ui5 && meta.abap2ui5.openAbapCore;
  if (typeof recorded === 'string' && SHA_RE.test(recorded)) return { sha: recorded, source: 'package' };
  const known = KNOWN_OPEN_ABAP_CORE[version];
  if (known) return { sha: known, source: 'known' };
  return { sha: null, source: 'unknown' };
}

/** The transpiler that wrote the package's output/: its record, else the
 *  @abaplint/runtime the package pins (the two are released in lockstep, same
 *  version number). Null when neither is a plain version. Pure. */
export function transpilerOf(meta) {
  const recorded = meta && meta.abap2ui5 && meta.abap2ui5.transpiler;
  if (typeof recorded === 'string' && VERSION_RE.test(recorded)) return { version: recorded, source: 'package' };
  const runtime = meta && meta.dependencies && meta.dependencies['@abaplint/runtime'];
  if (typeof runtime === 'string' && VERSION_RE.test(runtime)) return { version: runtime, source: '@abaplint/runtime pin' };
  return null;
}

/** The express range the package's peer accepts (the fallback when it names
 *  none, or something that is not a plain range). Pure. */
export function expressRangeOf(meta) {
  const peer = meta && meta.peerDependencies && meta.peerDependencies.express;
  return typeof peer === 'string' && RANGE_RE.test(peer) && /\d/.test(peer) ? peer.trim() : EXPRESS_FALLBACK_RANGE;
}

/** The @abaplint/cli version app-template pins: its lockfile's exact entry,
 *  else the version its package.json range starts from, else the fallback.
 *  Takes the two files' TEXT (null when absent). Pure. */
export function cliVersionOf({ lockText = null, pkgText = null } = {}) {
  try {
    const lock = lockText && JSON.parse(lockText);
    const v = lock && lock.packages && lock.packages['node_modules/@abaplint/cli'] && lock.packages['node_modules/@abaplint/cli'].version;
    if (typeof v === 'string' && VERSION_RE.test(v)) return { version: v, source: 'app-template package-lock.json' };
  } catch {
    /* not JSON: the next source */
  }
  try {
    const pkg = pkgText && JSON.parse(pkgText);
    const range = pkg && ((pkg.devDependencies && pkg.devDependencies['@abaplint/cli']) || (pkg.dependencies && pkg.dependencies['@abaplint/cli']));
    const m = typeof range === 'string' && /^[\^~=]?\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
    if (m) return { version: m[1], source: 'app-template package.json' };
  } catch {
    /* not JSON: the fallback */
  }
  return { version: ABAPLINT_CLI_FALLBACK, source: 'fallback (app-template\'s pin could not be read)' };
}

/** What the runtime directory of one release has to have installed: name ->
 *  exact version (express: the peer RANGE, recorded exact by the install).
 *  Pure. */
export function desiredDeps({ version, meta, cli = null }) {
  const transpiler = transpilerOf(meta);
  if (!transpiler) throw new Error(`${RUNTIME_PKG}@${version} names no transpiler version (abap2ui5.transpiler) and pins no @abaplint/runtime - there is no telling which transpiler its output needs`);
  return {
    [RUNTIME_PKG]: version,
    '@abaplint/transpiler-cli': transpiler.version,
    express: expressRangeOf(meta),
    ...(cli ? { '@abaplint/cli': cli } : {}),
  };
}

/** The `name@spec` arguments an install still needs: every dependency the
 *  runtime directory's package.json does not record at the wanted version -
 *  express only when it is not recorded at all, so the version the first
 *  install resolved stays the one in use. Pure. */
export function installSpecs(desired, recorded = {}) {
  const specs = [];
  for (const [name, want] of Object.entries(desired)) {
    const have = recorded[name];
    if (name === 'express' ? !have : have !== want) specs.push(`${name}@${want}`);
  }
  return specs;
}

/** The ABAP objects in a sandbox, as `<name>.<type>` keys: classes and
 *  interfaces (what deploy_app and abap2ui5-unit write), database tables
 *  and structures (TABL) and data elements (DTEL) - what migrate_report
 *  deploys with abap-cloud-gui's stores, and what a project's unit run
 *  brings along. Pure. */
export function devObjects(fileNames) {
  const keys = new Set();
  for (const f of fileNames) {
    const m = /^([a-z0-9_]+)\.(clas|intf|tabl|dtel)\./i.exec(f);
    if (m) keys.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  }
  return [...keys].sort();
}

/** The transpiler's output files that belong to the dev objects: the module,
 *  its locals and testclasses modules, their source maps. Pure. */
export function devOutputFiles(outputFiles, objects) {
  const prefixes = objects.map((o) => `${o}.`);
  return outputFiles
    .filter((f) => /\.mjs(\.map)?$/.test(f) && prefixes.some((p) => f.toLowerCase().startsWith(p)))
    .sort();
}

/* The two shapes the transpiler writes an import of another object in, each
 * at the start of a line: `const {x} = await import("./x.clas.mjs");` and
 * `await import("./x.clas.locals.mjs");` (and, in _init.mjs, the static
 * `import "./x.mjs";`). Anchored on the line so the text of an ABAP string
 * literal that happens to read like an import is never touched. */
const IMPORT_LINE = /^([ \t]*(?:const\s*\{[^}\n]*\}\s*=\s*)?await\s+import\(\s*|[ \t]*import\s+(?:[^"\n]*\s+from\s+)?)"\.\/([^"/\n]+\.mjs)"/gm;

/** A dev module's imports of objects outside `local` (a Set of file names),
 *  pointed at the package's `./output/*` export - the modules the package's
 *  own boot already loaded, so there is one instance of each. Pure. */
export function rewriteImports(text, local) {
  return text.replace(IMPORT_LINE, (m, lead, file) => (local.has(file) ? m : `${lead}"${RUNTIME_PKG}/output/${file}"`));
}

/** Relative imports of files outside `local` left after the rewrite - a
 *  shape the rewrite does not know, reported by the build instead of
 *  failing at boot. Pure. */
export function strayImports(text, local) {
  const out = [];
  for (const m of text.matchAll(/import\(\s*"\.\/([^"/\n]+\.mjs)"\s*\)|\bfrom\s+"\.\/([^"/\n]+\.mjs)"|^\s*import\s+"\.\/([^"/\n]+\.mjs)"/gm)) {
    const file = m[1] || m[2] || m[3];
    if (!local.has(file)) out.push(file);
  }
  return out;
}

/** The order the dev modules are imported in at boot: the order the
 *  transpiler's own init.mjs imports them in (it puts classes with a class
 *  constructor last), then any it did not name, sorted. Pure. */
export function bootOrder(initText, mainFiles) {
  const wanted = new Set(mainFiles);
  const order = [];
  for (const m of String(initText || '').matchAll(/^[ \t]*(?:await\s+import\(|import\s+)"\.\/([^"/\n]+\.mjs)"/gm)) {
    if (wanted.has(m[1]) && !order.includes(m[1])) order.push(m[1]);
  }
  for (const f of [...wanted].sort()) if (!order.includes(f)) order.push(f);
  return order;
}

/*
 * The database tables of a sandbox. The transpiler writes a CREATE TABLE
 * per transparent table it was given into its init.mjs
 * (`sqlite.push(\`CREATE TABLE 'name' (...)\`);`) - and that init.mjs is
 * thrown away with the rest of the staging: the package's own boot opens the
 * runtime's SQLite database with the FRAMEWORK's tables only. So the build
 * takes the statements of the sandbox's own tables out of it and
 * apps/init.mjs runs them after the package's boot, before the apps load.
 * The recipe is abap-cloud-gui's (tools/report2cloud/test/runtime/backend.mjs).
 */

/** The SQLite CREATE TABLE statements the transpiler wrote into its
 *  init.mjs for `tables` (lower-case names), in its order. Pure. */
export function tableSchema(initText, tables) {
  const want = new Set(tables.map((t) => String(t).toLowerCase()));
  const out = [];
  for (const m of String(initText || '').matchAll(/^\s*sqlite\.push\(`(CREATE TABLE '([a-z0-9_/]+)'[^`]*)`\);\s*$/gm)) {
    if (want.has(m[2].toLowerCase())) out.push(m[1]);
  }
  return out;
}

/** The transparent tables among the sandbox's TABL objects: the ones whose
 *  abapGit XML says `<TABCLASS>TRANSP</TABCLASS>` - a structure (INTTAB,
 *  APPEND) is a TABL too, and has no table to create. Pure but for the
 *  reads of `inputDir`. */
export function transparentTables(inputDir, objects) {
  const out = [];
  for (const o of objects) {
    const m = /^(.+)\.tabl$/.exec(o);
    if (!m) continue;
    const file = fs.readdirSync(inputDir).find((f) => f.toLowerCase() === `${m[1]}.tabl.xml`);
    let xml = '';
    try {
      xml = file ? fs.readFileSync(path.join(inputDir, file), 'utf8') : '';
    } catch {
      /* unreadable: no table */
    }
    if (/<TABCLASS>\s*TRANSP\s*<\/TABCLASS>/i.test(xml)) out.push(m[1]);
  }
  return out;
}

/** apps/init.mjs: boot the package's runtime, apply its performance fixes
 *  when it offers them, create the sandbox's database tables (`schema`, the
 *  statements tableSchema found - none: nothing is written for them), then
 *  register the dev apps. The generated unit-test runner imports
 *  "./init.mjs", and the host imports this file too - one boot for both.
 *  Pure. */
export function appsInitSource(order, { version = '', schema = [] } = {}) {
  const tables = schema.length ? [
    `// the sandbox's database tables (its TABL objects), in the runtime's database - empty`,
    `// at every boot, as the package's own tables are`,
    `const db = globalThis.abap && globalThis.abap.context && globalThis.abap.context.databaseConnections`,
    `  ? globalThis.abap.context.databaseConnections["DEFAULT"] : undefined;`,
    `if (!db) throw new Error("${RUNTIME_PKG}${version ? ` ${version}` : ''} opened no DEFAULT database connection - the sandbox's tables cannot be created");`,
    `await db.execute(${JSON.stringify(schema.map((q) => q.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')))});`,
    ``,
  ] : [];
  return [
    `// Generated by the abap2UI5 MCP server (lib/npm-backend.mjs) on every build: the boot of the`,
    `// dev apps on ${RUNTIME_PKG}${version ? ` ${version}` : ''}. The unit-test runner beside it (index.mjs) and the`,
    `// server's host (lib/npm-host.mjs) both import it. Do not edit - the next build replaces it.`,
    `import * as runtime from "${RUNTIME_PKG}";`,
    ``,
    `await runtime.initialize();`,
    `// runtime performance fixes, in the releases that export them`,
    `export const accelerated = typeof runtime.accelerate === "function";`,
    `if (accelerated) await runtime.accelerate();`,
    ``,
    ...tables,
    ...order.map((f) => `await import("./${f}");`),
    ``,
    `export const devModules = ${JSON.stringify(order)};`,
    ``,
  ].join('\n');
}

/** The transpiler's config for one build: the sandbox as the input, the
 *  package's downport/ and open-abap-core as libraries (both folders
 *  relative to the runtime directory the transpiler runs in - it joins a
 *  library folder onto its cwd), the framework's own options. Pure. */
export function transpileConfig({ inputDir, outputDir, downportRel, coreRel }) {
  return {
    input_folder: inputDir,
    // the objects a sandbox holds (classes, interfaces, tables, data
    // elements); a stray file (a README, a package.devc.xml) is no input
    input_filter: ['[\\\\/][a-z0-9_]+\\.(clas|intf|tabl|dtel)\\.[a-z_.]*(abap|xml)$'],
    output_folder: outputDir,
    libs: [
      { folder: downportRel, files: '/**/*.*' },
      { folder: coreRel },
    ],
    write_unit_tests: true,
    write_source_map: true,
    options: {
      ignoreSyntaxCheck: false,
      addFilenames: true,
      addCommonJS: true,
      unknownTypes: 'runtimeError',
    },
  };
}

// ------------------------------------------------------ what is installed ----

/** Releases with a complete install in the workspace, newest first. */
export function installedRuntimes() {
  let names = [];
  try {
    names = fs.readdirSync(runtimeBase());
  } catch {
    return [];
  }
  return names
    .filter((v) => VERSION_RE.test(v) && fs.existsSync(path.join(runtimeDir(v), RUNTIME_MARKER)))
    .sort((a, b) => compareVersions(b, a));
}

/** The release in use, synchronously: the pin, else the one the last build
 *  used, else the newest installed; null before anything was installed. */
export function currentRuntimeVersion() {
  const pin = readRuntimePin();
  if (pin.value) return { version: pin.value, source: 'A2UI5_MCP_RUNTIME_VERSION' };
  const cur = readJson(currentFile());
  if (cur && typeof cur.version === 'string' && VERSION_RE.test(cur.version) && fs.existsSync(runtimeDir(cur.version))) {
    return { version: cur.version, source: 'the last build' };
  }
  const newest = installedRuntimes()[0];
  return newest ? { version: newest, source: 'the newest installed' } : null;
}

/** The installed package's package.json, or null. */
export function installedMeta(dir) {
  return readJson(path.join(pkgDir(dir), 'package.json'));
}

/** Is a build of the dev apps there for this runtime directory? */
export function appsBuilt(dir) {
  return Boolean(dir) && fs.existsSync(path.join(appsDir(dir), 'init.mjs'));
}

/** The record the last build wrote into apps/, or null. */
export function buildRecord(dir) {
  return dir ? readJson(path.join(appsDir(dir), BUILD_RECORD)) : null;
}

/** The registry's latest as last asked, `{ version, fetchedAt, meta }`, or null. */
export function cachedLatest() {
  const c = readJson(registryCacheFile());
  return c && typeof c.version === 'string' && VERSION_RE.test(c.version) ? c : null;
}

// ------------------------------------------------------------- the registry ----

/* npm itself answers the registry questions: it knows the user's registry,
 * proxy, CA and auth configuration, which the install that follows uses too
 * - a fetch of registry.npmjs.org would ignore a corporate mirror and then
 * disagree with the install about what exists. On Windows npm is a .cmd
 * script, which spawn only runs through the shell; the arguments are
 * quoted for cmd.exe there (a range carries `^` and `|`). */
export function npmCommand(args, platform = process.platform) {
  if (platform !== 'win32') return { cmd: 'npm', args, shell: false };
  return { cmd: 'npm.cmd', args: args.map((a) => (/[\s^|&<>()"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)), shell: true };
}

function spawnNpm(args, opts) {
  const c = npmCommand(args);
  return spawnWithTimeout(c.cmd, c.args, { ...opts, shell: c.shell });
}

/**
 * `npm view <spec>` for the fields a runtime install needs. Resolves - never
 * rejects - with `{ ok: true, meta }`, `{ ok: false, missing: true }` (the
 * registry has no such version) or `{ ok: false, error }` (it could not be
 * asked). Injectable for the tests (`view` option of the callers).
 */
export async function npmView(spec, { timeoutMs = 60_000, signal } = {}) {
  /* In the workspace, beside the release directories the install runs in:
   * npm reads a project .npmrc from the directory it runs in, and the
   * lookup used to run wherever this server was started - a project's
   * .npmrc there decided which registry was asked, never which one the
   * install then used. Both read the user's npm config (and npm_config_*)
   * now. */
  let cwd;
  try {
    fs.mkdirSync(runtimeBase(), { recursive: true });
    cwd = runtimeBase();
  } catch {
    /* an unwritable workspace: the install fails with its own words */
  }
  const res = await spawnNpm(['view', spec, 'version', 'abap2ui5', 'peerDependencies', 'dependencies', '--json'], { cwd, timeoutMs, signal });
  if (res.aborted) return { ok: false, aborted: true, error: 'cancelled' };
  if (res.timedOut) return { ok: false, error: `npm view ${spec} timed out` };
  let json = null;
  try {
    json = JSON.parse(res.stdout || 'null');
  } catch {
    /* npm printed something that is not JSON */
  }
  /* npm 12 prints `npm view --json` as an array, one element per matching
   * version, also for a spec only one version matches; npm 10 prints the
   * object. */
  if (Array.isArray(json) && json.length === 1) json = json[0];
  if (res.code === 0 && json && typeof json === 'object' && typeof json.version === 'string') return { ok: true, meta: json };
  if (res.code === 0 && typeof json === 'string') return { ok: true, meta: { version: json } };
  const err = json && json.error;
  if (err && (err.code === 'E404' || err.code === 'ETARGET')) return { ok: false, missing: true, error: err.summary || err.code };
  if (res.code === 0 && !json) return { ok: false, missing: true, error: `the registry has no ${spec}` };
  return { ok: false, error: (err && (err.summary || err.code)) || (res.stderr || res.stdout || `npm exited ${res.code}`).trim().split('\n').slice(-3).join(' ') };
}

/**
 * Which release to run, and where the answer came from:
 *   1. A2UI5_MCP_RUNTIME_VERSION (abap2ui5-unit sets it from the project's
 *      pin) - taken as it is;
 *   2. the registry's latest, asked through npm and cached for a day
 *      (A2UI5_MCP_REMOTE_TTL_MS, the mirror's TTL);
 *   3. offline (A2UI5_MCP_OFFLINE, or the registry could not be asked): the
 *      newest release installed, then the stale cached answer.
 * Resolves `{ version, source, meta? }` or `{ error }`; never rejects.
 */
export async function selectRuntimeVersion({ view = npmView, now = Date.now(), signal } = {}) {
  const pin = readRuntimePin();
  if (pin.invalid) return { error: `A2UI5_MCP_RUNTIME_VERSION=${pin.invalid} is not a release version (X.Y.Z)` };
  if (pin.value) return { version: pin.value, source: 'A2UI5_MCP_RUNTIME_VERSION' };
  const cached = cachedLatest();
  const offline = Boolean(process.env.A2UI5_MCP_OFFLINE);
  if (!offline && cached && now - Date.parse(cached.fetchedAt) < remoteTtlMs()) {
    return { version: cached.version, source: `the registry's latest (asked ${cached.fetchedAt})`, meta: cached.meta || null, cached: true };
  }
  let reason = 'A2UI5_MCP_OFFLINE is set';
  if (!offline) {
    const res = await view(`${RUNTIME_PKG}@latest`, { signal });
    if (res.ok && VERSION_RE.test(res.meta.version)) {
      const record = { version: res.meta.version, fetchedAt: new Date(now).toISOString(), meta: res.meta };
      try {
        fs.mkdirSync(runtimeBase(), { recursive: true });
        fs.writeFileSync(registryCacheFile(), JSON.stringify(record, null, 2) + '\n');
      } catch {
        /* the answer stands; the cache is a convenience */
      }
      return { version: record.version, source: 'the registry\'s latest', meta: res.meta };
    }
    if (res.aborted) return { error: 'cancelled', aborted: true };
    reason = `the registry could not be asked: ${res.error || 'no answer'}`;
  }
  const newest = installedRuntimes()[0];
  if (newest) return { version: newest, source: `the newest installed (${reason})` };
  if (cached) return { version: cached.version, source: `the registry's latest as last asked, ${cached.fetchedAt} (${reason})`, meta: cached.meta || null, cached: true };
  return { error: `no ${RUNTIME_PKG} is installed in ${runtimeBase()} and ${reason} - set A2UI5_MCP_RUNTIME_VERSION to a release, or let npm reach the registry` };
}

// -------------------------------------------------------------- the install ----

/* One install per runtime directory at a time, in this process: a lint and a
 * build asking at once are QUEUED on the directory rather than running two
 * npm installs over one node_modules - the second one then finds the
 * directory complete in two file reads, or installs only what the first
 * left out (the lint's abaplint). */
const installing = new Map();

/** The versions a runtime directory has installed, by dependency name. */
function installedVersions(dir, names) {
  const out = {};
  for (const name of names) {
    const meta = readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    if (meta && typeof meta.version === 'string') out[name] = meta.version;
  }
  return out;
}

/** What is still missing in a runtime directory for `desired`, as sentences
 *  (empty when complete). */
export function missingInstall(dir, desired) {
  const have = installedVersions(dir, Object.keys(desired));
  const missing = [];
  for (const [name, want] of Object.entries(desired)) {
    if (!have[name]) missing.push(`${name} is not installed`);
    else if (name !== 'express' && have[name] !== want) missing.push(`${name} is ${have[name]}, ${want} is wanted`);
  }
  if (!missing.length && !fs.existsSync(path.join(pkgDir(dir), 'output', 'init.mjs'))) missing.push(`${RUNTIME_PKG} carries no output/init.mjs`);
  return missing;
}

/**
 * Make sure the runtime directory of `version` has everything installed:
 * the package, express, the transpiler its output needs, and - `withLint` -
 * the lint's abaplint at app-template's pin. npm with --ignore-scripts,
 * exact versions (--save-exact), the lockfile written beside them. A
 * complete directory costs two file reads. Resolves `{ ok, dir, meta,
 * installed?, reason? }`; never rejects. `view` is injectable for the tests.
 */
export function ensureRuntime({ version, meta = null, withLint = true, onLine = () => {}, signal, timeoutMs = 30 * 60_000, view = npmView } = {}) {
  if (!VERSION_RE.test(String(version || ''))) return Promise.resolve({ ok: false, reason: `not a release version: ${version}` });
  const dir = runtimeDir(version);
  const before = installing.get(dir) || Promise.resolve();
  /* Caught here, because the contract above is "never rejects" and the
   * install writes files: a workspace that cannot be written (read-only, a
   * file where a directory belongs, a full disk) threw out of installOnce -
   * the build then ended without a build_log record, the lint of a deploy
   * answered a bare ENOTDIR, and every caller queued behind the failed
   * install was rejected with it too. */
  const run = before.then(() => installOnce({ version, dir, meta, withLint, onLine, signal, timeoutMs, view }))
    .catch((e) => ({ ok: false, dir, reason: `the runtime directory ${dir} could not be prepared: ${(e && e.message) || e}` }));
  installing.set(dir, run);
  const clear = () => {
    if (installing.get(dir) === run) installing.delete(dir);
  };
  run.then(clear, clear);
  return run;
}

async function installOnce({ version, dir, meta, withLint, onLine, signal, timeoutMs, view }) {
  let known = installedMeta(dir) || meta;
  const cli = withLint ? cliVersionOf(templatePinFiles()) : null;
  if (!known || !transpilerOf(known)) {
    const res = await view(`${RUNTIME_PKG}@${version}`, { signal });
    if (!res.ok) {
      if (res.aborted) return { ok: false, dir, aborted: true, reason: 'cancelled' };
      return { ok: false, dir, missing: Boolean(res.missing), reason: res.missing ? `the registry has no ${RUNTIME_PKG}@${version}` : `${RUNTIME_PKG}@${version} could not be looked up: ${res.error}` };
    }
    known = res.meta;
  }
  let desired;
  try {
    desired = desiredDeps({ version, meta: known, cli: cli && cli.version });
  } catch (e) {
    return { ok: false, dir, reason: String(e.message) };
  }
  if (!missingInstall(dir, desired).length && fs.existsSync(path.join(dir, RUNTIME_MARKER))) {
    return { ok: true, dir, meta: installedMeta(dir), installed: false, cli };
  }
  fs.mkdirSync(dir, { recursive: true });
  const pkgFile = path.join(dir, 'package.json');
  const recorded = (readJson(pkgFile) || {}).dependencies || {};
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, JSON.stringify({
      name: 'abap2ui5-mcp-runtime',
      version: '0.0.0',
      private: true,
      description: `The abap2UI5 MCP server's Node backend for abap2UI5 ${version}: ${RUNTIME_PKG} and the tools that build apps for it. Written and installed by the server (lib/npm-backend.mjs); safe to delete, it is installed again when needed.`,
      dependencies: {},
    }, null, 2) + '\n');
  }
  fs.rmSync(path.join(dir, RUNTIME_MARKER), { force: true });
  const specs = installSpecs(desired, recorded);
  onLine(`runtime: npm install ${specs.length ? specs.join(' ') : '(from package-lock.json)'} in ${dir}`);
  const res = await spawnNpm(
    ['install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', '--no-update-notifier', ...specs],
    { cwd: dir, timeoutMs, signal, onLine: (l) => { if (!/^npm (notice|warn)/.test(l)) onLine(`runtime: ${l}`); } },
  );
  if (res.aborted) return { ok: false, dir, aborted: true, reason: 'cancelled' };
  if (res.timedOut) return { ok: false, dir, reason: timedOutError('npm install', 'A2UI5_MCP_BUILD_TIMEOUT_MS') };
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-6).join('\n');
    return { ok: false, dir, missing: /E404|ETARGET|No matching version/.test(tail), reason: `npm install exited ${res.code}: ${tail}` };
  }
  const still = missingInstall(dir, desired);
  if (still.length) return { ok: false, dir, reason: `npm install finished, but ${still.join('; ')}` };
  const installedMetaNow = installedMeta(dir);
  fs.writeFileSync(path.join(dir, RUNTIME_MARKER), JSON.stringify({
    note: 'Written by the abap2UI5 MCP server once this directory\'s npm install was complete. Delete the directory to have it installed again.',
    version,
    installedAt: new Date().toISOString(),
    dependencies: installedVersions(dir, Object.keys(desired)),
    ...(cli ? { abaplintCliSource: cli.source } : {}),
  }, null, 2) + '\n');
  onLine(`runtime: ${RUNTIME_PKG} ${version} installed in ${dir} (${Object.entries(installedVersions(dir, Object.keys(desired))).map(([n, v]) => `${n} ${v}`).join(', ')})`);
  return { ok: true, dir, meta: installedMetaNow, installed: true, cli };
}

/** app-template's package-lock.json and package.json, as text (null when
 *  absent) - the checkout or its mirror. */
function templatePinFiles() {
  const root = resolveAppTemplate();
  const read = (f) => {
    try {
      return root ? fs.readFileSync(path.join(root, f), 'utf8') : null;
    } catch {
      return null;
    }
  };
  return { lockText: read('package-lock.json'), pkgText: read('package.json') };
}

/** The @abaplint/cli the lint installs, and where that version comes from. */
export function lintCliVersion() {
  return cliVersionOf(templatePinFiles());
}

// ------------------------------------------------------------ open-abap-core ----

/**
 * open-abap-core at `sha`, in the workspace: git init, a shallow fetch of
 * exactly that commit, a detached checkout - the three steps the framework's
 * own fetch-deps.mjs takes. Fetched into a temporary directory and renamed
 * into place once HEAD is verified, so a killed fetch never leaves a half
 * checkout under the sha's name. With `sha` null the default branch's HEAD
 * is resolved to one first (and the answer says so). Resolves `{ ok, dir,
 * sha, source?, reason? }`; never rejects.
 */
export async function ensureOpenAbapCore({ sha, source = 'package', onLine = () => {}, signal, timeoutMs = 10 * 60_000 } = {}) {
  let want = sha;
  let from = source;
  if (!want) {
    const ls = await spawnWithTimeout('git', ['ls-remote', OPEN_ABAP_CORE_URL, 'HEAD'], { timeoutMs, signal });
    const head = /^([0-9a-f]{40})\s+HEAD/m.exec(ls.stdout || '');
    if (!head) return { ok: false, reason: `the release records no open-abap-core commit and ${OPEN_ABAP_CORE_URL}'s HEAD could not be read (git exited ${ls.code})` };
    want = head[1];
    from = 'floating HEAD (the release records no commit)';
    onLine(`open-abap-core: the release records no commit - type-checking against HEAD ${want.slice(0, 12)}`);
  }
  if (!SHA_RE.test(want)) return { ok: false, reason: `not a commit: ${want}` };
  const dir = openAbapCoreDir(want);
  if (fs.existsSync(path.join(dir, '.abap2ui5-mcp-sha')) && fs.existsSync(path.join(dir, 'src'))) {
    return { ok: true, dir, sha: want, source: from, fetched: false };
  }
  const tmp = path.join(path.dirname(dir), `.tmp-${want.slice(0, 12)}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  onLine(`open-abap-core: git fetch --depth 1 ${OPEN_ABAP_CORE_URL} ${want}`);
  try {
    for (const args of [['init', '--quiet'], ['fetch', '--quiet', '--depth', '1', OPEN_ABAP_CORE_URL, want], ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], ['rev-parse', 'HEAD']]) {
      const res = await spawnWithTimeout('git', args, { cwd: tmp, timeoutMs, signal });
      if (res.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
      if (res.code !== 0) return { ok: false, reason: `git ${args[0]} exited ${res.code}: ${(res.stderr || '').trim().split('\n').slice(-2).join(' ')}` };
      if (args[0] === 'rev-parse' && res.stdout.trim() !== want) return { ok: false, reason: `checked out ${res.stdout.trim()}, ${want} was asked for` };
    }
    fs.writeFileSync(path.join(tmp, '.abap2ui5-mcp-sha'), want + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    onLine(`open-abap-core: ${want.slice(0, 12)} is at ${dir}`);
    return { ok: true, dir, sha: want, source: from, fetched: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ leftovers ----

/* The build, the open-abap-core fetch and an abap2ui5-unit run each work in a
 * temporary directory and remove it in a finally - which a process killed
 * hard never reaches: a client that closes the session mid-build (the
 * server's shutdown kills the transpiler and exits), a SIGKILL, Ctrl+C at a
 * unit run. Each left its directory for good, a build's staging up to 22 MB
 * of transpiler output. So every such directory carries its creator's pid,
 * and the next build removes the ones whose process is gone. */
const LEFTOVER_RUNTIME = /^(?:\.staging|\.apps|\.apps-old|apps-unit)-(\d+)-/;
const LEFTOVER_WORKSPACE = /^unit-(\d+)-/;
const LEFTOVER_CORE = /^\.tmp-[0-9a-f]{12}-(\d+)-/;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // somebody else's process: alive
  }
}

/** Remove the entries of `dir` whose name `re` matches, its first group the
 *  pid of a process that is gone - and older than `graceMs`, so the live
 *  build of a process in another PID namespace (a container sharing the
 *  workspace) is not taken for a dead one - or older than `maxAgeMs` whatever
 *  the pid says (a pid is reused). Resolves the names removed. */
export function sweepLeftovers(dir, re, { graceMs = 10 * 60_000, maxAgeMs = 24 * 60 * 60_000, now = Date.now(), alive = pidAlive } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m || Number(m[1]) === process.pid) continue;
    let age;
    try {
      age = now - fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if ((age > graceMs && !alive(Number(m[1]))) || age > maxAgeMs) {
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed.push(name);
      } catch {
        /* the next build tries again */
      }
    }
  }
  return removed;
}

// --------------------------------------------------------------- the build ----

/**
 * Transpile the sandbox's objects against the package and assemble apps/
 * (see the header). Resolves `{ ok, objects, modules, tests?, reason? }`;
 * never rejects. The transpiler's own output is streamed through onLine.
 *
 * `target` is the directory the build is swapped into - apps/ for the
 * server's own dev apps; abap2ui5-unit builds a project's classes into a
 * directory of its own beside it (it has to be inside the runtime directory:
 * the modules find the package through its node_modules).
 */
export async function buildApps({ dir, version, inputDir, coreDir, target = appsDir(dir), onLine = () => {}, signal, timeoutMs = 30 * 60_000 } = {}) {
  const transpiler = localBin(dir, '@abaplint/transpiler-cli', 'abap_transpile');
  if (!transpiler) return { ok: false, reason: missingBinMessage(dir, '@abaplint/transpiler-cli', 'abap_transpile', ' (build_backend installs it)') };
  const swept = [
    ...sweepLeftovers(dir, LEFTOVER_RUNTIME),
    ...sweepLeftovers(workspaceRoot(), LEFTOVER_WORKSPACE),
    ...sweepLeftovers(path.join(workspaceRoot(), 'open-abap-core'), LEFTOVER_CORE),
  ];
  if (swept.length) onLine(`transpile: removed ${swept.length} leftover(s) of killed builds, fetches or unit runs (${swept.join(', ')})`);
  fs.mkdirSync(inputDir, { recursive: true });
  const objects = devObjects(fs.readdirSync(inputDir));
  const staging = fs.mkdtempSync(path.join(dir, `.staging-${process.pid}-`));
  let fresh = null;
  try {
    const config = transpileConfig({
      inputDir,
      outputDir: staging,
      downportRel: path.relative(dir, downportDir(dir)).split(path.sep).join('/'),
      coreRel: path.relative(dir, coreDir).split(path.sep).join('/'),
    });
    const configFile = path.join(staging, 'abap_transpile.json');
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    onLine(`transpile: ${objects.length} dev object(s) in ${inputDir}, against ${RUNTIME_PKG} ${version} and open-abap-core`);
    const res = await spawnWithTimeout(process.execPath, [transpiler, configFile], {
      cwd: dir, timeoutMs, signal, onLine: (l) => { if (!/^\s*\d+% - /.test(l)) onLine(l); },
    });
    if (res.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    if (res.timedOut) return { ok: false, timedOut: true, reason: timedOutError('the transpile', 'A2UI5_MCP_BUILD_TIMEOUT_MS') };
    if (res.code !== 0) {
      const why = (res.stdout + '\n' + res.stderr).split('\n').filter((l) => /^Error|error/i.test(l)).slice(0, 5).join('\n');
      return { ok: false, reason: `the transpiler exited ${res.code}${why ? `:\n${why}` : ''}` };
    }
    const produced = fs.readdirSync(staging);
    const own = devOutputFiles(produced, objects);
    const local = new Set(own);
    const runner = fs.existsSync(path.join(staging, 'index.mjs')) ? fs.readFileSync(path.join(staging, 'index.mjs'), 'utf8') : null;
    if (!runner || !runner.includes('"./init.mjs"')) {
      return { ok: false, reason: 'the transpiler wrote no unit-test runner importing "./init.mjs" (index.mjs) - its output shape changed; run_unit_tests cannot run the dev apps\' tests on it' };
    }
    fresh = fs.mkdtempSync(path.join(dir, `.apps-${process.pid}-`));
    const stray = [];
    for (const f of own) {
      let text = fs.readFileSync(path.join(staging, f), 'utf8');
      if (f.endsWith('.mjs')) {
        text = rewriteImports(text, local);
        for (const s of strayImports(text, local)) stray.push(`${f} -> ${s}`);
      }
      fs.writeFileSync(path.join(fresh, f), text);
    }
    if (stray.length) {
      return { ok: false, reason: `an import the build does not know how to point at the package: ${stray.slice(0, 5).join(', ')} - the transpiler's output shape changed` };
    }
    const initText = fs.existsSync(path.join(staging, 'init.mjs')) ? fs.readFileSync(path.join(staging, 'init.mjs'), 'utf8') : '';
    const modules = bootOrder(initText, objects.map((o) => `${o}.mjs`).filter((f) => local.has(f)));
    const tables = transparentTables(inputDir, objects);
    const schema = tableSchema(initText, tables);
    if (schema.length !== tables.length) {
      const found = new Set(schema.map((q) => /^CREATE TABLE '([^']+)'/.exec(q)[1].toLowerCase()));
      return { ok: false, reason: `the transpiler wrote no CREATE TABLE for ${tables.filter((t) => !found.has(t)).join(', ')} into its init.mjs - its output shape changed; the sandbox's tables cannot be created` };
    }
    const tests = [...runner.matchAll(/objectName:\s*"([^"]+)"/g)].map((m) => m[1]);
    fs.writeFileSync(path.join(fresh, 'index.mjs'), runner);
    fs.writeFileSync(path.join(fresh, 'init.mjs'), appsInitSource(modules, { version, schema }));
    fs.writeFileSync(path.join(fresh, BUILD_RECORD), JSON.stringify({
      note: 'The dev apps the abap2UI5 MCP server transpiled for this runtime - rebuilt whole by every build_backend.',
      runtime: version,
      builtAt: new Date().toISOString(),
      input: inputDir,
      objects,
      modules,
      tables,
      testObjects: [...new Set(tests)],
      transpiledObjects: produced.filter((f) => f.endsWith('.mjs') && !f.endsWith('.map')).length,
    }, null, 2) + '\n');
    // the swap: the old apps/ out, the new one in, nothing half-written in between
    const apps = target;
    const old = path.join(dir, `.apps-old-${process.pid}-${Date.now()}`);
    if (fs.existsSync(apps)) fs.renameSync(apps, old);
    fs.renameSync(fresh, apps);
    fresh = null;
    fs.rmSync(old, { recursive: true, force: true });
    onLine(`transpile: ${path.basename(apps)}/ holds ${modules.length} dev module(s)${tests.length ? ` and the tests of ${[...new Set(tests)].join(', ')}` : ''}${tables.length ? `, and creates the table(s) ${tables.join(', ')} at boot` : ''} - the framework itself stays the package's (${produced.length} files of transpiler output left out)`);
    return { ok: true, objects, modules, tables, tests: [...new Set(tests)] };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (fresh) fs.rmSync(fresh, { recursive: true, force: true });
  }
}

/**
 * The whole npm build: which release, its install, open-abap-core at the
 * release's commit, the transpile of `inputDir` (the sandbox). Narrated
 * through onLine; resolves `{ ok, version, dir, ... , reason? }` and never
 * rejects. `withLint` also installs the lint's abaplint (the MCP tools lint
 * every deploy; abap2ui5-unit does not lint and leaves it out).
 */
/**
 * The release to run, installed: selectRuntimeVersion + ensureRuntime, the
 * first half of a build and all the lint needs (its abaplint and the
 * package's downport/ as the framework dependency). Resolves `{ ok,
 * version, source, dir, meta, missing?, aborted?, reason? }`; never rejects.
 */
export async function prepareRuntime({ withLint = true, onLine = () => {}, signal, timeoutMs = 30 * 60_000, view = npmView } = {}) {
  let pick = await selectRuntimeVersion({ view, signal });
  if (pick.error) return { ok: false, aborted: Boolean(pick.aborted), reason: pick.error };
  onLine(`runtime: ${RUNTIME_PKG} ${pick.version} (${pick.source})`);
  let rt = await ensureRuntime({ version: pick.version, meta: pick.meta, withLint, onLine, signal, timeoutMs, view });
  /* A cached answer the registry no longer stands by - the release was
   * unpublished, or npm points at another registry since - is asked again,
   * once: it used to fail every lint and build until the cache expired, a
   * day, with the registry's actual latest one question away. */
  if (!rt.ok && rt.missing && pick.cached) {
    onLine(`runtime: ${RUNTIME_PKG} ${pick.version}, the registry's latest as last asked, cannot be installed - asking the registry again`);
    try {
      fs.rmSync(registryCacheFile(), { force: true });
    } catch {
      /* then the answer below replaces it, or nothing does */
    }
    const again = await selectRuntimeVersion({ view, signal });
    if (!again.error && again.version !== pick.version) {
      pick = again;
      onLine(`runtime: ${RUNTIME_PKG} ${pick.version} (${pick.source})`);
      rt = await ensureRuntime({ version: pick.version, meta: pick.meta, withLint, onLine, signal, timeoutMs, view });
    }
  }
  return { ...rt, version: pick.version, source: pick.source };
}

/* `appsName` is the directory inside the runtime directory the build lands
 * in: apps/ for the server's dev apps (and then the build is recorded as the
 * release in use, runtime/current.json); abap2ui5-unit passes a directory of
 * its own and nothing is recorded - a project's unit run must neither replace
 * the apps an MCP session serves nor switch the release its backend runs. */
export async function buildNpm({ inputDir, appsName = APPS_DIR, withLint = true, onLine = () => {}, signal, timeoutMs = 30 * 60_000, view = npmView } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(appsName))) return { ok: false, reason: `not a directory name: ${appsName}` };
  const rt = await prepareRuntime({ withLint, onLine, signal, timeoutMs, view });
  if (!rt.ok) return { ok: false, version: rt.version, dir: rt.dir, aborted: Boolean(rt.aborted), missing: Boolean(rt.missing), reason: rt.reason };
  const core = openAbapCoreOf(rt.meta, rt.version);
  const lib = await ensureOpenAbapCore({ sha: core.sha, source: core.source, onLine, signal, timeoutMs });
  if (!lib.ok) return { ok: false, version: rt.version, dir: rt.dir, aborted: Boolean(lib.aborted), reason: `open-abap-core: ${lib.reason}` };
  const target = path.join(rt.dir, appsName);
  const built = await buildApps({ dir: rt.dir, version: rt.version, inputDir, coreDir: lib.dir, target, onLine, signal, timeoutMs });
  if (!built.ok) return { ok: false, version: rt.version, dir: rt.dir, aborted: Boolean(built.aborted), timedOut: Boolean(built.timedOut), reason: built.reason };
  if (appsName === APPS_DIR) {
    try {
      fs.writeFileSync(currentFile(), JSON.stringify({ version: rt.version, builtAt: new Date().toISOString() }, null, 2) + '\n');
    } catch {
      /* the build stands; the next status read falls back to the newest installed */
    }
  }
  return { ok: true, version: rt.version, dir: rt.dir, apps: target, openAbapCore: lib.sha, ...built };
}

// ----------------------------------------------------------------- status ----

/**
 * The npm backend as setup_status reports it, synchronously - no registry,
 * no npm, no git: which release is in use (and why), where it is, whether it
 * is installed and with which tools, which open-abap-core commit it
 * type-checks against, what the last build left in apps/, and what the next
 * build_backend would have to do.
 */
export function npmStatus({ sandboxDir = npmSandboxDir() } = {}) {
  const pin = readRuntimePin();
  const cur = currentRuntimeVersion();
  const latest = cachedLatest();
  const version = cur ? cur.version : (latest ? latest.version : null);
  const dir = version ? runtimeDir(version) : null;
  const marker = dir ? readJson(path.join(dir, RUNTIME_MARKER)) : null;
  const meta = dir ? installedMeta(dir) : null;
  const deps = (marker && marker.dependencies) || {};
  const core = openAbapCoreOf(meta || (latest && latest.version === version ? latest.meta : null), version);
  const coreFetched = Boolean(core.sha && fs.existsSync(path.join(openAbapCoreDir(core.sha), '.abap2ui5-mcp-sha')));
  const cli = lintCliVersion();
  const record = buildRecord(dir);
  let objects = [];
  try {
    objects = devObjects(fs.readdirSync(sandboxDir));
  } catch {
    /* no sandbox yet */
  }
  const transpiler = deps['@abaplint/transpiler-cli'] || (transpilerOf(meta) || {}).version || null;
  const steps = [];
  if (!version) {
    steps.push(`ask the registry for ${RUNTIME_PKG}'s latest release (the answer is cached for a day), install it with its transpiler, express and the lint's abaplint into ${runtimeBase()}${path.sep}<version> (npm --ignore-scripts, exact versions, a lockfile)`);
  } else if (!marker) {
    steps.push(`install ${RUNTIME_PKG}@${version} with its transpiler, express and the lint's abaplint into ${dir} (npm --ignore-scripts, exact versions, a lockfile)`);
  } else {
    // build_backend installs the lint's abaplint with the release (abap2ui5-unit's install leaves it out)
    const haveCli = deps['@abaplint/cli'];
    if (haveCli !== cli.version) {
      steps.push(`install the lint's @abaplint/cli ${cli.version} into ${dir} (${haveCli ? `${haveCli} is installed, ${cli.source} names ${cli.version}` : 'the release was installed without it, as abap2ui5-unit installs it'})`);
    }
    if (!pin.value && (!latest || Date.now() - Date.parse(latest.fetchedAt) >= remoteTtlMs())) {
      steps.push('ask the registry whether a newer release than this one exists (at most once a day)');
    }
  }
  if (!coreFetched) steps.push(core.sha ? `fetch open-abap-core ${core.sha.slice(0, 12)} with git` : 'fetch open-abap-core at the commit the release records (HEAD when it records none) with git');
  steps.push(`transpile the ${objects.length} dev object(s) in ${sandboxDir} into apps/ (seconds - the framework itself comes transpiled in the package)`);
  return {
    package: RUNTIME_PKG,
    version,
    versionSource: cur ? cur.source : (latest ? `the registry's latest as last asked, ${latest.fetchedAt}` : 'not decided yet: the next build asks the registry'),
    ...(pin.invalid ? { pinProblem: `A2UI5_MCP_RUNTIME_VERSION=${pin.invalid} is not a release version (X.Y.Z)` } : {}),
    ...(latest ? { registryLatest: { version: latest.version, askedAt: latest.fetchedAt } } : {}),
    installedReleases: installedRuntimes(),
    workspace: workspaceRoot(),
    dir,
    installed: Boolean(marker),
    ...(marker ? { installedAt: marker.installedAt } : {}),
    transpiler,
    express: deps.express || null,
    abaplintCli: { version: deps['@abaplint/cli'] || cli.version, source: deps['@abaplint/cli'] ? 'installed' : cli.source },
    openAbapCore: { sha: core.sha, source: core.source, fetched: coreFetched },
    sandbox: sandboxDir,
    apps: record ? { builtAt: record.builtAt, modules: record.modules, testObjects: record.testObjects } : null,
    nextBuild: steps,
  };
}

/** Test hook: forget the in-flight installs. */
export function resetNpmBackend() {
  installing.clear();
}

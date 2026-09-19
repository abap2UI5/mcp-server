/*
 * runtime — the deploy/run half of the MCP loop, no SAP system needed.
 *
 * Wraps the repo's existing Node pipeline (the same one e2e-build/e2e-smoke
 * use): an app class is written into src/zz_dev/ (gitignored dev sandbox),
 * the transpiled backend is rebuilt (scripts/e2e-build.mjs), the framework's
 * express shim serves it on localhost, and Playwright boots the app via
 * ?app_start=<class> exactly like scripts/e2e-smoke.mjs does — collecting
 * real page errors and returning a screenshot.
 *
 * Nothing here re-invents the pipeline: build = e2e-build, serve = the
 * abap2UI5 express shim, boot/error rules = the e2e-smoke gate (UI5 booted,
 * >3 rendered controls, no non-benign page error, no backend HTTP >= 400).
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawn, execFileSync } from 'child_process';
import { resolveA2UI5, resolveSamplesControls, resolveAppTemplate, resolveViewCheck, workspaceRoot, explicitEnv, RESOLVERS, REPO_DIRS } from './repos.mjs';
import { fileKeyed } from './cache.mjs';
import { isRemoteCheckout, readMarker, remoteEnabled, remoteBase, REMOTE_FILES } from './remote.mjs';
import { parseActions, cssAttr } from './interact.mjs';

// the deploy sandbox and build pipeline live in the samples-controls checkout
function corpus() {
  const d = resolveSamplesControls({ local: true });
  if (!d) throw new Error('samples-controls checkout not found — set SAMPLES_CONTROLS_HOME or clone it as a sibling');
  return d;
}

/* The framework checkout the backend is built in and served from — a LOCAL
 * one. The read-only GitHub mirror (lib/remote.mjs) serves the guide and the
 * interface; it has no node/ tree and nothing may be built inside a cache
 * directory, so every backend path resolves with `local: true`. */
function a2Local() {
  return resolveA2UI5({ local: true });
}

// --------------------------------------------------------- child processes ----

/* Every spawned batch child gets a hard timeout, so a hung transpile or a
 * stalled npx resolves the MCP call with a clear error instead of hanging it
 * forever. Defaults are generous per task (a full build takes tens of
 * minutes, lint/scope take seconds) and overridable via env vars, values in
 * milliseconds. */
const TIMEOUT_DEFAULTS = {
  A2UI5_MCP_LINT_TIMEOUT_MS: 5 * 60_000,
  A2UI5_MCP_SCOPE_TIMEOUT_MS: 5 * 60_000,
  A2UI5_MCP_BUILD_TIMEOUT_MS: 30 * 60_000,
  A2UI5_MCP_UNIT_TIMEOUT_MS: 10 * 60_000,
};

export function timeoutOf(envVar) {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : TIMEOUT_DEFAULTS[envVar];
}

// kill the child's whole process group (POSIX: the child was spawned detached,
// i.e. as a group leader), so grandchildren — npx wrapping abaplint, a build
// script spawning git — die with it
function killTree(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/* Spawn a child, collect its output (capped, only tails are ever reported),
 * and kill its process tree when it exceeds timeoutMs. Resolves — never
 * rejects — with { code, stdout, stderr, timedOut, aborted }; onLine sees
 * every non-empty line of both streams as it arrives.
 *
 * `signal` is the MCP request's AbortSignal: when the client cancels the
 * call, the whole process tree dies at once — a cancelled build_backend must
 * not keep transpiling for twenty more minutes under a request nobody is
 * waiting for. An abort resolves with { aborted: true } so each caller can
 * say in its own words that the CLIENT stopped it, not a timeout. */
export function spawnWithTimeout(cmd, args, { cwd, env, timeoutMs, onLine, signal } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ code: null, stdout: '', stderr: 'cancelled before start', timedOut: false, aborted: true });
      return;
    }
    const child = spawn(cmd, args, { cwd, env, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const keep = (which) => (d) => {
      const s = String(d);
      if (which === 'out') stdout = (stdout + s).slice(-262144);
      else stderr = (stderr + s).slice(-262144);
      if (onLine) s.split('\n').filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', keep('out'));
    child.stderr.on('data', keep('err'));
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      timer.unref();
    }
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };
    child.on('error', (e) => {
      // spawn failure (command not found) — surface it like output
      stderr += String((e && e.message) || e);
      done(null);
    });
    child.on('close', done);
  });
}

const timedOutError = (what, envVar) =>
  `${what} timed out after ${timeoutOf(envVar)}ms and its process tree was killed — raise ${envVar} if it was legitimately still working`;

// --------------------------------------------------------------- sandbox ----

/*
 * Where a deployed dev app lives, and what lints it. Two homes, in this order:
 *
 *   corpus     `<samples-controls>/src/zz_dev` - the sandbox this server was
 *              built around, linted with the corpus' own abaplint.jsonc
 *              relaxed to the customer namespace (devLintConfig).
 *   framework  `<abap2UI5>/node/zz_dev` - when there is no corpus checkout.
 *              The framework gitignores the directory; the incremental build
 *              copies from it exactly as from the corpus sandbox; the lint is
 *              the one a real project runs, app-template's abaplint.jsonc,
 *              with the framework sources next door as the dependency
 *              instead of a clone.
 *
 * The second home is what makes the whole expensive half work with ONE
 * checkout: the prebuilt backend needs only the framework, and until now the
 * deploy that feeds it needed the corpus. Both homes answer the same shape,
 * so nothing above this line asks which one it got.
 */
export const FRAMEWORK_SANDBOX = ['node', 'zz_dev'];

export function sandbox() {
  const c = resolveSamplesControls({ local: true });
  if (c) return { kind: 'corpus', root: c, dir: path.join(c, 'src', 'zz_dev') };
  const a2 = a2Local();
  if (a2) return { kind: 'framework', root: a2, dir: path.join(a2, ...FRAMEWORK_SANDBOX) };
  throw new Error('no dev sandbox: neither a samples-controls checkout (SAMPLES_CONTROLS_HOME, or a sibling of mcp-server) '
    + 'nor an abap2UI5 checkout (A2UI5_HOME, a sibling, or the one build_backend mode prebuilt clones) is there to deploy into');
}

const devDir = () => sandbox().dir;

/* Where run_app's screenshots land. NOT in the install directory any more:
 * SERVER_ROOT is inside node_modules for the npx/npm install the README leads
 * with, so every boot wrote PNGs into a package directory that the next
 * `npm install` may replace wholesale - and nothing said where they had gone.
 * A per-user directory under the OS temp dir is the default; the env var is
 * for anyone who wants to keep them. Resolved per call, so setting the
 * variable does not need a restart. */
const shotDir = () =>
  process.env.A2UI5_MCP_SCREENSHOT_DIR || path.join(os.tmpdir(), 'abap2ui5-mcp-screenshots');
export const PORT = Number(process.env.A2UI5_MCP_PORT || 3000);

// ---------------------------------------------------------------- deploy ----

/*
 * What a deployable app class may be called: a plain ABAP class name in the
 * CUSTOMER namespace, at most the 30 characters ABAP allows.
 *
 * It used to be `^z2ui5_cl_[a-z0-9_]+$`, which is the naming convention of the
 * demo-kit PORTS - and this server exists for an agent building its OWN app.
 * The ecosystem's own starting point, abap2UI5/app-template, ships
 * `zcl_app_001`; every tool here refused it, so an agent that followed the
 * recommended path could not deploy, build or look at the thing it had just
 * been told to write. `z`/`y` is the real rule (SAP reserves everything else),
 * and it is what the repo's abaplint config is relaxed to in devLintConfig( ).
 *
 * The safety property the regex carries is unchanged and is the reason it is a
 * whitelist rather than a blacklist: every caller-supplied name becomes a PATH
 * under the dev sandbox, and this is validated BEFORE it is joined. The
 * character class admits no `/`, `\`, `.`, null byte or space, so
 * `../../src/01/z2ui5_cl_x` is rejected as a name rather than escaping
 * src/zz_dev as a path. Shared by deploy and remove - the write path and the
 * delete path must not disagree about what a legal name is.
 */
const CLASS_RE = /^[zy][a-z0-9_]*$/;
const CLASS_MAX = 30;

function classNameOf(className) {
  const cls = String(className || '').toLowerCase();
  if (!CLASS_RE.test(cls) || cls.length > CLASS_MAX) {
    throw new Error(
      `invalid class name '${className}' — must be a plain ABAP class name in the customer namespace: `
      + `${CLASS_RE} (letters, digits and underscores only, starting z or y) and <= ${CLASS_MAX} chars. `
      + 'e.g. zcl_my_app, z2ui5_cl_my_app',
    );
  }
  return cls;
}

export function deployApp({ className, source, description, testclasses }) {
  const cls = classNameOf(className);
  if (!/z2ui5_if_app/i.test(source)) {
    throw new Error('source does not implement z2ui5_if_app — an abap2UI5 app is a class with `INTERFACES z2ui5_if_app.`');
  }
  if (!new RegExp(`class\\s+${cls}\\s+definition`, 'i').test(source)) {
    throw new Error(`source does not define CLASS ${cls} DEFINITION — class name and file must match`);
  }
  /* The local test classes, optional: the `.clas.testclasses.abap` include
   * abapGit keeps beside the class. Judged the way the class is - it has to
   * contain a test class - so a pasted main source does not land in the
   * include and fail three steps later inside the transpile. */
  const withTests = typeof testclasses === 'string' && testclasses.trim().length > 0;
  if (testclasses !== undefined && testclasses !== null && typeof testclasses !== 'string') {
    throw new Error('testclasses must be a string: the source of the local test classes (`CLASS ltcl_... FOR TESTING`)');
  }
  if (withTests && !/for\s+testing/i.test(testclasses)) {
    throw new Error('testclasses does not define a test class — it needs `CLASS ... DEFINITION ... FOR TESTING` (see app_guide, chapter 9)');
  }
  fs.mkdirSync(devDir(), { recursive: true });
  const abapPath = path.join(devDir(), `${cls}.clas.abap`);
  fs.writeFileSync(abapPath, source.endsWith('\n') ? source : source + '\n');
  const testPath = path.join(devDir(), `${cls}.clas.testclasses.abap`);
  if (withTests) fs.writeFileSync(testPath, testclasses.endsWith('\n') ? testclasses : testclasses + '\n');
  else fs.rmSync(testPath, { force: true }); // a redeploy without tests must not keep stale ones
  const desc = String(description || 'MCP dev app').slice(0, 60).replace(/[<>&]/g, ' ');
  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">`,
    ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">`,
    `  <asx:values>`,
    `   <VSEOCLASS>`,
    `    <CLSNAME>${cls.toUpperCase()}</CLSNAME>`,
    `    <LANGU>E</LANGU>`,
    `    <DESCRIPT>${desc}</DESCRIPT>`,
    `    <STATE>1</STATE>`,
    `    <CLSCCINCL>X</CLSCCINCL>`,
    `    <FIXPT>X</FIXPT>`,
    `    <UNICODE>X</UNICODE>`,
    // what abapGit writes for a class that carries local test classes
    ...(withTests ? [`    <WITH_UNIT_TESTS>X</WITH_UNIT_TESTS>`] : []),
    `   </VSEOCLASS>`,
    `  </asx:values>`,
    ` </asx:abap>`,
    `</abapGit>`,
    ``,
  ].join('\n');
  // abapGit serializes its XML with a UTF-8 byte order mark, app-template's
  // abaplint.jsonc enables xml_bom, and the sidecar this writes used to have
  // none - the first deploy into the framework sandbox failed its own lint on
  // exactly that (the corpus config never asked)
  fs.writeFileSync(path.join(devDir(), `${cls}.clas.xml`), '\uFEFF' + xml);
  return { abapPath, class: cls, testclassesPath: withTests ? testPath : null };
}

export function removeApp(className) {
  const cls = classNameOf(className);
  let removed = 0;
  for (const suffix of ['.clas.abap', '.clas.xml', '.clas.testclasses.abap']) {
    const p = path.join(devDir(), cls + suffix);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed++;
    }
  }
  return removed;
}

/*
 * The on-disk source of a deployed dev app, plus staleness against the built
 * backend: run_app boots what the last BUILD saw, so a file newer than
 * node/output/init.mjs is a deploy the served backend does not carry yet -
 * exactly the confusion ("I fixed that line, why does the app still crash?")
 * this report exists to end. Same name gate as deploy and remove: the name is
 * validated before it becomes a path, and never steps outside src/zz_dev.
 */
export function readAppSource(className) {
  const cls = classNameOf(className);
  const file = path.join(devDir(), `${cls}.clas.abap`);
  if (!fs.existsSync(file)) return { found: false, class: cls, file };
  const st = fs.statSync(file);
  const a2 = a2Local();
  const builtFile = a2 && path.join(a2, 'node', 'output', 'init.mjs');
  const builtSt = builtFile && fs.existsSync(builtFile) ? fs.statSync(builtFile) : null;
  return {
    found: true,
    class: cls,
    file,
    source: fs.readFileSync(file, 'utf8'),
    deployedAt: st.mtime.toISOString(),
    // null when there is no built backend to compare against - unknown, not fresh
    backendBuiltAt: builtSt ? builtSt.mtime.toISOString() : null,
    staleInBackend: builtSt ? st.mtimeMs > builtSt.mtimeMs : null,
    // the local test classes deployed beside it, if any (run_unit_tests runs them)
    testclasses: fs.existsSync(path.join(devDir(), `${cls}.clas.testclasses.abap`)),
  };
}

export function listDevApps() {
  if (!fs.existsSync(devDir())) return [];
  return fs
    .readdirSync(devDir())
    .filter((f) => f.endsWith('.clas.abap') && !f.endsWith('.clas.testclasses.abap'))
    .map((f) => f.replace('.clas.abap', ''));
}

// ------------------------------------------------------------------ lint ----

// strip // and /* */ comments outside strings so the repo's abaplint.jsonc
// can be parsed and patched (a naive regex would eat the // in dependency URLs)
export function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  /* Where the STRUCTURAL commas landed in `out`. Trailing-comma removal has to
   * know which commas are punctuation and which are text: a regex over the
   * finished output cannot tell them apart, and an abaplint exclude pattern
   * like `app[,]x` would come out as `app[]x` - a character class matching
   * nothing, so the exclusion silently stops excluding. */
  const commas = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
    } else if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
    } else if (inStr) {
      out += c;
      if (c === '\\') {
        out += n;
        i++;
      } else if (c === '"') {
        inStr = false;
      }
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      inLine = true;
    } else if (c === '/' && n === '*') {
      inBlock = true;
      i++;
    } else {
      if (c === ',') commas.push(out.length);
      out += c;
    }
  }
  // comments are gone from `out` by now, so "trailing" is decided by the next
  // non-whitespace character alone
  const drop = new Set();
  for (const at of commas) {
    let j = at + 1;
    while (j < out.length && /\s/.test(out[j])) j++;
    if (out[j] === '}' || out[j] === ']') drop.add(at);
  }
  if (!drop.size) return out;
  // split('') and not [...out]: the offsets in `drop` come from out.length,
  // which counts UTF-16 code units, while the spread iterates code POINTS.
  // One astral character anywhere before a trailing comma - an emoji in a
  // description is enough - shifts every later index by one and deletes the
  // wrong character, turning a valid config into unparseable JSON.
  return out.split('').filter((_, i) => !drop.has(i)).join('');
}

/* The repo config, relaxed for the dev sandbox: zz_dev is not excluded and
 * object_naming accepts any customer-namespace name.
 *
 * The corpus config demands the Z2UI5_CL_SMPC_ port prefix, which a user's app
 * must not be forced into; this used to relax it only as far as Z2UI5_CL_,
 * which was the same mistake one layer down - it made `zcl_app_001`, the name
 * app-template ships, a lint failure on a class this server had just accepted.
 * `^[ZY]` is the customer namespace and the same boundary classNameOf( )
 * enforces, so the two cannot disagree about what a legal app is. */
function devLintConfig() {
  const box = sandbox();
  const cfg = box.kind === 'corpus'
    ? corpusLintConfig(fs.readFileSync(path.join(box.root, 'abaplint.jsonc'), 'utf8'))
    : frameworkLintConfig(templateLintConfigText());
  // must sit in the repo root — the config's files glob resolves relative to
  // the config file's directory
  const p = path.join(box.root, ".abaplint-mcp-dev.jsonc");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/** The corpus' own config, relaxed to the customer namespace. Pure. */
export function corpusLintConfig(text) {
  const cfg = JSON.parse(stripJsonc(text));
  if (cfg.global && Array.isArray(cfg.global.exclude)) {
    cfg.global.exclude = cfg.global.exclude.filter((e) => e !== 'zz_dev');
  }
  if (cfg.rules && cfg.rules.object_naming) {
    cfg.rules.object_naming.clas = '^[ZY]';
    cfg.rules.object_naming.intf = '^[ZY]';
  }
  return cfg;
}

/* app-template's abaplint.jsonc, the lint a real project runs: read from the
 * template checkout, or from its GitHub mirror when there is none (the
 * server hydrates the template before deploy_app for exactly this read). A
 * missing template is a missing lint, and the deploy says so rather than
 * inventing a rule set here. */
function templateLintConfigText() {
  const root = resolveAppTemplate();
  const file = root && path.join(root, 'abaplint.jsonc');
  if (!file || !fs.existsSync(file)) {
    throw new Error('the framework sandbox lints with app-template\'s abaplint.jsonc, and no app-template checkout or mirror is there — '
      + 'clone https://github.com/abap2UI5/app-template as a sibling of mcp-server or point APP_TEMPLATE_HOME at one (or let the GitHub mirror fetch it: unset A2UI5_MCP_OFFLINE)');
  }
  return fs.readFileSync(file, 'utf8');
}

/** The template's config retargeted at the framework sandbox: the dev apps
 *  are the files, the framework sources next door are the dependency
 *  (instead of the clone the template's config asks abaplint for), the
 *  customer namespace is the naming rule. Pure. */
export function frameworkLintConfig(text) {
  const cfg = JSON.parse(stripJsonc(text));
  cfg.global = { ...(cfg.global || {}), files: `/${FRAMEWORK_SANDBOX.join('/')}/**/*.*` };
  delete cfg.global.exclude;
  cfg.dependencies = [{ folder: '/src', files: '/**/*.*' }];
  cfg.rules = cfg.rules || {};
  if (cfg.rules.object_naming && typeof cfg.rules.object_naming === 'object') {
    cfg.rules.object_naming = { ...cfg.rules.object_naming, clas: '^[ZY]', intf: '^[ZY]' };
  }
  return cfg;
}

/* Lints run ONE AT A TIME, in call order.
 *
 * The config file has to sit in the corpus root - the config's `files` glob
 * resolves relative to the config's own directory - so every lint writes the
 * same path into a repository this server does not own, and every lint deletes
 * it again in a finally. Concurrently, that is a race with one loser: the
 * first call to finish removes the config the second call's abaplint is still
 * reading, and that call fails with a parse error naming a file that no longer
 * exists. buildBackend solved its version of this with single-flight; this is
 * the same idea, queued rather than refused, because a lint is seconds and
 * waiting for one is cheaper than telling the agent to try again.
 *
 * Queued rather than given a per-call file name on purpose: `.abaplint-mcp-dev.jsonc`
 * is the exact path the corpus gitignores, and a suffixed sibling of it would
 * be an untracked file in somebody else's worktree the first time this process
 * is killed mid-lint. */
let lintQueue = Promise.resolve();

export function lintApp(className, { signal, onLine } = {}) {
  const run = lintQueue.then(() => lintOnce(className, { signal, onLine }), () => lintOnce(className, { signal, onLine }));
  // the queue only sequences; a failed lint must not poison the calls behind it
  lintQueue = run.then(() => {}, () => {});
  return run;
}

// abaplint with the relaxed dev config (dev sandbox included); returns only
// the findings for the given class file plus a total count
async function lintOnce(className, { signal, onLine } = {}) {
  const cls = String(className || '').toLowerCase();
  // the config has to sit in the corpus root (its files glob resolves from
  // there), so this server writes a file into a repository it does not own.
  // Removed again in the finally below - the way e2e-transpile.json already
  // is - rather than left behind for a .gitignore line in the other
  // repository to hide.
  const configPath = devLintConfig();
  let spawned;
  try {
    spawned = await spawnWithTimeout(
      'npx',
      ['abaplint', configPath, '--format', 'json'],
      { cwd: sandbox().root, timeoutMs: timeoutOf('A2UI5_MCP_LINT_TIMEOUT_MS'), signal, onLine },
    );
  } finally {
    try { fs.rmSync(configPath, { force: true }); } catch { /* best effort */ }
  }
  const { stdout, stderr, timedOut, aborted } = spawned;
  if (aborted) {
    return {
      ok: false,
      aborted: true,
      issues: [{ rule: 'cancelled', message: 'abaplint cancelled by the client — its process tree was killed' }],
      totalRepoIssues: -1,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      issues: [{ rule: 'timeout', message: timedOutError('abaplint', 'A2UI5_MCP_LINT_TIMEOUT_MS') }],
      totalRepoIssues: -1,
    };
  }
  try {
    const start = stdout.indexOf('[');
    const issues = JSON.parse(stdout.slice(start));
    const mine = issues.filter((i) => (i.file || '').includes(`${cls}.clas`));
    return {
      ok: mine.length === 0,
      issues: mine.map((i) => ({
        rule: i.key,
        message: i.description,
        line: i.start && i.start.row,
      })),
      totalRepoIssues: issues.length,
    };
  } catch {
    return { ok: false, issues: [{ rule: 'parse', message: (stderr || stdout).slice(-800) }], totalRepoIssues: -1 };
  }
}

// ----------------------------------------------------------------- scope ----

// in/out-of-scope verdict for UI5 control entities, via the corpus'
// scripts/scope-of.mjs CLI (exit 0 = all in scope)
export async function runScopeOf(entities, { signal } = {}) {
  const { code, stdout, stderr, timedOut, aborted } = await spawnWithTimeout(
    'node',
    [path.join(corpus(), 'scripts', 'scope-of.mjs'), ...entities],
    { cwd: corpus(), timeoutMs: timeoutOf('A2UI5_MCP_SCOPE_TIMEOUT_MS'), signal },
  );
  if (aborted) throw new Error('scope_of cancelled by the client — its process tree was killed');
  if (timedOut) throw new Error(timedOutError('scope-of', 'A2UI5_MCP_SCOPE_TIMEOUT_MS'));
  return { code, out: (stdout + stderr).trim() };
}

// ----------------------------------------------------------------- build ----

let building = null;
let buildingMode = null; // 'incremental' | 'full' while a build is in flight

/*
 * mode 'full'        — scripts/e2e-build.mjs: downport framework + all apps to
 *                      v702, then transpile. Slow (the 3 abaplint --fix passes
 *                      dominate), but handles any ABAP. Needs samples-controls.
 * mode 'prebuilt'    — download the backend the framework's own release
 *                      workflow built (backend-<version>.tar.gz on the GitHub
 *                      release of the checkout's package.json version) and
 *                      unpack it into the abap2UI5 checkout: node/downport,
 *                      node/output and node/deps, a manifest beside them. A
 *                      minute of download instead of tens of minutes of
 *                      transpile, and it needs only the abap2UI5 checkout -
 *                      not the corpus. What it carries is the FRAMEWORK, not
 *                      the corpus' ports, which is exactly what an agent
 *                      building its own app needs.
 * mode 'incremental' — copy only src/zz_dev/ into the EXISTING downport dir and
 *                      re-run just the transpile (~1-2 min). Skips the downport
 *                      fix passes, so the dev source must already be plain,
 *                      transpiler-friendly ABAP (which the framework style
 *                      guide prescribes anyway); a construct the transpiler
 *                      rejects fails the build with its message — fall back to
 *                      a full build or simplify the code. Works on top of a
 *                      full build and of a prebuilt one alike.
 * mode 'auto'        — incremental when a prior build exists; otherwise
 *                      prebuilt when the abap2UI5 checkout is there (the
 *                      download failing is reported, never silently turned
 *                      into a tens-of-minutes full build); full only when
 *                      there is no abap2UI5 checkout to unpack into and the
 *                      corpus can bootstrap one.
 */
/* `signal` (the MCP request's AbortSignal) kills the running build's process
 * tree on cancel. With single-flight that is necessarily shared: a second
 * caller that joined the in-flight build is joined to its cancellation too —
 * the alternative, a build that survives the request that started it, is the
 * orphan this option exists to prevent. */
export function buildBackend({ onLine, mode = 'auto', signal } = {}) {
  let a2 = a2Local();
  const corpusDir = resolveSamplesControls({ local: true });
  const canIncrement = Boolean(a2 && fs.existsSync(path.join(a2, 'node/downport')) && backendBuilt());
  /* No framework checkout and nothing configured: prebuilt can make one - a
   * shallow clone of the release into the workspace (cloneFramework). A set
   * A2UI5_HOME that points nowhere is a misconfiguration, never a reason to
   * clone somewhere else. */
  const canClone = !a2 && !explicitEnv('a2ui5');
  let effective = mode;
  if (mode === 'auto') effective = canIncrement ? 'incremental' : (a2 || canClone ? 'prebuilt' : 'full');
  const incremental = effective === 'incremental';
  const prebuilt = effective === 'prebuilt';
  /* Single-flight, per mode: a second call with the same effective mode joins
   * the in-flight build (same promise, same result); a different mode fails
   * fast instead of silently receiving the other mode's result — a mode:full
   * caller must never be handed an incremental build. Failing fast beats
   * queuing: silently appending a tens-of-minutes full build behind an
   * incremental one would look like a hang to the caller. */
  if (building) {
    if (effective === buildingMode) return building;
    return Promise.resolve({
      ok: false,
      code: null,
      inFlight: buildingMode,
      tail: `build in progress (${buildingMode}) — a ${effective} build cannot start concurrently; retry when the running build has finished`,
    });
  }
  if ((incremental || (prebuilt && !canClone)) && !a2) {
    return Promise.resolve({ ok: false, code: 1, tail: `abap2UI5 checkout not found${explicitEnv('a2ui5') ? ` (${explicitEnv('a2ui5')} is set and does not point at one)` : ''} — clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server (or run \`npm run node:setup\` in samples-controls), or point A2UI5_HOME at an existing checkout; then run build_backend again (mode prebuilt needs nothing else)` });
  }
  if (incremental && !canIncrement) {
    return Promise.resolve({ ok: false, code: 1, tail: 'incremental build needs a prior build (node/downport + node/output missing) — run mode:prebuilt (a download, needs only the abap2UI5 checkout) or mode:full (tens of minutes, needs samples-controls) first' });
  }
  if (effective === 'full' && !corpusDir) {
    return Promise.resolve({ ok: false, code: 1, tail: 'a full build runs samples-controls\' scripts/e2e-build.mjs — clone https://github.com/abap2UI5/samples-controls as a sibling of mcp-server or point SAMPLES_CONTROLS_HOME at a checkout; or run mode:prebuilt, which downloads the framework\'s released backend and needs only the abap2UI5 checkout' });
  }
  const run = (async () => {
    const buildTimeout = timeoutOf('A2UI5_MCP_BUILD_TIMEOUT_MS');
    const startedAt = new Date().toISOString();
    let tail = [];
    /* The FULL output, kept for build_log: the tool result carries a short
     * tail, and the rest used to be discarded - so the error a 30-line tail
     * cut off cost another tens-of-minutes build to see again. Capped at the
     * same 256 KiB spawnWithTimeout retains per stream, oldest lines out. */
    const full = [];
    let fullBytes = 0;
    let truncated = false;
    const keepLine = (line) => {
      tail = tail.concat(line).slice(-30);
      full.push(line);
      fullBytes += line.length + 1;
      while (fullBytes > BUILD_LOG_CAP && full.length > 1) {
        fullBytes -= full[0].length + 1;
        full.shift();
        truncated = true;
      }
      if (onLine) onLine(line);
    };
    /* One recording path for every way the build ends, so the log always
     * says how the run finished - which matters most for the failures. */
    const finish = (res) => {
      lastBuild = {
        startedAt,
        finishedAt: new Date().toISOString(),
        mode: effective,
        code: res.code ?? null,
        ok: Boolean(res.ok),
        timedOut: Boolean(res.timedOut),
        aborted: Boolean(res.aborted),
        truncated,
        lines: full,
      };
      persistBuildLog(lastBuild);
      return res;
    };
    let tcfgPath = null;
    try {
      let cmd;
      let cmdArgs;
      let cwd;
      if (prebuilt) {
        if (!a2) {
          const cloned = await cloneFramework({ onLine: keepLine, signal, timeoutMs: buildTimeout });
          if (cloned.aborted) {
            return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'clone cancelled by the client'].join('\n') });
          }
          if (!cloned.ok) return finish({ ok: false, code: 1, mode: effective, tail: tail.join('\n') });
          a2 = cloned.dir;
        }
        const res = await downloadPrebuilt({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (res.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'prebuilt download cancelled by the client'].join('\n') });
        }
        return finish({ ok: res.ok, code: res.ok ? 0 : 1, mode: effective, tail: tail.join('\n') });
      }
      if (incremental) {
        // the deployed dev apps, from whichever sandbox is in use
        if (fs.existsSync(devDir())) {
          for (const f of fs.readdirSync(devDir())) {
            if (/\.(abap|xml)$/.test(f)) fs.copyFileSync(path.join(devDir(), f), path.join(a2, 'node/downport', f));
          }
        }
        const tcfg = JSON.parse(fs.readFileSync(path.join(a2, 'node/setup/abap_transpile.json'), 'utf8'));
        /* Which open-abap-core the transpile reads. Three states, in the
         * order they are found:
         *   the corpus-style clone under node/open-abap-core (what a full
         *   e2e-build leaves behind) - reused, and the config retargeted at it
         *   as e2e-build does;
         *   the framework's own pinned clones under node/deps, which a
         *   prebuilt backend carries and `npm run deps` materialises - the
         *   config is used as it is, exactly as the framework's CI does;
         *   neither - the clone below, patched the way the corpus patches it
         *   when a corpus is there to lend the script. */
        const lib = path.join(a2, 'node/open-abap-core');
        const hasCorpusLib = fs.existsSync(path.join(lib, 'src'));
        const libsPresent = tcfg.libs.every((l) => l.folder && fs.existsSync(path.join(a2, l.folder)));
        if (!hasCorpusLib && !libsPresent) {
          fs.rmSync(lib, { recursive: true, force: true });
          /* Arguments, not a shell string. Both paths are built from a
           * checkout location, and that comes from A2UI5_HOME or
           * SAMPLES_CONTROLS_HOME or from wherever the sibling actually is -
           * so `/Users/me/My Projects/abap2UI5` was two arguments to `git
           * clone` and the clone landed somewhere nobody asked for, and a
           * `;` in a path was the shell's to read. `execFileSync` passes
           * each one whole. */
          execFileSync('git', ['clone', '--quiet', '--depth=1', 'https://github.com/open-abap/open-abap-core', lib], { cwd: a2, timeout: buildTimeout });
          if (corpusDir) {
            execFileSync('node', [path.join(corpusDir, 'web/ci/patch_open_abap_xml.mjs'), lib], { cwd: a2, timeout: buildTimeout });
          } else {
            keepLine('no samples-controls checkout: open-abap-core cloned unpatched (the framework\'s own CI transpiles against the unpatched library too)');
          }
        }
        // same transpile invocation e2e-build ends with: the framework's config,
        // retargeted at the local open-abap-core clone where one is used
        if (hasCorpusLib || !libsPresent) {
          tcfg.libs = tcfg.libs.map((l) => (l.url && l.url.includes('open-abap-core') ? { folder: '/node/open-abap-core' } : l));
        }
        tcfgPath = path.join(a2, 'e2e-transpile.json');
        fs.writeFileSync(tcfgPath, JSON.stringify(tcfg, null, 2));
        cmd = 'npx';
        cmdArgs = ['abap_transpile', './e2e-transpile.json'];
        cwd = a2;
      } else {
        cmd = 'node';
        cmdArgs = [path.join(corpus(), "scripts", "e2e-build.mjs")];
        cwd = corpus();
      }
      const { code, timedOut, aborted } = await spawnWithTimeout(cmd, cmdArgs, { cwd, timeoutMs: buildTimeout, onLine: keepLine, signal });
      if (aborted) {
        return finish({
          ok: false,
          code: null,
          mode: effective,
          aborted: true,
          tail: [...tail, `${effective} build cancelled by the client — its process tree was killed`].join('\n'),
        });
      }
      if (timedOut) {
        return finish({
          ok: false,
          code: null,
          mode: effective,
          timedOut: true,
          tail: [...tail, timedOutError(`${effective} build`, 'A2UI5_MCP_BUILD_TIMEOUT_MS')].join('\n'),
        });
      }
      return finish({ ok: code === 0, code, mode: effective, tail: tail.join('\n') });
    } finally {
      if (tcfgPath) fs.rmSync(tcfgPath, { force: true });
    }
  })();
  building = run;
  buildingMode = effective;
  // clear the in-flight slot on settle (identity-checked: works even when the
  // closure rejected synchronously, before these assignments ran)
  const clear = () => {
    if (building === run) {
      building = null;
      buildingMode = null;
    }
  };
  run.then(clear, clear);
  return run;
}

export function backendBuilt() {
  const a2 = a2Local();
  return Boolean(a2 && fs.existsSync(path.join(a2, 'node/output/init.mjs')));
}

// -------------------------------------------------------------- prebuilt ----

/* The asset the framework's release workflow attaches to every release
 * (abap2UI5's .github/workflows/backend-prebuilt.yaml): its name and the
 * manifest at the archive root are a contract shared with that workflow. A
 * renamed asset over there is a failed download here, reported by URL. */
export function prebuiltUrl(version) {
  return process.env.A2UI5_MCP_PREBUILT_URL
    || `https://github.com/abap2UI5/abap2UI5/releases/download/${version}/backend-${version}.tar.gz`;
}

/* The framework repository and where its releases are asked for. */
const FRAMEWORK_REPO = 'https://github.com/abap2UI5/abap2UI5';
const FRAMEWORK_LATEST = 'https://api.github.com/repos/abap2UI5/abap2UI5/releases/latest';

/** Where cloneFramework puts the checkout. */
export function frameworkCloneDir() {
  return path.join(workspaceRoot(), 'abap2UI5');
}

/*
 * A shallow clone of the framework's latest release into the workspace, for
 * a machine that has no abap2UI5 checkout at all: with it, `build_backend`
 * (prebuilt) and `run_app` need nothing anybody prepared. The release tag is
 * asked of GitHub so the clone's package.json version is one a backend asset
 * exists for; when the API cannot be reached the default branch is cloned
 * and the download then reports whether an asset exists for that version.
 * Narrated through onLine like the download. Never rejects.
 */
export async function cloneFramework({ onLine = () => {}, signal, timeoutMs = 30 * 60_000, fetchImpl = globalThis.fetch } = {}) {
  const dir = frameworkCloneDir();
  if (fs.existsSync(path.join(dir, 'node/srv/express.mjs'))) return { ok: true, dir, existed: true };
  let tag = null;
  try {
    const res = await fetchImpl(FRAMEWORK_LATEST, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'abap2ui5-mcp-server' } });
    if (res.ok) tag = String((await res.json()).tag_name || '') || null;
    else onLine(`clone: GitHub answered ${res.status} for the latest release — cloning the default branch instead`);
  } catch (e) {
    onLine(`clone: the latest release could not be looked up (${String((e && e.message) || e)}) — cloning the default branch instead`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true }); // a half clone from a killed run
  onLine(`clone: git clone --depth 1${tag ? ` --branch ${tag}` : ''} ${FRAMEWORK_REPO} ${dir}`);
  const args = ['clone', '--quiet', '--depth', '1', ...(tag ? ['--branch', tag] : []), FRAMEWORK_REPO, dir];
  const git = await spawnWithTimeout('git', args, { timeoutMs, onLine, signal });
  if (git.aborted) return { ok: false, aborted: true, dir };
  if (git.code !== 0 || !fs.existsSync(path.join(dir, 'node/srv/express.mjs'))) {
    onLine(`clone: git exited ${git.code} — ${(git.stderr || '').slice(-300)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, dir, reason: `git exited ${git.code}` };
  }
  onLine(`clone: abap2UI5${tag ? ` ${tag}` : ''} is at ${dir} (A2UI5_MCP_WORKSPACE moves the workspace)`);
  return { ok: true, dir, tag };
}

/* The manifest the archive carries at its root, kept beside the checkout's
 * package.json after unpacking (the framework gitignores it). */
export const PREBUILT_MANIFEST = 'backend-manifest.json';

/** The manifest of the prebuilt backend a checkout carries, or null. */
export function prebuiltManifest(a2 = a2Local()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(a2, PREBUILT_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/*
 * Download and unpack the released backend into the checkout. Resolves —
 * never rejects — with { ok, reason?, aborted?, manifest? }; every step is
 * narrated through onLine so the build log carries the story.
 *
 * The build products of any earlier build are removed first: an archive
 * unpacked over a stale node/output would keep files the release no longer
 * has. `npm ci` runs in the checkout when express (which the served backend
 * requires, and which samples-controls' node:setup used to install) is not
 * there yet.
 */
export async function downloadPrebuilt({ a2, onLine = () => {}, signal, timeoutMs = 30 * 60_000, fetchImpl = globalThis.fetch } = {}) {
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(a2, 'package.json'), 'utf8')).version;
  } catch (e) {
    onLine(`prebuilt backend: cannot read the checkout's package.json (${e.message})`);
    return { ok: false, reason: 'no package.json version' };
  }
  const url = prebuiltUrl(version);
  onLine(`prebuilt backend: fetching ${url}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-prebuilt-'));
  const file = path.join(tmp, `backend-${version}.tar.gz`);
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.any(signals), headers: { 'User-Agent': 'abap2ui5-mcp-server' }, redirect: 'follow' });
    if (!res.ok) {
      onLine(`prebuilt backend: HTTP ${res.status} — release ${version} carries no backend-${version}.tar.gz `
        + '(the asset is attached by the framework\'s backend-prebuilt workflow a while after the release; '
        + 'a checkout on an unreleased commit has no asset at all: run mode:full, or check out the release tag)');
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(file);
    let got = 0;
    let lastTenth = -1;
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      got += chunk.length;
      const tenth = total ? Math.floor((got * 10) / total) : -1;
      if (tenth !== lastTenth) {
        lastTenth = tenth;
        onLine(`prebuilt backend: ${Math.round(got / 1048576)} MB${total ? ` of ${Math.round(total / 1048576)} MB` : ''}`);
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    for (const d of ['node/output', 'node/downport', 'node/deps', PREBUILT_MANIFEST]) {
      fs.rmSync(path.join(a2, d), { recursive: true, force: true });
    }
    onLine(`prebuilt backend: unpacking into ${a2}`);
    const untar = await spawnWithTimeout('tar', ['-xzf', file, '-C', a2], { cwd: a2, timeoutMs, onLine, signal });
    if (untar.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    if (untar.code !== 0) {
      onLine(`prebuilt backend: tar exited ${untar.code} — ${(untar.stderr || '').slice(-300)}`);
      return { ok: false, reason: `tar exited ${untar.code}` };
    }
    const manifest = prebuiltManifest(a2);
    if (!manifest) {
      onLine(`prebuilt backend: the archive carries no ${PREBUILT_MANIFEST} at its root — not an archive this server understands`);
      return { ok: false, reason: 'no manifest' };
    }
    if (manifest.version && manifest.version !== version) {
      onLine(`prebuilt backend: the manifest says ${manifest.version}, the checkout is ${version} — run_app boots the archived build`);
    }
    if (!fs.existsSync(path.join(a2, 'node/output/init.mjs'))) {
      onLine('prebuilt backend: the archive carries no node/output/init.mjs');
      return { ok: false, reason: 'no node/output in the archive' };
    }
    if (!fs.existsSync(path.join(a2, 'node_modules', 'express'))) {
      onLine('prebuilt backend: npm ci in the abap2UI5 checkout (express and the ABAP runtime the backend needs)');
      const ci = await spawnWithTimeout('npm', ['ci', '--no-audit', '--no-fund'], { cwd: a2, timeoutMs, onLine, signal, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
      if (ci.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
      if (ci.code !== 0) {
        onLine(`prebuilt backend: npm ci exited ${ci.code} — ${(ci.stderr || '').slice(-300)}`);
        return { ok: false, reason: `npm ci exited ${ci.code}` };
      }
    }
    onLine(`prebuilt backend ${manifest.version || version} (${manifest.commit || 'unknown commit'}, built ${manifest.builtAt || 'unknown'}) unpacked into ${a2}`);
    return { ok: true, manifest };
  } catch (e) {
    if (signal && signal.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    const message = String((e && e.message) || e);
    onLine(`prebuilt backend: ${message}`);
    return { ok: false, reason: message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- build log ----

/* The last build's full retained output, for the build_log tool. In memory
 * on this module, and persisted as a file under the screenshot/tmp dir so a
 * restarted server can still answer for the build a previous one ran. */
const BUILD_LOG_CAP = 262144; // matches spawnWithTimeout's per-stream retention
let lastBuild = null;
const buildLogFile = () => path.join(shotDir(), 'last-build.json');

function persistBuildLog(record) {
  try {
    fs.mkdirSync(shotDir(), { recursive: true });
    fs.writeFileSync(buildLogFile(), JSON.stringify(record));
  } catch {
    /* best effort — the in-memory copy still serves this process */
  }
}

/** One slice of a line log: without `offset` the LAST `tail` lines, with it
 *  `tail` lines from that 0-based line on. `start` names where the slice
 *  begins so a caller can page. Pure, exported for the tests. */
export function sliceLog(lines, { tail = 100, offset } = {}) {
  if (offset !== undefined && offset !== null) {
    const start = Math.min(Math.max(0, offset), lines.length);
    return { start, lines: lines.slice(start, start + tail) };
  }
  const start = Math.max(0, lines.length - tail);
  return { start, lines: lines.slice(start) };
}

/**
 * The requested slice of the last build's output plus its metadata, or null
 * when no build has run and no persisted log exists. The persisted file is
 * only consulted when this process has not built yet (a fresh server after a
 * restart); a log from it says so under `fromPreviousServer`.
 */
export function buildLog({ tail = 100, offset } = {}) {
  let rec = lastBuild;
  let fromPreviousServer = false;
  if (!rec) {
    try {
      rec = JSON.parse(fs.readFileSync(buildLogFile(), 'utf8'));
      if (!Array.isArray(rec.lines)) return null;
      fromPreviousServer = true;
    } catch {
      return null;
    }
  }
  const { start, lines } = sliceLog(rec.lines, { tail, offset });
  return {
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    mode: rec.mode,
    code: rec.code,
    ok: rec.ok,
    ...(rec.timedOut ? { timedOut: true } : {}),
    ...(rec.aborted ? { aborted: true } : {}),
    ...(rec.truncated ? { truncated: 'the oldest lines were dropped to stay within the retention cap' } : {}),
    ...(fromPreviousServer ? { fromPreviousServer: true } : {}),
    totalLines: rec.lines.length,
    start,
    lines,
  };
}

// ----------------------------------------------------------------- serve ----

let server = null;

export function backendStatus() {
  const manifest = prebuiltManifest();
  return {
    a2ui5: a2Local(),
    built: backendBuilt(),
    ...(manifest ? { prebuilt: { version: manifest.version, commit: manifest.commit, builtAt: manifest.builtAt } } : {}),
    running: Boolean(server && server.exitCode === null),
    port: PORT,
  };
}

/* Single-flight, the same pattern buildBackend and getBrowser use: the
 * running/not-running check below is synchronous, but what follows it is a
 * long await (spawn, wait for "Listening on", wait for the port) - so two
 * concurrent run_app calls both passed the check and spawned TWO express
 * servers onto one port, the second of which failed to bind or, worse, won
 * the race and leaked the first. A second caller now joins the in-flight
 * start and gets the same result. */
let startingBackend = null;

export function startBackend() {
  if (server && server.exitCode === null) return Promise.resolve(backendStatus());
  if (startingBackend) return startingBackend;
  const run = startBackendOnce();
  startingBackend = run;
  const clear = () => {
    if (startingBackend === run) startingBackend = null;
  };
  run.then(clear, clear);
  return run;
}

async function startBackendOnce() {
  const a2 = a2Local();
  if (!a2) throw new Error('abap2UI5 checkout not found — run `npm run node:setup` or set A2UI5_HOME');
  if (!backendBuilt()) throw new Error('backend not built — call the build tool (or `npm run node:build`) first');
  await new Promise((resolve, reject) => {
    const srv = spawn('node', [path.join(a2, 'node/srv/express.mjs')], {
      env: { ...process.env, PORT: String(PORT) },
    });
    let out = '';
    const onData = (d) => {
      out += d;
      if (/Listening on/.test(out)) {
        srv.stdout.off('data', onData);
        server = srv;
        resolve();
      }
    };
    srv.stdout.on('data', onData);
    srv.stderr.on('data', (d) => (out += d));
    srv.on('exit', (c) => {
      /* Clear the live slot only when THIS child owns it. A kill() is
       * asynchronous: a stopped child's exit event can arrive after a newer
       * backend is already live, and unconditionally nulling `server` here
       * cleared the NEW child's reference - backendStatus() said "not
       * running" and stopBackend() had nothing left to kill, so the live
       * express server survived as an orphan holding the port. */
      if (server === srv) server = null;
      else reject(new Error(`backend exited (${c}) before listening:\n${out.slice(-500)}`));
    });
    setTimeout(() => {
      if (server !== srv) {
        srv.kill();
        reject(new Error(`backend did not start in 30s:\n${out.slice(-500)}`));
      }
    }, 30000).unref();
  });
  await waitPort(PORT);
  return backendStatus();
}

export async function stopBackend() {
  await closeBrowser();
  if (server && server.exitCode === null) {
    server.kill();
    server = null;
  }
  return backendStatus();
}

function waitPort(port, ms = 30000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ port, path: '/', timeout: 1000 }, (r) => {
        r.destroy();
        resolve();
      });
      // a socket timeout does NOT abort the request on its own — without this
      // destroy a stuck connection emits neither 'response' nor 'error', and
      // the deadline below (checked only on error) would never be reached
      req.on('timeout', () => req.destroy());
      req.on('error', () => (Date.now() > deadline ? reject(new Error('port timeout')) : setTimeout(tick, 300)));
    };
    tick();
  });
}

// ------------------------------------------------------------------- run ----

// benign-noise rules: the canonical list is the corpus' scripts/lib-smoke.mjs
// (the e2e harness this mirrors) and is imported from the resolved checkout so
// run_app judges boots by the same rules as the nightly gate. The vendored
// copy below only covers a standalone server without a corpus checkout.
export const LOCAL_BENIGN = [
  /library-preload/i,
  /messagebundle/i,
  /i18n/i,
  /themes?\/|library(\.css|-parameters)/i,
  /theming\.Parameters|\.properties/i,
  /failed to load (javascript )?resource/i,
  /Core\.applyTheme|sap\.ui\.getCore/i,
  /favicon/i,
  /deprecat/i,
  /sap-ui-cachebuster/i,
  /ERR_TUNNEL_CONNECTION_FAILED/i,
];
/* Resolved LAZILY, per call, and mtime-keyed (lib/cache.mjs) - it used to be
 * a top-level await, which froze whatever was true at server start: a corpus
 * checked out (or node:setup run) afterwards was silently missed until a
 * restart, against the repo's no-restart doctrine (see shotDir above). The
 * import URL carries the file's version so a changed lib-smoke.mjs really is
 * re-imported rather than answered from Node's module cache. Never rejects:
 * anything short of a readable canonical list means the vendored copy. */
export function benignRules() {
  let file;
  try {
    file = path.join(corpus(), 'scripts', 'lib-smoke.mjs');
  } catch {
    return Promise.resolve(LOCAL_BENIGN); // no corpus checkout
  }
  try {
    return fileKeyed(file, (f) => (async () => {
      try {
        const st = fs.statSync(f);
        const smoke = await import(`${pathToFileURL(f).href}?v=${st.mtimeMs}-${st.size}`);
        if (Array.isArray(smoke.BENIGN) && smoke.BENIGN.length) return smoke.BENIGN;
      } catch {
        // an older corpus without lib-smoke.mjs exports — vendored copy applies
      }
      return LOCAL_BENIGN;
    })());
  } catch {
    return Promise.resolve(LOCAL_BENIGN); // the corpus has no lib-smoke.mjs
  }
}

// serve UI5 from the local @openui5 packages (sandboxes have no CDN) — the
// same routing e2e-smoke uses
const MIME = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.properties': 'text/plain',
  '.html': 'text/html',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

function libRoots() {
  // no corpus, or one without its npm install: UI5 comes from the CDN then
  // (A2UI5_MCP_OFFLINE=1 turns that into the hermetic 404 of e2e-smoke)
  let base;
  try {
    base = path.join(corpus(), "node_modules", "@openui5");
  } catch {
    return [];
  }
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .map((p) => path.join(base, p, 'src'))
    .filter((p) => fs.existsSync(p));
}

function resolveLocal(pathname) {
  const i = pathname.indexOf('/resources/');
  if (i < 0) return null;
  const rel = pathname.slice(i + '/resources/'.length).replace(/^sap-ui-cachebuster\//, '');
  for (const root of libRoots()) {
    const full = path.join(root, rel);
    // the separator matters: a bare startsWith(root) also accepts a SIBLING
    // whose name merely begins with the root's (a `..` segment in rel resolves
    // to exactly that), which would serve files from outside the library
    if (full.startsWith(root + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { body: fs.readFileSync(full), type: MIME[path.extname(full)] || 'application/octet-stream' };
    }
  }
  return null;
}

let browserPromise = null;

// sandboxes often ship a system chromium instead of the playwright-managed
// download — honor A2UI5_MCP_CHROMIUM, else try the managed browser, else fall
// back to a known system binary
async function launchChromium() {
  const { chromium } = await import('playwright');
  const explicit = process.env.A2UI5_MCP_CHROMIUM;
  if (explicit) return chromium.launch({ executablePath: explicit });
  try {
    return await chromium.launch();
  } catch (e) {
    for (const cand of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
      if (fs.existsSync(cand)) return chromium.launch({ executablePath: cand });
    }
    throw e;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchChromium();
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}

/*
 * Boot <class> as the real app: the page, with its error collection wired,
 * after the first roundtrip. run_app photographs it at once; interact_app
 * drives it first. Both end in finishApp, which takes the picture and closes
 * the context, so the pair of tools cannot disagree about what a report is.
 */
async function openApp({ className, timeoutMs = 60000, signal, tool = 'run_app' }) {
  const cls = classNameOf(className);
  const cancelled = () => new Error(`${tool} cancelled by the client`);
  if (signal && signal.aborted) throw cancelled();
  // name a remedy that EXISTS: deploy_app has no `build` argument (class_name,
  // abap_source, description, lint), and an agent that goes looking for one
  // spends the next few minutes finding out it never had one
  if (!backendBuilt()) throw new Error(`backend not built — call build_backend (mode prebuilt or full the first time) before ${tool}`);
  await startBackend();

  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  /* An abort mid-boot closes the context: the Playwright waits below throw at
   * once instead of running out their timeout under a request nobody is
   * waiting for, and the check after the boot turns that into a prompt
   * cancellation error rather than a report full of "Target closed". */
  const onAbort = () => ctx.close().catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const page = await ctx.newPage();
  const errors = [];
  // resolved before the listeners are wired: they are synchronous callbacks
  const benignList = await benignRules();
  const benign = (s) => benignList.some((re) => re.test(s));
  page.on('pageerror', (e) => {
    if (!benign(e.message)) errors.push('pageerror: ' + e.message.slice(0, 300));
  });
  page.on('response', (r) => {
    try {
      const u = new URL(r.url());
      if (u.hostname === 'localhost' && u.port === String(PORT) && r.status() >= 400) {
        errors.push(`backend HTTP ${r.status()} for ${u.pathname}${u.search.slice(0, 60)}`);
      }
    } catch {
      /* ignore unparsable urls */
    }
  });
  // UI5 modules resolve from the local @openui5 packages; what they lack
  // (notably the BUILT theme css — the packages ship only .less sources) may
  // come from the real CDN so screenshots are styled. A2UI5_MCP_OFFLINE=1
  // forces the hermetic 404 behaviour of e2e-smoke.
  await page.route('**://sdk.openui5.org/**', (route) => {
    const hit = resolveLocal(new URL(route.request().url()).pathname);
    if (hit) return route.fulfill({ status: 200, contentType: hit.type, body: hit.body });
    return process.env.A2UI5_MCP_OFFLINE ? route.fulfill({ status: 404, body: '' }) : route.continue();
  });

  let booted = false;
  try {
    await page.goto(`http://localhost:${PORT}/?app_start=${cls}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForFunction(
      () => window.sap && window.sap.ui && document.querySelectorAll('[data-sap-ui]').length > 3,
      { timeout: timeoutMs },
    );
    booted = true;
    await page.waitForTimeout(600); // let the render settle so late errors surface
  } catch (e) {
    errors.push('boot: ' + String(e.message).split('\n')[0].slice(0, 300));
  }
  if (signal && signal.aborted) {
    await ctx.close().catch(() => {});
    throw cancelled();
  }
  return { cls, page, ctx, errors, booted, onAbort, cancelled, signal };
}

/* The picture and the report, then the context is closed. `suffix` keeps an
 * interaction's screenshot apart from the boot's on disk. */
async function finishApp(app, { fullPage = true, suffix = '' } = {}) {
  const { cls, page, ctx, errors, booted, onAbort, signal } = app;
  const dir = shotDir();
  fs.mkdirSync(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${cls}${suffix}.png`);
  let base64 = null;
  try {
    const buf = await page.screenshot({ path: screenshotPath, fullPage });
    base64 = buf.toString('base64');
  } catch (e) {
    errors.push('screenshot: ' + String(e.message).slice(0, 200));
  }
  if (signal) signal.removeEventListener('abort', onAbort);
  await ctx.close();
  return { class: cls, booted, ok: booted && errors.length === 0, errors, screenshotPath, base64 };
}

/*
 * Boot <class> as the real app and look at it.
 *   - errors: non-benign page errors + backend HTTP >= 400 responses
 *   - booted: UI5 up and > 3 controls rendered (the e2e-smoke gate)
 *   - screenshotPath/base64: full-page PNG
 */
export async function runApp({ className, timeoutMs = 60000, fullPage = true, signal }) {
  const app = await openApp({ className, timeoutMs, signal, tool: 'run_app' });
  return finishApp(app, { fullPage });
}

/* The element an action addresses. A control id the builder wrote comes back
 * from UI5 either as is or prefixed by the view (`__xmlview0--main`), so both
 * spellings match; the first match wins, which is the control itself rather
 * than one of its inner elements. */
function locate(page, step) {
  if (step.id) return page.locator(`[id="${cssAttr(step.id)}"], [id$="--${cssAttr(step.id)}"]`).first();
  if (step.selector) return page.locator(step.selector).first();
  if (step.text) return page.getByText(step.text, { exact: true }).first();
  return null;
}

async function performAction(page, step, timeout) {
  const loc = locate(page, step);
  switch (step.action) {
    case 'click':
      await loc.click({ timeout });
      return;
    case 'fill': {
      /* A UI5 input control is a wrapper; the editable element is inside it.
       * When the located element is not itself editable, the first input or
       * textarea inside it is - that is where sap.m.Input, TextArea and
       * ComboBox keep theirs. */
      let target = loc;
      const editable = await loc.evaluate((el) => ['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable).catch(() => false);
      if (!editable) {
        const inner = loc.locator('input, textarea').first();
        if (await inner.count()) target = inner;
      }
      await target.fill(step.value, { timeout });
      // the change event, and with it the roundtrip, fires when the field
      // loses focus - Tab is how a user does it
      if (step.commit) await target.press('Tab', { timeout });
      return;
    }
    case 'press':
      if (loc) await loc.press(step.key, { timeout });
      else await page.keyboard.press(step.key);
      return;
    case 'wait':
      if (loc) await loc.waitFor({ state: 'visible', timeout: step.ms || timeout });
      else await page.waitForTimeout(step.ms);
      return;
    default:
      throw new Error(`unknown action ${step.action}`);
  }
}

/*
 * Boot <class>, perform `actions` in order, let the roundtrips settle and
 * look at the result - the event branch of the app, which run_app cannot
 * reach. The report is run_app's plus one entry per action: performed or
 * not, and why not. The first action that fails stops the script (the ones
 * after it would act on a page in a state nobody asked for), and the picture
 * is still taken - the half that worked is worth looking at.
 */
export async function interactApp({ className, actions, timeoutMs = 60000, actionTimeoutMs = 10000, signal }) {
  const steps = parseActions(actions);
  const app = await openApp({ className, timeoutMs, signal, tool: 'interact_app' });
  const performed = [];
  if (app.booted) {
    for (const step of steps) {
      if (signal && signal.aborted) break;
      const t0 = Date.now();
      try {
        await performAction(app.page, step, actionTimeoutMs);
        performed.push({ ...step, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        performed.push({ ...step, ok: false, error: String((e && e.message) || e).split('\n')[0].slice(0, 300) });
        break;
      }
    }
    // let the roundtrips settle: an event posts to the backend and the view
    // re-renders on the answer
    await app.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await app.page.waitForTimeout(600);
  }
  if (signal && signal.aborted) {
    await app.ctx.close().catch(() => {});
    throw app.cancelled();
  }
  const res = await finishApp(app, { fullPage: true, suffix: '-interact' });
  const skipped = steps.length - performed.length;
  return {
    ...res,
    ok: res.ok && performed.length === steps.length && performed.every((a) => a.ok),
    actions: performed,
    ...(skipped ? { notPerformed: skipped } : {}),
  };
}

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

/** The runner's output as test results: what ran, what was skipped, and the
 *  failing test with its error when the run stopped. Pure, for the tests. */
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
    } else if (last && line.trim()) {
      after.push(line);
    }
  }
  const ran = tests.filter((t) => !t.skipped);
  const failed = code !== 0 && last && !last.skipped ? { ...last, error: after.join('\n').trim().slice(0, 2000) } : null;
  return { ok: code === 0, ran: ran.length, skipped: tests.length - ran.length, tests, failed };
}

/**
 * Run the transpiled ABAP Unit tests: all of them, or the test classes of
 * one object. Needs a built backend. Resolves with the parsed results (see
 * parseUnitOutput) plus how the run ended.
 */
export async function runUnitTests({ className, signal, onLine } = {}) {
  const a2 = a2Local();
  if (!a2) throw new Error('abap2UI5 checkout not found — clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server or point A2UI5_HOME at an existing checkout');
  if (!backendBuilt()) throw new Error('backend not built — call build_backend (mode prebuilt or full the first time) before run_unit_tests');
  const runner = path.join(a2, 'node/output/index.mjs');
  if (!fs.existsSync(runner)) {
    throw new Error('the built backend has no node/output/index.mjs — it was transpiled without write_unit_tests; run build_backend (mode prebuilt or full) again');
  }
  const cls = className ? classNameOf(className).toUpperCase() : null;
  let entry = runner;
  let tmpEntry = null;
  let filtered = false;
  if (cls) {
    const src = fs.readFileSync(runner, 'utf8');
    if (src.includes(RUNNER_LOOP)) {
      const patched = src.replace(RUNNER_LOOP, `for (const st of getData().filter((st) => st.objectName === ${JSON.stringify(cls)})) {`);
      tmpEntry = path.join(a2, 'node/output', `index-mcp-${cls.toLowerCase()}.mjs`);
      fs.writeFileSync(tmpEntry, patched);
      entry = tmpEntry;
      filtered = true;
    } else if (onLine) {
      onLine('the generated runner has an unexpected shape — running every test and filtering the report');
    }
  }
  let spawned;
  try {
    spawned = await spawnWithTimeout('node', [entry], { cwd: a2, timeoutMs: timeoutOf('A2UI5_MCP_UNIT_TIMEOUT_MS'), signal, onLine });
  } finally {
    if (tmpEntry) fs.rmSync(tmpEntry, { force: true });
  }
  const { code, stdout, stderr, timedOut, aborted } = spawned;
  if (aborted) return { ok: false, aborted: true, class: cls, ran: 0, tests: [], error: 'run_unit_tests cancelled by the client — the runner\'s process tree was killed' };
  if (timedOut) return { ok: false, timedOut: true, class: cls, ran: 0, tests: [], error: timedOutError('the unit test runner', 'A2UI5_MCP_UNIT_TIMEOUT_MS') };
  const parsed = parseUnitOutput(stdout, code);
  if (cls && !filtered) {
    parsed.tests = parsed.tests.filter((t) => t.object === cls);
    parsed.ran = parsed.tests.filter((t) => !t.skipped).length;
    parsed.skipped = parsed.tests.length - parsed.ran;
    if (parsed.failed && parsed.failed.object !== cls) parsed.failed = null;
  }
  return {
    ...parsed,
    class: cls,
    filtered,
    ...(code !== 0 && !parsed.failed ? { error: (stderr || stdout).trim().slice(-2000) } : {}),
  };
}

// ---------------------------------------------------------------- status ----

/*
 * What this server can do right now, in one read: which checkout each tool
 * would use (a local one, the read-only mirror, or nothing and why), whether
 * the backend is built and running, which sandbox a deploy lands in, and the
 * programs the expensive half spawns. An agent used to learn all of this one
 * failed call at a time; the setup_status tool answers it once, and a human
 * setting a machine up reads the same answer.
 */
export function setupStatus() {
  const repos = {};
  for (const [key, resolve] of Object.entries(RESOLVERS)) {
    const local = resolve({ local: true });
    const any = resolve();
    const env = explicitEnv(key);
    const entry = { repository: REPO_DIRS[key].repository };
    if (local) entry.local = local;
    else if (any && isRemoteCheckout(any)) {
      const marker = readMarker(any);
      entry.mirror = any;
      entry.fetchedAt = marker && marker.fetchedAt;
    } else {
      entry.missing = true;
      entry.hint = env
        ? `${env} is set to ${process.env[env]}, which is not a checkout`
        : (REMOTE_FILES[key]
          ? 'no checkout; the knowledge tools fetch this repository\'s files from GitHub on first use'
          : `clone ${REPO_DIRS[key].repository} as a sibling of mcp-server, or point ${REPO_DIRS[key].env[0]} at a checkout`);
    }
    if (env) entry.env = env;
    repos[key] = entry;
  }
  const linter = resolveViewCheck();
  repos.viewCheck = linter
    ? { repository: REPO_DIRS.viewCheck.repository, local: linter }
    : { repository: REPO_DIRS.viewCheck.repository, missing: true, hint: 'clone https://github.com/abap2UI5/linter as a sibling and npm ci — validate_view, fix_view and screenshot_view need it' };

  let box = null;
  let sandboxError = null;
  try {
    box = sandbox();
  } catch (e) {
    sandboxError = String(e.message);
  }
  const a2 = a2Local();
  const status = backendStatus();
  const which = (cmd) => {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const chromium = process.env.A2UI5_MCP_CHROMIUM
    || ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => fs.existsSync(c))
    || null;
  return {
    repos,
    sandbox: box
      ? { kind: box.kind, dir: box.dir, deployedApps: listDevApps() }
      : { missing: true, hint: sandboxError },
    backend: {
      checkout: a2,
      built: status.built,
      running: status.running,
      port: status.port,
      ...(status.prebuilt ? { prebuilt: status.prebuilt } : {}),
      unitTestRunner: Boolean(a2 && fs.existsSync(path.join(a2, 'node/output/index.mjs'))),
      cloneTarget: frameworkCloneDir(),
      ...(a2 ? {} : { hint: 'build_backend (mode prebuilt) clones the framework release into cloneTarget and downloads its backend' }),
    },
    programs: { git: which('git'), tar: which('tar'), npx: which('npx'), chromium },
    settings: {
      mirror: remoteEnabled() ? 'on' : 'off',
      mirrorDir: remoteBase(),
      offline: Boolean(process.env.A2UI5_MCP_OFFLINE),
      screenshotDir: shotDir(),
      timeouts: Object.fromEntries(Object.keys(TIMEOUT_DEFAULTS).map((k) => [k, timeoutOf(k)])),
    },
  };
}

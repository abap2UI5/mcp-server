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
import { resolveA2UI5, resolveSamplesControls } from './repos.mjs';

// the deploy sandbox and build pipeline live in the samples-controls checkout
function corpus() {
  const d = resolveSamplesControls();
  if (!d) throw new Error('samples-controls checkout not found — set SAMPLES_CONTROLS_HOME or clone it as a sibling');
  return d;
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
 * rejects — with { code, stdout, stderr, timedOut }; onLine sees every
 * non-empty line of both streams as it arrives. */
export function spawnWithTimeout(cmd, args, { cwd, env, timeoutMs, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
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
    const done = (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
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
const devDir = () => path.join(corpus(), 'src', 'zz_dev');

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

export function deployApp({ className, source, description }) {
  const cls = classNameOf(className);
  if (!/z2ui5_if_app/i.test(source)) {
    throw new Error('source does not implement z2ui5_if_app — an abap2UI5 app is a class with `INTERFACES z2ui5_if_app.`');
  }
  if (!new RegExp(`class\\s+${cls}\\s+definition`, 'i').test(source)) {
    throw new Error(`source does not define CLASS ${cls} DEFINITION — class name and file must match`);
  }
  fs.mkdirSync(devDir(), { recursive: true });
  const abapPath = path.join(devDir(), `${cls}.clas.abap`);
  fs.writeFileSync(abapPath, source.endsWith('\n') ? source : source + '\n');
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
    `   </VSEOCLASS>`,
    `  </asx:values>`,
    ` </asx:abap>`,
    `</abapGit>`,
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(devDir(), `${cls}.clas.xml`), xml);
  return { abapPath, class: cls };
}

export function removeApp(className) {
  const cls = classNameOf(className);
  let removed = 0;
  for (const suffix of ['.clas.abap', '.clas.xml']) {
    const p = path.join(devDir(), cls + suffix);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed++;
    }
  }
  return removed;
}

export function listDevApps() {
  if (!fs.existsSync(devDir())) return [];
  return fs
    .readdirSync(devDir())
    .filter((f) => f.endsWith('.clas.abap'))
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
  const cfg = JSON.parse(stripJsonc(fs.readFileSync(path.join(corpus(), "abaplint.jsonc"), 'utf8')));
  if (cfg.global && Array.isArray(cfg.global.exclude)) {
    cfg.global.exclude = cfg.global.exclude.filter((e) => e !== 'zz_dev');
  }
  if (cfg.rules && cfg.rules.object_naming) {
    cfg.rules.object_naming.clas = '^[ZY]';
    cfg.rules.object_naming.intf = '^[ZY]';
  }
  // must sit in the repo root — the config's files glob resolves relative to
  // the config file's directory
  const p = path.join(corpus(), ".abaplint-mcp-dev.jsonc");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
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

export function lintApp(className) {
  const run = lintQueue.then(() => lintOnce(className), () => lintOnce(className));
  // the queue only sequences; a failed lint must not poison the calls behind it
  lintQueue = run.then(() => {}, () => {});
  return run;
}

// abaplint with the relaxed dev config (dev sandbox included); returns only
// the findings for the given class file plus a total count
async function lintOnce(className) {
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
      { cwd: corpus(), timeoutMs: timeoutOf('A2UI5_MCP_LINT_TIMEOUT_MS') },
    );
  } finally {
    try { fs.rmSync(configPath, { force: true }); } catch { /* best effort */ }
  }
  const { stdout, stderr, timedOut } = spawned;
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
export async function runScopeOf(entities) {
  const { code, stdout, stderr, timedOut } = await spawnWithTimeout(
    'node',
    [path.join(corpus(), 'scripts', 'scope-of.mjs'), ...entities],
    { cwd: corpus(), timeoutMs: timeoutOf('A2UI5_MCP_SCOPE_TIMEOUT_MS') },
  );
  if (timedOut) throw new Error(timedOutError('scope-of', 'A2UI5_MCP_SCOPE_TIMEOUT_MS'));
  return { code, out: (stdout + stderr).trim() };
}

// ----------------------------------------------------------------- build ----

let building = null;
let buildingMode = null; // 'incremental' | 'full' while a build is in flight

/*
 * mode 'full'        — scripts/e2e-build.mjs: downport framework + all apps to
 *                      v702, then transpile. Slow (the 3 abaplint --fix passes
 *                      dominate), but handles any ABAP.
 * mode 'incremental' — copy only src/zz_dev/ into the EXISTING downport dir and
 *                      re-run just the transpile (~1-2 min). Skips the downport
 *                      fix passes, so the dev source must already be plain,
 *                      transpiler-friendly ABAP (which the framework style
 *                      guide prescribes anyway); a construct the transpiler
 *                      rejects fails the build with its message — fall back to
 *                      a full build or simplify the code.
 * mode 'auto'        — incremental when a prior full build exists, else full.
 */
export function buildBackend({ onLine, mode = 'auto' } = {}) {
  const a2 = resolveA2UI5();
  const canIncrement = Boolean(a2 && fs.existsSync(path.join(a2, 'node/downport')) && backendBuilt());
  const incremental = mode === 'incremental' || (mode === 'auto' && canIncrement);
  const effective = incremental ? 'incremental' : 'full';
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
  if (incremental && !a2) {
    return Promise.resolve({ ok: false, code: 1, tail: 'abap2UI5 checkout not found — clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server (or run `npm run node:setup` in samples-controls), or point A2UI5_HOME at an existing checkout; then run mode:full once' });
  }
  if (incremental && !canIncrement) {
    return Promise.resolve({ ok: false, code: 1, tail: 'incremental build needs a prior full build (node/downport + node/output missing) — run mode:full first' });
  }
  const run = (async () => {
    const buildTimeout = timeoutOf('A2UI5_MCP_BUILD_TIMEOUT_MS');
    let tail = [];
    const keepLine = (line) => {
      tail = tail.concat(line).slice(-30);
      if (onLine) onLine(line);
    };
    let tcfgPath = null;
    try {
      let cmd;
      let cmdArgs;
      let cwd;
      if (incremental) {
        if (fs.existsSync(devDir())) {
          for (const f of fs.readdirSync(devDir())) {
            if (/\.(abap|xml)$/.test(f)) fs.copyFileSync(path.join(devDir(), f), path.join(a2, 'node/downport', f));
          }
        }
        // the transpile depends on the locally patched open-abap-core clone that
        // e2e-build normally provides — restore it if it was cleaned away
        const lib = path.join(a2, 'node/open-abap-core');
        if (!fs.existsSync(path.join(lib, 'src'))) {
          fs.rmSync(lib, { recursive: true, force: true });
          /* Arguments, not a shell string. Both paths are built from a
           * checkout location, and that comes from A2UI5_HOME or
           * SAMPLES_CONTROLS_HOME or from wherever the sibling actually is -
           * so `/Users/me/My Projects/abap2UI5` was two arguments to `git
           * clone` and the clone landed somewhere nobody asked for, and a
           * `;` in a path was the shell's to read. `execFileSync` passes
           * each one whole. */
          execFileSync('git', ['clone', '--quiet', '--depth=1', 'https://github.com/open-abap/open-abap-core', lib], { cwd: a2, timeout: buildTimeout });
          execFileSync('node', [path.join(corpus(), 'web/ci/patch_open_abap_xml.mjs'), lib], { cwd: a2, timeout: buildTimeout });
        }
        // same transpile invocation e2e-build ends with: the framework's config,
        // retargeted at the locally patched open-abap-core clone
        const tcfg = JSON.parse(fs.readFileSync(path.join(a2, 'node/setup/abap_transpile.json'), 'utf8'));
        tcfg.libs = tcfg.libs.map((l) => (l.url && l.url.includes('open-abap-core') ? { folder: '/node/open-abap-core' } : l));
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
      const { code, timedOut } = await spawnWithTimeout(cmd, cmdArgs, { cwd, timeoutMs: buildTimeout, onLine: keepLine });
      if (timedOut) {
        return {
          ok: false,
          code: null,
          mode: effective,
          timedOut: true,
          tail: [...tail, timedOutError(`${effective} build`, 'A2UI5_MCP_BUILD_TIMEOUT_MS')].join('\n'),
        };
      }
      return { ok: code === 0, code, mode: effective, tail: tail.join('\n') };
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
  const a2 = resolveA2UI5();
  return Boolean(a2 && fs.existsSync(path.join(a2, 'node/output/init.mjs')));
}

// ----------------------------------------------------------------- serve ----

let server = null;

export function backendStatus() {
  return {
    a2ui5: resolveA2UI5(),
    built: backendBuilt(),
    running: Boolean(server && server.exitCode === null),
    port: PORT,
  };
}

export async function startBackend() {
  if (server && server.exitCode === null) return backendStatus();
  const a2 = resolveA2UI5();
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
const LOCAL_BENIGN = [
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
export const BENIGN = await (async () => {
  try {
    const smoke = await import(pathToFileURL(path.join(corpus(), 'scripts', 'lib-smoke.mjs')).href);
    if (Array.isArray(smoke.BENIGN) && smoke.BENIGN.length) return smoke.BENIGN;
  } catch {
    // no checkout, or an older one without lib-smoke.mjs — vendored copy applies
  }
  return LOCAL_BENIGN;
})();
const benign = (s) => BENIGN.some((re) => re.test(s));

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
  const base = path.join(corpus(), "node_modules", "@openui5");
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
 * Boot <class> as the real app and look at it.
 *   - errors: non-benign page errors + backend HTTP >= 400 responses
 *   - booted: UI5 up and > 3 controls rendered (the e2e-smoke gate)
 *   - screenshotPath/base64: full-page PNG
 */
export async function runApp({ className, timeoutMs = 60000, fullPage = true }) {
  const cls = classNameOf(className);
  // name a remedy that EXISTS: deploy_app has no `build` argument (class_name,
  // abap_source, description, lint), and an agent that goes looking for one
  // spends the next few minutes finding out it never had one
  if (!backendBuilt()) throw new Error('backend not built — call build_backend (mode full the first time, tens of minutes) before run_app');
  await startBackend();

  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
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

  const dir = shotDir();
  fs.mkdirSync(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${cls}.png`);
  let base64 = null;
  try {
    const buf = await page.screenshot({ path: screenshotPath, fullPage });
    base64 = buf.toString('base64');
  } catch (e) {
    errors.push('screenshot: ' + String(e.message).slice(0, 200));
  }
  await ctx.close();
  return { class: cls, booted, ok: booted && errors.length === 0, errors, screenshotPath, base64 };
}

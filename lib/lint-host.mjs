/*
 * lint-host — the warm abaplint: one long-lived worker (lib/lint-worker.mjs)
 * that keeps an @abaplint/core Registry with the framework parsed, so a
 * deploy's lint costs the sandbox's parse and the rules, not the 2.6 s the
 * fresh `abaplint --format json` process spent mostly on the dependency
 * folder. The CLI stays the fallback for everything the worker cannot do,
 * and `lintWarm` says `{ used: false, why }` then - lib/runtime.mjs runs
 * the CLI exactly as before in that case:
 *
 *   - no @abaplint/core beside the @abaplint/cli the lint would run, or one
 *     of another version: the CLI bundles its own core, and the findings
 *     have to be the ones that CLI gives, so only the same version may
 *     stand in for it (the npm backend installs the pair at app-template's
 *     pin; a framework checkout usually has the CLI alone);
 *   - a config the worker does not mirror: `global.files` that is not one
 *     `<sandbox>/**\/*.*` glob of the sandbox directory itself, an exclude
 *     list, a dependency without a folder of files (the CLI would git-clone
 *     its url), apack dependencies. The retargeted template config the
 *     framework and npm sandboxes lint with is exactly the shape mirrored;
 *     the corpus' own config (the whole corpus as the files) is not;
 *   - `A2UI5_MCP_LINT_WORKER=0`: the escape hatch.
 *
 * The timeout and the client's cancel keep their meaning: either kills the
 * worker (its whole tree, like every other child) and answers `timedOut` /
 * `aborted` in the words the CLI path answers them; the next lint starts a
 * fresh worker and pays the cold parse once. A worker that dies on its own
 * fails the call over to the CLI. One request at a time: lintApp queues the
 * lints already, and the worker answers them in order.
 *
 * Invalidation: the worker keeps the dependency parse under a key the host
 * computes per call - the config, the dependency folders, every file in
 * them by name, size and mtime, and the core version. A new release (another
 * runtime directory), a pulled checkout, a changed config each change the
 * key and the worker parses the dependencies again; the sandbox is diffed
 * per call inside the worker.
 *
 * Idle: a parsed framework is about 300 MB of RSS, and the worker used to
 * hold it for the life of the server - an agent that deployed once at the
 * start of a day kept it until the evening. After `A2UI5_MCP_LINT_IDLE_MS`
 * (default 10 min; 0 keeps it forever) without a request the worker is
 * retired (`{ op: 'exit' }`, killed a second later if it ignores that),
 * and the next lint starts a fresh one and pays the cold parse once more.
 * A request that arrives while one retires starts a new worker at once:
 * the slot is cleared before the exit is asked for, so nothing is sent to
 * a child on its way out.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { adoptChild, killChildTree } from './spawn.mjs';

const WORKER = fileURLToPath(new URL('./lint-worker.mjs', import.meta.url));

/* How long an idle worker is kept before it is retired. */
export const DEFAULT_LINT_IDLE_MS = 10 * 60_000;

/** The idle time after which the worker is retired (A2UI5_MCP_LINT_IDLE_MS,
 *  ms; 0 = never; the default otherwise). Pure. */
export function lintIdleMs(env = process.env) {
  const raw = env.A2UI5_MCP_LINT_IDLE_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_LINT_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LINT_IDLE_MS;
}

/** Whether the warm worker is on (A2UI5_MCP_LINT_WORKER=0 turns it off). Pure. */
export function warmLintEnabled(env = process.env) {
  const raw = env.A2UI5_MCP_LINT_WORKER;
  return !(raw !== undefined && ['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase()));
}

function versionOf(root, pkg) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8'));
    return typeof meta.version === 'string' ? meta.version : null;
  } catch {
    return null;
  }
}

/** The @abaplint/core that may stand in for the @abaplint/cli under `binRoot`:
 *  `{ ok: true, coreRoot, version }`, or `{ ok: false, why }`. Pure over the
 *  two package.json files. */
export function coreForCli(binRoot) {
  const cli = versionOf(binRoot, '@abaplint/cli');
  const core = versionOf(binRoot, '@abaplint/core');
  if (!cli) return { ok: false, why: `no @abaplint/cli version readable under ${binRoot}` };
  if (!core) return { ok: false, why: `no @abaplint/core installed beside the @abaplint/cli ${cli} in ${binRoot}` };
  if (core !== cli) return { ok: false, why: `@abaplint/core ${core} is not the @abaplint/cli ${cli}'s version in ${binRoot}` };
  return { ok: true, coreRoot: binRoot, version: core };
}

/* The one `global.files` shape the worker mirrors: `/<dir>/**\/*.*` naming
 * the sandbox directory itself. Returns the dir relative to the base, or
 * null. Pure. */
export function sandboxGlobDir(files) {
  if (typeof files !== 'string') return null;
  const m = /^\/?(.+?)\/\*\*\/\*\.\*$/.exec(files.trim());
  return m ? m[1] : null;
}

/** The dependency folders of a config as absolute paths, or `{ why }` when
 *  the config asks for something the worker cannot do. Pure over the config. */
export function dependencyFolders(config, base) {
  const g = (config && config.global) || {};
  if (g.useApackDependencies) return { why: 'the config uses apack dependencies' };
  if (Array.isArray(g.exclude) && g.exclude.length) return { why: 'the config carries an exclude list' };
  const deps = Array.isArray(config && config.dependencies) ? config.dependencies : [];
  if (!deps.length) return { why: 'the config names no dependency folder' };
  const folders = [];
  for (const d of deps) {
    if (!d || typeof d.folder !== 'string' || !d.folder) return { why: `a dependency without a folder (${d && d.url ? d.url : 'unnamed'}) - the CLI would clone it` };
    if (d.files !== undefined && d.files !== '/**/*.*') return { why: `a dependency files pattern the worker does not mirror (${d.files})` };
    folders.push(path.resolve(base, `.${d.folder.startsWith('/') ? d.folder : `/${d.folder}`}`));
  }
  return { folders };
}

/* Every file below the folders by name, size and mtime, hashed with the
 * config and the core version: the key the worker keeps its registry under. */
export function dependencyKey({ config, folders, coreVersion }) {
  const h = createHash('sha256');
  h.update(String(coreVersion)).update('\n').update(JSON.stringify(config)).update('\n');
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      h.update(`${rel}\0unreadable\n`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${rel}${e.name}/`);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          h.update(`${rel}${e.name}\0${st.size}\0${st.mtimeMs}\n`);
        } catch {
          /* vanished: not an input */
        }
      }
    }
  };
  for (const f of folders) {
    h.update(`${f}\n`);
    walk(f, '');
  }
  return h.digest('hex');
}

// ------------------------------------------------------------- the worker ----

let worker = null; // { child, pending: Map<id, { resolve }>, stderr: string[], idleMs, idleTimer }
let nextId = 1;

/** Test hook: the pid of the live worker, or null. */
export function lintWorkerPid() {
  return worker && worker.child.exitCode === null ? worker.child.pid : null;
}

/* While a request waits, the child and its channel keep this process alive
 * (the answer, or the exit of a killed child, has to be seen); idle, neither
 * does - see startWorker - and the idle clock runs (retireWorker at its
 * end; a timer that keeps nothing alive either). */
const busy = (w) => {
  if (w.idleTimer) clearTimeout(w.idleTimer);
  w.idleTimer = null;
  w.child.ref();
  if (w.child.channel && w.child.channel.ref) w.child.channel.ref();
};
const idle = (w) => {
  w.child.unref();
  if (w.child.channel && w.child.channel.unref) w.child.channel.unref();
  if (w.idleTimer) clearTimeout(w.idleTimer);
  w.idleTimer = w.idleMs > 0 ? setTimeout(() => retireWorker(w), w.idleMs) : null;
  if (w.idleTimer && w.idleTimer.unref) w.idleTimer.unref();
};

/* The idle clock ran out: the slot is cleared FIRST (a lint from now on
 * starts a fresh worker), then the child is asked to exit and killed a
 * second later if it does not. A request that slipped in is left alone. */
function retireWorker(w) {
  w.idleTimer = null;
  if (w.pending.size) return;
  if (worker === w) worker = null;
  if (w.child.exitCode !== null || w.child.signalCode !== null) return;
  try {
    w.child.send({ op: 'exit' });
  } catch {
    /* channel gone already */
  }
  const timer = setTimeout(() => killChildTree(w.child), 1000);
  if (timer.unref) timer.unref();
  w.child.once('exit', () => clearTimeout(timer));
}

function startWorker(idleMs) {
  const child = spawn(process.execPath, [WORKER], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    detached: process.platform !== 'win32', // a group leader: killChildTree reaches everything it starts
  });
  adoptChild(child);
  /* An idle worker must not keep this process alive - neither the child
   * nor its IPC channel is referenced while nothing is pending (a test
   * file, or the server at its end, would otherwise never exit); a request
   * references the channel for as long as it waits. */
  const w = { child, pending: new Map(), stderr: [], idleMs, idleTimer: null };
  idle(w);
  child.stderr.setEncoding('utf8');
  child.stderr.unref?.();
  child.stderr.on('data', (d) => {
    w.stderr.push(String(d));
    while (w.stderr.length > 50) w.stderr.shift();
  });
  child.on('message', (m) => {
    const p = m && w.pending.get(m.id);
    if (!p) return;
    w.pending.delete(m.id);
    if (!w.pending.size) idle(w);
    p.resolve(m);
  });
  const gone = (why) => {
    if (w.idleTimer) clearTimeout(w.idleTimer);
    w.idleTimer = null;
    if (worker === w) worker = null;
    for (const [id, p] of w.pending) {
      w.pending.delete(id);
      p.resolve({ id, ok: false, died: true, error: `${why}${w.stderr.length ? `: ${w.stderr.join('').trim().split('\n').slice(-3).join(' ')}` : ''}` });
    }
  };
  child.on('error', (e) => gone(`the lint worker could not start (${(e && e.message) || e})`));
  child.on('exit', (code, sig) => gone(`the lint worker exited (${sig || code})`));
  worker = w;
  return w;
}

/** End the worker (shutdown, the tests): the next lint starts a fresh one. */
export async function closeLintWorker() {
  const w = worker;
  worker = null;
  if (!w) return;
  if (w.idleTimer) clearTimeout(w.idleTimer);
  w.idleTimer = null;
  if (w.child.exitCode === null) {
    const exited = new Promise((resolve) => w.child.once('exit', resolve));
    try {
      w.child.send({ op: 'exit' });
    } catch {
      /* channel gone already */
    }
    const timer = setTimeout(() => killChildTree(w.child), 1000);
    await exited;
    clearTimeout(timer);
  }
}

/**
 * Lint the sandbox on the warm worker. Resolves `{ used: false, why }` when
 * the CLI has to run instead, otherwise `{ used: true, ok, issues,
 * reparsed, dependencyFiles, timedOut, aborted, error }` - `issues` in the
 * CLI's --format json shape. Never rejects.
 */
export async function lintWarm({ binRoot, base, config, sandboxDir, timeoutMs, signal, onLine = null, env = process.env } = {}) {
  if (!warmLintEnabled(env)) return { used: false, why: 'A2UI5_MCP_LINT_WORKER=0' };
  if (signal && signal.aborted) return { used: true, ok: false, aborted: true, issues: [] };
  const core = coreForCli(binRoot);
  if (!core.ok) return { used: false, why: core.why };
  const rel = sandboxGlobDir(config && config.global && config.global.files);
  if (!rel) return { used: false, why: `a global.files the worker does not mirror (${JSON.stringify(config && config.global && config.global.files)})` };
  if (path.resolve(base, rel) !== path.resolve(sandboxDir)) return { used: false, why: `global.files names ${path.resolve(base, rel)}, not the sandbox ${sandboxDir}` };
  const deps = dependencyFolders(config, base);
  if (deps.why) return { used: false, why: deps.why };
  const depKey = dependencyKey({ config, folders: deps.folders, coreVersion: core.version });

  const w = worker && worker.child.exitCode === null ? worker : startWorker(lintIdleMs(env));
  w.idleMs = lintIdleMs(env); // the environment of THIS call decides the next idle wait
  const id = nextId++;
  const t0 = Date.now();
  let timedOut = false;
  let aborted = false;
  const answer = new Promise((resolve) => w.pending.set(id, { resolve }));
  busy(w);
  const kill = () => {
    if (worker === w) worker = null;
    killChildTree(w.child);
  };
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
  const onAbort = () => { aborted = true; kill(); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    w.child.send({ id, op: 'lint', coreRoot: core.coreRoot, base, config, sandboxDir: path.resolve(sandboxDir), depFolders: deps.folders, depKey });
  } catch (e) {
    w.pending.delete(id);
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    kill();
    return { used: false, why: `the lint worker took no request (${(e && e.message) || e})` };
  }
  const reply = await answer;
  if (timer) clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onAbort);
  if (timedOut) return { used: true, ok: false, timedOut: true, issues: [] };
  if (aborted) return { used: true, ok: false, aborted: true, issues: [] };
  if (!reply.ok) {
    // a crash or a core that does not behave: this call runs the CLI
    return { used: false, why: reply.error || 'the lint worker answered no result' };
  }
  if (onLine) {
    onLine(`abaplint ${core.version} (warm): ${reply.reparsed ? `${reply.dependencyFiles} dependency file(s) parsed, ` : ''}${reply.sandboxFiles} sandbox file(s), ${reply.issues.length} finding(s) in ${Date.now() - t0} ms`);
  }
  return { used: true, ok: true, issues: reply.issues, reparsed: Boolean(reply.reparsed), dependencyFiles: reply.dependencyFiles };
}

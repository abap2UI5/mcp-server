/*
 * spawn — the child processes of the expensive half: every batch child
 * (abaplint, the transpiler, npm, git, a build script) is started here, with
 * a hard timeout, its whole process tree killed on expiry or on the MCP
 * request's cancellation, and its output kept for the report.
 *
 * A module of its own since the npm backend (lib/npm-backend.mjs) spawns npm,
 * git and the transpiler too: it needs these helpers and lib/runtime.mjs
 * needs it, and an import cycle between the two is a trap nobody should have
 * to reason about. lib/runtime.mjs re-exports what it always exported.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

/* Every spawned batch child gets a hard timeout, so a hung transpile or a
 * stalled npx resolves the MCP call with a clear error instead of hanging it
 * forever. Defaults are generous per task (a full build takes tens of
 * minutes, lint/scope take seconds) and overridable via env vars, values in
 * milliseconds. */
export const TIMEOUT_DEFAULTS = {
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
// i.e. as a group leader), so grandchildren — abaplint's workers, a build
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
/* Every child spawnWithTimeout has running, for the shutdown: the children
 * are process-group leaders (detached, so killTree reaches their
 * grandchildren), which also means nothing kills them when this server
 * exits - a build running when the client went away kept transpiling, and a
 * clone kept cloning, under nobody. killChildren( ) is what the server's
 * shutdown path calls. */
const liveChildren = new Set();

/** Kill the process tree of every child still running (the shutdown path). */
export function killChildren() {
  for (const child of liveChildren) killTree(child);
  liveChildren.clear();
}

/* `shell` is for npm on Windows only, where it is a .cmd script that spawn
 * runs through cmd.exe or not at all (lib/npm-backend.mjs npmCommand). */
export function spawnWithTimeout(cmd, args, { cwd, env, timeoutMs, onLine, signal, shell = false } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ code: null, stdout: '', stderr: 'cancelled before start', timedOut: false, aborted: true });
      return;
    }
    const child = spawn(cmd, args, { cwd, env, shell, detached: process.platform !== 'win32' });
    liveChildren.add(child);
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
      liveChildren.delete(child);
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

/*
 * A tool from a checkout's OWN install: the file its package's `bin` entry
 * names under `<root>/node_modules/<pkg>`, or null when the checkout has not
 * installed it.
 *
 * The lint and the incremental transpile used to go through `npx abaplint` /
 * `npx abap_transpile`. When the checkout had no local bin, npx did not fail:
 * stdin is not a TTY under an MCP client, so it answered its own install
 * prompt and fetched whatever the REGISTRY has under that name - and
 * `abap_transpile` is an unclaimed name there, i.e. anyone could publish it
 * and have this server run it inside the user's framework checkout
 * (dependency confusion). A missing install is now a sentence naming the
 * checkout and the `npm ci` that fixes it; nothing is ever downloaded to run.
 *
 * Spawned as `node <file>` rather than through node_modules/.bin: the .bin
 * entries are shell shims on Windows, which spawn will not run without a
 * shell, and both bins are plain node scripts.
 */
export function localBin(root, pkg, bin) {
  if (!root) return null;
  const dir = path.join(root, 'node_modules', ...pkg.split('/'));
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin && meta.bin[bin];
  if (typeof rel !== 'string') return null;
  const file = path.join(dir, rel);
  return fs.existsSync(file) ? file : null;
}

/** The sentence for a checkout without the install `localBin` looked for. */
export function missingBinMessage(root, pkg, bin, remedy = '') {
  return `${bin} is not installed in ${root} (no node_modules/${pkg}) — run \`npm ci\` there${remedy}. `
    + `This server runs the checkout's own ${bin} only; it never lets npx fetch one from the registry.`;
}

export const timedOutError = (what, envVar) =>
  `${what} timed out after ${timeoutOf(envVar)}ms and its process tree was killed — raise ${envVar} if it was legitimately still working`;


// Small shared helpers: child processes with a hard timeout, file walking,
// hashing, JSON I/O. Nothing here knows about abap2UI5.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS_DIR = path.join(BENCH_DIR, 'tasks');
export const CACHE_DIR = path.join(BENCH_DIR, '.cache');

/** Run a command, capture stdout/stderr, kill the whole process group on
 *  timeout. Never throws for a non-zero exit - the caller reads `code`. */
export function run(cmd, args, { cwd, env, timeoutMs = 10 * 60 * 1000, input, onStdout, onStderr } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), timedOut: false, durationMs: 0, spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    /* Decoded as UTF-8 across chunk boundaries: a chunk is bytes, and a
     * character split between two of them came out as replacement
     * characters - in the transcript, the result text, the grader's output. */
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (onStdout) onStdout(d); });
    child.stderr.on('data', (d) => { stderr += d; if (onStderr) onStderr(d); });
    child.on('error', (e) => { stderr += String(e && e.message || e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/** Every file under `dir`, relative paths with forward slashes. Skips
 *  node_modules and every dot-entry - the same walk the linter makes. */
export function walk(dir, { skip = (name) => name === 'node_modules' || name.startsWith('.') } = {}) {
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip(e.name)) continue;
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(a, r);
      else if (e.isFile()) out.push(r);
    }
  };
  visit(dir, '');
  return out.sort();
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false });
}

/** A seeded PRNG (mulberry32) - the trial order is shuffled reproducibly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Tiny argv parser: --flag, --key value, --key=value, --no-flag. */
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out[camel(a.slice(2, eq))] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (key.startsWith('no-') && booleans.includes(key.slice(3))) { out[camel(key.slice(3))] = false; continue; }
    if (booleans.includes(key)) { out[camel(key)] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[camel(key)] = true; continue; }
    out[camel(key)] = next;
    i++;
  }
  return out;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export async function gitHead(dir) {
  const r = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: 20000 });
  if (r.code !== 0) return null;
  const d = await run('git', ['-C', dir, 'status', '--porcelain'], { timeoutMs: 20000 });
  return { sha: r.stdout.trim(), dirty: d.code === 0 && d.stdout.trim() !== '' };
}

/** Every task directory, sorted: { id, dir, task, expect }. */
export function loadTasks(filter) {
  const ids = fs.readdirSync(TASKS_DIR).filter((d) => /^\d\d-/.test(d)).sort();
  const wanted = filter && filter.length
    ? ids.filter((id) => filter.some((f) => id === f || id.startsWith(`${f}-`) || id.slice(3) === f))
    : ids;
  return wanted.map((id) => {
    const dir = path.join(TASKS_DIR, id);
    return {
      id,
      dir,
      prompt: fs.readFileSync(path.join(dir, 'task.md'), 'utf8'),
      expect: readJson(path.join(dir, 'expect.json')),
    };
  });
}

export function timestamp() {
  return new Date().toISOString();
}

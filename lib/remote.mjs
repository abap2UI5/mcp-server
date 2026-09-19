/*
 * remote — the read-only GitHub mirror of a sibling checkout that is not there.
 *
 * Every knowledge tool of this server reads committed files out of a sibling
 * checkout: the guide, the client interface and the two pitfall catalogues
 * from abap2UI5, the capability map and the porting brief from
 * samples-controls, three catalogues, the docs tree, the template. None of
 * those reads needs anything a checkout provides beyond the file itself — no
 * npm install, no build, no git history — and yet each tool was dead until
 * somebody had cloned three to six repositories next to this one. In a fresh
 * project, where an agent meets this server for the first time, that is the
 * whole first hour.
 *
 * So the cheap half now has a fallback: when no local checkout resolves and
 * nothing is configured, the files a tool reads are fetched from
 * raw.githubusercontent.com into a per-user cache directory that LOOKS like a
 * checkout — the same relative paths — and the resolvers hand that directory
 * out as the repo. Every reader keeps reading files from a root; nothing is
 * paraphrased, nothing is bundled, and the live-read contract stands: what the
 * agent sees is what the repository's main branch says, at most a day old.
 *
 * Three rules keep this honest:
 *
 * - A SET ENV VAR STAYS AUTHORITATIVE. `A2UI5_HOME=/nowhere` means "that is
 *   where it is", and a misconfiguration is reported, never papered over with a
 *   download (test/missing-siblings.test.mjs pins that). The mirror is only
 *   ever the answer to "nothing configured, nothing next to me".
 * - THE MIRROR IS READ-ONLY, AND SAYS SO. `deploy_app`, `build_backend`,
 *   `run_app` write into or execute out of a checkout; a mirror carries a
 *   marker file (`MARKER`) and those tools refuse it with the clone command
 *   instead of trying to build inside a cache directory.
 * - OFFLINE IS A CHOICE, NOT AN ACCIDENT. `A2UI5_MCP_OFFLINE=1` (which already
 *   turns the UI5 CDN off) and `A2UI5_MCP_REMOTE=0` switch the mirror off; a
 *   fetch that fails keeps whatever the cache already had and says it is
 *   stale, and with nothing cached the tool degrades exactly as before.
 *
 * The extension had this first: its examples view falls back to the
 * repositories' committed catalogues over HTTPS with a day cache. This is the
 * same decision for the server, and the same TTL.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { REPO_DIRS, explicitEnv } from './repos.mjs';

/** The marker a mirror directory carries — its presence IS the probe. */
export const MARKER = '.abap2ui5-mirror.json';

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;

/** Where the mirrors live: one directory per repository under a per-user cache. */
export function remoteBase() {
  return process.env.A2UI5_MCP_REMOTE_DIR || path.join(os.tmpdir(), 'abap2ui5-mcp-remote');
}

/** The mirror directory of one repo key (`corpus`, `samples`, ...). */
export function remoteRoot(key) {
  return path.join(remoteBase(), REPO_DIRS[key].dirs[0]);
}

/** Off with A2UI5_MCP_OFFLINE=1 or A2UI5_MCP_REMOTE=0 — an explicit choice. */
export function remoteEnabled() {
  if (process.env.A2UI5_MCP_OFFLINE) return false;
  const v = String(process.env.A2UI5_MCP_REMOTE || '').toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function remoteTtlMs() {
  const raw = Number(process.env.A2UI5_MCP_REMOTE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/** Is `dir` one of the mirrors (a directory that carries the marker)? */
export function isRemoteCheckout(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, MARKER));
}

/** The marker's content, or null. */
export function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

/*
 * What each repository has to carry for the tools that read it. A fixed list
 * per repository — the whole point is that the cheap half reads a handful of
 * committed files — except the two that are lists themselves: the template's
 * file list is in its template.json, the docs tree in the repository tree.
 * Those are resolved in `plan()` below, in a second step after the first file.
 */
export const REMOTE_FILES = {
  a2ui5: [
    'docs/agents/building-apps.md',
    'src/02/z2ui5_if_client.intf.abap',
    '.claude/skills/abap-check/SKILL.md',
    '.claude/skills/ui5-check/SKILL.md',
    'package.json',
  ],
  corpus: [
    'CAPABILITIES.md',
    'catalogue.json',
    'SAMPLES.md',
    'scripts/generation-prompt.txt',
  ],
  samples: ['catalogue.json', 'SAMPLES.md'],
  samplesStack: ['catalogue.json', 'SAMPLES.md'],
  appTemplate: ['template.json'],
  docs: ['package.json'],
};

/* Which repositories a tool (or a resource) reads. The server hydrates these
 * before the tool runs; a tool not listed here reads nothing that can be
 * mirrored — or writes, which a mirror never takes. */
export const REMOTE_TOOLS = {
  capabilities: ['corpus'],
  examples: ['samples', 'corpus', 'samplesStack'],
  read_example: [], // per call: the repository the arguments name
  app_guide: ['a2ui5'],
  api_reference: ['a2ui5'],
  generation_rules: ['corpus'],
  scaffold_app: ['appTemplate'],
  docs_search: ['docs'],
  pitfalls: ['a2ui5'],
  // a write tool, but its lint READS app-template's abaplint.jsonc when the
  // sandbox is the framework's (lib/runtime.mjs sandbox) - the mirror serves
  // that one file, the deploy itself never touches a mirror
  deploy_app: ['appTemplate'],
  // composes deploy_app's handler (server.mjs) - the hydrate step is keyed on
  // the tool the CLIENT called, so the composed tool has to name the same reads
  verify_app: ['appTemplate'],
};

/** The repo keys a resource URI reads. */
export function resourceRepos(uri) {
  const u = String(uri || '');
  if (u.startsWith('abap2ui5://guide') || u.startsWith('abap2ui5://api') || u.startsWith('abap2ui5://pitfalls/')) return ['a2ui5'];
  if (u === 'abap2ui5://capabilities' || u === 'abap2ui5://generation-rules') return ['corpus'];
  return [];
}

/** The branch a repository's files are read from. */
function branchOf(key) {
  return REPO_DIRS[key].branch || 'main';
}

function rawUrl(key, rel) {
  return `${RAW}/${REPO_DIRS[key].repository}/${branchOf(key)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/*
 * A relative path an agent or a catalogue hands over becomes a file under the
 * mirror directory, so it is validated the way deploy_app validates a class
 * name: before it is joined, as a whitelist. No absolute path, no `..`, no
 * backslash, no empty segment — and never the marker itself.
 */
export function safeRelPath(rel) {
  const s = String(rel || '').replace(/^\.\//, '');
  if (!s || s.length > 400) return null;
  if (s.startsWith('/') || s.includes('\\') || s.includes('\0')) return null;
  const parts = s.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (parts[parts.length - 1] === MARKER) return null;
  return parts.join('/');
}

/* ONE fetch implementation, injectable for the tests (nothing in `npm test`
 * may reach the network). A token, when the environment carries one, raises
 * the API rate limit; raw.githubusercontent.com does not need it. */
function fetchImplOf(opts) {
  return opts.fetchImpl || globalThis.fetch;
}

function authHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchText(url, opts) {
  const res = await fetchImplOf(opts)(url, {
    headers: { 'User-Agent': 'abap2ui5-mcp-server', ...authHeaders() },
    signal: AbortSignal.timeout(opts.timeoutMs || FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** The docs page tree, as the repository tree API lists it: every
 *  `docs/**\/*.md` outside the directories the site's own generator skips. */
async function docsPages(opts) {
  const key = 'docs';
  const url = `${API}/repos/${REPO_DIRS[key].repository}/git/trees/${branchOf(key)}?recursive=1`;
  const tree = JSON.parse(await fetchText(url, opts));
  const SKIP = ['docs/.vitepress/', 'docs/public/', 'docs/node_modules/'];
  return (tree.tree || [])
    .filter((e) => e.type === 'blob' && e.path.startsWith('docs/') && e.path.endsWith('.md'))
    .filter((e) => !SKIP.some((s) => e.path.startsWith(s)))
    .map((e) => e.path);
}

/** Every file a mirror of `key` has to carry, resolved — the second step for
 *  the two repositories whose list is itself a file. */
async function plan(key, opts) {
  const fixed = REMOTE_FILES[key] || [];
  if (key === 'appTemplate') {
    const spec = JSON.parse(await fetchText(rawUrl(key, 'template.json'), opts));
    return [...fixed, ...(spec.files?.shared || []), ...(spec.files?.named || [])];
  }
  if (key === 'docs') return [...fixed, ...(await docsPages(opts))];
  return fixed;
}

async function writeFile(root, rel, text) {
  const at = path.join(root, rel);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
}

/** Is the mirror of `key` present and younger than the TTL? */
export function mirrorFresh(key) {
  const marker = readMarker(remoteRoot(key));
  if (!marker || !marker.fetchedAt) return false;
  return Date.now() - Date.parse(marker.fetchedAt) < remoteTtlMs();
}

/* Single-flight per repository: a pair of callers asking for the same mirror
 * in one breath (examples reads three repositories) share one download rather
 * than racing to write the same files. */
const inFlight = new Map();
/* The last outcome per key, for the missing-checkout message: "not found -
 * and the mirror could not be fetched because ..." is actionable in a way
 * "not found" alone is not, once a download was tried. */
const lastResult = new Map();

/** The last hydrate outcome of `key`, or null before any attempt. */
export function lastHydrate(key) {
  return lastResult.get(key) || null;
}

/** One sentence on why no mirror stands in for `key` right now, or '' when
 *  a mirror was never the question (a local checkout, nothing attempted). */
export function remoteStatus(key) {
  if (!REMOTE_FILES[key]) return '';
  const env = explicitEnv(key);
  if (env) return ` (${env} is set, so the read-only GitHub mirror is not consulted: fix the path, or unset it to read from GitHub)`;
  if (!remoteEnabled()) return ' (the GitHub mirror is switched off: A2UI5_MCP_OFFLINE / A2UI5_MCP_REMOTE=0)';
  const last = lastResult.get(key);
  if (last && last.error && !last.root) return ` — and the read-only GitHub mirror could not be fetched either: ${last.error}`;
  return '';
}

/**
 * Make sure the mirror of `key` is there and fresh. Resolves to
 * `{ root, fetched, fromCache, stale, error }`; never rejects — a failed
 * download leaves an existing cache in place (`stale: true`) or nothing at
 * all (`root: null`), and the tool degrades with its usual message plus the
 * reason. `local` says whether a real checkout resolves; when it does, this
 * is a no-op, because the mirror is only ever the fallback.
 */
export function hydrate(key, { local = null, force = false, fetchImpl, timeoutMs } = {}) {
  if (local) return Promise.resolve({ root: local, fetched: false, fromCache: false, local: true });
  // a set env var is authoritative: it names where the checkout IS, and a
  // path that is not one is a misconfiguration to report, never to download around
  if (!REMOTE_FILES[key]) return Promise.resolve({ root: null, fetched: false, unsupported: true });
  if (explicitEnv(key)) return Promise.resolve({ root: null, fetched: false, configured: explicitEnv(key) });
  if (!remoteEnabled()) return Promise.resolve({ root: null, fetched: false, disabled: true });
  const root = remoteRoot(key);
  if (!force && mirrorFresh(key)) return Promise.resolve({ root, fetched: false, fromCache: true });
  if (inFlight.has(key)) return inFlight.get(key);
  const run = (async () => {
    const opts = { fetchImpl, timeoutMs };
    try {
      const files = await plan(key, opts);
      const texts = new Map();
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const rel = files[next++];
          texts.set(rel, await fetchText(rawUrl(key, rel), opts));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
      /* Written only once EVERY file arrived: a half-mirrored template is a
       * project handed out with a hole in it, which is the failure the
       * template's own check exists to prevent. */
      for (const [rel, text] of texts) await writeFile(root, rel, text);
      const marker = {
        note: 'A read-only mirror of the committed files the abap2UI5 MCP server reads when no local checkout of this repository exists. Safe to delete; it is re-fetched on the next call. Clone the repository for anything that writes or builds.',
        repository: REPO_DIRS[key].repository,
        branch: branchOf(key),
        fetchedAt: new Date().toISOString(),
        files,
      };
      await writeFile(root, MARKER, JSON.stringify(marker, null, 2) + '\n');
      return { root, fetched: true, fromCache: false, files: files.length };
    } catch (e) {
      const message = String((e && e.message) || e);
      if (isRemoteCheckout(root)) return { root, fetched: false, fromCache: true, stale: true, error: message };
      return { root: null, fetched: false, error: message };
    }
  })();
  inFlight.set(key, run);
  const clear = (res) => {
    if (res && typeof res === 'object') lastResult.set(key, res);
    if (inFlight.get(key) === run) inFlight.delete(key);
  };
  run.then(clear, clear);
  return run;
}

/**
 * One file of a repository, on demand — for a path a catalogue names and the
 * fixed list does not carry (a sample's class source). Resolves to the local
 * path of the file, from the cache when the mirror is fresh and has it,
 * fetched otherwise. Throws on a path outside the whitelist or a fetch that
 * fails with nothing cached.
 */
export async function fetchRemoteFile(key, rel, { fetchImpl, timeoutMs } = {}) {
  const safe = safeRelPath(rel);
  if (!safe) throw new Error(`refusing path '${rel}' — a relative path inside the repository, no '..'`);
  const env = explicitEnv(key);
  if (env) throw new Error(`${env} is set and does not point at a checkout that has the file — fix the path, or unset it so the read-only GitHub mirror is consulted`);
  if (!remoteEnabled()) throw new Error('the GitHub mirror is switched off (A2UI5_MCP_OFFLINE / A2UI5_MCP_REMOTE=0) — clone the repository or switch it on');
  const root = remoteRoot(key);
  const at = path.join(root, safe);
  if (fs.existsSync(at) && mirrorFresh(key)) return at;
  try {
    const text = await fetchText(rawUrl(key, safe), { fetchImpl, timeoutMs });
    await writeFile(root, safe, text);
    return at;
  } catch (e) {
    if (fs.existsSync(at)) return at; // stale beats nothing
    throw new Error(`could not fetch ${REPO_DIRS[key].repository}/${safe} from GitHub: ${String((e && e.message) || e)}`);
  }
}

/** Test hook: forget the in-flight downloads. */
export function resetRemote() {
  inFlight.clear();
  lastResult.clear();
}

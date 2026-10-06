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
import { privateDirProblem } from './private-dir.mjs';

/** The marker a mirror directory carries — its presence IS the probe. */
export const MARKER = '.abap2ui5-mirror.json';

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/*
 * The most a text answer from GitHub may be: a timeout bounds how long a
 * read takes, not how much it holds, and a proxy or mirror in between that
 * answers with something else (an endless or a huge body) filled this
 * process's memory before the timeout came. Measured 2026-10: the largest
 * file a mirror carries (samples-controls' catalogue.json) 0.34 MB, the
 * docs tree listing 0.09 MB, the framework's release list (cloneFramework)
 * 0.28 MB, a sample class a few KB - 8 MB is more than twenty times the
 * largest. Read in chunks and stopped at the cap, said by URL.
 */
export const TEXT_MAX_BYTES = 8 * 1024 * 1024;

const inMb = (bytes) => `${Math.round((bytes / 1048576) * 10) / 10} MB`;

/** The error a response over `maxBytes` is answered with. */
export function tooLargeError(url, maxBytes) {
  return new Error(`the answer for ${url} is larger than ${inMb(maxBytes)} - stopped reading it `
    + '(far more than the file can be: a proxy or mirror in between answering with something else?)');
}

/** The size a response declares (content-length), or null. */
export function declaredLength(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A response's body as text, read only up to `maxBytes`: one that declares
 * more is refused unread, one that streams more is cancelled at the cap.
 * Decoded like `res.text()` (UTF-8, a BOM dropped). A stand-in response
 * without a stream (the tests' fakes) is read through its text().
 */
export async function readCappedText(res, url, maxBytes = TEXT_MAX_BYTES) {
  const declared = declaredLength(res);
  if (declared !== null && declared > maxBytes) {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    throw tooLargeError(url, maxBytes);
  }
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let got = 0;
    // leaving the loop by the throw cancels the stream (its iterator's return)
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > maxBytes) throw tooLargeError(url, maxBytes);
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLargeError(url, maxBytes);
  return text;
}
const CONCURRENCY = 8;

/** Where the mirrors live: one directory per repository under a per-user cache. */
export function remoteBase() {
  return process.env.A2UI5_MCP_REMOTE_DIR || path.join(os.tmpdir(), 'abap2ui5-mcp-remote');
}

/**
 * Why the mirror base must not be used, or null. The default sits under the
 * shared temp dir by a fixed name, so it is used only when it is this user's
 * own (lib/private-dir.mjs): a directory another local user created first, or
 * a link planted there, decided what every knowledge tool served - and
 * add_agent_setup wrote the files of a planted template.json into the
 * user's project. `create` makes it (0700) for a writer. A base that
 * A2UI5_MCP_REMOTE_DIR names is the user's choice and is not checked.
 */
export function remoteBaseProblem({ create = false } = {}) {
  if (process.env.A2UI5_MCP_REMOTE_DIR) return null;
  const problem = privateDirProblem(remoteBase(), { create });
  return problem && `${problem} - the GitHub mirror is not read from or written to there; set A2UI5_MCP_REMOTE_DIR to a directory of your own`;
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
  // writes - into the PROJECT the agent names, never into a mirror; the
  // template it executes is only read, so the mirror serves it like scaffold_app
  add_agent_setup: ['appTemplate'],
  docs_search: ['docs'],
  pitfalls: ['a2ui5'],
  // a write tool, but its lint READS app-template's abaplint.jsonc when the
  // sandbox is the framework's (lib/runtime.mjs sandbox) - the mirror serves
  // that one file, the deploy itself never touches a mirror
  deploy_app: ['appTemplate'],
  // composes deploy_app's handler (server.mjs) - the hydrate step is keyed on
  // the tool the CLIENT called, so the composed tool has to name the same reads
  verify_app: ['appTemplate'],
  // the npm backend's install puts the lint's abaplint beside the runtime at
  // app-template's pin, read from its package-lock.json (lib/npm-backend.mjs)
  build_backend: ['appTemplate'],
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
 * may reach the network).
 *
 * A token, when the environment carries one, goes to api.github.com and
 * NOWHERE else: it raises the tree API's rate limit (60 requests an hour per
 * address without one), which is the only thing it is for here. It used to be
 * sent to raw.githubusercontent.com as well, which needs none - and answers a
 * token it does not accept with 404, so one stale GITHUB_TOKEN in a shell
 * made every knowledge tool report every file as missing. The API, when it
 * refuses the token (401, or 403), is asked again without it, with a warning:
 * a public repository needs no credentials, and a bad token must not cost
 * the answer. */
function fetchImplOf(opts) {
  return opts.fetchImpl || globalThis.fetch;
}

function tokenOf() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

const isApi = (url) => url.startsWith(`${API}/`);

/* Said once per process, on stderr - stdout is the protocol channel. */
let tokenWarned = false;
function warnToken(status) {
  if (tokenWarned) return;
  tokenWarned = true;
  console.error(`abap2ui5 MCP server: api.github.com refused the GITHUB_TOKEN/GH_TOKEN from the environment (HTTP ${status}) `
    + '- continuing without it; fix or unset the variable to get the higher rate limit back');
}

/* What a refusal means, in words an agent can act on. The tree API without
 * a token is limited to 60 requests an hour per address; "HTTP 403" alone
 * read like a permissions problem with the repository. */
function httpError(res, url, { sentToken }) {
  const remaining = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-ratelimit-remaining') : null;
  if (isApi(url) && (res.status === 429 || (res.status === 403 && (remaining === '0' || remaining === null)))) {
    const reset = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('x-ratelimit-reset')) : NaN;
    const when = Number.isFinite(reset) && reset > 0 ? ` (it resets at ${new Date(reset * 1000).toISOString()})` : '';
    const sure = res.status === 429 || remaining === '0';
    return new Error(`HTTP ${res.status} for ${url} — ${sure ? '' : 'most likely '}GitHub's ${sentToken ? '' : 'unauthenticated '}API rate limit is used up${when}`
      + (sentToken ? '' : '; the tree API allows 60 requests an hour per address without a token - set GITHUB_TOKEN (or GH_TOKEN) to any GitHub token to raise it, or clone the repository'));
  }
  return new Error(`HTTP ${res.status} for ${url}`);
}

async function fetchText(url, opts) {
  const token = isApi(url) ? tokenOf() : null;
  const get = (withToken) => fetchImplOf(opts)(url, {
    headers: { 'User-Agent': 'abap2ui5-mcp-server', ...(withToken ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || FETCH_TIMEOUT_MS),
  });
  let res = await get(Boolean(token));
  let sentToken = Boolean(token);
  if (token && (res.status === 401 || res.status === 403)) {
    warnToken(res.status);
    res = await get(false);
    sentToken = false;
  }
  if (!res.ok) throw httpError(res, url, { sentToken });
  return readCappedText(res, url, opts.maxBytes);
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
  let listed = [];
  if (key === 'appTemplate') {
    const spec = JSON.parse(await fetchText(rawUrl(key, 'template.json'), opts));
    listed = [...(spec.files?.shared || []), ...(spec.files?.named || [])];
  } else if (key === 'docs') {
    listed = await docsPages(opts);
  }
  /* The listed paths come from a FILE in another repository (template.json,
   * the tree listing) and become paths under the mirror directory - so they
   * pass the same whitelist an agent's path does. `../../.bashrc` in a
   * template.json used to be joined onto the mirror root and written. One bad
   * entry refuses the whole mirror: a template with a hole in it is the
   * failure the all-or-nothing write exists to prevent. */
  for (const rel of listed) {
    if (!safeRelPath(rel)) {
      throw new Error(`the ${REPO_DIRS[key].repository} listing names '${String(rel).slice(0, 120)}', a path outside the repository — refusing to mirror it`);
    }
  }
  return [...fixed, ...listed.map(safeRelPath)];
}

async function writeFile(root, rel, text) {
  const at = path.resolve(root, rel);
  // the last line of defence behind safeRelPath: nothing lands outside root
  if (!at.startsWith(path.resolve(root) + path.sep)) throw new Error(`refusing to write '${rel}' outside ${root}`);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
}

/** Is the mirror of `key` present and younger than the TTL? */
export function mirrorFresh(key) {
  const marker = readMarker(remoteRoot(key));
  if (!marker || !marker.fetchedAt) return false;
  return Date.now() - Date.parse(marker.fetchedAt) < remoteTtlMs();
}

/** Was this mirrored file written within the TTL? */
function fileFresh(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < remoteTtlMs();
  } catch {
    return false;
  }
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
  const problem = remoteBaseProblem({ create: true });
  if (problem) {
    const res = { root: null, fetched: false, error: problem };
    lastResult.set(key, res);
    return Promise.resolve(res);
  }
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
      const before = readMarker(root);
      for (const [rel, text] of texts) await writeFile(root, rel, text);
      /* A file the last refresh listed and this one does not is gone
       * upstream (a docs page renamed or removed, a file the template no
       * longer lists): it is taken out, or docs_search - which walks the
       * mirror's tree - kept serving the page, with a URL that 404s, for as
       * long as the cache lived. Only files the old marker LISTED, so a
       * sample fetched on demand (fetchRemoteFile) stays. */
      const now = new Set(files);
      for (const rel of (before && Array.isArray(before.files) ? before.files : [])) {
        const safe = safeRelPath(rel);
        if (!safe || now.has(safe)) continue;
        const at = path.resolve(root, safe);
        if (at.startsWith(path.resolve(root) + path.sep)) fs.rmSync(at, { force: true });
      }
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
  const problem = remoteBaseProblem({ create: true });
  if (problem) throw new Error(problem);
  const root = remoteRoot(key);
  const at = path.join(root, safe);
  /* The FILE's own age too, not only the marker's: hydrate rewrites the
   * files of its list and the marker, never a file fetched here on demand -
   * so a sample read once kept being served from that first fetch for as
   * long as some tool refreshed the mirror every day, against "at most a
   * day old". */
  if (fs.existsSync(at) && mirrorFresh(key) && fileFresh(at)) return at;
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
  tokenWarned = false;
}

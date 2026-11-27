/*
 * ui5-routing - what the browser tools' pages load UI5 from (split out of
 * lib/runtime.mjs, which re-exports it): the benign console rules a boot is
 * judged by, UI5 from the corpus' local @openui5 packages, and the
 * in-memory cache of the CDN's answers behind the route handler.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { fileKeyed } from './cache.mjs';
import { corpus } from './sandbox.mjs';

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

/* The corpus' @openui5 packages' `src` folders, the UI5 this server serves
 * locally - an empty list without a corpus or without its npm install (UI5
 * comes from the CDN then; A2UI5_MCP_OFFLINE=1 turns that into the hermetic
 * 404 of e2e-smoke). Memoised on the `@openui5` directory itself
 * (`fileKeyed`: its mtime moves when a package is added or removed, which is
 * what an npm install does): a boot asks for hundreds of UI5 modules, and
 * every one of them read the directory and stat'ed each package again.
 * Exported for the test. */
export function libRoots() {
  let base;
  try {
    base = path.join(corpus(), 'node_modules', '@openui5');
  } catch {
    return [];
  }
  try {
    return fileKeyed(base, (dir) => fs
      .readdirSync(dir)
      .map((p) => path.join(dir, p, 'src'))
      .filter((p) => fs.existsSync(p)), 'lib-roots');
  } catch {
    return []; // no such directory
  }
}

/* The local file behind a UI5 resource URL, or null. One stat per root
 * (it used to be an existsSync and a statSync). Exported for the test. */
export function resolveLocal(pathname) {
  const i = pathname.indexOf('/resources/');
  if (i < 0) return null;
  const rel = pathname.slice(i + '/resources/'.length).replace(/^sap-ui-cachebuster\//, '');
  for (const root of libRoots()) {
    const full = path.join(root, rel);
    // the separator matters: a bare startsWith(root) also accepts a SIBLING
    // whose name merely begins with the root's (a `..` segment in rel resolves
    // to exactly that), which would serve files from outside the library
    if (!full.startsWith(root + path.sep)) continue;
    // one stat, and no exception for a path that is not there (a throw costs
    // more than the stat itself, and most roots do not carry a given file)
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (st && st.isFile()) return { body: fs.readFileSync(full), type: MIME[path.extname(full)] || 'application/octet-stream' };
  }
  return null;
}

// ------------------------------------------------------------ UI5 cache ----

/* What the CDN answered, kept across calls: every run_app / interact_app
 * opens a context of its own (nothing of one call's page may reach the
 * next), and a fresh context has an empty HTTP cache - so every call
 * downloaded UI5 again from sdk.openui5.org, the bootstrap and a few
 * hundred modules, several MB, before the app could boot. The route handler
 * (ui5RouteHandler) answers a GET it has seen from here, fetches a miss
 * itself and keeps the answer: one module-level map keyed by URL, bounded
 * by bytes (A2UI5_MCP_UI5_CACHE_MB, default 64; 0 switches it off), the
 * oldest entries going first. Only successful answers (200) are kept; a
 * body larger than the cap is passed through unkept. The hermetic 404 of
 * A2UI5_MCP_OFFLINE and the local @openui5 packages come before it. */
export const DEFAULT_UI5_CACHE_MB = 64;

/** The cache's cap in bytes (A2UI5_MCP_UI5_CACHE_MB; 0 = off). Pure. */
export function ui5CacheBytes(env = process.env) {
  const raw = env.A2UI5_MCP_UI5_CACHE_MB;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_UI5_CACHE_MB * 1048576;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n * 1048576) : DEFAULT_UI5_CACHE_MB * 1048576;
}

const ui5Cache = new Map(); // url -> { status, headers, body: Buffer }
let ui5CacheSize = 0;

/* The headers a cached answer is served with: the type, and what a
 * cross-origin fetch of a JSON or .properties file needs. Never the
 * transfer's own (content-encoding, content-length: the body kept is the
 * decoded one). */
const KEPT_HEADERS = (name) => name === 'content-type' || name.startsWith('access-control-');

/** Keep a successful GET answer for `url` under the cap; evicts the oldest first. */
export function ui5CacheStore(url, { status, headers = {}, body }, cap = ui5CacheBytes()) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (status !== 200 || buf.length > cap || cap <= 0) return false;
  if (ui5Cache.has(url)) {
    ui5CacheSize -= ui5Cache.get(url).body.length;
    ui5Cache.delete(url);
  }
  for (const [k, v] of ui5Cache) {
    if (ui5CacheSize + buf.length <= cap) break;
    ui5Cache.delete(k);
    ui5CacheSize -= v.body.length;
  }
  const kept = {};
  for (const [k, v] of Object.entries(headers)) if (KEPT_HEADERS(String(k).toLowerCase())) kept[String(k).toLowerCase()] = v;
  ui5Cache.set(url, { status, headers: kept, body: buf });
  ui5CacheSize += buf.length;
  return true;
}

/** The kept answer for `url`, or null. */
export function ui5CacheGet(url) {
  return ui5Cache.get(url) || null;
}

/** Test hook and shutdown: entries and bytes held. */
export function ui5CacheStats() {
  return { entries: ui5Cache.size, bytes: ui5CacheSize };
}

/** Test hook: forget everything. */
export function clearUi5Cache() {
  ui5Cache.clear();
  ui5CacheSize = 0;
}

/*
 * The handler of every request for sdk.openui5.org: the corpus' local
 * packages first (resolveLocal), then the hermetic 404 of
 * A2UI5_MCP_OFFLINE, then the cache above for a GET, then the CDN - the
 * route fetches the miss itself (`route.fetch`) so the answer can be kept,
 * and a fetch that fails is handed to the browser (`route.continue`),
 * which reports the failure in its own words (net::ERR_...). `env` and the
 * cap are injectable for the test.
 */
export function ui5RouteHandler({ env = process.env, cap = ui5CacheBytes(env) } = {}) {
  return async (route) => {
    const req = route.request();
    const url = req.url();
    const hit = resolveLocal(new URL(url).pathname);
    if (hit) return route.fulfill({ status: 200, contentType: hit.type, body: hit.body });
    if (env.A2UI5_MCP_OFFLINE) return route.fulfill({ status: 404, body: '' });
    if (cap <= 0 || req.method() !== 'GET') return route.continue();
    const cached = ui5CacheGet(url);
    if (cached) return route.fulfill({ status: cached.status, headers: cached.headers, body: cached.body });
    let res;
    try {
      res = await route.fetch();
    } catch {
      return route.continue();
    }
    const status = res.status();
    if (status === 200) {
      try {
        ui5CacheStore(url, { status, headers: res.headers(), body: await res.body() }, cap);
      } catch {
        // a body that cannot be read is served as it is, unkept
      }
    }
    return route.fulfill({ response: res });
  };
}

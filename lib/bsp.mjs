/*
 * The frontend files of abap2UI5 addons, served to run_app and interact_app.
 *
 * An addon that brings its own UI5 controls (abap2UI5-addons/custom-controls
 * and its customer twin) ships them as a BSP application - abapGit WAPA files
 * such as `src/01/z2ui5_cci.wapa.cc_-scaninput.js` - and the frontend loads
 * them from `/sap/bc/ui5_ui5/sap/<bsp>/...`. The Node backend knows only the
 * framework's own frontend, so a view with `z2ui5_cci.cc.ScanInput` in it
 * ended in "ModuleError: failed to load z2ui5_cci/cc/ScanInput.js" and the
 * app terminated - every app that used an addon control was unusable in the
 * expensive half.
 *
 * The page now answers those requests from the WAPA files of local
 * checkouts. abapGit writes the path below the BSP with `/` as `_-` and in
 * lower case (custom-controls' tools/app2bsp.mjs), so the lookup is by that
 * name, case-insensitive. Only files found by walking the roots can be
 * served - a request names a key of the index, never a path - and a request
 * for a BSP no root carries goes on to the backend as before.
 *
 * Roots: A2UI5_MCP_BSP_DIRS (directories, separated like PATH) when set - it
 * is authoritative, as every other repository variable here is - else the
 * directory the server runs in (a project that is an addon, or holds one)
 * and the sibling checkouts of the addons with controls, beside this server.
 * After those, the folders deploy_folder deployed in this server's life
 * (registerBspRoot): a project deployed from anywhere brings its own BSP
 * along. Behind the configured roots, so the first root still wins a key.
 *
 * Served as a system serves a page, not as abapGit stores it: a page is
 * stored as lines space-padded to 255 characters, and the system hands the
 * lines out without that padding - without ANY blank at the end of a line,
 * which is why a template literal with a blank before its line break changes
 * on a system (bspBody). A binary file is served as it is.
 *
 * Two consumers: the Playwright route of run_app / interact_app
 * (bspRouteHandler), and the npm host (lib/npm-host.mjs), which serves the
 * same files at the same paths to ANY browser on this machine - an agent's
 * own Playwright script against `backend start` saw a 404 before, because
 * only the server's own Chromium was routed.
 */
import fs from 'fs';
import path from 'path';
import { SERVER_ROOT } from './repos.mjs';

/** The addon checkouts looked for beside the server when nothing is set. */
export const BSP_SIBLINGS = ['custom-controls', 'custom-controls-customer'];

const WAPA = /^([a-z0-9_]+)\.wapa\.(.+)$/i;
const SKIP = new Set(['node_modules', '.git']);
const MAX_DEPTH = 5;
const MAX_FILES = 5000;

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.properties': 'text/plain; charset=utf-8',
};

/* The folders deploy_folder deployed WAPA files from, in deploy order - kept
 * for the life of the server (a restarted server forgets them, and the next
 * deploy_folder names them again). */
const deployedRoots = [];

/** deploy_folder: serve the WAPA files under `dir` from now on. */
export function registerBspRoot(dir) {
  const at = path.resolve(dir);
  if (!deployedRoots.includes(at)) deployedRoots.push(at);
}

/** Test hook: forget the deployed roots. */
export function clearBspRoots() {
  deployedRoots.length = 0;
}

/** The directories searched for WAPA files, existing ones only. */
export function bspRoots({ env = process.env, cwd = process.cwd(), serverRoot = SERVER_ROOT, deployed = deployedRoots } = {}) {
  const set = env.A2UI5_MCP_BSP_DIRS;
  const wanted = [
    ...(set !== undefined && set !== ''
      ? set.split(path.delimiter).filter(Boolean).map((d) => path.resolve(cwd, d))
      : [cwd, ...BSP_SIBLINGS.map((n) => path.join(serverRoot, '..', n))]),
    ...deployed,
  ];
  const seen = new Set();
  return wanted.filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * The WAPA files under `roots`: a Map from `<bsp>/<path>` in lower case to
 * the absolute file. Symbolic links are not followed; the walk stops at a
 * depth and a file count, so a root that is a home directory costs little.
 * The first root that carries a key wins.
 */
export function bspIndex(roots) {
  const index = new Map();
  let files = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || files > MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      files += 1;
      const m = WAPA.exec(e.name);
      // <bsp>.wapa.xml is the application's metadata, not a file of it
      if (!m || m[2].toLowerCase() === 'xml') continue;
      const key = `${m[1]}/${m[2].replace(/_-/g, '/')}`.toLowerCase();
      if (!index.has(key)) index.set(key, path.join(dir, e.name));
    }
  };
  for (const root of roots) walk(root, 0);
  return index;
}

/** `<bsp>/<path>` in lower case for a BSP repository URL, else null. */
export function bspKey(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /^\/sap\/bc\/ui5_ui5\/sap\/([^/]+)\/(.+)$/i.exec(pathname);
  if (!m) return null;
  let rest;
  try {
    rest = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (rest.split('/').some((p) => p === '..' || p === '.')) return null;
  return `${m[1]}/${rest}`.toLowerCase();
}

/* What a binary file is: served as it is. Everything else is a page. */
const BINARY = new Set(['.png', '.gif', '.jpg', '.jpeg', '.woff', '.woff2', '.ttf', '.wasm', '.ico']);

/** The bytes a system serves for the WAPA file `bytes` of `key`: a page
 *  without the blanks at the end of its lines (the 255-character padding,
 *  and with it any blank the source had there); a binary file unchanged. */
export function bspBody(key, bytes) {
  if (BINARY.has(path.extname(key).toLowerCase())) return bytes;
  return Buffer.from(String(bytes).split('\n').map((l) => l.replace(/ +$/, '')).join('\n'));
}

/** The content type a key is served with. */
export function bspType(key) {
  return TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

/**
 * The answer for the BSP URL `url` out of `index`: null when it is no BSP
 * URL or names a BSP the index does not carry (the request goes on to the
 * backend), else { status, type, body, key } - 404 for a file the carried
 * BSP lacks.
 */
export function bspAnswer(index, url, names = new Set(bspNames(index))) {
  const key = bspKey(url);
  if (!key || !names.has(key.split('/')[0])) return null;
  const file = index.get(key);
  let bytes = null;
  if (file) {
    try {
      bytes = fs.readFileSync(file);
    } catch {
      bytes = null;
    }
  }
  if (bytes === null) {
    return { key, status: 404, type: 'text/plain; charset=utf-8', body: `not in the local copy of ${key.split('/')[0]}` };
  }
  return { key, status: 200, type: bspType(key), body: bspBody(key, bytes) };
}

/** The BSP names the index carries. */
export function bspNames(index) {
  return [...new Set([...index.keys()].map((k) => k.split('/')[0]))].sort();
}

/**
 * A Playwright route handler over `index`: a file of a carried BSP is
 * answered from disk, every other request goes on unchanged. `served` and
 * `missed` collect the keys, so a report can say what came from where;
 * `onUnserved(bsp, key)` is told once per BSP that was asked for and no root
 * carries, `onMissing(key)` of every file a carried BSP lacks.
 */
export function bspRouteHandler(index, { served = [], missed = [], onUnserved = () => {}, onMissing = () => {} } = {}) {
  const names = new Set(bspNames(index));
  const told = new Set();
  const handler = async (route) => {
    const key = bspKey(route.request().url());
    if (!key) return route.continue();
    const name = key.split('/')[0];
    if (!names.has(name)) {
      if (!told.has(name)) {
        told.add(name);
        onUnserved(name, key);
      }
      return route.continue();
    }
    const a = bspAnswer(index, route.request().url(), names);
    if (a.status !== 200) {
      missed.push(key);
      onMissing(key);
      return route.fulfill({ status: a.status, contentType: a.type, body: a.body });
    }
    served.push(key);
    return route.fulfill({ status: 200, contentType: a.type, body: a.body });
  };
  handler.served = served;
  handler.missed = missed;
  return handler;
}

/** Is `url` a request for a file of a BSP application? */
export function isBspUrl(url) {
  return bspKey(typeof url === 'string' ? url : url.href) !== null;
}

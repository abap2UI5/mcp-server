/*
 * sandbox - where the expensive half works (split out of lib/runtime.mjs,
 * which re-exports it): the corpus and framework checkouts it builds in,
 * which backend a call runs on (backendKind - a framework checkout or the
 * npm package), the dev sandbox a deploy lands in, the screenshot and
 * build-log directory, and the port the backend serves on.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveA2UI5, resolveSamplesControls, workspaceRoot, explicitEnv } from './repos.mjs';
import { privateDirProblem } from './private-dir.mjs';
import { npmSandboxDir, runtimeDir, currentRuntimeVersion } from './npm-backend.mjs';

// the deploy sandbox and build pipeline live in the samples-controls checkout
export function corpus() {
  const d = resolveSamplesControls({ local: true });
  if (!d) throw new Error('samples-controls checkout not found — set SAMPLES_CONTROLS_HOME or clone it as a sibling');
  return d;
}

/* The framework checkout the backend is built in and served from — a LOCAL
 * one. The read-only GitHub mirror (lib/remote.mjs) serves the guide and the
 * interface; it has no node/ tree and nothing may be built inside a cache
 * directory, so every backend path resolves with `local: true`. */
export function a2Local() {
  return resolveA2UI5({ local: true });
}

// --------------------------------------------------------------- backend ----

/*
 * Which backend the expensive half runs on, decided per call by what is
 * there (nothing is remembered but the checkouts themselves):
 *
 *   checkout  a framework checkout resolves - A2UI5_HOME, a sibling, the
 *             corpus' .abap2UI5, or the clone build_backend mode prebuilt
 *             made in the workspace. Everything as it always was: the
 *             prebuilt asset or the framework's own transpile, the
 *             incremental build in node/downport, node/srv/express.mjs.
 *   npm       no checkout (and none configured): @abap2ui5/node-runtime from
 *             the registry, installed per release in the workspace
 *             (lib/npm-backend.mjs). The default for a machine that has
 *             nothing - it used to be a clone plus the framework's whole
 *             npm ci.
 *   missing   A2UI5_HOME is set and is not a checkout: reported, never built
 *             around (the rule every repository follows here).
 *   clone     A2UI5_MCP_BACKEND=clone and no checkout yet: the old default,
 *             build_backend clones the release first.
 *
 * A2UI5_MCP_BACKEND=npm chooses the npm backend even beside a checkout (the
 * checkout keeps serving the guide and the interface); =clone restores the
 * clone as the answer to "nothing is there". Once a clone exists it IS a
 * checkout - delete ~/.abap2ui5-mcp/abap2UI5 to go back to the npm default.
 */
export function backendPreference() {
  const v = String(process.env.A2UI5_MCP_BACKEND || '').trim().toLowerCase();
  return v === 'npm' || v === 'clone' ? v : null;
}

/** The decision itself, from the three facts it rests on. Pure. */
export function decideBackend({ preference = null, checkout = false, envSet = false } = {}) {
  if (preference === 'npm') return 'npm';
  if (checkout) return 'checkout';
  if (envSet) return 'missing';
  return preference === 'clone' ? 'clone' : 'npm';
}

export function backendKind() {
  return decideBackend({ preference: backendPreference(), checkout: Boolean(a2Local()), envSet: Boolean(explicitEnv('a2ui5')) });
}

/** The runtime directory of the npm backend's release in use, or null. */
export function npmRuntimeDir() {
  const cur = currentRuntimeVersion();
  return cur ? runtimeDir(cur.version) : null;
}

// --------------------------------------------------------------- sandbox ----

/*
 * Where a deployed dev app lives, and what lints it. Three homes, in this order:
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
 *   npm        `<workspace>/sandbox` - when the npm backend is the one in use
 *              and there is no corpus. Outside the per-release runtime
 *              directories, so a new release keeps every deployed app; linted
 *              with app-template's config too, the package's downport/ as the
 *              framework dependency.
 *
 * The second home made the expensive half work with ONE checkout, the third
 * with none. All three answer the same shape, so nothing above this line asks
 * which one it got.
 */
export const FRAMEWORK_SANDBOX = ['node', 'zz_dev'];

export function sandbox() {
  const c = resolveSamplesControls({ local: true });
  if (c) return { kind: 'corpus', root: c, dir: path.join(c, 'src', 'zz_dev') };
  const kind = backendKind();
  if (kind === 'checkout') {
    const a2 = a2Local();
    return { kind: 'framework', root: a2, dir: path.join(a2, ...FRAMEWORK_SANDBOX) };
  }
  if (kind === 'npm') return { kind: 'npm', root: workspaceRoot(), dir: npmSandboxDir() };
  throw new Error('no dev sandbox: neither a samples-controls checkout (SAMPLES_CONTROLS_HOME, or a sibling of mcp-server) '
    + 'nor an abap2UI5 checkout (A2UI5_HOME, a sibling, or the one build_backend mode prebuilt clones) is there to deploy into'
    + (kind === 'missing'
      ? ` - ${explicitEnv('a2ui5')} is set and points at no checkout; unset it to deploy into the npm backend's sandbox (${npmSandboxDir()})`
      : ' - A2UI5_MCP_BACKEND=clone: run build_backend (mode prebuilt clones the release) first, or unset it for the npm backend'));
}

export const devDir = () => sandbox().dir;

/* Where run_app's screenshots land. NOT in the install directory any more:
 * SERVER_ROOT is inside node_modules for the npx/npm install the README leads
 * with, so every boot wrote PNGs into a package directory that the next
 * `npm install` may replace wholesale - and nothing said where they had gone.
 * A per-user directory under the OS temp dir is the default; the env var is
 * for anyone who wants to keep them. Resolved per call, so setting the
 * variable does not need a restart. */
export const shotDir = () =>
  process.env.A2UI5_MCP_SCREENSHOT_DIR || path.join(os.tmpdir(), 'abap2ui5-mcp-screenshots');

/* Why the screenshot dir must not be used, or null. The default sits under
 * the shared temp dir by a fixed name (/tmp on Linux): a directory another
 * local user made first read every screenshot of the user's apps and fed a
 * restarted server's build_log a last-build.json of its own, and a link of
 * that name - or of `<class>.png`, `last-build.json` inside it - pointed the
 * writes into the user's own files. So the default is used only while it is
 * the user's own (lib/private-dir.mjs); `create` makes it 0700 for a writer.
 * A directory A2UI5_MCP_SCREENSHOT_DIR names is the user's choice. */
export function shotDirProblem({ create = false } = {}) {
  if (process.env.A2UI5_MCP_SCREENSHOT_DIR) {
    if (create) fs.mkdirSync(shotDir(), { recursive: true });
    return null;
  }
  const problem = privateDirProblem(shotDir(), { create });
  return problem && `${problem} - nothing is written to or read from it; set A2UI5_MCP_SCREENSHOT_DIR to a directory of your own`;
}
export const PORT = Number(process.env.A2UI5_MCP_PORT || 3000);

/* The address the backend binds - and therefore the one address every
 * client of it here connects to: the start's port wait, run_app's and
 * interact_app's Chromium, the app tools' HTTP client, the check that
 * tells the backend's responses from the CDN's. The NAME localhost is never
 * used for it: where it resolves to ::1 first (the resolver's order, an
 * /etc/hosts of the machine), a connection to localhost:<port> reached
 * [::1]:<port> - which another local user can listen on, and then served
 * the page, read the events and answered the start's wait - or nothing at
 * all, a backend that "did not start". */
export const BACKEND_HOST = '127.0.0.1';

/** The URL run_app's Chromium opens to boot `cls` on the backend. */
export const appStartUrl = (cls, port = PORT) => `http://${BACKEND_HOST}:${port}/?app_start=${cls}`;

/** Whether a URL the page loaded is the backend's (its errors are the app's). */
export function isBackendUrl(url, port = PORT) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' && u.hostname === BACKEND_HOST && u.port === String(port);
  } catch {
    return false; // an unparsable url is nobody's
  }
}

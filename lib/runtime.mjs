/*
 * runtime — the deploy/run half of the MCP loop, no SAP system needed.
 *
 * Wraps the ecosystem's existing Node pipeline: an app class is written into
 * a dev sandbox, the transpiled backend is rebuilt, a Node host serves it on
 * 127.0.0.1 (BACKEND_HOST), and Playwright boots the app via ?app_start=<class> exactly like
 * samples-controls' scripts/e2e-smoke.mjs does — collecting real page errors
 * and returning a screenshot.
 *
 * Two backends, decided per call (backendKind): a framework CHECKOUT -
 * build = its prebuilt asset, its own transpile or the corpus' e2e-build,
 * serve = its express shim - or, with no checkout, the npm package
 * @abap2ui5/node-runtime (lib/npm-backend.mjs) - build = only the dev apps
 * transpiled against it, serve = lib/npm-host.mjs. Nothing here re-invents
 * the pipeline, and the boot/error rules are the e2e-smoke gate's either way
 * (UI5 booted, >3 rendered controls, no non-benign page error, no backend
 * HTTP >= 400).
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import { resolveA2UI5, resolveSamplesControls, resolveAppTemplate, resolveViewCheck, resolveCloudGui, workspaceRoot, explicitEnv, RESOLVERS, REPO_DIRS } from './repos.mjs';
import { fileKeyed } from './cache.mjs';
import { privateDirProblem } from './private-dir.mjs';
import { TIMEOUT_DEFAULTS, timeoutOf, spawnWithTimeout, localBin, missingBinMessage, timedOutError } from './spawn.mjs';
import {
  npmSandboxDir, runtimeDir, appsDir, appsBuilt, downportDir, currentRuntimeVersion, prepareRuntime, buildNpm,
  npmStatus, RUNTIME_PKG, spawnNpm,
} from './npm-backend.mjs';

// the child-process helpers live in lib/spawn.mjs now; exported from here as
// they always were, so nothing that imports them from this module changes
export { TIMEOUT_DEFAULTS, timeoutOf, spawnWithTimeout, killChildren, localBin, missingBinMessage } from './spawn.mjs';
import { isRemoteCheckout, readMarker, remoteEnabled, remoteBase, REMOTE_FILES, readCappedText, declaredLength, tooLargeError } from './remote.mjs';
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
function npmRuntimeDir() {
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

/* Why the screenshot dir must not be used, or null. The default sits under
 * the shared temp dir by a fixed name (/tmp on Linux): a directory another
 * local user made first read every screenshot of the user's apps and fed a
 * restarted server's build_log a last-build.json of its own, and a link of
 * that name - or of `<class>.png`, `last-build.json` inside it - pointed the
 * writes into the user's own files. So the default is used only while it is
 * the user's own (lib/private-dir.mjs); `create` makes it 0700 for a writer.
 * A directory A2UI5_MCP_SCREENSHOT_DIR names is the user's choice. */
function shotDirProblem({ create = false } = {}) {
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

/* Exported for abap2ui5-unit, which puts a project's classes and interfaces
 * into a sandbox under the same gate: a name that is a path is refused. */
export function classNameOf(className) {
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

/*
 * Where the objects a dev app must not share its name with are defined, per
 * sandbox home. The customer namespace classNameOf( ) admits is not the dev
 * apps' alone: the framework's own z2ui5_* classes are in it, and so is the
 * ICF handler every host boots (zcl_sicf, in node/srv). A dev app of such a
 * name is no app of its own - the build puts it beside the original, where
 * the second copy either fails the transpile or quietly replaces the
 * framework's class in the output the host serves. So the name is refused at
 * deploy, where the reason can still be said:
 *
 *   npm        the release's downport/ - the ABAP its output was transpiled
 *              from, node/srv folded in
 *   framework  src/ and node/srv/ of the checkout
 *   corpus     the corpus' own src/ (zz_dev, the sandbox itself, aside) and
 *              the framework checkout beside it, when one resolves
 */
function ownObjectRoots(box) {
  const framework = (a2) => [
    { owner: 'the framework\'s', dir: path.join(a2, 'src') },
    { owner: 'the framework\'s', dir: path.join(a2, 'node', 'srv') },
  ];
  if (box.kind === 'npm') {
    const runtime = npmRuntimeDir();
    return runtime ? [{ owner: 'the framework\'s', dir: downportDir(runtime) }] : [];
  }
  if (box.kind === 'framework') return framework(box.root);
  const a2 = a2Local();
  return [{ owner: 'samples-controls\'', dir: path.join(box.root, 'src') }, ...(a2 ? framework(a2) : [])];
}

/** The file that already defines `cls` as a class or an interface, or null. */
function ownObjectOf(cls, box) {
  const names = new Map([[`${cls}.clas.abap`, 'class'], [`${cls}.intf.abap`, 'interface']]);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null; // a root that is not there defines nothing
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === box.dir || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const hit = walk(p);
        if (hit) return hit;
      } else if (names.has(e.name)) {
        return { file: p, type: names.get(e.name) };
      }
    }
    return null;
  };
  for (const root of ownObjectRoots(box)) {
    const hit = walk(root.dir);
    if (hit) return { ...hit, owner: root.owner };
  }
  return null;
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
  const box = sandbox();
  const own = ownObjectOf(cls, box);
  if (own) {
    throw new Error(`${cls} is ${own.owner} own ${own.type} (${own.file}) - a dev app of that name would be a second copy `
      + 'of it beside the original, and the build either fails on the pair or serves yours in its place. Choose another name, '
      + 'e.g. zcl_my_app');
  }
  fs.mkdirSync(box.dir, { recursive: true });
  const abapPath = path.join(box.dir, `${cls}.clas.abap`);
  fs.writeFileSync(abapPath, source.endsWith('\n') ? source : source + '\n');
  const testPath = path.join(box.dir, `${cls}.clas.testclasses.abap`);
  if (withTests) fs.writeFileSync(testPath, testclasses.endsWith('\n') ? testclasses : testclasses + '\n');
  else fs.rmSync(testPath, { force: true }); // a redeploy without tests must not keep stale ones
  /* The default names the class. It used to be the constant 'MCP dev app',
   * and abaplint's identical_descriptions (on in app-template's config, the
   * lint of the framework sandbox) then failed every second dev app - so
   * verify_app stopped at deploy for an app with nothing wrong with it. */
  const desc = String(description || `MCP dev app ${cls}`).slice(0, 60).replace(/[<>&]/g, ' ');
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
  fs.writeFileSync(path.join(box.dir, `${cls}.clas.xml`), '\uFEFF' + xml);
  return { abapPath, class: cls, testclassesPath: withTests ? testPath : null };
}

export function removeApp(className) {
  const cls = classNameOf(className);
  let removed = 0;
  /* Every file of the class, not three suffixes: migrate_report's deploy and
   * abap2ui5-unit write a class with all of its includes (locals_imp,
   * locals_def, macros), and a removed class whose include stayed behind was
   * still an object of the sandbox - gone from the deployed-apps list, still
   * in the next build's input, an include without its class. The name passed
   * classNameOf, so it holds no dot: `<cls>.clas.` is this class alone. */
  const dir = devDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* no sandbox directory yet: nothing deployed */
  }
  for (const f of names) {
    if (!f.toLowerCase().startsWith(`${cls}.clas.`)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) {
      fs.unlinkSync(p);
      removed++;
    }
  }
  // and the copies the incremental build made of them, so the next build
  // does not transpile a class that is no longer deployed. The npm backend
  // keeps no copies: its build reads the sandbox itself and rebuilds apps/
  // whole, which takes a removed app out of it.
  const a2 = a2Local();
  if (a2 && backendKind() === 'checkout') syncDevCopies(a2, { copy: false });
  return removed;
}

/*
 * The dev apps' copies inside the framework's node/downport - what the
 * incremental transpile actually reads.
 *
 * The build used to copy the sandbox in and never take anything out. So
 * after remove_app the class was still in node/downport and build_backend
 * kept failing on it (or kept serving it); a redeploy WITHOUT testclasses
 * left the old `.clas.testclasses.abap` there and its tests kept running;
 * and abap2ui5-unit, which promises to leave a developer's checkout as it
 * found it, left every class it had tested behind.
 *
 * node/downport is also where the framework's OWN downported sources live
 * (at its root too: zcl_sicf, the zcl_tst_* apps), so nothing is deleted by
 * name or pattern. A manifest records the files THIS server put there, and
 * only those are ever removed: a copy whose sandbox source is gone is
 * deleted, a file that was there before (the framework's) is overwritten as
 * before but never owned. A copy an older server left behind, identical to
 * what is being copied now, is adopted. The manifest is a dotfile inside
 * node/downport - the transpiler's glob skips dotfiles, and a prebuilt
 * download or a full build, which recreate the directory, take the manifest
 * away together with every copy it lists.
 */
export const DEV_COPIES = '.abap2ui5-mcp-dev-copies.json';
const COPY_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*\.(abap|xml)$/i;

export function syncDevCopies(a2, { copy = true } = {}) {
  const down = path.join(a2, 'node', 'downport');
  if (!fs.existsSync(down)) return { copied: [], removed: [] };
  const manifest = path.join(down, DEV_COPIES);
  let owned = [];
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    // a plain file name in that directory, or it is not ours to delete
    owned = (Array.isArray(m.files) ? m.files : []).filter((f) => typeof f === 'string' && COPY_NAME.test(f));
  } catch {
    /* no manifest yet */
  }
  let dir = null;
  try {
    dir = devDir();
  } catch {
    /* no sandbox at all: every copy is stale */
  }
  // the sandbox's package.devc.xml is not an app: copying it overwrote the
  // framework's own node/downport/package.devc.xml, and nothing reads it
  const present = dir && fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => COPY_NAME.test(f) && f !== 'package.devc.xml')
    : [];
  const removed = [];
  for (const f of owned) {
    if (present.includes(f)) continue;
    fs.rmSync(path.join(down, f), { force: true });
    removed.push(f);
  }
  const keep = new Set(owned.filter((f) => present.includes(f)));
  const copied = [];
  if (copy) {
    for (const f of present) {
      const src = path.join(dir, f);
      const dst = path.join(down, f);
      const text = fs.readFileSync(src);
      if (!fs.existsSync(dst) || keep.has(f) || fs.readFileSync(dst).equals(text)) keep.add(f);
      fs.writeFileSync(dst, text);
      copied.push(f);
    }
  }
  if (keep.size) {
    fs.writeFileSync(manifest, JSON.stringify({
      note: 'Dev-app copies the abap2UI5 MCP server made from its sandbox; it removes each one again once its source is gone. Nothing else in this directory is listed or touched.',
      files: [...keep].sort(),
    }, null, 2) + '\n');
  } else {
    fs.rmSync(manifest, { force: true });
  }
  return { copied, removed };
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
  const builtFile = builtMarkerFile();
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
function devLintConfig(box, runtime = null) {
  let cfg;
  if (box.kind === 'corpus') cfg = corpusLintConfig(fs.readFileSync(path.join(box.root, 'abaplint.jsonc'), 'utf8'));
  else if (box.kind === 'npm') cfg = frameworkLintConfig(templateLintConfigText(), npmLintTarget(box, runtime));
  else cfg = frameworkLintConfig(templateLintConfigText());
  // must sit in the repo root — the config's files glob resolves relative to
  // the config file's directory
  const p = path.join(box.root, ".abaplint-mcp-dev.jsonc");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/* The npm sandbox's lint target, relative to the workspace root the config
 * sits in: the sandbox as the files, the release's downport/ - the ABAP its
 * output/ was transpiled from - as the framework dependency. Pure. */
export function npmLintTarget(box, runtime) {
  const rel = (p) => '/' + path.relative(box.root, p).split(path.sep).join('/');
  return { files: `${rel(box.dir)}/**/*.*`, folder: rel(downportDir(runtime)) };
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
export function frameworkLintConfig(text, { files = `/${FRAMEWORK_SANDBOX.join('/')}/**/*.*`, folder = '/src' } = {}) {
  const cfg = JSON.parse(stripJsonc(text));
  cfg.global = { ...(cfg.global || {}), files };
  delete cfg.global.exclude;
  cfg.dependencies = [{ folder, files: '/**/*.*' }];
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

/* The findings of ONE class out of the whole repository's: the files of that
 * object (`<cls>.clas.abap`, `.clas.xml`, its includes), matched on the file
 * NAME. A substring test on the path used to hand a class the findings of
 * every class whose name ends in its own - deploying `z_app` reported
 * `zz_app`'s, and failed a clean class (verify_app stopped at deploy). Pure. */
export function issuesOfClass(issues, cls) {
  const name = String(cls).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`(?:^|[\\\\/])${name}\\.clas\\.[^\\\\/]*$`, 'i');
  return (issues || []).filter((i) => own.test(String(i.file || '')));
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
  const box = sandbox();
  const root = box.root;
  /* The npm sandbox lints with the abaplint the RELEASE's runtime directory
   * installs (at app-template's pin), against that release's downport/ - so
   * the first deploy on a bare machine installs the runtime (the same
   * install the build would make, queued with it, once). */
  let binRoot = root;
  let runtime = null;
  if (box.kind === 'npm') {
    const rt = await prepareRuntime({ withLint: true, onLine, signal, timeoutMs: timeoutOf('A2UI5_MCP_BUILD_TIMEOUT_MS') });
    if (!rt.ok) {
      return {
        ok: false,
        ...(rt.aborted ? { aborted: true } : {}),
        issues: [{ rule: rt.aborted ? 'cancelled' : 'runtime-missing', message: `the lint runs the abaplint of the ${RUNTIME_PKG} runtime, and it is not installed: ${rt.reason}` }],
        totalRepoIssues: -1,
      };
    }
    binRoot = runtime = rt.dir;
  }
  const abaplint = localBin(binRoot, '@abaplint/cli', 'abaplint');
  if (!abaplint) {
    return {
      ok: false,
      issues: [{
        rule: 'abaplint-missing',
        message: missingBinMessage(binRoot, '@abaplint/cli', 'abaplint',
          box.kind === 'framework' ? ' (build_backend mode prebuilt runs it when it unpacks a backend)' : ''),
      }],
      totalRepoIssues: -1,
    };
  }
  const configPath = devLintConfig(box, runtime);
  let spawned;
  try {
    spawned = await spawnWithTimeout(
      process.execPath,
      [abaplint, configPath, '--format', 'json'],
      { cwd: root, timeoutMs: timeoutOf('A2UI5_MCP_LINT_TIMEOUT_MS'), signal, onLine },
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
    const mine = issuesOfClass(issues, cls);
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
let buildingMode = null; // the effective mode while a build is in flight

/*
 * mode 'npm'         — the npm backend (lib/npm-backend.mjs): the release of
 *                      @abap2ui5/node-runtime (A2UI5_MCP_RUNTIME_VERSION, else
 *                      the registry's latest) installed into the workspace
 *                      once, open-abap-core fetched at the release's commit
 *                      once, then only the sandbox transpiled - seconds. No
 *                      framework checkout, no clone, no framework devDependencies.
 *                      What auto does whenever no framework checkout is there.
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
 * mode 'transpile'   — the framework's OWN pipeline in the abap2UI5 checkout
 *                      (`npm run downport` + `npm run auto_transpile`, after an
 *                      `npm ci` when node_modules is missing): the framework
 *                      alone, no corpus, a few minutes (2-3 on a laptop). What
 *                      the release workflow runs to produce the prebuilt asset,
 *                      run here for a checkout no asset exists for - an
 *                      unreleased commit, or a release published before the
 *                      workflow existed.
 * mode 'incremental' — copy only the sandbox into the EXISTING downport dir and
 *                      re-run just the transpile (~1-2 min). Skips the downport
 *                      fix passes, so the dev source must already be plain,
 *                      transpiler-friendly ABAP (which the framework style
 *                      guide prescribes anyway); a construct the transpiler
 *                      rejects fails the build with its message — fall back to
 *                      a full build or simplify the code. Works on top of a
 *                      full build and of a prebuilt one alike.
 * mode 'auto'        — npm when the npm backend is the one in use (no
 *                      framework checkout, or A2UI5_MCP_BACKEND=npm - see
 *                      backendKind). With a checkout: incremental when a prior
 *                      build exists; otherwise prebuilt - and when the release
 *                      carries no asset (HTTP 404), transpile: the framework's
 *                      own few-minute build, announced in the log, never the
 *                      tens-of-minutes corpus build. With A2UI5_MCP_BACKEND=clone
 *                      and no checkout: prebuilt, which clones the release
 *                      first (the default before the npm backend). full only
 *                      when A2UI5_HOME points nowhere and the corpus can
 *                      bootstrap a checkout.
 *
 * incremental in the npm backend is the npm build - it transpiles the sandbox
 * alone anyway. prebuilt and transpile without a checkout clone the release
 * into the workspace first: they are the explicit way to the clone.
 */
/* `signal` (the MCP request's AbortSignal) kills the running build's process
 * tree on cancel. With single-flight that is necessarily shared: a second
 * caller that joined the in-flight build is joined to its cancellation too —
 * the alternative, a build that survives the request that started it, is the
 * orphan this option exists to prevent. */
/* `withLint` (npm only) also installs the lint's abaplint with the runtime,
 * so the next deploy_app lints without an install of its own; abap2ui5-unit,
 * which does not lint, leaves it out. */
/* `beforeBuild` (async) runs once the build is really starting - after the
 * in-flight check and the plan's refusal, before any step. build_backend
 * stops the running backend there: stopped before those checks, a call that
 * was refused (a build of another mode in progress) had still taken the
 * running app down. A caller that joins the in-flight build does not run it. */
/**
 * The build a mode asks for, given what is there: `{ effective }`, or with
 * `problem` - the sentence the build answers instead of starting. Pure; the
 * whole matrix (backend kind x mode) is pinned in test/npm-runtime.test.mjs.
 *   kind          backendKind() - checkout | npm | missing | clone
 *   a2            the checkout, when there is one
 *   canIncrement  a prior build in that checkout
 *   canClone      no checkout and no A2UI5_HOME - prebuilt/transpile may clone
 *   corpus        the samples-controls checkout, when there is one
 *   envName       the A2UI5_HOME-style variable that is set, if any
 *   preference    A2UI5_MCP_BACKEND (backendPreference) - under `npm` the
 *                 package stays the backend in use whatever a build makes,
 *                 so a checkout build (prebuilt, transpile, full) is refused
 *                 the way mode npm is refused beside a checkout in use
 */
export function planBuild({ mode = 'auto', kind, a2 = null, canIncrement = false, canClone = false, corpus = null, envName = null, preference = null }) {
  let effective = mode;
  if (mode === 'auto') {
    effective = kind === 'npm' ? 'npm' : (canIncrement ? 'incremental' : (a2 || canClone ? 'prebuilt' : 'full'));
  } else if (mode === 'incremental' && kind === 'npm') {
    effective = 'npm'; // the npm build transpiles the sandbox alone anyway
  }
  const problem = (text) => ({ effective, problem: text });
  if (effective === 'npm' && kind !== 'npm') return problem(npmModeProblem(kind, { a2, envName }));
  const unserved = npmPreferenceProblem({ mode: effective, a2, preference });
  if (unserved) return problem(unserved);
  if ((effective === 'incremental' || ((effective === 'transpile' || effective === 'prebuilt') && !canClone)) && !a2) {
    return problem(`abap2UI5 checkout not found${envName ? ` (${envName} is set and does not point at one)` : ''} — clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server (or run \`npm run node:setup\` in samples-controls), or point A2UI5_HOME at an existing checkout; then run build_backend again (mode prebuilt needs nothing else)`);
  }
  if (effective === 'incremental' && !canIncrement) {
    return problem('incremental build needs a prior build (node/downport + node/output missing) — run mode:prebuilt (a download, needs only the abap2UI5 checkout) or mode:full (tens of minutes, needs samples-controls) first');
  }
  if (effective === 'full' && !corpus) {
    return problem('a full build runs samples-controls\' scripts/e2e-build.mjs — clone https://github.com/abap2UI5/samples-controls as a sibling of mcp-server or point SAMPLES_CONTROLS_HOME at a checkout; or run mode:prebuilt, which downloads the framework\'s released backend and needs only the abap2UI5 checkout');
  }
  return { effective };
}

export function buildBackend({ onLine, mode = 'auto', signal, withLint = true, beforeBuild = null } = {}) {
  let a2 = a2Local();
  const corpusDir = resolveSamplesControls({ local: true });
  const kind = backendKind();
  /* No framework checkout and nothing configured: prebuilt and transpile can
   * make one - a shallow clone of the release into the workspace
   * (cloneFramework). A set A2UI5_HOME that points nowhere is a
   * misconfiguration, never a reason to clone somewhere else. */
  const plan = planBuild({
    mode,
    kind,
    a2,
    canIncrement: Boolean(kind === 'checkout' && a2 && fs.existsSync(path.join(a2, 'node/downport')) && checkoutBuilt(a2)),
    canClone: !a2 && !explicitEnv('a2ui5'),
    corpus: corpusDir,
    envName: explicitEnv('a2ui5'),
    preference: backendPreference(),
  });
  const effective = plan.effective;
  const incremental = effective === 'incremental';
  const prebuilt = effective === 'prebuilt';
  const transpile = effective === 'transpile';
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
  if (plan.problem) return Promise.resolve({ ok: false, code: 1, tail: plan.problem });
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
      if (beforeBuild) await beforeBuild();
      let cmd;
      let cmdArgs;
      let cwd;
      if (effective === 'npm') {
        const res = await buildNpm({ inputDir: sandbox().dir, withLint, onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (res.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'npm build cancelled by the client — its process tree was killed'].join('\n') });
        }
        if (res.timedOut) {
          return finish({ ok: false, code: null, mode: effective, timedOut: true, tail: [...tail, res.reason].join('\n') });
        }
        if (!res.ok) keepLine(`npm build: ${res.reason}`);
        return finish({
          ok: res.ok,
          code: res.ok ? 0 : 1,
          mode: effective,
          ...(res.version ? { runtime: res.version } : {}),
          ...(res.missing ? { releaseMissing: true } : {}),
          tail: tail.join('\n'),
        });
      }
      if ((prebuilt || transpile) && !a2) {
        const cloned = await cloneFramework({ onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (cloned.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'clone cancelled by the client'].join('\n') });
        }
        if (!cloned.ok) return finish({ ok: false, code: 1, mode: effective, tail: tail.join('\n') });
        a2 = cloned.dir;
      }
      if (prebuilt) {
        const res = await downloadPrebuilt({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (res.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'prebuilt download cancelled by the client'].join('\n') });
        }
        /* No asset for this version and the caller left the choice to auto:
         * the framework's own build is minutes, not the corpus' tens of
         * minutes, so it is taken - said in the log, never silently. */
        if (!res.ok && mode === 'auto' && /^HTTP 404/.test(res.reason || '')) {
          keepLine('prebuilt backend: no asset for this version - building the framework itself instead (mode transpile, a few minutes)');
          const built = await transpileFramework({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
          if (built.aborted) {
            return finish({ ok: false, code: null, mode: 'transpile', aborted: true, tail: [...tail, 'transpile cancelled by the client'].join('\n') });
          }
          return finish({ ok: built.ok, code: built.ok ? 0 : 1, mode: 'transpile', tail: tail.join('\n') });
        }
        return finish({ ok: res.ok, code: res.ok ? 0 : 1, mode: effective, tail: tail.join('\n') });
      }
      if (transpile) {
        const built = await transpileFramework({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (built.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'transpile cancelled by the client'].join('\n') });
        }
        return finish({ ok: built.ok, code: built.ok ? 0 : 1, mode: effective, tail: tail.join('\n') });
      }
      if (incremental) {
        // checked first: nothing is copied or cloned for a build that cannot run
        const transpiler = localBin(a2, '@abaplint/transpiler-cli', 'abap_transpile');
        if (!transpiler) {
          keepLine(missingBinMessage(a2, '@abaplint/transpiler-cli', 'abap_transpile'));
          return finish({ ok: false, code: 1, mode: effective, tail: tail.join('\n') });
        }
        // the deployed dev apps, from whichever sandbox is in use - and the
        // copies of apps removed (or test includes dropped) since, taken out
        const synced = syncDevCopies(a2);
        if (synced.removed.length) keepLine(`removed from node/downport (no longer deployed): ${synced.removed.join(', ')}`);
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
           * `;` in a path was the shell's to read. spawn passes each one
           * whole.
           *
           * And spawned, not execFileSync: the synchronous call froze the
           * whole stdio server for the length of the clone (no other
           * request, no cancellation answered), could not be killed by the
           * client's cancel or the shutdown, and a failure threw past
           * finish( ), so build_log kept the previous build's record. A
           * step that fails takes the clone with it - an unpatched or half
           * clone would otherwise be reused as the corpus' one next time. */
          const steps = [
            { what: 'git clone open-abap-core', cmd: 'git', args: ['clone', '--quiet', '--depth=1', 'https://github.com/open-abap/open-abap-core', lib] },
            ...(corpusDir ? [{ what: 'patch_open_abap_xml.mjs', cmd: process.execPath, args: [path.join(corpusDir, 'web/ci/patch_open_abap_xml.mjs'), lib] }] : []),
          ];
          for (const step of steps) {
            const res = await spawnWithTimeout(step.cmd, step.args, { cwd: a2, timeoutMs: buildTimeout, onLine: keepLine, signal });
            if (res.aborted || res.timedOut || res.code !== 0) fs.rmSync(lib, { recursive: true, force: true });
            if (res.aborted) {
              return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, `${step.what} cancelled by the client`].join('\n') });
            }
            if (res.timedOut) {
              return finish({ ok: false, code: null, mode: effective, timedOut: true, tail: [...tail, timedOutError(step.what, 'A2UI5_MCP_BUILD_TIMEOUT_MS')].join('\n') });
            }
            if (res.code !== 0) {
              keepLine(`${step.what} exited ${res.code}${res.stderr ? ` - ${res.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
              return finish({ ok: false, code: res.code ?? 1, mode: effective, tail: tail.join('\n') });
            }
          }
          if (!corpusDir) {
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
        cmd = process.execPath;
        cmdArgs = [transpiler, './e2e-transpile.json'];
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

/** Is the backend in use built - a checkout's node/output, or the npm
 *  release's apps/ (a build of the dev apps on it)? */
export function backendBuilt() {
  if (backendKind() === 'npm') return appsBuilt(npmRuntimeDir());
  return checkoutBuilt(a2Local());
}

function checkoutBuilt(a2) {
  return Boolean(a2 && fs.existsSync(path.join(a2, 'node/output/init.mjs')));
}

/* The file whose mtime says when the served backend was built:
 * node/output/init.mjs of a checkout, apps/init.mjs of the npm release. */
function builtMarkerFile() {
  if (backendKind() === 'npm') {
    const dir = npmRuntimeDir();
    return dir ? path.join(appsDir(dir), 'init.mjs') : null;
  }
  const a2 = a2Local();
  return a2 ? path.join(a2, 'node', 'output', 'init.mjs') : null;
}

/** Why a checkout build (mode prebuilt, transpile or full) cannot be the
 *  backend in use under A2UI5_MCP_BACKEND=npm, or null: the package stays
 *  the backend whatever the build makes. The mirror of npmModeProblem. */
export function npmPreferenceProblem({ mode, a2 = a2Local(), preference = backendPreference() } = {}) {
  if (preference !== 'npm' || !['prebuilt', 'transpile', 'full'].includes(mode)) return null;
  return `A2UI5_MCP_BACKEND=npm makes ${RUNTIME_PKG} the backend in use, so mode ${mode} would build `
    + `${a2 ? `the checkout ${a2}` : 'a framework clone'} into a backend nothing serves - build with mode auto (or npm), `
    + `or unset A2UI5_MCP_BACKEND to run on ${a2 ? 'that checkout' : 'the clone mode prebuilt makes'}`;
}

/** Why a build in mode npm cannot be the backend in use right now, or null. */
export function npmModeProblem(kind = backendKind(), { a2 = a2Local(), envName = explicitEnv('a2ui5') } = {}) {
  if (kind === 'npm') return null;
  if (kind === 'checkout') {
    return `the framework checkout ${a2} is the backend in use, so mode npm would build a backend nothing serves - `
      + `set A2UI5_MCP_BACKEND=npm to run on ${RUNTIME_PKG} beside the checkout, or build with mode auto`;
  }
  if (kind === 'missing') return `${envName} is set and points at no abap2UI5 checkout - fix it, or unset it to run on ${RUNTIME_PKG}`;
  return `A2UI5_MCP_BACKEND=clone chooses the framework clone - unset it (or set it to npm) to run on ${RUNTIME_PKG}`;
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

/* The framework repository and where its releases are asked for.
 *
 * NOT `releases/latest`: the framework publishes every version twice, the
 * release (`1.145.0`, which carries backend-1.145.0.tar.gz) and its 7.02
 * downport (`1.145.0-702`, published seconds later, no asset). GitHub's
 * "latest" is simply the newest, so it named the downport, and the clone got
 * downported sources that no prebuilt backend exists for. The list is read
 * instead and the highest plain X.Y.Z release is taken (latestPlainRelease). */
const FRAMEWORK_REPO = 'https://github.com/abap2UI5/abap2UI5';
const FRAMEWORK_RELEASES = 'https://api.github.com/repos/abap2UI5/abap2UI5/releases?per_page=100';

/** The highest plain `X.Y.Z` (or `vX.Y.Z`) tag among GitHub releases -
 *  never a draft, a prerelease or a suffixed tag like `1.145.0-702`. Pure. */
export function latestPlainRelease(releases) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue;
    const tag = String(r.tag_name || '');
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!m) continue;
    const v = m.slice(1).map(Number);
    const i = best ? v.findIndex((n, j) => n !== best.v[j]) : -1;
    if (!best || (i >= 0 && v[i] > best.v[i])) best = { tag, v };
  }
  return best ? best.tag : null;
}

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
export async function cloneFramework({ onLine = () => {}, signal, timeoutMs = 30 * 60_000, fetchImpl = globalThis.fetch, tag: wanted = null } = {}) {
  const dir = frameworkCloneDir();
  if (fs.existsSync(path.join(dir, 'node/srv/express.mjs'))) {
    /* A clone that is there but on another release than the one asked for
     * (the CI runner asks for the project's pin) is replaced: a backend
     * built from the wrong framework tests the wrong framework. */
    if (!wanted || readVersion(dir) === wanted) return { ok: true, dir, existed: true, tag: readVersion(dir) };
    onLine(`clone: ${dir} is abap2UI5 ${readVersion(dir)}, ${wanted} was asked for - replacing it`);
  }
  let tag = wanted;
  if (!tag) try {
    const res = await fetchImpl(FRAMEWORK_RELEASES, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'abap2ui5-mcp-server' } });
    if (res.ok) {
      tag = latestPlainRelease(JSON.parse(await readCappedText(res, FRAMEWORK_RELEASES)));
      if (!tag) onLine('clone: no X.Y.Z release among the framework\'s releases — cloning the default branch instead');
    } else onLine(`clone: GitHub answered ${res.status} for the release list — cloning the default branch instead`);
  } catch (e) {
    onLine(`clone: the latest release could not be looked up (${String((e && e.message) || e)}) — cloning the default branch instead`);
  }
  if (signal && signal.aborted) return { ok: false, aborted: true, dir };
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

/** The version a checkout's package.json names, or null. */
export function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/*
 * The framework's own build, in its checkout: what backend-prebuilt.yaml
 * runs to make the asset, run here when there is none. `npm ci` first when
 * the checkout has no node_modules (the transpiler and abaplint are its
 * devDependencies; express, which the served backend needs, too). Narrated
 * through onLine; never rejects.
 */
export async function transpileFramework({ a2, onLine = () => {}, signal, timeoutMs = 30 * 60_000 } = {}) {
  const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  const steps = [];
  if (!fs.existsSync(path.join(a2, 'node_modules', '@abaplint', 'transpiler-cli'))) {
    steps.push({ what: 'npm ci', args: ['ci', '--no-audit', '--no-fund'] });
  }
  steps.push({ what: 'npm run downport', args: ['run', 'downport'] });
  steps.push({ what: 'npm run auto_transpile', args: ['run', 'auto_transpile'] });
  for (const d of ['node/output', PREBUILT_MANIFEST]) fs.rmSync(path.join(a2, d), { recursive: true, force: true });
  for (const step of steps) {
    onLine(`transpile: ${step.what} in ${a2}`);
    /* spawnNpm: on Windows npm is npm.cmd, which spawn runs through cmd.exe
     * or not at all - a bare npm spawn failed there with ENOENT */
    const res = await spawnNpm(step.args, { cwd: a2, env, timeoutMs, onLine, signal });
    if (res.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    if (res.timedOut) {
      onLine(`transpile: ${timedOutError(step.what, 'A2UI5_MCP_BUILD_TIMEOUT_MS')}`);
      return { ok: false, reason: 'timeout' };
    }
    if (res.code !== 0) {
      onLine(`transpile: ${step.what} exited ${res.code} — ${(res.stderr || res.stdout || '').slice(-400)}`);
      return { ok: false, reason: `${step.what} exited ${res.code}` };
    }
  }
  if (!fs.existsSync(path.join(a2, 'node/output/init.mjs'))) {
    onLine('transpile: finished, but node/output/init.mjs is not there');
    return { ok: false, reason: 'no node/output after the transpile' };
  }
  onLine(`transpile: abap2UI5 ${readVersion(a2) || ''} built in ${a2}`);
  return { ok: true };
}

/* The manifest the archive carries at its root, kept beside the checkout's
 * package.json after unpacking (the framework gitignores it). */
export const PREBUILT_MANIFEST = 'backend-manifest.json';

/* The most the prebuilt archive may be. backend-1.146.0.tar.gz is 2.7 MB
 * (1.145.0: 2.7 MB too) - the framework transpiled, its downport and
 * open-abap-core, compressed; 200 MB leaves it room to grow seventyfold. A
 * download was bounded by the build timeout only, so a proxy or a mirror
 * (A2UI5_MCP_PREBUILT_URL) answering with an endless body filled the temp
 * disk for half an hour. One that declares more is refused unread, one that
 * streams more is cut at the cap; the previous build stays either way. */
export const PREBUILT_MAX_BYTES = 200 * 1024 * 1024;

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
export async function downloadPrebuilt({ a2, onLine = () => {}, signal, timeoutMs = 30 * 60_000, fetchImpl = globalThis.fetch, maxBytes = PREBUILT_MAX_BYTES } = {}) {
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
  let out = null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.any(signals), headers: { 'User-Agent': 'abap2ui5-mcp-server' }, redirect: 'follow' });
    if (!res.ok) {
      onLine(`prebuilt backend: HTTP ${res.status} — release ${version} carries no backend-${version}.tar.gz `
        + '(the asset is attached by the framework\'s backend-prebuilt workflow a while after the release; '
        + 'a checkout on an unreleased commit has no asset at all: run mode:full, or check out the release tag)');
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const total = declaredLength(res) || 0;
    if (total > maxBytes) {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
      throw tooLargeError(url, maxBytes);
    }
    out = fs.createWriteStream(file);
    let got = 0;
    let lastTenth = -1;
    for await (const chunk of res.body) {
      got += chunk.length;
      // leaving the loop by the throw cancels the download (catch below)
      if (got > maxBytes) throw tooLargeError(url, maxBytes);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
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
      const ci = await spawnNpm(['ci', '--no-audit', '--no-fund'], { cwd: a2, timeoutMs, onLine, signal, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
      if (ci.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
      if (ci.code !== 0) {
        onLine(`prebuilt backend: npm ci exited ${ci.code} — ${(ci.stderr || '').slice(-300)}`);
        return { ok: false, reason: `npm ci exited ${ci.code}` };
      }
    }
    onLine(`prebuilt backend ${manifest.version || version} (${manifest.commit || 'unknown commit'}, built ${manifest.builtAt || 'unknown'}) unpacked into ${a2}`);
    return { ok: true, manifest };
  } catch (e) {
    /* A download that died mid-stream leaves the file open; closed here so
     * the cleanup below can remove it (Windows refuses an open file) - and
     * waited for: a stream still opening its file when the download is cut
     * (the size cap on the first chunk) opened it after the cleanup had
     * removed the directory, an ENOENT 'error' nobody listened for. */
    if (out) {
      out.on('error', () => {});
      out.destroy();
      if (!out.closed) await new Promise((r) => out.once('close', r));
    }
    if (signal && signal.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    const message = String((e && e.message) || e);
    onLine(`prebuilt backend: ${message}`);
    return { ok: false, reason: message };
  } finally {
    // best effort: a temp dir that will not go must not turn a reported
    // failure into a rejection this function promises never to produce
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in tmp */ }
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
    if (shotDirProblem({ create: true })) return;
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
      if (shotDirProblem()) return null;
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
/* What the npm host said about itself when it started (release, dev
 * modules, accelerate, compression) - reported while it runs. */
let hostBanner = null;

/* The npm backend's host: shipped in this package, resolved beside this file
 * so an npx install finds it where the server itself is. */
const NPM_HOST = fileURLToPath(new URL('./npm-host.mjs', import.meta.url));

export function backendStatus() {
  const kind = backendKind();
  const running = Boolean(server && server.exitCode === null);
  if (kind === 'npm') {
    const cur = currentRuntimeVersion();
    return {
      backend: 'npm',
      runtime: cur ? cur.version : null,
      runtimeDir: cur ? runtimeDir(cur.version) : null,
      built: backendBuilt(),
      running,
      port: PORT,
      ...(running && hostBanner ? { host: hostBanner } : {}),
    };
  }
  const manifest = prebuiltManifest();
  return {
    backend: kind,
    a2ui5: a2Local(),
    built: backendBuilt(),
    ...(manifest ? { prebuilt: { version: manifest.version, commit: manifest.commit, builtAt: manifest.builtAt } } : {}),
    running,
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
/* The child of the start in flight, until it listens (then it is `server`).
 * Only the server's shutdown reaches it (stopBackend({ starting: true })):
 * a shutdown during a start used to exit with this child untracked, and it
 * went on to listen - an orphan holding the port for the next session. */
let startingChild = null;

export function startBackend() {
  /* A start during build_backend booted the output from BEFORE the build:
   * the build stops the backend once, when it begins, and reported built
   * while the process it never saw went on serving the old classes - under
   * the same pid, so the restart check kept its sessions current too. */
  if (building) return Promise.reject(new Error('build_backend is running — start the app once it has finished (the backend would serve the output from before the build)'));
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
  let cmd;
  let args;
  if (backendKind() === 'npm') {
    // the npm release's host: the package booted, the dev apps registered
    const dir = npmRuntimeDir();
    if (!dir || !appsBuilt(dir)) throw new Error(`backend not built — call build_backend first (it installs ${RUNTIME_PKG} and transpiles the deployed apps)`);
    cmd = process.execPath;
    args = [NPM_HOST, dir];
  } else {
    const a2 = a2Local();
    if (!a2) throw new Error('abap2UI5 checkout not found — run `npm run node:setup` or set A2UI5_HOME');
    if (!backendBuilt()) throw new Error('backend not built — call the build tool (or `npm run node:build`) first');
    cmd = 'node';
    args = [path.join(a2, 'node/srv/express.mjs')];
  }
  hostBanner = null;
  let child = null;
  await new Promise((resolve, reject) => {
    /* HOST: the framework's node/srv/express.mjs binds EVERY interface when
     * it is unset ("what the e2e runner and a container need"), so the dev
     * backend - every deployed app, run by anyone who can reach the port -
     * listened on the LAN beside a checkout, while the npm host binds
     * 127.0.0.1. Loopback is all run_app and the app tools connect to; a
     * HOST the user's shell exports (a host name) is overridden for the
     * same reason. An express.mjs from before HOST ignores it. */
    const srv = spawn(cmd, args, {
      env: { ...process.env, PORT: String(PORT), HOST: BACKEND_HOST },
      windowsHide: true, // no console window of its own on Windows (lib/spawn.mjs)
    });
    child = srv;
    startingChild = srv;
    let out = '';
    const onData = (d) => {
      out += d;
      if (/Listening on/.test(out)) {
        srv.stdout.off('data', onData);
        const banner = /^abap2ui5 npm host: (.*)$/m.exec(out);
        hostBanner = banner ? banner[1] : null;
        server = srv;
        resolve();
      }
    };
    srv.stdout.on('data', onData);
    /* Kept only until the backend listens - the output is what a failed
     * start reports. It used to be appended for the backend's whole life,
     * so every stack trace a long session's backend printed stayed in this
     * process's memory. Still read after that, so the pipe never fills. */
    srv.stderr.on('data', (d) => {
      if (server !== srv) out += d;
    });
    /* A child that cannot be spawned at all (no `node` on the PATH a desktop
     * client hands its servers) emits 'error' and neither 'exit' nor
     * 'close': without this listener that was an uncaught exception, and
     * the start then waited out its 30 s to report an empty output. */
    srv.on('error', (e) => {
      if (server !== srv) reject(new Error(`backend could not be started (${cmd}): ${(e && e.message) || e}`));
    });
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
  }).finally(() => {
    if (startingChild === child) startingChild = null;
  });
  await waitPort(PORT);
  return backendStatus();
}

/* `starting` (the server's shutdown): also kill the child of a start that
 * has not listened yet - `server` is only set once it does. */
export async function stopBackend({ starting = false } = {}) {
  await closeBrowser();
  if (server && server.exitCode === null) {
    server.kill();
    server = null;
  }
  if (starting && startingChild && startingChild.exitCode === null) startingChild.kill();
  return backendStatus();
}

/* The app_* tools (lib/appclient.mjs) speak to the backend over HTTP, the
 * way the browser does - at the address it binds, never at localhost
 * (BACKEND_HOST). */
export const backendBaseUrl = () => `http://${BACKEND_HOST}:${PORT}/`;

/** Which backend PROCESS is serving (its pid), or null. A draft lives in the
 *  process that wrote it: a session started under another one is gone. */
export function backendGeneration() {
  return server && server.exitCode === null ? server.pid : null;
}

/* An app class in the transpiled output: a module that defines the
 * interface method itself (`async z2ui5_if_app$main(`) - a mention of the
 * interface (the handler calls it) is no app. */
const APP_MAIN = /async\s+z2ui5_if_app\$main\s*\(/;

function appModulesIn(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.clas.mjs'));
  } catch {
    return [];
  }
  return names
    .filter((f) => {
      try {
        return APP_MAIN.test(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return false;
      }
    })
    .map((f) => f.replace(/\.clas\.mjs$/, '').toUpperCase());
}

/*
 * The app classes the built backend can start (app_list): the deployed dev
 * apps and the framework's own (its popups, the startup app). Read from the
 * transpiled output, not from the sandbox - an app deployed after the last
 * build is not startable yet, and saying so is the point.
 *   npm:      apps/ (the dev apps) + the package's output/ (the framework)
 *   checkout: node/output/, the dev copies listed by the incremental build
 *             as dev, everything else framework
 */
export function builtAppClasses() {
  if (!backendBuilt()) return null;
  let devNames;
  try {
    devNames = new Set(listDevApps().map((c) => String(c).toUpperCase()));
  } catch {
    devNames = new Set(); // no sandbox resolves: nothing was deployed
  }
  if (backendKind() === 'npm') {
    const dir = npmRuntimeDir();
    const dev = appModulesIn(appsDir(dir));
    const framework = appModulesIn(path.join(dir, 'node_modules', ...RUNTIME_PKG.split('/'), 'output'));
    return [
      ...dev.map((app) => ({ app, source: 'dev' })),
      ...framework.filter((a) => !dev.includes(a)).map((app) => ({ app, source: 'framework' })),
    ];
  }
  const a2 = a2Local();
  return appModulesIn(path.join(a2, 'node', 'output')).map((app) => ({ app, source: devNames.has(app) ? 'dev' : 'framework' }));
}

/* Asked at BACKEND_HOST: http.get's default host is the name localhost,
 * which can be ::1 - another process's port, or no answer at all. `get` is
 * http.get, injectable for the test. */
export function waitPort(port, ms = 30000, { get = http.get } = {}) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = get({ host: BACKEND_HOST, port, path: '/', timeout: 1000 }, (r) => {
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

/*
 * Which Chromium, in this order:
 *   1. A2UI5_MCP_CHROMIUM, then CHROMIUM_BIN (the linter's variable, so one
 *      setting serves validate_view and run_app) - an explicit choice;
 *   2. the browser Playwright itself manages (PLAYWRIGHT_BROWSERS_PATH, or
 *      its per-user cache after `npx playwright install chromium`);
 *   3. a system binary - /usr/bin/chromium(-browser), and LAST the
 *      /opt/pw-browsers/chromium link some sandbox images carry.
 * The third list is a fallback for machines without the managed download;
 * it used to be the only thing setup_status looked at, so a machine with a
 * perfectly good Playwright-managed browser was reported as having none.
 */
const SYSTEM_CHROMIUMS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium'];

/** Playwright's own executable path for its managed Chromium, or null when
 *  playwright is not installed. Synchronous (setup_status is). */
function playwrightChromiumPath() {
  try {
    return createRequire(import.meta.url)('playwright').chromium.executablePath() || null;
  } catch {
    return null;
  }
}

/** The Chromium run_app would launch, as { path, source, exists }, or null. */
export function resolveChromium({ env = process.env, exists = fs.existsSync, managed = playwrightChromiumPath } = {}) {
  for (const v of ['A2UI5_MCP_CHROMIUM', 'CHROMIUM_BIN']) {
    if (env[v]) return { path: env[v], source: v, exists: exists(env[v]) };
  }
  const own = managed();
  if (own && exists(own)) return { path: own, source: 'playwright', exists: true };
  const sys = SYSTEM_CHROMIUMS.find((c) => exists(c));
  if (sys) return { path: sys, source: 'system', exists: true };
  return null;
}

async function launchChromium() {
  const { chromium } = await import('playwright');
  const explicit = process.env.A2UI5_MCP_CHROMIUM || process.env.CHROMIUM_BIN;
  if (explicit) return chromium.launch({ executablePath: explicit });
  try {
    return await chromium.launch();
  } catch (e) {
    for (const cand of SYSTEM_CHROMIUMS) {
      if (fs.existsSync(cand)) return chromium.launch({ executablePath: cand });
    }
    throw e;
  }
}

/* One Chromium for run_app and interact_app - but only while it is alive.
 * The promise used to be kept for the server's whole life: a browser that
 * crashed or was killed (an OOM kill, a closed display) was handed out
 * again, every run_app after it failed on "browser has been closed" until
 * the server restarted, and a launch that failed (no Chromium yet) stayed
 * the answer after `npx playwright install chromium` had fixed it. A
 * disconnected browser and a rejected launch now clear the slot, so the next
 * call launches afresh. Exported for the test (`launch` injects the launcher). */
export async function getBrowser({ launch = launchChromium } = {}) {
  if (!browserPromise) {
    const p = Promise.resolve().then(launch);
    browserPromise = p;
    const clear = () => {
      if (browserPromise === p) browserPromise = null;
    };
    p.then((b) => {
      if (b && typeof b.on === 'function') b.on('disconnected', clear);
      if (b && typeof b.isConnected === 'function' && !b.isConnected()) clear();
    }, clear);
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
 * The browser context an app boots in.
 *
 * The framework's page carries a hash-only Content-Security-Policy: the one
 * inline bootstrap it ships is allowed by its hash, and nothing else inline
 * is. The CDN's sap-ui-core.js is the BUILT file and needs nothing more; the
 * @openui5 packages this server serves locally (libRoots) are SOURCES, and
 * source sap-ui-core.js document.write()s inline scripts to load the core,
 * which that policy blocks - so run_app with a corpus beside it never booted
 * (a boot timeout, the CSP violation only in the console). bypassCSP is set
 * exactly then: with UI5 from the CDN the app boots under the framework's own
 * policy, which is the one a real system serves.
 */
export function appContextOptions() {
  return {
    viewport: { width: 1280, height: 800 },
    ...(libRoots().length ? { bypassCSP: true } : {}),
  };
}

/* UI5 is up and has rendered more than three controls - the e2e-smoke gate.
 * The options go in the THIRD argument: waitForFunction(fn, arg, options),
 * and passing { timeout } second handed it to the page function as its arg
 * while the wait kept Playwright's default 30 s - so timeout_ms was ignored
 * in both directions (a slow boot was cut at 30 s, a quick fail waited 30 s). */
export function waitForBoot(page, timeoutMs) {
  return page.waitForFunction(
    () => window.sap && window.sap.ui && document.querySelectorAll('[data-sap-ui]').length > 3,
    undefined,
    { timeout: timeoutMs },
  );
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
  const ctx = await browser.newContext(appContextOptions());
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
    if (!isBackendUrl(r.url()) || r.status() < 400) return;
    const u = new URL(r.url());
    errors.push(`backend HTTP ${r.status()} for ${u.pathname}${u.search.slice(0, 60)}`);
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
    await page.goto(appStartUrl(cls), {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await waitForBoot(page, timeoutMs);
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
  /* A screenshot dir that is not the user's own keeps the picture in the
   * answer only: the PNG is still returned, just not saved there. */
  let notSaved = null;
  try {
    notSaved = shotDirProblem({ create: true });
  } catch (e) {
    notSaved = `${shotDir()} cannot be created (${(e && e.code) || e})`;
  }
  const screenshotPath = notSaved ? null : path.join(shotDir(), `${cls}${suffix}.png`);
  let base64 = null;
  try {
    const buf = await page.screenshot({ ...(screenshotPath ? { path: screenshotPath } : {}), fullPage });
    base64 = buf.toString('base64');
  } catch (e) {
    errors.push('screenshot: ' + String(e.message).slice(0, 200));
  }
  if (signal) signal.removeEventListener('abort', onAbort);
  await ctx.close();
  return { class: cls, booted, ok: booted && errors.length === 0, errors, screenshotPath, base64, ...(notSaved ? { screenshotNotSaved: notSaved } : {}) };
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
export function locate(page, step) {
  if (step.id) return page.locator(`[id="${cssAttr(step.id)}"], [id$="--${cssAttr(step.id)}"]`).first();
  if (step.selector) return page.locator(step.selector).first();
  if (step.text) return page.getByText(step.text, { exact: true }).first();
  return null;
}

export async function performAction(page, step, timeout) {
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
      /* Within the action's timeout: without one the look waits Playwright's
       * own default (30 s) for an element that is not there, and a fill of
       * a wrong id took that long before the fill's own timeout even began.
       * An element that never appeared fails the action here, as it would
       * in the fill. */
      const editable = await loc.evaluate((el) => ['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable, undefined, { timeout })
        .catch((e) => {
          if (e && e.name === 'TimeoutError') throw e;
          return false;
        });
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

/* A frame of a test include's module in the stack the runner prints with a
 * failure: `at [async ][new ][<class>.][#]<method> (<dir>/<object>.clas.testclasses.mjs:L:C)`. */
const TEST_FRAME = /^\s*at (?:async )?(new )?(?:([A-Za-z0-9_$]+)\.)?#?([A-Za-z0-9_$]+) \((?:[^()]*[\\/])?([^\\/()]+)\.clas\.testclasses\.mjs:\d+:\d+\)\s*\{?\s*$/;

/* What a test class runs BEFORE the runner prints a test's "running" line:
 * class_setup ahead of the class's first line, the constructor and setup
 * ahead of each method's. A failure in one of them belongs to the test that
 * had not started - never to the one whose line was printed last. */
const BEFORE_THE_LINE = new Set(['class_setup', 'constructor', 'constructor_', 'setup']);

/** A failure in a test class's fixture, read off the stack: `{ object,
 *  localClass, method, fixture: true }`, or null when the test that was
 *  running is on the stack (its own failure) or no fixture is. Pure. */
function fixtureFailure(lines, last) {
  const frames = [];
  for (const line of lines) {
    const m = TEST_FRAME.exec(line);
    if (!m) continue;
    let object = m[4];
    try {
      object = decodeURIComponent(object);
    } catch {
      /* not escaped */
    }
    frames.push({ object: object.replace(/#/g, '/').toUpperCase(), localClass: m[1] ? m[3] : (m[2] || null), method: m[1] ? 'constructor' : m[3] });
  }
  if (last && frames.some((f) => f.object === last.object && f.method.toLowerCase() === last.method.toLowerCase())) return null;
  const f = frames.find((x) => BEFORE_THE_LINE.has(x.method.toLowerCase()));
  return f ? { ...f, fixture: true } : null;
}

/** The runner's output as test results: what ran, what was skipped, and the
 *  failing test with its error when the run stopped - or, when the stack
 *  says a test class's class_setup, constructor or setup threw, that
 *  class's fixture (`fixture: true`). Pure, for the tests. */
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
    } else if (line.trim()) {
      after.push(line);
    }
  }
  const ran = tests.filter((t) => !t.skipped);
  let failed = null;
  if (code !== 0) {
    const error = after.join('\n').trim().slice(0, 2000);
    const fixture = fixtureFailure(after, last);
    if (fixture) failed = { ...fixture, error };
    else if (last && !last.skipped) failed = { ...last, error };
  }
  return { ok: code === 0, ran: ran.length, skipped: tests.length - ran.length, tests, failed };
}

/**
 * Run the transpiled ABAP Unit tests: all of them, or the test classes of
 * one object. Needs a built backend. Resolves with the parsed results (see
 * parseUnitOutput) plus how the run ended.
 */
/** The generated runner's text, filtered to the objects named (upper case).
 *  Pure; null when the runner has not got the loop line the filter hooks. */
export function filteredRunner(src, names) {
  if (!src.includes(RUNNER_LOOP)) return null;
  const set = JSON.stringify(names.map((n) => String(n).toUpperCase()));
  return src.replace(RUNNER_LOOP, `for (const st of getData().filter((st) => ${set}.includes(st.objectName))) {`);
}

let runnerCopies = 0;

export async function runUnitTests({ className, classNames, signal, onLine, appsDir: ownApps = null } = {}) {
  /* Where the runner is. A checkout: node/output/index.mjs, the transpiler's
   * runner over the WHOLE tree, the framework's own suite included. The npm
   * backend: apps/index.mjs, the runner the transpiler wrote for the dev apps
   * alone (it lists no library object's tests) - booted through apps/init.mjs
   * on the package's runtime. The package's own output/index.mjs is the
   * framework's suite and is never run here. `appsDir` names another build
   * of the npm backend's (abap2ui5-unit builds a project into a directory of
   * its own inside the runtime directory). */
  let base;
  let node = 'node';
  if (ownApps) {
    if (!fs.existsSync(path.join(ownApps, 'init.mjs'))) throw new Error(`no build in ${ownApps} - build it first`);
    base = { cwd: path.dirname(ownApps), out: ownApps };
    node = process.execPath;
  } else if (backendKind() === 'npm') {
    const dir = npmRuntimeDir();
    if (!dir || !appsBuilt(dir)) throw new Error(`backend not built — call build_backend (it installs ${RUNTIME_PKG} and transpiles the deployed apps) before run_unit_tests`);
    base = { cwd: dir, out: appsDir(dir) };
    node = process.execPath;
  } else {
    const a2 = a2Local();
    if (!a2) throw new Error('abap2UI5 checkout not found — clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server or point A2UI5_HOME at an existing checkout');
    if (!backendBuilt()) throw new Error('backend not built — call build_backend (mode prebuilt or full the first time) before run_unit_tests');
    base = { cwd: a2, out: path.join(a2, 'node/output') };
  }
  const runner = path.join(base.out, 'index.mjs');
  if (!fs.existsSync(runner)) {
    throw new Error(`the built backend has no ${runner} — it was transpiled without write_unit_tests; run build_backend again`);
  }
  const wanted = [...(classNames || []), ...(className ? [className] : [])].map((c) => classNameOf(c).toUpperCase());
  const cls = wanted.length === 1 ? wanted[0] : null;
  let entry = runner;
  let tmpEntry = null;
  let filtered = false;
  if (wanted.length) {
    const patched = filteredRunner(fs.readFileSync(runner, 'utf8'), wanted);
    if (patched) {
      /* A name of this RUN's: it used to be the selection's alone, and two
       * runs at once over different class sets wrote one file - the first
       * child loaded the second call's filter, and the first call to finish
       * deleted the file under the other. Beside the runner, for its
       * relative imports. */
      runnerCopies += 1;
      tmpEntry = path.join(base.out, `index-mcp-${(cls || 'selection').toLowerCase()}-${process.pid}-${runnerCopies}.mjs`);
      fs.writeFileSync(tmpEntry, patched);
      entry = tmpEntry;
      filtered = true;
    } else if (onLine) {
      onLine('the generated runner has an unexpected shape — running every test and filtering the report');
    }
  }
  let spawned;
  try {
    /* V8 keeps ten frames of a stack by default, and a failure a few calls
     * deep in the code under test loses the test class's frame - which is
     * what tells a failing setup from a failing test (parseUnitOutput). */
    spawned = await spawnWithTimeout(node, ['--stack-trace-limit=100', entry], { cwd: base.cwd, timeoutMs: timeoutOf('A2UI5_MCP_UNIT_TIMEOUT_MS'), signal, onLine });
  } finally {
    if (tmpEntry) fs.rmSync(tmpEntry, { force: true });
  }
  const { code, stdout, stderr, timedOut, aborted } = spawned;
  if (aborted) return { ok: false, aborted: true, class: cls, ran: 0, tests: [], error: 'run_unit_tests cancelled by the client — the runner\'s process tree was killed' };
  if (timedOut) return { ok: false, timedOut: true, class: cls, ran: 0, tests: [], error: timedOutError('the unit test runner', 'A2UI5_MCP_UNIT_TIMEOUT_MS') };
  const parsed = parseUnitOutput(stdout, code);
  if (wanted.length && !filtered) {
    parsed.tests = parsed.tests.filter((t) => wanted.includes(t.object));
    parsed.ran = parsed.tests.filter((t) => !t.skipped).length;
    parsed.skipped = parsed.tests.length - parsed.ran;
    if (parsed.failed && !wanted.includes(parsed.failed.object)) parsed.failed = null;
  }
  return {
    ...parsed,
    class: cls,
    ...(wanted.length > 1 ? { classes: wanted } : {}),
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
/* setup_status' backend section: which backend is in use and why, and for
 * the npm backend what is installed and what the next build would do. */
function backendReport({ a2, status, box }) {
  const kind = backendKind();
  const pref = backendPreference();
  const raw = String(process.env.A2UI5_MCP_BACKEND || '').trim();
  const common = {
    kind,
    ...(pref ? { preference: `A2UI5_MCP_BACKEND=${pref}` } : {}),
    ...(raw && !pref ? { preferenceProblem: `A2UI5_MCP_BACKEND=${raw} is neither npm nor clone - ignored` } : {}),
    built: status.built,
    running: status.running,
    port: status.port,
  };
  if (kind === 'npm') {
    const npm = npmStatus({ sandboxDir: box ? box.dir : npmSandboxDir() });
    return {
      ...common,
      ...(status.host ? { host: status.host } : {}),
      npm,
      unitTestRunner: Boolean(npm.dir && fs.existsSync(path.join(appsDir(npm.dir), 'index.mjs'))),
      ...(a2 ? { checkout: a2, note: `the checkout at ${a2} still serves the guide, the interface and the pitfalls; the backend is the npm one because A2UI5_MCP_BACKEND=npm` } : {}),
      cloneTarget: frameworkCloneDir(),
      hint: `no framework checkout needed: build_backend runs on ${RUNTIME_PKG} (npm.nextBuild says what it would do). `
        + (pref === 'npm'
          ? `A2UI5_MCP_BACKEND=npm keeps it the backend - unset it to run on ${a2 ? 'the checkout' : 'a framework clone (build_backend mode prebuilt then clones one into cloneTarget)'}`
          : 'build_backend mode prebuilt (or A2UI5_MCP_BACKEND=clone) clones the framework into cloneTarget instead'),
    };
  }
  return {
    ...common,
    checkout: a2,
    ...(status.prebuilt ? { prebuilt: status.prebuilt } : {}),
    unitTestRunner: Boolean(a2 && fs.existsSync(path.join(a2, 'node/output/index.mjs'))),
    cloneTarget: frameworkCloneDir(),
    ...(kind === 'checkout' && a2 && path.resolve(a2) === path.resolve(frameworkCloneDir())
      ? { note: `this is the workspace clone build_backend made; delete it (or set A2UI5_MCP_BACKEND=npm) to run on ${RUNTIME_PKG} instead` }
      : {}),
    ...(kind === 'missing' ? { hint: `${explicitEnv('a2ui5')} is set and points at no checkout: fix it, or unset it to run on ${RUNTIME_PKG} (no checkout needed)` } : {}),
    ...(kind === 'clone' ? { hint: 'A2UI5_MCP_BACKEND=clone: build_backend (mode prebuilt) clones the framework release into cloneTarget and downloads its backend' } : {}),
  };
}

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
    : { repository: REPO_DIRS.viewCheck.repository, missing: true, hint: 'validate_view, fix_view and screenshot_view need it: npm install @abap2ui5/linter in the project the server runs in (an npm install of the server brings it along as the declared peer, npm 7+), or clone https://github.com/abap2UI5/linter as a sibling and npm ci' };

  // migrate_report's converter: local only, it needs the checkout's npm ci (lib/migrate.mjs)
  const cloudGui = resolveCloudGui();
  const guiEnv = explicitEnv('cloudGui');
  repos.cloudGui = cloudGui
    ? { repository: REPO_DIRS.cloudGui.repository, local: cloudGui, ...(fs.existsSync(path.join(cloudGui, 'node_modules', '@abaplint', 'core')) ? {} : { hint: `run npm ci in ${cloudGui} - report2cloud parses with its @abaplint/core` }) }
    : { repository: REPO_DIRS.cloudGui.repository, missing: true, hint: guiEnv ? `${guiEnv} is set to ${process.env[guiEnv]}, which is not a checkout` : 'migrate_report needs it: clone https://github.com/abap2UI5-addons/abap-cloud-gui as a sibling of mcp-server and npm ci there, or point ABAP_CLOUD_GUI_HOME at one' };

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
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
  const found = resolveChromium();
  const chromium = found && found.exists ? found.path : null;
  const chromiumSource = found ? found.source : null;
  return {
    repos,
    sandbox: box
      ? { kind: box.kind, dir: box.dir, deployedApps: listDevApps() }
      : { missing: true, hint: sandboxError },
    backend: backendReport({ a2, status, box }),
    programs: {
      git: which('git'),
      tar: which('tar'),
      npm: which('npm'),
      npx: which('npx'),
      chromium,
      ...(chromiumSource ? { chromiumSource } : {}),
      ...(found && !found.exists ? { chromiumHint: `${found.source} names ${found.path}, which does not exist` } : {}),
      ...(!found ? { chromiumHint: 'no Chromium: `npx playwright install chromium` (Playwright-managed), or point A2UI5_MCP_CHROMIUM at one' } : {}),
    },
    settings: {
      mirror: remoteEnabled() ? 'on' : 'off',
      mirrorDir: remoteBase(),
      offline: Boolean(process.env.A2UI5_MCP_OFFLINE),
      screenshotDir: shotDir(),
      timeouts: Object.fromEntries(Object.keys(TIMEOUT_DEFAULTS).map((k) => [k, timeoutOf(k)])),
    },
  };
}

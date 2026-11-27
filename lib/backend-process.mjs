/*
 * backend-process - the backend child (split out of lib/runtime.mjs, which
 * re-exports it): started once and shared (startBackend), on the framework
 * checkout's express shim or the npm host (lib/npm-host.mjs), with an
 * allowlisted environment, a liveness check and a generation that tells a
 * restarted backend apart; stopped with its tree; and the app classes the
 * built output serves.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { fileKeyed } from './cache.mjs';
import { runtimeDir, appsDir, appsBuilt, currentRuntimeVersion, RUNTIME_PKG, buildRecord } from './npm-backend.mjs';
import { a2Local, backendKind, npmRuntimeDir, PORT, BACKEND_HOST } from './sandbox.mjs';
import { listDevApps } from './deploy.mjs';
import { building, backendBuilt, whileBuilding } from './build.mjs';
import { prebuiltManifest } from './prebuilt.mjs';
import { closeAppContexts } from './browser.mjs';

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
 * Every stop reaches it (stopBackend( )): a shutdown during a start used to
 * exit with this child untracked, and it went on to listen - an orphan
 * holding the port for the next session. */
let startingChild = null;
// the children of starts a stop ended: their exit is no failed start
const stoppedStarts = new WeakSet();

/* How long a backend child must stay up past its "Listening on" before the
 * start trusts it (startBackendOnce). */
export const LIVENESS_MS = 500;

/* The start's two clocks, as one mutable object so a test can turn them
 * down (test/backend.test.mjs spawns a dozen fake backends and paid the
 * liveness wait and the port poll at full size for each): `livenessMs` is
 * LIVENESS_MS, `portPollMs` the interval waitPort asks the port at. Not an
 * environment variable on purpose - nothing but a test has a reason to
 * trust a backend sooner. */
export const backendTiming = { livenessMs: LIVENESS_MS, portPollMs: 300 };

export function startBackend() {
  /* A start during build_backend booted the output from BEFORE the build:
   * the build stops the backend once, when it begins, and reported built
   * while the process it never saw went on serving the old classes - under
   * the same pid, so the restart check kept its sessions current too. */
  if (building) return Promise.reject(new Error(whileBuilding('start the app', 'the backend would serve the output from before the build')));
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
    cmd = process.execPath;
    args = [path.join(a2, 'node/srv/express.mjs')];
  }
  hostBanner = null;
  let child = null;
  let listenedAt = 0;
  await new Promise((resolve, reject) => {
    /* HOST: the framework's node/srv/express.mjs binds EVERY interface when
     * it is unset ("what the e2e runner and a container need"), so the dev
     * backend - every deployed app, run by anyone who can reach the port -
     * listened on the LAN beside a checkout, while the npm host binds
     * 127.0.0.1. Loopback is all run_app and the app tools connect to; a
     * HOST the user's shell exports (a host name) is overridden for the
     * same reason. An express.mjs from before HOST ignores it. */
    const srv = spawn(cmd, args, {
      env: backendEnv(process.env, { port: PORT, host: BACKEND_HOST }),
      windowsHide: true, // no console window of its own on Windows (lib/spawn.mjs)
    });
    child = srv;
    startingChild = srv;
    let out = '';
    const onData = (d) => {
      out += d;
      if (/Listening on/.test(out)) {
        listenedAt = Date.now();
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
      else if (stoppedStarts.has(srv)) reject(new Error('the backend start was stopped (backend stop, or a build) before it listened'));
      /* A port in use is the common case (3000 is every dev server's
       * default), and the raw EADDRINUSE line named the port but not the
       * way out - which the listening-then-exit path below already gives. */
      else {
        const inUse = /EADDRINUSE/.test(out)
          ? `\nport ${PORT} is taken by another process: stop it, or start the server with another A2UI5_MCP_PORT`
          : '';
        reject(new Error(`backend exited (${c}) before listening:\n${out.slice(-500)}${inUse}`));
      }
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
  /* The port answered - but maybe not this child: a backend that said
   * "Listening on" over a bind error (express 5's app.listen calls its
   * callback with the error too) exits a moment later, and the port wait
   * was answered by whoever holds the port. The app tools would then talk
   * to a stranger's server. (A child this server killed meanwhile - a stop
   * during the wait - is no such case: the status says it is not running.)
   * The port wait alone lost that race: another process answers its first
   * GET within milliseconds, before the child's exit is even seen - two
   * starts in three over a port in use reported "running". So the child
   * has to live LIVENESS_MS past its "Listening on" (the wait ends early
   * when it exits): a bind error or a crash in the first moments of the
   * boot fails the start, for half a second on a start that takes about
   * one. A backend that dies later is caught by the next call - its
   * sessions are refused (the generation) and the start runs again. */
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const left = backendTiming.livenessMs - (Date.now() - listenedAt);
  if (!child.killed && !exited() && left > 0) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        child.off('exit', done);
        resolve();
      };
      const timer = setTimeout(done, left);
      child.on('exit', done);
    });
  }
  if (!child.killed && exited()) {
    throw new Error(`the backend exited (${child.exitCode ?? child.signalCode}) right after it said it was listening - port ${PORT} is answered by another process: `
      + 'stop it, or start the server with another A2UI5_MCP_PORT');
  }
  return backendStatus();
}

/* What a child that EXECUTES ABAP inherits: an ALLOWLIST, not this
 * server's whole environment. The backend and the unit-test runner boot the
 * transpiled app, and open-abap's `@KERNEL` escape (and `process.env` from
 * any JavaScript the app reaches) lets ABAP read the environment - so an app
 * (a migrated report, a sample an injected agent was steered into deploying)
 * could read every secret the user's shell exports: the GitHub token, the
 * system-mode SAP credentials, and whatever else is there (cloud keys, npm
 * tokens, a database URL). A denylist of the names this server knows missed
 * all of the third kind. Running the app is trusted code (SECURITY.md); this
 * is defence in depth, not a substitute for not deploying untrusted ABAP.
 *
 * What the two children read, enumerated (and measured: build_backend,
 * app_start and run_unit_tests ran end to end with nothing else, from a
 * parent environment full of decoys - CHANGELOG):
 *   - the npm host (lib/npm-host.mjs) and the framework's node/srv/express.mjs:
 *     PORT and HOST, set by backendEnv below (ALLOWED_HOSTS deliberately not);
 *   - the release's runtime, @abaplint/runtime and express: NODE_ENV, DEBUG
 *     (express' and the debug module's switches) - nothing else
 *     (`process.env` across the installed runtime's node_modules);
 *   - Node itself: PATH (a child it spawns), HOME / USERPROFILE (os.homedir),
 *     TMPDIR / TMP / TEMP (os.tmpdir - per user on macOS), TZ and the locale
 *     (LANG, LANGUAGE, LC_*: sy-datum, sy-uzeit and Intl follow them),
 *     NODE_OPTIONS (a heap size or --use-openssl-ca the user set for every
 *     node), NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / SSL_CERT_DIR /
 *     OPENSSL_CONF (a corporate CA for an app's cl_http_client), NODE_ICU_DATA
 *     (a node built without full ICU), NODE_USE_ENV_PROXY and the proxy
 *     variables (an app's outbound HTTP behind a proxy), LD_LIBRARY_PATH (a
 *     node that needed it to start at all needs it in the child too);
 *   - Windows (from Node's and libuv's documentation, not measured here):
 *     SystemRoot and windir (crypto, DNS and os.tmpdir fall back to them),
 *     ComSpec and PATHEXT (a .cmd a child runs), SystemDrive, APPDATA and
 *     LOCALAPPDATA, USERNAME and USERDOMAIN (os.userInfo), PROCESSOR_ARCHITECTURE
 *     and NUMBER_OF_PROCESSORS. Names compared case-insensitively - Windows
 *     spells them SystemRoot and Path, and reads them in any case.
 * A proxy URL can carry credentials (http://user:pass@proxy); it is passed
 * because an app's outbound HTTP needs it exactly as the server's does, and
 * it is the one secret-shaped value on the list. Anything an app genuinely
 * needs beyond this belongs in the app, not in the server's environment. */
const CHILD_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'LANGUAGE',
  'NODE_ENV', 'DEBUG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA', 'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF', 'LD_LIBRARY_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'APPDATA', 'LOCALAPPDATA',
  'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]);

/** The allowlist, for the check that SECURITY.md names every entry. */
export const CHILD_ENV_NAMES = Object.freeze([...CHILD_ENV_ALLOW]);

/** The part of `base` a child that boots or tests an app may see: the
 *  allowlist above, any spelling (and the LC_* locale family). */
export function appChildEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const up = k.toUpperCase();
    if (CHILD_ENV_ALLOW.has(up) || /^LC_[A-Z]+$/.test(up)) env[k] = v;
  }
  return env;
}

/* The backend child's environment: the allowlist above, with the port and
 * the loopback bind - and WITHOUT ALLOWED_HOSTS (not on the list; removed
 * again here so a later widening of the list cannot let it through).
 * The framework's express.mjs reads that variable as more names to serve,
 * and `*` switches its DNS-rebinding guard off (any Host, any Origin): an
 * ALLOWED_HOSTS=* the user's shell exports for a container of their own would
 * open every dev app to any web page they open. Removed in any spelling -
 * environment names are case-insensitive on Windows. */
export function backendEnv(base, { port, host }) {
  const env = appChildEnv(base);
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ALLOWED_HOSTS') delete env[key];
  return { ...env, PORT: String(port), HOST: host };
}

/* `starting` (the server's shutdown): also kill the child of a start that
 * has not listened yet - `server` is only set once it does. */
export async function stopBackend() {
  /* The pages on the backend, not the browser: a page open on a backend
   * that is going away shows a dead app, so every context (a run_app or
   * interact_app in flight) is closed - the Chromium itself does not
   * depend on the backend, and every build and every stop used to close
   * it, so the next run_app paid its launch again. closeBrowser is the
   * shutdown's. */
  await closeAppContexts();
  if (server && server.exitCode === null) {
    server.kill();
    server = null;
  }
  /* A start in flight is stopped too - every caller's, not the shutdown's
   * only: `backend stop` answered "not running" and the start went on to
   * listen, and a build_backend that stopped the backend while one started
   * reported built while the process from before it served the old code. */
  if (startingChild && startingChild.exitCode === null) {
    stoppedStarts.add(startingChild);
    startingChild.kill();
    if (startingBackend) await startingBackend.catch(() => {});
  }
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

/* The class modules of a transpiler output folder: its own, and those one
 * folder down - @abaplint/transpiler-cli 2.14 and later write a folder per
 * origin (project/ for the transpile's input, open-abap-core/, ...), earlier
 * ones everything into the folder itself. apps/ is flat either way. */
function classModulesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      try {
        for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.endsWith('.clas.mjs')) out.push(path.join(dir, e.name, f));
      } catch {
        /* unreadable: none */
      }
    } else if (e.name.endsWith('.clas.mjs')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function scanAppModules(dir) {
  const apps = classModulesIn(dir)
    .filter((file) => {
      try {
        return APP_MAIN.test(fs.readFileSync(file, 'utf8'));
      } catch {
        return false;
      }
    })
    .map((file) => path.basename(file).replace(/\.clas\.mjs$/, '').toUpperCase());
  return [...new Set(apps)];
}

/* Memoised per output folder on its `init.mjs` (lib/cache.mjs): every build
 * writes that file anew - apps/ is swapped in whole, the transpiler rewrites
 * node/output/init.mjs, a release install brings the package's - and it is
 * the marker readAppSource dates a build by (`builtMarkerFile`). app_list
 * used to read every class module of the dev apps AND the whole framework
 * on each call. A folder without an init.mjs is scanned uncached, as before. */
function appModulesIn(dir) {
  try {
    return fileKeyed(path.join(dir, 'init.mjs'), () => scanAppModules(dir), 'app-modules');
  } catch {
    return scanAppModules(dir);
  }
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
    /* a full build (lib/npm-backend.mjs, THE FULL TRANSPILE): apps/ holds
     * the framework as well, so the deployed names say which app is whose,
     * as on a checkout */
    if ((buildRecord(dir) || {}).layout === 'full') {
      return appModulesIn(appsDir(dir)).map((app) => ({ app, source: devNames.has(app) ? 'dev' : 'framework' }));
    }
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
export function waitPort(port, ms = 30000, { get = http.get, pollMs = backendTiming.portPollMs } = {}) {
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
      req.on('error', () => (Date.now() > deadline ? reject(new Error('port timeout')) : setTimeout(tick, pollMs)));
    };
    tick();
  });
}

/*
 * setup-status - setup_status (split out of lib/runtime.mjs, which
 * re-exports it): every checkout, the backend, the sandbox, the browser and
 * the programs the expensive half spawns, in one read.
 */
import fs from 'fs';
import path from 'path';
import { resolveViewCheck, resolveCloudGui, explicitEnv, RESOLVERS, REPO_DIRS } from './repos.mjs';
import { TIMEOUT_DEFAULTS, timeoutOf } from './spawn.mjs';
import { npmSandboxDir, appsDir, npmStatus, RUNTIME_PKG } from './npm-backend.mjs';
import { isRemoteCheckout, readMarker, remoteEnabled, remoteBase, REMOTE_FILES } from './remote.mjs';
import { corpus, a2Local, backendPreference, backendKind, sandbox, shotDir } from './sandbox.mjs';
import { listDevApps } from './deploy.mjs';
import { frameworkCloneDir } from './prebuilt.mjs';
import { backendStatus } from './backend-process.mjs';
import { resolveChromium } from './browser.mjs';

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

/*
 * Is `cmd` an executable on the PATH? Read in-process, the way the shell
 * looks: every PATH directory in order, on Windows with each PATHEXT
 * extension (npm is npm.cmd there). It used to spawn `which` / `where` - a
 * child per program for a read that promises to be cheap, with no timeout,
 * and `which` is absent from minimal images (Debian slim, distroless), where
 * every program then read as missing. Pure apart from the file checks.
 */
export function onPath(cmd, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const key = win ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
  const dirs = String((key && env[key]) || '').split(win ? ';' : ':').map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const extKey = win ? Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT') : null;
  const exts = win
    ? String((extKey && env[extKey]) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  // a name that already carries one of the extensions is looked up as it is
  const names = win && exts.some((e) => cmd.toUpperCase().endsWith(e.toUpperCase())) ? [cmd] : exts.map((e) => cmd + e);
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        // not here: the next one
      }
    }
  }
  return false;
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
    ? { repository: REPO_DIRS.cloudGui.repository, local: cloudGui, ...(fs.existsSync(path.join(cloudGui, 'node_modules', '@abaplint', 'core')) ? {} : { hint: `run npm ci in ${cloudGui} - report2UI5 parses with its @abaplint/core` }) }
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
  const which = (cmd) => onPath(cmd);
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

/* The OpenUI5 checkout samples-controls' scripts/scope-of.mjs reads the
 * JSDoc from: OPENUI5_SRC, else fork-openui5 beside the corpus (the
 * script's own rule, resolved the same way - a relative OPENUI5_SRC from
 * the corpus, where runScopeOf runs the script, not from where this server
 * was started). */
export function openui5Dir(corpusRoot = corpus()) {
  return process.env.OPENUI5_SRC ? path.resolve(corpusRoot, process.env.OPENUI5_SRC) : path.resolve(corpusRoot, '..', 'fork-openui5');
}

/**
 * Why scope_of answered UNRESOLVED, when the reason is no entity name but
 * the missing OpenUI5 checkout - or null. The script prints "UNRESOLVED (no
 * source .js found - check the entity name / fork checkout)" for every
 * OpenUI5 entity without it, sap.m.Wizard included, and the answer read
 * like a misspelt name.
 */
export function scopeOfNote(out, dir = openui5Dir()) {
  if (!/UNRESOLVED/.test(String(out)) || fs.existsSync(path.join(dir, 'src'))) return null;
  return `the OpenUI5 checkout scope_of reads the JSDoc from is not there (${path.join(dir, 'src')} is missing), so every OpenUI5 entity reads UNRESOLVED whatever its name - `
    + 'clone https://github.com/SAP/openui5 there (src/ is all it reads), or point OPENUI5_SRC at a checkout. '
    + 'validate_view answers the same 1.71 question for a view without it: its property gate flags a control or member newer than the floor';
}

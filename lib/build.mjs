/*
 * build - build_backend (split out of lib/runtime.mjs, which re-exports it):
 * the plan (planBuild - which mode runs on which backend), one build at a
 * time with followers, the npm and checkout paths, and the build log the
 * build_log tool reads - the log is the build's own record, so it lives
 * beside the code that writes it.
 */
import fs from 'fs';
import path from 'path';
import { resolveSamplesControls, explicitEnv } from './repos.mjs';
import { timeoutOf, spawnWithTimeout, localBin, missingBinMessage, timedOutError } from './spawn.mjs';
import { appsDir, appsBuilt, buildNpm, RUNTIME_PKG } from './npm-backend.mjs';
import { ANSWER_BUDGET } from './budget.mjs';
import { corpus, a2Local, backendPreference, backendKind, npmRuntimeDir, sandbox, shotDir, shotDirProblem } from './sandbox.mjs';
import { syncDevCopies, checkoutFingerprint, checkoutBuildUnchanged, recordCheckoutBuild, listDevApps } from './deploy.mjs';
import { cloneFramework, transpileFramework, downloadPrebuilt } from './prebuilt.mjs';

// ----------------------------------------------------------------- build ----

export let building = null;
/** The refusal of a step that would read the backend's output while a build
 *  replaces it - one sentence for every such step (startBackend,
 *  runUnitTests), naming what to do once the build is done and why. */
export const whileBuilding = (task, why) => `build_backend is running — ${task} once it has finished (${why})`;
let buildingMode = null; // the effective mode while a build is in flight
/* The onLine of every call that joined the build in flight: build_backend's
 * progress notifications follow the build's lines, and a joined call with a
 * progressToken used to hear nothing until the build ended. */
const buildFollowers = new Set();

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
 *                      tens-of-minutes corpus build - either one followed by
 *                      the incremental build of the deployed dev apps, which
 *                      the framework build does not carry. With A2UI5_MCP_BACKEND=clone
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
 * orphan this option exists to prevent. The joiner's own signal only ends
 * its wait (joinBuild): the build is the first caller's. */
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

/* A call that joined the in-flight build waits on it until its OWN request
 * is cancelled - then it stops waiting and answers as cancelled, and the
 * build goes on for the call that started it (whose signal alone kills it).
 * Without this the joiner ignored its cancel and held its request open to
 * the end of a build that may take tens of minutes. Without a signal the
 * joiner gets the build's own promise. */
function joinBuild(promise, signal, mode, onLine) {
  if (onLine) {
    buildFollowers.add(onLine);
    const leave = () => buildFollowers.delete(onLine);
    promise.then(leave, leave);
    if (signal) signal.addEventListener('abort', leave, { once: true });
  }
  if (!signal) return promise;
  const detached = () => ({
    ok: false,
    code: null,
    mode,
    aborted: true,
    joined: true,
    tail: `stopped waiting for the ${mode} build another call started — that build goes on; build_log shows it`,
  });
  if (signal.aborted) return Promise.resolve(detached());
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(detached());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
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
  let incremental = effective === 'incremental';
  const prebuilt = effective === 'prebuilt';
  const transpile = effective === 'transpile';
  /* Single-flight, per mode: a second call with the same effective mode joins
   * the in-flight build (same promise, same result); a different mode fails
   * fast instead of silently receiving the other mode's result — a mode:full
   * caller must never be handed an incremental build. Failing fast beats
   * queuing: silently appending a tens-of-minutes full build behind an
   * incremental one would look like a hang to the caller. */
  if (building) {
    if (effective === buildingMode) return joinBuild(building, signal, effective, onLine);
    return Promise.resolve({
      ok: false,
      code: null,
      inFlight: buildingMode,
      tail: `build in progress (${buildingMode}) — a ${effective} build cannot start concurrently; retry when the running build has finished`,
    });
  }
  if (plan.problem) return Promise.resolve({ ok: false, code: 1, tail: plan.problem });
  buildFollowers.clear();
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
      /* the tail goes into build_backend's answer: 30 lines of a minified
       * bundle or a JSON dump were several answers' worth (build_log keeps
       * the line whole) */
      tail = tail.concat(line.length > TAIL_LINE_SHOWN ? `${line.slice(0, TAIL_LINE_SHOWN)} [... ${line.length - TAIL_LINE_SHOWN} more characters - build_log has the line]` : line).slice(-30);
      full.push(line);
      fullBytes += line.length + 1;
      while (fullBytes > BUILD_LOG_CAP && full.length > 1) {
        fullBytes -= full[0].length + 1;
        full.shift();
        truncated = true;
      }
      if (onLine) onLine(line);
      for (const follow of buildFollowers) follow(line);
    };
    /* One recording path for every way the build ends, so the log always
     * says how the run finished - which matters most for the failures. */
    const finish = (res) => {
      lastBuild = {
        startedAt,
        finishedAt: new Date().toISOString(),
        mode: res.mode || effective,
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
    let fingerprint = null;
    // what ran: the mode, or a framework build with the dev apps' incremental one on top
    let ranAs = effective;
    /* The running backend is stopped once, and only when a build really
     * starts: the npm build and the incremental one first compare what they
     * would build with the last build's record, and a build nothing changed
     * for leaves the backend (and the app tools' sessions on it) alone. */
    let stopped = false;
    const stopFirst = async () => {
      if (stopped || !beforeBuild) return;
      stopped = true;
      await beforeBuild();
    };
    try {
      if (effective !== 'npm' && effective !== 'incremental') await stopFirst();
      let cmd;
      let cmdArgs;
      let cwd;
      if (effective === 'npm') {
        const res = await buildNpm({ inputDir: sandbox().dir, withLint, onLine: keepLine, signal, timeoutMs: buildTimeout, beforeBuild: stopFirst });
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
          ...(res.unchanged ? { unchanged: true } : {}),
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
      /* The framework is in place - prebuilt, or its own transpile. What it
       * carries is the FRAMEWORK: the deployed dev apps are in none of it.
       * Under auto (build_backend's default, verify_app's build stage) the
       * build goes on into the incremental transpile of the sandbox, so the
       * one call that "picks up deployed ABAP" does; a first build used to
       * answer built with no dev app in it, and run_app / app_start then
       * found no such app. An explicit prebuilt or transpile keeps doing
       * only that and names the apps it left out. */
      const frameworkBuilt = (frameworkMode) => {
        let pending = [];
        try { pending = listDevApps(); } catch { pending = []; }
        if (mode !== 'auto' || !pending.length) {
          return finish({ ok: true, code: 0, mode: frameworkMode, ...(pending.length ? { devAppsNotBuilt: pending } : {}), tail: tail.join('\n') });
        }
        keepLine(`${frameworkMode} backend in place - now the incremental build of the ${pending.length} deployed dev app(s) on top of it: ${pending.join(', ')}`);
        incremental = true;
        ranAs = `${frameworkMode}+incremental`;
        return null;
      };
      if (prebuilt) {
        const res = await downloadPrebuilt({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (res.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'prebuilt download cancelled by the client'].join('\n') });
        }
        /* No asset for this version and the caller left the choice to auto:
         * the framework's own build is minutes, not the corpus' tens of
         * minutes, so it is taken - said in the log, never silently. */
        if (!res.ok && mode === 'auto' && (/^HTTP 404/.test(res.reason || '') || res.layoutMismatch)) {
          keepLine(`prebuilt backend: ${res.layoutMismatch ? 'the asset does not fit this checkout' : 'no asset for this version'} - building the framework itself instead (mode transpile, a few minutes)`);
          const built = await transpileFramework({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
          if (built.aborted) {
            return finish({ ok: false, code: null, mode: 'transpile', aborted: true, tail: [...tail, 'transpile cancelled by the client'].join('\n') });
          }
          if (!built.ok) return finish({ ok: false, code: 1, mode: 'transpile', tail: tail.join('\n') });
          const done = frameworkBuilt('transpile');
          if (done) return done;
        } else {
          if (!res.ok) return finish({ ok: false, code: 1, mode: effective, tail: tail.join('\n') });
          const done = frameworkBuilt('prebuilt');
          if (done) return done;
        }
      } else if (transpile) {
        const built = await transpileFramework({ a2, onLine: keepLine, signal, timeoutMs: buildTimeout });
        if (built.aborted) {
          return finish({ ok: false, code: null, mode: effective, aborted: true, tail: [...tail, 'transpile cancelled by the client'].join('\n') });
        }
        if (!built.ok) return finish({ ok: false, code: 1, mode: effective, tail: tail.join('\n') });
        const done = frameworkBuilt('transpile');
        if (done) return done;
      }
      if (incremental) {
        // checked first: nothing is copied or cloned for a build that cannot run
        const transpiler = localBin(a2, '@abaplint/transpiler-cli', 'abap_transpile');
        if (!transpiler) {
          keepLine(missingBinMessage(a2, '@abaplint/transpiler-cli', 'abap_transpile'));
          return finish({ ok: false, code: 1, mode: ranAs, tail: tail.join('\n') });
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
              return finish({ ok: false, code: null, mode: ranAs, aborted: true, tail: [...tail, `${step.what} cancelled by the client`].join('\n') });
            }
            if (res.timedOut) {
              return finish({ ok: false, code: null, mode: ranAs, timedOut: true, tail: [...tail, timedOutError(step.what, 'A2UI5_MCP_BUILD_TIMEOUT_MS')].join('\n') });
            }
            if (res.code !== 0) {
              keepLine(`${step.what} exited ${res.code}${res.stderr ? ` - ${res.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
              return finish({ ok: false, code: res.code ?? 1, mode: ranAs, tail: tail.join('\n') });
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
        /* the build node/output holds was made from exactly this: nothing
         * to transpile, and the backend serving it keeps running */
        fingerprint = checkoutFingerprint(a2, tcfg);
        if (checkoutBuildUnchanged(a2, fingerprint)) {
          keepLine(`incremental: nothing changed since the last build (the sandbox, node/downport, the transpiler and its config are the same) - node/output stays as it is, the backend keeps running`);
          return finish({ ok: true, code: 0, mode: ranAs, unchanged: true, tail: tail.join('\n') });
        }
        await stopFirst();
        tcfgPath = path.join(a2, 'e2e-transpile.json');
        fs.writeFileSync(tcfgPath, JSON.stringify(tcfg, null, 2));
        cmd = process.execPath;
        cmdArgs = [transpiler, './e2e-transpile.json'];
        cwd = a2;
      } else {
        cmd = process.execPath;
        cmdArgs = [path.join(corpus(), "scripts", "e2e-build.mjs")];
        cwd = corpus();
      }
      const { code, timedOut, aborted } = await spawnWithTimeout(cmd, cmdArgs, { cwd, timeoutMs: buildTimeout, onLine: keepLine, signal });
      if (aborted) {
        return finish({
          ok: false,
          code: null,
          mode: ranAs,
          aborted: true,
          tail: [...tail, `${ranAs} build cancelled by the client — its process tree was killed`].join('\n'),
        });
      }
      if (timedOut) {
        return finish({
          ok: false,
          code: null,
          mode: ranAs,
          timedOut: true,
          tail: [...tail, timedOutError(`${ranAs} build`, 'A2UI5_MCP_BUILD_TIMEOUT_MS')].join('\n'),
        });
      }
      if (code === 0 && fingerprint) recordCheckoutBuild(a2, fingerprint);
      return finish({ ok: code === 0, code, mode: ranAs, tail: tail.join('\n') });
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
export function builtMarkerFile() {
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


// ------------------------------------------------------------- build log ----

/* The last build's full retained output, for the build_log tool. In memory
 * on this module, and persisted as a file under the screenshot/tmp dir so a
 * restarted server can still answer for the build a previous one ran. */
const BUILD_LOG_CAP = 262144; // matches spawnWithTimeout's per-stream retention
// what one line of build_backend's 30-line tail shows: 30 of them fit an answer
const TAIL_LINE_SHOWN = 1000;
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
  const sliced = sliceLog(rec.lines, { tail, offset });
  const { start, lines, cut } = fitLog(sliced, { tail, fromEnd: offset === undefined || offset === null });
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
    ...(cut ? { cut } : {}),
    lines,
  };
}

/* What one line of a build log may show: a minified bundle or a JSON dump
 * printed on one line is kept whole in the log, and shown cut. */
export const LOG_LINE_SHOWN = 4000;

/**
 * A slice of the log as one answer holds it (lib/budget.mjs): `tail` lines
 * of a log that keeps 256 KiB were whatever their length - 2,000 lines of a
 * transpiler's output answered 464,000 characters, and the client then
 * shows the agent nothing. Without an offset (`fromEnd`) the LAST lines that
 * fit are kept, with one the first; each line is measured JSON-escaped, as
 * the answer writes it, and a line longer than LOG_LINE_SHOWN is cut. `cut`
 * names the build_log call that reads what was left out. Pure.
 */
export function fitLog({ start, lines }, { tail, fromEnd, budget = ANSWER_BUDGET - 5000 } = {}) {
  const shown = lines.map((l) => (l.length > LOG_LINE_SHOWN ? `${l.slice(0, LOG_LINE_SHOWN)} [... ${l.length - LOG_LINE_SHOWN} more characters]` : l));
  // an entry of { lines: [ ... ] }: the escaped string, its indentation, comma and line break
  const cost = (l) => JSON.stringify(l).length + 6;
  const order = fromEnd ? [...shown.keys()].reverse() : [...shown.keys()];
  let used = 0;
  let keep = 0;
  for (const i of order) {
    const n = cost(shown[i]);
    if (keep && used + n > budget) break;
    used += n;
    keep += 1;
  }
  if (keep === shown.length) return { start, lines: shown };
  if (fromEnd) {
    const first = start + shown.length - keep;
    return {
      start: first,
      lines: shown.slice(shown.length - keep),
      cut: `the ${shown.length - keep} line(s) before these did not fit one answer - build_log { offset: ${start}, tail: ${shown.length - keep} } reads them`,
    };
  }
  return {
    start,
    lines: shown.slice(0, keep),
    cut: `${shown.length - keep} more line(s) of this slice did not fit one answer - build_log { offset: ${start + keep}, tail: ${tail} } reads on`,
  };
}

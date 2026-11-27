/*
 * browser - run_app and interact_app (split out of lib/runtime.mjs, which
 * re-exports it): which Chromium, one shared browser with a context per
 * call, the boot and its error log, the wait on the backend, the
 * screenshots, and the actions interact_app performs.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { parseActions, cssAttr } from './interact.mjs';
import { shotDir, shotDirProblem, appStartUrl, isBackendUrl } from './sandbox.mjs';
import { classNameOf } from './deploy.mjs';
import { backendBuilt } from './build.mjs';
import { startBackend } from './backend-process.mjs';
import { benignRules, libRoots, ui5RouteHandler } from './ui5-routing.mjs';
import { bspRoots, bspIndex, bspRouteHandler, isBspUrl } from './bsp.mjs';

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

/** Test hook: is a browser launched (or launching)? */
export function browserOpen() {
  return Boolean(browserPromise);
}

/** Close every context of the shared browser (the app pages) and keep the
 *  browser. Nothing to do without a browser, or with one that is gone. */
export async function closeAppContexts() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  if (!b || typeof b.contexts !== 'function') return;
  await Promise.all(b.contexts().map((c) => c.close().catch(() => {})));
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
 * A context and its page on `browser`, wired by `setup(page)`. An abort of
 * `signal` mid-boot closes the context: the Playwright waits after it throw
 * at once instead of running out their timeout under a request nobody is
 * waiting for (openApp turns that into a prompt cancellation error rather
 * than a report full of "Target closed"). A throw of newPage or of the setup
 * (a benign-rules import, page.route) closes the context and takes the
 * listener off the signal before it propagates - every failed boot left a
 * browser context open for the life of the server, and a listener on the
 * request's signal.
 */
export async function openPage(browser, contextOptions, signal, setup = async () => {}) {
  const ctx = await browser.newContext(contextOptions);
  const onAbort = () => ctx.close().catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const page = await ctx.newPage();
    await setup(page);
    return { ctx, page, onAbort };
  } catch (e) {
    if (signal) signal.removeEventListener('abort', onAbort);
    await ctx.close().catch(() => {});
    throw e;
  }
}

/* The distinct page errors one run_app / interact_app report lists. Each
 * is at most ~330 characters; a page that throws from a timer, or a poll
 * the backend answers 500, pushed the same line hundreds of times and the
 * report went past what a client accepts (a 100 ms interval over a 60 s
 * boot: 600 lines, 180,000 characters). */
export const ERRORS_KEPT = 20;

/**
 * The error list of one app run: a repeated message is listed once with
 * its count ("... (37 times)"), and past `max` distinct messages the rest
 * are only counted. `length` is every error pushed - what `ok` asks.
 * `list()` the lines in first-seen order, `cut()` the sentence for what
 * was left out (null when nothing was).
 */
export function createErrorLog(max = ERRORS_KEPT) {
  const seen = new Map();
  let total = 0;
  let dropped = 0;
  return {
    push(msg) {
      total += 1;
      const key = String(msg);
      if (seen.has(key)) seen.set(key, seen.get(key) + 1);
      else if (seen.size < max) seen.set(key, 1);
      else dropped += 1;
    },
    get length() {
      return total;
    },
    list() {
      return [...seen].map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m));
    },
    cut() {
      return dropped
        ? `${dropped} more error${dropped === 1 ? '' : 's'} past the first ${max} distinct messages not listed (${total} in all)`
        : null;
    },
  };
}

/*
 * The UI5 runtime the page loads - its bootstrap (sap-ui-core.js, from the
 * CDN the framework's page names, sdk.openui5.org) and the libraries and
 * themes after it - is no backend request, so a failed load was in no
 * report: with the CDN out of reach and no local @openui5 packages, run_app
 * answered "boot: page.waitForFunction: Timeout 60000ms exceeded" with a
 * blank picture, and an app that booted without its theme was "ok" with an
 * unstyled screenshot. watchUi5 records every such request that failed or
 * answered 400 and up (a backend URL is never one); ui5LoadReport turns that
 * into the sentence the report carries.
 */
export function watchUi5(page) {
  const failed = [];
  const isUi5 = (url) => {
    if (isBackendUrl(url)) return false;
    try {
      return new URL(String(url)).pathname.includes('/resources/');
    } catch {
      return false;
    }
  };
  /* `fatal` rejects the moment the BOOTSTRAP fails: without sap-ui-core.js
   * nothing boots, and waitForBoot used to wait its whole timeout (60 s)
   * for a page whose first request had already been answered 404 or
   * refused within milliseconds - bootOrUi5Failure races the two. A
   * failure of a library or theme after the bootstrap is a note, not a
   * reason to stop waiting. Caught here once so an unraced rejection is
   * never an unhandled one. */
  let fail;
  const fatal = new Promise((resolve, reject) => { fail = reject; });
  fatal.catch(() => {});
  // once per URL: a 404 a script or stylesheet tag asked for is also a failed request after it
  const add = (url, reason) => {
    if (!isUi5(url) || failed.some((x) => x.url === url)) return;
    failed.push({ url, reason });
    if (BOOTSTRAP.test(url)) {
      const e = new Error(`the UI5 bootstrap did not load: ${url} - ${reason}`);
      e.ui5Fatal = true;
      fail(e);
    }
  };
  page.on('requestfailed', (r) => add(r.url(), (r.failure() && r.failure().errorText) || 'failed'));
  page.on('response', (r) => {
    if (r.status() >= 400) add(r.url(), `HTTP ${r.status()}`);
  });
  return { failed, fatal };
}

/* The UI5 bootstrap's URL. */
const BOOTSTRAP = /sap-ui-core\.js(\?|$)/;

/* waitForBoot, cut short by watchUi5's `fatal`: resolves when the app
 * booted, rejects with the boot wait's own error at its timeout, and with
 * the bootstrap's failure (`ui5Fatal`) the moment that is recorded. The
 * boot wait goes on in the browser after a fatal rejection and ends with
 * the context; its own rejection is swallowed here. */
export function bootOrUi5Failure(page, ui5, timeoutMs) {
  const boot = waitForBoot(page, timeoutMs);
  boot.catch(() => {});
  return Promise.race([boot, ui5.fatal]);
}

/**
 * What the report says about the UI5 runtime: `error` when the app did not
 * boot and UI5 itself never arrived (the bootstrap failed, or nothing of
 * `sap.ui` is on the page), `note` when it booted with resources missing
 * (a theme, a library: the picture is not the real one). `localUi5` - the
 * corpus' @openui5 packages served (libRoots); `offline` -
 * A2UI5_MCP_OFFLINE, which answers every CDN request with a 404.
 */
export function ui5LoadReport({ booted, sapLoaded, failed = [], localUi5 = false, offline = false }) {
  if (!failed.length) return { error: null, note: null };
  // the bootstrap first, then a stylesheet (the theme - what leaves a picture unstyled)
  const first = failed.find((x) => /sap-ui-core\.js(\?|$)/.test(x.url))
    || failed.find((x) => /\.css(\?|$)/.test(x.url)) || failed[0];
  const where = `${first.url} - ${first.reason}${failed.length > 1 ? ` (and ${failed.length - 1} more UI5 request(s))` : ''}`;
  const source = localUi5
    ? 'run_app serves UI5 from the samples-controls checkout\'s @openui5 packages and takes what they lack from the CDN'
    : 'run_app takes UI5 from the CDN (sdk.openui5.org) when no samples-controls checkout with its npm install (@openui5 packages) is beside the server';
  const remedy = offline
    ? `A2UI5_MCP_OFFLINE is set, which answers every CDN request with a 404 - unset it${localUi5 ? '' : ', or run npm ci in samples-controls'}`
    : (localUi5
      ? 'this machine could not reach the CDN - the packages carry the themes as .less sources only, so the built theme CSS comes from there: allow sdk.openui5.org through its network or proxy'
      : 'this machine could not reach it - allow sdk.openui5.org through its network or proxy, or run npm ci in a samples-controls checkout beside the server');
  if (!booted && !sapLoaded) {
    return { error: `UI5 did not load, so no app could boot: ${where}. ${source}; ${remedy}. This says nothing about the app - app_start answers its screen without a browser`, note: null };
  }
  return { error: null, note: `${failed.length} UI5 request(s) failed: ${where}. The app booted, but the picture may lack its theme or a library - ${source}; ${remedy}` };
}

/*
 * Boot <class> as the real app: the page, with its error collection wired,
 * after the first roundtrip. run_app photographs it at once; interact_app
 * drives it first. Both end in finishApp, which takes the picture and closes
 * the context, so the pair of tools cannot disagree about what a report is.
 */
async function openApp({ className, timeoutMs = 60000, signal, tool = 'run_app', query = '' }) {
  const cls = classNameOf(className);
  const cancelled = () => new Error(`${tool} cancelled by the client`);
  if (signal && signal.aborted) throw cancelled();
  // name a remedy that EXISTS: deploy_app has no `build` argument (class_name,
  // abap_source, description, lint), and an agent that goes looking for one
  // spends the next few minutes finding out it never had one
  if (!backendBuilt()) throw new Error(`backend not built — call build_backend (mode prebuilt or full the first time) before ${tool}`);
  /* Offline with nothing to serve UI5 from: the answer is known before a
   * browser is launched or the backend started - every CDN request would
   * be the hermetic 404, and the boot waited its whole timeout for it. */
  if (process.env.A2UI5_MCP_OFFLINE && !libRoots().length) {
    const report = ui5LoadReport({
      booted: false, sapLoaded: false, offline: true, localUi5: false,
      failed: [{ url: 'https://sdk.openui5.org/resources/sap-ui-core.js', reason: 'would be answered HTTP 404 (A2UI5_MCP_OFFLINE is set and there are no local @openui5 packages), so it was not requested' }],
    });
    return { cls, page: null, ctx: null, errors: null, booted: false, cancelled, signal, inflight: null, ui5Note: null, early: report.error };
  }
  await startBackend();

  const browser = await getBrowser();
  const errors = createErrorLog();
  let inflight;
  let anyInflight;
  let ui5;
  const { ctx, page, onAbort } = await openPage(browser, appContextOptions(), signal, async (pg) => {
    ui5 = watchUi5(pg);
    // resolved before the listeners are wired: they are synchronous callbacks
    const benignList = await benignRules();
    const benign = (s) => benignList.some((re) => re.test(s));
    pg.on('pageerror', (e) => {
      if (!benign(e.message)) errors.push('pageerror: ' + e.message.slice(0, 300));
    });
    /* The backend requests in flight - an action waits for its roundtrip
     * (settle): the frontend drops an event fired while one is running, and
     * the busy overlay shows only after a second, so a quick second click
     * landed, was thrown away and reported as performed. */
    inflight = trackRequests(pg, isBackendUrl);
    // every request, UI5's own modules and libraries included: the first
    // view is not on screen while the libraries it needs still load
    anyInflight = trackRequests(pg, () => true);
    pg.on('response', (r) => {
      if (!isBackendUrl(r.url()) || r.status() < 400) return;
      const u = new URL(r.url());
      errors.push(`backend HTTP ${r.status()} for ${u.pathname}${u.search.slice(0, 60)}`);
    });
    // UI5 modules resolve from the local @openui5 packages; what they lack
    // (notably the BUILT theme css — the packages ship only .less sources) may
    // come from the real CDN so screenshots are styled, kept across calls
    // (ui5RouteHandler). A2UI5_MCP_OFFLINE=1 forces the hermetic 404
    // behaviour of e2e-smoke.
    await pg.route('**://sdk.openui5.org/**', ui5RouteHandler());
    // the frontend files of addons with controls (lib/bsp.mjs): answered
    // from their abapGit WAPA files, which the backend does not serve
    // the backend answers such a request with its start page (HTTP 200), so
    // the frontend's "script load error" was the only trace - say it here
    await pg.route(isBspUrl, bspRouteHandler(bspIndex(bspRoots()), {
      onUnserved: (name, key) => errors.push(`${key} was asked for, a file of the addon BSP ${name}, which no local checkout carries - `
        + 'the backend does not serve it; point A2UI5_MCP_BSP_DIRS at the addon\'s checkout (custom-controls for z2ui5_cci), or put it beside this server'),
      onMissing: (key) => errors.push(`${key} was asked for and is not in the local checkout of its addon BSP - an older checkout than the app expects?`),
    }));
  });

  let booted = false;
  try {
    await page.goto(appStartUrl(cls, undefined, query), {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await bootOrUi5Failure(page, ui5, timeoutMs);
    booted = true;
    // the boot check is met by the frontend's own shell already: the app's
    // first view follows its roundtrip and the libraries it loads
    await firstViewSettled(page, anyInflight);
    await renderSettled(page, inflight); // let the render settle so late errors surface
  } catch (e) {
    // a failed bootstrap is reported by ui5LoadReport below, in its words
    if (!e || !e.ui5Fatal) errors.push('boot: ' + String(e.message).split('\n')[0].slice(0, 300));
  }
  if (signal && signal.aborted) {
    await ctx.close().catch(() => {});
    throw cancelled();
  }
  const sapLoaded = booted || await page.evaluate(() => Boolean(window.sap && window.sap.ui && window.sap.ui.getCore)).catch(() => false);
  const ui5Report = ui5LoadReport({ booted, sapLoaded, failed: ui5.failed, localUi5: libRoots().length > 0, offline: Boolean(process.env.A2UI5_MCP_OFFLINE) });
  if (ui5Report.error) errors.push(ui5Report.error);
  return { cls, page, ctx, errors, booted, onAbort, cancelled, signal, inflight, ui5Note: ui5Report.note };
}

/** The requests of `page` that `match` takes, in flight: { n, last }. */
export function trackRequests(page, match) {
  const inflight = { n: 0, last: Date.now() };
  const track = (d) => (r) => {
    if (!match(r.url())) return;
    inflight.n = Math.max(0, inflight.n + d);
    inflight.last = Date.now();
  };
  page.on('request', track(1));
  page.on('requestfinished', track(-1));
  page.on('requestfailed', track(-1));
  return inflight;
}

/*
 * The one wait the browser tools have: until the backend requests `inflight`
 * counts (trackRequests) are all answered and none went out for `quietMs`,
 * and `minMs` have passed either way - true then; false at the ceiling
 * `maxMs` with the backend still busy. The boot's and the script's tails
 * used to be a fixed 600 ms each, the action wait a 100 ms grace plus a
 * 50 ms poll: a page whose roundtrips are done and quiet is looked at
 * sooner, one still busy is given what it was given before, never more.
 * The clock and the sleep are injectable - the unit test runs it on a fake
 * clock; the page's own waitForTimeout is the sleep in the browser.
 */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function quietAfter(inflight, { quietMs = 250, minMs = 0, maxMs = 600, pollMs = 50, now = Date.now, sleep = realSleep } = {}) {
  const t0 = now();
  for (;;) {
    const elapsed = now() - t0;
    const quiet = inflight.n === 0 && now() - inflight.last >= quietMs;
    if (elapsed >= maxMs) return quiet;
    if (elapsed >= minMs && quiet) return true;
    await sleep(Math.max(1, Math.min(pollMs, maxMs - elapsed)));
  }
}

/* Until the backend requests an action started have answered and nothing
 * new went out for `quietMs` - false when it is still busy after `maxMs`.
 * The first 100 ms are a grace for the roundtrip an event starts: the
 * request goes out after the click, not with it. */
export async function settle(page, inflight, { quietMs = 250, maxMs = 10000 } = {}) {
  const graceMs = Math.min(100, maxMs);
  await page.waitForTimeout(graceMs);
  return quietAfter(inflight, { quietMs, minMs: 0, maxMs: Math.max(0, maxMs - graceMs), sleep: (ms) => page.waitForTimeout(ms) });
}

/*
 * After the boot: wait until the app's first view is on screen. waitForBoot
 * is met as soon as the frontend's shell has rendered a few UI5 elements -
 * before the app's first roundtrip has been answered, its XML view built and
 * the libraries that view needs loaded. renderSettled's 600 ms covered a
 * small app; a large view (a page of tables and a custom control) was
 * photographed blank and reported ok. So: no request of the page in flight
 * for 300 ms and no change to the DOM for 300 ms, at least 300 ms, at most
 * `maxMs` - a page that never quiets (an animation, a clock) is photographed
 * when the time is up, as before, never refused for it.
 */
export async function firstViewSettled(page, inflight, { quietMs = 300, minMs = 300, maxMs = 10000, pollMs = 50, now = Date.now } = {}) {
  await page.evaluate(() => {
    window.__a2ui5Mutated = Date.now();
    new MutationObserver(() => { window.__a2ui5Mutated = Date.now(); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }).catch(() => {});
  const t0 = now();
  for (;;) {
    const elapsed = now() - t0;
    // the age of the last change, measured in the page: its clock, not ours
    const age = await page.evaluate(() => Date.now() - (window.__a2ui5Mutated || 0)).catch(() => Infinity);
    const quiet = inflight.n === 0 && now() - inflight.last >= quietMs && age >= quietMs;
    if (elapsed >= maxMs) return quiet;
    if (elapsed >= minMs && quiet) return true;
    await page.waitForTimeout(Math.max(1, Math.min(pollMs, maxMs - elapsed)));
  }
}

/* The tail after the boot and after the script: as long as it takes the
 * backend to be quiet for 250 ms, at least 250 ms for the render to settle
 * (late errors surface then), and at most the 600 ms it always was. */
const renderSettled = (page, inflight) =>
  quietAfter(inflight, { quietMs: 250, minMs: 250, maxMs: 600, sleep: (ms) => page.waitForTimeout(ms) });

/* The tallest picture taken: a full-page shot follows the content, and a
 * page of 1500 rows was a 1280x36004 PNG of 7.7 MB - past what the Claude
 * API accepts (8000 px a side) and the client's result cap. */
export const MAX_SHOT_HEIGHT = 4096;

let shotCount = 0;

/* The run_app / interact_app pictures kept on disk: every call writes one of
 * its own (below), and nothing took them away - a day of agent work left
 * hundreds of full-page PNGs, megabytes each, in the temp dir. */
export const SHOTS_KEPT = 50;
/* What finishApp names a picture: <class>[-interact]-<base36 time><count>.png.
 * Only files of that name are ever removed - the directory may be one the
 * user named (A2UI5_MCP_SCREENSHOT_DIR) and hold pictures of their own. */
const SHOT_NAME = /^[zy][a-z0-9_]*(?:-interact)?-[0-9a-z]{8,}[0-9]+\.png$/;

/** Remove all but the `keep` newest of this server's pictures in `dir`;
 *  answers how many went. Never throws: a picture that cannot be removed
 *  is left for the next call. */
export function pruneShots(dir, keep = SHOTS_KEPT) {
  let shots;
  try {
    shots = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && SHOT_NAME.test(d.name))
      .map((d) => {
        const at = path.join(dir, d.name);
        try {
          return { at, mtime: fs.lstatSync(at).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return 0;
  }
  if (shots.length <= keep) return 0;
  shots.sort((a, b) => b.mtime - a.mtime || (a.at < b.at ? 1 : -1));
  let removed = 0;
  for (const { at } of shots.slice(keep)) {
    try {
      fs.unlinkSync(at);
      removed += 1;
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed;
}

/* The picture and the report, then the context is closed. `suffix` keeps an
 * interaction's screenshot apart from the boot's on disk. */
async function finishApp(app, { fullPage = true, suffix = '' } = {}) {
  const { cls, page, ctx, errors, booted, onAbort, signal, ui5Note } = app;
  // openApp answered without a page (offline, no UI5 to serve): no picture to take
  if (app.early) return { class: cls, booted: false, ok: false, errors: [app.early], screenshotPath: null, base64: null };
  /* A screenshot dir that is not the user's own keeps the picture in the
   * answer only: the PNG is still returned, just not saved there. */
  let notSaved = null;
  try {
    notSaved = shotDirProblem({ create: true });
  } catch (e) {
    notSaved = `${shotDir()} cannot be created (${(e && e.code) || e})`;
  }
  /* One file per call: two calls on one class wrote the same path, and the
   * report of one named the other's picture. */
  shotCount += 1;
  const screenshotPath = notSaved ? null : path.join(shotDir(), `${cls}${suffix}-${Date.now().toString(36)}${shotCount}.png`);
  let base64 = null;
  let clipped = null;
  try {
    const opts = { ...(screenshotPath ? { path: screenshotPath } : {}), fullPage };
    if (fullPage) {
      const size = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      })).catch(() => null);
      if (size && size.height > MAX_SHOT_HEIGHT) {
        opts.clip = { x: 0, y: 0, width: size.width, height: MAX_SHOT_HEIGHT };
        clipped = size.height;
      }
    }
    const buf = await page.screenshot(opts);
    base64 = buf.toString('base64');
  } catch (e) {
    errors.push('screenshot: ' + String(e.message).slice(0, 200));
  }
  if (screenshotPath) pruneShots(shotDir());
  if (signal) signal.removeEventListener('abort', onAbort);
  await ctx.close();
  const errorsCut = errors.cut();
  return {
    class: cls, booted, ok: booted && errors.length === 0, errors: errors.list(), screenshotPath, base64,
    ...(errorsCut ? { errorsCut } : {}),
    ...(ui5Note ? { ui5: ui5Note } : {}),
    ...(notSaved ? { screenshotNotSaved: notSaved } : {}),
    ...(clipped ? { screenshotCut: `the page is ${clipped} px tall - the picture shows its first ${MAX_SHOT_HEIGHT} px` } : {}),
  };
}

/*
 * Boot <class> as the real app and look at it.
 *   - errors: non-benign page errors + backend HTTP >= 400 responses
 *   - booted: UI5 up and > 3 controls rendered (the e2e-smoke gate)
 *   - screenshotPath/base64: full-page PNG
 */
export async function runApp({ className, timeoutMs = 60000, fullPage = true, signal, query = '' }) {
  const app = await openApp({ className, timeoutMs, signal, tool: 'run_app', query });
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

/* The ids app_start's agent snapshot hands out: f1 a field, a1 an action,
 * t1 a table, and so on - a letter and a number. */
const SNAPSHOT_ID = /^[a-z]\d+$/;

/**
 * What a failed action says. A timeout on an element that never appeared
 * read "locator.evaluate: Timeout 10000ms exceeded." - after ten seconds, with
 * nothing on which element or why. The commonest cause is an id from
 * app_start's snapshot (`f1`, `a1`): those exist only in the snapshot, this
 * tool looks for the control's id in the page - the one the view gives it
 * with a( n = `id` ... ), which an app may not set at all. Pure.
 */
export function actionError(step, e, timeout) {
  const raw = String((e && e.message) || e).split('\n')[0].slice(0, 300);
  if (!(e && e.name === 'TimeoutError')) return raw;
  const what = step.id ? `id '${step.id}'` : step.selector ? `selector '${step.selector}'` : step.text ? `text '${step.text}'` : null;
  if (!what) return raw;
  let why = `no element with the ${what} could be acted on within ${timeout} ms`;
  if (step.id && SNAPSHOT_ID.test(step.id)) {
    why += ` - '${step.id}' looks like an id from app_start's snapshot, which exists only there: interact_app looks for the `
      + 'control\'s own id in the page (a( n = `id` v = `...` ) in the view), a CSS `selector` or its visible `text`; '
      + 'or drive the app with app_start / app_act, which take the snapshot ids';
  } else if (step.id) {
    why += ' - the view has to give the control that id, a( n = `id` v = `...` ); else address it by `text` or `selector`';
  }
  return `${why} (${raw})`;
}

/*
 * Boot <class>, perform `actions` in order, let the roundtrips settle and/*
 * Boot <class>, perform `actions` in order, let the roundtrips settle and
 * look at the result - the event branch of the app, which run_app cannot
 * reach. The report is run_app's plus one entry per action: performed or
 * not, and why not. The first action that fails stops the script (the ones
 * after it would act on a page in a state nobody asked for), and the picture
 * is still taken - the half that worked is worth looking at.
 */
export async function interactApp({ className, actions, timeoutMs = 60000, actionTimeoutMs = 10000, signal, query = '' }) {
  const steps = parseActions(actions);
  const app = await openApp({ className, timeoutMs, signal, tool: 'interact_app', query });
  const performed = [];
  if (app.booted) {
    for (const step of steps) {
      if (signal && signal.aborted) break;
      const t0 = Date.now();
      try {
        await performAction(app.page, step, actionTimeoutMs);
        const settled = await settle(app.page, app.inflight);
        performed.push({ ...step, ok: true, ms: Date.now() - t0, ...(settled ? {} : { note: 'the app was still busy 10 s after it - the next action may have been dropped' }) });
      } catch (e) {
        performed.push({ ...step, ok: false, error: actionError(step, e, actionTimeoutMs) });
        break;
      }
    }
    /* The tail after the script: the backend quiet for 250 ms (every
     * action waited for its own roundtrip in `settle` already), at least
     * 250 ms for the render. It used to wait for Playwright's `networkidle`
     * first - no request of ANY kind for 500 ms, up to 10 s - which a page
     * with a long poll or a slow theme download never reaches: the whole
     * 10 s, every call, after the actions were long settled. */
    await renderSettled(app.page, app.inflight);
  }
  if (signal && signal.aborted) {
    if (app.ctx) await app.ctx.close().catch(() => {});
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

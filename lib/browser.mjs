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
  forgetSessions();
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  if (!b || typeof b.contexts !== 'function') return;
  await Promise.all(b.contexts().map((c) => c.close().catch(() => {})));
}

export async function closeBrowser() {
  forgetSessions();
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
  /* An abort while the context was being made fired before the listener
   * below existed - and an aborted signal fires no second time, so the
   * context stayed open through the whole boot nobody was waiting for. */
  if (signal && signal.aborted) {
    await ctx.close().catch(() => {});
    throw abortError(signal);
  }
  const onAbort = () => ctx.close().catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const page = await ctx.newPage();
    await setup(page);
    if (signal && signal.aborted) throw abortError(signal);
    return { ctx, page, onAbort };
  } catch (e) {
    if (signal) signal.removeEventListener('abort', onAbort);
    await ctx.close().catch(() => {});
    throw e;
  }
}

/** The error an aborted `signal` ends a step with: its reason when that is
 *  an Error, else an AbortError of its own. */
function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
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
  // every await is a moment the client may have cancelled in: looked at
  // after each, before the next step starts something to close again
  if (signal && signal.aborted) throw cancelled();

  const browser = await getBrowser();
  if (signal && signal.aborted) throw cancelled();
  /* The listeners push into `state.errors`, not into a variable of their
   * own: a kept browser session (interact_app keep_open) starts each call
   * with a fresh log, and the listeners wired at the boot must follow it. */
  const state = { errors: createErrorLog(), files: [], pendingFiles: [] };
  const errors = { push: (m) => state.errors.push(m) };
  let inflight;
  let anyInflight;
  let ui5;
  const opened = await openPage(browser, appContextOptions(), signal, async (pg) => {
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
    /* A download the app offers (cs_event-download_b64_file, a link with
     * `download`) is written to disk and its path reported - a file the
     * agent has to judge (a PDF, a spreadsheet) is then checked with
     * ordinary tools instead of disappearing with the context. */
    pg.on('download', (d) => {
      state.pendingFiles.push(saveDownload(d, state).catch((e) => {
        errors.push(`download ${d.suggestedFilename()}: ${String((e && e.message) || e).split('\n')[0].slice(0, 200)}`);
      }));
    });
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
  }).catch((e) => {
    // openPage closed the context; an abort is the client's cancel
    throw signal && signal.aborted ? cancelled() : e;
  });
  const { ctx, page, onAbort } = opened;

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
  return Object.assign(state, { cls, page, ctx, booted, onAbort, cancelled, signal, inflight, ui5Note: ui5Report.note });
}

/* ------------------------------------------------------------ files ---- */

/* Where interact_app writes what an app hands out - a download, the src of
 * an iframe (`save`): <screenshot dir>/files, private like the pictures.
 * Null when the screenshot dir is not the user's own (shotDirProblem). */
export function filesDir() {
  try {
    if (shotDirProblem({ create: true })) return null;
  } catch {
    return null;
  }
  const dir = path.join(shotDir(), 'files');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/* The files kept: the newest FILES_KEPT of this server's naming, as the
 * pictures are (pruneShots). */
export const FILES_KEPT = 100;
const FILE_NAME = /^[zy][a-z0-9_]*-[0-9a-z]{8,}[0-9]+-[A-Za-z0-9_.-]+$/;
export const SAVE_MAX_BYTES = 50 * 1024 * 1024;
let fileCount = 0;

/** A safe file name for `want` (letters, digits, _ - . - no path, no
 *  leading dot), with the extension `type` suggests when it has none. Pure. */
export function safeFileName(want, type = '') {
  let base = String(want || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'file';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) {
    const t = String(type).toLowerCase().split(';')[0].trim();
    const ext = {
      'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
      'application/json': 'json', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'application/xml': 'xml', 'text/xml': 'xml',
      'application/zip': 'zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    }[t];
    if (ext) base += `.${ext}`;
  }
  return base;
}

function newFilePath(dir, cls, name) {
  fileCount += 1;
  return path.join(dir, `${cls}-${Date.now().toString(36)}${fileCount}-${name}`);
}

/** Remove all but the `keep` newest files of this server's naming in `dir`. */
export function pruneFiles(dir, keep = FILES_KEPT) {
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && FILE_NAME.test(d.name))
      .map((d) => ({ at: path.join(dir, d.name), mtime: fs.lstatSync(path.join(dir, d.name)).mtimeMs }));
  } catch {
    return 0;
  }
  if (files.length <= keep) return 0;
  files.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const { at } of files.slice(keep)) {
    try {
      fs.unlinkSync(at);
      removed += 1;
    } catch {
      /* left for the next call */
    }
  }
  return removed;
}

export async function saveDownload(download, state) {
  const dir = filesDir();
  if (!dir) {
    await download.cancel().catch(() => {});
    throw new Error(`not saved - ${shotDirProblem() || 'no private directory for it'}`);
  }
  const at = newFilePath(dir, state.cls || 'zapp', safeFileName(download.suggestedFilename()));
  await download.saveAs(at);
  const bytes = fs.statSync(at).size;
  state.files.push({ source: 'download', name: download.suggestedFilename(), path: at, bytes });
  pruneFiles(dir);
}

/*
 * `save`: the resource an element points at - the src of an iframe (a PDF
 * the app shows), an img, an object's data, a link's href - fetched INSIDE
 * the page, so a data: URI, a blob: URL and a backend URL all work the way
 * the page itself sees them, then written to disk.
 */
export async function saveResource(page, loc, step, timeout, state) {
  const url = await loc.evaluate((el, attr) => {
    const raw = attr ? el.getAttribute(attr) : (el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('data') || el.src || el.href || el.data);
    if (!raw) return null;
    try {
      return new URL(raw, document.baseURI).href;
    } catch {
      return raw;
    }
  }, step.attribute || null, { timeout });
  if (!url) throw new Error(`the element has no ${step.attribute || 'src, href or data'} to save`);
  const dir = filesDir();
  if (!dir) throw new Error(`not saved - ${shotDirProblem() || 'no private directory for it'}`);
  const got = await page.evaluate(async ({ u, max }) => {
    const res = await fetch(u);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) return { status: res.status, tooBig: buf.length };
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { status: res.status, type: res.headers.get('content-type') || '', b64: btoa(bin), bytes: buf.length };
  }, { u: url, max: SAVE_MAX_BYTES });
  if (got.tooBig) throw new Error(`the resource is ${got.tooBig} bytes, over the ${SAVE_MAX_BYTES / 1024 / 1024} MB a save takes`);
  if (got.status >= 400) throw new Error(`fetching it answered HTTP ${got.status}`);
  const type = got.type || (/^data:([^;,]+)/.exec(url) || [])[1] || '';
  const fromUrl = /^(?:data|blob):/.test(url) ? '' : new URL(url).pathname.split('/').pop();
  const at = newFilePath(dir, state.cls || 'zapp', safeFileName(step.name || fromUrl || 'file', type));
  fs.writeFileSync(at, Buffer.from(got.b64, 'base64'), { mode: 0o600 });
  pruneFiles(dir);
  const file = { source: 'save', path: at, bytes: got.bytes, contentType: type, from: url.length > 120 ? `${url.slice(0, 100)}... (${url.length} chars)` : url };
  state.files.push(file);
  return file;
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
async function finishApp(app, { fullPage = true, suffix = '', keep = false } = {}) {
  const { cls, page, ctx, booted, onAbort, signal, ui5Note } = app;
  const errors = app.errors;
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
  // a download still being written belongs to this answer
  if (app.pendingFiles && app.pendingFiles.length) {
    await Promise.allSettled(app.pendingFiles.splice(0));
  }
  if (!keep) await ctx.close();
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
    case 'drag': {
      /* The mouse, not Playwright's dragTo: a canvas, a splitter or a
       * sortable list listens to pointer/mouse down, move and up - and a
       * drag by an offset has no target element at all. */
      await loc.scrollIntoViewIfNeeded({ timeout });
      const from = await loc.boundingBox({ timeout });
      if (!from) throw new Error('the element to drag from is not visible');
      const x0 = from.x + (step.x !== undefined ? step.x : from.width / 2);
      const y0 = from.y + (step.y !== undefined ? step.y : from.height / 2);
      let x1 = x0 + (step.dx || 0);
      let y1 = y0 + (step.dy || 0);
      if (step.toId || step.toSelector || step.toText) {
        const to = locate(page, { id: step.toId, selector: step.toSelector, text: step.toText });
        const box = await to.boundingBox({ timeout });
        if (!box) throw new Error('the element to drag to is not visible');
        x1 = box.x + box.width / 2;
        y1 = box.y + box.height / 2;
      }
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x1, y1, { steps: step.steps || 10 });
      await page.mouse.up();
      return { from: { x: Math.round(x0), y: Math.round(y0) }, to: { x: Math.round(x1), y: Math.round(y1) } };
    }
    case 'read': {
      const value = await loc.evaluate((el, { attribute, property }) => {
        const v = attribute ? el.getAttribute(attribute) : el[property];
        if (v === undefined || v === null) return v === null ? null : undefined;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
        try {
          return JSON.parse(JSON.stringify(v));
        } catch {
          return String(v);
        }
      }, { attribute: step.attribute, property: step.property }, { timeout });
      return readValue(value);
    }
    case 'screenshot':
      return { shot: true };
    case 'save':
      return null; // performed by interactApp, which holds the files list
    default:
      throw new Error(`unknown action ${step.action}`);
  }
}

/* What a read answers: the value, a long string cut to READ_MAX
 * characters (a data: URI of a PDF is megabytes) with its full length. */
export const READ_MAX = 2000;
export function readValue(value) {
  if (value === undefined) return { value: null, note: 'the element has no such property' };
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (json !== undefined && json !== null && json.length > READ_MAX) {
    return { value: (typeof value === 'string' ? value : json).slice(0, READ_MAX), length: json.length, cut: `the value is ${json.length} characters - the first ${READ_MAX} are shown; save writes a src or href whole to disk` };
  }
  return { value };
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
 * Browser sessions that outlive a call (interact_app keep_open): the
 * context and its page stay open, and the next call continues on them with
 * `browser_session` - a flow that has to be looked at between steps is no
 * longer booted again on every call, and 30 steps are no longer the end of
 * it. At most MAX_SESSIONS at a time; one idle for SESSION_IDLE_MS is
 * closed. Stopping the backend closes every app context (stopBackend), and
 * with it every session - the next call says so.
 */
export const MAX_SESSIONS = 3;
export const SESSION_IDLE_MS = 15 * 60 * 1000;
const sessions = new Map();
let sessionCount = 0;

function touchSession(id, app) {
  if (app.idleTimer) clearTimeout(app.idleTimer);
  app.idleTimer = setTimeout(() => closeSession(id), SESSION_IDLE_MS);
  if (typeof app.idleTimer.unref === 'function') app.idleTimer.unref();
}

/* The kept sessions are gone with their contexts (closeAppContexts,
 * closeBrowser): their idle timers with them. */
function forgetSessions() {
  for (const app of sessions.values()) if (app.idleTimer) clearTimeout(app.idleTimer);
  sessions.clear();
}

/** Close a kept browser session; true when there was one. */
export async function closeSession(id) {
  const app = sessions.get(id);
  if (!app) return false;
  sessions.delete(id);
  if (app.idleTimer) clearTimeout(app.idleTimer);
  await app.ctx.close().catch(() => {});
  return true;
}

/** The kept sessions: [{ session, class, idleMs }]. */
export function listSessions() {
  return [...sessions].map(([session, app]) => ({ session, class: app.cls, idleMs: Date.now() - app.usedAt }));
}

/*
 * Boot <class> - or continue the kept session `session` - perform `actions`
 * in order, let the roundtrips settle and look at the result: the event
 * branch of the app, which run_app cannot reach. The report is run_app's
 * plus one entry per action: performed or not, and why not; a `read` adds
 * its value, a `save` its file, a `screenshot` a picture (`shots`), and
 * every download the app offered is under `files`. The first action that
 * fails stops the script (the ones after it would act on a page in a state
 * nobody asked for), and the picture is still taken - the half that worked
 * is worth looking at.
 */
export async function interactApp({ className, actions, timeoutMs = 60000, actionTimeoutMs = 10000, signal, query = '', keepOpen = false, session = null, close = false }) {
  const steps = actions === undefined && session ? [] : parseActions(actions);
  let app;
  let id = null;
  if (session) {
    app = sessions.get(session);
    if (!app || app.page.isClosed()) {
      if (app) await closeSession(session);
      throw new Error(`no browser session '${String(session).slice(0, 40)}' - it was closed (close: true, ${SESSION_IDLE_MS / 60000} min idle, `
        + 'a backend stop or build, a server restart) or never existed; start again with class_name and keep_open: true');
    }
    id = session;
    app.errors = createErrorLog();
    app.files = [];
    app.signal = signal;
    if (close && !steps.length) {
      await closeSession(session);
      return { class: app.cls, booted: true, ok: true, closed: session, actions: [], errors: [], screenshotPath: null, base64: null, shots: [], files: [] };
    }
  } else {
    if (keepOpen && sessions.size >= MAX_SESSIONS) {
      throw new Error(`${MAX_SESSIONS} browser sessions are open already (${[...sessions.keys()].join(', ')}) - close one with { browser_session, close: true } first`);
    }
    app = await openApp({ className, timeoutMs, signal, tool: 'interact_app', query });
  }
  const performed = [];
  const shots = [];
  if (app.booted) {
    for (const step of steps) {
      if (signal && signal.aborted) break;
      const t0 = Date.now();
      try {
        let detail = await performAction(app.page, step, actionTimeoutMs);
        if (step.action === 'save') detail = { file: await saveResource(app.page, locate(app.page, step), step, actionTimeoutMs, app) };
        if (step.action === 'screenshot') {
          detail = null;
          shots.push({ step: performed.length, ...(await stepShot(app, step)) });
        }
        const settled = await settle(app.page, app.inflight);
        performed.push({ ...step, ok: true, ms: Date.now() - t0, ...(detail || {}), ...(settled ? {} : { note: 'the app was still busy 10 s after it - the next action may have been dropped' }) });
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
    if (id) await closeSession(id);
    else if (app.ctx) await app.ctx.close().catch(() => {});
    throw app.cancelled();
  }
  const keep = app.booted && !close && (keepOpen || Boolean(id));
  const res = await finishApp(app, { fullPage: true, suffix: '-interact', keep });
  if (keep && !id) {
    sessionCount += 1;
    id = `b${sessionCount}${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(id, app);
  }
  if (keep) {
    app.usedAt = Date.now();
    touchSession(id, app);
  } else if (id) {
    await closeSession(id);
  }
  const skipped = steps.length - performed.length;
  return {
    ...res,
    ok: res.ok && performed.length === steps.length && performed.every((a) => a.ok),
    actions: performed,
    ...(skipped ? { notPerformed: skipped } : {}),
    shots,
    files: (app.files || []).slice(),
    ...(keep ? { session: id } : {}),
    ...(id && !keep ? { closed: id } : {}),
  };
}

/* A `screenshot` step: the page (or the element the step names) now, saved
 * like the final picture and returned with it. */
async function stepShot(app, step) {
  let notSaved = null;
  try {
    notSaved = shotDirProblem({ create: true });
  } catch (e) {
    notSaved = String((e && e.code) || e);
  }
  shotCount += 1;
  const at = notSaved ? null : path.join(shotDir(), `${app.cls}-interact-${Date.now().toString(36)}${shotCount}.png`);
  const target = step.id || step.selector || step.text ? locate(app.page, step) : app.page;
  const opts = { ...(at ? { path: at } : {}) };
  if (target === app.page) {
    const size = await app.page.evaluate(() => ({ width: document.documentElement.clientWidth, height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })).catch(() => null);
    opts.fullPage = true;
    if (size && size.height > MAX_SHOT_HEIGHT) opts.clip = { x: 0, y: 0, width: size.width, height: MAX_SHOT_HEIGHT };
  }
  const buf = await target.screenshot(opts);
  if (at) pruneShots(shotDir());
  return { screenshot: at, ...(notSaved ? { screenshotNotSaved: notSaved } : {}), base64: buf.toString('base64') };
}

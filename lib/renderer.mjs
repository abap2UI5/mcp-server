/*
 * renderer — one warm Chromium for the cheap half of the loop.
 *
 * Every validate_view/screenshot_view used to pay a full renderer cold start
 * (browser launch + UI5 boot) because the linter opened and closed its own
 * per call. The linter now takes an ALREADY-OPEN renderer as an option —
 * `{ renderer }` into checkFiles/screenshotFiles, opened via its ./render
 * export's openRenderer — and, when given one, uses it and does not close
 * it: the caller owns the lifecycle. This module is that owner.
 *
 * FEATURE-DETECTED at both ends, because the linter is an UNPINNED sibling
 * that can be older than this server:
 *   - a checkout without the ./render export (or openRenderer) has no warm
 *     path to offer;
 *   - one with ./render but whose checkFiles/screenshotFiles predate the
 *     `renderer` option would open its own renderer anyway — passing ours
 *     would only leak a browser. That support is not visible in the exports
 *     map, so it is read off the functions' own text (`o.renderer` /
 *     `opts.renderer`); the spelling is part of the linter's documented
 *     consumer contract (its DEFAULTS comment names this server), and a
 *     refactor that breaks the match fails SAFE — back to today's cold path,
 *     never to a broken one.
 *
 * One renderer per CONFIG, because theme and css are baked in at open time
 * (the gate renders sap_hcb without css, a screenshot renders the theme the
 * caller asked for with css) — keyed, single-flight, capped, evicted oldest-
 * first. Concurrent calls that share a renderer are safe: the renderer's own
 * page pool queues them. A renderer whose browser died is dropped via
 * dropRenderer and the next call opens a fresh one; the caller falls back to
 * the cold path for the call that noticed.
 */
import { importViewCheck } from './repos.mjs';

// key -> { promise } in insertion order; MAX bounds how many themes stay warm
const warm = new Map();
const MAX_WARM = 3;

/* How many pages validate_view's warm render gate keeps: concurrent calls
 * queue on the pool, and one page serialized every validate of a session
 * that runs them in parallel (an agent verifying several views at once).
 * Two by default - a page is a Chromium tab, cheap next to the browser -
 * and `A2UI5_MCP_RENDER_PAGES` sets it (1 to RENDER_PAGES_MAX; anything
 * else is the default). Pure over `env`, for the test. */
export const RENDER_PAGES_DEFAULT = 2;
export const RENDER_PAGES_MAX = 8;
export function renderPages(env = process.env) {
  const raw = env.A2UI5_MCP_RENDER_PAGES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return RENDER_PAGES_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return RENDER_PAGES_DEFAULT;
  return Math.min(n, RENDER_PAGES_MAX);
}

const keyOf = ({ pages = 1, theme, css = false } = {}) => `${pages}|${theme || ''}|${css ? 1 : 0}`;

/** The linter's openRenderer, or null when this checkout has no warm path. */
async function warmOpener() {
  let lib;
  let render;
  try {
    lib = await importViewCheck('.');
    render = await importViewCheck('./render');
  } catch {
    return null; // no ./render export (or no linter at all): cold path
  }
  if (!render || typeof render.openRenderer !== 'function') return null;
  const text = String(lib.checkFiles || '') + String(lib.screenshotFiles || '');
  if (!/\b(?:o|opts)\.renderer\b/.test(text)) return null; // option predates this checkout
  return render.openRenderer;
}

/**
 * A warm renderer for this config, or null when the linter offers no warm
 * path (older checkout, missing render deps) — null means: run the call the
 * way it always ran, and let the linter say its own words about anything
 * missing. Never throws.
 */
export async function getRenderer(config = {}) {
  const opener = await warmOpener().catch(() => null);
  if (!opener) return null;
  const key = keyOf(config);
  let slot = warm.get(key);
  if (!slot) {
    // single-flight per config: the promise goes into the map before any await
    const promise = Promise.resolve()
      .then(() => opener(config))
      .catch(() => null); // deps missing etc: the cold path reports it canonically
    slot = { promise };
    warm.set(key, slot);
    while (warm.size > MAX_WARM) {
      const [oldestKey, oldest] = warm.entries().next().value;
      warm.delete(oldestKey);
      oldest.promise.then((r) => r && r.close()).catch(() => {});
    }
  }
  const renderer = await slot.promise;
  if (!renderer && warm.get(key) === slot) warm.delete(key); // failed open: retry next call
  return renderer;
}

/** Drop (and close) the warm renderer for this config — for a caller that
 *  just watched its browser die; the next call opens a fresh one.
 *
 *  `renderer`: the one the caller watched die. Two calls that shared a
 *  renderer both see it die; the first drop opens the way for a fresh one,
 *  and the second drop used to close THAT one - under whatever call was
 *  using it by then, which saw a dead browser in turn. With `renderer`
 *  given, a slot that holds another renderer by now is left alone. */
export async function dropRenderer(config = {}, renderer = undefined) {
  const key = keyOf(config);
  const slot = warm.get(key);
  if (!slot) return;
  if (renderer !== undefined && (await slot.promise) !== renderer) return;
  if (warm.get(key) !== slot) return; // dropped (or replaced) while this waited
  warm.delete(key);
  await slot.promise.then((r) => r && r.close()).catch(() => {});
}

/** Shutdown: close every warm renderer, next to stopBackend/closeBrowser. */
export async function closeRenderers() {
  const slots = [...warm.values()];
  warm.clear();
  await Promise.all(slots.map((s) => s.promise.then((r) => r && r.close()).catch(() => {})));
}

/* A dead shared browser does not throw out of the linter: render( ) catches
 * the page error and reports it as a HARNESS line, so the call "succeeds"
 * with errors that are about the renderer, not the view. This is the tell. */
const DEAD = /HARNESS:.*(target.*closed|browser has been closed|session closed|connection closed|crashed)/i;

export function rendererLooksDead(errorStrings) {
  return (errorStrings || []).some((e) => DEAD.test(String(e)));
}

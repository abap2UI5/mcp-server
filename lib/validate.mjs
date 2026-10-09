/*
 * validate — what validate_view does when the render gate cannot run at all.
 *
 * validate_view runs two gates through the linter: the property gate (pure
 * JavaScript, always there) and the render gate (UI5 in a headless Chromium,
 * which needs @abap2ui5/linter-render and a browser that launches). When the
 * second could not START - the runtime package not installed, a Chromium
 * that would not launch - the linter throws, and the tool used to return
 * that throw as its whole answer: an error, or Playwright's launch log (5 KB
 * of ANSI-coloured argv), and none of the property findings that had already
 * been computed. The one gate that did work was thrown away with the one
 * that did not.
 *
 * Now the check is repeated with render: false and the reason goes into the
 * notes: the agent gets the findings it can act on and one sentence on why
 * the picture half is missing. A render gate that RAN and found errors is
 * not this case - those are findings (renderErrors), and stay exactly as
 * they were. In lib/ so the fallback is testable (server.mjs connects stdio
 * at module scope and may not be imported by a test).
 */

/** The first meaningful line of a render-infrastructure error, without the
 *  terminal colour codes Playwright's launch log carries, capped. */
export function renderFailureReason(err) {
  const text = String((err && err.message) || err || 'unknown error')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * Run `withRender()`; when it throws and rendering was asked for, run
 * `withoutRender()` instead and say why. Resolves to `{ result, renderSkipped }`
 * where `renderSkipped` is the reason, or null when the render gate ran.
 * Rethrows when rendering was not asked for (then the throw is about
 * something else) or when the property-only retry fails too.
 */
export async function withRenderFallback({ render, withRender, withoutRender }) {
  try {
    return { result: await withRender(), renderSkipped: null };
  } catch (e) {
    if (render === false) throw e;
    const reason = renderFailureReason(e);
    const result = await withoutRender();
    return { result, renderSkipped: reason };
  }
}

/** The note validate_view adds when the render gate was skipped. */
export function renderSkippedNote(reason) {
  return `render gate skipped - it could not start (${reason}); these are the property findings only. `
    + 'The render gate needs @abap2ui5/linter-render installed beside the linter and a Chromium Playwright can launch '
    + '(the linter reads CHROMIUM_BIN for one); render: false skips it on purpose.';
}

/**
 * The render gate on a WARM renderer, retried cold when that renderer
 * failed: `warm()` runs the check on the shared browser, `cold()` runs it on
 * a browser of its own, `drop()` retires the warm one for the next call, and
 * `looksDead(result)` spots a browser that died without a throw (the HARNESS
 * lines). A throw out of the warm run - a wedged page the dead browser could
 * not reload - used to go straight to withRenderFallback, so the answer was
 * the property findings alone, with a note that the render gate "could not
 * start" and needs @abap2ui5/linter-render installed: wrong on both counts,
 * when a cold run renders fine. A throw of the cold run is the real answer.
 */
export async function warmThenCold({ warm, cold, drop, looksDead }) {
  let result;
  try {
    result = await warm();
  } catch {
    await drop();
    return cold();
  }
  if (looksDead(result)) {
    await drop();
    return cold();
  }
  return result;
}

/**
 * The one-line `hint` of a validate_view answer, from what is left in it.
 * It used to explain an event without a handler whenever ANY hint was left
 * - beside an unused namespace or a spelled-out get_event_arg( 1 ), neither
 * of which has anything to do with events - and never said that fix_view
 * clears the findings marked `fixable`. `findings` are the listed ones
 * (each with `type`, `severity` and, where fix_view can clear it, `fixable`).
 */
export function validateHint(counts, findings = []) {
  const fixable = findings.some((f) => f && f.fixable === true)
    ? '; fix_view clears the ones marked fixable: true'
    : '';
  if (counts.error === 0 && counts.warning > 0) {
    return `what is left is about the UI5 version you target: fix it, raise min_ui5 if the system is newer, or accept it via allow${fixable}`;
  }
  if (counts.error === 0 && counts.hint > 0) {
    const events = findings.some((f) => f && f.type === 'event-without-handler')
      ? ' - an event without a handler is intended when the roundtrip alone is the point'
      : '';
    return `hints are advisory, ok stays true${events}${fixable}`;
  }
  return undefined;
}

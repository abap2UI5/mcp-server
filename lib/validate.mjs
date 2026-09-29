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

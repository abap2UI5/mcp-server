/*
 * screenshot — photograph the view a source builds, without a system.
 *
 * The cheap half of "let me see it". The linter reconstructs the view from the
 * z2ui5_cl_ui5_view_builder calls, seeds it with a model derived from the
 * class's own TYPES/DATA and renders it in the same headless harness its render
 * gate already uses; `--screenshot` keeps that view standing and photographs it
 * instead of throwing it away. Seconds, no backend, no transpile.
 *
 * This server had no way to reach it. The only way for an agent to SEE anything
 * was `run_app`, which boots the REAL app and therefore needs a full transpile
 * of the framework first - tens of minutes, once, and a rebuild after every
 * edit. So the loop was: write ABAP, get a verdict in seconds, and then either
 * pay a build to look at it or never look at it at all.
 *
 * Nothing about taking the picture is implemented here. This is the file
 * handling the linter's API needs (it takes paths, because that is what the CLI
 * has) and the viewport parsing the MCP argument shape needs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/* `390x844` -> { width: 390, height: 844 }. Refused rather than guessed at: a
 * size that silently fell back to the default would produce a picture of the
 * WRONG viewport, which is worse than no picture when the viewport is the
 * question being asked.
 *
 * BOUNDED, because each entry is a browser viewport and a PNG that has to
 * travel back through the protocol: the pattern alone accepted `99999x99999`
 * (a ten-gigapixel full-page screenshot) and any number of viewports at once.
 * Both limits are far above any real device and are refused by name rather
 * than clamped - a picture at a viewport nobody asked for is the failure this
 * whole function exists to prevent. */
const MAX_EDGE = 4096;
const MAX_VIEWPORTS = 8;

export function parseSizes(sizes) {
  if (!sizes || ![sizes].flat().length) return undefined;
  const list = [sizes].flat();
  if (list.length > MAX_VIEWPORTS) {
    throw new Error(`too many sizes (${list.length}) — at most ${MAX_VIEWPORTS} viewports per call`);
  }
  return list.map((s) => {
    const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(s).trim().toLowerCase());
    if (!m) throw new Error(`invalid size '${s}' — use WIDTHxHEIGHT, e.g. 390x844`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width > MAX_EDGE || height > MAX_EDGE) {
      throw new Error(`size '${s}' is out of range — at most ${MAX_EDGE}x${MAX_EDGE}`);
    }
    return { width, height };
  });
}

/*
 * Photograph one source. `screenshotFiles` is the linter's own export and takes
 * FILES, so the source is written to a temp directory and removed again - the
 * same shape validate_view uses, and for the same reason: an MCP client sends
 * source, never a path into a checkout this server can read.
 *
 * Returns the linter's entries untouched ({ file, index, kind, size, png,
 * errors }) - the caller decides what to say about them.
 */
export async function screenshotSource({ screenshotFiles, abapSource, xml, sizes, theme, model, onProgress }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-shot-'));
  const file = path.join(dir, xml ? 'source.view.xml' : 'source.clas.abap');
  try {
    fs.writeFileSync(file, xml || abapSource);
    // onProgress is the linter's own callback shape ({ phase, done, total });
    // an older linter ignores options it does not know, so passing it can
    // never break a checkout that predates it
    return await screenshotFiles([file], {
      ...(sizes ? { sizes } : {}),
      ...(theme ? { theme } : {}),
      ...(model ? { model } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

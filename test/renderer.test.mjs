// The warm-renderer feature detection (lib/renderer.mjs): the warm path may
// only engage when the linter BOTH exports ./render openRenderer AND its
// checkFiles/screenshotFiles honour a caller-supplied renderer - anything
// less must leave today's cold path exactly as it is. Sibling-free: fake
// linter checkouts built in a temp dir, pointed at via the authoritative env
// var. A file of its own because AI_VIEW_CHECK_HOME has to be juggled around
// dynamic imports without other suites racing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getRenderer, dropRenderer, closeRenderers } = await import('../lib/renderer.mjs');
const { rendererLooksDead } = await import('../lib/renderer.mjs');

/* A fake linter checkout: enough package.json to pass the resolver's identity
 * check (exports with '.' and './findings'), index/findings/render modules
 * shaped by each test. */
function fakeLinter({ withRenderExport, checkFilesText, openMarker }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-warm-'));
  const dir = path.join(base, 'linter');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const exports = {
    '.': './lib/index.mjs',
    './findings': './lib/findings.mjs',
    ...(withRenderExport ? { './render': './lib/render.mjs' } : {}),
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-linter', exports }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.mjs'), checkFilesText);
  fs.writeFileSync(path.join(dir, 'lib', 'findings.mjs'), 'export const SEVERITIES = ["error"];');
  if (withRenderExport) {
    fs.writeFileSync(
      path.join(dir, 'lib', 'render.mjs'),
      `import fs from 'fs';
       export async function openRenderer(config = {}) {
         fs.appendFileSync(${JSON.stringify(openMarker)}, 'open\\n');
         return { config, closed: false, async close() { this.closed = true; fs.appendFileSync(${JSON.stringify(openMarker)}, 'close\\n'); } };
       }`,
    );
  }
  return { base, dir };
}

async function withFakeLinter(shape, fn) {
  const marker = path.join(os.tmpdir(), `a2ui5-warm-marker-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(marker, '');
  const { base, dir } = fakeLinter({ ...shape, openMarker: marker });
  const saved = process.env.AI_VIEW_CHECK_HOME;
  process.env.AI_VIEW_CHECK_HOME = dir;
  try {
    return await fn({ marker });
  } finally {
    if (saved === undefined) delete process.env.AI_VIEW_CHECK_HOME;
    else process.env.AI_VIEW_CHECK_HOME = saved;
    await closeRenderers();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }
}

// checkFiles/screenshotFiles that HONOUR opts.renderer (the new linter shape)
const NEW_SHAPE = `
export async function checkFiles(files, opts = {}) {
  const o = { ...opts };
  const ownRenderer = !o.renderer;
  return [];
}
export async function screenshotFiles(files, opts = {}) {
  const renderer = opts.renderer ?? null;
  return [];
}`;

// the OLD shape: a local variable named renderer, but no caller option
const OLD_SHAPE = `
export async function checkFiles(files, opts = {}) {
  const renderer = await Promise.resolve({ close() {} });
  return [];
}
export async function screenshotFiles(files, opts = {}) {
  return [];
}`;

test('no linter checkout at all: getRenderer answers null, never throws', async () => {
  const saved = process.env.AI_VIEW_CHECK_HOME;
  process.env.AI_VIEW_CHECK_HOME = path.join(os.tmpdir(), 'a2ui5-no-such-linter');
  try {
    assert.equal(await getRenderer({ pages: 1 }), null);
  } finally {
    if (saved === undefined) delete process.env.AI_VIEW_CHECK_HOME;
    else process.env.AI_VIEW_CHECK_HOME = saved;
  }
});

test('a linter without the ./render export stays on the cold path', async () => {
  await withFakeLinter({ withRenderExport: false, checkFilesText: NEW_SHAPE }, async () => {
    assert.equal(await getRenderer({ pages: 1 }), null);
  });
});

test('a linter whose checkFiles predates the renderer option stays cold', async () => {
  await withFakeLinter({ withRenderExport: true, checkFilesText: OLD_SHAPE }, async ({ marker }) => {
    assert.equal(await getRenderer({ pages: 1 }), null);
    assert.equal(fs.readFileSync(marker, 'utf8'), '', 'no browser may be opened for a linter that would not use it');
  });
});

test('a supporting linter gets ONE warm renderer per config, shared and closable', async () => {
  await withFakeLinter({ withRenderExport: true, checkFilesText: NEW_SHAPE }, async ({ marker }) => {
    // two concurrent calls: single-flight, one open
    const [a, b] = await Promise.all([getRenderer({ pages: 1 }), getRenderer({ pages: 1 })]);
    assert.ok(a, 'the warm path engages');
    assert.equal(a, b, 'concurrent calls share the renderer');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'open\n', 'exactly one browser opened');

    // a different config (another theme) is a different renderer
    const themed = await getRenderer({ theme: 'sap_horizon', css: true });
    assert.ok(themed && themed !== a);

    // a dropped renderer is closed and the next call opens a fresh one
    await dropRenderer({ pages: 1 });
    assert.ok(fs.readFileSync(marker, 'utf8').includes('close\n'));
    const fresh = await getRenderer({ pages: 1 });
    assert.ok(fresh && fresh !== a, 'a fresh renderer after the drop');
  });
});

test('rendererLooksDead spots a dead browser and leaves view errors alone', () => {
  assert.equal(rendererLooksDead(['HARNESS: Target page, context or browser has been closed']), true);
  assert.equal(rendererLooksDead(['HARNESS: browser has been closed']), true);
  assert.equal(rendererLooksDead(['Error: failed to load View: undefined resource sap/m/Nope']), false);
  assert.equal(rendererLooksDead([]), false);
  assert.equal(rendererLooksDead(undefined), false);
});

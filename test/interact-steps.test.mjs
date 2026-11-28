// interact_app's newer steps (drag, read, save, screenshot) and the files an
// app hands out: the parser's refusals here, and the mechanics against a
// real page in a headless Chromium served by the test itself - a canvas
// that only a mouse drag draws on, an iframe whose src is a data: URI, a
// download link. Skipped where no Chromium is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseActions, MAX_STEP_SHOTS } from '../lib/interact.mjs';
import { performAction, locate, saveResource, saveDownload, safeFileName, readValue, READ_MAX } from '../lib/browser.mjs';

test('drag: needs a start element and a target, an element OR an offset', () => {
  assert.deepEqual(parseActions([{ action: 'drag', selector: 'canvas', dx: 40, dy: -5 }]),
    [{ action: 'drag', selector: 'canvas', dx: 40, dy: -5, steps: 10 }]);
  assert.deepEqual(parseActions([{ action: 'drag', id: 'item1', to_id: 'item3', x: 2, y: 3, steps: 4 }]),
    [{ action: 'drag', id: 'item1', toId: 'item3', x: 2, y: 3, steps: 4 }]);
  assert.throws(() => parseActions([{ action: 'drag', dx: 4 }]), /drag needs id, selector or text/);
  assert.throws(() => parseActions([{ action: 'drag', id: 'a' }]), /drag needs where to/);
  assert.throws(() => parseActions([{ action: 'drag', id: 'a', to_id: 'b', dx: 3 }]), /OR by an offset/);
  assert.throws(() => parseActions([{ action: 'drag', id: 'a', to_id: 'b', to_text: 'c' }]), /ONE of to_id/);
  assert.throws(() => parseActions([{ action: 'drag', id: 'a', dx: '4' }]), /`dx` must be a number/);
  assert.throws(() => parseActions([{ action: 'drag', id: 'a', dx: 4, steps: 0.5 }]), /`steps` must be an integer/);
  assert.throws(() => parseActions([{ action: 'click', id: 'a', dx: 4 }]), /dx belongs to a drag/);
});

test('read takes ONE of attribute or property; save an optional attribute and a safe name', () => {
  assert.deepEqual(parseActions([{ action: 'read', selector: 'iframe', attribute: 'src' }]), [{ action: 'read', selector: 'iframe', attribute: 'src' }]);
  assert.deepEqual(parseActions([{ action: 'read', id: 'f', property: 'value' }]), [{ action: 'read', id: 'f', property: 'value' }]);
  assert.throws(() => parseActions([{ action: 'read', id: 'f' }]), /ONE of `attribute`/);
  assert.throws(() => parseActions([{ action: 'read', id: 'f', attribute: 'a', property: 'b' }]), /ONE of `attribute`/);
  assert.throws(() => parseActions([{ action: 'read', attribute: 'src' }]), /read needs id, selector or text/);
  assert.deepEqual(parseActions([{ action: 'save', selector: 'iframe', name: 'form.pdf' }]), [{ action: 'save', selector: 'iframe', name: 'form.pdf' }]);
  assert.throws(() => parseActions([{ action: 'save', selector: 'iframe', name: '../x' }]), /`name` may hold/);
  assert.throws(() => parseActions([{ action: 'save', selector: 'iframe', name: '.hidden' }]), /`name` may hold/);
  assert.throws(() => parseActions([{ action: 'save' }]), /save needs id, selector or text/);
  assert.throws(() => parseActions([{ action: 'click', id: 'a', property: 'value' }]), /`property` belongs to a read/);
  assert.throws(() => parseActions([{ action: 'click', id: 'a', name: 'x' }]), /`name` belongs to a save/);
});

test('screenshot steps: a page or an element, at most MAX_STEP_SHOTS', () => {
  assert.deepEqual(parseActions([{ action: 'screenshot' }, { action: 'screenshot', id: 'panel' }]), [{ action: 'screenshot' }, { action: 'screenshot', id: 'panel' }]);
  assert.throws(() => parseActions(Array.from({ length: MAX_STEP_SHOTS + 1 }, () => ({ action: 'screenshot' }))), /at most 5 screenshot steps/);
});

test('safeFileName: no path, no leading dot, the extension from the content type', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('.bashrc'), 'bashrc');
  assert.equal(safeFileName('form', 'application/pdf'), 'form.pdf');
  assert.equal(safeFileName('report.xlsx', 'application/pdf'), 'report.xlsx');
  assert.equal(safeFileName('a b?c', 'text/plain; charset=utf-8'), 'a_b_c.txt');
  assert.equal(safeFileName('', ''), 'file');
});

test('readValue cuts a long value and says how long it was', () => {
  assert.deepEqual(readValue('x'), { value: 'x' });
  assert.deepEqual(readValue(undefined), { value: null, note: 'the element has no such property' });
  const long = readValue('d'.repeat(READ_MAX + 10));
  assert.equal(long.value.length, READ_MAX);
  assert.equal(long.length, READ_MAX + 10);
});

const PDF = '%PDF-1.4\n% a tiny not-really pdf\n';
const PAGE = `<!doctype html><html><body style="margin:0">
<canvas id="__xmlview0--pad" width="200" height="100" style="display:block"></canvas>
<p id="trace">none</p>
<iframe id="viewer" src="data:application/pdf;base64,${Buffer.from(PDF).toString('base64')}"></iframe>
<a id="dl" href="data:text/plain;base64,${Buffer.from('hello file').toString('base64')}" download="hello.txt">Download</a>
<input id="field" value="typed">
<script>
  const c = document.getElementById('__xmlview0--pad');
  let down = null;
  c.addEventListener('mousedown', (e) => { down = [e.offsetX, e.offsetY]; });
  c.addEventListener('mouseup', (e) => { if (down) document.getElementById('trace').textContent = down.join(',') + '->' + e.offsetX + ',' + e.offsetY; down = null; });
</script></body></html>`;

async function browserOrNull() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch();
  } catch {
    for (const c of [process.env.A2UI5_MCP_CHROMIUM, '/opt/pw-browsers/chromium', '/usr/bin/chromium'].filter(Boolean)) {
      if (fs.existsSync(c)) {
        try {
          return await chromium.launch({ executablePath: c });
        } catch {
          /* next */
        }
      }
    }
  }
  return null;
}

test('drag draws on a canvas, read answers an attribute, save and a download land on disk', async (t) => {
  const browser = await browserOrNull();
  if (!browser) {
    t.skip('no Chromium for Playwright on this machine');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const before = process.env.A2UI5_MCP_SCREENSHOT_DIR;
  process.env.A2UI5_MCP_SCREENSHOT_DIR = dir;
  const srv = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const ctx = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const state = { cls: 'zcl_test', files: [] };

    const [drag] = parseActions([{ action: 'drag', id: 'pad', x: 10, y: 20, dx: 50, dy: 30 }]);
    const moved = await performAction(page, drag, 5000);
    assert.deepEqual(await page.textContent('#trace'), '10,20->60,50');
    assert.equal(moved.to.x - moved.from.x, 50);

    const [read] = parseActions([{ action: 'read', selector: '#viewer', attribute: 'src' }]);
    const got = await performAction(page, read, 5000);
    assert.match(got.value, /^data:application\/pdf;base64,/);
    const [prop] = parseActions([{ action: 'read', id: 'field', property: 'value' }]);
    assert.deepEqual(await performAction(page, prop, 5000), { value: 'typed' });

    const [save] = parseActions([{ action: 'save', selector: '#viewer' }]);
    const file = await saveResource(page, locate(page, save), save, 5000, state);
    assert.equal(fs.readFileSync(file.path, 'utf8'), PDF);
    assert.match(file.path, /\.pdf$/);
    assert.ok(file.path.startsWith(path.join(dir, 'files')));

    const download = page.waitForEvent('download');
    await page.click('#dl');
    await saveDownload(await download, state);
    const dl = state.files.find((f) => f.source === 'download');
    assert.equal(dl.name, 'hello.txt');
    assert.equal(fs.readFileSync(dl.path, 'utf8'), 'hello file');
  } finally {
    await ctx.close();
    await browser.close();
    srv.close();
    if (before === undefined) delete process.env.A2UI5_MCP_SCREENSHOT_DIR;
    else process.env.A2UI5_MCP_SCREENSHOT_DIR = before;
  }
});

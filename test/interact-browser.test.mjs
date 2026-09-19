// interact_app's hands against a real page: the four actions (click, fill,
// press, wait) performed in a headless Chromium on a static page this test
// serves itself - no backend, no UI5, no network. What it proves is the
// mechanics the UI5 page relies on: a builder id is found as-is and as the
// view-prefixed `--id`, a fill lands in the inner input of a wrapper control
// and commits through Tab (the change event), a click by exact text hits the
// button, a press reaches the focused element, a wait-for-text waits.
// Skipped where no Chromium is there (the same lookup run_app makes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { locate, performAction } from '../lib/runtime.mjs';
import { parseActions } from '../lib/interact.mjs';

const PAGE = `<!doctype html><html><body>
<div id="__xmlview0--name" class="sapMInput"><input id="__xmlview0--name-inner" type="text"></div>
<button id="__xmlview0--save" type="button">Save</button>
<button type="button" id="plain">Reset</button>
<p id="out"></p>
<p id="changes">0</p>
<script>
  const inner = document.getElementById('__xmlview0--name-inner');
  let changes = 0;
  inner.addEventListener('change', () => { changes++; document.getElementById('changes').textContent = String(changes); });
  inner.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('out').textContent = 'entered ' + inner.value; });
  document.getElementById('__xmlview0--save').addEventListener('click', () => {
    setTimeout(() => { document.getElementById('out').textContent = 'Saved, ' + inner.value; }, 150);
  });
  document.getElementById('plain').addEventListener('click', () => { inner.value = ''; document.getElementById('out').textContent = 'reset'; });
</script></body></html>`;

async function browserOrNull() {
  const { chromium } = await import('playwright');
  const explicit = process.env.A2UI5_MCP_CHROMIUM;
  const candidates = [explicit, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  try {
    return await chromium.launch();
  } catch {
    for (const c of candidates) {
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

test('the four actions drive a page the way a UI5 view expects', async (t) => {
  const browser = await browserOrNull();
  if (!browser) {
    t.skip('no Chromium for Playwright on this machine');
    return;
  }
  const srv = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const text = (sel) => page.locator(sel).textContent();

    // fill by builder id: the wrapper is found through the view prefix, the
    // value lands in the inner input, Tab commits it (one change event)
    const [fill] = parseActions([{ action: 'fill', id: 'name', value: 'World' }]);
    await performAction(page, fill, 5000);
    assert.equal(await page.locator('#__xmlview0--name-inner').inputValue(), 'World');
    assert.equal(await text('#changes'), '1');

    // click by exact text; the page answers after a delay, and a wait for the
    // text (a locator wait) sees it arrive
    const [click, waitText] = parseActions([{ action: 'click', text: 'Save' }, { action: 'wait', text: 'Saved, World' }]);
    await performAction(page, click, 5000);
    await performAction(page, waitText, 5000);
    assert.equal(await text('#out'), 'Saved, World');

    // press on a located element reaches it; fill without commit leaves the
    // change event unfired
    const [fill2] = parseActions([{ action: 'fill', selector: '#__xmlview0--name-inner', value: 'Again', commit: false }]);
    await performAction(page, fill2, 5000);
    assert.equal(await text('#changes'), '1', 'commit: false fires no change');
    const [press] = parseActions([{ action: 'press', id: 'name-inner', key: 'Enter' }]);
    await performAction(page, press, 5000);
    assert.equal(await text('#out'), 'entered Again');

    // an exact id (no view prefix) resolves too, and a plain wait waits
    const [reset, pause] = parseActions([{ action: 'click', id: 'plain' }, { action: 'wait', ms: 50 }]);
    await performAction(page, reset, 5000);
    await performAction(page, pause, 5000);
    assert.equal(await text('#out'), 'reset');

    // a locator that matches nothing fails within the action timeout, with
    // Playwright's message - what interact_app records per action
    const [missing] = parseActions([{ action: 'click', text: 'No such button' }]);
    await assert.rejects(performAction(page, missing, 300), /Timeout|waiting for/);
    assert.equal(typeof locate(page, { text: 'Save' }).click, 'function', 'locate answers a Playwright locator');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.close();
  }
});

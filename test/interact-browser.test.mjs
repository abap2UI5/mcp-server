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
import { locate, performAction, settle, trackRequests, watchUi5, ui5LoadReport } from '../lib/runtime.mjs';
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
    // a fill too: its look for the editable element waited Playwright's 30 s
    // default before the fill's own timeout began
    const [fillMissing] = parseActions([{ action: 'fill', id: 'no-such-field', value: 'x' }]);
    const t0 = Date.now();
    await assert.rejects(performAction(page, fillMissing, 300), /Timeout/);
    assert.ok(Date.now() - t0 < 5000, `a fill of a missing element fails within the action timeout, took ${Date.now() - t0} ms`);
    assert.equal(typeof locate(page, { text: 'Save' }).click, 'function', 'locate answers a Playwright locator');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.close();
  }
});

/* The frontend drops an event fired while a roundtrip runs, and its busy
 * overlay shows only after a second: two quick clicks lost the second, and
 * both were reported as performed. interact_app waits for the roundtrip an
 * action started (settle) before the next one. */
test('an action waits for the roundtrip it started before the next one', async (t) => {
  const browser = await browserOrNull();
  if (!browser) {
    t.skip('no Chromium for Playwright on this machine');
    return;
  }
  const page2 = `<!doctype html><html><body><button id="add" type="button">Add</button><p id="count">0</p><script>
    let busy = false; let count = 0;
    document.getElementById('add').addEventListener('click', async () => {
      if (busy) return; // what the frontend does with an event during a roundtrip
      busy = true;
      const r = await fetch('/roundtrip', { method: 'POST' });
      count = Number(await r.text()) + count;
      document.getElementById('count').textContent = String(count);
      busy = false;
    });
  </script></body></html>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/roundtrip') setTimeout(() => res.end('1'), 400);
    else res.writeHead(200, { 'content-type': 'text/html' }).end(page2);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const inflight = trackRequests(page, (u) => u.endsWith('/roundtrip'));
    const [click] = parseActions([{ action: 'click', id: 'add' }]);
    for (let i = 0; i < 3; i += 1) {
      await performAction(page, click, 5000);
      assert.equal(await settle(page, inflight), true);
    }
    assert.equal(await page.locator('#count').textContent(), '3', 'every click reached the app');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.close();
  }
});

/* UI5 that does not load used to be in no report: run_app answered a boot
 * timeout and a blank picture when the CDN was out of reach (no local
 * @openui5 packages, a proxy that refuses sdk.openui5.org), and an app that
 * booted without its theme was ok with an unstyled one. watchUi5 records the
 * failed /resources/ requests of the page, ui5LoadReport says what they mean. */
test('a UI5 bootstrap or theme that does not load is named, with what to do', async (t) => {
  const browser = await browserOrNull();
  if (!browser) {
    t.skip('no Chromium for Playwright on this machine');
    return;
  }
  const srv = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head>'
        + '<link rel="stylesheet" href="/resources/sap/m/themes/sap_horizon/library.css">'
        + '<script src="/resources/sap-ui-cachebuster/sap-ui-core.js"></script></head><body>app</body></html>');
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const page = await browser.newPage();
  try {
    const ui5 = watchUi5(page);
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForTimeout(200);
    assert.deepEqual(ui5.failed.map((f) => [new URL(f.url).pathname, f.reason]).sort(), [
      ['/resources/sap-ui-cachebuster/sap-ui-core.js', 'HTTP 404'],
      ['/resources/sap/m/themes/sap_horizon/library.css', 'HTTP 404'],
    ]);
    const sapLoaded = await page.evaluate(() => Boolean(window.sap && window.sap.ui));
    const report = ui5LoadReport({ booted: false, sapLoaded, failed: ui5.failed });
    assert.match(report.error, /^UI5 did not load, so no app could boot: http:\/\/127\.0\.0\.1:\d+\/resources\/sap-ui-cachebuster\/sap-ui-core\.js - HTTP 404 \(and 1 more UI5 request\(s\)\)\./);
    assert.match(report.error, /npm ci in a samples-controls checkout/);
    assert.match(report.error, /app_start answers its screen without a browser/);
    assert.equal(report.note, null);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.close();
  }
});

test('ui5LoadReport: nothing failed is nothing to say; a booted app is a note, offline names its switch', () => {
  assert.deepEqual(ui5LoadReport({ booted: true, sapLoaded: true, failed: [] }), { error: null, note: null });
  assert.deepEqual(ui5LoadReport({ booted: false, sapLoaded: false, failed: [] }), { error: null, note: null }, 'a boot that failed with UI5 there is the app\'s');
  const theme = [{ url: 'https://sdk.openui5.org/resources/sap/m/themes/sap_horizon/library.css', reason: 'net::ERR_TUNNEL_CONNECTION_FAILED' }];
  const booted = ui5LoadReport({ booted: true, sapLoaded: true, failed: theme, localUi5: true });
  assert.equal(booted.error, null);
  assert.match(booted.note, /^1 UI5 request\(s\) failed: https:\/\/sdk\.openui5\.org\/resources\/sap\/m\/themes\/sap_horizon\/library\.css - net::ERR_TUNNEL_CONNECTION_FAILED\. The app booted, but the picture may lack its theme/);
  assert.match(booted.note, /@openui5 packages and takes what they lack from the CDN/);
  assert.match(booted.note, /themes as \.less sources only/);
  assert.doesNotMatch(booted.note, /npm ci/, 'the packages are there: installing them is no remedy');
  // the stylesheet is named before another resource
  const two = ui5LoadReport({ booted: true, sapLoaded: true, failed: [{ url: 'https://sdk.openui5.org/resources/sap-ui-version.json', reason: 'x' }, ...theme], localUi5: true });
  assert.match(two.note, /^2 UI5 request\(s\) failed: https:\/\/sdk\.openui5\.org\/resources\/sap\/m\/themes/);
  const offline = ui5LoadReport({ booted: false, sapLoaded: false, failed: theme, offline: true });
  assert.match(offline.error, /A2UI5_MCP_OFFLINE is set/);
  // UI5 there and the app still not booted: the app's own failure, not UI5's
  assert.equal(ui5LoadReport({ booted: false, sapLoaded: true, failed: theme }).error, null);
});

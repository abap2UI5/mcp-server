// stdio smoke: boots the real server and drives the MCP handshake. Needs the
// samples-controls sibling checkout (the server reads its content live) - the test
// SKIPS cleanly when it is absent, so `npm test` stays green in a bare CI
// checkout while still exercising the full path in a sibling workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSamplesControls, resolveViewCheck, resolveA2UI5, resolveDocs } from '../lib/repos.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { RESOURCE_URIS, GUIDE_CHAPTER_TEMPLATE } from '../lib/resources.mjs';
import { PROMPT_NAMES } from '../lib/prompts.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const HAVE_CORPUS = !!resolveSamplesControls();
const HAVE_LINTER = !!resolveViewCheck();
const HAVE_A2UI5 = !!resolveA2UI5();
const HAVE_DOCS = !!resolveDocs();
/* The picture needs more than the linter checkout: the UI5 sources and the
 * browser that renders them, which is an opt-in install there
 * (@abap2ui5/render-runtime + `playwright install chromium`). Absent, this is
 * not a failure of anything in THIS repo. */
const HAVE_RENDER_RUNTIME = HAVE_LINTER
  && fs.existsSync(path.join(resolveViewCheck(), 'node_modules', '@openui5', 'sap.m'));

/* The complete tool surface, DERIVED from the TOOLS array rather than kept as
 * a copy here (this list was one of the four hand-duplicates AGENTS.md flagged
 * as a drift trap). What this smoke still pins is that the running server
 * serves exactly that array over stdio. */

test(`stdio smoke: initialize, ${TOOL_NAMES.length} tools, a capabilities query`, { skip: !HAVE_CORPUS && 'samples-controls sibling not found' }, async () => {
  const p = spawn('node', [path.join(ROOT, 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 5000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const msgs = buf
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const hit = msgs.find(pred);
        if (hit) {
          clearInterval(iv);
          res(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error('timeout waiting for MCP response'));
        }
      }, 50);
    });

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
    const init = await until((m) => m.id === 1);
    assert.equal(init.result.serverInfo.name, 'abap2ui5');
    assert.equal(init.result.serverInfo.version, PKG.version, 'served version must be the package.json version');

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await until((m) => m.id === 2);
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), TOOL_NAMES);

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capabilities', arguments: { query: 'popup' } } });
    const caps = await until((m) => m.id === 3);
    assert.ok(JSON.stringify(caps.result).length > 200, 'capabilities query returned content');

    /* `examples` over the real committed catalogue, live over stdio. The one
     * parser in this repo that has silently broken TWICE (AGENTS.md: a new
     * <br> block made every row unmatchable), and its failure mode is the
     * reason it needs a live assertion rather than fixtures alone - zero rows
     * reads as "there are no samples for that", not as a parse error. The
     * fixtures in test/unit.test.mjs pin the semantics; this pins that the
     * shipped catalogue still answers. */
    send({
      jsonrpc: '2.0', id: 19, method: 'tools/call',
      params: { name: 'examples', arguments: { query: 'breadcrumbs', repo: 'samples-controls' } },
    });
    const exRes = (await until((m) => m.id === 19, 15000)).result;
    assert.ok(!exRes.isError, `examples errored: ${exRes.content[0].text}`);
    const ex = JSON.parse(exRes.content[0].text);
    assert.ok(ex.matches > 0, `the corpus has breadcrumb ports - a zero here is a broken catalogue read: ${exRes.content[0].text.slice(0, 300)}`);
    assert.ok(ex.entries[0].cls && ex.entries[0].path, 'an entry names a class and the file to read');

    // and the richer shape: the corpus commits catalogue.json, so that is what
    // the answer must have come from - a silent fall back to the SAMPLES.md
    // page would cost the verification status the ranking uses
    send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'examples', arguments: {} } });
    const sum = JSON.parse((await until((m) => m.id === 20, 15000)).result.content[0].text).summary;
    assert.equal(sum.sources['samples-controls'], 'catalogue.json');
    assert.ok(sum.byRepo['samples-controls'] > 0, 'the corpus catalogue parsed to entries');

    // validate_view through the linter checkout's public exports (property
    // gate only — render needs a browser, which this smoke does not assume)
    if (HAVE_LINTER) {
      send({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
          name: 'validate_view',
          arguments: {
            xml: '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m"><Page title="smoke"/></mvc:View>',
            render: false,
          },
        },
      });
      const vv = await until((m) => m.id === 4, 15000);
      assert.ok(!vv.result.isError, `validate_view errored: ${JSON.stringify(vv.result.content)}`);
      const body = JSON.parse(vv.result.content[0].text);
      assert.equal(body.ok, true, `clean view must validate ok: ${vv.result.content[0].text}`);

      /* A finding must arrive EXPLAINED. The message is one terminal line; the
       * paragraph behind the rule id lives in the linter's ./rule-docs export,
       * and reaching it used to mean fetching a website mid-task. */
      send({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: {
          name: 'validate_view',
          arguments: {
            xml: '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m"><Page title="x"><Button typ="Emphasized"/></Page></mvc:View>',
            render: false,
          },
        },
      });
      const bad = JSON.parse((await until((m) => m.id === 5, 15000)).result.content[0].text);
      assert.equal(bad.ok, false);
      assert.ok(bad.rules && bad.rules['unknown-property'], `the rule that fired must be explained: ${JSON.stringify(bad.rules)}`);
      assert.ok(bad.rules['unknown-property'].summary, 'the one-line summary comes by default');
      assert.equal(bad.rules['unknown-property'].detail, undefined, 'the paragraph is opt-in, so the response stays small');

      send({
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: {
          name: 'validate_view',
          arguments: {
            xml: '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m"><Page title="x"><Button typ="Emphasized"/></Page></mvc:View>',
            render: false,
            explain: true,
          },
        },
      });
      const explained = JSON.parse((await until((m) => m.id === 6, 15000)).result.content[0].text);
      assert.ok(explained.rules['unknown-property'].detail, 'explain:true returns the paragraph');
    }

    /* The cheap way to SEE a view: source in, IMAGE out, no backend and no
     * build. The image travels as an MCP image content block, the way run_app
     * has always returned its screenshot. */
    if (HAVE_RENDER_RUNTIME) {
      send({
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: {
          name: 'screenshot_view',
          arguments: {
            xml: '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m"><Page title="smoke"><Text text="hello"/></Page></mvc:View>',
            sizes: ['400x300'],
          },
        },
      });
      const shot = (await until((m) => m.id === 7, 120000)).result;
      const first = shot.content[0].text;
      /* No browser installed is a missing PREREQUISITE, not a defect here -
       * the render runtime is an opt-in install in the linter checkout and
       * `playwright install chromium` is a separate step again. Anything else
       * that goes wrong still fails the test. */
      if (shot.isError && /browser|executable|chromium|playwright|render gate needs/i.test(first)) {
        assert.ok(true, `screenshot skipped - no browser available: ${first.slice(0, 120)}`);
      } else {
        assert.ok(!shot.isError, `screenshot_view errored: ${first}`);
        const image = shot.content.find((c) => c.type === 'image');
        assert.ok(image, `an image content block must come back: ${JSON.stringify(shot.content.map((c) => c.type))}`);
        assert.equal(image.mimeType, 'image/png');
        assert.ok(image.data.length > 1000, 'the PNG must have content in it');
        assert.equal(JSON.parse(first).views[0].size, '400x300', 'photographed at the viewport that was asked for');
      }
    }

    /* The app-building guide - the rulebook for the job this server exists
     * for, which used to be reachable only as the PORTING brief. */
    if (HAVE_A2UI5) {
      send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'app_guide', arguments: { section: '1' } } });
      const guide = (await until((m) => m.id === 8, 15000)).result;
      assert.ok(!guide.isError, `app_guide errored: ${guide.content[0].text}`);
      const g = JSON.parse(guide.content[0].text);
      assert.equal(g.matches, 1, 'a numbered section selects exactly one chapter');
      assert.match(g.sections[0].heading, /^1\./);
      assert.ok(g.chapters.length > 3, `the whole table of contents comes back with it: ${g.chapters}`);
      assert.ok(g.sections[0].body.length > 100, 'a chapter arrives with its text, not just its name');

      /* The client API, from the real interface: a queried method must arrive
       * as a signature (parameters, defaults) and not as prose alone. */
      send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'api_reference', arguments: { query: 'follow_up_action' } } });
      const apiRes = (await until((m) => m.id === 9, 15000)).result;
      assert.ok(!apiRes.isError, `api_reference errored: ${apiRes.content[0].text}`);
      const api = JSON.parse(apiRes.content[0].text);
      const fua = (api.methods || []).find((m) => m.name === 'follow_up_action');
      assert.ok(fua, `follow_up_action must be found: ${apiRes.content[0].text.slice(0, 200)}`);
      assert.ok(fua.parameters.some((p) => p.name === 't_arg'), 'the signature comes with its parameters');
      assert.ok(fua.doc.length > 200, 'the ABAP-Doc comes with the method');

      // and the no-argument call is the compact surface, not the whole text
      send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'api_reference', arguments: {} } });
      const apiAll = JSON.parse((await until((m) => m.id === 10, 15000)).result.content[0].text);
      assert.ok(apiAll.methods.length > 20, 'every method is listed');
      assert.ok(apiAll.constants.some((c) => c.name === 'cs_event'), 'the constant groups are listed');
      assert.ok(apiAll.methods.some((m) => m.obsolete), 'obsolete methods are marked, not hidden');
    }

    /* The documentation site, searched from its checkout: a hit must carry
     * the published URL pair the docs repo actually serves. */
    if (HAVE_DOCS) {
      send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'docs_search', arguments: { query: 'mcp server', limit: 3 } } });
      const docsRes = (await until((m) => m.id === 11, 15000)).result;
      assert.ok(!docsRes.isError, `docs_search errored: ${docsRes.content[0].text}`);
      const docs = JSON.parse(docsRes.content[0].text);
      assert.ok(docs.matches > 0, 'the site documents its own MCP server');
      const [hit] = docs.entries;
      assert.match(hit.url, /^https:\/\/abap2ui5\.github\.io\/docs\/.+\.html$/);
      assert.match(hit.markdown, /^https:\/\/abap2ui5\.github\.io\/docs\/.+\.md$/);
      assert.ok(hit.title && hit.heading, 'a hit names its page and section');
    }

    /* The knowledge documents as MCP resources: the list is the derived
     * catalogue from lib/resources.mjs (names and URIs, no file reads), the
     * per-chapter guide is a resource TEMPLATE, and a read hands the document
     * over whole. */
    send({ jsonrpc: '2.0', id: 12, method: 'resources/list' });
    const resList = (await until((m) => m.id === 12)).result;
    assert.deepEqual(resList.resources.map((r) => r.uri).sort(), RESOURCE_URIS);
    for (const r of resList.resources) {
      assert.ok(r.name && r.description && r.mimeType, `resource ${r.uri} must carry name, description, mimeType`);
    }

    send({ jsonrpc: '2.0', id: 13, method: 'resources/templates/list' });
    const tmpl = (await until((m) => m.id === 13)).result;
    assert.deepEqual(tmpl.resourceTemplates.map((t) => t.uriTemplate), [GUIDE_CHAPTER_TEMPLATE]);

    // the capability map read whole — the corpus is present in this suite
    send({ jsonrpc: '2.0', id: 14, method: 'resources/read', params: { uri: 'abap2ui5://capabilities' } });
    const capRead = await until((m) => m.id === 14);
    assert.ok(!capRead.error, `reading the capability map errored: ${JSON.stringify(capRead.error)}`);
    const [capDoc] = capRead.result.contents;
    assert.equal(capDoc.uri, 'abap2ui5://capabilities');
    assert.equal(capDoc.mimeType, 'text/markdown');
    assert.ok(capDoc.text.length > 1000, 'the whole document comes back, not a stub');

    if (HAVE_A2UI5) {
      // one chapter through the template, same slicing as the app_guide tool
      send({ jsonrpc: '2.0', id: 15, method: 'resources/read', params: { uri: 'abap2ui5://guide/1' } });
      const chap = await until((m) => m.id === 15);
      assert.ok(!chap.error, `reading a guide chapter errored: ${JSON.stringify(chap.error)}`);
      assert.match(chap.result.contents[0].text, /^## 1\./, 'the asked-for chapter, with its heading');
    }

    /* The workflow prompts: the derived list from lib/prompts.mjs, and a get
     * that renders the loop AROUND the task - orchestration over the existing
     * tools, never their content. */
    send({ jsonrpc: '2.0', id: 16, method: 'prompts/list' });
    const promptList = (await until((m) => m.id === 16)).result;
    assert.deepEqual(promptList.prompts.map((pr) => pr.name).sort(), PROMPT_NAMES);
    for (const pr of promptList.prompts) {
      assert.ok(pr.description && pr.arguments?.length, `prompt ${pr.name} must declare description and arguments`);
    }

    send({
      jsonrpc: '2.0', id: 17, method: 'prompts/get',
      params: { name: 'build-an-abap2ui5-app', arguments: { task: 'a flight table with a search field' } },
    });
    const got = await until((m) => m.id === 17);
    assert.ok(!got.error, `prompts/get errored: ${JSON.stringify(got.error)}`);
    const rendered = got.result.messages[0].content.text;
    assert.ok(rendered.includes('a flight table with a search field'), 'the task lands in the rendered prompt');
    for (const tool of ['examples', 'app_guide', 'validate_view', 'screenshot_view', 'deploy_app', 'build_backend', 'run_app', 'pitfalls']) {
      assert.ok(rendered.includes(`\`${tool}\``), `the prompt must walk the loop through ${tool}`);
    }

    // a missing required argument is the get request's error, with the way out
    send({ jsonrpc: '2.0', id: 18, method: 'prompts/get', params: { name: 'build-an-abap2ui5-app', arguments: {} } });
    const noArg = await until((m) => m.id === 18);
    assert.ok(noArg.error, 'a required argument left out must be a JSON-RPC error');
    assert.match(noArg.error.message, /needs the argument 'task'/);
  } finally {
    p.kill();
  }
});

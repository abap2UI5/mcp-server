// Missing-checkout degradation: every tool that reads a sibling checkout must
// return a clear, actionable error (which repo, how to clone it, which env
// var) instead of crashing with a TypeError — and the server itself must boot.
//
// The env vars are authoritative (lib/repos.mjs): pointing all three at
// nonexistent directories forces the missing-checkout path deterministically,
// whether or not real siblings exist next to this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { RESOURCE_URIS } from '../lib/resources.mjs';
import { PROMPT_NAMES } from '../lib/prompts.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const NOWHERE = path.join(ROOT, 'test', 'does-not-exist');

test('every sibling-dependent tool degrades with an actionable error when the checkouts are missing', async () => {
  const p = spawn('node', [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      SAMPLES_CONTROLS_HOME: path.join(NOWHERE, 'samples-controls'),
      SAMPLES_HOME: path.join(NOWHERE, 'samples'),
      SAMPLES_STACK_HOME: path.join(NOWHERE, 'samples-stack'),
      A2UI5_HOME: path.join(NOWHERE, 'abap2UI5'),
      AI_VIEW_CHECK_HOME: path.join(NOWHERE, 'linter'),
      APP_TEMPLATE_HOME: path.join(NOWHERE, 'app-template'),
      DOCS_HOME: path.join(NOWHERE, 'docs'),
    },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 10000) =>
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

  let id = 0;
  const call = async (name, args = {}) => {
    const reqId = ++id + 100;
    send({ jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } });
    const msg = await until((m) => m.id === reqId);
    return msg.result;
  };
  const expectMissing = (result, repoRe, envVar) => {
    assert.equal(result.isError, true, `expected isError, got: ${JSON.stringify(result)}`);
    const text = result.content[0].text;
    assert.match(text, repoRe, `error must name the missing repo: ${text}`);
    assert.match(text, new RegExp(envVar), `error must name the env var: ${text}`);
    assert.match(text, /clone|checkout/i, `error must say how to fix it: ${text}`);
  };

  try {
    // the server still boots without any sibling checkout
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'missing-siblings', version: '0' } } });
    const init = await until((m) => m.id === 1);
    assert.equal(init.result.serverInfo.name, 'abap2ui5');
    assert.equal(init.result.serverInfo.version, PKG.version);

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await until((m) => m.id === 2);
    // the derived list from lib/tools.mjs — the full surface stays served
    // even when every sibling checkout is absent
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), TOOL_NAMES);

    // samples-controls-backed tools
    const CORPUS = /samples-controls checkout not found/;
    expectMissing(await call('capabilities', {}), CORPUS, 'SAMPLES_CONTROLS_HOME');
    expectMissing(await call('capabilities', { query: 'popup' }), CORPUS, 'SAMPLES_CONTROLS_HOME');
    expectMissing(await call('generation_rules', {}), CORPUS, 'SAMPLES_CONTROLS_HOME');
    // the starter project comes from a repository of its own
    expectMissing(await call('scaffold_app', {}), /app-template/, 'APP_TEMPLATE_HOME');
    expectMissing(await call('scaffold_app', { class: 'zcl_my_app' }), /app-template/, 'APP_TEMPLATE_HOME');
    expectMissing(await call('scope_of', { entities: ['sap.m.Wizard'] }), CORPUS, 'SAMPLES_CONTROLS_HOME');
    expectMissing(
      await call('deploy_app', { class_name: 'z2ui5_cl_demo', abap_source: 'CLASS z2ui5_cl_demo DEFINITION. INTERFACES z2ui5_if_app.' }),
      CORPUS,
      'SAMPLES_CONTROLS_HOME',
    );
    expectMissing(await call('build_backend', {}), CORPUS, 'SAMPLES_CONTROLS_HOME');
    expectMissing(await call('remove_app', {}), CORPUS, 'SAMPLES_CONTROLS_HOME');
    expectMissing(await call('remove_app', { class_name: 'z2ui5_cl_demo' }), CORPUS, 'SAMPLES_CONTROLS_HOME');

    /* The sample catalogues - three repositories, none of them the corpus, and
     * the error has to name each one rather than sending the reader to
     * samples-controls for a sample-catalogue query. `examples` only fails when
     * ALL THREE are missing (one present is a thinner answer, not an error), so
     * this is the state that has to produce it. */
    const SAMPLES = /samples checkout not found/;
    for (const call_args of [{}, { query: 'value help' }]) {
      const r = await call('examples', call_args);
      expectMissing(r, SAMPLES, 'SAMPLES_HOME');
      const t = r.content[0].text;
      assert.match(t, /samples-controls checkout not found/, `must name samples-controls: ${t}`);
      assert.match(t, /samples-stack checkout not found/, `must name samples-stack: ${t}`);
      assert.match(t, /SAMPLES_STACK_HOME/, `must name the stack env var: ${t}`);
    }

    // linter-backed tools: the verdict and the picture come from the same
    // checkout, so both have to degrade the same way
    expectMissing(
      await call('validate_view', { xml: '<mvc:View xmlns:mvc="sap.ui.core.mvc"/>' }),
      /linter checkout not found/,
      'AI_VIEW_CHECK_HOME',
    );
    expectMissing(
      await call('screenshot_view', { xml: '<mvc:View xmlns:mvc="sap.ui.core.mvc"/>' }),
      /linter checkout not found/,
      'AI_VIEW_CHECK_HOME',
    );

    // abap2UI5-backed tools (run_app checks samples-controls first — both missing here)
    expectMissing(await call('run_app', { class_name: 'z2ui5_cl_demo' }), CORPUS, 'SAMPLES_CONTROLS_HOME');
    // the pitfalls catalogues live in the abap2UI5 checkout, not in the corpus
    expectMissing(await call('pitfalls', {}), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissing(await call('pitfalls', { area: 'view' }), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    // and so does the app-building guide - it is maintained beside the sources
    expectMissing(await call('app_guide', {}), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissing(await call('app_guide', { section: '5' }), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    // the client API is an interface in the framework sources
    expectMissing(await call('api_reference', {}), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissing(await call('api_reference', { query: 'toast' }), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    // the documentation site has a checkout of its own
    expectMissing(await call('docs_search', { query: 'value help' }), /docs checkout not found/, 'DOCS_HOME');
    expectMissing(await call('backend', { action: 'start' }), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissing(await call('backend', { action: 'restart' }), /abap2UI5 checkout not found/, 'A2UI5_HOME');

    // backend status/stop never need a checkout
    const status = await call('backend', { action: 'status' });
    assert.ok(!status.isError, `backend status must work without checkouts: ${JSON.stringify(status)}`);
    assert.equal(JSON.parse(status.content[0].text).built, false);

    /* Resources degrade the same way, on the read and never on the list.
     * Listing is names and URIs from lib/resources.mjs — no file is touched,
     * so the full catalogue is listed even here, with every checkout absent.
     * A read against a missing checkout is the read request's JSON-RPC error,
     * carrying the same actionable message the tool returns. */
    send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    const resList = await until((m) => m.id === 3);
    assert.deepEqual(resList.result.resources.map((r) => r.uri).sort(), RESOURCE_URIS,
      'the resource list must not shrink when checkouts are missing');

    const readErr = async (uri) => {
      const reqId = ++id + 200;
      send({ jsonrpc: '2.0', id: reqId, method: 'resources/read', params: { uri } });
      const msg = await until((m) => m.id === reqId);
      assert.ok(msg.error, `reading ${uri} without its checkout must be a JSON-RPC error: ${JSON.stringify(msg)}`);
      return msg.error.message;
    };
    const expectMissingRead = (text, repoRe, envVar) => {
      assert.match(text, repoRe, `read error must name the missing repo: ${text}`);
      assert.match(text, new RegExp(envVar), `read error must name the env var: ${text}`);
      assert.match(text, /clone|checkout/i, `read error must say how to fix it: ${text}`);
    };
    expectMissingRead(await readErr('abap2ui5://guide'), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissingRead(await readErr('abap2ui5://guide/5'), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissingRead(await readErr('abap2ui5://api'), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissingRead(await readErr('abap2ui5://pitfalls/abap'), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissingRead(await readErr('abap2ui5://pitfalls/view'), /abap2UI5 checkout not found/, 'A2UI5_HOME');
    expectMissingRead(await readErr('abap2ui5://capabilities'), CORPUS, 'SAMPLES_CONTROLS_HOME');
    expectMissingRead(await readErr('abap2ui5://generation-rules'), CORPUS, 'SAMPLES_CONTROLS_HOME');

    /* The prompts read no checkout at all - they orchestrate the tools, which
     * carry their own degradation. So with every sibling absent, listing and
     * rendering both still work in full. */
    send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
    const promptList = await until((m) => m.id === 4);
    assert.deepEqual(promptList.result.prompts.map((pr) => pr.name).sort(), PROMPT_NAMES,
      'the prompt list must not shrink when checkouts are missing');
    send({
      jsonrpc: '2.0', id: 5, method: 'prompts/get',
      params: { name: 'port-a-ui5-sample', arguments: { sample: 'sap.m.Wizard' } },
    });
    const gotPrompt = await until((m) => m.id === 5);
    assert.ok(!gotPrompt.error, `prompts/get must work without checkouts: ${JSON.stringify(gotPrompt.error)}`);
    assert.ok(gotPrompt.result.messages[0].content.text.includes('sap.m.Wizard'));
  } finally {
    p.kill();
  }
});

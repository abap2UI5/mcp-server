// fix_view's core (lib/fixview.mjs) against the REAL linter sibling: the
// property gate runs, the mechanical fixes land, nothing is written anywhere.
// Skips itself when the linter checkout is absent or predates ./fix, the way
// the smoke test skips without the corpus - `npm test` stays green in a bare
// checkout and exercises the full path in a sibling workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewCheck, importViewCheck } from '../lib/repos.mjs';
import { fixSource } from '../lib/fixview.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ANSWER_BUDGET } from '../lib/budget.mjs';

const HAVE_LINTER = Boolean(resolveViewCheck());
const HAVE_FIX = await (async () => {
  if (!HAVE_LINTER) return false;
  try {
    const fix = await importViewCheck('./fix');
    return typeof fix.applyFixes === 'function';
  } catch {
    return false;
  }
})();

const skip = !HAVE_LINTER
  ? 'linter sibling not found'
  : (!HAVE_FIX && 'linter sibling predates ./fix');

// two mechanical defects the linter documents as fixable: an obsolete binder
// call (renamed) and an obsolete model-update call (deleted, line and all)
const FIXABLE_APP = `CLASS zcl_fix_me DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA quantity TYPE string.
ENDCLASS.

CLASS zcl_fix_me IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->tag( \`Text\`
        )->a( n = \`text\` v = client->_bind_edit( quantity ) ).
    client->view_display( view->stringify( ) ).
    client->popup_model_update( ).
  ENDMETHOD.
ENDCLASS.
`;

const OPT = { minUi5: '1.71', allow: [], properties: true };

test('fixSource applies the linter fixes and returns the corrected source', { skip }, async () => {
  const lib = await importViewCheck('.');
  const fix = await importViewCheck('./fix');
  const res = await fixSource({
    checkFiles: lib.checkFiles,
    applyFixes: fix.applyFixes,
    abapSource: FIXABLE_APP,
    opt: OPT,
  });
  assert.ok(res.applied >= 2, `expected at least the two seeded fixes, applied ${res.applied}`);
  assert.match(res.source, /client->_bind\( quantity \)/, 'the obsolete binder is renamed');
  assert.ok(!res.source.includes('_bind_edit'), 'the obsolete name is gone');
  assert.ok(!res.source.includes('popup_model_update'), 'the dead call is deleted');
  const fixedTypes = res.fixed.map((f) => f.type);
  assert.ok(fixedTypes.includes('obsolete-binder'), `fixed must name the rule: ${fixedTypes}`);
  assert.ok(fixedTypes.includes('obsolete-model-update'), `fixed must name the rule: ${fixedTypes}`);
  for (const f of res.fixed) {
    assert.ok(f.message, 'a fixed finding keeps its message');
  }
  assert.deepEqual(res.remaining, [], 'this fixture fixes clean');
});

test('fixSource leaves an unfixable finding standing and says so', { skip }, async () => {
  const lib = await importViewCheck('.');
  const fix = await importViewCheck('./fix');
  // binding a local variable is a decision (move it to an attribute), not a
  // mechanical fix - it must survive under `remaining` with the source intact
  const src = `CLASS zcl_fix_me2 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_fix_me2 IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA lv_title TYPE string.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->tag( \`Text\`
        )->a( n = \`text\` v = client->_bind( lv_title ) ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
`;
  const res = await fixSource({
    checkFiles: lib.checkFiles,
    applyFixes: fix.applyFixes,
    abapSource: src,
    opt: OPT,
  });
  assert.equal(res.applied, 0);
  assert.deepEqual(res.fixed, []);
  assert.ok(res.remaining.some((f) => f.type === 'binding-to-local'),
    `the unfixable finding stands: ${JSON.stringify(res.remaining.map((f) => f.type))}`);
  assert.equal(res.source, src, 'a source with nothing to fix comes back byte-identical');
});

/* A view of a few hundred defects: validate_view answered 538,000
 * characters and fix_view 584,000 - past what a client accepts, so the agent
 * saw none of them. The most severe findings that fit are listed, the
 * counts stay whole, and the cut is said. */
test('validate_view and fix_view fit a view of hundreds of findings into one answer', { skip }, async () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const n = 600;
  const xml = '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m"><Page>'
    + Array.from({ length: n }, (_, i) => `<Button text="b${i}" notaprop${i}="x" icon="sap-icon://nonexistent${i}"/>`).join('')
    + '</Page></mvc:View>';
  const env = { ...process.env, A2UI5_MCP_REMOTE: '0' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server.mjs')], env, stderr: 'ignore' });
  const client = new Client({ name: 'findings', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const v = await client.callTool({ name: 'validate_view', arguments: { xml, render: false } });
    const vt = v.content[0].text;
    assert.ok(vt.length < ANSWER_BUDGET, `validate_view answered ${vt.length} characters`);
    const vr = JSON.parse(vt);
    const total = vr.counts.error + vr.counts.warning + vr.counts.hint;
    assert.ok(total >= n, 'the counts carry every finding');
    assert.ok(vr.findings.length > 0 && vr.findings.length < total);
    assert.match(vr.findingsCut, new RegExp(`^${total - vr.findings.length} more finding\\(s\\) did not fit one answer`));
    assert.equal(vr.ok, false);
    const f = await client.callTool({ name: 'fix_view', arguments: { xml } });
    const ft = f.content[0].text;
    assert.ok(ft.length < ANSWER_BUDGET, `fix_view answered ${ft.length} characters`);
    const fr = JSON.parse(ft);
    assert.equal(typeof fr.source, 'string', 'the corrected source goes whole');
    assert.match(fr.remainingCut, /more remaining finding\(s\) did not fit one answer - validate_view the corrected source/);
  } finally {
    await client.close();
  }
});

/* The findings came back in the order the gates produced them - neither the
 * linter's report order (source order, report.mjs problemsOf) nor severity:
 * this app answered a warning on line 140, a hint on line 108, then a warning
 * on line 26. And a cut answer kept the most severe, so the head of a long
 * list and the whole of a short one were sorted by different rules. Both
 * tools list the most severe first, in source order within a severity - the
 * cut answer is the head of that list. */
test('validate_view and fix_view list the findings most severe first, in source order within a severity', { skip }, async () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fs = await import('node:fs');
  const abap = fs.readFileSync(path.join(ROOT, 'test/fixtures/agent-app/zcl_agent_mcp.clas.abap'), 'utf8');
  const { severityOf, severityRank } = await importViewCheck('./findings');
  const sorted = (list) => list.every((f, i) => i === 0 || (() => {
    const a = list[i - 1];
    const ra = severityRank(severityOf(a));
    const rb = severityRank(severityOf(f));
    return ra > rb || (ra === rb && ((a.line ?? Infinity) < (f.line ?? Infinity) || ((a.line ?? Infinity) === (f.line ?? Infinity) && (a.column ?? 0) <= (f.column ?? 0))));
  })());
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server.mjs')], env: { ...process.env, A2UI5_MCP_REMOTE: '0' }, stderr: 'ignore' });
  const client = new Client({ name: 'order', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const v = JSON.parse((await client.callTool({ name: 'validate_view', arguments: { abap_source: abap, render: false } })).content[0].text);
    const severities = new Set(v.findings.map((f) => severityOf(f)));
    assert.ok(v.findings.length >= 3 && severities.size >= 2, `the fixture has findings of more than one severity: ${JSON.stringify(v.findings.map((f) => [f.severity, f.line]))}`);
    assert.ok(sorted(v.findings), `validate_view: ${JSON.stringify(v.findings.map((f) => [f.severity, f.line]))}`);
    // fix_view's remaining: the same order
    const f = JSON.parse((await client.callTool({ name: 'fix_view', arguments: { abap_source: abap } })).content[0].text);
    assert.ok(sorted(f.remaining), `fix_view remaining: ${JSON.stringify(f.remaining.map((x) => [x.severity, x.line]))}`);
  } finally {
    await client.close();
  }
});

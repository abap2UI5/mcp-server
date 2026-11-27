// lib/removed-api.mjs: an abaplint "not found" on removed abap2UI5 API gets
// the replacement from the docs' deprecations.json. Sibling-free: a fixture
// in the file's own shape, and the reader with the mirror fetch injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRemoved, annotateRemoved, removedApiEntries, resetRemovedApi, explainRemoved } from '../lib/removed-api.mjs';

const ENTRIES = [
  { name: '_bind_edit', kind: 'method', status: 'removed', replacement: '_bind( )', since: '1.151.0', note: 'deprecated since 1.142.0' },
  { name: 'view_model_update', kind: 'method', status: 'removed', replacement: 'delete the call', since: '1.151.0' },
  { name: 'z2ui5_cl_xml_view', kind: 'class', status: 'moved', replacement: 'z2ui5_cl_ui5_view_builder, or install abap2UI5-ext' },
  { name: 'z2ui5_cl_pop_*', kind: 'class', pattern: true, status: 'moved', replacement: 'the popups addon' },
  { name: 'z2ui5_cl_pop_js_loader', kind: 'class', status: 'removed', replacement: 'nothing - the loader is gone' },
];

test('findRemoved: exact before pattern, case-insensitive, by kind', () => {
  assert.equal(findRemoved(ENTRIES, '_BIND_EDIT', ['method']).replacement, '_bind( )');
  assert.equal(findRemoved(ENTRIES, '_bind_edit', ['class']), null, 'a method entry does not answer a class');
  assert.equal(findRemoved(ENTRIES, 'z2ui5_cl_pop_to_confirm', ['class']).replacement, 'the popups addon');
  assert.equal(findRemoved(ENTRIES, 'z2ui5_cl_pop_js_loader', ['class']).status, 'removed', 'the exact entry outranks the pattern');
  assert.equal(findRemoved(ENTRIES, 'zcl_my_class', ['class']), null);
  assert.equal(findRemoved(null, 'x', ['class']), null);
});

test('annotateRemoved: the abaplint messages deploy_app returns, as they are', () => {
  const issues = [
    { rule: 'check_syntax', message: 'Class z2ui5_cl_xml_view not found', line: 12 },
    { rule: 'check_syntax', message: 'Method "_bind_edit" not found, methodCallChain', line: 13 },
    { rule: 'check_syntax', message: 'Method "my_own_method" not found, methodCallChain', line: 14 },
    { rule: 'keyword_case', message: 'Keyword should be upper case', line: 15 },
  ];
  const { issues: out, count } = annotateRemoved(issues, ENTRIES);
  assert.equal(count, 2);
  assert.equal(out[0].removed.replacement, 'z2ui5_cl_ui5_view_builder, or install abap2UI5-ext');
  assert.deepEqual(out[1].removed, { name: '_bind_edit', status: 'removed', replacement: '_bind( )', since: '1.151.0', note: 'deprecated since 1.142.0' });
  assert.equal(out[2].removed, undefined, 'a typo of the app\'s own is not removed API');
  assert.equal(out[3].removed, undefined);
  assert.equal(issues[1].removed, undefined, 'the input is not changed');
});

test('removedApiEntries: the mirror when there is no docs checkout; null when nothing answers', async () => {
  const saved = process.env.DOCS_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-removed-'));
  process.env.DOCS_HOME = path.join(dir, 'no-docs');
  try {
    resetRemovedApi();
    assert.equal(await removedApiEntries({ fetchFile: async () => { throw new Error('offline'); } }), null);
    const file = path.join(dir, 'deprecations.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: ENTRIES }));
    resetRemovedApi();
    const asked = [];
    const entries = await removedApiEntries({ fetchFile: async (key, rel) => { asked.push([key, rel]); return file; } });
    assert.equal(entries.length, ENTRIES.length);
    assert.deepEqual(asked, [['docs', 'docs/public/api/deprecations.json']]);
    fs.writeFileSync(file, 'not json');
    resetRemovedApi();
    assert.equal(await removedApiEntries({ fetchFile: async () => file }), null, 'a damaged file is no answer');
  } finally {
    resetRemovedApi();
    if (saved === undefined) delete process.env.DOCS_HOME;
    else process.env.DOCS_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explainRemoved: a clean lint, or one without a "not found", asks nobody', async () => {
  assert.equal(await explainRemoved({ ok: true, issues: [] }), null);
  assert.equal(await explainRemoved({ ok: false, issues: [{ message: 'Keyword should be upper case' }] }), null);
  assert.equal(await explainRemoved(null), null);
});

// fix_view's core (lib/fixview.mjs) against the REAL linter sibling: the
// property gate runs, the mechanical fixes land, nothing is written anywhere.
// Skips itself when the linter checkout is absent or predates ./fix, the way
// the smoke test skips without the corpus - `npm test` stays green in a bare
// checkout and exercises the full path in a sibling workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewCheck, importViewCheck } from '../lib/repos.mjs';
import { fixSource } from '../lib/fixview.mjs';

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

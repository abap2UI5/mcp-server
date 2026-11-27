// A dev app left broken in the sandbox stops every build: the failed build
// names it and says how to take it out. Sibling-free: both helpers are pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockingDevObjects, blockingSentence } from '../lib/deploy.mjs';

const TAIL = 'Error: check_syntax, Method "_bind_edit" not found, methodCallChain, zcl_old_app.clas.abap:13\n'
  + 'check_syntax, Method "view_model_update" not found, methodCallChain, zcl_old_app.clas.abap:19\n'
  + 'something in z2ui5_cl_core_app.clas.abap:40\n'
  + 'and a test include zcl_other.clas.testclasses.abap:7';

test('blockingDevObjects: the dev apps a failed build names, once each, framework objects left out', () => {
  assert.deepEqual(blockingDevObjects(TAIL, ['zcl_old_app', 'zcl_other', 'zcl_todo_app']), ['zcl_old_app', 'zcl_other']);
  assert.deepEqual(blockingDevObjects(TAIL, []), []);
  assert.deepEqual(blockingDevObjects('no file named', ['zcl_old_app']), []);
});

test('blockingSentence: nothing without a name, the remove_app call for each one', () => {
  assert.equal(blockingSentence([]), '');
  const s = blockingSentence(['zcl_old_app']);
  assert.match(s, /stops at zcl_old_app/);
  assert.match(s, /remove_app \{ class_name: "zcl_old_app" \}/);
});

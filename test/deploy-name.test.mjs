// deploy_app / verify_app without class_name: the name is the class the
// source defines. Sibling-free: the parser is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classNameFromSource } from '../lib/deploy.mjs';

test('classNameFromSource: the global class a source defines', () => {
  assert.equal(classNameFromSource('CLASS zcl_todo_app DEFINITION PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.'), 'zcl_todo_app');
  assert.equal(classNameFromSource('class ZCL_X definition public final create public .'), 'zcl_x', 'any case, lower-cased');
  // a DEFERRED or LOCAL FRIENDS statement before it names no class of its own
  assert.equal(classNameFromSource('CLASS ltcl_test DEFINITION DEFERRED.\nCLASS zcl_a DEFINITION LOCAL FRIENDS ltcl_test.\nCLASS zcl_a DEFINITION PUBLIC.'), 'zcl_a');
  assert.equal(classNameFromSource('CLASS /abc/cl_app DEFINITION PUBLIC.'), '/abc/cl_app', 'a namespace stays');
  assert.equal(classNameFromSource('REPORT zfoo.'), null);
  assert.equal(classNameFromSource(undefined), null);
});

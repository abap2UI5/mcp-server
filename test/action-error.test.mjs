// interact_app's failed action: a timeout says which element and why, and an
// app_start snapshot id is named as one. Sibling-free: actionError is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionError } from '../lib/browser.mjs';

const timeout = Object.assign(new Error('locator.evaluate: Timeout 10000ms exceeded.\nCall log: ...'), { name: 'TimeoutError' });

test('a snapshot id is named as one, with the two ways that work', () => {
  const msg = actionError({ action: 'fill', id: 'f1', value: 'x' }, timeout, 10000);
  assert.match(msg, /no element with the id 'f1' could be acted on within 10000 ms/);
  assert.match(msg, /app_start's snapshot/);
  assert.match(msg, /app_act/);
  assert.match(msg, /Timeout 10000ms exceeded\.\)$/, 'the original line stays, at the end');
});

test('a view id, a text, and errors that are no timeout', () => {
  assert.match(actionError({ action: 'click', id: 'btn_add' }, timeout, 10000), /the view has to give the control that id/);
  assert.match(actionError({ action: 'click', text: 'Add' }, timeout, 5000), /^no element with the text 'Add' could be acted on within 5000 ms/);
  assert.equal(actionError({ action: 'click', id: 'f1' }, new Error('element is not enabled\nmore'), 10000), 'element is not enabled');
});

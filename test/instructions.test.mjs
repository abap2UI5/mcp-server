// lib/instructions.mjs: the text every client puts into the agent's system
// prompt. Sibling-free: the text and both tool surfaces are data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serverInstructions } from '../lib/instructions.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { SYSTEM_TOOL_NAMES, SYSTEM_WRITE_TOOL_NAMES } from '../lib/system-tools.mjs';

/* Every snake_case word of the text is a tool name - except the abap2UI5 API
 * the text quotes (z2ui5_* objects and the client methods of the renames). */
const API = new Set(['view_model_update', 'get_event', 'follow_up_action', 'check_initialized']);
const toolWords = (text) => (text.match(/\b[a-z]+_[a-z_]+\b/g) || [])
  .filter((w) => !w.startsWith('z2ui5_') && !w.startsWith('check_on_') && !API.has(w));

for (const [label, system, names] of [
  ['sandbox', false, new Set(TOOL_NAMES)],
  ['system', true, new Set([...SYSTEM_TOOL_NAMES, ...SYSTEM_WRITE_TOOL_NAMES])],
]) {
  test(`instructions (${label}): every tool named is a tool of that surface`, () => {
    const text = serverInstructions({ system });
    const named = toolWords(text);
    assert.ok(named.length >= 3, `expected the loop's tools to be named, got ${named}`);
    for (const w of named) assert.ok(names.has(w), `"${w}" is not a ${label} tool`);
  });

  test(`instructions (${label}): short enough to be read in every turn`, () => {
    // a client may cut long instructions; the details belong in the descriptions
    assert.ok(serverInstructions({ system }).length < 2500, 'instructions over 2500 characters');
  });
}

test('instructions (sandbox): starts with setup_status and names the current view builder', () => {
  const text = serverInstructions();
  const order = ['setup_status', 'capabilities', 'validate_view', 'deploy_app', 'build_backend', 'run_app', 'pitfalls'];
  const at = order.map((w) => text.indexOf(w));
  assert.ok(at.every((i) => i >= 0), `missing one of ${order}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the loop is told in its order');
  assert.match(text, /z2ui5_cl_ui5_view_builder/);
  assert.match(text, /_bind_edit.*->.*_bind\(/);
});

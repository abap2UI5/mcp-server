// The precedence lintOptionsFor documents, pinned against the REAL linter's
// applyConfig: explicit tool arguments beat the project's abap2ui5lint.jsonc,
// and an explicit `allow` entry always survives - the config can only allow
// MORE, never take a caller's allowance away. Skips without the linter
// sibling, the way the fix-view suite does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveViewCheck } from '../lib/repos.mjs';
import { lintOptionsFor } from '../lib/lintopts.mjs';

const skip = !resolveViewCheck() && 'linter sibling not found';

async function withProject(config, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lintopts-'));
  try {
    fs.writeFileSync(path.join(dir, 'abap2ui5lint.jsonc'), JSON.stringify(config));
    return await fn(dir); // awaited, or the finally would delete the project under the async body
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an explicit allow survives the project config; the config merges in', { skip }, async () => {
  await withProject({ ui5: '1.96', allow: ['sap.m.FromConfig.prop'] }, async (dir) => {
    const { opt, configFile } = await lintOptionsFor({
      project_dir: dir,
      allow: ['sap.m.FromCaller.prop'],
    });
    assert.equal(configFile, path.join(dir, 'abap2ui5lint.jsonc'));
    assert.ok(opt.allow.includes('sap.m.FromCaller.prop'),
      `the caller's allowance must survive the config: ${JSON.stringify(opt.allow)}`);
    // merge, not override in either direction: both allowances are meant
    assert.ok(opt.allow.includes('sap.m.FromConfig.prop'),
      `the project's allowance still applies: ${JSON.stringify(opt.allow)}`);
    // and the config's UI5 floor fills in where the caller said nothing
    assert.equal(opt.minUi5, '1.96');
  });
});

test('an explicit min_ui5 beats the config floor; config fills what was not said', { skip }, async () => {
  await withProject({ ui5: '1.96', allow: ['sap.m.FromConfig.prop'] }, async (dir) => {
    const { opt } = await lintOptionsFor({ project_dir: dir, min_ui5: '1.71' });
    assert.equal(opt.minUi5, '1.71', 'the explicit floor wins over the config');
    assert.deepEqual(opt.allow, ['sap.m.FromConfig.prop'], 'no explicit allow: the config list applies');
  });
});

test('a min_ui5 that is no version is refused by name', async () => {
  for (const bad of ['abc', '1,120', '1.71x', ' 1.71', 'latest']) {
    await assert.rejects(lintOptionsFor({ min_ui5: bad }), /min_ui5 must be a UI5 version/,
      `'${bad}' used to be compared as if it were a floor`);
  }
});

test('forceNoRender pins render off against a config that turns it on', { skip }, async () => {
  await withProject({ render: true }, async (dir) => {
    const { opt } = await lintOptionsFor({ project_dir: dir }, { forceNoRender: true });
    assert.equal(opt.render, false, 'fix_view runs the property gate only, whatever the config says');
  });
});

/* The schema says array of strings; a client need not send one. A bare string
 * was spread into its characters by applyConfig (the allowance silently
 * gone) - refused by name now, before the linter sees it. */
test('allow must be an array of strings', { skip }, async () => {
  await withProject({ allow: ['sap.m.FromConfig.prop'] }, async (dir) => {
    await assert.rejects(lintOptionsFor({ project_dir: dir, allow: 'sap.m.GenericTile.systemInfo' }), /allow must be an array of strings/);
    await assert.rejects(lintOptionsFor({ project_dir: dir, allow: [42] }), /every allow entry must be a non-empty string/);
    const { opt } = await lintOptionsFor({ project_dir: dir, allow: [] });
    assert.deepEqual(opt.allow, ['sap.m.FromConfig.prop'], 'an empty list allows nothing more');
  });
});

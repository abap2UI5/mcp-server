// build_static: the pure parts - which folder a site may be written to, and
// the bundle's options (the shims, the names kept, the start class). The
// build itself installs from the registry and transpiles; it was run end to
// end against a static host under /<repo>/ when it was written (CHANGELOG).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { outProblem, bundleOptions, SITE_MARKER, STATIC_TOOLS, ENCODED_PATHS } from '../lib/static-build.mjs';

test('the site folder: new, empty or an earlier build_static\'s - never the project or a folder of somebody\'s own', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  const project = path.join(base, 'src');
  fs.mkdirSync(project);
  assert.equal(outProblem(path.join(base, 'site'), project), null, 'a new folder');
  fs.mkdirSync(path.join(base, 'empty'));
  assert.equal(outProblem(path.join(base, 'empty'), project), null, 'an empty one');
  fs.mkdirSync(path.join(base, 'docs'));
  fs.writeFileSync(path.join(base, 'docs', 'index.md'), '# mine');
  assert.match(outProblem(path.join(base, 'docs'), project), /not empty and no earlier build_static wrote it/);
  fs.writeFileSync(path.join(base, 'docs', SITE_MARKER), '{}');
  assert.equal(outProblem(path.join(base, 'docs'), project), null, 'one a build wrote');
  assert.match(outProblem(project, project), /holds the project itself/);
  assert.match(outProblem(base, project), /holds the project itself/);
  assert.match(outProblem(path.join(project, 'site'), project), /inside the folder being built/);
});

test('the bundle: the Node stand-ins, the names kept for RTTI, the start class upper case', () => {
  const o = bundleOptions({ target: '/rt/static', tools: '/tools/node_modules', runtime: '/rt/node_modules', outfile: '/out/app.js', startClass: 'zcl_app', ui5: '1.136.11' });
  assert.equal(o.keepNames, true);
  assert.equal(o.format, 'esm');
  assert.equal(o.platform, 'browser');
  assert.match(o.alias.zlib, /zlib-shim\.mjs$/);
  assert.match(o.alias.crypto, /crypto-shim\.mjs$/);
  assert.match(o.alias.fs, /empty\.mjs$/);
  assert.equal(o.alias['abap2ui5-static:init'], path.join('/rt/static', 'init.mjs'));
  assert.deepEqual(JSON.parse(o.define.__A2UI5_STATIC__), { startClass: 'ZCL_APP', ui5: '1.136.11' });
  assert.deepEqual(o.nodePaths, ['/tools/node_modules', '/rt/node_modules']);
  assert.ok(o.plugins.includes(ENCODED_PATHS));
  for (const v of Object.values(STATIC_TOOLS)) assert.match(v, /^\d+\.\d+\.\d+$/, 'exact versions only');
});

test('an URL-encoded import (a namespaced object) is resolved to its file', () => {
  let hook;
  ENCODED_PATHS.setup({ onResolve: (opts, fn) => { hook = { opts, fn }; } });
  assert.ok(hook.opts.filter.test('./open-abap-core/%23ui2%23cl_json.clas.mjs'));
  assert.deepEqual(hook.fn({ path: './open-abap-core/%23ui2%23cl_json.clas.mjs', resolveDir: '/out' }), { path: path.join('/out', 'open-abap-core', '#ui2#cl_json.clas.mjs') });
  assert.equal(hook.fn({ path: 'pkg/%23x', resolveDir: '/out' }), undefined);
});

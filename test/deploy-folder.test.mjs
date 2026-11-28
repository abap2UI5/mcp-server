// deploy_folder: the ABAP objects of a folder into the dev sandbox in one
// call. The collector is pure over a directory; the tool is driven over
// stdio against a throwaway corpus sandbox (SAMPLES_CONTROLS_HOME), with the
// lint off - the lint is deploy_app's, tested there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { folderObjects, objectsMatcher } from '../lib/runtime.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'CLASS zcl_fold_app DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES z2ui5_if_app.\nENDCLASS.\nCLASS zcl_fold_app IMPLEMENTATION.\nENDCLASS.\n';

function project() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-fold-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  w('src/package.devc.xml', '<abapGit/>');
  w('src/README.md', '# not an object');
  w('src/zcl_fold_app.clas.abap', APP);
  w('src/zcl_fold_app.clas.xml', '<abapGit/>');
  w('src/lib/zcl_fold_help.clas.abap', 'CLASS zcl_fold_help DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_fold_help IMPLEMENTATION.\nENDCLASS.\n');
  w('src/lib/zcl_fold_help.clas.testclasses.abap', 'CLASS ltcl DEFINITION FOR TESTING.\nENDCLASS.\nCLASS ltcl IMPLEMENTATION.\nENDCLASS.\n');
  w('src/lib/zcl_fold_help.clas.xml', '<abapGit/>');
  w('src/lib/zif_fold.intf.abap', 'INTERFACE zif_fold PUBLIC.\nENDINTERFACE.\n');
  w('src/lib/zfold_tab.tabl.xml', '<abapGit/>');
  w('src/lib/zorphan.clas.xml', '<abapGit/>');
  w('src/node_modules/zcl_ignored.clas.abap', 'x');
  w('src/.hidden/zcl_hidden.clas.abap', 'x');
  return base;
}

test('folderObjects takes classes with their includes, interfaces and tables, and lists what it skipped', () => {
  const base = project();
  try {
    const { objects, skipped } = folderObjects(path.join(base, 'src'));
    assert.deepEqual(objects.map((o) => `${o.name}.${o.type}:${o.files.map((f) => f.name).sort().join(',')}`).sort(), [
      'zcl_fold_app.clas:zcl_fold_app.clas.abap,zcl_fold_app.clas.xml',
      'zcl_fold_help.clas:zcl_fold_help.clas.abap,zcl_fold_help.clas.testclasses.abap,zcl_fold_help.clas.xml',
      'zfold_tab.tabl:zfold_tab.tabl.xml',
      'zif_fold.intf:zif_fold.intf.abap',
    ]);
    assert.ok(skipped.includes('README.md'), skipped.join(' | '));
    assert.ok(skipped.some((s) => s.startsWith(path.join('lib', 'zorphan.clas.xml'))), 'a sidecar without its source is skipped, not deployed');
    assert.ok(!skipped.some((s) => /package\.devc|zcl_ignored|zcl_hidden/.test(s)), skipped.join(' | '));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('folderObjects refuses what is not a folder, skips symbolic links, and refuses a file that is there twice', () => {
  const base = project();
  try {
    assert.throws(() => folderObjects(path.join(base, 'nowhere')), /no directory/);
    assert.throws(() => folderObjects(path.join(base, 'src', 'zcl_fold_app.clas.abap')), /not a directory/);
    fs.writeFileSync(path.join(base, 'secret.clas.abap'), 'SECRET');
    fs.symlinkSync(path.join(base, 'secret.clas.abap'), path.join(base, 'src', 'zcl_link.clas.abap'));
    const { objects, skipped } = folderObjects(path.join(base, 'src'));
    assert.ok(!objects.some((o) => o.name === 'zcl_link'));
    assert.ok(skipped.some((s) => /zcl_link.*symbolic link/.test(s)), skipped.join(' | '));
    fs.mkdirSync(path.join(base, 'src', 'dup'));
    fs.writeFileSync(path.join(base, 'src', 'dup', 'zcl_fold_app.clas.abap'), APP);
    assert.throws(() => folderObjects(path.join(base, 'src')), /there twice/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('objectsMatcher takes the findings of the deployed objects only', () => {
  const m = objectsMatcher([{ name: 'zcl_a', type: 'clas' }, { name: 'zif_b', type: 'intf' }]);
  assert.equal(m('/x/src/zz_dev/zcl_a.clas.abap'), true);
  assert.equal(m('zcl_a.clas.testclasses.abap'), true);
  assert.equal(m('/x/zif_b.intf.abap'), true);
  assert.equal(m('/x/zzcl_a.clas.abap'), false);
  assert.equal(m('/x/zcl_a.intf.abap'), false);
});

async function withServer(base, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: {
      ...process.env,
      A2UI5_MCP_REMOTE: '0',
      SAMPLES_CONTROLS_HOME: path.join(base, 'corpus'),
      A2UI5_HOME: path.join(base, 'nowhere'),
      AI_VIEW_CHECK_HOME: path.join(base, 'nowhere'),
      A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'),
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'fold', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: Boolean(r.isError), text: r.content.map((c) => c.text || '').join('\n') };
    });
  } finally {
    await client.close();
  }
}

test('deploy_folder writes every object into the sandbox, names the apps, and replaces an object whole', async () => {
  const base = project();
  fs.mkdirSync(path.join(base, 'corpus', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(base, 'corpus', 'scripts', 'e2e-build.mjs'), '// probe\n');
  fs.mkdirSync(path.join(base, 'corpus', 'src', 'zz_dev'), { recursive: true });
  const box = path.join(base, 'corpus', 'src', 'zz_dev');
  try {
    await withServer(base, async (call) => {
      const r = await call('deploy_folder', { path: path.join(base, 'src'), lint: false });
      assert.equal(r.isError, false, r.text);
      const reply = JSON.parse(r.text);
      assert.deepEqual(reply.apps, ['zcl_fold_app']);
      assert.deepEqual(reply.deployed.sort(), ['zcl_fold_app.clas', 'zcl_fold_help.clas', 'zfold_tab.tabl', 'zif_fold.intf']);
      assert.ok(fs.existsSync(path.join(box, 'zcl_fold_help.clas.testclasses.abap')));
      assert.ok(fs.existsSync(path.join(box, 'zfold_tab.tabl.xml')));

      // the test include is gone from the folder: the redeploy takes it out of the sandbox too
      fs.rmSync(path.join(base, 'src', 'lib', 'zcl_fold_help.clas.testclasses.abap'));
      const again = await call('deploy_folder', { path: path.join(base, 'src'), lint: false });
      assert.equal(again.isError, false, again.text);
      assert.ok(!fs.existsSync(path.join(box, 'zcl_fold_help.clas.testclasses.abap')));

      const none = await call('deploy_folder', { path: path.join(base, 'corpus', 'scripts'), lint: false });
      assert.equal(none.isError, true);
      assert.match(none.text, /no ABAP object/);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deploy_folder serves the BSP of the folder instead of skipping its pages; verify_project stops where a stage fails', async () => {
  const base = project();
  fs.mkdirSync(path.join(base, 'corpus', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(base, 'corpus', 'scripts', 'e2e-build.mjs'), '// probe\n');
  fs.mkdirSync(path.join(base, 'corpus', 'src', 'zz_dev'), { recursive: true });
  fs.mkdirSync(path.join(base, 'src', '01'), { recursive: true });
  fs.writeFileSync(path.join(base, 'src', '01', 'z2ui5_ccc.wapa.xml'), '<abapGit/>');
  fs.writeFileSync(path.join(base, 'src', '01', 'z2ui5_ccc.wapa.cc_-canvas.js'), 'x();'.padEnd(255));
  try {
    await withServer(base, async (call) => {
      const r = await call('deploy_folder', { path: path.join(base, 'src'), lint: false });
      assert.equal(r.isError, false, r.text);
      const reply = JSON.parse(r.text);
      assert.deepEqual(reply.bsp.names, ['z2ui5_ccc']);
      assert.deepEqual(reply.bsp.servedAt, ['/sap/bc/ui5_ui5/sap/z2ui5_ccc/']);
      assert.ok(!(reply.skipped || []).some((f) => /wapa/.test(f)), 'the pages are no skipped files');

      // a folder of two apps: verify_project wants to be told which one to boot, before it writes anything
      fs.writeFileSync(path.join(base, 'src', 'zcl_fold_two.clas.abap'), APP.replace(/zcl_fold_app/g, 'zcl_fold_two'));
      const two = await call('verify_project', { path: path.join(base, 'src') });
      assert.equal(two.isError, true);
      assert.match(two.text, /2 apps \(zcl_fold_app, zcl_fold_two\) - pass class_name/);
      const wrong = await call('verify_project', { path: path.join(base, 'src'), class_name: 'zcl_nope' });
      assert.equal(wrong.isError, true);
      assert.match(wrong.text, /zcl_nope is no class of/);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deploy_folder writes nothing when one name is refused, and nothing through a link in the sandbox', async () => {
  const base = project();
  fs.mkdirSync(path.join(base, 'corpus', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(base, 'corpus', 'scripts', 'e2e-build.mjs'), '// probe\n');
  const box = path.join(base, 'corpus', 'src', 'zz_dev');
  fs.mkdirSync(box, { recursive: true });
  try {
    await withServer(base, async (call) => {
      // a name outside the customer namespace: refused before the first write
      fs.writeFileSync(path.join(base, 'src', 'cl_standard.clas.abap'), 'CLASS cl_standard DEFINITION.\nENDCLASS.\n');
      const r = await call('deploy_folder', { path: path.join(base, 'src'), lint: false });
      assert.equal(r.isError, true);
      assert.match(r.text, /cl_standard/);
      assert.deepEqual(fs.readdirSync(box), [], 'a refused folder leaves the sandbox as it was');
      fs.rmSync(path.join(base, 'src', 'cl_standard.clas.abap'));

      // a link in the sandbox where an object goes: refused, the victim untouched
      fs.writeFileSync(path.join(base, 'victim.txt'), 'ORIGINAL\n');
      fs.symlinkSync(path.join(base, 'victim.txt'), path.join(box, 'zif_fold.intf.abap'));
      const l = await call('deploy_folder', { path: path.join(base, 'src'), lint: false });
      assert.equal(l.isError, true);
      assert.match(l.text, /symbolic link|outside the dev sandbox/);
      assert.equal(fs.readFileSync(path.join(base, 'victim.txt'), 'utf8'), 'ORIGINAL\n');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

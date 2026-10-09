// Security regressions: an UNTRUSTED checkout (a sample, docs or an app
// cloned from GitHub) is hostile content, and a tool that reads or writes a
// path derived from it must not be steered outside the checkout through a
// symbolic link. safeRelPath and the sandbox name gate stop a `..` in a
// STRING; these pin the other half, resolved through the real file system.
// Each case failed before its containment fix (lib/contain.mjs resolvedInside,
// insideRoot/readInside, writeNoFollow).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolvedInside } from '../lib/remote.mjs';
import { writeNoFollow, writeInside, readInside, OutsideRootError } from '../lib/contain.mjs';
import { deployFiles } from '../lib/migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolvedInside: a path is inside only with every symlink on it resolved', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-sec-'));
  try {
    const root = path.join(base, 'root');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'x');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
    assert.equal(resolvedInside(root, path.join(root, 'sub', 'ok.txt')), true);
    // a file about to be written (does not exist yet) under a real directory
    assert.equal(resolvedInside(root, path.join(root, 'sub', 'new.txt')), true);
    // a symlink to a file outside the root
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'leak.txt'));
    assert.equal(resolvedInside(root, path.join(root, 'leak.txt')), false);
    // a symlinked directory leading out
    fs.symlinkSync(base, path.join(root, 'up'));
    assert.equal(resolvedInside(root, path.join(root, 'up', 'secret.txt')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function evilCheckouts() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-sec-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET-DO-NOT-LEAK\n');
  // a hostile samples checkout: a "sample" that is a symlink out of the tree
  fs.mkdirSync(path.join(base, 'samples', 'src'), { recursive: true });
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(base, 'samples', 'src', 'z2ui5_cl_evil.clas.abap'));
  w('samples/SAMPLES.md', '# Samples\n\n## X\n\n| Sample | Class |\n|---|---|\n| **Evil** — x<br>s<br><sub>k</sub> | [`Z2UI5_CL_EVIL`](src/z2ui5_cl_evil.clas.abap) |\n');
  // a hostile docs checkout: a page directory symlinked to an outside tree
  w('docs/package.json', '{"name":"abap2ui5-docs"}');
  w('docs/docs/index.md', '# Home\n\nstart\n');
  w('outside/leak.md', '# Leak\n\nsecret binding content\n');
  fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'docs', 'docs', 'ext'));
  // a hostile corpus with a symlinked sandbox file (the deploy/read target)
  w('corpus/scripts/e2e-build.mjs', '// probe\n');
  fs.mkdirSync(path.join(base, 'corpus', 'src', 'zz_dev'), { recursive: true });
  fs.writeFileSync(path.join(base, 'victim.txt'), 'ORIGINAL\n');
  fs.symlinkSync(path.join(base, 'victim.txt'), path.join(base, 'corpus', 'src', 'zz_dev', 'zcl_evil.clas.abap'));
  return base;
}

async function withServer(base, env, fn) {
  const nowhere = path.join(base, 'nowhere');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: { ...process.env, A2UI5_MCP_REMOTE: '0', AI_VIEW_CHECK_HOME: nowhere, A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'), ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'sec', version: '0' }, { capabilities: {} });
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

test('read_example refuses a sample file that resolves out of the checkout', async () => {
  const base = evilCheckouts();
  try {
    await withServer(base, { SAMPLES_HOME: path.join(base, 'samples') }, async (call) => {
      const r = await call('read_example', { repo: 'samples', path: 'src/z2ui5_cl_evil.clas.abap' });
      assert.equal(r.isError, true, 'the symlinked sample must be refused');
      assert.match(r.text, /symbolic link|outside the checkout/);
      assert.doesNotMatch(r.text, /TOP-SECRET/, 'the file content must not leak');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('docs_search does not follow a symlinked page directory out of the checkout', async () => {
  const base = evilCheckouts();
  try {
    await withServer(base, { DOCS_HOME: path.join(base, 'docs') }, async (call) => {
      const r = await call('docs_search', { query: 'binding' });
      assert.equal(r.isError, false);
      assert.doesNotMatch(r.text, /leak|secret binding/, 'the outside page must not be indexed');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deploy_app and read_app refuse a sandbox file that is a symlink out of the sandbox', async () => {
  const base = evilCheckouts();
  const victim = path.join(base, 'victim.txt');
  try {
    await withServer(base, { SAMPLES_CONTROLS_HOME: path.join(base, 'corpus'), A2UI5_HOME: path.join(base, 'nowhere') }, async (call) => {
      const src = 'CLASS zcl_evil DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES z2ui5_if_app.\nENDCLASS.\nCLASS zcl_evil IMPLEMENTATION.\nENDCLASS.\n';
      const d = await call('deploy_app', { class_name: 'zcl_evil', abap_source: src, lint: false });
      assert.equal(d.isError, true, 'writing through the symlink must be refused');
      assert.match(d.text, /symbolic link|outside the dev sandbox/);
      assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'the victim file outside the sandbox is untouched');
      const r = await call('read_app', { class_name: 'zcl_evil' });
      assert.equal(r.isError, true, 'reading through the symlink must be refused');
      assert.doesNotMatch(r.text, /ORIGINAL/, 'the outside file content must not leak');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* A DANGLING link is the case realpath cannot resolve: its parent resolved
 * inside, so it counted as inside - and a write through it creates the file
 * wherever it points (a ~/.config/autostart entry, a shell rc). */
test('resolvedInside: a dangling link is never inside; writeNoFollow never writes through a link', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-sec-'));
  try {
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    const target = path.join(base, 'created-outside.txt');
    fs.symlinkSync(target, path.join(root, 'dangling'));
    assert.equal(resolvedInside(root, path.join(root, 'dangling')), false, 'a dangling link is not inside');
    assert.throws(() => writeNoFollow(path.join(root, 'dangling'), 'x'), OutsideRootError);
    assert.equal(fs.existsSync(target), false, 'nothing was created through the dangling link');
    fs.writeFileSync(path.join(base, 'victim.txt'), 'ORIGINAL');
    fs.symlinkSync(path.join(base, 'victim.txt'), path.join(root, 'live'));
    assert.throws(() => writeNoFollow(path.join(root, 'live'), 'x'), /symbolic link/);
    assert.equal(fs.readFileSync(path.join(base, 'victim.txt'), 'utf8'), 'ORIGINAL');
    fs.symlinkSync(base, path.join(root, 'up'));
    assert.throws(() => writeInside(root, ['up', 'new.txt'], 'x'), OutsideRootError, 'a linked directory on the way');
    assert.equal(fs.existsSync(path.join(base, 'new.txt')), false);
    assert.throws(() => readInside(root, 'live', 'utf8'), /outside the checkout/);
    writeNoFollow(path.join(root, 'plain.txt'), 'ok');
    assert.equal(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), 'ok', 'a plain file is written as before');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deploy_app refuses a DANGLING link in the sandbox - nothing is created where it points', async () => {
  const base = evilCheckouts();
  const created = path.join(base, 'autostart-entry.txt');
  fs.rmSync(path.join(base, 'corpus', 'src', 'zz_dev', 'zcl_evil.clas.abap'));
  fs.symlinkSync(created, path.join(base, 'corpus', 'src', 'zz_dev', 'zcl_evil.clas.abap'));
  try {
    await withServer(base, { SAMPLES_CONTROLS_HOME: path.join(base, 'corpus'), A2UI5_HOME: path.join(base, 'nowhere') }, async (call) => {
      const src = 'CLASS zcl_evil DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES z2ui5_if_app.\nENDCLASS.\nCLASS zcl_evil IMPLEMENTATION.\nENDCLASS.\n';
      const d = await call('deploy_app', { class_name: 'zcl_evil', abap_source: src, lint: false });
      assert.equal(d.isError, true, d.text);
      assert.match(d.text, /symbolic link|outside the dev sandbox/);
      assert.equal(fs.existsSync(created), false, 'the write did not follow the dangling link');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** A secret outside, and checkouts whose documents are links to it. */
function evilDocuments() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-sec-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const link = (rel) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.symlinkSync(path.join(base, 'secret.txt'), path.join(base, rel)); };
  w('secret.txt', 'TOP-SECRET-DO-NOT-LEAK\n## Chapter\n');
  // abap2UI5: the guide, the interface and a catalogue of pitfalls are links out
  w('a2/node/srv/express.mjs', '// probe\n');
  link('a2/docs/agents/building-apps.md');
  link('a2/src/02/z2ui5_if_client.intf.abap');
  link('a2/.claude/skills/abap-check/SKILL.md');
  link('a2/.claude/skills/ui5-check/SKILL.md');
  // samples-controls: the capability map and the porting brief
  w('corpus/scripts/e2e-build.mjs', '// probe\n');
  link('corpus/CAPABILITIES.md');
  link('corpus/scripts/generation-prompt.txt');
  // samples: the catalogue
  w('samples/SAMPLES.md', '# Samples\n');
  w('samples/package.json', '{"name":"abap2UI5-samples"}');
  link('samples/catalogue.json');
  // docs: docs/ itself is a link to a tree outside
  w('docs/package.json', '{"name":"abap2ui5-docs"}');
  w('outside/index.md', '# Outside\n\nTOP-SECRET page binding\n');
  fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'docs', 'docs'));
  // app-template: template.json lists a path out of it and a file that is a link out
  w('template/abaplint.jsonc', '{}\n');
  link('template/CLAUDE.md');
  w('template/template.json', JSON.stringify({
    placeholderClass: 'zcl_app_001',
    files: { shared: ['CLAUDE.md', '../secret.txt'], named: [] },
    substitutions: { class: { files: [], renamesPath: true }, packageText: [], repo: [] },
    agentSetup: { files: { 'CLAUDE.md': 'why' } },
  }));
  w('project/.git/HEAD', 'ref: refs/heads/main\n');
  return base;
}

test('the knowledge tools never answer with a checkout file that is a link out of it', async () => {
  const base = evilDocuments();
  try {
    await withServer(base, {
      A2UI5_HOME: path.join(base, 'a2'),
      SAMPLES_CONTROLS_HOME: path.join(base, 'corpus'),
      SAMPLES_HOME: path.join(base, 'samples'),
      SAMPLES_STACK_HOME: path.join(base, 'nowhere'),
      DOCS_HOME: path.join(base, 'docs'),
      APP_TEMPLATE_HOME: path.join(base, 'template'),
    }, async (call) => {
      for (const [name, args] of [
        ['app_guide', {}], ['api_reference', {}], ['pitfalls', {}], ['pitfalls', { area: 'view' }],
        ['capabilities', {}], ['capabilities', { query: 'x' }], ['generation_rules', {}],
        ['examples', { query: 'x' }], ['docs_search', { query: 'binding' }], ['scaffold_app', {}],
      ]) {
        const r = await call(name, args);
        assert.doesNotMatch(r.text, /TOP-SECRET/, `${name} ${JSON.stringify(args)} leaked the file behind the link`);
        if (name !== 'examples' && name !== 'scaffold_app') assert.match(r.text, /symbolic link/, `${name}: says why`);
      }
      const ex = await call('examples', { query: 'x' });
      assert.match(ex.text, /catalogue\.json resolve\(s\), through a symbolic link, outside the checkout/);
      const sc = await call('scaffold_app', {});
      assert.match(sc.text, /"refused"[\s\S]*CLAUDE\.md[\s\S]*\.\.\/secret\.txt/, sc.text);
      // add_agent_setup: the template file is copied INTO the project - refused, nothing written
      const ag = await call('add_agent_setup', { project_dir: path.join(base, 'project') });
      assert.equal(ag.isError, true, ag.text);
      assert.match(ag.text, /symbolic link/);
      assert.equal(fs.existsSync(path.join(base, 'project', 'CLAUDE.md')), false, 'nothing written into the project');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* migrate_report { deploy: true } copies src/01 of the abap-cloud-gui
 * checkout and the popups into the sandbox: a file there that is a link out
 * of its checkout is not copied (read_app would serve its target back). */
test('deployFiles skips a support file that is a link out of its checkout', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-sec-'));
  try {
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
    w('secret.txt', 'TOP-SECRET');
    w('cgui/src/01/z2ui5_cl_cgui_report.clas.abap', 'CLASS z2ui5_cl_cgui_report DEFINITION. ENDCLASS.');
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(base, 'cgui', 'src', '01', 'z2ui5_cl_cgui_leak.clas.abap'));
    w('popups/src/00/z2ui5_cl_pop_x.clas.abap', 'CLASS z2ui5_cl_pop_x DEFINITION. ENDCLASS.');
    const box = path.join(base, 'box');
    const res = deployFiles({ files: { 'zcl_k.clas.abap': 'x' }, dir: box, cloudGui: path.join(base, 'cgui'), popups: path.join(base, 'popups'), classNameOf: (n) => n });
    assert.deepEqual(fs.readdirSync(box).sort(), ['z2ui5_cl_cgui_report.clas.abap', 'z2ui5_cl_pop_x.clas.abap', 'zcl_k.clas.abap']);
    assert.ok(!res.support.includes('z2ui5_cl_cgui_leak'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* SECURITY.md is where a reader learns what transpiled ABAP can read from
 * the environment, and it described the allowlist by category - NODE_ENV,
 * DEBUG, NODE_ICU_DATA, NODE_USE_ENV_PROXY and LD_LIBRARY_PATH were passed
 * and named nowhere. Both directions: every allowed name is in the
 * paragraph, and every variable the paragraph names is allowed. */
test('SECURITY.md names exactly the environment the app children are given', async () => {
  const { CHILD_ENV_NAMES } = await import('../lib/runtime.mjs');
  const doc = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  const para = /\*\*A child that runs the app gets an allowlisted environment\.\*\*[\s\S]*?\n- \*\*/.exec(doc);
  assert.ok(para, 'SECURITY.md lost its allowlist paragraph');
  const named = new Set([...para[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));
  for (const name of CHILD_ENV_NAMES) assert.ok(named.has(name), `${name} is passed to the app children and SECURITY.md does not say so`);
  for (const name of named) {
    if (['PORT', 'HOST', 'LC_'].includes(name)) continue; // set by backendEnv, and the LC_* family
    assert.ok(CHILD_ENV_NAMES.includes(name), `SECURITY.md says ${name} reaches the app children; appChildEnv does not pass it`);
  }
});

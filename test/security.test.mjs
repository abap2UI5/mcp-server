// Security regressions: an UNTRUSTED checkout (a sample, docs or an app
// cloned from GitHub) is hostile content, and a tool that reads or writes a
// path derived from it must not be steered outside the checkout through a
// symbolic link. safeRelPath and the sandbox name gate stop a `..` in a
// STRING; these pin the other half, resolved through the real file system.
// Each case failed before the containment fix (lib/remote.mjs resolvedInside).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolvedInside } from '../lib/remote.mjs';

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

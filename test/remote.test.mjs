// The read-only GitHub mirror (lib/remote.mjs): the fallback the knowledge
// tools have when no checkout resolves and nothing is configured. Sibling-free
// and NETWORK-FREE - every fetch here is a fake handed in through `fetchImpl`,
// and the mirror lives in a temp dir named by A2UI5_MCP_REMOTE_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hydrate, fetchRemoteFile, safeRelPath, isRemoteCheckout, readMarker, remoteRoot, remoteEnabled,
  mirrorFresh, remoteStatus, lastHydrate, resetRemote, REMOTE_FILES, REMOTE_TOOLS, resourceRepos, MARKER,
} from '../lib/remote.mjs';
import { resolveKey, REPO_DIRS } from '../lib/repos.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { RESOURCE_URIS } from '../lib/resources.mjs';

const ENV_VARS = ['A2UI5_HOME', 'AI_VIEW_CHECK_HOME', 'SAMPLES_CONTROLS_HOME', 'AI_DEMOKIT_HOME', 'SAMPLES_HOME', 'SAMPLES_STACK_HOME',
  'APP_TEMPLATE_HOME', 'DOCS_HOME', 'A2UI5_MCP_REMOTE', 'A2UI5_MCP_OFFLINE', 'A2UI5_MCP_REMOTE_TTL_MS'];

/* Every test runs with the mirror in its own temp dir and no repo env var
 * set, and puts the environment back afterwards. */
function withEnv(fn) {
  return async (t) => {
    const saved = Object.fromEntries(ENV_VARS.map((v) => [v, process.env[v]]));
    for (const v of ENV_VARS) delete process.env[v];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-remote-test-'));
    process.env.A2UI5_MCP_REMOTE_DIR = dir;
    resetRemote();
    try {
      await fn(t, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.A2UI5_MCP_REMOTE_DIR;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetRemote();
    }
  };
}

/** A fake fetch serving `files` (url suffix -> text), counting calls. */
function fakeFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = Object.entries(files).find(([suffix]) => url.endsWith(suffix));
    if (!hit) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => hit[1] };
  };
  impl.calls = calls;
  return impl;
}

test('safeRelPath admits a relative path inside the repository and nothing else', () => {
  assert.equal(safeRelPath('src/01/z2ui5_cl_smp_app_493.clas.abap'), 'src/01/z2ui5_cl_smp_app_493.clas.abap');
  assert.equal(safeRelPath('./CAPABILITIES.md'), 'CAPABILITIES.md');
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'a/./b', MARKER, `x/${MARKER}`, 'a\0b']) {
    assert.equal(safeRelPath(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('the tool and resource tables name real tools, resources and repo keys', () => {
  for (const [tool, keys] of Object.entries(REMOTE_TOOLS)) {
    assert.ok(TOOL_NAMES.includes(tool), `REMOTE_TOOLS names '${tool}', which lib/tools.mjs does not define`);
    for (const k of keys) assert.ok(REMOTE_FILES[k], `REMOTE_TOOLS['${tool}'] names repo key '${k}' without a file list`);
  }
  for (const k of Object.keys(REMOTE_FILES)) {
    assert.ok(REPO_DIRS[k], `REMOTE_FILES names repo key '${k}', which lib/repo-dirs.json does not have`);
    assert.ok(REPO_DIRS[k].repository, `repo-dirs.json entry '${k}' needs a repository for the mirror URL`);
  }
  for (const uri of RESOURCE_URIS) {
    for (const k of resourceRepos(uri)) assert.ok(REMOTE_FILES[k], `resource ${uri} maps to repo key '${k}' without a file list`);
  }
  // verify_app runs deploy_app's handler inside one request: the hydrate step
  // is keyed on the tool the client called, so it has to name the same reads
  for (const k of REMOTE_TOOLS.deploy_app) assert.ok(REMOTE_TOOLS.verify_app.includes(k), `verify_app must hydrate '${k}' like deploy_app`);
  assert.deepEqual(resourceRepos('abap2ui5://guide/5'), ['a2ui5']);
  assert.deepEqual(resourceRepos('abap2ui5://nothing'), []);
});

test('hydrate fetches the fixed file list into a mirror the resolver then hands out', withEnv(async (t, dir) => {
  const files = Object.fromEntries(REMOTE_FILES.corpus.map((f) => [`/${f}`, `content of ${f}`]));
  const fetchImpl = fakeFetch(files);
  // a local sibling checkout, when the workspace has one, wins over the mirror
  // by design - the resolver assertions below only hold without one
  const localCorpus = resolveKey('corpus', { local: true });
  if (!localCorpus) assert.equal(resolveKey('corpus'), null, 'nothing resolves before the mirror exists');
  const res = await hydrate('corpus', { local: null, fetchImpl });
  assert.equal(res.fetched, true);
  assert.equal(res.root, remoteRoot('corpus'));
  assert.equal(path.dirname(res.root), dir);
  assert.equal(fetchImpl.calls.length, REMOTE_FILES.corpus.length);
  assert.ok(fetchImpl.calls.every((u) => u.startsWith('https://raw.githubusercontent.com/abap2UI5/samples-controls/main/')));
  for (const f of REMOTE_FILES.corpus) assert.equal(fs.readFileSync(path.join(res.root, f), 'utf8'), `content of ${f}`);
  assert.ok(isRemoteCheckout(res.root));
  const marker = readMarker(res.root);
  assert.equal(marker.repository, 'abap2UI5/samples-controls');
  assert.deepEqual(marker.files, REMOTE_FILES.corpus);
  // the mirror is now what the resolver answers - but never as a LOCAL checkout
  if (!localCorpus) {
    assert.equal(resolveKey('corpus'), res.root);
    assert.equal(resolveKey('corpus', { local: true }), null);
  }
  // fresh: a second hydrate costs nothing
  const again = await hydrate('corpus', { local: null, fetchImpl });
  assert.equal(again.fromCache, true);
  assert.equal(fetchImpl.calls.length, REMOTE_FILES.corpus.length, 'a fresh mirror is not fetched again');
  assert.ok(mirrorFresh('corpus'));
}));

test('a local checkout, a set env var or the offline switch means no download at all', withEnv(async () => {
  const fetchImpl = fakeFetch({});
  const local = await hydrate('corpus', { local: '/some/checkout', fetchImpl });
  assert.equal(local.local, true);
  process.env.SAMPLES_CONTROLS_HOME = '/nowhere/at/all';
  const configured = await hydrate('corpus', { local: null, fetchImpl });
  assert.equal(configured.root, null);
  assert.equal(configured.configured, 'SAMPLES_CONTROLS_HOME');
  assert.match(remoteStatus('corpus'), /SAMPLES_CONTROLS_HOME is set/);
  await assert.rejects(fetchRemoteFile('corpus', 'src/x.clas.abap', { fetchImpl }), /SAMPLES_CONTROLS_HOME is set/);
  delete process.env.SAMPLES_CONTROLS_HOME;
  process.env.A2UI5_MCP_OFFLINE = '1';
  assert.equal(remoteEnabled(), false);
  const offline = await hydrate('corpus', { local: null, fetchImpl });
  assert.equal(offline.disabled, true);
  assert.match(remoteStatus('corpus'), /switched off/);
  delete process.env.A2UI5_MCP_OFFLINE;
  process.env.A2UI5_MCP_REMOTE = '0';
  assert.equal(remoteEnabled(), false);
  assert.equal(fetchImpl.calls.length, 0, 'nothing was fetched');
  // the linter has no mirror: it needs an install, not a file
  assert.equal((await hydrate('viewCheck', { local: null, fetchImpl })).unsupported, true);
}));

test('a failed download leaves no half mirror, keeps a stale one, and the reason reaches the message', withEnv(async () => {
  // only the first file of the list is served: nothing may be written
  const partial = fakeFetch({ [`/${REMOTE_FILES.corpus[0]}`]: 'x' });
  const res = await hydrate('corpus', { local: null, fetchImpl: partial });
  assert.equal(res.root, null);
  assert.match(res.error, /HTTP 404/);
  assert.ok(!fs.existsSync(remoteRoot('corpus')), 'a partial mirror must not be written');
  assert.equal(lastHydrate('corpus').error, res.error);
  assert.match(remoteStatus('corpus'), /could not be fetched either: HTTP 404/);
  // a complete mirror, then the network goes away: the stale copy is kept
  const full = fakeFetch(Object.fromEntries(REMOTE_FILES.corpus.map((f) => [`/${f}`, `v1 ${f}`])));
  assert.equal((await hydrate('corpus', { local: null, fetchImpl: full })).fetched, true);
  process.env.A2UI5_MCP_REMOTE_TTL_MS = '1';
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mirrorFresh('corpus'), false);
  const dead = fakeFetch({});
  const stale = await hydrate('corpus', { local: null, fetchImpl: dead });
  assert.equal(stale.stale, true);
  assert.equal(stale.root, remoteRoot('corpus'));
  assert.equal(fs.readFileSync(path.join(stale.root, 'CAPABILITIES.md'), 'utf8'), 'v1 CAPABILITIES.md');
  assert.equal(remoteStatus('corpus'), '', 'a stale mirror still stands in, so the missing-checkout message says nothing');
}));

test('the template mirror follows template.json, the docs mirror the repository tree', withEnv(async () => {
  const spec = { placeholderClass: 'zcl_app_001', files: { shared: ['package.json', '.github/workflows/check.yml'], named: ['src/zcl_app_001.clas.abap'] } };
  const tpl = fakeFetch({
    '/template.json': JSON.stringify(spec),
    '/package.json': '{"name":"abap2ui5-app"}',
    '/.github/workflows/check.yml': 'name: check',
    '/src/zcl_app_001.clas.abap': 'CLASS zcl_app_001 DEFINITION PUBLIC.',
  });
  const t = await hydrate('appTemplate', { local: null, fetchImpl: tpl });
  assert.equal(t.fetched, true);
  assert.equal(t.files, 4);
  assert.ok(fs.existsSync(path.join(t.root, '.github/workflows/check.yml')));
  // template.json is fetched once for the plan and once as a file of the list
  assert.equal(tpl.calls.filter((u) => u.endsWith('/template.json')).length, 2);

  const tree = { tree: [
    { type: 'blob', path: 'docs/index.md' },
    { type: 'blob', path: 'docs/advanced/linter.md' },
    { type: 'blob', path: 'docs/.vitepress/config.mts' },
    { type: 'blob', path: 'docs/public/index.md' },
    { type: 'tree', path: 'docs/advanced' },
    { type: 'blob', path: 'README.md' },
  ] };
  const docs = fakeFetch({
    'git/trees/main?recursive=1': JSON.stringify(tree),
    '/package.json': '{"name":"abap2ui5-docs"}',
    '/docs/index.md': '# Home',
    '/docs/advanced/linter.md': '# Linter',
  });
  const d = await hydrate('docs', { local: null, fetchImpl: docs });
  assert.equal(d.fetched, true);
  assert.deepEqual(readMarker(d.root).files, ['package.json', 'docs/index.md', 'docs/advanced/linter.md']);
  assert.ok(!fs.existsSync(path.join(d.root, 'docs/public')), 'the excluded directories are not mirrored');
  if (!resolveKey('docs', { local: true })) assert.equal(resolveKey('docs'), d.root);
}));

test('fetchRemoteFile reads one file on demand, from the cache while fresh', withEnv(async () => {
  const src = 'CLASS z2ui5_cl_smp_app_493 DEFINITION PUBLIC.';
  const impl = fakeFetch({ '/src/01/z2ui5_cl_smp_app_493.clas.abap': src });
  const at = await fetchRemoteFile('samples', 'src/01/z2ui5_cl_smp_app_493.clas.abap', { fetchImpl: impl });
  assert.equal(fs.readFileSync(at, 'utf8'), src);
  assert.equal(path.dirname(path.dirname(path.dirname(at))), remoteRoot('samples'));
  // no marker yet (nothing hydrated), so a second call fetches again
  await fetchRemoteFile('samples', 'src/01/z2ui5_cl_smp_app_493.clas.abap', { fetchImpl: impl });
  assert.equal(impl.calls.length, 2);
  // once the mirror is fresh, the cached copy answers
  await hydrate('samples', { local: null, fetchImpl: fakeFetch({ '/catalogue.json': '{}', '/SAMPLES.md': '' }) });
  await fetchRemoteFile('samples', 'src/01/z2ui5_cl_smp_app_493.clas.abap', { fetchImpl: impl });
  assert.equal(impl.calls.length, 2, 'a fresh mirror serves the file it has');
  await assert.rejects(fetchRemoteFile('samples', '../escape', { fetchImpl: impl }), /refusing path/);
  await assert.rejects(fetchRemoteFile('samples', 'src/none.abap', { fetchImpl: impl }), /could not fetch abap2UI5\/samples\/src\/none\.abap/);
}));

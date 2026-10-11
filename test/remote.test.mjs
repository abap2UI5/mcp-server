// The read-only GitHub mirror (lib/remote.mjs): the fallback the knowledge
// tools have when no checkout resolves and nothing is configured. Sibling-free
// and NETWORK-FREE - every fetch here is a fake handed in through `fetchImpl`,
// and the mirror lives in a temp dir named by A2UI5_MCP_REMOTE_DIR.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hydrate, fetchRemoteFile, safeRelPath, isRemoteCheckout, readMarker, remoteRoot, remoteEnabled,
  mirrorFresh, remoteStatus, lastHydrate, resetRemote, FAILURE_BACKOFF_MS, failureBackoffMs, REMOTE_FILES, REMOTE_OPTIONAL, REMOTE_TOOLS, resourceRepos, MARKER, TEXT_MAX_BYTES,
} from '../lib/remote.mjs';
import { resolveKey, REPO_DIRS } from '../lib/repos.mjs';
import { privateDirProblem } from '../lib/private-dir.mjs';
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
  // so do the tools that compose build_backend: verify_app, and migrate_report { deploy: true }
  for (const composer of ['verify_app', 'migrate_report']) {
    for (const k of REMOTE_TOOLS.build_backend) assert.ok((REMOTE_TOOLS[composer] || []).includes(k), `${composer} must hydrate '${k}' like build_backend`);
  }
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
  // the fixed list, and the optional files the fake does not have (404: left out)
  assert.equal(fetchImpl.calls.length, REMOTE_FILES.corpus.length + REMOTE_OPTIONAL.corpus.length);
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
  assert.equal(fetchImpl.calls.length, REMOTE_FILES.corpus.length + REMOTE_OPTIONAL.corpus.length, 'a fresh mirror is not fetched again');
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
  // the failure is the answer for a while (FAILURE_BACKOFF_MS) - force tries regardless
  assert.equal((await hydrate('corpus', { local: null, fetchImpl: full, force: true })).fetched, true);
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

test('a failed download is not tried again for FAILURE_BACKOFF_MS - with or without a stale copy', withEnv(async () => {
  assert.ok(FAILURE_BACKOFF_MS >= 60_000 && FAILURE_BACKOFF_MS <= 10 * 60_000, 'a few minutes');
  const dead = fakeFetch({});
  const first = await hydrate('corpus', { local: null, fetchImpl: dead });
  assert.equal(first.root, null);
  const calls = dead.calls.length;
  assert.ok(calls > 0);
  const again = await hydrate('corpus', { local: null, fetchImpl: dead });
  assert.equal(dead.calls.length, calls, 'no second download while the failure is fresh');
  assert.equal(again.root, null);
  assert.equal(again.error, first.error);
  assert.match(again.backoff, /^not retried for \d+ s$/);
  assert.match(remoteStatus('corpus'), /could not be fetched either: HTTP 404/, 'the reason stays in the message');
  /* and says when it is tried again: a user who fixed the network (a
   * proxy, a token) read the same error for three minutes without a word
   * that nothing had been tried */
  assert.match(remoteStatus('corpus'), /HTTP 404.* \(tried \d+ s ago - not tried again for another \d+ s\)$/);
  // a stale mirror stands in for the failure the same way
  const full = fakeFetch(Object.fromEntries(REMOTE_FILES.corpus.map((f) => [`/${f}`, `v1 ${f}`])));
  assert.equal((await hydrate('corpus', { local: null, fetchImpl: full, force: true })).fetched, true);
  process.env.A2UI5_MCP_REMOTE_TTL_MS = '1';
  await new Promise((r) => setTimeout(r, 5));
  const staleFirst = await hydrate('corpus', { local: null, fetchImpl: dead });
  assert.equal(staleFirst.stale, true);
  const n = dead.calls.length;
  const staleAgain = await hydrate('corpus', { local: null, fetchImpl: dead });
  assert.equal(dead.calls.length, n, 'the stale copy, without waiting out another fetch');
  assert.equal(staleAgain.stale, true);
  assert.equal(staleAgain.root, remoteRoot('corpus'));
  // once the backoff is over it is tried again
  lastHydrate('corpus').failedAt -= FAILURE_BACKOFF_MS;
  await hydrate('corpus', { local: null, fetchImpl: dead });
  assert.ok(dead.calls.length > n);
}));

/* A fixed 3 min meant a machine that is simply offline (without
 * A2UI5_MCP_OFFLINE) stalled the 20 s fetch timeout every three minutes,
 * per mirror, for as long as the server ran. The wait doubles per failure
 * in a row, up to the TTL, and a success starts it over. On a fake clock. */
test('the failure backoff doubles per failure in a row, stops at the TTL, and a success resets it', withEnv(async () => {
  const MIN = 60_000;
  assert.deepEqual([1, 2, 3, 4].map((n) => failureBackoffMs(n, 24 * 60 * MIN)), [3 * MIN, 6 * MIN, 12 * MIN, 24 * MIN]);
  assert.equal(failureBackoffMs(9, 24 * 60 * MIN), 768 * MIN, 'doubled up to the TTL (3 * 2^8 min)');
  assert.equal(failureBackoffMs(10, 24 * 60 * MIN), 24 * 60 * MIN, 'and never past it (1536 min would be)');
  assert.equal(failureBackoffMs(40, 24 * 60 * MIN), 24 * 60 * MIN, 'however many failures');
  assert.equal(failureBackoffMs(3, 5 * MIN), 5 * MIN, 'a short TTL is the cap');
  assert.equal(failureBackoffMs(1, 1), FAILURE_BACKOFF_MS, 'and never under the first step');
  assert.equal(failureBackoffMs(0), FAILURE_BACKOFF_MS);
  process.env.A2UI5_MCP_REMOTE_TTL_MS = String(10 * MIN);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const dead = fakeFetch({});
    const tried = () => dead.calls.length;
    const first = await hydrate('corpus', { local: null, fetchImpl: dead });
    assert.equal(first.failures, 1);
    assert.equal(first.backoffMs, 3 * MIN);
    let n = tried();
    mock.timers.tick(3 * MIN - 1);
    assert.equal((await hydrate('corpus', { local: null, fetchImpl: dead })).backoff, 'not retried for 1 s');
    assert.equal(tried(), n, 'nothing tried inside the first 3 min');
    mock.timers.tick(1);
    const second = await hydrate('corpus', { local: null, fetchImpl: dead });
    assert.ok(tried() > n, 'tried again after 3 min');
    assert.deepEqual([second.failures, second.backoffMs], [2, 6 * MIN], 'the second failure in a row waits 6 min');
    n = tried();
    mock.timers.tick(6 * MIN - 1);
    assert.equal((await hydrate('corpus', { local: null, fetchImpl: dead })).failures, 2);
    assert.equal(tried(), n, 'not inside the 6 min');
    assert.match(remoteStatus('corpus'), /not tried again for another 1 s\)$/);
    mock.timers.tick(1);
    const third = await hydrate('corpus', { local: null, fetchImpl: dead });
    assert.ok(tried() > n);
    assert.deepEqual([third.failures, third.backoffMs], [3, 10 * MIN], '12 min would be past the 10 min TTL');
    mock.timers.tick(10 * MIN);
    const fourth = await hydrate('corpus', { local: null, fetchImpl: dead });
    assert.deepEqual([fourth.failures, fourth.backoffMs], [4, 10 * MIN], 'stays at the TTL');
    // the network comes back: a success resets the run
    const full = fakeFetch(Object.fromEntries(REMOTE_FILES.corpus.map((f) => [`/${f}`, `v1 ${f}`])));
    mock.timers.tick(10 * MIN);
    assert.equal((await hydrate('corpus', { local: null, fetchImpl: full })).fetched, true);
    assert.equal(lastHydrate('corpus').failures, undefined);
    mock.timers.tick(10 * MIN + 1); // the mirror is stale again
    const afterSuccess = await hydrate('corpus', { local: null, fetchImpl: dead });
    assert.equal(afterSuccess.stale, true, 'the copy stands in');
    assert.deepEqual([afterSuccess.failures, afterSuccess.backoffMs], [1, 3 * MIN], 'back to the first step');
    n = tried();
    mock.timers.tick(3 * MIN - 1);
    assert.equal((await hydrate('corpus', { local: null, fetchImpl: dead })).failures, 1);
    assert.equal(tried(), n, 'the stale copy, without a fetch, for 3 min');
    mock.timers.tick(1);
    assert.equal((await hydrate('corpus', { local: null, fetchImpl: dead })).failures, 2);
    assert.ok(tried() > n);
    // force tries regardless of the wait, and counts
    const forced = await hydrate('corpus', { local: null, fetchImpl: dead, force: true });
    assert.equal(forced.failures, 3);
  } finally {
    mock.timers.reset();
  }
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

/* A refresh wrote the new list over the old one and never took anything
 * out: a docs page removed upstream stayed in the mirror, and docs_search
 * (which walks the mirror's tree) kept answering with it. */
test('a refresh takes out the files the repository no longer lists, and keeps the ones read on demand', withEnv(async () => {
  const tree = (paths) => JSON.stringify({ tree: paths.map((p) => ({ type: 'blob', path: p })) });
  const first = await hydrate('docs', { local: null, fetchImpl: fakeFetch({
    'git/trees/main?recursive=1': tree(['docs/index.md', 'docs/old.md']),
    '/package.json': '{"name":"abap2ui5-docs"}',
    '/docs/index.md': '# Home',
    '/docs/old.md': '# A page that moves',
  }) });
  assert.ok(fs.existsSync(path.join(first.root, 'docs/old.md')));
  const onDemand = await fetchRemoteFile('docs', 'docs/extra.md', { fetchImpl: fakeFetch({ '/docs/extra.md': '# read on demand' }) });
  const again = await hydrate('docs', { local: null, force: true, fetchImpl: fakeFetch({
    'git/trees/main?recursive=1': tree(['docs/index.md']),
    '/package.json': '{"name":"abap2ui5-docs"}',
    '/docs/index.md': '# Home',
  }) });
  assert.equal(again.fetched, true);
  assert.ok(!fs.existsSync(path.join(again.root, 'docs/old.md')), 'a page gone upstream is gone from the mirror');
  assert.ok(fs.existsSync(path.join(again.root, 'docs/index.md')));
  assert.ok(fs.existsSync(onDemand), 'a file the marker never listed is not the refresh\'s to remove');
}));

/* catalogue-derived.json makes `examples` find a sample by a control its
 * view builds - an improvement, never a precondition: a mirror carries it
 * when the repository has it, goes without when it does not, and a refresh
 * that no longer finds it takes the old copy away. */
test('an optional mirror file is carried when it is there and never costs the mirror', withEnv(async () => {
  assert.deepEqual(REMOTE_OPTIONAL.corpus, ['catalogue-derived.json']);
  assert.deepEqual(REMOTE_OPTIONAL.samples, ['catalogue-derived.json']);
  const files = Object.fromEntries(REMOTE_FILES.samples.map((f) => [`/${f}`, `content of ${f}`]));
  const withDerived = await hydrate('samples', { local: null, force: true, fetchImpl: fakeFetch({ ...files, '/catalogue-derived.json': '{"controls":[]}' }) });
  assert.equal(withDerived.fetched, true);
  assert.equal(fs.readFileSync(path.join(withDerived.root, 'catalogue-derived.json'), 'utf8'), '{"controls":[]}');
  assert.deepEqual(readMarker(withDerived.root).files, [...REMOTE_FILES.samples, 'catalogue-derived.json']);
  const without = await hydrate('samples', { local: null, force: true, fetchImpl: fakeFetch(files) });
  assert.equal(without.fetched, true, 'a 404 of an optional file is no failed mirror');
  assert.ok(!fs.existsSync(path.join(without.root, 'catalogue-derived.json')), 'the copy of the last refresh is gone with it');
  assert.deepEqual(readMarker(without.root).files, REMOTE_FILES.samples);
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
  /* hydrate refreshes the marker and the files of its list, never a file
   * fetched on demand: a fresh marker alone kept serving that file's first
   * fetch for as long as the mirror was refreshed daily */
  const file = path.join(remoteRoot('samples'), 'src/01/z2ui5_cl_smp_app_493.clas.abap');
  const old = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
  fs.utimesSync(file, old, old);
  assert.equal(mirrorFresh('samples'), true);
  await fetchRemoteFile('samples', 'src/01/z2ui5_cl_smp_app_493.clas.abap', { fetchImpl: impl });
  assert.equal(impl.calls.length, 3, 'a file older than the TTL is fetched again, fresh marker or not');
  await fetchRemoteFile('samples', 'src/01/z2ui5_cl_smp_app_493.clas.abap', { fetchImpl: impl });
  assert.equal(impl.calls.length, 3, 'and served from the cache once it is fresh');
  await assert.rejects(fetchRemoteFile('samples', '../escape', { fetchImpl: impl }), /refusing path/);
  await assert.rejects(fetchRemoteFile('samples', 'src/none.abap', { fetchImpl: impl }), /could not fetch abap2UI5\/samples\/src\/none\.abap/);
}));

/* A token is for the API's rate limit and goes nowhere else. It used to be
 * sent to raw.githubusercontent.com too, which answers a token it does not
 * accept with 404 - so one stale GITHUB_TOKEN made every knowledge tool
 * report every file missing. A token the API refuses is dropped, not fatal. */
test('the GitHub token goes to the API only, and a refused one is retried without', withEnv(async () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  const seen = [];
  const tree = { tree: [{ type: 'blob', path: 'docs/index.md' }] };
  const impl = async (url, init) => {
    const auth = init && init.headers && init.headers.Authorization;
    seen.push({ url, auth });
    if (url.includes('api.github.com') && auth) return { ok: false, status: 401, headers: new Map(), text: async () => 'Bad credentials' };
    if (url.includes('api.github.com')) return { ok: true, status: 200, text: async () => JSON.stringify(tree) };
    if (auth) return { ok: false, status: 404, text: async () => 'not found' }; // what raw does with a bad token
    return { ok: true, status: 200, text: async () => (url.endsWith('package.json') ? '{}' : '# Home') };
  };
  const errors = [];
  const origError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    process.env.GITHUB_TOKEN = 'ghp_stale';
    delete process.env.GH_TOKEN;
    const d = await hydrate('docs', { local: null, fetchImpl: impl });
    assert.equal(d.fetched, true, `the mirror is fetched despite the bad token: ${d.error}`);
    for (const c of seen.filter((x) => x.url.includes('raw.githubusercontent.com'))) {
      assert.equal(c.auth, undefined, `no token to ${c.url}`);
    }
    const api = seen.filter((x) => x.url.includes('api.github.com'));
    assert.deepEqual(api.map((x) => Boolean(x.auth)), [true, false], 'with the token first, then without');
    assert.equal(errors.filter((e) => /refused the GITHUB_TOKEN/.test(e)).length, 1, 'one warning on stderr');
  } finally {
    console.error = origError;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}));

test('a used-up unauthenticated API limit says so and names the token', withEnv(async () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    const headers = new Map([['x-ratelimit-remaining', '0'], ['x-ratelimit-reset', '1900000000']]);
    const impl = async (url) => (url.includes('api.github.com')
      ? { ok: false, status: 403, headers, text: async () => 'rate limited' }
      : { ok: true, status: 200, text: async () => '{}' });
    const d = await hydrate('docs', { local: null, fetchImpl: impl });
    assert.equal(d.root, null);
    assert.match(d.error, /HTTP 403/);
    assert.match(d.error, /unauthenticated API rate limit/);
    assert.match(d.error, /GITHUB_TOKEN/);
    assert.match(remoteStatus('docs'), /rate limit/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}));

/* template.json is a file in another repository, and its entries become
 * paths under the mirror directory: an entry that climbs out of it must
 * refuse the mirror, not write outside it. */
test('a template.json entry that escapes the repository refuses the whole mirror', withEnv(async (t, dir) => {
  for (const bad of ['../../escaped.txt', '/etc/escaped.txt', 'src/../../escaped.txt']) {
    resetRemote();
    const spec = { placeholderClass: 'zcl_app_001', files: { shared: ['package.json', bad], named: [] } };
    const impl = fakeFetch({ '/template.json': JSON.stringify(spec), '/package.json': '{}', 'escaped.txt': 'pwned' });
    const res = await hydrate('appTemplate', { local: null, fetchImpl: impl });
    assert.equal(res.root, null, bad);
    assert.match(res.error, /outside the repository/);
    assert.ok(!impl.calls.some((u) => u.endsWith('escaped.txt')), 'the bad entry is not even fetched');
    assert.ok(!fs.existsSync(path.join(dir, 'escaped.txt')) && !fs.existsSync(path.join(path.dirname(dir), 'escaped.txt')));
    assert.ok(!isRemoteCheckout(remoteRoot('appTemplate')), 'no half mirror either');
  }
}));

/* The default base is <tmp>/abap2ui5-mcp-remote - on Linux under /tmp, which
 * every local user can write. Another user who made that name first (or
 * linked it) decided what every knowledge tool served, and add_agent_setup
 * wrote the files of their template.json into the user's project. TMPDIR
 * points os.tmpdir() at a directory of this test's own, so nothing here
 * touches the real shared temp dir. */
const POSIX = process.platform !== 'win32';
test('the default mirror base is used only when it is this user\'s own directory', { skip: !POSIX && 'POSIX modes and links' }, withEnv(async (t, dir) => {
  const savedTmp = process.env.TMPDIR;
  delete process.env.A2UI5_MCP_REMOTE_DIR;
  process.env.TMPDIR = dir;
  try {
    assert.equal(os.tmpdir(), dir);
    const base = path.join(dir, 'abap2ui5-mcp-remote');
    // what another user would plant: a fresh template mirror behind a link
    const planted = path.join(dir, 'theirs');
    const tpl = path.join(planted, REPO_DIRS.appTemplate.dirs[0]);
    fs.mkdirSync(tpl, { recursive: true });
    fs.writeFileSync(path.join(tpl, 'template.json'), JSON.stringify({ files: { shared: ['.claude/settings.json'] } }));
    fs.writeFileSync(path.join(tpl, MARKER), JSON.stringify({ fetchedAt: new Date().toISOString(), files: ['template.json'] }));
    fs.symlinkSync(planted, base);
    assert.equal(remoteRoot('appTemplate'), path.join(base, REPO_DIRS.appTemplate.dirs[0]));
    const local = resolveKey('appTemplate', { local: true });
    if (!local) assert.equal(resolveKey('appTemplate'), null, 'a linked base is no mirror');
    const impl = fakeFetch({ '/template.json': '{"files":{}}' });
    const res = await hydrate('appTemplate', { local: null, fetchImpl: impl });
    assert.equal(res.root, null);
    assert.match(res.error, /symbolic link/);
    assert.match(remoteStatus('appTemplate'), /A2UI5_MCP_REMOTE_DIR/);
    assert.equal(impl.calls.length, 0, 'nothing fetched, nothing written through the link');
    await assert.rejects(fetchRemoteFile('appTemplate', 'README.md', { fetchImpl: impl }), /symbolic link/);
    assert.deepEqual(fs.readdirSync(tpl).sort(), [MARKER, 'template.json'].sort());

    // a real directory everybody can write is refused the same way
    fs.unlinkSync(base);
    fs.mkdirSync(base);
    fs.chmodSync(base, 0o777);
    fs.cpSync(tpl, path.join(base, REPO_DIRS.appTemplate.dirs[0]), { recursive: true });
    resetRemote();
    if (!local) assert.equal(resolveKey('appTemplate'), null, 'a world-writable base is no mirror');
    assert.match((await hydrate('appTemplate', { local: null, fetchImpl: impl })).error, /writable by every user/);

    // absent, it is created 0700 and used; one of ours readable by others is narrowed
    fs.rmSync(base, { recursive: true, force: true });
    resetRemote();
    const spec = { files: { shared: ['package.json'], named: [] } };
    const ok = await hydrate('appTemplate', { local: null, fetchImpl: fakeFetch({ '/template.json': JSON.stringify(spec), '/package.json': '{}' }) });
    assert.equal(ok.fetched, true, ok.error);
    assert.equal(fs.statSync(base).mode & 0o777, 0o700);
    fs.chmodSync(base, 0o755);
    assert.equal(privateDirProblem(base), null);
    assert.equal(fs.statSync(base).mode & 0o777, 0o700);
    // owned by somebody else (the uid is a parameter: no test can chown)
    assert.match(privateDirProblem(base, { uid: fs.statSync(base).uid + 1 }), /belongs to another user/);
    // an absent directory is nothing to distrust; a file is no directory
    assert.equal(privateDirProblem(path.join(dir, 'absent')), null);
    fs.writeFileSync(path.join(dir, 'file'), '');
    assert.match(privateDirProblem(path.join(dir, 'file')), /not a directory/);
    // a base the user names is the user's choice
    process.env.A2UI5_MCP_REMOTE_DIR = planted;
    assert.equal(remoteRoot('appTemplate'), tpl);
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
}));

/* A response stream of `total` bytes in 1 MB chunks of `fill`, made as they
 * are pulled - `pulled()` says how much the reader asked for, `cancelled()`
 * whether it let go of the rest. */
function bigBody(total, { fill = 0x61 } = {}) {
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(1048576, total - sent);
      sent += n;
      c.enqueue(new Uint8Array(n).fill(fill));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => sent, cancelled: () => cancelled };
}

/* fetchText had timeouts and no size limit: a proxy or mirror answering a
 * file with a huge or endless body filled the server's memory before the
 * 20 s were up. It reads up to TEXT_MAX_BYTES (8 MB, over twenty times the
 * largest file a mirror carries) and stops there, by URL. */
test('a GitHub answer over the text cap is cut at the cap and reported, one under it is read whole', withEnv(async () => {
  assert.equal(TEXT_MAX_BYTES, 8 * 1024 * 1024);
  const big = bigBody(64 * 1048576);
  await assert.rejects(
    fetchRemoteFile('samples', 'src/zcl_big.clas.abap', { fetchImpl: async () => new Response(big.stream) }),
    (e) => /could not fetch abap2UI5\/samples\/src\/zcl_big\.clas\.abap/.test(e.message) && /larger than 8 MB - stopped reading/.test(e.message),
  );
  assert.ok(big.pulled() <= TEXT_MAX_BYTES + 2 * 1048576, `read ${big.pulled()} bytes of an oversized answer`);
  assert.equal(big.cancelled(), true, 'the rest of the answer is let go');
  assert.equal(fs.existsSync(path.join(remoteRoot('samples'), 'src/zcl_big.clas.abap')), false, 'nothing is written');

  // declared too large: refused before a byte is read
  const declared = bigBody(1024);
  await assert.rejects(
    fetchRemoteFile('samples', 'src/zcl_decl.clas.abap', {
      fetchImpl: async () => new Response(declared.stream, { headers: { 'content-length': String(100 * 1048576) } }),
    }),
    /larger than 8 MB/,
  );
  assert.equal(declared.pulled(), 0);

  // under the cap: read whole and decoded as text() decodes, a character
  // split across two chunks included
  const bytes = Buffer.from('\ufeffCLASS zcl_ok \u00e4\u00f6\u00fc.', 'utf8');
  const split = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes.subarray(0, 17)));
      c.enqueue(new Uint8Array(bytes.subarray(17)));
      c.close();
    },
  });
  const at = await fetchRemoteFile('samples', 'src/zcl_ok.clas.abap', { fetchImpl: async () => new Response(split) });
  assert.equal(fs.readFileSync(at, 'utf8'), await new Response(bytes).text());
  // an answer just under the cap is still the file
  const near = bigBody(TEXT_MAX_BYTES - 10);
  const nearAt = await fetchRemoteFile('samples', 'src/zcl_near.clas.abap', { fetchImpl: async () => new Response(near.stream) });
  assert.equal(fs.statSync(nearAt).size, TEXT_MAX_BYTES - 10);
}));

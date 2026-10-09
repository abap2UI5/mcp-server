// Sibling-free unit tests (node --test): every unit here runs without the
// samples-controls / abap2UI5 / linter checkouts. The stdio smoke lives in
// test/smoke.test.mjs and DOES need the siblings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonc, LOCAL_BENIGN, benignRules, deployApp, removeApp } from '../lib/runtime.mjs';
import { parseCapabilities, searchCapabilities } from '../lib/capabilities.mjs';
import { parseExamples, searchExamples, catalogueEntries, derivedControls, CATALOGUES, matchRow } from '../lib/examples.mjs';
import { CORPUS_DIRS, resolveLintConfig, viewCheckCandidates, SERVER_ROOT } from '../lib/repos.mjs';
import { sliceCatalogue } from '../lib/pitfalls.mjs';
import { sliceGuide, guideChapters } from '../lib/guide.mjs';
import { parseApi, searchApi, apiSummary } from '../lib/api.mjs';
import { searchDocs, slicePage, headingText, markdownLinks } from '../lib/docs.mjs';
import { parseSizes } from '../lib/screenshot.mjs';
import { oneOf, boundedInt, stringArray, checkStringArgs } from '../lib/args.mjs';
import { readCached } from '../lib/cache.mjs';
import { scaffold, rename, validClassName, templateFiles, readSpec } from '../lib/scaffold.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------ stripJsonc ----
test('stripJsonc counts characters the way it measured them', () => {
  // the offsets of the trailing commas come from out.length (UTF-16 code
  // units); dropping them by code POINT shifts every index after the first
  // astral character, so an emoji anywhere before a trailing comma used to
  // delete the wrong one and leave unparseable JSON behind
  const jsonc = '{ "a": "\u{1F389}", "b": [1,2,], }';
  const out = stripJsonc(jsonc);
  assert.deepEqual(JSON.parse(out), { a: '\u{1F389}', b: [1, 2] });
});


test('stripJsonc removes line and block comments but keeps strings intact', () => {
  const jsonc = `{
  // line comment
  "a": "value with // no comment",
  /* block
     comment */
  "b": ["x", "y"], // trailing
  "url": "https://example.com/path"
}`;
  const parsed = JSON.parse(stripJsonc(jsonc));
  assert.equal(parsed.a, 'value with // no comment');
  assert.deepEqual(parsed.b, ['x', 'y']);
  assert.equal(parsed.url, 'https://example.com/path');
});

test('stripJsonc tolerates trailing commas', () => {
  const parsed = JSON.parse(stripJsonc('{ "a": [1, 2,], "b": { "c": 1, }, }'));
  assert.deepEqual(parsed.a, [1, 2]);
  assert.equal(parsed.b.c, 1);
});

/* Trailing-comma removal must tell punctuation from text. It used to be a
 * regex over the finished output, which also rewrote string CONTENT: an
 * abaplint exclude pattern `app[,]x` came out as `app[]x` - a character class
 * that matches nothing, so the exclusion silently stopped excluding. */
test('stripJsonc leaves a comma inside a string alone', () => {
  assert.equal(JSON.parse(stripJsonc('{ "exclude": ["src/app[,]x"], }')).exclude[0], 'src/app[,]x');
  assert.equal(JSON.parse(stripJsonc('{ "a": "foo, } bar" }')).a, 'foo, } bar');
});

// -------------------------------------------------- CAPABILITIES.md parser ----

// marks built from code points so this source stays 7-bit ASCII (repo rule)
const OK = String.fromCodePoint(0x2705);
const PART = String.fromCodePoint(0x1f536);
const NO = String.fromCodePoint(0x274c);
const CAPS_FIXTURE = [
  '# CAPABILITIES',
  '',
  '## Views & controls',
  '',
  '| UI5 feature | Status | How | Evidence |',
  '|---|---|---|---|',
  `| Plain controls | ${OK} works | open/leaf/a chains | app 051 |`,
  `| Escaped pipe \\| in cell | ${PART} partial | see notes | app 007 |`,
  `| Frontend factories | ${NO} not expressible | no equivalent | - |`,
  '',
  '## Popups & messages',
  '',
  '| UI5 feature | Status | How | Evidence |',
  '|---|---|---|---|',
  `| Dialogs | ${OK} works | popup_display | app 044 |`,
  '',
].join('\n');

test('parseCapabilities reads sections, statuses and escaped pipes from a table', () => {
  const entries = parseCapabilities(CAPS_FIXTURE);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].section, 'Views & controls');
  assert.equal(entries[0].status, 'direct');
  assert.equal(entries[1].feature, 'Escaped pipe | in cell');
  assert.equal(entries[1].status, 'workaround');
  assert.equal(entries[2].status, 'not-expressible');
  assert.equal(entries[3].section, 'Popups & messages');
});

test('searchCapabilities filters by status and by AND-ed query terms', () => {
  const works = searchCapabilities({ status: 'direct', rawText: CAPS_FIXTURE });
  assert.deepEqual(works.map((e) => e.feature), ['Plain controls', 'Dialogs']);
  const hit = searchCapabilities({ query: 'popup dialog', rawText: CAPS_FIXTURE });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].feature, 'Dialogs');
  assert.equal(searchCapabilities({ query: 'nonexistent thing', rawText: CAPS_FIXTURE }).length, 0);
});

/* Both documents are parsed LIVE on every query - that is the whole design
 * (no generated artifact that can drift), and it means the server re-reads
 * whatever the checkout happens to contain right now: mid-edit, mid-merge,
 * half-pulled. A throw there is not a wrong answer, it is a dead tool, so
 * neither parser may throw on anything.
 *
 * Measured before pinning: 1,144 calls over the real CAPABILITIES.md and the
 * abap-check catalogue - 60 truncations each, 400 seeded mutations
 * (pipes, backticks, headings, rule lines inserted / runs deleted /
 * duplicated) and degenerate inputs - threw nothing. Those need the sibling
 * checkouts; this fixture-scale guard is what runs sibling-free. */
test('the live parsers report, never throw, on a damaged document', () => {
  const POISON = ['|', '\\|', '\n', '`', '#', '##', '---', '|---|', '', ' ', '\\', '"'];
  for (let i = 0; i <= 40; i++) {
    const capCut = CAPS_FIXTURE.slice(0, Math.floor((CAPS_FIXTURE.length * i) / 40));
    const catCut = CATALOGUE.slice(0, Math.floor((CATALOGUE.length * i) / 40));
    assert.doesNotThrow(() => parseCapabilities(capCut), `parseCapabilities threw on a ${i}/40 truncation`);
    assert.doesNotThrow(() => searchCapabilities({ query: 'a b', status: 'direct', rawText: capCut }),
      `searchCapabilities threw on a ${i}/40 truncation`);
    assert.doesNotThrow(() => sliceCatalogue(catCut, 'icon'), `sliceCatalogue threw on a ${i}/40 truncation`);
  }
  POISON.forEach((p, i) => {
    const at = Math.floor((CAPS_FIXTURE.length * (i + 1)) / (POISON.length + 1));
    assert.doesNotThrow(() => parseCapabilities(CAPS_FIXTURE.slice(0, at) + p + CAPS_FIXTURE.slice(at)),
      `parseCapabilities threw on ${JSON.stringify(p)} at ${at}`);
    assert.doesNotThrow(() => sliceCatalogue(CATALOGUE.slice(0, at) + p + CATALOGUE.slice(at)),
      `sliceCatalogue threw on ${JSON.stringify(p)} at ${at}`);
  });
  for (const bad of ['', '\n', '|', '|||', '# x', '## ', '---\n---\n', '|a|b|c|d|']) {
    assert.doesNotThrow(() => parseCapabilities(bad), `parseCapabilities threw on ${JSON.stringify(bad)}`);
    assert.doesNotThrow(() => sliceCatalogue(bad), `sliceCatalogue threw on ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------- deployApp validation ----
// The validation gate runs BEFORE any sibling checkout is touched, so the
// error paths are sibling-free. (The happy path writes into samples-controls and
// is covered by the stdio smoke instead.)

test('deployApp rejects a class name outside the customer namespace', () => {
  for (const bad of ['acl_my_app', 'cl_my_app', 'my_app', '1cl_app', '']) {
    assert.throws(
      () => deployApp({ className: bad, source: 'x' }),
      /invalid class name/,
      `expected rejection for '${bad}'`,
    );
  }
});

/* The namespace this accepts is the CUSTOMER namespace, not the corpus' port
 * convention. It was `^z2ui5_cl_`, which is what the demo-kit ports are called
 * - and this server exists for an agent building its own app. abap2UI5's own
 * app-template ships `zcl_app_001`, so the recommended starting point was the
 * one name every tool here refused. */
test('deployApp accepts the customer-namespace names a user app actually has', () => {
  const source = (cls) => `CLASS ${cls} DEFINITION. INTERFACES z2ui5_if_app. ENDCLASS.`;
  /* Both sandbox homes pointed nowhere: the name gate runs first, and what
   * stops the deploy after it is the missing sandbox - a different error
   * entirely, and one that must not be a write into a sibling checkout that
   * happens to be next to this repository (the framework's node/zz_dev is a
   * sandbox now, and a test may not leave apps in it). */
  const saved = { corpus: process.env.SAMPLES_CONTROLS_HOME, a2: process.env.A2UI5_HOME };
  process.env.SAMPLES_CONTROLS_HOME = path.join(os.tmpdir(), 'a2ui5-no-corpus-here');
  process.env.A2UI5_HOME = path.join(os.tmpdir(), 'a2ui5-no-framework-here');
  try {
    for (const good of ['zcl_app_001', 'ycl_app', 'z2ui5_cl_my_app', 'zcx_error']) {
      assert.throws(
        () => deployApp({ className: good, source: source(good) }),
        /no dev sandbox/,
        `expected '${good}' to pass the name gate and stop at the sandbox`,
      );
    }
  } finally {
    for (const [k, v] of [['SAMPLES_CONTROLS_HOME', saved.corpus], ['A2UI5_HOME', saved.a2]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('deployApp rejects an over-long class name', () => {
  assert.throws(
    () => deployApp({ className: 'z2ui5_cl_' + 'a'.repeat(30), source: 'x' }),
    /invalid class name/,
  );
});

test('deployApp rejects source without z2ui5_if_app', () => {
  assert.throws(
    () => deployApp({ className: 'z2ui5_cl_demo', source: 'CLASS z2ui5_cl_demo DEFINITION.' }),
    /does not implement z2ui5_if_app/,
  );
});

test('deployApp rejects a class-name/source mismatch', () => {
  assert.throws(
    () =>
      deployApp({
        className: 'z2ui5_cl_demo',
        source: 'CLASS z2ui5_cl_other DEFINITION. INTERFACES z2ui5_if_app.',
      }),
    /does not define CLASS z2ui5_cl_demo DEFINITION/,
  );
});

// ------------------------------------------------- removeApp validation ----
// remove_app unlinks by name, so it validates the SAME way deploy does. A name
// carrying path separators must never reach the filesystem: it would resolve
// out of the src/zz_dev sandbox and delete real corpus sources. Rejection here
// is what makes that unreachable, so it is asserted rather than assumed.

test('removeApp rejects a name that would escape the dev sandbox', () => {
  assert.throws(
    () => removeApp('../../src/01/z2ui5_cl_smpc_app_001'),
    /invalid class name/,
  );
});

test('removeApp rejects the same names deployApp does', () => {
  for (const bad of ['acl_my_app', 'z2ui5_cl_' + 'a'.repeat(30), '', 'z2ui5_cl_a/b', 'zcl_a.b', 'zcl_a\\b', 'zcl a']) {
    assert.throws(() => removeApp(bad), /invalid class name/, `expected rejection for '${bad}'`);
  }
});

// ------------------------------------------------- readAppSource gate ----
// read_app reads by name, through the SAME gate deploy and remove use: a
// name carrying path separators must die as a name, never resolve as a path
// out of src/zz_dev into real corpus sources.

test('readAppSource rejects the names deployApp rejects', async () => {
  const { readAppSource } = await import('../lib/runtime.mjs');
  for (const bad of ['acl_my_app', '', '../../src/01/z2ui5_cl_smpc_app_001', '/etc/passwd', 'zcl_a.b', 'z2ui5_cl_' + 'a'.repeat(30)]) {
    assert.throws(() => readAppSource(bad), /invalid class name/, `expected rejection for '${bad}'`);
  }
});

/* The staleness half: a dev app deployed AFTER the last build is code
 * run_app does not serve yet, and the report has to say so. Fake corpus and
 * framework checkouts via the authoritative env vars. */
test('readAppSource reports the source and whether the built backend carries it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-readapp-'));
  const corpus = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(corpus, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'scripts', 'e2e-build.mjs'), '');
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');
  const saved = {};
  const wanted = { AI_DEMOKIT_HOME: corpus, SAMPLES_CONTROLS_HOME: '', A2UI5_HOME: a2 };
  for (const [k, v] of Object.entries(wanted)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { readAppSource } = await import('../lib/runtime.mjs');
    // nothing deployed yet: found false, and the path it looked at is named
    assert.equal(readAppSource('zcl_read_me').found, false);

    const src = 'CLASS zcl_read_me DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES z2ui5_if_app. ENDCLASS.';
    deployApp({ className: 'zcl_read_me', source: src });

    // no built backend: staleness is UNKNOWN, not fresh
    let r = readAppSource('zcl_read_me');
    assert.equal(r.found, true);
    assert.equal(r.source, src + '\n');
    assert.equal(r.staleInBackend, null);
    assert.equal(r.backendBuiltAt, null);

    // a build OLDER than the deploy: the backend does not carry this file
    fs.mkdirSync(path.join(a2, 'node', 'output'), { recursive: true });
    fs.writeFileSync(path.join(a2, 'node', 'output', 'init.mjs'), '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(a2, 'node', 'output', 'init.mjs'), old, old);
    r = readAppSource('zcl_read_me');
    assert.equal(r.staleInBackend, true);

    // a build NEWER than the deploy carries it
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(a2, 'node', 'output', 'init.mjs'), newer, newer);
    r = readAppSource('zcl_read_me');
    assert.equal(r.staleInBackend, false);
    assert.ok(r.backendBuiltAt);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* Widening the namespace must not widen what can be WRITTEN. Every one of
 * these is a name whose only purpose is to leave src/zz_dev, and each has to
 * die in the name gate rather than in path.join. */
test('a wider namespace is still no way out of the dev sandbox', () => {
  for (const escape of [
    '../../src/01/z2ui5_cl_smpc_app_001',
    'z2ui5_cl_x/../../../etc/passwd',
    '/etc/passwd',
    'zcl_app/../../x',
    'zcl_app .clas',
  ]) {
    assert.throws(() => deployApp({ className: escape, source: 'x' }), /invalid class name/, `deploy '${escape}'`);
    assert.throws(() => removeApp(escape), /invalid class name/, `remove '${escape}'`);
  }
});

// ------------------------------------------------------ mtime file cache ----

/* The live-read contract, made affordable: a parse is cached under
 * (path, mtimeMs, size), so an unchanged file costs a stat and a CHANGED file
 * - a git pull, an edit - invalidates itself. No TTL, no manual flush. */
test('readCached parses once per file version and re-parses on change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-cache-'));
  const file = path.join(dir, 'doc.md');
  try {
    fs.writeFileSync(file, 'one');
    let parses = 0;
    const parse = (text) => { parses++; return text.toUpperCase(); };
    assert.equal(readCached(file, parse), 'ONE');
    assert.equal(readCached(file, parse), 'ONE');
    assert.equal(parses, 1, 'an unchanged file is parsed once');

    // same size, different mtime - an edit that touched the timestamp
    fs.utimesSync(file, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    assert.equal(readCached(file, parse), 'ONE');
    assert.equal(parses, 2, 'a changed mtime invalidates');

    // changed content (size differs) with whatever mtime the write produced
    fs.writeFileSync(file, 'two three');
    assert.equal(readCached(file, parse), 'TWO THREE');
    assert.equal(parses, 3, 'changed content is re-parsed');
    assert.equal(readCached(file, parse), 'TWO THREE');
    assert.equal(parses, 3);

    // a file that cannot be statted throws what fs throws - the caller keeps
    // its own existsSync semantics, nothing broken lands in the cache
    assert.throws(() => readCached(path.join(dir, 'missing.md'), parse), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- BENIGN filter ----

test('the vendored BENIGN patterns match known console noise and not real errors', () => {
  const noise = LOCAL_BENIGN.some((re) => re.test('Failed to load resource: favicon.ico 404'));
  const real = LOCAL_BENIGN.some((re) => re.test("TypeError: Cannot read properties of undefined (reading 'getModel')"));
  assert.equal(noise, true); // known console noise is filtered
  assert.equal(real, false); // a real JS error is never swallowed
});

/* benignRules resolves the canonical list from the corpus PER CALL - it used
 * to be frozen at module load, so a corpus checked out after server start was
 * silently missed until a restart. */
test('benignRules reads the corpus list live and falls back to the vendored copy', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-benign-'));
  const corpus = path.join(base, 'ai-demokit');
  const saved = { demokit: process.env.AI_DEMOKIT_HOME, corpusHome: process.env.SAMPLES_CONTROLS_HOME };
  process.env.AI_DEMOKIT_HOME = corpus;
  process.env.SAMPLES_CONTROLS_HOME = '';
  try {
    // no corpus at all: the vendored copy applies
    assert.deepEqual(await benignRules(), LOCAL_BENIGN);
    // the corpus appears AFTER "server start" - no restart needed
    fs.mkdirSync(path.join(corpus, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(corpus, 'scripts', 'e2e-build.mjs'), '');
    assert.deepEqual(await benignRules(), LOCAL_BENIGN, 'a corpus without lib-smoke.mjs still answers');
    fs.writeFileSync(
      path.join(corpus, 'scripts', 'lib-smoke.mjs'),
      'export const BENIGN = [/canonical-noise/];',
    );
    const live = await benignRules();
    assert.equal(live.length, 1);
    assert.match('canonical-noise here', live[0]);
  } finally {
    if (saved.demokit === undefined) delete process.env.AI_DEMOKIT_HOME;
    else process.env.AI_DEMOKIT_HOME = saved.demokit;
    if (saved.corpusHome === undefined) delete process.env.SAMPLES_CONTROLS_HOME;
    else process.env.SAMPLES_CONTROLS_HOME = saved.corpusHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- repo naming ----

/* The corpus repository has been renamed twice — ai-demokit -> abap2UI5-api ->
 * samples-controls — and the linter once. Neither rename may break a working
 * install: a checkout sits in a directory named after whatever it was cloned
 * as, and an env var somebody set months ago keeps its name. Both lists are
 * newest-first, and the current name has to be the one a fresh setup gets. */
test('the corpus resolves under its current name and both former ones', () => {
  assert.equal(CORPUS_DIRS[0], 'samples-controls', 'a fresh clone must resolve first');
  for (const legacy of ['abap2UI5-api', 'ai-demokit']) {
    assert.ok(CORPUS_DIRS.includes(legacy), `${legacy} was a real directory name and must still resolve`);
  }
});

test('a corpus checkout is found through its directory name', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-repos-'));
  try {
    for (const dir of CORPUS_DIRS) {
      const home = path.join(base, dir);
      fs.mkdirSync(path.join(home, 'scripts'), { recursive: true });
      // the probe file resolveSamplesControls looks for
      fs.writeFileSync(path.join(home, 'scripts', 'e2e-build.mjs'), '');
      const found = execFileSync(process.execPath, ['-e',
        "import('./lib/repos.mjs').then(m => process.stdout.write(String(m.resolveSamplesControls())))"],
      { cwd: ROOT, env: { ...process.env, SAMPLES_CONTROLS_HOME: home }, encoding: 'utf8' });
      assert.equal(found, home, `${dir} must resolve when pointed at explicitly`);
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the former env var still points the server at the corpus', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-legacyenv-'));
  try {
    fs.mkdirSync(path.join(home, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(home, 'scripts', 'e2e-build.mjs'), '');
    const found = execFileSync(process.execPath, ['-e',
      "import('./lib/repos.mjs').then(m => process.stdout.write(String(m.resolveSamplesControls())))"],
    { cwd: ROOT, env: { ...process.env, SAMPLES_CONTROLS_HOME: '', AI_DEMOKIT_HOME: home }, encoding: 'utf8' });
    assert.equal(found, home, 'AI_DEMOKIT_HOME must keep working — it is in existing MCP client configs');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* A probe file that two repositories both generate proves nothing. `samples`
 * and `samples-stack` both commit SAMPLES.md, so a SAMPLES_HOME pointing at
 * one used to resolve cheerfully as the other and every answer came from the
 * wrong catalogue; the linter probe was a bare package.json, so any Node
 * project in a directory called `linter` resolved as the linter and failed
 * later, inside importViewCheck, with "does not export '.'" - which reads as
 * an out-of-date linter rather than as "that is not a linter checkout".
 *
 * What the identity checks must NOT do is break an old checkout: they are
 * skipped where the file they name is absent, which is the shape a checkout
 * from before catalogue.json has. */
const resolvedWith = (fn, env) => execFileSync(
  process.execPath,
  ['-e', `import('./lib/repos.mjs').then(m => process.stdout.write(String(m.${fn}())))`],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      // every candidate the guess would otherwise find, silenced
      SAMPLES_HOME: '', SAMPLES_STACK_HOME: '', AI_VIEW_CHECK_HOME: '', ...env,
    },
    encoding: 'utf8',
  },
);

function fakeCheckout(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-ident-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('a catalogue checkout is identified, not just probed for SAMPLES.md', () => {
  const stack = fakeCheckout({
    'SAMPLES.md': '# samples-stack',
    'catalogue.json': { repo: 'abap2UI5/samples-stack', samples: [] },
    'package.json': { name: 'abap2ui5-samples-stack' },
  });
  const samples = fakeCheckout({
    'SAMPLES.md': '# samples',
    'catalogue.json': { repository: 'abap2UI5/samples', samples: [] },
    'package.json': { name: 'abap2UI5-samples' },
  });
  // the shape a checkout from before catalogue.json existed has
  const old = fakeCheckout({ 'SAMPLES.md': '# samples' });
  try {
    assert.equal(resolvedWith('resolveSamples', { SAMPLES_HOME: samples }), samples);
    assert.equal(resolvedWith('resolveSamplesStack', { SAMPLES_STACK_HOME: stack }), stack);
    assert.equal(resolvedWith('resolveSamples', { SAMPLES_HOME: stack }), 'null',
      'a samples-stack checkout must not answer as samples');
    assert.equal(resolvedWith('resolveSamplesStack', { SAMPLES_STACK_HOME: samples }), 'null',
      'nor the other way round');
    assert.equal(resolvedWith('resolveSamples', { SAMPLES_HOME: old }), old,
      'a checkout with nothing but the page still resolves - the checks only ever rule OUT');
  } finally {
    for (const d of [stack, samples, old]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a linter checkout is identified by its exports map, not by having a package.json', () => {
  const linter = fakeCheckout({
    'package.json': {
      name: '@abap2ui5/linter',
      exports: { '.': './lib/index.mjs', './findings': './lib/findings.mjs', './config': './lib/config.mjs' },
    },
  });
  const notTheLinter = fakeCheckout({ 'package.json': { name: 'some-other-tool', exports: { '.': './index.js' } } });
  const noExports = fakeCheckout({ 'package.json': { name: 'anything', main: 'index.js' } });
  try {
    assert.equal(resolvedWith('resolveViewCheck', { AI_VIEW_CHECK_HOME: linter }), linter);
    assert.equal(resolvedWith('resolveViewCheck', { AI_VIEW_CHECK_HOME: notTheLinter }), 'null',
      'an exports map without the linter entries is not a linter checkout');
    assert.equal(resolvedWith('resolveViewCheck', { AI_VIEW_CHECK_HOME: noExports }), 'null',
      'and neither is a package.json with no exports map at all');
  } finally {
    for (const d of [linter, notTheLinter, noExports]) fs.rmSync(d, { recursive: true, force: true });
  }
});

/* Two repositories are named `docs` - abap2UI5/docs and cap2UI5/docs - and
 * both carry the probe file docs/index.md, so a workspace with the WRONG one
 * checked out as ../docs used to resolve it and hand back
 * abap2ui5.github.io URLs that do not exist. The package name tells them
 * apart; a checkout from before package.json existed still resolves, because
 * identify checks only ever rule OUT. */
test('a docs checkout is identified as the abap2UI5 site, not any tree with docs/index.md', () => {
  const mkDocs = (pkg) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-docs-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'index.md'), '# home\n');
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  };
  const ours = mkDocs({ name: 'abap2ui5-docs' });
  const capDocs = mkDocs({ name: 'cap2ui5-docs' });
  const old = mkDocs(null);
  try {
    assert.equal(resolvedWith('resolveDocs', { DOCS_HOME: ours }), ours);
    assert.equal(resolvedWith('resolveDocs', { DOCS_HOME: capDocs }), 'null',
      'the cap2UI5 docs site must not answer as the abap2UI5 docs');
    assert.equal(resolvedWith('resolveDocs', { DOCS_HOME: old }), old,
      'a checkout with no package.json still resolves - the checks only ever rule OUT');
  } finally {
    for (const d of [ours, capDocs, old]) fs.rmSync(d, { recursive: true, force: true });
  }
});

/* The exports map IS the contract with the linter (AGENTS.md: internal
 * file-layout refactors there are safe, a removed or renamed export breaks a
 * tool here while the linter's own tests stay green) - and the resolution of
 * that map had no test at all. Node accepts two shapes for a target, a plain
 * path and a conditional-exports object, and both reach this repo: the linter
 * publishes `{ types, default }` today and published a bare string before that.
 * A third case matters as much - an entry that is not there - because that is
 * what an OLDER checkout looks like, and it has to say so by name rather than
 * failing on an undefined path. */
test('importViewCheck resolves both export shapes and names a missing entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-exports-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'index.mjs'), 'export const which = "root";\n');
  fs.writeFileSync(path.join(dir, 'lib', 'findings.mjs'), 'export const which = "findings";\n');
  fs.writeFileSync(path.join(dir, 'lib', 'config.mjs'), 'export const which = "config";\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@abap2ui5/linter',
    exports: {
      // a plain string target, the shape the linter published first
      '.': './lib/index.mjs',
      // conditional exports, the shape it publishes now
      './findings': { types: './types.d.ts', default: './lib/findings.mjs' },
      // and one where `import` wins over `default`, as Node resolves it
      './config': { import: './lib/config.mjs', default: './lib/index.mjs' },
      // an entry with no runtime target at all: types only
      './rule-docs': { types: './types.d.ts' },
    },
  }));
  const saved = process.env.AI_VIEW_CHECK_HOME;
  process.env.AI_VIEW_CHECK_HOME = dir;
  try {
    const { importViewCheck } = await import('../lib/repos.mjs');
    assert.equal((await importViewCheck('.')).which, 'root');
    assert.equal((await importViewCheck('./findings')).which, 'findings');
    assert.equal((await importViewCheck('./config')).which, 'config',
      'the import condition wins over default, the way Node resolves it');

    // an older checkout: the tool has to say WHICH export and WHERE, because
    // the remedy is a git pull in that other repository
    await assert.rejects(
      () => importViewCheck('./screenshot'),
      (e) => /does not export '\.\/screenshot'/.test(e.message) && e.message.includes(dir),
    );
    await assert.rejects(() => importViewCheck('./rule-docs'), /does not export '\.\/rule-docs'/,
      'an entry with only a types target is no more importable than a missing one');
  } finally {
    if (saved === undefined) delete process.env.AI_VIEW_CHECK_HOME;
    else process.env.AI_VIEW_CHECK_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importViewCheck answers null without a linter checkout, rather than throwing', async () => {
  const saved = process.env.AI_VIEW_CHECK_HOME;
  process.env.AI_VIEW_CHECK_HOME = path.join(os.tmpdir(), 'a2ui5-no-linter-here');
  try {
    const { importViewCheck } = await import('../lib/repos.mjs');
    assert.equal(await importViewCheck('.'), null,
      'the caller turns null into the actionable missing-checkout message');
  } finally {
    if (saved === undefined) delete process.env.AI_VIEW_CHECK_HOME;
    else process.env.AI_VIEW_CHECK_HOME = saved;
  }
});

// ------------------------------------------------------------- pitfalls ----

/* The two catalogues are markdown maintained in the abap2UI5 repo, so what is
 * testable here is the slicing, not the content: sections stay whole (a case
 * without its evidence and its fix is worth nothing), and a query narrows to
 * the sections that carry every term. */
const CATALOGUE = `---
name: ui5-check
description: front matter the agent should never see
---

# What a green CI does not prove

The floor is OpenUI5 1.71.

## 1. Names the target release does not have

An unknown sap-icon:// name renders nothing and logs nothing.

## 2. Layout that only works from a newer release on

ToolbarSpacer inside a sap.m.Bar deletes every sibling after it.
`;

test('pitfalls: the front matter is stripped and the preamble survives as a section', () => {
  const secs = sliceCatalogue(CATALOGUE);
  assert.ok(!JSON.stringify(secs).includes('front matter the agent should never see'),
    'skill front matter is plumbing, not content');
  assert.equal(secs[0].heading, '(preamble)');
  assert.match(secs[0].body, /floor is OpenUI5 1\.71/, 'the preamble says how to read the rest — keep it');
});

test('pitfalls: a query narrows to whole sections that carry every term', () => {
  const secs = sliceCatalogue(CATALOGUE, 'icon');
  assert.equal(secs.length, 1);
  assert.match(secs[0].heading, /^1\. Names/);
  assert.match(secs[0].body, /renders nothing and logs nothing/, 'the section comes back WHOLE');
  assert.equal(sliceCatalogue(CATALOGUE, 'toolbar bar').length, 1, 'both terms must match, in any order');
  assert.equal(sliceCatalogue(CATALOGUE, 'icon toolbar').length, 0,
    'terms from two different sections match neither');
});

// ----------------------------------------------------- resolveLintConfig ----

/* A stand-in for the linter's findConfigFrom: answers for the directories the
 * fake tree has a config in, null everywhere else. */
const finder = (...withConfig) => (dir) => (withConfig.includes(dir) ? `${dir}/abap2ui5lint.jsonc` : null);

test('a named project decides which config validate_view uses', () => {
  const find = finder('/home/me/app', '/cwd', '/corpus');
  assert.equal(
    resolveLintConfig(find, { projectDir: '/home/me/app', cwd: '/cwd', corpus: '/corpus' }),
    '/home/me/app/abap2ui5lint.jsonc',
  );
});

test('a named project without a config gets defaults, not the corpus config', () => {
  // the regression this argument exists for: an app in someone else's
  // repository was judged by samples-controls' rules with no way to say no
  const find = finder('/corpus', '/cwd');
  assert.equal(
    resolveLintConfig(find, { projectDir: '/home/me/app', cwd: '/cwd', corpus: '/corpus' }),
    null,
    'the caller pointed somewhere - a config from elsewhere is not an answer',
  );
});

test('unnamed falls back to the working directory before the corpus', () => {
  const find = finder('/cwd', '/corpus');
  assert.equal(
    resolveLintConfig(find, { cwd: '/cwd', corpus: '/corpus' }),
    '/cwd/abap2ui5lint.jsonc',
  );
});

test('the corpus config still applies when nothing else has one', () => {
  // porting inside samples-controls keeps working exactly as before
  const find = finder('/corpus');
  assert.equal(
    resolveLintConfig(find, { cwd: '/somewhere/else', corpus: '/corpus' }),
    '/corpus/abap2ui5lint.jsonc',
  );
});

test('no config anywhere is null, not a throw', () => {
  assert.equal(resolveLintConfig(finder(), { cwd: '/x' }), null);
});

/* The sample catalogue as a query surface. Parsed from a literal here rather
 * than from the checkout, so the shape SAMPLES.md promises is asserted even
 * where the sibling repository is not present. */
const SAMPLES_MD = [
  '# The sample catalogue',
  '',
  '## Basics',
  '',
  '| Sample | Class |',
  '|---|---|',
  '| **Basics I** — Hello World, the Smallest App<br><sub>hello world minimal start here</sub> | [`Z2UI5_CL_SMP_APP_493`](src/01/z2ui5_cl_smp_app_493.clas.abap) |',
  '',
  '## Popup',
  '',
  '| Sample | Class |',
  '|---|---|',
  '| Value Help: Suggestions and F4 Dialog<br><sub>f4 search help suggestion input</sub><br><sub>docs: [cookbook/expert_more/value_help](https://abap2ui5.github.io/docs/cookbook/expert_more/value_help)</sub> | [`Z2UI5_CL_SMP_APP_009`](src/01/z2ui5_cl_smp_app_009.clas.abap) |',
  '| Navigation — app state<br><sub>bookmark restore url</sub> | [`Z2UI5_CL_SMP_APP_321`](src/00/97/z2ui5_cl_smp_app_321.clas.abap) |',
].join('\n');

test('the sample catalogue parses into pointers, with and without a row header', () => {
  const all = parseExamples(SAMPLES_MD);
  assert.equal(all.length, 3);

  const basics = all.find((e) => e.cls === 'Z2UI5_CL_SMP_APP_493');
  assert.equal(basics.title, 'Basics I');
  assert.equal(basics.sub, 'Hello World, the Smallest App');
  assert.equal(basics.label, 'Basics I — Hello World, the Smallest App');
  assert.equal(basics.path, 'src/01/z2ui5_cl_smp_app_493.clas.abap');
  assert.equal(basics.area, 'samples');

  /* generate-samples-md drops a header that would repeat its section, so this
   * row has none. `title` then falls back to the section, which reads wrong on
   * its own ("Popup") - the LABEL must not inherit that fallback, or every
   * such sample would be announced by its section instead of by what it does. */
  const f4 = all.find((e) => e.cls === 'Z2UI5_CL_SMP_APP_009');
  assert.equal(f4.title, 'Popup');
  assert.equal(f4.label, 'Value Help: Suggestions and F4 Dialog');

  // src/00 is experimental or a test app: readable, not to be copied wholesale
  assert.equal(all.find((e) => e.cls === 'Z2UI5_CL_SMP_APP_321').area, 'experimental-or-test');
});

/* The catalogue is generated over in abap2UI5/samples and grew a second block of
 * small type - the `@docs` chapter links - under the keywords. A parser that
 * expected exactly one would match no rows at all, and the failure mode is the
 * quiet one: `examples` would answer "nothing found" for every query instead of
 * raising anything. */
test('a row keeps parsing when the catalogue adds another block of small type', () => {
  const f4 = parseExamples(SAMPLES_MD).find((e) => e.cls === 'Z2UI5_CL_SMP_APP_009');
  assert.equal(f4.label, 'Value Help: Suggestions and F4 Dialog');
  // and the docs link is not mistaken for a search term
  assert.equal(f4.keywords, 'f4 search help suggestion input');
  assert.equal(searchExamples({ query: 'f4', rawText: SAMPLES_MD }).length, 1);
  assert.equal(searchExamples({ query: 'cookbook', rawText: SAMPLES_MD }).length, 0);
});

/* The catalogues grew a SECOND kind of block under the title - the summary
 * sentence, in normal type rather than in <sub> - and the parser has to keep
 * the two apart. Mistaking the sentence for the search terms would rank every
 * sample by prose it did not choose to be found by; mistaking the terms for
 * the sentence would put "f4 search help suggestion input" where a human reads
 * a description. */
const SAMPLES_MD_WITH_SUMMARY = [
  '## Popup',
  '',
  '| Sample | Class |',
  '|---|---|',
  '| Value Help: Suggestions and F4 Dialog<br>The value help, both halves: suggestions while typing and the F4 dialog behind the field.<br><sub>f4 search help suggestion input</sub><br><sub>docs: [cookbook/expert_more/value_help](https://abap2ui5.github.io/docs/cookbook/expert_more/value_help)</sub> | [`Z2UI5_CL_SMP_APP_009`](src/01/z2ui5_cl_smp_app_009.clas.abap) |',
].join('\n');

test('the summary sentence and the search terms are told apart', () => {
  const [e] = parseExamples(SAMPLES_MD_WITH_SUMMARY);
  assert.equal(e.summary, 'The value help, both halves: suggestions while typing and the F4 dialog behind the field.');
  assert.equal(e.keywords, 'f4 search help suggestion input');
  assert.equal(e.label, 'Value Help: Suggestions and F4 Dialog');

  // the sentence is searchable, and a hit in it ranks BELOW a keyword hit
  assert.equal(searchExamples({ query: 'typing', rawText: SAMPLES_MD_WITH_SUMMARY }).length, 1);
  // the docs block is still not a search term
  assert.equal(searchExamples({ query: 'cookbook', rawText: SAMPLES_MD_WITH_SUMMARY }).length, 0);
});

/* A row that has NO summary yet must keep parsing: the three repositories add
 * the line at their own pace, and a parser that required it would answer
 * "nothing found" for a whole catalogue rather than fail loudly. */
test('a row without a summary still parses', () => {
  const e = parseExamples(SAMPLES_MD).find((x) => x.cls === 'Z2UI5_CL_SMP_APP_009');
  assert.equal(e.summary, '');
  assert.equal(e.keywords, 'f4 search help suggestion input');
});

/* The row shape is maintained in three OTHER repositories, and a new kind of
 * block has twice made every row unmatchable here. A block whose tag this
 * parser has never seen must cost it nothing - the sample still has to be
 * findable, because "no rows parsed" reads as "there are no samples for that"
 * rather than as a parse error. */
test('a row survives a block this parser has never seen', () => {
  const md = [
    '## Basics',
    '',
    '| Sample | Class |',
    '|---|---|',
    '| **Future** — Something<br>The sentence.<br><span>a block from a later generator</span><br><sub>terms here</sub> | [`Z2UI5_CL_SMP_APP_999`](src/01/z2ui5_cl_smp_app_999.clas.abap) |',
  ].join('\n');
  const [e] = parseExamples(md);
  assert.ok(e, 'the row with an unknown block was dropped');
  assert.equal(e.cls, 'Z2UI5_CL_SMP_APP_999');
  // and the two blocks this parser DOES read are still told apart correctly
  assert.equal(e.summary, 'The sentence.');
  assert.equal(e.keywords, 'terms here');
});

test('every catalogue names its repository and its env var when it is missing', () => {
  assert.deepEqual(CATALOGUES.map((c) => c.repo), ['samples', 'samples-controls', 'samples-stack']);
  for (const c of CATALOGUES) {
    assert.match(c.url, /^https:\/\/github\.com\/abap2UI5\//);
    assert.match(c.env, /_HOME$/);
  }
});

test('searching the catalogue narrows on every term and ranks a keyword hit first', () => {
  const q = (query, opts = {}) => searchExamples({ query, rawText: SAMPLES_MD, ...opts }).map((e) => e.cls);

  assert.deepEqual(q('f4 search'), ['Z2UI5_CL_SMP_APP_009']);
  // AND, not OR: a second term that matches nothing removes the hit
  assert.deepEqual(q('f4 tree'), []);

  /* "help" is in app 009's keywords and in nothing else; "popup" is the
   * SECTION both share. Ranked, so the one that chose the word comes first -
   * and the weaker match is still returned, because it may be the only one. */
  const both = q('popup');
  assert.equal(both.length, 2);

  assert.deepEqual(q('bookmark', { area: 'samples' }), []);
  assert.deepEqual(q('bookmark', { area: 'experimental-or-test' }), ['Z2UI5_CL_SMP_APP_321']);
});

/* abap2UI5/samples flattened src/01 and src/00 into one `src/` package
 * (2026-09-22). The area used to be read off src/01, so every sample of a
 * current checkout was filed as experimental-or-test and `area: samples` -
 * the filter the description recommends - answered nothing. src/00 decides. */
test('a sample in the flat src/ package is the supported set, not experimental-or-test', () => {
  const flat = [
    '## Basics',
    '',
    '| **Basics I** — Hello World<br><sub>hello world</sub> | [`Z2UI5_CL_SMP_APP_493`](src/z2ui5_cl_smp_app_493.clas.abap) |',
  ].join('\n');
  assert.equal(parseExamples(flat)[0].area, 'samples');
  assert.deepEqual(searchExamples({ query: 'hello', area: 'samples', rawText: flat }).map((e) => e.cls), ['Z2UI5_CL_SMP_APP_493']);
  assert.deepEqual(searchExamples({ query: 'hello', area: 'experimental-or-test', rawText: flat }), []);
  // the JSON adapter too: samples' catalogue.json names the flat paths
  const [json] = searchExamples({
    area: 'samples',
    rawCatalogue: { samples: [{ class: 'z2ui5_cl_smp_app_540', file: 'src/z2ui5_cl_smp_app_540.clas.abap', category: 'AI', title: 'AI' }] },
  });
  assert.equal(json.cls, 'Z2UI5_CL_SMP_APP_540');
  assert.equal(json.area, 'samples');
});

/* The `docs:` block is a per-sample list of the cookbook chapters somebody
 * decided that app is the worked example of - and this parser knew it only
 * well enough to SKIP it while looking for the keywords. So the agent got a
 * class to read and no way to reach the prose explaining what it demonstrates,
 * which is the half a human reviewer opens first. */
test('the docs links reach the caller instead of being skipped', () => {
  const [e] = parseExamples(SAMPLES_MD_WITH_SUMMARY);
  assert.deepEqual(e.docs, [{
    topic: 'cookbook/expert_more/value_help',
    url: 'https://abap2ui5.github.io/docs/cookbook/expert_more/value_help',
  }]);
  // several links in one block, as `samples` writes them
  const md = SAMPLES_MD_WITH_SUMMARY.replace(
    '<sub>docs: [cookbook/expert_more/value_help](https://abap2ui5.github.io/docs/cookbook/expert_more/value_help)</sub>',
    '<sub>docs: [a/b](https://x/a/b), [c/d](https://x/c/d)</sub>',
  );
  assert.deepEqual(parseExamples(md)[0].docs.map((d) => d.topic), ['a/b', 'c/d']);
  // a row without the block says so with an empty list, never undefined
  assert.deepEqual(parseExamples(SAMPLES_MD).find((x) => x.cls === 'Z2UI5_CL_SMP_APP_321').docs, []);
});

/* samples-controls writes the whole row header in bold with nothing after it,
 * and the row pattern required a dash after the bold half. So 430 of the 614
 * apps - the entire demo-kit catalogue - parsed as rows with NO header of their
 * own: `title` fell back to the section, and every port announced itself as the
 * LIBRARY it belongs to ("sap.m", 109 times over) while the control an agent
 * asked for survived only inside the keyword blob. */
test('a bold row header without a dash after it is still the title', () => {
  const md = [
    '### sap.m',
    '',
    '| Sample | Class |',
    '|---|---|',
    '| **sap.m.Bar**<br>Each screen is typically a Page with a header.<br><sub>bar sap.m header</sub> | [`Z2UI5_CL_SMPC_APP_002`](src/01/01/z2ui5_cl_smpc_app_002.clas.abap) |',
  ].join('\n');
  const [e] = parseExamples(md, 'samples-controls');
  assert.equal(e.title, 'sap.m.Bar');
  assert.equal(e.label, 'sap.m.Bar', 'the label must name the control, not the library');
  assert.equal(e.sub, '', 'nothing follows the header, so there is no sub-title - and no stray asterisks');
  assert.equal(e.section, 'sap.m');
  assert.equal(e.summary, 'Each screen is typically a Page with a header.');

  // and the dashed shape the other two catalogues use is untouched
  const [dashed] = parseExamples(SAMPLES_MD_WITH_SUMMARY);
  assert.equal(dashed.label, 'Value Help: Suggestions and F4 Dialog');
});

/* The committed catalogue.json each sample repository carries now - richer
 * than the page (verification status, deviations, the learning-path stage,
 * what a stack sample needs) and DIFFERENT per repository, so each shape is
 * pinned by its own fixture. The adapters must fold all three into the entry
 * shape the row parser produces: one search, one ranking, one result shape
 * regardless of which file a checkout has. */

const CAT_SAMPLES = {
  samples: [
    {
      class: 'z2ui5_cl_smp_app_493',
      file: 'src/01/z2ui5_cl_smp_app_493.clas.abap',
      category: 'Basics',
      stage: 'start',
      title: 'Basics I',
      description: 'Hello World, the Smallest App',
      summary: 'The smallest app that runs.',
      keywords: ['hello', 'world', 'minimal'],
      docs: ['https://abap2ui5.github.io/docs/get_started/hello_world'],
    },
    {
      class: 'z2ui5_cl_smp_app_454',
      file: 'src/01/z2ui5_cl_smp_app_454.clas.abap',
      category: 'List',
      stage: 'rows',
      title: 'List', // === category: the page drops such a header, so must the label
      description: 'Filter and Sort the Binding from ABAP',
      summary: 'Sorts a bound list from ABAP.',
      keywords: ['sorter', 'filter'],
      docs: [],
    },
  ],
};

const CAT_CONTROLS = {
  ports: [
    {
      class: 'z2ui5_cl_smpc_app_003',
      file: 'src/01/01/z2ui5_cl_smpc_app_003.clas.abap',
      category: 'src/01',
      library: 'sap.m',
      sample: 'sap.m.sample.Breadcrumbs',
      entity: 'sap.m.Breadcrumbs',
      title: 'Breadcrumbs sample',
      summary: 'Breadcrumbs displays a link hierarchy.',
      keywords: 'breadcrumbs sap.m trail', // one string here, not an array
      status: 'checked',
      deviations: ['NOTE'],
    },
    {
      class: 'z2ui5_cl_smpc_sapui5_001',
      file: 'src/03/z2ui5_cl_smpc_sapui5_001.clas.abap',
      category: 'src/03',
      library: 'sap.suite.ui.microchart',
      sample: '',
      entity: '', // the src/03 collection has no demo-kit original
      title: 'sap.suite.ui.microchart - InteractiveDonutChart',
      summary: 'A SAPUI5-only control, orientation rather than a 1:1 port.',
      keywords: 'interactivedonutchart',
      status: 'collection',
      deviations: [],
    },
  ],
};

const CAT_STACK = {
  samples: [
    {
      class: 'Z2UI5_CL_SMPS_APP_315',
      path: 'src/01/z2ui5_cl_smps_app_315.clas.abap',
      package: 'src/01',
      technology: 'OData',
      title: 'Two Models in One View',
      summary: 'one table bound to each',
      keywords: ['odata', 'model'],
      needs: 'an activated OData V2 service',
    },
  ],
};

test('samples catalogue.json adapts to the row shape, stage and docs included', () => {
  const [hello, list] = catalogueEntries(CAT_SAMPLES, 'samples');
  assert.equal(hello.cls, 'Z2UI5_CL_SMP_APP_493', 'the class name is upper-cased like the page renders it');
  assert.equal(hello.section, 'Basics');
  assert.equal(hello.label, 'Basics I — Hello World, the Smallest App');
  assert.equal(hello.keywords, 'hello world minimal', 'array keywords become the one searchable string');
  assert.equal(hello.area, 'samples');
  assert.equal(hello.stage, 'start');
  // a bare URL becomes the { topic, url } pair the row parser returns
  assert.deepEqual(hello.docs, [{
    topic: 'get_started/hello_world',
    url: 'https://abap2ui5.github.io/docs/get_started/hello_world',
  }]);
  // a title that just repeats its category must not lead the label -
  // the page drops such a header and the two paths have to agree
  assert.equal(list.label, 'Filter and Sort the Binding from ABAP');
  assert.equal(list.title, 'List');
});

test('samples-controls catalogue.json leads with the entity and keeps the verification status', () => {
  const [bc, donut] = catalogueEntries(CAT_CONTROLS, 'samples-controls');
  // the entity is what an agent asks for - and unlike the SAMPLES.md rows,
  // the JSON carries it for every port
  assert.equal(bc.title, 'sap.m.Breadcrumbs');
  assert.equal(bc.label, 'sap.m.Breadcrumbs — Breadcrumbs sample');
  assert.equal(bc.section, 'sap.m');
  assert.equal(bc.status, 'checked');
  assert.deepEqual(bc.deviations, ['NOTE']);
  assert.equal(bc.area, 'samples-controls');
  // src/03 has no entity: the title already names the control
  assert.equal(donut.title, 'sap.suite.ui.microchart - InteractiveDonutChart');
  assert.equal(donut.status, 'collection');
  assert.equal(donut.deviations, undefined, 'an empty deviation list is omitted, not shipped');
});

test('samples-stack catalogue.json exposes technology and what the system must provide', () => {
  const [e] = catalogueEntries(CAT_STACK, 'samples-stack');
  assert.equal(e.cls, 'Z2UI5_CL_SMPS_APP_315');
  assert.equal(e.section, 'OData');
  assert.equal(e.technology, 'OData');
  assert.equal(e.needs, 'an activated OData V2 service');
  assert.equal(e.label, 'Two Models in One View');
  assert.equal(e.area, 'samples-stack');
});

/* The fallback contract: anything that is not that repository's catalogue -
 * a truncated file, a foreign JSON, a future shape - answers null so the
 * caller reads SAMPLES.md instead. An empty ARRAY is not null: that is a
 * catalogue asserting there are no samples. */
test('a JSON that is not the catalogue answers null, never a throw', () => {
  for (const bad of [null, 'text', 42, [], {}, { samples: 'not-a-list' }, { ports: {} }]) {
    assert.equal(catalogueEntries(bad, 'samples'), null, JSON.stringify(bad));
  }
  assert.equal(catalogueEntries({ samples: [] }, 'samples')?.length, 0);
  // a damaged entry inside an otherwise healthy list is skipped, not fatal
  const some = catalogueEntries({ samples: [null, 'x', {}, CAT_SAMPLES.samples[0]] }, 'samples');
  assert.equal(some.length, 1);
});

test('a verified port outranks an unverified one when the relevance ties', () => {
  /* Same keyword hit on every port, statuses deliberately in the wrong order
   * in the file - between two equally relevant ports, the one a human has
   * watched run is the better class to copy from. */
  const mixed = {
    ports: ['generated', 'checked', 'reviewed'].map((status, i) => ({
      class: `z2ui5_cl_smpc_app_00${i}`,
      file: `src/01/01/z2ui5_cl_smpc_app_00${i}.clas.abap`,
      category: 'src/01',
      library: 'sap.m',
      entity: `sap.m.Gadget${i}`,
      title: `Gadget ${i}`,
      summary: 'a gadget',
      keywords: 'gadget sap.m',
      status,
      deviations: [],
    })),
  };
  const hits = searchExamples({ query: 'gadget', repo: 'samples-controls', rawCatalogue: mixed });
  assert.deepEqual(hits.map((e) => e.status), ['checked', 'reviewed', 'generated']);
  /* Ranked, not filtered: the status only breaks ties. A query that names
   * the unverified port still finds it - and finds it first. */
  const named = searchExamples({ query: 'gadget0', repo: 'samples-controls', rawCatalogue: mixed });
  assert.equal(named[0].title, 'sap.m.Gadget0');
  assert.equal(named[0].status, 'generated');
});

/* catalogue-derived.json (samples-controls, samples) lists every control
 * type a sample's view BUILDS. The catalogue's own words name what a port is
 * filed under, so "sap.m.Dialog" found 7 of the 33 ports that build one. A
 * term found among the built controls matches too, ranks below one found in
 * the catalogue's words, and the hit names what it was found by. */
test('examples finds a sample by a control its view builds (catalogue-derived.json)', () => {
  const cat = {
    ports: [
      { class: 'z2ui5_cl_smpc_app_001', file: 'src/01/01/z2ui5_cl_smpc_app_001.clas.abap', library: 'sap.m', entity: 'sap.m.Dialog', title: 'Dialog', summary: 'a dialog', keywords: 'dialog sap.m', status: 'generated' },
      { class: 'z2ui5_cl_smpc_app_002', file: 'src/01/01/z2ui5_cl_smpc_app_002.clas.abap', library: 'sap.m', entity: 'sap.m.PlanningCalendar', title: 'Planning Calendar', summary: 'appointments', keywords: 'planningcalendar sap.m', status: 'checked' },
      { class: 'z2ui5_cl_smpc_app_003', file: 'src/01/01/z2ui5_cl_smpc_app_003.clas.abap', library: 'sap.m', entity: 'sap.m.Bar', title: 'Bar', summary: 'a bar', keywords: 'bar sap.m', status: 'checked' },
    ],
  };
  const derived = {
    controls: ['sap.m.Dialog', 'sap.m.Button', 'sap.m.PlanningCalendar', 'sap.m.Bar'],
    ports: [
      { class: 'z2ui5_cl_smpc_app_001', controls: [0, 1] },
      { class: 'z2ui5_cl_smpc_app_002', controls: [2, 0, 1] },
      { class: 'z2ui5_cl_smpc_app_003', controls: [3] },
    ],
  };
  const q = (query, rawDerived = derived) => searchExamples({ query, repo: 'samples-controls', rawCatalogue: cat, rawDerived });
  // without the derived file: only the port whose catalogue words say so
  assert.deepEqual(q('sap.m.Dialog', null).map((e) => e.cls), ['Z2UI5_CL_SMPC_APP_001']);
  // with it: the calendar that builds a Dialog too, ranked below the port about one
  const hits = q('sap.m.Dialog');
  assert.deepEqual(hits.map((e) => e.cls), ['Z2UI5_CL_SMPC_APP_001', 'Z2UI5_CL_SMPC_APP_002']);
  assert.deepEqual(hits[1].builds, ['sap.m.Dialog'], 'the hit names the control it was found by');
  // AND across both halves: a catalogue word and a built control
  assert.deepEqual(q('appointments button').map((e) => e.cls), ['Z2UI5_CL_SMPC_APP_002']);
  // the full control list never travels in the answer
  assert.ok(!JSON.stringify(q('bar')).includes('PlanningCalendar'), 'only the matched controls are named');
  assert.equal(JSON.stringify(q('appointments')[0]).includes('builds'), false, 'a hit not found by a control names none');
  // a hit whose catalogue words carry every term names no `builds`, even
  // when its view builds a match: the field says what a hit was found BY
  assert.equal(q('sap.m.Dialog')[0].builds, undefined, 'the Dialog port was found by its own words');
  // the samples shape keys its list `samples`; anything else is no derived file
  assert.equal(derivedControls({ controls: ['sap.m.Table'], samples: [{ class: 'z2ui5_cl_smp_app_001', controls: [0] }] }).get('Z2UI5_CL_SMP_APP_001')[0], 'sap.m.Table');
  for (const bad of [null, {}, { controls: 'x' }, { controls: [] }, { controls: [], ports: 'x' }]) assert.equal(derivedControls(bad), null, JSON.stringify(bad));
});

/* A hit found in the catalogue's own words for EVERY term ranks above one
 * that needed the built controls for a term - whatever their keyword hits.
 * The keyword score came first, so a port with "dialog" among its keywords
 * that merely builds a Select outranked one whose words carry both terms:
 * "select dialog" moved a match of the catalogue's words off the first
 * page. The catalogue-word matches keep the order they had without the
 * derived file, and the rest follow. */
test('examples ranks every match in the catalogue\'s own words above one that needed the built controls', () => {
  const cat = {
    ports: [
      { class: 'z2ui5_cl_smpc_app_011', file: 'src/a.clas.abap', library: 'sap.m', entity: 'sap.m.Panel', title: 'Panel', summary: 'select a dialog option', keywords: 'panel', status: 'generated' },
      { class: 'z2ui5_cl_smpc_app_012', file: 'src/b.clas.abap', library: 'sap.m', entity: 'sap.m.Dialog', title: 'Dialog', summary: 'a dialog', keywords: 'dialog popup', status: 'checked' },
    ],
  };
  const derived = { controls: ['sap.m.Select', 'sap.m.Dialog'], ports: [{ class: 'z2ui5_cl_smpc_app_011', controls: [0] }, { class: 'z2ui5_cl_smpc_app_012', controls: [0, 1] }] };
  const without = searchExamples({ query: 'select dialog', repo: 'samples-controls', rawCatalogue: cat }).map((e) => e.cls);
  assert.deepEqual(without, ['Z2UI5_CL_SMPC_APP_011']);
  const hits = searchExamples({ query: 'select dialog', repo: 'samples-controls', rawCatalogue: cat, rawDerived: derived });
  assert.deepEqual(hits.map((e) => e.cls), ['Z2UI5_CL_SMPC_APP_011', 'Z2UI5_CL_SMPC_APP_012'], 'the catalogue-word match first, as without the derived file');
  assert.equal(hits[0].builds, undefined);
  assert.deepEqual(hits[1].builds, ['sap.m.Select'], 'only the control the hit needed - not the Dialog its words already name');
});

/* Which FILE answers, pinned against a checkout on disk: catalogue.json where
 * the checkout has one, SAMPLES.md where it does not (an older checkout is
 * exactly that, and must keep working untouched), SAMPLES.md again when the
 * JSON is mid-pull garbage - and for `samples` the page's src/00 rows merged
 * IN beside the JSON, because its catalogue deliberately covers src/01 only
 * and the experimental area must not vanish with the upgrade. */
test('catalogue.json is preferred, SAMPLES.md is the fallback and the src/00 supplement', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-cat-'));
  const nowhere = path.join(base, 'not-checked-out');
  const home = path.join(base, 'samples');
  fs.mkdirSync(home, { recursive: true });
  // SAMPLES.md is the samples probe, so every checkout shape carries it
  fs.writeFileSync(path.join(home, 'SAMPLES.md'), [
    '## Basics',
    '',
    '| Sample | Class |',
    '|---|---|',
    '| **Basics I** — Hello World<br><sub>page keywords</sub> | [`Z2UI5_CL_SMP_APP_493`](src/01/z2ui5_cl_smp_app_493.clas.abap) |',
    '| Playground<br><sub>experimental thing</sub> | [`Z2UI5_CL_SMP_APP_321`](src/00/97/z2ui5_cl_smp_app_321.clas.abap) |',
  ].join('\n'));
  const query = () => JSON.parse(execFileSync(process.execPath, ['-e',
    "import('./lib/examples.mjs').then(m => process.stdout.write(JSON.stringify({"
    + 'entries: m.parseExamples(), summary: m.exampleSummary() })))'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SAMPLES_HOME: home,
      // authoritative misses: a set env var pointing nowhere resolves to null
      SAMPLES_CONTROLS_HOME: nowhere,
      AI_DEMOKIT_HOME: nowhere,
      SAMPLES_STACK_HOME: nowhere,
    },
  }));
  try {
    // no catalogue.json: the row parser answers alone, as it always has
    let r = query();
    assert.equal(r.summary.sources.samples, 'SAMPLES.md');
    assert.deepEqual(r.entries.map((e) => e.cls), ['Z2UI5_CL_SMP_APP_493', 'Z2UI5_CL_SMP_APP_321']);
    assert.equal(r.entries[0].stage, undefined);

    // with catalogue.json: the JSON wins for the classes it carries (the
    // stage proves which file answered), the page still carries src/00
    fs.writeFileSync(path.join(home, 'catalogue.json'), JSON.stringify({
      samples: [{
        class: 'z2ui5_cl_smp_app_493',
        file: 'src/01/z2ui5_cl_smp_app_493.clas.abap',
        category: 'Basics',
        stage: 'start',
        title: 'Basics I',
        description: 'Hello World, the Smallest App',
        summary: 'The smallest app that runs.',
        keywords: ['hello', 'world'],
        docs: [],
      }],
    }));
    r = query();
    assert.equal(r.summary.sources.samples, 'catalogue.json');
    assert.deepEqual(r.entries.map((e) => e.cls), ['Z2UI5_CL_SMP_APP_493', 'Z2UI5_CL_SMP_APP_321']);
    assert.equal(r.entries[0].stage, 'start', 'the class both files carry is answered from the JSON');
    assert.equal(r.entries[1].area, 'experimental-or-test', 'the page-only src/00 row survives the upgrade');

    // a catalogue.json that does not parse (mid-pull) falls back to the page
    fs.writeFileSync(path.join(home, 'catalogue.json'), '{ "samples": [ trunca');
    r = query();
    assert.deepEqual(r.entries.map((e) => e.cls), ['Z2UI5_CL_SMP_APP_493', 'Z2UI5_CL_SMP_APP_321']);
    assert.equal(r.entries[0].stage, undefined, 'the damaged JSON answered nothing - the page did');

    // and the absent catalogues are still named, not silently dropped
    assert.equal(r.summary.notSearched.length, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- guide ----
/* The app-building guide, sliced by chapter the way the pitfalls catalogues
 * are. The document itself lives in the abap2UI5 checkout; the slicing does
 * not need it. */

const GUIDE_MD = [
  '# Building apps with abap2UI5 — the agent guide',
  '',
  'Self-contained reference. When this guide and the code disagree, the code wins.',
  '',
  '## 1. The model in one paragraph',
  '',
  'An abap2UI5 app is one ABAP class implementing z2ui5_if_app.',
  '',
  '## 5. Events',
  '',
  'Register a named event and read it back on the next roundtrip.',
  '',
  '## 6. Popups, popovers, messages',
  '',
  'A popup is a second view displayed into the popup slot.',
].join('\n');

test('the guide keeps its intro as a section of its own', () => {
  const sections = sliceGuide(GUIDE_MD);
  assert.equal(sections.length, 4);
  assert.equal(sections[0].heading, '(intro)');
  assert.match(sections[0].body, /the code wins/, 'the "how to read this" half must survive');
  assert.deepEqual(guideChapters(GUIDE_MD).slice(1), ['1. The model in one paragraph', '5. Events', '6. Popups, popovers, messages']);
});

/* A chapter can be asked for by number or by a word in its heading. A NUMBER
 * has to mean the chapter number and nothing else: falling through to a
 * substring match made `section: "5"` also return the view-builder chapter,
 * whose heading carries `z2ui5_cl_ui5_view_builder`. A digit is a terrible
 * needle in a document about a framework with one in its name. */
test('a chapter can be asked for by number or by name, and a number means the number', () => {
  assert.deepEqual(sliceGuide(GUIDE_MD, { section: '5' }).map((s) => s.heading), ['5. Events']);
  assert.deepEqual(sliceGuide(GUIDE_MD, { section: 'events' }).map((s) => s.heading), ['5. Events']);
  assert.deepEqual(sliceGuide(GUIDE_MD, { section: 'popup' }).map((s) => s.heading), ['6. Popups, popovers, messages']);
  assert.deepEqual(sliceGuide(GUIDE_MD, { section: 'nope' }), []);
});

test('a guide query narrows to whole chapters that carry every term', () => {
  assert.deepEqual(sliceGuide(GUIDE_MD, { query: 'roundtrip' }).map((s) => s.heading), ['5. Events']);
  // AND, like every other search here
  assert.deepEqual(sliceGuide(GUIDE_MD, { query: 'roundtrip popup' }), []);
});

// ------------------------------------------------------------- docs_search ----
/* The documentation search over injected fixture pages - the real tree lives
 * in the docs checkout, the semantics must not need it. What is pinned: AND-ed
 * terms, the title > heading > body ranking, the published URL pair built the
 * way the docs repo's own generate-llms.mjs builds them (SITE + /<path> plus
 * the extension), and a snippet that quotes the matching section. */

const DOC_PAGES = [
  {
    path: 'cookbook/value_help',
    text: '---\ntitle: meta\n---\n# Value Help\n\nBoth halves of the value help.\n\n## The F4 dialog\n\nThe dialog behind the field opens on F4.\n',
  },
  {
    path: 'advanced/linter',
    text: '# The linter\n\nChecks a view without a system.\n\n## Value help findings\n\nA suggestion-only field is flagged.\n',
  },
  {
    path: 'get_started/setup',
    text: '# Setup\n\nInstall abapGit first. The value help sample helps later.\n\n```abap\n" value help inside a fence is still body text\n```\n',
  },
];

test('docs are ranked title over heading over body, terms AND-ed', () => {
  const hits = searchDocs({ query: 'value help', pages: DOC_PAGES });
  assert.deepEqual(hits.map((h) => h.path),
    ['cookbook/value_help', 'advanced/linter', 'get_started/setup']);
  // AND: adding a term that only one page carries narrows to it
  assert.deepEqual(searchDocs({ query: 'value help suggestion', pages: DOC_PAGES }).map((h) => h.path),
    ['advanced/linter']);
  assert.deepEqual(searchDocs({ query: 'value help nonexistent', pages: DOC_PAGES }), []);
  assert.deepEqual(searchDocs({ query: '', pages: DOC_PAGES }), []);
});

test('a docs hit carries the published URL pair and a quoting snippet', () => {
  const [hit] = searchDocs({ query: 'f4 dialog', pages: DOC_PAGES });
  assert.equal(hit.path, 'cookbook/value_help');
  assert.equal(hit.title, 'Value Help', 'the title is the # heading, not the frontmatter');
  assert.equal(hit.heading, 'The F4 dialog', 'the best-matching section is named');
  assert.match(hit.snippet, /opens on F4/);
  // the URL shapes the docs repo publishes: <path>.html rendered, <path>.md raw
  assert.equal(hit.url, 'https://abap2ui5.github.io/docs/cookbook/value_help.html');
  assert.equal(hit.markdown, 'https://abap2ui5.github.io/docs/cookbook/value_help.md');
});

test('the docs search honours its limit and never throws on damaged pages', () => {
  assert.equal(searchDocs({ query: 'value', pages: DOC_PAGES, limit: 2 }).length, 2);
  for (const bad of ['', '---\nunclosed', '# only a title', '```\nfence never closed', '## \n\n|']) {
    assert.doesNotThrow(() => searchDocs({ query: 'x y', pages: [{ path: 'p', text: bad }] }),
      `searchDocs threw on ${JSON.stringify(bad)}`);
  }
});

test('a docs checkout is found through DOCS_HOME and its probe', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-docs-'));
  try {
    fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'docs', 'index.md'), '# docs');
    const found = execFileSync(process.execPath, ['-e',
      "import('./lib/repos.mjs').then(m => process.stdout.write(String(m.resolveDocs())))"],
    { cwd: ROOT, env: { ...process.env, DOCS_HOME: home }, encoding: 'utf8' });
    assert.equal(found, home);
    // a directory without the page tree is not a docs checkout
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-notdocs-'));
    const miss = execFileSync(process.execPath, ['-e',
      "import('./lib/repos.mjs').then(m => process.stdout.write(String(m.resolveDocs())))"],
    { cwd: ROOT, env: { ...process.env, DOCS_HOME: empty }, encoding: 'utf8' });
    assert.equal(miss, 'null', 'a set env var pointing at a non-checkout must resolve to null, not fall through');
    fs.rmSync(empty, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* One dangling symbolic link anywhere under docs/ threw out of the tree walk
 * (statSync on its target), and every docs_search failed with ENOENT. */
test('a dangling symbolic link in the docs tree is skipped, not the whole search', { skip: process.platform === 'win32' && 'symbolic links need privileges there' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-docs-link-'));
  try {
    fs.mkdirSync(path.join(home, 'docs', 'cookbook'), { recursive: true });
    fs.writeFileSync(path.join(home, 'docs', 'index.md'), '# docs');
    fs.writeFileSync(path.join(home, 'docs', 'cookbook', 'value_help.md'), '# Value Help\n\nvalue help text');
    fs.symlinkSync('gone.md', path.join(home, 'docs', 'cookbook', 'broken.md'));
    const out = execFileSync(process.execPath, ['-e',
      "import('./lib/docs.mjs').then(m => process.stdout.write(JSON.stringify(m.searchDocs({ query: 'value help' }).map((e) => e.path))))"],
    { cwd: ROOT, env: { ...process.env, DOCS_HOME: home }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), ['cookbook/value_help']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ api ----
/* The client API (z2ui5_if_client), parsed from a fixture that carries every
 * shape the real interface uses: single-line and multi-line METHODS, ABAP-Doc
 * with @parameter blocks, inline " notes on parameters and constant entries,
 * nested cs_* groups, TYPES with their doc INSIDE the block. The real file is
 * in the abap2UI5 checkout; the parsing must not need it. */

const API_FIXTURE = `INTERFACE z2ui5_if_client
  PUBLIC.

  CONSTANTS:
    BEGIN OF cs_device,
      BEGIN OF system,
        phone   TYPE string VALUE \`phone\`,
        desktop TYPE string VALUE \`desktop\`,
      END OF system,
    END OF cs_device.

  CONSTANTS:
    BEGIN OF cs_event,
      start_timer TYPE string VALUE \`START_TIMER\`,
      "obsolet
      z2ui5       TYPE string VALUE \`Z2UI5\`,
    END OF cs_event.

  CONSTANTS:
    "! Hash-based routing modes - the doc sits INSIDE the block here.
    BEGIN OF cs_nav_mode,
      default TYPE string VALUE \`DEFAULT\`,
    END OF cs_nav_mode.

  TYPES:
    "! Everything the frontend sent with this roundtrip.
    BEGIN OF ty_s_get,
      event TYPE string,
    END OF ty_s_get.

  METHODS view_destroy.

  "! Display the MAIN view. A new main view is a new screen.
  METHODS view_display
    IMPORTING
      val TYPE clike.

  "! obsolete - does NOTHING. It stays so existing apps keep compiling.
  METHODS view_model_update.

  "! @parameter omit_initial | keep INITIAL fields out of the model
  "!                           instead of sending them as \`\` / 0
  METHODS _bind
    IMPORTING
      val                  TYPE data
      "obsolete - inactive, not passed on internally
      view                 TYPE clike     DEFAULT cs_view-main
      omit_initial         TYPE abap_bool DEFAULT abap_false
      tab_index            TYPE i         OPTIONAL
    RETURNING
      VALUE(result)        TYPE string.

  METHODS nav_app_leave
    IMPORTING
      VALUE(app)    TYPE REF TO z2ui5_if_app OPTIONAL
      event         TYPE clike               OPTIONAL
        PREFERRED PARAMETER app
    RETURNING
      VALUE(result) TYPE string.

ENDINTERFACE.
`;

test('the client API parses into methods, constants and types', () => {
  const p = parseApi(API_FIXTURE);
  assert.deepEqual(p.methods.map((m) => m.name),
    ['view_destroy', 'view_display', 'view_model_update', '_bind', 'nav_app_leave']);
  assert.deepEqual(p.constants.map((c) => c.name), ['cs_device', 'cs_event', 'cs_nav_mode']);
  assert.deepEqual(p.types.map((t) => t.name), ['ty_s_get']);

  const display = p.methods.find((m) => m.name === 'view_display');
  assert.match(display.doc, /new main view is a new screen/);
  assert.deepEqual(display.parameters, [{ name: 'val', kind: 'importing', type: 'clike' }]);

  // nesting flattens to the path an app actually writes
  assert.deepEqual(p.constants[0].values.map((v) => v.path),
    ['cs_device-system-phone', 'cs_device-system-desktop']);
  // a doc INSIDE the CONSTANTS/TYPES block still documents the group
  assert.match(p.constants[2].doc, /INSIDE the block/);
  assert.match(p.types[0].doc, /frontend sent/);
  assert.match(p.types[0].definition, /event TYPE string/);
});

test('obsolete methods and tagged constants are marked, never hidden', () => {
  const p = parseApi(API_FIXTURE);
  // the obsolete half of the interface exists so old apps compile - an agent
  // must SEE it (to read old code) and see it marked (to not write new calls)
  assert.equal(p.methods.find((m) => m.name === 'view_model_update').obsolete, true);
  assert.equal(p.methods.find((m) => m.name === 'view_display').obsolete, false);
  const ev = p.constants.find((c) => c.name === 'cs_event');
  assert.equal(ev.values.find((v) => v.path === 'cs_event-z2ui5').note, 'obsolet');
  assert.equal(ev.values.find((v) => v.path === 'cs_event-start_timer').note, undefined);
});

test('a parameter carries its default, its optionality and its own doc', () => {
  const bind = parseApi(API_FIXTURE).methods.find((m) => m.name === '_bind');
  const by = Object.fromEntries(bind.parameters.map((x) => [x.name, x]));
  assert.equal(by.view.default, 'cs_view-main');
  // the inline " note above a parameter is that parameter's documentation
  assert.match(by.view.doc, /obsolete - inactive/);
  // an @parameter block reaches the parameter it names, wrapped lines joined
  assert.match(by.omit_initial.doc, /keep INITIAL fields out of the model instead/);
  assert.equal(by.tab_index.optional, true);
  assert.equal(by.result.kind, 'returning');

  const nav = parseApi(API_FIXTURE).methods.find((m) => m.name === 'nav_app_leave');
  assert.equal(nav.parameters.find((x) => x.name === 'app').preferred, true);
  assert.equal(nav.parameters.find((x) => x.name === 'app').type, 'REF TO z2ui5_if_app');
});

test('an API query is AND-ed and returns whole entries', () => {
  const p = parseApi(API_FIXTURE);
  const timer = searchApi(p, 'timer');
  assert.deepEqual(timer.constants.map((c) => c.values.map((v) => v.path)).flat(), ['cs_event-start_timer']);
  assert.deepEqual(timer.methods, []);
  // a method hit comes back with ALL its parameters, not the matching one
  const omit = searchApi(p, 'omit initial');
  assert.deepEqual(omit.methods.map((m) => m.name), ['_bind']);
  assert.equal(omit.methods[0].parameters.length, 5);
  // AND: a second term that matches nothing removes the hit
  assert.deepEqual(searchApi(p, 'timer omit').constants, []);
  // a group whose NAME matches returns the whole group
  assert.equal(searchApi(p, 'cs_device').constants[0].values.length, 2);
});

test('the API parser reports, never throws, on a damaged interface', () => {
  for (let i = 0; i <= 40; i++) {
    const cut = API_FIXTURE.slice(0, Math.floor((API_FIXTURE.length * i) / 40));
    assert.doesNotThrow(() => parseApi(cut), `parseApi threw on a ${i}/40 truncation`);
    assert.doesNotThrow(() => apiSummary(parseApi(cut)), `apiSummary threw on a ${i}/40 truncation`);
    assert.doesNotThrow(() => searchApi(parseApi(cut), 'timer'), `searchApi threw on a ${i}/40 truncation`);
  }
  for (const bad of ['', 'METHODS', 'CONSTANTS:', 'TYPES:', '"! doc for nothing', 'BEGIN OF x,']) {
    assert.doesNotThrow(() => parseApi(bad), `parseApi threw on ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------- screenshot ----
/* The viewport list screenshot_view takes. Refused rather than guessed at: a
 * size that quietly fell back to the default would return a picture of the
 * wrong viewport, and the viewport is the question being asked. */
test('a viewport is parsed, or refused by name', () => {
  assert.deepEqual(parseSizes(['390x844', '1280x900']), [
    { width: 390, height: 844 }, { width: 1280, height: 900 },
  ]);
  assert.equal(parseSizes([]), undefined, 'no sizes means the default, not an empty list');
  assert.equal(parseSizes(undefined), undefined);
  for (const bad of ['huge', '390', '390*844', '390x', 'x844', '390x844px']) {
    assert.throws(() => parseSizes([bad]), /invalid size/, `expected rejection for '${bad}'`);
  }
});

/* Each viewport is a browser window and a PNG travelling back through the
 * protocol, so the pattern alone was not the whole gate: it accepted
 * `99999x99999` - a ten-gigapixel full-page screenshot - and any number of
 * viewports in one call. */
test('a viewport is bounded in size and in number', () => {
  assert.throws(() => parseSizes(['99999x99999']), /out of range/);
  assert.throws(() => parseSizes(['4097x100']), /out of range/);
  assert.doesNotThrow(() => parseSizes(['4096x4096']), 'the limit itself is still a viewport');
  // a zero edge matched the two-digit pattern; Chromium takes 0 as "no override"
  for (const tiny of ['00x10', '10x00', '09x844']) assert.throws(() => parseSizes([tiny]), /out of range/, tiny);
  assert.doesNotThrow(() => parseSizes(['10x10']), 'the lower limit itself is still a viewport');
  assert.throws(() => parseSizes(Array(9).fill('390x844')), /too many sizes/);
  assert.doesNotThrow(() => parseSizes(Array(8).fill('390x844')));
});

// -------------------------------------------------------------- arguments ----
/* The tool schemas declare `enum` and `type: number`; a client is free to send
 * anything anyway, so the checking happens here. What this pins is that an
 * unrecognised value is an ERROR rather than a silent fallback - the failure
 * that cost a full build when `mode: "incremental "` fell through to auto. */
test('an enumerated argument is checked, never silently defaulted', () => {
  assert.equal(oneOf('full', { name: 'mode', allowed: ['auto', 'incremental', 'full'], dflt: 'auto' }), 'full');
  assert.equal(oneOf(undefined, { name: 'mode', allowed: ['auto', 'full'], dflt: 'auto' }), 'auto');
  assert.equal(oneOf('', { name: 'mode', allowed: ['auto', 'full'], dflt: 'auto' }), 'auto');
  assert.equal(oneOf(undefined, { name: 'status', allowed: ['direct'] }), undefined,
    'no default means "no filter", not a made-up one');

  // the trailing space is the real case: it missed `=== "incremental"` and
  // started a full build
  for (const bad of ['incremental ', 'Full', 'increment', 'auto;rm -rf /', 0, true]) {
    assert.throws(
      () => oneOf(bad, { name: 'mode', allowed: ['auto', 'incremental', 'full'], dflt: 'auto' }),
      /unknown mode/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  // and the message lists what IS accepted, so the agent can retry
  assert.throws(
    () => oneOf('x', { name: 'area', allowed: ['abap', 'view', 'all'], dflt: 'all' }),
    /unknown area 'x' .* use abap, view or all/,
  );
});

test('a numeric argument is coerced, bounded and refused when it is not a number', () => {
  const opts = { name: 'limit', dflt: 20, min: 1, max: 200 };
  assert.equal(boundedInt(undefined, opts), 20);
  assert.equal(boundedInt(5, opts), 5);
  assert.equal(boundedInt('5', opts), 5, 'a client that sends the number as a string means the number');
  assert.equal(boundedInt(7.9, opts), 7);
  // 0 and negative used to mean "no limit at all" one layer down
  assert.equal(boundedInt(0, opts), 1);
  assert.equal(boundedInt(-3, opts), 1);
  assert.equal(boundedInt(1e9, opts), 200);
  // Number( ) read true as 1, false, [] and blanks as 0 and [7] as 7
  for (const bad of ['abc', {}, NaN, Infinity, true, false, [], [7], '  ']) {
    assert.throws(() => boundedInt(bad, opts), /limit must be a number/, `expected rejection for ${String(bad)}`);
  }
});

test('an argument echoed in an error is cut to 80 characters', () => {
  const huge = 'x'.repeat(300000);
  for (const run of [
    () => oneOf(huge, { name: 'mode', allowed: ['a', 'b'] }),
    () => boundedInt(huge, { name: 'tail', dflt: 1 }),
  ]) {
    assert.throws(run, (e) => e.message.length < 400);
  }
});

test('an argument the tool does not declare is refused, naming the ones it has', () => {
  const tool = { name: 'app_act', inputSchema: { type: 'object', properties: { session: { type: 'string' }, values: { type: 'object' }, event: { type: 'string' } } } };
  assert.doesNotThrow(() => checkStringArgs(tool, { session: 'S1', event: 'POST' }));
  assert.throws(() => checkStringArgs(tool, { session: 'S1', value: { f1: '1' }, event: 'POST' }), /^Error: app_act has no argument 'value' - its arguments: session, values, event$/);
  assert.throws(() => checkStringArgs({ name: 'x', inputSchema: { type: 'object', properties: {} } }, { a: 1 }), /x has no argument 'a' - it takes none/);
});

/* A list argument that ends up as spawn argv has the failure modes coercion
 * cannot repair: a bare string passes a length check and shatters into one
 * argv entry per character, a number throws inside spawn as a TypeError
 * nobody can act on. scope_of\'s entities go through this. */
test('a string-list argument is exactly an array of non-empty strings, bounded', () => {
  const opts = { name: 'entities' };
  assert.deepEqual(stringArray(['sap.m.Wizard'], opts), ['sap.m.Wizard']);
  assert.deepEqual(stringArray(['  sap.m.Bar '], opts), ['sap.m.Bar'], 'entries are trimmed');
  // a bare string has .length and would shatter into characters in argv
  assert.throws(() => stringArray('sap.m.Wizard', opts), /entities must be an array of strings/);
  assert.throws(() => stringArray(42, opts), /entities must be an array of strings/);
  assert.throws(() => stringArray([], opts), /entities is empty/);
  assert.throws(() => stringArray(['sap.m.Bar', 7], opts), /non-empty string/);
  assert.throws(() => stringArray(['sap.m.Bar', ''], opts), /non-empty string/);
  assert.throws(() => stringArray(['   '], opts), /non-empty string/);
  assert.throws(() => stringArray([null], opts), /non-empty string/);
  assert.throws(
    () => stringArray(Array.from({ length: 51 }, (_, i) => `e${i}`), opts),
    /at most 50 per call/,
  );
  assert.throws(() => stringArray(['x'.repeat(201)], opts), /longer than 200 characters/);
});

/* Defence in depth under the tool layer: searchExamples used to return the
 * WHOLE catalogue - 600+ entries - for limit 0, a negative number, or the NaN
 * a non-numeric argument produces. An argument meant to make the answer
 * smaller must never make it bigger. */
test('the example search bounds its limit whatever the caller passed', () => {
  const all = searchExamples({ query: 'app', rawText: SAMPLES_MD, limit: 99 }).length;
  assert.ok(all >= 2, 'the fixture has rows to limit');
  assert.equal(searchExamples({ query: 'app', rawText: SAMPLES_MD, limit: 1 }).length, 1);
  for (const bad of [0, -1, 'abc', NaN]) {
    const n = searchExamples({ query: 'app', rawText: SAMPLES_MD, limit: bad }).length;
    assert.ok(n <= all && n >= 1, `limit ${String(bad)} must stay bounded, got ${n}`);
  }
  assert.equal(searchExamples({ query: 'app', rawText: SAMPLES_MD, limit: 0 }).length, 1,
    'zero is the smallest answer that is still an answer, not "all of them"');
});

// ----------------------------------------------------------- scaffold ----
/* The class name is substituted into the sidecar's CLSNAME and into file
 * names, so it is validated before it is used. An object whose ABAP and whose
 * CLSNAME disagree looks right and does not activate - which is why
 * app-template ships a rename script rather than an instruction. */
test('a scaffold class name is an ABAP class name, or it is refused', () => {
  for (const ok of ['zcl_my_app', 'zcx_error', 'zcl_a1_b2']) {
    assert.equal(validClassName(ok), true, ok);
  }
  for (const bad of ['', 'zcl_', 'cl_my_app', 'zcl-my-app', '../etc/passwd',
    'zcl_app/../../x', 'zcl_my app', 'zcl_' + 'x'.repeat(30)]) {
    assert.equal(validClassName(bad), false, "expected refusal for '" + bad + "'");
  }
});

/* ycl_ and ycx_ were accepted here and are rejected by the abaplint
 * object_naming (^ZCL_|^ZCX_) that ships in the same template - so the scaffold
 * blessed a name and handed back a repository failing its own gate. */
test('a name the scaffolded project cannot lint is refused here', () => {
  for (const bad of ['ycl_my_app', 'ycx_error']) {
    assert.equal(validClassName(bad), false, "expected refusal for '" + bad + "'");
  }
});

/* The rule belongs to template.json, like the file list does. This file keeps a
 * fallback for a checkout that has no spec yet, and a second copy of a rule is
 * exactly what this module exists to avoid - so the two have to agree whenever
 * the sibling is there to ask. */
test('the fallback class rule agrees with the template it stands in for', (t) => {
  const root = path.join(ROOT, '..', 'app-template');
  if (!fs.existsSync(path.join(root, 'template.json'))) {
    t.skip('app-template sibling has no template.json');
    return;
  }
  const spec = readSpec(root);
  if (!spec?.substitutions?.class?.rule) {
    t.skip('that checkout has no class rule');
    return;
  }

  const probes = ['zcl_my_app', 'zcx_error', 'ycl_my_app', 'ycx_error', 'cl_my_app',
    'zcl_a1_b2', 'zcl_', 'zif_my_app'];
  for (const probe of probes) {
    assert.equal(
      validClassName(probe),
      validClassName(probe, spec),
      `the fallback and template.json disagree about "${probe}" - one of them moved`,
    );
  }
});

/* The substitution engine itself, on a fixture spec of the same shape
 * app-template's template.json has. It is pure (spec, file, text, options) and
 * used to be reachable only through scaffold(), i.e. only with the sibling
 * checkout - so on a bare checkout the three tests below skipped and a
 * substitution bug was invisible. */
const TEMPLATE_SPEC = {
  placeholderClass: 'zcl_app_001',
  files: {
    shared: ['abaplint.jsonc', 'package.json'],
    named: ['.abapgit.xml', 'src/package.devc.xml', 'src/zcl_app_001.clas.abap', 'src/zcl_app_001.clas.xml'],
  },
  substitutions: {
    class: {
      files: ['src/zcl_app_001.clas.abap', 'src/zcl_app_001.clas.xml', 'AGENTS.md'],
      renamesPath: true,
    },
    packageText: [{ file: 'src/package.devc.xml', element: 'CTEXT' }],
    repo: [
      { file: '.abapgit.xml', element: 'NAME' },
      { file: 'package.json', jsonKey: 'name' },
    ],
  },
};
const sub = (file, text, opts) => rename(TEMPLATE_SPEC, file, text, opts);

test('the substitution engine renames a class in both cases, and only where the spec says', () => {
  const abap = 'CLASS zcl_app_001 DEFINITION PUBLIC.\n  " see zcl_app_001\nENDCLASS.\n';
  assert.equal(
    sub('src/zcl_app_001.clas.abap', abap, { cls: 'zcl_invoice' }),
    'CLASS zcl_invoice DEFINITION PUBLIC.\n  " see zcl_invoice\nENDCLASS.\n',
  );
  // the sidecar writes the name UPPER case - renaming only the ABAP produces an
  // object abapGit imports under one name and ABAP activates under another
  assert.equal(
    sub('src/zcl_app_001.clas.xml', '<CLSNAME>ZCL_APP_001</CLSNAME>', { cls: 'zcl_invoice' }),
    '<CLSNAME>ZCL_INVOICE</CLSNAME>',
  );
  // a file the spec does not list keeps the placeholder, whatever it contains
  assert.equal(
    sub('abaplint.jsonc', '{ "x": "zcl_app_001" }', { cls: 'zcl_invoice' }),
    '{ "x": "zcl_app_001" }',
  );
  // no class asked for, or the template's own name asked for: nothing to do
  assert.equal(sub('src/zcl_app_001.clas.abap', abap, {}), abap);
  assert.equal(sub('src/zcl_app_001.clas.abap', abap, { cls: 'zcl_app_001' }), abap);
});

test('the substitution engine writes the package text and the repository name', () => {
  assert.equal(
    sub('src/package.devc.xml', '<DEVC><CTEXT>Template app</CTEXT></DEVC>', { packageText: 'Invoice App' }),
    '<DEVC><CTEXT>Invoice App</CTEXT></DEVC>',
  );
  assert.equal(
    sub('.abapgit.xml', '<NAME>app-template</NAME>', { repo: 'invoice-app' }),
    '<NAME>invoice-app</NAME>',
  );
  // the same substitution, expressed as a JSON key rather than an element
  assert.equal(
    sub('package.json', '{\n  "name": "abap2ui5-app-template",\n  "version": "1.0.0"\n}', { repo: 'invoice-app' }),
    '{\n  "name": "invoice-app",\n  "version": "1.0.0"\n}',
  );
  // each substitution applies to ITS file only
  assert.equal(sub('.abapgit.xml', '<CTEXT>x</CTEXT>', { packageText: 'y' }), '<CTEXT>x</CTEXT>');
  assert.equal(sub('package.json', '{ "name": "x" }', {}), '{ "name": "x" }');
});

test('the substitution engine applies every substitution asked for at once', () => {
  const xml = '<abapGit><NAME>app-template</NAME></abapGit>';
  assert.equal(
    sub('.abapgit.xml', xml, { cls: 'zcl_invoice', packageText: 'Invoice App', repo: 'invoice-app' }),
    '<abapGit><NAME>invoice-app</NAME></abapGit>',
    'a named file gets the substitutions the spec lists it under, and no others',
  );
  const clas = 'CLASS zcl_app_001 DEFINITION.\n<CTEXT>keep</CTEXT>\n';
  assert.equal(
    sub('src/zcl_app_001.clas.abap', clas, { cls: 'zcl_invoice', packageText: 'Invoice App', repo: 'invoice-app' }),
    'CLASS zcl_invoice DEFINITION.\n<CTEXT>keep</CTEXT>\n',
  );
});

/* The free-text values land in XML and JSON and used to be spliced in raw,
 * as a String.replace replacement STRING: `R&D <tools>` broke the sidecar's
 * XML, `my"repo` broke package.json, and `$&` expanded to the matched text. */
test('the substitution engine escapes package text and repository name for the format they land in', () => {
  const pkg = sub('src/package.devc.xml', '<DEVC><CTEXT>Template app</CTEXT></DEVC>', { packageText: 'R&D <tools> $& end' });
  assert.equal(pkg, '<DEVC><CTEXT>R&amp;D &lt;tools&gt; $&amp; end</CTEXT></DEVC>');
  const abapgit = sub('.abapgit.xml', '<NAME>app-template</NAME>', { repo: 'my"repo $\' <x>' });
  assert.equal(abapgit, '<NAME>my&quot;repo $&apos; &lt;x&gt;</NAME>');
  const json = sub('package.json', '{\n  "name": "abap2ui5-app-template",\n  "version": "1.0.0"\n}', { repo: 'my"repo $& \\ end' });
  assert.deepEqual(JSON.parse(json), { name: 'my"repo $& \\ end', version: '1.0.0' }, 'package.json stays JSON and says exactly what was asked');
  // an existing value with an escaped quote is replaced whole, not half
  const again = sub('package.json', '{ "name": "a\\"b" }', { repo: 'c' });
  assert.deepEqual(JSON.parse(again), { name: 'c' });
});

test('scaffolding renames the class in the ABAP, the sidecar and the file name', (t) => {
  const root = path.join(ROOT, '..', 'app-template');
  // template.json, not abaplint.jsonc: the file list and the substitutions
  // moved into it, so it is what scaffold() actually needs. A checkout that
  // predates it is a sibling that is present and still cannot serve this test.
  if (!fs.existsSync(path.join(root, 'template.json'))) {
    t.skip('app-template sibling has no template.json');
    return;
  }
  const { files, missing } = scaffold(root, {
    cls: 'zcl_invoice_app', packageText: 'Invoice App', repo: 'invoice-app',
  });
  assert.deepEqual(missing, [], 'the template still has every file this serves');
  assert.equal(files.length, templateFiles(readSpec(root)).length);

  const at = (suffix) => files.find((f) => f.path.endsWith(suffix));
  assert.ok(at('src/zcl_invoice_app.clas.abap'), 'the class file is named after the class');
  assert.ok(at('src/zcl_invoice_app.clas.xml'), 'and so is its sidecar');
  assert.match(at('.clas.abap').text, /CLASS zcl_invoice_app DEFINITION/);
  // upper case in the sidecar, lower in the ABAP - that asymmetry is the bug
  assert.match(at('.clas.xml').text, /<CLSNAME>ZCL_INVOICE_APP<\/CLSNAME>/);
  assert.match(at('package.devc.xml').text, /<CTEXT>Invoice App<\/CTEXT>/);
  assert.match(at('.abapgit.xml').text, /<NAME>invoice-app<\/NAME>/);

  assert.ok(!files.some((f) => /zcl_app_001/i.test(f.text)),
    'no file still carries the template own class name');
  assert.ok(files.some((f) => f.path === 'AGENTS.md'),
    'the briefing ships with the project - an agent without one is the gap this closes');
});

test('scaffolding without a class name returns the template as it stands', (t) => {
  const root = path.join(ROOT, '..', 'app-template');
  // template.json, not abaplint.jsonc: the file list and the substitutions
  // moved into it, so it is what scaffold() actually needs. A checkout that
  // predates it is a sibling that is present and still cannot serve this test.
  if (!fs.existsSync(path.join(root, 'template.json'))) {
    t.skip('app-template sibling has no template.json');
    return;
  }
  const { files } = scaffold(root, {});
  assert.ok(files.some((f) => f.path === 'src/zcl_app_001.clas.abap'));
});

test('a template missing a file reports it rather than shipping a shorter project', (t) => {
  // The description comes from the template too, so the fixture carries the
  // real one - a hand-written list here would be the copy this stopped keeping.
  // That makes this test need the sibling checkout, exactly like the two
  // scaffold tests above, and it must skip the same way: CI checks out this
  // repository alone, and a test that reads a neighbour without saying so
  // fails there for a reason that has nothing to do with the code.
  const specFile = path.join(ROOT, '..', 'app-template', 'template.json');
  if (!fs.existsSync(specFile)) {
    t.skip('app-template sibling has no template.json');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2u5-tpl-'));
  fs.cpSync(specFile, path.join(dir, 'template.json'));
  fs.writeFileSync(path.join(dir, 'abaplint.jsonc'), '{}');
  const { files, missing, spec } = scaffold(dir, {});
  assert.deepEqual(files.map((f) => f.path), ['abaplint.jsonc']);
  assert.ok(missing.includes('src/zcl_app_001.clas.abap'));
  assert.equal(missing.length, templateFiles(spec).length - 1);
});

/* Without template.json there is no list to serve, and the point of reading
 * the template's own description is that this repo does not keep a second
 * one to fall back on. */
test('a template without its own description is reported, not guessed at', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2u5-nospec-'));
  fs.writeFileSync(path.join(dir, 'abaplint.jsonc'), '{}');
  const { files, noSpec } = scaffold(dir, {});
  assert.equal(noSpec, true);
  assert.deepEqual(files, []);
});

// ------------------------------------------------------------------- bins ----

/* `npx --yes @abap2ui5/mcp-server` runs the bin named after the package's
 * UNSCOPED name, or the only bin when there is exactly one. 0.2.0 had two
 * bins and neither was called `mcp-server`, so every registration the docs
 * give failed with "could not determine executable to run". The release
 * workflow proves the whole npx path against the tarball
 * (scripts/pack-smoke.mjs); this pins the manifest half on every `npm test`. */
test('the package carries a bin named after its unscoped name, and keeps the explicit ones', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const unscoped = pkg.name.replace(/^@[^/]+\//, '');
  assert.equal(pkg.bin[unscoped], 'server.mjs', `npx ${pkg.name} runs bin '${unscoped}' - it must be the server`);
  assert.equal(pkg.bin['abap2ui5-mcp'], 'server.mjs', 'the explicit form every version answers stays');
  assert.equal(pkg.bin['abap2ui5-unit'], 'scripts/ci-unit.mjs', 'the CI runner bin is a contract with app-template');
  for (const file of new Set(Object.values(pkg.bin))) {
    assert.ok(pkg.files.some((f) => file === f || file.startsWith(f)), `${file} is a bin and must be in files`);
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /^#!\/usr\/bin\/env node\n/, `${file} needs its shebang`);
  }
});

// ---------------------------------------------------------------- run_app ----

/* waitForFunction(fn, arg, options): the boot wait passed { timeout } as the
 * ARG, so the page function received it and the wait kept Playwright's
 * default 30 s - run_app's and interact_app's timeout_ms did nothing. */
test('the boot wait hands timeout_ms to Playwright as options, not as the page argument', async () => {
  const { waitForBoot } = await import('../lib/runtime.mjs');
  const calls = [];
  const page = { waitForFunction: async (...args) => { calls.push(args); } };
  await waitForBoot(page, 12345);
  assert.equal(calls.length, 1);
  const [fn, arg, options] = calls[0];
  assert.equal(typeof fn, 'function');
  assert.equal(arg, undefined, 'nothing is passed to the page function');
  assert.deepEqual(options, { timeout: 12345 });
});

/* The framework page's CSP allows its inline bootstrap by hash only; the
 * locally served @openui5 SOURCE sap-ui-core.js document.write()s inline
 * scripts, which that policy blocks, so a run_app with a corpus beside it
 * never booted. bypassCSP exactly when local sources are served - with the
 * CDN's built file the app boots under the framework's own policy. */
test('the app context bypasses CSP only while UI5 is served from local sources', async () => {
  const { appContextOptions } = await import('../lib/runtime.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-csp-'));
  const saved = { SAMPLES_CONTROLS_HOME: process.env.SAMPLES_CONTROLS_HOME, AI_DEMOKIT_HOME: process.env.AI_DEMOKIT_HOME };
  try {
    const corpus = path.join(base, 'samples-controls');
    fs.mkdirSync(path.join(corpus, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(corpus, 'scripts', 'e2e-build.mjs'), '');
    process.env.SAMPLES_CONTROLS_HOME = corpus;
    delete process.env.AI_DEMOKIT_HOME;
    assert.equal(appContextOptions().bypassCSP, undefined, 'a corpus without its npm install: CDN, the page\'s own CSP');
    fs.mkdirSync(path.join(corpus, 'node_modules', '@openui5', 'sap.m', 'src'), { recursive: true });
    assert.equal(appContextOptions().bypassCSP, true);
    assert.deepEqual(appContextOptions().viewport, { width: 1280, height: 800 });
    process.env.SAMPLES_CONTROLS_HOME = path.join(base, 'nowhere');
    assert.equal(appContextOptions().bypassCSP, undefined, 'no corpus: CDN');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- linter lookup ----

/* app-template ships @abap2ui5/linter as a devDependency, and the server
 * started in such a project said "linter checkout not found - clone it as a
 * sibling". The project's install and the server's own node_modules are
 * candidates now, after the checkout siblings (and after a set env var, which
 * still decides alone). */
test('an installed @abap2ui5/linter is a linter candidate: the project\'s, then the server\'s own', () => {
  const project = path.join(os.tmpdir(), 'some-project');
  const c = viewCheckCandidates({ cwd: project });
  const inProject = path.join(project, 'node_modules', '@abap2ui5', 'linter');
  const inServer = path.join(SERVER_ROOT, 'node_modules', '@abap2ui5', 'linter');
  assert.ok(c.includes(inProject), 'the project the server runs in');
  assert.ok(c.includes(inServer), 'installed beside the server');
  assert.ok(c.indexOf(path.join(SERVER_ROOT, '..', 'linter')) < c.indexOf(inProject), 'a sibling checkout still comes first');
  assert.ok(c.indexOf(inProject) < c.indexOf(inServer));
});

// ---------------------------------------------------------- validate_view ----

/* A render gate that cannot START (no @abap2ui5/linter-render, a Chromium
 * that will not launch) throws out of the linter. validate_view used to
 * return that throw - an error, or 5 KB of Playwright's ANSI launch log - and
 * lose the property findings that had already been computed. */
test('validate_view falls back to the property gate when the render gate cannot start', async () => {
  const { withRenderFallback, renderFailureReason, renderSkippedNote } = await import('../lib/validate.mjs');
  const launchLog = '\u001b[31mbrowserType.launch: Target page, context or browser has been closed\u001b[39m\nBrowser logs:\n\n<launching> /opt/x --no-sandbox ' + 'x'.repeat(5000);
  const calls = [];
  const res = await withRenderFallback({
    render: true,
    withRender: async () => { calls.push('render'); throw new Error(launchLog); },
    withoutRender: async () => { calls.push('properties'); return { findings: [{ type: 'unknown-icon' }], notes: [] }; },
  });
  assert.deepEqual(calls, ['render', 'properties']);
  assert.deepEqual(res.result.findings, [{ type: 'unknown-icon' }], 'the property findings survive');
  assert.equal(res.renderSkipped, 'browserType.launch: Target page, context or browser has been closed');
  assert.ok(!/\u001b/.test(res.renderSkipped), 'no terminal colour codes');
  assert.match(renderSkippedNote(res.renderSkipped), /property findings only/);
  assert.ok(renderFailureReason(new Error('y'.repeat(1000))).length <= 300);

  // a clean render: nothing skipped, no second run
  const ok = await withRenderFallback({ render: true, withRender: async () => ({ findings: [] }), withoutRender: async () => { throw new Error('not called'); } });
  assert.equal(ok.renderSkipped, null);
  // render: false asked for, so the throw is about something else - it stands
  await assert.rejects(withRenderFallback({ render: false, withRender: async () => { throw new Error('parse'); }, withoutRender: async () => ({}) }), /parse/);
});

/* A warm renderer that THROWS mid-call (a wedged page its dead browser could
 * not reload) is retired and the check run cold - not handed to the
 * fallback above, which answered the property findings alone with a note
 * that the render gate "could not start". Composed the way validate_view
 * composes them. */
/* The hint explained an event without a handler whenever any hint was left
 * - beside an unused namespace or get_event_arg( 1 ), which have nothing to
 * do with events (seen on bench task 13's reference and samples-controls
 * 533) - and never pointed at fix_view for the fixable ones. */
test('the validate_view hint is about the findings that are left', async () => {
  const { validateHint } = await import('../lib/validate.mjs');
  const ns = { type: 'unused-namespace-declaration', severity: 'hint', fixable: true };
  const ev = { type: 'event-without-handler', severity: 'hint' };
  const old = { type: 'member-too-new', severity: 'warning' };
  assert.equal(validateHint({ error: 0, warning: 0, hint: 1 }, [ns]), 'hints are advisory, ok stays true; fix_view clears the ones marked fixable: true');
  assert.equal(validateHint({ error: 0, warning: 0, hint: 1 }, [ev]), 'hints are advisory, ok stays true - an event without a handler is intended when the roundtrip alone is the point');
  assert.doesNotMatch(validateHint({ error: 0, warning: 0, hint: 1 }, [ns]), /event/, 'no event talk without an event finding');
  assert.match(validateHint({ error: 0, warning: 1, hint: 1 }, [old, ns]), /^what is left is about the UI5 version you target.*; fix_view clears the ones marked fixable: true$/);
  assert.doesNotMatch(validateHint({ error: 0, warning: 1, hint: 0 }, [old]), /fix_view/);
  assert.equal(validateHint({ error: 1, warning: 0, hint: 0 }, []), undefined);
  assert.equal(validateHint({ error: 0, warning: 0, hint: 0 }, []), undefined);
});

test('validate_view retries a throwing warm renderer cold before falling back', async () => {
  const { withRenderFallback, warmThenCold } = await import('../lib/validate.mjs');
  const calls = [];
  const rendered = { findings: [], renderErrors: ['Unknown control sap.m.Buton'] };
  const res = await withRenderFallback({
    render: true,
    withRender: () => warmThenCold({
      warm: async () => { calls.push('warm'); throw new Error('page.reload: Target page, context or browser has been closed'); },
      cold: async () => { calls.push('cold'); return rendered; },
      drop: async () => { calls.push('drop'); },
      looksDead: () => false,
    }),
    withoutRender: async () => { calls.push('properties'); return { findings: [] }; },
  });
  assert.deepEqual(calls, ['warm', 'drop', 'cold']);
  assert.equal(res.renderSkipped, null, 'the render gate ran - cold');
  assert.equal(res.result, rendered);

  // a dead browser that did not throw: dropped and retried cold too
  const dead = [];
  const r2 = await warmThenCold({
    warm: async () => { dead.push('warm'); return { renderErrors: ['HARNESS: browser has been closed'] }; },
    cold: async () => { dead.push('cold'); return rendered; },
    drop: async () => { dead.push('drop'); },
    looksDead: (r) => r.renderErrors.length > 0,
  });
  assert.deepEqual(dead, ['warm', 'drop', 'cold']);
  assert.equal(r2, rendered);
  // a healthy warm run is the answer, nothing dropped
  const healthy = await warmThenCold({ warm: async () => rendered, cold: async () => { throw new Error('not called'); }, drop: async () => { throw new Error('not called'); }, looksDead: () => false });
  assert.equal(healthy, rendered);
  // a cold run that throws too is the fallback's case, with ITS reason
  const both = await withRenderFallback({
    render: true,
    withRender: () => warmThenCold({ warm: async () => { throw new Error('warm'); }, cold: async () => { throw new Error('no chromium'); }, drop: async () => {}, looksDead: () => false }),
    withoutRender: async () => ({ findings: [] }),
  });
  assert.equal(both.renderSkipped, 'no chromium');
});

// ------------------------------------------------------- small contracts ----

/* The generation_rules footer linked docs/cookbook/overview, a page the site
 * never had. Every docs URL this repository hands out is checked against the
 * docs sources when a local docs checkout is there (the CI smoke job clones
 * one); on a bare checkout there is nothing to check against. */
test('every abap2ui5.github.io/docs link the server or README hands out names a real page', async (t) => {
  const { resolveDocs } = await import('../lib/repos.mjs');
  const docs = resolveDocs({ local: true });
  if (!docs) return t.skip('no local docs checkout');
  const files = ['server.mjs', 'README.md', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`)];
  const seen = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/https:\/\/abap2ui5\.github\.io\/docs\/([A-Za-z0-9_./-]+)/g)) {
      const page = m[1].replace(/#.*$/, '').replace(/\.(html|md)$/, '').replace(/\/$/, '/index');
      if (!page || page.includes('...') || seen.has(page)) continue;
      seen.add(page);
      assert.ok(fs.existsSync(path.join(docs, 'docs', `${page}.md`)), `${f} links docs/${m[1]}, which is no page (docs/${page}.md)`);
    }
  }
  assert.ok(seen.size > 0);
});

/* scaffold_app's schema advertised ^[zy]c[lx]_ while the template (and the
 * fallback here) enforce ^z(cl|cx)_ - an agent following the schema got
 * `ycl_…` refused. */
test('scaffold_app advertises the class rule it enforces', async () => {
  const { TOOLS } = await import('../lib/tools.mjs');
  const { classNameRule } = await import('../lib/scaffold.mjs');
  const desc = TOOLS.find((x) => x.name === 'scaffold_app').inputSchema.properties.class.description;
  const prefix = classNameRule(null).rule.split('[')[0]; // ^z(cl|cx)_
  assert.ok(desc.includes(prefix), `the schema says ${desc}`);
  assert.doesNotMatch(desc, /\[zy\]/);
});

test('a list argument\'s error shows an example of THAT argument', () => {
  assert.throws(() => stringArray('zcl_x', { name: 'class_names', example: '["zcl_my_app"]' }), /e\.g\. \["zcl_my_app"\]/);
  assert.throws(() => stringArray([], { name: 'class_names', example: '["zcl_my_app"]' }), /e\.g\. \["zcl_my_app"\]/);
  assert.throws(() => stringArray('sap.m.Wizard', { name: 'entities' }), /e\.g\. \["sap\.m\.Wizard"\]/, 'the default stays scope_of\'s');
});

/* `capabilities { query: 42 }` answered "query.toLowerCase is not a
 * function". Every string-typed argument is checked against the tool's own
 * schema before its handler runs. */
test('a string argument that is not a string is refused by name, for every tool', async () => {
  const { TOOLS } = await import('../lib/tools.mjs');
  const tool = (n) => TOOLS.find((x) => x.name === n);
  assert.throws(() => checkStringArgs(tool('capabilities'), { query: 42 }), /query must be a string, not 42 \(number\)/);
  assert.throws(() => checkStringArgs(tool('validate_view'), { xml: ['<x/>'] }), /xml must be a string.*an array/);
  assert.throws(() => checkStringArgs(tool('scaffold_app'), { class: { a: 1 } }), /class must be a string/);
  checkStringArgs(tool('capabilities'), { query: 'popup', status: undefined });
  checkStringArgs(tool('capabilities'), { query: null });
  checkStringArgs(tool('examples'), { limit: 5 }); // a number where the schema says number
  checkStringArgs(undefined, { anything: 1 }); // an unknown tool is the handler's to report
  // every string-typed property of every tool is covered by the one check
  for (const t of TOOLS) {
    for (const [name, schema] of Object.entries(t.inputSchema.properties || {})) {
      if (schema.type !== 'string') continue;
      assert.throws(() => checkStringArgs(t, { [name]: 7 }), new RegExp(`${name} must be a string`), `${t.name}.${name}`);
    }
  }
});

/* The handlers read booleans as `=== true` / `=== false`, so a client that
 * stringified them got the default without a word: add_agent_setup with
 * dry_run "true" WROTE into the project, migrate_report deploy "true"
 * deployed nothing. And screenshot_view's model "..." was spread into the
 * derived model one character per key. Both are checked against the schema
 * like the strings. */
test('a boolean or object argument of the wrong type is refused by name, for every tool', async () => {
  const { TOOLS } = await import('../lib/tools.mjs');
  const tool = (n) => TOOLS.find((x) => x.name === n);
  assert.throws(() => checkStringArgs(tool('add_agent_setup'), { dry_run: 'true' }), /dry_run must be a boolean.*"true" \(string\)/);
  assert.throws(() => checkStringArgs(tool('migrate_report'), { source: 'x', deploy: 1 }), /deploy must be a boolean/);
  assert.throws(() => checkStringArgs(tool('screenshot_view'), { model: 'T_ITEMS' }), /model must be an object/);
  assert.throws(() => checkStringArgs(tool('screenshot_view'), { model: [{ A: 1 }] }), /model must be an object.*an array/);
  checkStringArgs(tool('add_agent_setup'), { dry_run: false });
  checkStringArgs(tool('screenshot_view'), { model: { T_ITEMS: [] } });
  checkStringArgs(tool('verify_app'), { boot: null, render: undefined });
  for (const t of TOOLS) {
    for (const [name, schema] of Object.entries(t.inputSchema.properties || {})) {
      if (schema.type === 'boolean') {
        assert.throws(() => checkStringArgs(t, { [name]: 'false' }), new RegExp(`${name} must be a boolean`), `${t.name}.${name}`);
      }
      if (schema.type === 'object') {
        assert.throws(() => checkStringArgs(t, { [name]: 'x' }), new RegExp(`${name} must be an object`), `${t.name}.${name}`);
      }
    }
  }
});

/* setup_status only knew three hard-coded paths (one of them a sandbox
 * image's /opt/pw-browsers link), so a machine with a perfectly good
 * Playwright-managed Chromium was reported as having none. */
test('the Chromium is the explicit one, then Playwright\'s own, then a system binary', async () => {
  const { resolveChromium } = await import('../lib/runtime.mjs');
  const has = (...paths) => (p) => paths.includes(p);
  const managed = () => '/home/u/.cache/ms-playwright/chromium-1/chrome';
  assert.deepEqual(resolveChromium({ env: {}, exists: has('/home/u/.cache/ms-playwright/chromium-1/chrome', '/usr/bin/chromium'), managed }),
    { path: '/home/u/.cache/ms-playwright/chromium-1/chrome', source: 'playwright', exists: true });
  assert.deepEqual(resolveChromium({ env: {}, exists: has('/usr/bin/chromium', '/opt/pw-browsers/chromium'), managed }),
    { path: '/usr/bin/chromium', source: 'system', exists: true }, 'the sandbox link is the last resort');
  assert.deepEqual(resolveChromium({ env: {}, exists: has('/opt/pw-browsers/chromium'), managed: () => null }),
    { path: '/opt/pw-browsers/chromium', source: 'system', exists: true });
  assert.deepEqual(resolveChromium({ env: { A2UI5_MCP_CHROMIUM: '/x/chrome', CHROMIUM_BIN: '/y' }, exists: has(), managed }),
    { path: '/x/chrome', source: 'A2UI5_MCP_CHROMIUM', exists: false }, 'an explicit choice is reported even when it is wrong');
  assert.equal(resolveChromium({ env: { CHROMIUM_BIN: '/y' }, exists: has('/y'), managed }).source, 'CHROMIUM_BIN');
  assert.equal(resolveChromium({ env: {}, exists: has(), managed }), null);
});

// ------------------------------------------------------------- setup.sh ----
/* setup.sh reuses an existing checkout under any directory name it carried
 * before a rename - by its own list, a second copy of lib/repo-dirs.json. It
 * left out `abap2UI5-api`, so a corpus checked out under that name was cloned
 * a second time as samples-controls. Pinned against the JSON. */
test('setup.sh reuses every directory name lib/repo-dirs.json knows for the checkouts it clones', async () => {
  const { REPO_DIRS } = await import('../lib/repos.mjs');
  const script = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
  const calls = [...script.matchAll(/^[ \t]*ensure_repo[ \t]+(\S+)[ \t]+(\S+)((?:[ \t]+\S+)*)[ \t]*$/gm)]
    .map((m) => [m[1], ...m[3].trim().split(/[ \t]+/).filter(Boolean)]);
  assert.ok(calls.length >= 3, 'setup.sh ensure_repo calls found');
  for (const dirs of calls) {
    const entry = Object.values(REPO_DIRS).find((r) => r.dirs[0] === dirs[0]);
    assert.ok(entry, `setup.sh clones ${dirs[0]}, which repo-dirs.json does not name`);
    assert.deepEqual(dirs, entry.dirs, `setup.sh's names for ${dirs[0]}`);
  }
});

// ------------------------------------- markdown parsers over runs of blanks ----

/* The patterns these parsers used: a lazy group or a \s* in front of another
 * \s* retried every split of a run of blanks - quadratic for a heading, cubic
 * for a catalogue row ('| ' + 1000 blanks + '|' took 85 s). The rewrites must
 * match the same lines and capture the same text. */
const OLD_ROW = /^\|\s*(?:\*\*(?<title>[^*]+)\*\*\s*(?:(?:—|--)\s*)?)?(?<sub>[^|<]*?)\s*(?<blocks>(?:<br>(?:<[a-z]+>[^<]*<\/[a-z]+>|[^<]*))*)\s*\|\s*\[`(?<cls>[A-Z0-9_]+)`\]\((?<path>[^)]+)\)\s*\|/;
/* ROW_PATTERN is OLD_ROW with its blanks kept atomically - what lib/examples.mjs
 * matched with until matchRow spelled it out (its link scan was quadratic). */
const ROW_PATTERN = /^\|(?=(\s*))\1(?:\*\*(?<title>[^*]+)\*\*(?=(\s*))\3(?:(?:—|--)(?=(\s*))\4)?)?(?=(?<sub>[^|<]*))\k<sub>(?<blocks>(?:<br>(?:<[a-z]+>[^<]*<\/[a-z]+>|[^<]*(?!\s)))*)\s*\|\s*\[`(?<cls>[A-Z0-9_]+)`\]\((?<path>[^)]+)\)\s*\|/;
/* mulberry32: an LCG over doubles taken mod n loses its low bits (seeded(7)
 * answered rnd(12) with 0, 4 and 8 only), and the fuzzers then never built
 * most of the rows they list */
const seeded = (seed) => (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const LS = String.fromCharCode(0x2028);

test('matchRow matches what the row patterns matched, with the same groups', () => {
  const rnd = seeded(7);
  const pick = (a) => a[rnd(a.length)];
  const ws = () => pick(['', ' ', '  ', '\t', ' \r ', '   ', LS, '\u00a0']);
  const part = () => pick(['', 'a', 'a b', 'x | y', 'a*b', 'a — b', '--x', '<x', '|', '*', '**', ')', '(', '[`', '`', 'Z', '<br>', '</b>', '<b>']);
  const block = () => pick(['<br>' + part(), `<br><sub>${part()}</sub>`, `<br><i>${part()}</i>`, '<br>', '<br><sub>docs: [a](b)</sub>', `<br>${part()} | [\`Z\`](z) `,
    '<br><br>x</b>', `<br><${pick(['br', 'b', 'sub', ''])}>${part()}</${pick(['b', 'sub', '', 'x1'])}>`, '<br> ', '<br>' + ws() + part() + ws()]);
  const link = () => pick(['[`A`](p)', '[`B_2`](s/y.abap)', '[`A`](p)', '[`A_1`](src/x.abap)', '[`a`](p)', '[`A`]()', '[`A`](p', 'A', '[``](p)', '[`A`] (p)', '[`A`](p))', '[`A`](p|q)']);
  const toks = ['|', ' ', '<br>', '<b>', '</b>', '[`A`](', 'p)', ')', '**', '—', '--', 'a', '\t', '<', '>', '/', 'Z'];
  const exact = (m) => m && { title: m.groups.title, sub: m.groups.sub, blocks: m.groups.blocks, cls: m.groups.cls, path: m.groups.path, end: m[0].length };
  const trimmed = (g) => g && { ...g, sub: (g.sub || '').trim() };
  let matched = 0;
  for (let k = 0; k < 60000; k += 1) {
    let s;
    if (rnd(4) === 0) {
      s = '|';
      for (let j = rnd(20); j > 0; j -= 1) s += pick(toks);
    } else {
      s = '|' + ws() + (rnd(2) ? `**${part()}**${ws()}${pick(['', '— ', '-- ', '—', '--', '-'])}${ws()}` : '') + part() + ws();
      for (let b = rnd(5); b > 0; b -= 1) s += block() + ws();
      s += pick(['|', '', ' |']) + ws() + link() + ws() + pick(['|', '', ' |', '| x |']) + pick(['', ' | [`B`](q) |', ' x', '<br>|[`C`](r)|']);
      if (rnd(5) === 0) { const at = rnd(s.length); s = s.slice(0, at) + s.slice(at + 1 + rnd(3)); }
      if (rnd(8) === 0) { const at = rnd(s.length); s = s.slice(0, at) + pick(toks) + s.slice(at); }
    }
    const row = matchRow(s);
    if (row) matched += 1;
    assert.deepEqual(row, exact(ROW_PATTERN.exec(s)), JSON.stringify(s));
    // the first pattern's sub kept no trailing blanks; parseExamples trims it
    assert.deepEqual(trimmed(row), trimmed(exact(OLD_ROW.exec(s))), JSON.stringify(s));
  }
  assert.ok(matched > 5000, `the generator makes rows that match (${matched})`);
});

test('markdownLinks finds what the link patterns found, and plain() replaces them alike', () => {
  const rnd = seeded(5);
  const toks = ['[', ']', '(', ')', 'a', ' ', '\n', '[a](', '](', '[]', '()', 'b c'];
  const viaRegex = (re, s) => [...s.matchAll(re)].map((m) => ({ index: m.index, end: m.index + m[0].length, text: m[1], target: m[2] }));
  let found = 0;
  for (let k = 0; k < 100000; k += 1) {
    let s = '';
    for (let n = rnd(k % 10 === 0 ? 60 : 14); n > 0; n -= 1) s += toks[rnd(toks.length)];
    const links = markdownLinks(s);
    assert.deepEqual(links, viaRegex(/\[([^\]]+)\]\(([^)]*)\)/g, s), JSON.stringify(s));
    assert.deepEqual(markdownLinks(s, { emptyTarget: false }), viaRegex(/\[([^\]]+)\]\(([^)]+)\)/g, s), JSON.stringify(s));
    if (links.length) found += 1;
    // the page title goes through plain(): link text kept, targets dropped, as the pattern did
    const title = ((`# ${s}`.match(/^#\s+(\S.*)?/m) || [])[1] || '').trim();
    const old = title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(slicePage(`# ${s}`).title, old, JSON.stringify(s));
  }
  assert.ok(found > 10000, `the generator makes links (${found})`);
});

test('headingText is the heading regex: same lines, same text', () => {
  const rnd = seeded(11);
  const toks = ['#', '#', '#', ' ', ' ', '\t', '\r', LS, 'a', 'b c', '*', '—', ' '];
  for (let k = 0; k < 60000; k += 1) {
    let s = '';
    for (let n = rnd(10); n > 0; n -= 1) s += toks[rnd(toks.length)];
    for (const [min, max] of [[1, 4], [2, 3]]) {
      const m = new RegExp(`^#{${min},${max}}\\s+(.+?)\\s*$`).exec(s);
      assert.equal(headingText(s, min, max), m ? m[1] : null, JSON.stringify(s));
    }
    const page = `${s}\n${toks[rnd(toks.length)]}\n# t`;
    // slicePage hands the title to plain(): links, * and ` dropped, blanks folded
    const old = (page.match(/^#\s+(.+?)\s*$/m) || [, ''])[1].trim().replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(slicePage(page).title, old, JSON.stringify(page));
  }
});

test('catalogue rows and doc headings take linear time over a run of blanks', () => {
  const blanks = ' '.repeat(100000);
  const t0 = Date.now();
  assert.deepEqual(parseExamples(`| ${blanks}|\n## a${blanks}b\n| **t** a${blanks}b |\n| **t** a<br>${blanks}| [\`X\`](p) x`), []);
  const [row] = parseExamples(`## S${blanks}\n| **T** ${blanks}— s${blanks}<br>sum${blanks}| [\`Z_A\`](src/z_a.clas.abap)${blanks}|`);
  assert.deepEqual([row.section, row.title, row.sub, row.summary, row.cls], ['S', 'T', 's', 'sum', 'Z_A']);
  const page = slicePage(`# a${blanks}b\n## c${blanks}\r${blanks}\n#${blanks}`);
  assert.equal(page.title, `a b`);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

/* 0.4 s for a 50k row of "|[`A`](" (the link's `\(([^)]+)\)` scanned to the
 * next parenthesis from every end a block could have), 3 s for 50k `[` in a
 * docs page (the link text scanned to the next `]` from every `[`) */
test('catalogue rows and markdown links take linear time over runs of link openers', () => {
  const n = 400000;
  const t0 = Date.now();
  assert.deepEqual(parseExamples(`| a<br>${'|[`A`]('.repeat(n / 7)}\n| a<br>${'|[`A`]('.repeat(n / 7)})`), []);
  assert.deepEqual(parseExamples(`|${'<br>'.repeat(n / 4)}`), []);
  const [row] = parseExamples(`| **T** s<br><sub>docs: ${'['.repeat(n)}[a](u)</sub> | [\`Z_A\`](p) |`);
  assert.deepEqual(row.docs, [{ topic: '['.repeat(n) + 'a', url: 'u' }]);
  for (const body of ['['.repeat(n), '[a]('.repeat(n / 4), '[a'.repeat(n / 2)]) {
    assert.equal(slicePage(`# t ${body}`).title.length, 2 + body.length);
    // the snippet flattens the section body through plain()
    assert.equal(searchDocs({ query: 'zz', pages: [{ path: 'p', text: `# zz\n${body}` }] }).length, 1);
  }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

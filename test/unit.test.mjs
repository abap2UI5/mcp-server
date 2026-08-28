// Sibling-free unit tests (node --test): every unit here runs without the
// ai-demokit / abap2UI5 / linter checkouts. The stdio smoke lives in
// test/smoke.test.mjs and DOES need the siblings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonc, BENIGN, deployApp, removeApp } from '../lib/runtime.mjs';
import { parseCapabilities, searchCapabilities } from '../lib/capabilities.mjs';
import { parseExamples, searchExamples, catalogueEntries, CATALOGUES } from '../lib/examples.mjs';
import { CORPUS_DIRS, resolveLintConfig } from '../lib/repos.mjs';
import { sliceCatalogue } from '../lib/pitfalls.mjs';
import { sliceGuide, guideChapters } from '../lib/guide.mjs';
import { parseApi, searchApi, apiSummary } from '../lib/api.mjs';
import { searchDocs } from '../lib/docs.mjs';
import { parseSizes } from '../lib/screenshot.mjs';
import { oneOf, boundedInt } from '../lib/args.mjs';
import { scaffold, validClassName, templateFiles, readSpec } from '../lib/scaffold.mjs';
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
// error paths are sibling-free. (The happy path writes into ai-demokit and
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
  for (const good of ['zcl_app_001', 'ycl_app', 'z2ui5_cl_my_app', 'zcx_error']) {
    // it gets past validation - what stops it here is the missing corpus
    // checkout it would write into, which is a different error entirely
    assert.doesNotThrow(
      () => { try { deployApp({ className: good, source: source(good) }); } catch (e) {
        if (/invalid class name/.test(e.message)) throw e;
      } },
      `expected '${good}' to pass the name gate`,
    );
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

// ------------------------------------------------------- BENIGN filter ----

test('BENIGN patterns match known console noise and not real errors', () => {
  const noise = BENIGN.some((re) => re.test('Failed to load resource: favicon.ico 404'));
  const real = BENIGN.some((re) => re.test("TypeError: Cannot read properties of undefined (reading 'getModel')"));
  assert.equal(noise, true); // known console noise is filtered
  assert.equal(real, false); // a real JS error is never swallowed
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
  for (const bad of ['abc', {}, NaN, Infinity]) {
    assert.throws(() => boundedInt(bad, opts), /limit must be a number/, `expected rejection for ${String(bad)}`);
  }
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
  for (const ok of ['zcl_my_app', 'ycl_app', 'zcx_error', 'zcl_a1_b2']) {
    assert.equal(validClassName(ok), true, ok);
  }
  for (const bad of ['', 'zcl_', 'cl_my_app', 'zcl-my-app', '../etc/passwd',
    'zcl_app/../../x', 'zcl_my app', 'zcl_' + 'x'.repeat(30)]) {
    assert.equal(validClassName(bad), false, "expected refusal for '" + bad + "'");
  }
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

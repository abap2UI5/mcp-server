// Answers that fit a client (lib/budget.mjs).
//
// Claude Code refuses a tool result over 25,000 tokens and the agent then
// sees NOTHING. Three defaults went over: scaffold_app (~280 KB, the whole
// template), pitfalls without a query (~120 KB) and examples with a large
// limit (~135 KB) - and later capabilities and api_reference with a broad
// query. They are paged now, and every page names the arguments that fetch
// the rest - these tests walk the pages to the end and check that nothing
// was lost on the way. run_unit_tests counts a long run per object. Sibling-free: the checkouts are fakes built in
// a temp dir and pointed at through the (authoritative) env vars.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ANSWER_BUDGET, sizeOf, takeWithin, takeSmallestWithin, fitSnapshot, fitUnitResult } from '../lib/budget.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 90_000; // characters: comfortably under the client's token cap for this kind of text

function fakes() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-paging-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), text);
  };
  // app-template: three big documents and the small files a project needs
  const big = (tag) => `# ${tag}\n` + `${tag} line of prose that goes on for a while.\n`.repeat(900);
  write('app-template/abaplint.jsonc', '{ "rules": {} }\n');
  write('app-template/AGENTS.md', big('AGENTS'));
  write('app-template/skills/a/SKILL.md', big('SKILLA'));
  write('app-template/skills/b/SKILL.md', big('SKILLB'));
  write('app-template/package.json', '{ "name": "app" }\n');
  write('app-template/src/zcl_app_001.clas.abap', 'CLASS zcl_app_001 DEFINITION PUBLIC.\nENDCLASS.\n');
  write('app-template/src/zcl_app_001.clas.xml', '<CLSNAME>ZCL_APP_001</CLSNAME>\n');
  write('app-template/template.json', JSON.stringify({
    placeholderClass: 'zcl_app_001',
    files: {
      shared: ['AGENTS.md', 'skills/a/SKILL.md', 'abaplint.jsonc', 'skills/b/SKILL.md', 'package.json'],
      named: ['src/zcl_app_001.clas.abap', 'src/zcl_app_001.clas.xml'],
    },
    substitutions: {
      class: { files: ['src/zcl_app_001.clas.abap', 'src/zcl_app_001.clas.xml'], renamesPath: true, rule: '^z(cl|cx)_[a-z0-9_]{1,26}$', maxLength: 30 },
      packageText: [],
      repo: [],
    },
  }));
  // the framework: a pitfalls catalogue far over one answer
  write('abap2UI5/node/srv/express.mjs', '// probe');
  // the client API: far more documented methods than one answer carries
  const doc = (i) => Array.from({ length: 8 }, (_, k) => `  "! Entry ${i} documentation line ${k} - what the method does, in some detail, for a while.`).join('\n');
  const methods = Array.from({ length: 120 }, (_, i) => `${doc(i)}\n  "!\n  "! @parameter val | the value of entry ${i}\n  METHODS method_${String(i).padStart(3, '0')}\n    IMPORTING\n      val TYPE clike OPTIONAL.\n`);
  write('abap2UI5/src/02/z2ui5_if_client.intf.abap', [
    'INTERFACE z2ui5_if_client',
    '  PUBLIC.',
    '',
    '  CONSTANTS:',
    '    BEGIN OF cs_event,',
    '      entry_close TYPE string VALUE `ENTRY_CLOSE`,',
    '    END OF cs_event.',
    '',
    ...methods,
    'ENDINTERFACE.',
    '',
  ].join('\n'));
  // the capability map: far more matching rows than one answer carries
  const DIRECT = String.fromCodePoint(0x2705);
  write('samples-controls/scripts/e2e-build.mjs', '// probe\n');
  write('samples-controls/CAPABILITIES.md', [
    '# Capabilities', '', '## Controls', '',
    '| UI5 feature | Status | How | Evidence |', '|---|---|---|---|',
    ...Array.from({ length: 400 }, (_, i) => `| Feature ${i} | ${DIRECT} direct | ${'how it is expressed in abap2UI5 '.repeat(4)} | z2ui5_cl_port_${i} |`),
    '',
  ].join('\n'));
  // a built backend whose runner has one class with 600 tests (over the
  // budget indented, under it compact) and one with 1,500 (over both)
  write('abap2UI5/node/output/init.mjs', '// fake\n');
  write('abap2UI5/node/output/index.mjs', [
    'function getData() {',
    '  const out = [];',
    "  for (let i = 0; i < 600; i++) out.push({ objectName: 'ZCL_MID', localClass: 'LTCL_TEST', method: 'TEST_METHOD_NUMBER_' + i });",
    "  for (let i = 0; i < 1500; i++) out.push({ objectName: 'ZCL_BIG', localClass: 'LTCL_TEST', method: 'TEST_METHOD_NUMBER_' + i });",
    '  return out;',
    '}',
    'for (const st of getData()) {',
    '  console.log(`${st.objectName}: running ${st.localClass}->${st.method}`);',
    '}',
    '',
  ].join('\n'));
  const sections = Array.from({ length: 40 }, (_, i) => `## Case ${i + 1}\n\n` + `evidence for case ${i + 1}. `.repeat(250));
  write('abap2UI5/.claude/skills/abap-check/SKILL.md', `---\nname: abap-check\n---\nPreamble.\n\n${sections.join('\n\n')}\n`);
  write('abap2UI5/.claude/skills/ui5-check/SKILL.md', '---\nname: ui5-check\n---\nPreamble.\n\n## View case\n\nsmall\n');
  // a sample catalogue with many rows
  const rows = Array.from({ length: 400 }, (_, i) => `| **Sample ${i}** — table demo number ${i}<br>${'a long summary of what it shows '.repeat(6)}<br><sub>table demo</sub> | [\`Z2UI5_CL_SMP_APP_${String(i).padStart(3, '0')}\`](src/01/z2ui5_cl_smp_app_${i}.clas.abap) |`);
  write('samples/SAMPLES.md', ['# Samples', '', '## Tables', '', '| Sample | Class |', '|---|---|', ...rows].join('\n'));
  return base;
}

async function withServer(fn) {
  const base = fakes();
  const nowhere = path.join(base, 'nowhere');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: {
      ...process.env,
      APP_TEMPLATE_HOME: path.join(base, 'app-template'),
      A2UI5_HOME: path.join(base, 'abap2UI5'),
      SAMPLES_HOME: path.join(base, 'samples'),
      SAMPLES_CONTROLS_HOME: path.join(base, 'samples-controls'),
      AI_DEMOKIT_HOME: '',
      SAMPLES_STACK_HOME: nowhere,
      AI_VIEW_CHECK_HOME: nowhere,
      DOCS_HOME: nowhere,
      A2UI5_MCP_REMOTE: '0',
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'paging', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      const t = r.content[0].text;
      assert.ok(!r.isError, `${name} errored: ${t.slice(0, 500)}`);
      assert.ok(t.length < LIMIT, `${name} ${JSON.stringify(args)} answered ${t.length} characters`);
      return JSON.parse(t);
    });
  } finally {
    await client.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('scaffold_app pages the template: the small files first, then every other one on request', async () => {
  await withServer(async (call) => {
    const first = await call('scaffold_app', { class: 'zcl_my_app' });
    const got = new Map(first.files.map((f) => [f.path, f.text]));
    for (const must of ['src/zcl_my_app.clas.abap', 'src/zcl_my_app.clas.xml', 'abaplint.jsonc', 'package.json']) {
      assert.ok(got.has(must), `${must} is on the first page`);
    }
    assert.match(got.get('src/zcl_my_app.clas.xml'), /ZCL_MY_APP/, 'renamed on a page like before');
    let remaining = first.remaining.map((r) => r.path);
    assert.ok(remaining.length > 0, 'the big documents did not all fit');
    assert.match(first.more, /files:/);
    for (let i = 0; remaining.length && i < 10; i++) {
      const page = await call('scaffold_app', { class: 'zcl_my_app', files: remaining });
      for (const f of page.files) got.set(f.path, f.text);
      remaining = (page.remaining || []).map((r) => r.path);
    }
    assert.equal(remaining.length, 0, 'the pages end');
    assert.equal(got.size, 7, 'every template file arrived exactly once');
    assert.match(got.get('AGENTS.md'), /^# AGENTS/);
  });
});

test('pitfalls pages its sections and every section arrives once', async () => {
  await withServer(async (call) => {
    const seen = [];
    let offset = 0;
    let total = null;
    for (let i = 0; i < 20; i++) {
      const page = await call('pitfalls', offset ? { offset } : {});
      total = page.matches;
      for (const c of page.catalogues) for (const s of c.sections) seen.push(`${c.area}:${s.heading}`);
      const m = page.more && /offset: (\d+)/.exec(page.more);
      if (!m) break;
      offset = Number(m[1]);
    }
    assert.equal(total, 43, 'two preambles, 40 abap cases, one view case');
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'no section twice');
    assert.ok(seen.includes('abap:Case 40') && seen.includes('view:View case'));
  });
});

test('examples pages a large limit instead of answering past the client cap', async () => {
  await withServer(async (call) => {
    const first = await call('examples', { query: 'table', repo: 'samples', limit: 200 });
    assert.equal(first.matches, 400);
    assert.ok(first.returned < 200, 'the budget cut the page');
    assert.ok(sizeOf(first) <= ANSWER_BUDGET, `the page is ${sizeOf(first)} characters as written - entries measured two levels deep`);
    const m = /offset: (\d+)/.exec(first.more);
    assert.equal(Number(m[1]), first.returned);
    const second = await call('examples', { query: 'table', repo: 'samples', limit: 200, offset: Number(m[1]) });
    assert.equal(second.offset, first.returned);
    assert.notEqual(second.entries[0].cls, first.entries[0].cls);
    const small = await call('examples', { query: 'table', repo: 'samples' });
    assert.equal(small.returned, 20, 'the default page is unchanged');
  });
});

/* Two tools answered every match at once: api_reference { query: "e" } was
 * ~75,000 characters, capabilities { query: "a" } ~61,000. Both page now. */
test('capabilities pages its matches and every entry arrives once', async () => {
  await withServer(async (call) => {
    const seen = [];
    let offset = 0;
    let first = null;
    for (let i = 0; i < 20; i++) {
      const page = await call('capabilities', offset ? { query: 'feature', offset } : { query: 'feature' });
      first ||= page;
      assert.ok(sizeOf(page) <= ANSWER_BUDGET, `${sizeOf(page)} characters`);
      assert.equal(page.returned, page.entries.length);
      seen.push(...page.entries.map((e) => e.feature));
      const m = page.more && /offset: (\d+)/.exec(page.more);
      if (!m) break;
      offset = Number(m[1]);
    }
    assert.equal(first.matches, 400);
    assert.ok(first.returned < 400, 'the budget cut the first page');
    assert.match(first.more, /call again with offset: \d+ \(same query and status\)/);
    assert.equal(seen.length, 400);
    assert.equal(new Set(seen).size, 400, 'no entry twice');
    const limited = await call('capabilities', { query: 'feature', limit: 5, offset: 10 });
    assert.deepEqual(limited.entries.map((e) => e.feature), ['Feature 10', 'Feature 11', 'Feature 12', 'Feature 13', 'Feature 14']);
    assert.equal(limited.offset, 10);
    assert.match(limited.more, /385 more - call again with offset: 15/);
    const small = await call('capabilities', { query: 'feature 399' });
    assert.deepEqual(small, { matches: 1, returned: 1, entries: small.entries }, 'a small answer names no page');
  });
});

test('api_reference pages its matches by entry - methods, constant groups, types - and every entry arrives once', async () => {
  await withServer(async (call) => {
    const seen = [];
    let offset = 0;
    let first = null;
    for (let i = 0; i < 20; i++) {
      const page = await call('api_reference', offset ? { query: 'entry', offset } : { query: 'entry' });
      first ||= page;
      assert.ok(sizeOf(page) <= ANSWER_BUDGET, `${sizeOf(page)} characters`);
      const names = [...(page.methods || []), ...(page.constants || []), ...(page.types || [])].map((x) => x.name);
      assert.equal(page.returned, names.length);
      seen.push(...names);
      const m = page.more && /offset: (\d+)/.exec(page.more);
      if (!m) break;
      offset = Number(m[1]);
    }
    assert.equal(first.matches, 121, '120 methods and the cs_event group');
    assert.ok(first.returned < 121, 'the budget cut the first page');
    assert.match(first.more, /\(same query and kind\)/);
    assert.equal(seen.length, 121);
    assert.equal(new Set(seen).size, 121, 'no entry twice');
    assert.ok(seen.includes('method_119') && seen.includes('cs_event'));
    const last = await call('api_reference', { query: 'entry', offset: 119, limit: 5 });
    assert.deepEqual(last.methods.map((m) => m.name), ['method_119']);
    assert.deepEqual(last.constants.map((c) => c.name), ['cs_event']);
    assert.equal(last.more, undefined);
    const kind = await call('api_reference', { query: 'entry', kind: 'constants' });
    assert.equal(kind.matches, 1);
    assert.equal(kind.methods, undefined);
  });
});

/* run_unit_tests measured the compact JSON and answered the indented one: a
 * class of 600 tests passed at 68,000 characters; past the compact budget
 * it dropped `tests` and then read tests.length - a TypeError for a single
 * class whose run passed. */
test('run_unit_tests counts a class\'s tests per object past the budget, measured as the answer is written', async () => {
  await withServer(async (call) => {
    for (const [cls, n] of [['zcl_mid', 600], ['zcl_big', 1500]]) {
      const res = await call('run_unit_tests', { class_name: cls });
      assert.ok(sizeOf(res) <= ANSWER_BUDGET, `${cls}: ${sizeOf(res)} characters`);
      assert.equal(res.ok, true);
      assert.equal(res.ran, n);
      assert.equal(res.tests, undefined);
      assert.deepEqual(res.testsPerObject, { [cls.toUpperCase()]: n });
      assert.equal(res.hint, undefined, 'a class with tests is not "no test class"');
    }
  });
});

test('fitUnitResult: a result that fits is the same object; past the budget tests are counted per object', () => {
  const small = { ok: true, ran: 1, skipped: 0, tests: [{ object: 'ZCL_A', localClass: 'L', method: 'M' }], failed: null, class: 'ZCL_A' };
  assert.equal(fitUnitResult(small), small);
  const noTests = { ok: false, aborted: true, error: 'x' };
  assert.equal(fitUnitResult(noTests), noTests);
  const tests = Array.from({ length: 750 }, (_, i) => ({ object: i % 3 ? 'ZCL_A' : 'ZCL_B', localClass: 'LTCL_TEST', method: `TEST_${i}`, ...(i % 100 ? {} : { skipped: 'by filter' }) }));
  const big = { ok: true, ran: 742, skipped: 8, tests, failed: null, class: null };
  assert.ok(JSON.stringify(big).length < 55_000 && sizeOf(big) > 55_000, 'the case the compact measure let through');
  const fit = fitUnitResult(big);
  assert.equal(fit.tests, undefined);
  assert.equal('tests' in fit, false);
  assert.deepEqual(fit.testsPerObject, { ZCL_B: 250, ZCL_A: 500 });
  assert.equal(fit.skippedTests.length, 8);
  assert.match(fit.testsNote, /counted per object/);
  assert.equal(big.tests.length, 750, 'the input is not changed');
});

test('the budget helpers keep order, always return one item, and prefer small files', () => {
  const items = [{ t: 'x'.repeat(100) }, { t: 'y'.repeat(10) }, { t: 'z'.repeat(10) }];
  assert.deepEqual(takeWithin(items, 50).taken, [items[0]], 'one item even when it alone is over');
  assert.deepEqual(takeWithin(items, 1000).rest, []);
  assert.equal(sizeOf({ a: 1, b: 2 }), 22);
  assert.equal(sizeOf({ a: 1, b: 2 }, 2), 22 + 4 * 4, 'four lines, each four spaces deeper');
  const head = '{\n  "entries": [\n';
  const tail = '\n  ]\n}';
  assert.equal(JSON.stringify({ entries: [{ a: 1, b: 2 }] }, null, 2).length, head.length + sizeOf({ a: 1, b: 2 }, 2) + tail.length,
    'depth 2 is exactly how an entry of { entries: [...] } is written');
  const files = [{ path: 'BIG', text: 'b'.repeat(ANSWER_BUDGET) }, { path: 'a', text: 'a' }, { path: 'c', text: 'c' }];
  const { taken, rest } = takeSmallestWithin(files, 1000);
  assert.deepEqual(taken.map((f) => f.path), ['a', 'c'], 'original order kept');
  assert.deepEqual(rest.map((f) => f.path), ['BIG']);
});

test('fitSnapshot: a snapshot that fits is the same; long values are cut and read-only, then rows go from the end', () => {
  const small = { snapshotVersion: 1, fields: [{ id: 'f1', value: 'x', editable: true }], tables: [] };
  assert.equal(fitSnapshot(small).snapshot, small);
  const big = {
    snapshotVersion: 1,
    fields: [{ id: 'f1', value: 'a'.repeat(120000), editable: true }, { id: 'f2', value: 'short', editable: true }],
    tables: [{ id: 't1', rowCount: 300, truncated: false, editableCells: ['NOTE', 'QTY'], rows: Array.from({ length: 300 }, (_, i) => ({ NOTE: i === 0 ? 'n'.repeat(5000) : `note ${i}`.padEnd(300, '.'), QTY: i })) }],
  };
  const { snapshot, notes } = fitSnapshot(big);
  assert.ok(JSON.stringify(snapshot).length <= ANSWER_BUDGET);
  assert.equal(snapshot.fields[0].value.length, 2003);
  assert.equal(snapshot.fields[0].editable, false);
  assert.equal(snapshot.fields[1].editable, true);
  assert.deepEqual(snapshot.tables[0].editableCells, ['QTY']);
  assert.equal(snapshot.tables[0].truncated, true);
  assert.ok(snapshot.tables[0].rows.length < 300 && snapshot.tables[0].rows.length >= 1);
  assert.equal(snapshot.tables[0].rowCount, 300);
  assert.equal(big.fields[0].value.length, 120000, 'the input is not changed');
  assert.match(notes.join(' '), /f1 are cut.*table t1: cells of NOTE.*table t1 shows its first \d+ row\(s\)/);
});

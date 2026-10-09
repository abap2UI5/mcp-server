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
import { ANSWER_BUDGET, sizeOf, takeWithin, takeSmallestWithin, fitSnapshot, fitUnitResult, fitFindings, fitRules, fitObject, fitVerifyStages, guardAnswer } from '../lib/budget.mjs';

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
  // the app-building guide: more chapters than one answer carries
  const chapters = Array.from({ length: 30 }, (_, i) => `## ${i + 1}. Chapter ${i + 1}\n\n` + `guide prose for chapter ${i + 1}. `.repeat(140));
  write('abap2UI5/docs/agents/building-apps.md', `# Building apps\n\nHow to read this guide.\n\n${chapters.join('\n\n')}\n`);
  write('abap2UI5/.claude/skills/ui5-check/SKILL.md', '---\nname: ui5-check\n---\nPreamble.\n\n## View case\n\nsmall\n');
  // the documentation site: more matching pages than one default answer lists
  write('docs/package.json', JSON.stringify({ name: 'abap2ui5-docs' }));
  write('docs/docs/index.md', '# Home\n\nThe start page.\n');
  for (let i = 0; i < 25; i++) write(`docs/docs/cookbook/page_${String(i).padStart(2, '0')}.md`, `# Page ${i}\n\n## Binding\n\nhow binding works, part ${i}.\n`);
  // a sample catalogue with many rows
  const rows = Array.from({ length: 400 }, (_, i) => `| **Sample ${i}${i < 3 ? ' button' : ''}** — table demo number ${i}<br>${'a long summary of what it shows '.repeat(6)}<br><sub>table demo</sub> | [\`Z2UI5_CL_SMP_APP_${String(i).padStart(3, '0')}\`](src/01/z2ui5_cl_smp_app_${i}.clas.abap) |`);
  write('samples/SAMPLES.md', ['# Samples', '', '## Tables', '', '| Sample | Class |', '|---|---|', ...rows].join('\n'));
  // what the linter knows: the first 50 views build a Button, three say so in their words
  write('samples/catalogue-derived.json', JSON.stringify({
    controls: ['sap.m.Button', 'sap.m.Table'],
    samples: Array.from({ length: 400 }, (_, i) => ({ class: `z2ui5_cl_smp_app_${String(i).padStart(3, '0')}`, controls: i < 50 ? [1, 0] : [1] })),
  }));
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
      DOCS_HOME: path.join(base, 'docs'),
      A2UI5_MCP_REMOTE: '0',
      A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'),
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'paging', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(async (name, args, { budget = LIMIT, error = false } = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const t = r.content[0].text;
      assert.equal(Boolean(r.isError), error, `${name} ${error ? 'did not error' : 'errored'}: ${t.slice(0, 500)}`);
      assert.ok(t.length < budget, `${name} ${JSON.stringify(args)} answered ${t.length} characters`);
      return error ? t : JSON.parse(t);
    }, base);
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

/* read_app paged by raw characters while the answer is JSON: a class whose
 * lines carry JSON templates (abap2UI5 apps build them in string templates)
 * went out with every quote and line break escaped, ~35% over the budget. */
test('read_app pages a class by lines, measured as the answer is written', async () => {
  await withServer(async (call, base) => {
    const line = '    lv_json = lv_json && `{"a":"1","b":"2","c":"3","d":"4","e":"5","f":"6"}`.';
    const total = 1600;
    const src = ['CLASS zcl_json_heavy DEFINITION PUBLIC.', ...Array.from({ length: total - 2 }, () => line), 'ENDCLASS.'].join('\n');
    const dir = path.join(base, 'samples-controls', 'src', 'zz_dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'zcl_json_heavy.clas.abap'), src);
    const seen = [];
    let from;
    for (let page = 0; page < 10; page += 1) {
      const r = await call('read_app', { class_name: 'zcl_json_heavy', ...(from ? { from_line: from } : {}) }, { budget: ANSWER_BUDGET });
      seen.push(...r.source.split('\n'));
      if (!r.next) break;
      assert.equal(r.lines.to + 1, r.next.from_line);
      from = r.next.from_line;
    }
    assert.ok(from, 'more than one page');
    assert.equal(seen.length, total, 'every line arrives once');
    assert.equal(seen.join('\n'), src);
    const past = await call('read_app', { class_name: 'zcl_json_heavy', from_line: total + 1 });
    assert.equal(past.pastEnd, `from_line ${total + 1} is past the end - the file has ${total} lines; its last line is shown`);
    assert.deepEqual(past.lines, { from: total, to: total, total });
  });
});

/* build_log answered `tail` lines (up to 2,000) whatever their length: the
 * kept log is up to 256 KiB, and a transpiler that prints long lines filled
 * an answer several times over. */
/* read_example answered a sample whole: samples-controls' largest ports
 * are 84,000 characters, past what a client accepts as one answer. */
test('read_example pages a long sample by lines and every line arrives once', async () => {
  await withServer(async (call, base) => {
    const line = '      ->input( value = client->_bind_edit( ms_data-field ) description = `{"k":"v"}` ).';
    const total = 1400;
    const src = ['CLASS z2ui5_cl_smp_app_900 DEFINITION PUBLIC.', ...Array.from({ length: total - 2 }, () => line), 'ENDCLASS.'].join('\n');
    fs.mkdirSync(path.join(base, 'samples', 'src', '01'), { recursive: true });
    fs.writeFileSync(path.join(base, 'samples', 'src', '01', 'z2ui5_cl_smp_app_900.clas.abap'), src);
    const seen = [];
    let from;
    for (let page = 0; page < 10; page += 1) {
      const r = await call('read_example', { repo: 'samples', path: 'src/01/z2ui5_cl_smp_app_900.clas.abap', ...(from ? { from_line: from } : {}) }, { budget: ANSWER_BUDGET });
      assert.equal(r.lines, total);
      seen.push(...r.source.split('\n'));
      if (!r.nextPage) break;
      assert.equal(r.page.to_line + 1, r.nextPage.from_line);
      from = r.nextPage.from_line;
    }
    assert.ok(from, 'more than one page');
    assert.equal(seen.join('\n'), src, 'every line arrives once');
    const small = await call('read_example', { repo: 'samples', path: 'src/01/z2ui5_cl_smp_app_900.clas.abap', from_line: total });
    assert.deepEqual(small.page, { from_line: total, to_line: total });
    assert.equal(small.nextPage, undefined);
    assert.equal(small.pastEnd, undefined, 'the last line is no past-the-end page');
    /* past the end: the last line, and a sentence - it was clamped without
     * a word and read as an empty or a one-line file */
    const past = await call('read_example', { repo: 'samples', path: 'src/01/z2ui5_cl_smp_app_900.clas.abap', from_line: 5000 });
    assert.equal(past.pastEnd, `from_line 5000 is past the end - the file has ${total} lines; its last line is shown`);
    assert.equal(past.source, 'ENDCLASS.');
  });
});

test('build_log fits its lines into one answer and says how to read the rest', async () => {
  await withServer(async (call, base) => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, '0')} "${'x'.repeat(110)}"`);
    lines[1990] = `a minified bundle on one line ${'y'.repeat(200_000)}`;
    fs.mkdirSync(path.join(base, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(base, 'shots', 'last-build.json'), JSON.stringify({ startedAt: 'x', finishedAt: 'y', mode: 'incremental', code: 1, ok: false, lines }));
    // the tail: the LAST lines that fit, the cut said with the offset that reads on before them
    const last = await call('build_log', { tail: 2000 }, { budget: ANSWER_BUDGET });
    assert.equal(last.totalLines, 2000);
    assert.equal(last.lines[last.lines.length - 1], lines[1999], 'the tail ends with the last line');
    assert.equal(last.start + last.lines.length, 2000);
    assert.ok(last.start > 0);
    assert.match(last.cut, /build_log \{ offset: \d+, tail: \d+ \}/);
    const long = last.lines[1990 - last.start];
    assert.ok(long.length < 10_000 && /more characters\]$/.test(long), 'one huge line is shortened, not the whole answer');
    // paging from an offset: the first lines that fit, then on to the end
    let offset = 0;
    const seen = [];
    for (let page = 0; page < 20 && offset < 2000; page += 1) {
      const r = await call('build_log', { offset, tail: 2000 }, { budget: ANSWER_BUDGET });
      assert.equal(r.start, offset);
      seen.push(...r.lines);
      offset = r.start + r.lines.length;
      if (offset < 2000) assert.match(r.cut, new RegExp(`offset: ${offset}`));
    }
    assert.equal(seen.length, 2000, 'every line arrives once');
    assert.equal(seen[0], lines[0]);
    assert.equal(seen[1999], lines[1999]);
  });
});

test('a failed build_backend answers its tail with every long line shortened', async () => {
  await withServer(async (call, base) => {
    fs.writeFileSync(path.join(base, 'samples-controls', 'scripts', 'e2e-build.mjs'),
      `for (let i = 0; i < 40; i++) console.log('step ' + i + ' ' + 'z'.repeat(50000));\nprocess.exitCode = 1;\n`);
    const t = await call('build_backend', { mode: 'full' }, { budget: ANSWER_BUDGET, error: true });
    assert.match(t, /^build failed \(exit 1, mode full\)/);
    assert.match(t, /step 39 z+ \[\.\.\. \d+ more characters - build_log has the line\]/);
    const log = await call('build_log', { tail: 1 }, { budget: ANSWER_BUDGET });
    assert.match(log.lines[0], /^step 39 z+ \[\.\.\. \d+ more characters\]$/, 'build_log shows the line, cut to what one answer holds');
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

/* app_guide answered every chapter at once - 48,000 characters for the
 * real guide, and the guide grows upstream; the default call is the one
 * the description tells an agent to make first. */
test('app_guide pages its chapters and every chapter arrives once', async () => {
  await withServer(async (call) => {
    const seen = [];
    let offset = 0;
    let first = null;
    for (let i = 0; i < 20; i++) {
      const page = await call('app_guide', offset ? { offset } : {});
      first ||= page;
      assert.ok(sizeOf(page) <= ANSWER_BUDGET, `${sizeOf(page)} characters`);
      assert.equal(page.returned, page.sections.length);
      assert.equal(page.chapters.length, 31, 'the table of contents comes with every page');
      seen.push(...page.sections.map((c) => c.heading));
      const m = page.more && /offset: (\d+)/.exec(page.more);
      if (!m) break;
      offset = Number(m[1]);
    }
    assert.equal(first.matches, 31, 'the intro and 30 chapters');
    assert.ok(first.returned < 31, 'the budget cut the first page');
    assert.match(first.more, /call again with offset: \d+ \(same section and query\)/);
    assert.equal(seen.length, 31);
    assert.equal(new Set(seen).size, 31, 'no chapter twice');
    assert.ok(seen.includes('(intro)') && seen.includes('30. Chapter 30'));
    const limited = await call('app_guide', { query: 'guide prose', offset: 3, limit: 2 });
    assert.deepEqual(limited.sections.map((c) => c.heading), ['4. Chapter 4', '5. Chapter 5']);
    assert.equal(limited.offset, 3);
    assert.match(limited.more, /25 more - call again with offset: 5/);
    const one = await call('app_guide', { section: '7' });
    assert.deepEqual(one.sections.map((c) => c.heading), ['7. Chapter 7']);
    assert.equal(one.more, undefined, 'one chapter names no page');
  });
});

/* docs_search answered `matches: 10` for a query 25 pages answer: the
 * count of what it returned, and nothing said where the rest was. */
test('docs_search counts every matching page and pages the rest', async () => {
  await withServer(async (call) => {
    const first = await call('docs_search', { query: 'binding' });
    assert.equal(first.matches, 25);
    assert.equal(first.returned, 10);
    assert.match(first.more, /15 more - call again with offset: 10 \(same query\)/);
    const seen = new Set(first.entries.map((e) => e.path));
    for (const offset of [10, 20]) {
      const page = await call('docs_search', { query: 'binding', offset });
      assert.equal(page.offset, offset);
      for (const e of page.entries) seen.add(e.path);
    }
    assert.equal(seen.size, 25, 'every page arrives once');
    const last = await call('docs_search', { query: 'binding', offset: 20 });
    assert.equal(last.returned, 5);
    assert.equal(last.more, undefined);
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
    assert.equal(small.foundByBuilds, undefined, 'every match in the catalogue\'s own words: nothing to say');
  });
});

/* A generic word matches most of a catalogue through the controls the views
 * build ("button": 424 matches, 135 of them only because the view has a
 * Button). Those come after the catalogue-word matches, and the answer says
 * how many there are, so a long `matches` is not read as that many samples
 * ABOUT the word. */
test('examples says how many matches were found only by a control the view builds', async () => {
  await withServer(async (call) => {
    const r = await call('examples', { query: 'button', repo: 'samples' });
    assert.equal(r.matches, 50);
    assert.deepEqual(r.entries.slice(0, 3).map((e) => [e.cls, e.builds]), [0, 1, 2].map((i) => [`Z2UI5_CL_SMP_APP_00${i}`, undefined]),
      'the three found by their own words first, naming no builds');
    assert.deepEqual(r.entries[3].builds, ['sap.m.Button']);
    assert.match(r.foundByBuilds, /^47 of the 50 matches needed a control their view builds to match \(named under `builds`\) - they come after the 3 that match in the catalogues' own words/);
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
    // the compact list pages the same way - it ignored offset and limit and
    // answered the whole surface again to a call asking for its second page
    const compact = await call('api_reference', { offset: 118, limit: 5 });
    assert.equal(compact.entries, 121);
    assert.equal(compact.offset, 118);
    assert.deepEqual(compact.methods.map((m) => m.name), ['method_118', 'method_119']);
    assert.deepEqual(compact.constants.map((c) => c.name), ['cs_event']);
    assert.equal(compact.more, undefined);
    const head = await call('api_reference', { kind: 'methods', limit: 2 });
    assert.deepEqual(head.methods.map((m) => m.name), ['method_000', 'method_001']);
    assert.match(head.more, /118 more - call again with offset: 2 \(same kind, no query\)/);
    const whole = await call('api_reference', {});
    assert.equal(whole.returned, 121, 'the whole compact list still fits one answer');
    const kind = await call('api_reference', { query: 'entry', kind: 'constants' });
    assert.equal(kind.matches, 1);
    assert.equal(kind.methods, undefined);
    /* the singular is the same filter: `kind: "method"` - what an agent
     * asking for one method types - was refused, a roundtrip for nothing */
    assert.deepEqual(await call('api_reference', { query: 'entry', kind: 'constant' }), kind);
    assert.deepEqual(await call('api_reference', { kind: 'method', limit: 2 }), head);
    assert.equal((await call('api_reference', { kind: 'type' })).entries, 0);
    assert.match(await call('api_reference', { kind: 'Methods' }, { error: true }), /unknown kind 'Methods' — use methods, constants, types or all/);
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

test('fitFindings: a list that fits is the same; past the budget the most severe stay, in their own order', () => {
  const few = [{ type: 'a', severity: 'hint' }];
  assert.equal(fitFindings(few).findings, few);
  assert.equal(fitFindings(few).cut, 0);
  const rank = { hint: 0, warning: 1, error: 2 };
  const many = Array.from({ length: 300 }, (_, i) => ({ type: `t${i}`, severity: i % 3 === 0 ? 'error' : (i % 3 === 1 ? 'warning' : 'hint'), message: 'm'.repeat(200) }));
  const { findings, cut } = fitFindings(many, { budget: 20_000, rankOf: (f) => rank[f.severity] });
  assert.ok(cut > 0 && findings.length + cut === many.length);
  assert.ok(sizeOf(findings, 1) <= 20_000 + 2000);
  const kept = new Set(findings.map((f) => f.type));
  const errors = many.filter((f) => f.severity === 'error');
  assert.ok(errors.every((f) => kept.has(f.type)) || findings.every((f) => f.severity === 'error'), 'errors go first');
  assert.deepEqual(findings, many.filter((f) => kept.has(f.type)), 'in the order the gate reported them');
  assert.equal(fitFindings([{ big: 'x'.repeat(100_000) }]).findings.length, 1, 'always one');
});

/* verify_app composes the single tools' answers, each fitted to one answer
 * by itself - and together past it: a validate stage that passed with a few
 * hundred hints (advisory, so ok) and a unit stage of a few hundred tests
 * answered ~100,000 characters, and the client showed the agent nothing of
 * the loop it had just run. The passed validate stage gives up findings
 * first (validate_view lists them), then the unit stage counts per object. */
test('fitVerifyStages: the composed verify_app report fits one answer', () => {
  const hint = (i) => ({ type: 'event-arg-single-row-table', severity: 'hint', line: i + 1, column: 3, message: `t_arg = VALUE #( ( \`${'x'.repeat(60)}\` ) ) builds a one-row table for a single argument (${i})`, url: 'https://abap2ui5.github.io/linter/#event-arg-single-row-table' });
  const findings = Array.from({ length: 140 }, (_, i) => hint(i));
  const tests = Array.from({ length: 330 }, (_, i) => ({ object: 'ZCL_APP', class: 'LTCL_TEST', method: `test_method_${i}`, ok: true }));
  const stages = {
    validate: { ok: true, counts: { error: 0, warning: 0, hint: 150 }, findings, findingsCut: '10 more finding(s) did not fit one answer', renderErrors: [], hint: 'hints are advisory, ok stays true' },
    deploy: { ok: true, deployed: 'zcl_app' },
    build: { ok: true, built: true, mode: 'incremental' },
    unit: { ok: true, ran: 330, skipped: 0, tests, failed: [] },
    boot: { ok: true, booted: true, errors: [] },
  };
  const before = sizeOf({ ok: true, stages });
  assert.ok(sizeOf(stages.validate) < ANSWER_BUDGET && sizeOf(stages.unit) < ANSWER_BUDGET && before > ANSWER_BUDGET, `each fits alone, together ${before}`);
  const fit = fitVerifyStages(stages);
  assert.ok(sizeOf({ ok: true, stages: fit }) <= ANSWER_BUDGET - 5000, `${sizeOf({ ok: true, stages: fit })} characters`);
  assert.deepEqual(fit.validate.findings, findings.slice(0, fit.validate.findings.length), 'the head of the list stays');
  assert.match(fit.validate.findingsCut, new RegExp(`^${150 - fit.validate.findings.length} more finding\\(s\\) left out of this report - validate_view lists them`));
  assert.deepEqual(fit.deploy, stages.deploy);
  assert.equal(stages.validate.findings.length, 140, 'the input is not changed');
  // a report that fits is the same object
  const small = { validate: { ok: true, counts: { error: 0, warning: 0, hint: 1 }, findings: [hint(0)] }, build: { ok: true } };
  assert.equal(fitVerifyStages(small), small);
  // when the findings alone cannot make room, the unit stage is counted per object too
  const huge = { ...stages, unit: { ...stages.unit, tests: Array.from({ length: 700 }, (_, i) => tests[i % 330]), ran: 700 } };
  const hugeFit = fitVerifyStages(huge);
  assert.ok(sizeOf({ ok: true, stages: hugeFit }) <= ANSWER_BUDGET - 5000, `${sizeOf({ ok: true, stages: hugeFit })} characters`);
  assert.equal(hugeFit.unit.tests, undefined);
  assert.deepEqual(hugeFit.unit.testsPerObject, { ZCL_APP: 700 });
});

/* fitRules: validate_view's explain:true carries a paragraph per rule, and a
 * view tripping a dozen distinct rules passed them ALL - `rules` alone could
 * pass the budget while fitFindings only shrank the findings. */
test('fitRules caps the explanations and keeps the ordered ones first', () => {
  const small = { a: { summary: 'x', detail: 'y' } };
  assert.equal(fitRules(small).rules, small);
  assert.equal(fitRules(small).cut, 0);
  const para = (n) => ({ summary: `rule ${n}`, detail: 'p'.repeat(1200), example: 'e'.repeat(300) });
  const rules = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`rule_${String(i).padStart(2, '0')}`, para(i)]));
  const order = ['rule_37', 'rule_19', 'rule_05'];
  const { rules: fit, cut } = fitRules(rules, { budget: 12_000, order });
  assert.ok(cut > 0 && Object.keys(fit).length + cut === 40);
  assert.ok(sizeOf(fit, 1) <= 12_000 + 1500);
  assert.deepEqual(Object.keys(fit).slice(0, 3), order, 'the ordered rules are kept first');
  assert.equal(Object.keys(rules).length, 40, 'the input is not changed');
  assert.equal(Object.keys(fitRules({ one: para(0) }, { budget: 10 }).rules).length, 1, 'always at least one');
});

/* fitObject: migrate_report { deploy: true } stacks the deploy/build/start
 * stages - each a tool's own fitted answer, together past the budget. */
test('fitObject bounds a composed object and leaves a note', () => {
  const small = { ok: true, stages: { deploy: { ok: true } } };
  assert.equal(fitObject(small), small);
  const big = {
    ok: true,
    stages: {
      deploy: { ok: true, with: Array.from({ length: 50 }, (_, i) => `z2ui5_cl_support_${i}`) },
      build: { ok: true, tail: 't'.repeat(500) },
      start: { ok: true, snapshot: { texts: Array.from({ length: 4000 }, (_, i) => `line of app text number ${i} `.repeat(4)) } },
    },
  };
  assert.ok(sizeOf(big) > ANSWER_BUDGET, `the case: ${sizeOf(big)}`);
  const fit = fitObject(big);
  assert.ok(sizeOf(fit) <= ANSWER_BUDGET - 5000, `${sizeOf(fit)} characters`);
  assert.equal(fit.ok, true);
  assert.equal(fit.stages.deploy.ok, true);
  assert.match(fit.__answerGuardCut, /shrunk here as a backstop/);
  assert.ok(sizeOf(big) > ANSWER_BUDGET, 'the input is not changed');
});

/* guardAnswer: the one last-line backstop. A seeded run of oversized results
 * - JSON and prose, one to three content blocks - proves NO answer leaves it
 * over the budget, whatever a per-tool fitter missed. */
test('guardAnswer: no result ever leaves over the budget, and JSON stays JSON when it can', () => {
  // a result within budget is returned untouched
  const ok = { content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }] };
  assert.equal(guardAnswer(ok), ok);
  // an image-only (or image-plus-small-text) result is left alone
  const img = { content: [{ type: 'image', data: 'x'.repeat(200000), mimeType: 'image/png' }, { type: 'text', text: 'small' }] };
  assert.equal(guardAnswer(img), img);

  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const bigJson = () => {
    const kind = pick(['array', 'wide', 'deep', 'strings']);
    if (kind === 'array') return { matches: 9000, entries: Array.from({ length: 2000 + Math.floor(rnd() * 3000) }, (_, i) => ({ id: i, text: 'e'.repeat(50 + Math.floor(rnd() * 200)) })) };
    if (kind === 'wide') return Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'.repeat(200 + Math.floor(rnd() * 400))]));
    if (kind === 'deep') return { stages: { a: { findings: Array.from({ length: 1500 }, (_, i) => ({ i, m: 'm'.repeat(100) })) }, b: { tests: Array.from({ length: 1500 }, (_, i) => ({ i })) } } };
    return { source: 's'.repeat(80000 + Math.floor(rnd() * 200000)), note: 'keep' };
  };
  const bigProse = () => 'p'.repeat(70000 + Math.floor(rnd() * 300000));

  for (let i = 0; i < 400; i += 1) {
    const blocks = [];
    const n = 1 + Math.floor(rnd() * 3);
    for (let b = 0; b < n; b += 1) {
      if (rnd() < 0.6) blocks.push({ type: 'text', text: JSON.stringify(bigJson(), null, 2) });
      else if (rnd() < 0.5) blocks.push({ type: 'text', text: bigProse() });
      else blocks.push({ type: 'resource', resource: { uri: 'x://y', mimeType: 'application/json', text: JSON.stringify(bigJson(), null, 2) } });
    }
    // an image block sometimes, which must not count against the text budget
    if (rnd() < 0.3) blocks.push({ type: 'image', data: 'i'.repeat(100000), mimeType: 'image/png' });
    const before = blocks.map((bl) => (bl.text ? JSON.parse(JSON.stringify(bl)) : null));
    const guarded = guardAnswer({ content: blocks });
    const total = guarded.content.reduce((s, bl) => s + (typeof bl.text === 'string' ? bl.text.length : (bl.resource && typeof bl.resource.text === 'string' ? bl.resource.text.length : 0)), 0);
    assert.ok(total <= ANSWER_BUDGET, `run ${i}: ${total} characters over ${ANSWER_BUDGET}`);
    // a block that was already within its share is untouched; a shrunk JSON
    // block parses (unless it had to be hard-truncated as the last resort)
    for (const bl of guarded.content) {
      const ref = typeof bl.text === 'string' ? bl : (bl.resource && typeof bl.resource.text === 'string' ? bl.resource : null);
      if (!ref) continue;
      if (!/truncated to fit/.test(ref.text)) {
        try { JSON.parse(ref.text); } catch { /* prose block: not JSON to begin with */ }
      }
    }
  }
});


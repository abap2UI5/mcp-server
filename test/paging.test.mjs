// Answers that fit a client (lib/budget.mjs).
//
// Claude Code refuses a tool result over 25,000 tokens and the agent then
// sees NOTHING. Three defaults went over: scaffold_app (~280 KB, the whole
// template), pitfalls without a query (~120 KB) and examples with a large
// limit (~135 KB). They are paged now, and every page names the arguments
// that fetch the rest - these tests walk the pages to the end and check that
// nothing was lost on the way. Sibling-free: the checkouts are fakes built in
// a temp dir and pointed at through the (authoritative) env vars.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ANSWER_BUDGET, takeWithin, takeSmallestWithin } from '../lib/budget.mjs';

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
      SAMPLES_CONTROLS_HOME: nowhere,
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
    const m = /offset: (\d+)/.exec(first.more);
    assert.equal(Number(m[1]), first.returned);
    const second = await call('examples', { query: 'table', repo: 'samples', limit: 200, offset: Number(m[1]) });
    assert.equal(second.offset, first.returned);
    assert.notEqual(second.entries[0].cls, first.entries[0].cls);
    const small = await call('examples', { query: 'table', repo: 'samples' });
    assert.equal(small.returned, 20, 'the default page is unchanged');
  });
});

test('the budget helpers keep order, always return one item, and prefer small files', () => {
  const items = [{ t: 'x'.repeat(100) }, { t: 'y'.repeat(10) }, { t: 'z'.repeat(10) }];
  assert.deepEqual(takeWithin(items, 50).taken, [items[0]], 'one item even when it alone is over');
  assert.deepEqual(takeWithin(items, 1000).rest, []);
  const files = [{ path: 'BIG', text: 'b'.repeat(ANSWER_BUDGET) }, { path: 'a', text: 'a' }, { path: 'c', text: 'c' }];
  const { taken, rest } = takeSmallestWithin(files, 1000);
  assert.deepEqual(taken.map((f) => f.path), ['a', 'c'], 'original order kept');
  assert.deepEqual(rest.map((f) => f.path), ['BIG']);
});

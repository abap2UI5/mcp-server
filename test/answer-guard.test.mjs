// "Every tool answer passes guardAnswer" (lib/budget.mjs) as something a test
// can fail on, not a sentence in a comment.
//
// Two halves. The structural one reads server.mjs: ONE handler for tools/call,
// and it is the guard wrapped around the dispatch - so a second registration,
// or a dispatch registered without the wrapper, fails here. The runtime one
// runs the real server under a test-only loader hook (test/helpers/
// guard-probe.mjs) that marks every result guardAnswer returns, and sweeps
// EVERY tool name - the sandbox's and the system mode's, an unknown name and a
// bad argument too - asserting that each answer carries the mark and that its
// content blocks, all of them, are within the budgets. A return path that
// bypasses the dispatch point answers without the mark.
//
// Sibling-free: every checkout env var points nowhere (authoritative - no
// mirror, no sibling), offline, a workspace of its own, a closed port for the
// system mode - so every tool answers fast and nothing is built or fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { SYSTEM_TOOL_NAMES } from '../lib/system-tools.mjs';
import { ANSWER_BUDGET, IMAGE_BUDGET } from '../lib/budget.mjs';
import { PROBE_MARK } from './helpers/guard-probe-hooks.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOWHERE = path.join(ROOT, 'test', 'does-not-exist');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

test('server.mjs registers ONE tools/call handler, and it is guardAnswer around the dispatch', () => {
  const registrations = SERVER.match(/setRequestHandler\(\s*CallToolRequestSchema\b/g) || [];
  assert.equal(registrations.length, 1, 'exactly one tools/call handler');
  assert.match(SERVER, /\nserver\.setRequestHandler\(CallToolRequestSchema, answerToolCall\);\n/,
    'the registered handler is answerToolCall itself, not a closure around something else');
  assert.match(SERVER, /\nconst answerToolCall = async \(req, extra\) => guardAnswer\(await dispatchToolCall\(req, extra\)\);\n/,
    'answerToolCall is the guard applied to the dispatch - every return path of it, the catch included');
  // the dispatch is reachable only through the guard
  assert.deepEqual((SERVER.match(/\bdispatchToolCall\b/g) || []).length, 2, 'dispatchToolCall: its definition and the one call in answerToolCall');
  assert.doesNotMatch(SERVER, /['"]tools\/call['"]/, 'no handler keyed by the method string');
  // nothing else answers tools: no high-level McpServer registration anywhere
  for (const f of ['server.mjs', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((n) => n.endsWith('.mjs')).map((n) => `lib/${n}`)]) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\.registerTool\(|\bnew McpServer\(/, `${f} registers tools outside the one dispatch point`);
    if (f !== 'server.mjs') assert.doesNotMatch(src, /CallToolRequestSchema/, `${f} handles tools/call`);
  }
});

/** The server under the probe, over stdio. */
function probedServer(env, cwd) {
  const p = spawn(process.execPath, ['--import', path.join(ROOT, 'test', 'helpers', 'guard-probe.mjs'), path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'], env, cwd,
  });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (waiting.has(m.id)) {
          waiting.get(m.id)(m);
          waiting.delete(m.id);
        }
      } catch {
        /* a log line */
      }
    }
  });
  const rpc = (method, params, ms = 60_000) => new Promise((resolve, reject) => {
    id += 1;
    const mine = id;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} ${JSON.stringify(params).slice(0, 80)} in ${ms} ms`)), ms);
    waiting.set(mine, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
  });
  return { rpc, close: () => p.kill() };
}

/** Every block of a tools/call answer within its budget, the mark there. */
function assertGuarded(label, msg) {
  assert.ok(msg.result, `${label}: a result, not a protocol error (${JSON.stringify(msg.error || msg).slice(0, 200)})`);
  const r = msg.result;
  assert.equal(r._meta?.[PROBE_MARK], true, `${label}: the answer did not pass guardAnswer`);
  assert.ok(Array.isArray(r.content) && r.content.length > 0, `${label}: content blocks`);
  let text = 0;
  let pictures = 0;
  for (const b of r.content) {
    if (b.type === 'text') text += b.text.length;
    else if (b.type === 'image') pictures += b.data.length;
    else if (b.type === 'resource') text += (b.resource.text || b.resource.blob || '').length;
    else assert.fail(`${label}: a content block of type ${b.type} nobody measures`);
  }
  assert.ok(text <= ANSWER_BUDGET, `${label}: ${text} characters of text, over ${ANSWER_BUDGET}`);
  assert.ok(pictures <= IMAGE_BUDGET, `${label}: ${pictures} characters of pictures, over ${IMAGE_BUDGET}`);
}

const isolated = (extra = {}) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-guard-'));
  const env = {
    PATH: process.env.PATH,
    HOME: ws,
    TMPDIR: ws,
    SAMPLES_CONTROLS_HOME: path.join(NOWHERE, 'samples-controls'),
    SAMPLES_HOME: path.join(NOWHERE, 'samples'),
    SAMPLES_STACK_HOME: path.join(NOWHERE, 'samples-stack'),
    A2UI5_HOME: path.join(NOWHERE, 'abap2UI5'),
    AI_VIEW_CHECK_HOME: path.join(NOWHERE, 'linter'),
    APP_TEMPLATE_HOME: path.join(NOWHERE, 'app-template'),
    DOCS_HOME: path.join(NOWHERE, 'docs'),
    ABAP_CLOUD_GUI_HOME: path.join(NOWHERE, 'abap-cloud-gui'),
    A2UI5_MCP_OFFLINE: '1',
    A2UI5_MCP_REMOTE: '0',
    A2UI5_MCP_WORKSPACE: path.join(ws, 'workspace'),
    A2UI5_MCP_SCREENSHOT_DIR: path.join(ws, 'shots'),
    A2UI5_MCP_PORT: '3931',
    ...extra,
  };
  return { ws, env };
};

async function sweep(names, extra) {
  const { ws, env } = isolated(extra);
  const srv = probedServer(env, ws);
  try {
    await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'guard-sweep', version: '0' } });
    const listed = (await srv.rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [...names].sort(), 'the sweep covers every tool the server lists');
    for (const name of listed) assertGuarded(name, await srv.rpc('tools/call', { name, arguments: {} }));
    assertGuarded('an unknown tool', await srv.rpc('tools/call', { name: 'no_such_tool', arguments: {} }));
    assertGuarded('an unknown argument (the throw path)', await srv.rpc('tools/call', { name: listed[0], arguments: { no_such_argument: 1 } }));
    assertGuarded('a huge unknown argument name', await srv.rpc('tools/call', { name: listed[0], arguments: { ['x'.repeat(200_000)]: 1 } }));
  } finally {
    srv.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test('every sandbox tool, called over stdio, answers through guardAnswer within the budgets', { timeout: 300_000 }, async () => {
  await sweep(TOOL_NAMES);
});

test('every system-mode tool, called over stdio, answers through guardAnswer within the budgets', { timeout: 120_000 }, async () => {
  await sweep(SYSTEM_TOOL_NAMES, { A2UI5_MCP_SYSTEM_URL: 'http://127.0.0.1:9/sap/bc/z2ui5', A2UI5_MCP_SYSTEM_USER: 'u', A2UI5_MCP_SYSTEM_PASSWORD: 'p' });
});

/* The same over the real checkouts beside this one, where they are: the
 * knowledge tools answer whole documents there (the guide, the interface,
 * the porting brief), the sizes the budget exists for. Read-only tools only. */
test('the knowledge tools over the real checkouts answer through guardAnswer within the budgets', { timeout: 120_000 }, async (t) => {
  if (!fs.existsSync(path.join(ROOT, '..', 'abap2UI5')) && !fs.existsSync(path.join(ROOT, '..', 'samples-controls'))) {
    t.skip('no sibling checkouts');
    return;
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-guard-real-'));
  const srv = probedServer({ ...process.env, A2UI5_MCP_REMOTE: '0', A2UI5_MCP_WORKSPACE: path.join(ws, 'workspace') }, ws);
  try {
    await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'guard-real', version: '0' } });
    for (const [name, args] of [
      ['capabilities', {}], ['capabilities', { query: 'e' }], ['app_guide', {}], ['api_reference', {}], ['pitfalls', {}],
      ['generation_rules', {}], ['examples', { query: 'table' }], ['docs_search', { query: 'popup' }], ['setup_status', {}],
    ]) {
      assertGuarded(`${name} ${JSON.stringify(args)}`, await srv.rpc('tools/call', { name, arguments: args }));
    }
  } finally {
    srv.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

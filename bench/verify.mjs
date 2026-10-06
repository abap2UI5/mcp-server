#!/usr/bin/env node
// Verify the harness itself - run before every bench run and after every
// change under bench/:
//
//   1. the gate versions the grader runs are the ones the pinned app-template
//      locks (package-lock.json) - otherwise the bench would not be judging
//      by `npm run check`
//   2. every task's reference solution passes every check
//   3. every deliberately broken variant (verify/broken/*) fails exactly the
//      checks its variant.json names, and no other
//   4. the Claude Code adapter's transcript summary (turns, MCP connection,
//      contamination) on a recorded stream
//   5. the child-process helper decodes a character the pipe splits
//
//   node verify.mjs [--concurrency 4] [--json verify.json]
// Exit 0 when all of it holds.
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from './adapters/claude-code.mjs';
import { failureReasons, gradeDir, pins, summaryLine } from './lib/grade.mjs';
import { BENCH_DIR, loadTasks, parseArgs, readJson, run, writeJson } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const concurrency = Math.max(1, Number(args.concurrency || 4));
const problems = [];
const say = (m) => process.stdout.write(m + '\n');

// 1. gate versions
const p = await pins({ template: args.template });
const lock = readJson(path.join(p.templateDir, 'package-lock.json'));
say(`pins: app-template ${readJson(path.join(BENCH_DIR, 'bench.config.json')).templateRef.slice(0, 12)}, abap2UI5 ${p.frameworkRef}`);
for (const name of ['@abap2ui5/linter', '@abap2ui5/linter-render', '@abaplint/cli']) {
  const want = lock.packages[`node_modules/${name}`] && lock.packages[`node_modules/${name}`].version;
  const have = readJson(path.join(BENCH_DIR, 'node_modules', name, 'package.json')).version;
  const ok = want === have;
  say(`gate ${name}: bench ${have}, template lock ${want} ${ok ? 'ok' : 'MISMATCH'}`);
  if (!ok) problems.push(`${name}: the bench installs ${have}, the pinned template locks ${want} - align bench/package.json with the template`);
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// 2. references
say('\nreference solutions (must pass):');
const tasks = loadTasks();
const refGrades = await pool(tasks, (t) => gradeDir(path.join(t.dir, 'reference'), t, { template: args.template }));
for (const g of refGrades) {
  say(summaryLine(g));
  if (!g.pass) { problems.push(`reference ${g.task} does not pass`); for (const r of failureReasons(g)) say(`    ${r}`); }
}

// 3. broken variants
say('\nbroken variants (must fail exactly the named checks):');
const brokenDir = path.join(BENCH_DIR, 'verify', 'broken');
const variants = fs.readdirSync(brokenDir).filter((d) => fs.existsSync(path.join(brokenDir, d, 'variant.json'))).sort();
const brokenGrades = await pool(variants, async (name) => {
  const v = readJson(path.join(brokenDir, name, 'variant.json'));
  const [task] = loadTasks([v.task]);
  return { name, v, g: await gradeDir(path.join(brokenDir, name), task, { template: args.template }) };
});
for (const { name, v, g } of brokenGrades) {
  const failed = Object.entries(g.checks).filter(([, c]) => !c.pass).map(([k]) => k).sort();
  const want = [...v.mustFail].sort();
  const ok = !g.pass && !g.infraError && JSON.stringify(failed) === JSON.stringify(want);
  say(`${name.padEnd(24)} ${ok ? 'ok  ' : 'BAD '} failed: ${failed.join(', ') || '(none)'}${ok ? '' : ` - expected: ${want.join(', ')}`}`);
  say(`    ${failureReasons(g, 2).join('\n    ')}`);
  if (!ok) problems.push(`broken variant ${name}: failed [${failed.join(', ')}], expected [${want.join(', ')}]`);
}

// 4. adapter transcript summary
const stream = [
  { type: 'system', subtype: 'init', model: 'm', mcp_servers: [{ name: 'abap2ui5', status: 'connected' }] },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__abap2ui5__app_guide', input: {} }, { type: 'tool_use', name: 'Read', input: { file_path: path.join(BENCH_DIR, 'tasks', '01-hello-toast', 'reference', 'src', 'x') } }] } },
  { type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: { m: {} } },
];
const s = summarize(stream, { code: 0, timedOut: false, durationMs: 1000, stderr: '' });
const adapterOk = s.turns === 3 && s.costUsd === 0.5 && s.mcpToolCalls === 1 && s.contaminated === true && s.mcpServers[0].status === 'connected' && s.infraError === null
  && summarize([], { code: 1, timedOut: false, durationMs: 5, stderr: 'auth' }).infraError !== null;
say(`\nadapter transcript summary: ${adapterOk ? 'ok' : 'BAD'}`);
if (!adapterOk) problems.push('claude-code summarize() does not read a recorded stream as expected');

// 5. the child-process helper keeps a character whole when the pipe splits
//    it between two chunks - the transcript and the grader's output are
//    UTF-8, and a split em dash came out as replacement characters
const split = "const b = Buffer.from('a\\u2014b\\n'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 100);";
const seen = [];
const splitRun = await run(process.execPath, ['-e', split], { timeoutMs: 30000, onStdout: (d) => seen.push(d) });
const decodeOk = splitRun.stdout === 'a\u2014b\n' && seen.join('') === 'a\u2014b\n';
say(`child output decoding: ${decodeOk ? 'ok' : 'BAD'}`);
if (!decodeOk) problems.push(`run() split a character across chunks: ${JSON.stringify(splitRun.stdout)}`);

if (args.json) writeJson(String(args.json), { references: refGrades, broken: brokenGrades.map(({ name, v, g }) => ({ name, variant: v, grade: g })), problems });
say(problems.length ? `\nFAILED:\n- ${problems.join('\n- ')}` : `\nverified: ${refGrades.length} references pass, ${brokenGrades.length} broken variants fail as intended`);
process.exit(problems.length ? 1 : 0);

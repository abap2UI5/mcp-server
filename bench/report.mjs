#!/usr/bin/env node
// Aggregate one or more runs into the Markdown an article can carry.
//
//   node report.mjs results/<run-id> [results/<other-run-id> ...] [--out report.md]
//
// Reads every trials/**/meta.json of the given runs. A trial whose agent
// never started (no session, auth failure) or whose grading failed for a
// harness reason is EXCLUDED and counted separately; a trial whose
// transcript touched the bench's own files is excluded as contaminated. A
// timeout or a budget stop is the agent's result and counts as a failure.
import fs from 'node:fs';
import path from 'node:path';
import { CONDITION_NAMES } from './lib/conditions.mjs';
import { parseArgs, readJson, walk } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const dirs = args._;
if (dirs.length === 0) {
  process.stderr.write('usage: node report.mjs results/<run-id> [more run dirs] [--out report.md]\n');
  process.exit(2);
}

const runs = [];
const trials = [];
for (const d of dirs) {
  const runFile = path.join(d, 'run.json');
  if (!fs.existsSync(runFile)) { process.stderr.write(`${d}: no run.json - not a run directory\n`); process.exit(2); }
  runs.push(readJson(runFile));
  for (const f of walk(path.join(d, 'trials')).filter((x) => x.endsWith('meta.json'))) trials.push(readJson(path.join(d, 'trials', f)));
}

const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : '-');
/** Wilson score interval, 95%. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96;
  const ph = k / n;
  const den = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const ci = (k, n) => { const w = wilson(k, n); return w ? `${Math.round(w[0] * 100)}-${Math.round(w[1] * 100)}%` : '-'; };
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmt = (x, d = 1) => (x == null ? '-' : x.toFixed(d));

const excluded = { agentInfra: 0, graderInfra: 0, contaminated: 0 };
const valid = trials.filter((t) => {
  if (t.meta && t.meta.infraError) { excluded.agentInfra++; return false; }
  if (t.grade && t.grade.infraError) { excluded.graderInfra++; return false; }
  if (t.meta && t.meta.contaminated) { excluded.contaminated++; return false; }
  return true;
});

const conds = CONDITION_NAMES.filter((c) => valid.some((t) => t.condition === c));
const by = (c) => valid.filter((t) => t.condition === c);
const count = (list, f) => list.filter(f).length;

const out = [];
const models = [...new Set(trials.map((t) => t.meta && t.meta.model).filter(Boolean))];
const agents = [...new Set(runs.map((r) => `${r.agent.name} ${r.agent.version}`))];
const taskIds = [...new Set(valid.map((t) => t.task))].sort();
out.push('## abap2UI5-bench results');
out.push('');
out.push(`Runs: ${runs.map((r) => r.runId).join(', ')}${runs.some((r) => r.dryRun) ? ' (DRY RUN - reference solutions, not an agent)' : ''}  `);
out.push(`Agent: ${agents.join('; ')} - model: ${models.join(', ') || 'n/a'}  `);
out.push(`Tasks: ${taskIds.length}, repetitions: ${[...new Set(runs.map((r) => r.reps))].join('/')}, trials graded: ${valid.length} (excluded: ${excluded.agentInfra} agent never started, ${excluded.graderInfra} grader error, ${excluded.contaminated} contaminated)  `);
out.push(`Pins: app-template ${runs[0].pins.templateRef.slice(0, 7)}, abap2UI5 ${runs[0].pins.frameworkRef}, @abap2ui5/linter ${runs[0].gates['@abap2ui5/linter']}, @abaplint/cli ${runs[0].gates['@abaplint/cli']}${runs[0].mcpServer ? `, MCP server ${(runs[0].mcpServer.args || []).find((a) => /mcp-server|server\.mjs/.test(a)) || runs[0].mcpServer.command}` : ''}`);
out.push('');

// headline
const head = (c) => { const l = by(c); const k = count(l, (t) => t.grade.lintRenderClean); return { k, n: l.length }; };
if (conds.length) {
  const parts = conds.map((c) => { const h = head(c); return `**${c}** ${pct(h.k, h.n)} (${h.k}/${h.n}, 95% CI ${ci(h.k, h.n)})`; });
  out.push(`**Lint and render clean** (abaplint + @abap2ui5/linter static + render, the template's \`npm run check\`): ${parts.join(' - ')}`);
  out.push('');
}

out.push('| Condition | n | abaplint | abaplint (code only) | linter static | render | **lint + render clean** | task checks | **all checks** | mean turns | mean cost (USD) | mean time (min) | MCP calls / trial |');
out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const c of conds) {
  const l = by(c);
  const n = l.length;
  const row = [
    c,
    n,
    pct(count(l, (t) => t.grade.checks.abaplint), n),
    pct(count(l, (t) => t.grade.abaplintCodePass), n),
    pct(count(l, (t) => t.grade.checks.lint), n),
    pct(count(l, (t) => t.grade.checks.render), n),
    `**${pct(count(l, (t) => t.grade.lintRenderClean), n)}**`,
    pct(count(l, (t) => t.grade.checks.expect), n),
    `**${pct(count(l, (t) => t.grade.pass), n)}**`,
    fmt(mean(l.map((t) => t.meta.turns))),
    fmt(mean(l.map((t) => t.meta.costUsd)), 2),
    fmt(mean(l.map((t) => (t.meta.durationMs != null ? t.meta.durationMs / 60000 : null)))),
    c === 'full' ? fmt(mean(l.map((t) => t.meta.mcpToolCalls))) : '-',
  ];
  out.push(`| ${row.join(' | ')} |`);
}
out.push('');
const timeouts = valid.filter((t) => t.meta.timedOut).length;
const noMcp = by('full').filter((t) => t.meta.mcpConnected === false).length;
if (timeouts || noMcp) out.push(`Notes: ${timeouts} trial(s) hit the time budget (counted as failures)${noMcp ? `; in ${noMcp} full trial(s) the MCP server did not connect (kept - that is what the user would have experienced - but check the transcript)` : ''}.`, '');

// by level
const levels = [...new Set(valid.map((t) => t.level))].filter((x) => x != null).sort();
if (levels.length) {
  out.push('All checks passed, by task difficulty:');
  out.push('');
  out.push(`| Level | ${conds.join(' | ')} |`);
  out.push(`| --- | ${conds.map(() => '---:').join(' | ')} |`);
  for (const lv of levels) {
    out.push(`| ${lv} | ${conds.map((c) => { const l = by(c).filter((t) => t.level === lv); return `${pct(count(l, (t) => t.grade.pass), l.length)} (${count(l, (t) => t.grade.pass)}/${l.length})`; }).join(' | ')} |`);
  }
  out.push('');
}

// per task
out.push('<details><summary>Per task (all checks passed / trials)</summary>');
out.push('');
out.push(`| Task | ${conds.join(' | ')} |`);
out.push(`| --- | ${conds.map(() => '---:').join(' | ')} |`);
for (const id of taskIds) {
  out.push(`| ${id} | ${conds.map((c) => { const l = by(c).filter((t) => t.task === id); return l.length ? `${count(l, (t) => t.grade.pass)}/${l.length}` : '-'; }).join(' | ')} |`);
}
out.push('');
out.push('</details>');
out.push('');

const md = out.join('\n') + '\n';
if (args.out) fs.writeFileSync(String(args.out), md);
process.stdout.write(md);

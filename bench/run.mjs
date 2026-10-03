#!/usr/bin/env node
// Run the benchmark: every task x condition x repetition gets a fresh
// workspace, an agent run in it, and a grade.
//
//   node run.mjs [--agent claude-code] [--model <id>] [--reps 3]
//                [--conditions baseline,llms,template,full] [--tasks 01,02,...]
//                [--timeout-min 20] [--max-turns <n>] [--max-budget-usd 5]
//                [--concurrency 1] [--seed 1] [--run-id <id>] [--resume <id>]
//                [--template <dir>] [--template-install ci|none]
//                [--mcp-server npm|local] [--mcp-version <x.y.z>]
//                [--workspace-root <dir>] [--keep-workspaces] [--no-isolate]
//   node run.mjs --dry-run      the same pipeline with the reference solution
//                               as the "agent" - free, must come out 100%
//
// Writes results/<run-id>/: run.json (what was run, on what), trials.jsonl
// (one line per trial) and trials/<task>/<condition>/r<k>/ (prompt.md,
// transcript.jsonl, meta.json, output/ - the agent's classes - grade.json).
// `node report.mjs results/<run-id>` turns it into the article table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONDITION_NAMES, prepareTemplateInstall, prepareWorkspace, promptFor } from './lib/conditions.mjs';
import { collectObjects, failureReasons, gradeDir, pins } from './lib/grade.mjs';
import { benchConfig } from './lib/pins.mjs';
import { BENCH_DIR, gitHead, loadTasks, parseArgs, readJson, rng, run, sha256, shuffle, timestamp, walk, writeJson } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'keep-workspaces', 'isolate', 'help'] });
if (args.help) {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 25).join('\n').replace(/^\/\/ ?/gm, '') + '\n');
  process.exit(0);
}

const log = (m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const dryRun = !!args.dryRun;
const agentName = dryRun ? 'reference' : String(args.agent || 'claude-code');
const conditions = String(args.conditions || CONDITION_NAMES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
for (const c of conditions) if (!CONDITION_NAMES.includes(c)) { log(`unknown condition ${c} (known: ${CONDITION_NAMES.join(', ')})`); process.exit(2); }
const tasks = loadTasks(args.tasks ? String(args.tasks).split(',') : null);
if (tasks.length === 0) { log('no task matches --tasks'); process.exit(2); }
const reps = Number(args.reps || 1);
const concurrency = Math.max(1, Number(args.concurrency || 1));
const seed = Number(args.seed || 1);
const isolate = args.isolate !== false;
const limits = {
  timeoutMs: Number(args.timeoutMin || 20) * 60 * 1000,
  maxTurns: args.maxTurns ? Number(args.maxTurns) : null,
  // a cost cap per trial, so a looping agent cannot run up the bill; hitting
  // it ends the trial and counts as a failure, like the time budget
  maxBudgetUsd: args.maxBudgetUsd === undefined ? (dryRun ? null : 5) : (Number(args.maxBudgetUsd) || null),
};

let adapter;
try {
  adapter = (await import(`./adapters/${agentName}.mjs`)).default;
} catch (e) {
  log(`no adapter "${agentName}" in adapters/ (${e.message})`);
  process.exit(2);
}
try { adapter.preflight({ isolate }); } catch (e) { log(e.message); process.exit(2); }

// ---- the run directory ----------------------------------------------------
const runId = String(args.resume || args.runId || `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${dryRun ? 'dry' : agentName}`);
const runDir = path.join(BENCH_DIR, 'results', runId);
const wsRoot = path.join(path.resolve(String(args.workspaceRoot || path.join(os.tmpdir(), 'abap2ui5-bench-ws'))), runId);
if (wsRoot.startsWith(BENCH_DIR + path.sep)) { log('--workspace-root must lie outside the bench checkout - an agent could read the reference solutions from there'); process.exit(2); }
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(wsRoot, { recursive: true });

// ---- the pins, resolved once ----------------------------------------------
log('resolving the pinned app-template and abap2UI5 release');
const p = await pins({ template: args.template });
const needsTemplate = conditions.some((c) => c === 'template' || c === 'full');
let templateInstall = null;
if (needsTemplate && String(args.templateInstall || 'ci') === 'ci') templateInstall = await prepareTemplateInstall(p.templateDir, wsRoot, log);

let mcpServer = null;
if (conditions.includes('full')) {
  if (String(args.mcpServer || 'npm') === 'local') {
    mcpServer = { command: process.execPath, args: [path.resolve(BENCH_DIR, '..', 'server.mjs')] };
  } else {
    let version = args.mcpVersion ? String(args.mcpVersion) : null;
    if (!version) {
      const v = await run('npm', ['view', '@abap2ui5/mcp-server', 'version'], { timeoutMs: 60000 });
      version = v.code === 0 ? v.stdout.trim() : null;
      if (!version) { log(`cannot resolve the published @abap2ui5/mcp-server version (${v.stderr.trim()}); pass --mcp-version`); process.exit(2); }
    }
    const tpl = readJson(path.join(p.templateDir, '.mcp.json')).mcpServers.abap2ui5;
    mcpServer = { ...tpl, args: tpl.args.map((a) => (a === '@abap2ui5/mcp-server' ? `@abap2ui5/mcp-server@${version}` : a)) };
  }
}

const info = await adapter.info({ model: args.model });
const runJsonFile = path.join(runDir, 'run.json');
const prior = fs.existsSync(runJsonFile) ? readJson(runJsonFile) : null;
const runInfo = {
  runId,
  dryRun,
  startedAt: prior ? prior.startedAt : timestamp(),
  resumedAt: prior ? timestamp() : undefined,
  agent: info,
  modelRequested: args.model ? String(args.model) : null,
  conditions,
  tasks: tasks.map((t) => t.id),
  reps,
  seed,
  limits,
  isolate,
  concurrency,
  bench: await gitHead(BENCH_DIR),
  pins: { ...benchConfig(), templateDir: p.templateDir, template: await gitHead(p.templateDir), frameworkRef: p.frameworkRef },
  gates: Object.fromEntries(['@abap2ui5/linter', '@abap2ui5/linter-render', '@abaplint/cli'].map((n) => [n, readJson(path.join(BENCH_DIR, 'node_modules', n, 'package.json')).version])),
  templateInstall: templateInstall ? 'npm ci (hard-linked per workspace)' : 'none',
  mcpServer,
  node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  workspaceRoot: wsRoot,
};
writeJson(runJsonFile, runInfo);

// ---- the trials, in a seeded random order ---------------------------------
// Interleaving conditions spreads model drift and API weather over all of
// them instead of letting one condition run on a bad afternoon.
let trials = [];
for (let r = 1; r <= reps; r++) for (const t of tasks) for (const c of conditions) trials.push({ task: t, condition: c, rep: r });
trials = shuffle(trials, rng(seed));

const trialsFile = path.join(runDir, 'trials.jsonl');
const STRIP_ENV = ['A2UI5_HOME', 'SAMPLES_CONTROLS_HOME', 'AI_DEMOKIT_HOME', 'SAMPLES_HOME', 'SAMPLES_STACK_HOME', 'APP_TEMPLATE_HOME', 'DOCS_HOME', 'AI_VIEW_CHECK_HOME'];
const agentEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP_ENV.includes(k)));

let done = 0;
async function runTrial({ task, condition, rep }) {
  const trialDir = path.join(runDir, 'trials', task.id, condition, `r${rep}`);
  if (fs.existsSync(path.join(trialDir, 'grade.json')) && fs.existsSync(path.join(trialDir, 'meta.json'))) {
    done++;
    log(`[${done}/${trials.length}] ${task.id} ${condition} r${rep}: already graded, kept`);
    return;
  }
  fs.rmSync(trialDir, { recursive: true, force: true });
  fs.mkdirSync(trialDir, { recursive: true });
  const ws = path.join(wsRoot, task.id, condition, `r${rep}`);
  fs.rmSync(ws, { recursive: true, force: true });

  const prepared = await prepareWorkspace(condition, ws, { templateDir: p.templateDir, templateInstall, mcpServer });
  const seedHashes = new Map(walk(ws).map((f) => [f, sha256(path.join(ws, f))]));
  const prompt = promptFor(condition, task);
  fs.writeFileSync(path.join(trialDir, 'prompt.md'), prompt);

  const startedAt = timestamp();
  let meta;
  try {
    meta = await adapter.run({ workspace: ws, prompt, task, mcpConfig: prepared.mcpConfig, model: args.model ? String(args.model) : null, limits, logDir: trialDir, env: agentEnv, isolate });
  } catch (e) {
    meta = { infraError: `adapter threw: ${e && e.stack || e}` };
  }
  const endedAt = timestamp();

  // the agent's output: every abapGit object it created or changed
  const outDir = path.join(trialDir, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const { files } = collectObjects(ws);
  for (const f of files) {
    if (seedHashes.get(f.rel) === sha256(path.join(ws, f.rel))) continue;
    fs.mkdirSync(path.dirname(path.join(outDir, f.rel)), { recursive: true });
    fs.copyFileSync(path.join(ws, f.rel), path.join(outDir, f.rel));
  }

  const grade = await gradeDir(outDir, task, { template: args.template });
  writeJson(path.join(trialDir, 'grade.json'), grade);
  const mcpConnected = condition === 'full' ? (meta.mcpServers || []).some((s) => s.name === 'abap2ui5' && s.status === 'connected') : null;
  const record = {
    runId,
    task: task.id,
    level: task.expect.level || null,
    condition,
    rep,
    agent: info.name,
    startedAt,
    endedAt,
    meta: { ...meta, mcpConnected: dryRun ? null : mcpConnected },
    grade: {
      pass: grade.pass,
      lintRenderClean: grade.lintRenderClean,
      checks: Object.fromEntries(Object.entries(grade.checks).map(([k, v]) => [k, !!v.pass])),
      abaplintCodePass: grade.checks.abaplint ? !!grade.checks.abaplint.codePass : false,
      infraError: grade.infraError,
    },
  };
  writeJson(path.join(trialDir, 'meta.json'), record);
  fs.appendFileSync(trialsFile, JSON.stringify(record) + '\n');
  if (!args.keepWorkspaces) fs.rmSync(ws, { recursive: true, force: true });

  done++;
  const flags = [meta.infraError ? 'AGENT-INFRA' : '', grade.infraError ? 'GRADER-INFRA' : '', meta.contaminated ? 'CONTAMINATED' : '', meta.timedOut ? 'TIMEOUT' : '', condition === 'full' && !dryRun && !mcpConnected ? 'MCP-NOT-CONNECTED' : ''].filter(Boolean).join(' ');
  log(`[${done}/${trials.length}] ${task.id} ${condition} r${rep}: ${grade.pass ? 'PASS' : 'FAIL'} (clean ${grade.lintRenderClean ? 'yes' : 'no'})${meta.turns != null ? ` turns=${meta.turns}` : ''}${meta.costUsd != null ? ` cost=$${meta.costUsd.toFixed(2)}` : ''} ${flags}`);
  if (!grade.pass && dryRun) for (const r of failureReasons(grade)) log(`    ${r}`);
}

const queue = trials.slice();
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) await runTrial(queue.shift());
}));

runInfo.endedAt = timestamp();
writeJson(runJsonFile, runInfo);
if (!args.keepWorkspaces) fs.rmSync(wsRoot, { recursive: true, force: true });
log(`done: ${runDir}`);
log(`report: node report.mjs ${path.relative(process.cwd(), runDir) || runDir}`);

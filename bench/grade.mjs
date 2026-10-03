#!/usr/bin/env node
// Grade one directory of agent output against one task.
//
//   node grade.mjs --task 01-hello-toast path/to/output [--out grade.json] [--template dir]
//
// Prints the grade JSON on stdout (or writes it to --out) and a one-line
// summary on stderr. Exit 0 when the task passes, 1 when it does not, 2 on a
// usage or harness error.
import { failureReasons, gradeDir, summaryLine } from './lib/grade.mjs';
import { loadTasks, parseArgs, writeJson } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const dir = args._[0];
if (!dir || !args.task || args.help) {
  process.stderr.write('usage: node grade.mjs --task <NN or NN-slug> <dir> [--out grade.json] [--template <app-template dir>]\n');
  process.exit(2);
}
const [task] = loadTasks([String(args.task)]);
if (!task) {
  process.stderr.write(`no task matches ${args.task}\n`);
  process.exit(2);
}
const g = await gradeDir(dir, task, { template: args.template });
if (args.out) writeJson(args.out, g); else process.stdout.write(JSON.stringify(g, null, 2) + '\n');
process.stderr.write(summaryLine(g) + '\n');
for (const r of failureReasons(g)) process.stderr.write(`  ${r}\n`);
process.exit(g.infraError ? 2 : g.pass ? 0 : 1);

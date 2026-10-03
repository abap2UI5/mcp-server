// The four conditions a task is run under. They differ in the workspace the
// agent starts in and in one paste block - never in the task text, the
// autonomy note, the tools, the budget or the model.
//
//   baseline  an empty directory and the task
//   llms      the same, with the docs page's "paste the essentials" block
//             ahead of the task (llms.txt, building-apps.md)
//   template  the app-template project at the pin: AGENTS.md (the full
//             app-building guide), CLAUDE.md, the four skills, the gates
//             installed (npm ci) - but NOT its .mcp.json
//   full      template plus the abap2UI5 MCP server registered
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_DIR, readJson, run } from './util.mjs';

export const CONDITION_NAMES = ['baseline', 'llms', 'template', 'full'];

const read = (f) => fs.readFileSync(path.join(BENCH_DIR, 'prompts', f), 'utf8').trim();

export function promptFor(condition, task) {
  const parts = [];
  if (condition === 'llms') parts.push(read('llms-paste-block.txt'));
  parts.push(task.prompt.trim());
  parts.push(read('common.md'));
  return parts.join('\n\n') + '\n';
}

/** The files a project made from the template has: template.json's own
 *  description (files.shared + files.named), the same list scaffold_app,
 *  scripts/rename.mjs and `npm create abap2ui5-app` execute. */
export function templateFiles(templateDir) {
  const t = readJson(path.join(templateDir, 'template.json'));
  return [...(t.files.shared || []), ...(t.files.named || [])];
}

/** Install the template's gates once per run (npm ci from its lockfile);
 *  every template workspace then gets a hard-linked copy of node_modules, so
 *  an agent that runs `npm ci` itself replaces its own copy and nobody
 *  else's. */
export async function prepareTemplateInstall(templateDir, root, log) {
  const dir = path.join(root, '_template-install');
  if (fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(templateDir, f), path.join(dir, f));
  log(`installing the template's gates (npm ci) into ${dir}`);
  const r = await run('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: dir, timeoutMs: 15 * 60 * 1000 });
  if (r.code !== 0) throw new Error(`npm ci for the template failed: ${(r.stderr || r.stdout).slice(-800)}`);
  return dir;
}

async function linkNodeModules(installDir, ws) {
  const src = path.join(installDir, 'node_modules');
  const dst = path.join(ws, 'node_modules');
  const r = await run('cp', ['-al', src, dst], { timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0) {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}

/** Fill `ws` (an empty directory) for `condition`. Returns what the adapter
 *  needs: { mcpConfig } (a path, or null). */
export async function prepareWorkspace(condition, ws, ctx) {
  fs.mkdirSync(ws, { recursive: true });
  if (condition === 'baseline' || condition === 'llms') return { mcpConfig: null };
  if (condition !== 'template' && condition !== 'full') throw new Error(`unknown condition ${condition}`);

  for (const rel of templateFiles(ctx.templateDir)) {
    const src = path.join(ctx.templateDir, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(ws, rel));
  }
  if (ctx.templateInstall) await linkNodeModules(ctx.templateInstall, ws);

  if (condition === 'template') {
    fs.rmSync(path.join(ws, '.mcp.json'), { force: true });
    return { mcpConfig: null };
  }
  // full: the server the template registers, at the version resolved once
  // for the whole run (or this checkout's server.mjs with --mcp-server local)
  fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { abap2ui5: ctx.mcpServer } }, null, 2) + '\n');
  return { mcpConfig: path.join(ws, '.mcp.json') };
}

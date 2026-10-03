// The pinned checkouts a bench run judges against and hands out:
// app-template at bench.config.json's templateRef, and the abap2UI5 release
// that template's abaplint.jsonc pins. Both are cloned once into .cache/ and
// verified by commit; a clone that is not at the pin is never used.
import fs from 'node:fs';
import path from 'node:path';
import { stripJsonc } from '@abap2ui5/linter/config';
import { BENCH_DIR, CACHE_DIR, readJson, run } from './util.mjs';

export function benchConfig() {
  return readJson(path.join(BENCH_DIR, 'bench.config.json'));
}

async function git(args, opts = {}) {
  const r = await run('git', args, { timeoutMs: 5 * 60 * 1000, ...opts });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

/** The app-template checkout at the pin. `override` (a directory) wins and is
 *  used as it is - the caller records its commit. */
export async function ensureTemplate({ override } = {}) {
  if (override) {
    const dir = path.resolve(override);
    if (!fs.existsSync(path.join(dir, 'template.json'))) throw new Error(`--template ${dir}: no template.json there - not an app-template checkout`);
    return dir;
  }
  const { templateRepo, templateRef } = benchConfig();
  const dir = path.join(CACHE_DIR, `app-template-${templateRef.slice(0, 12)}`);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
    if (head === templateRef) return dir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  await git(['init', '-q', tmp]);
  await git(['-C', tmp, 'fetch', '-q', '--depth', '1', templateRepo, templateRef]);
  await git(['-C', tmp, 'checkout', '-q', 'FETCH_HEAD']);
  const head = await git(['-C', tmp, 'rev-parse', 'HEAD']);
  if (head !== templateRef) throw new Error(`app-template clone is at ${head}, expected ${templateRef}`);
  fs.renameSync(tmp, dir);
  return dir;
}

/** The template's abaplint.jsonc, parsed. */
export function templateLintConfig(templateDir) {
  return JSON.parse(stripJsonc(fs.readFileSync(path.join(templateDir, 'abaplint.jsonc'), 'utf8')));
}

/** The abap2UI5 release the template's abaplint config pins ("branch" -
 *  abaplint hands it to git clone --branch, so it is a tag). */
export function frameworkRefOf(templateDir) {
  const cfg = templateLintConfig(templateDir);
  const dep = (cfg.dependencies || []).find((d) => /abap2UI5\/abap2UI5/i.test(d.url || ''));
  if (!dep || !dep.branch) throw new Error('the template abaplint.jsonc pins no abap2UI5 branch/tag - the bench cannot know which framework to judge against');
  return dep.branch;
}

/** The framework sources at that tag, cloned once. */
export async function ensureFramework(ref) {
  const { frameworkRepo } = benchConfig();
  const safe = ref.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(CACHE_DIR, `abap2UI5-${safe}`);
  if (fs.existsSync(path.join(dir, 'src', '02', 'z2ui5_if_client.intf.abap'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await git(['clone', '-q', '--depth', '1', '--branch', ref, frameworkRepo, tmp]);
  fs.renameSync(tmp, dir);
  return dir;
}

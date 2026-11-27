/*
 * lint - abaplint over the deployed dev apps (split out of lib/runtime.mjs,
 * which re-exports it): the config each backend's sandbox is linted with,
 * lintApp through the warm worker (lib/lint-host.mjs) or a fresh process,
 * and scope_of over the corpus' script.
 */
import fs from 'fs';
import path from 'path';
import { resolveAppTemplate } from './repos.mjs';
import { timeoutOf, spawnWithTimeout, localBin, missingBinMessage, timedOutError } from './spawn.mjs';
import { lintWarm } from './lint-host.mjs';
import { downportDir, prepareRuntime, RUNTIME_PKG } from './npm-backend.mjs';
import { readInside, writeInside } from './contain.mjs';
import { corpus, FRAMEWORK_SANDBOX, sandbox } from './sandbox.mjs';

// ------------------------------------------------------------------ lint ----

// strip // and /* */ comments outside strings so the repo's abaplint.jsonc
// can be parsed and patched (a naive regex would eat the // in dependency URLs)
export function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  /* Where the STRUCTURAL commas landed in `out`. Trailing-comma removal has to
   * know which commas are punctuation and which are text: a regex over the
   * finished output cannot tell them apart, and an abaplint exclude pattern
   * like `app[,]x` would come out as `app[]x` - a character class matching
   * nothing, so the exclusion silently stops excluding. */
  const commas = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
    } else if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
    } else if (inStr) {
      out += c;
      if (c === '\\') {
        out += n;
        i++;
      } else if (c === '"') {
        inStr = false;
      }
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      inLine = true;
    } else if (c === '/' && n === '*') {
      inBlock = true;
      i++;
    } else {
      if (c === ',') commas.push(out.length);
      out += c;
    }
  }
  // comments are gone from `out` by now, so "trailing" is decided by the next
  // non-whitespace character alone
  const drop = new Set();
  for (const at of commas) {
    let j = at + 1;
    while (j < out.length && /\s/.test(out[j])) j++;
    if (out[j] === '}' || out[j] === ']') drop.add(at);
  }
  if (!drop.size) return out;
  // split('') and not [...out]: the offsets in `drop` come from out.length,
  // which counts UTF-16 code units, while the spread iterates code POINTS.
  // One astral character anywhere before a trailing comma - an emoji in a
  // description is enough - shifts every later index by one and deletes the
  // wrong character, turning a valid config into unparseable JSON.
  return out.split('').filter((_, i) => !drop.has(i)).join('');
}

/* The repo config, relaxed for the dev sandbox: zz_dev is not excluded and
 * object_naming accepts any customer-namespace name.
 *
 * The corpus config demands the Z2UI5_CL_SMPC_ port prefix, which a user's app
 * must not be forced into; this used to relax it only as far as Z2UI5_CL_,
 * which was the same mistake one layer down - it made `zcl_app_001`, the name
 * app-template ships, a lint failure on a class this server had just accepted.
 * `^[ZY]` is the customer namespace and the same boundary classNameOf( )
 * enforces, so the two cannot disagree about what a legal app is. */
function devLintConfig(box, runtime = null) {
  let cfg;
  if (box.kind === 'corpus') cfg = corpusLintConfig(readInside(box.root, 'abaplint.jsonc', 'utf8', 'the samples-controls checkout'));
  else if (box.kind === 'npm') cfg = frameworkLintConfig(templateLintConfigText(), npmLintTarget(box, runtime));
  else cfg = frameworkLintConfig(templateLintConfigText());
  // must sit in the repo root — the config's files glob resolves relative to
  // the config file's directory
  /* into a checkout (the corpus' root, the framework's): never through a
   * link there - a checkout shipping .abaplint-mcp-dev.jsonc as a link to
   * ~/.bashrc had every deploy overwrite it (lib/contain.mjs) */
  const configPath = writeInside(box.root, '.abaplint-mcp-dev.jsonc', JSON.stringify(cfg, null, 2), 'the checkout the sandbox lives in');
  return { configPath, cfg };
}

/* The npm sandbox's lint target, relative to the workspace root the config
 * sits in: the sandbox as the files, the release's downport/ - the ABAP its
 * output/ was transpiled from - as the framework dependency. Pure. */
export function npmLintTarget(box, runtime) {
  const rel = (p) => '/' + path.relative(box.root, p).split(path.sep).join('/');
  return { files: `${rel(box.dir)}/**/*.*`, folder: rel(downportDir(runtime)) };
}

/** The corpus' own config, relaxed to the customer namespace. Pure. */
export function corpusLintConfig(text) {
  const cfg = JSON.parse(stripJsonc(text));
  if (cfg.global && Array.isArray(cfg.global.exclude)) {
    cfg.global.exclude = cfg.global.exclude.filter((e) => e !== 'zz_dev');
  }
  if (cfg.rules && cfg.rules.object_naming) {
    cfg.rules.object_naming.clas = '^[ZY]';
    cfg.rules.object_naming.intf = '^[ZY]';
  }
  return cfg;
}

/* app-template's abaplint.jsonc, the lint a real project runs: read from the
 * template checkout, or from its GitHub mirror when there is none (the
 * server hydrates the template before deploy_app for exactly this read). A
 * missing template is a missing lint, and the deploy says so rather than
 * inventing a rule set here. */
function templateLintConfigText() {
  const root = resolveAppTemplate();
  const file = root && path.join(root, 'abaplint.jsonc');
  if (!file || !fs.existsSync(file)) {
    throw new Error('the framework sandbox lints with app-template\'s abaplint.jsonc, and no app-template checkout or mirror is there — '
      + 'clone https://github.com/abap2UI5/app-template as a sibling of mcp-server or point APP_TEMPLATE_HOME at one (or let the GitHub mirror fetch it: unset A2UI5_MCP_OFFLINE)');
  }
  return readInside(root, 'abaplint.jsonc', 'utf8', 'the app-template checkout');
}

/** The template's config retargeted at the framework sandbox: the dev apps
 *  are the files, the framework sources next door are the dependency
 *  (instead of the clone the template's config asks abaplint for), the
 *  customer namespace is the naming rule. Pure. */
export function frameworkLintConfig(text, { files = `/${FRAMEWORK_SANDBOX.join('/')}/**/*.*`, folder = '/src' } = {}) {
  const cfg = JSON.parse(stripJsonc(text));
  cfg.global = { ...(cfg.global || {}), files };
  delete cfg.global.exclude;
  cfg.dependencies = [{ folder, files: '/**/*.*' }];
  cfg.rules = cfg.rules || {};
  if (cfg.rules.object_naming && typeof cfg.rules.object_naming === 'object') {
    cfg.rules.object_naming = { ...cfg.rules.object_naming, clas: '^[ZY]', intf: '^[ZY]' };
  }
  return cfg;
}

/* Lints run ONE AT A TIME, in call order.
 *
 * The config file has to sit in the corpus root - the config's `files` glob
 * resolves relative to the config's own directory - so every lint writes the
 * same path into a repository this server does not own, and every lint deletes
 * it again in a finally. Concurrently, that is a race with one loser: the
 * first call to finish removes the config the second call's abaplint is still
 * reading, and that call fails with a parse error naming a file that no longer
 * exists. buildBackend solved its version of this with single-flight; this is
 * the same idea, queued rather than refused, because a lint is seconds and
 * waiting for one is cheaper than telling the agent to try again.
 *
 * Queued rather than given a per-call file name on purpose: `.abaplint-mcp-dev.jsonc`
 * is the exact path the corpus gitignores, and a suffixed sibling of it would
 * be an untracked file in somebody else's worktree the first time this process
 * is killed mid-lint. */
let lintQueue = Promise.resolve();

export function lintApp(className, { signal, onLine } = {}) {
  const run = lintQueue.then(() => lintOnce(className, { signal, onLine }), () => lintOnce(className, { signal, onLine }));
  // the queue only sequences; a failed lint must not poison the calls behind it
  lintQueue = run.then(() => {}, () => {});
  return run;
}

/* The findings of ONE class out of the whole repository's: the files of that
 * object (`<cls>.clas.abap`, `.clas.xml`, its includes), matched on the file
 * NAME. A substring test on the path used to hand a class the findings of
 * every class whose name ends in its own - deploying `z_app` reported
 * `zz_app`'s, and failed a clean class (verify_app stopped at deploy). Pure. */
export function issuesOfClass(issues, cls) {
  const name = String(cls).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`(?:^|[\\\\/])${name}\\.clas\\.[^\\\\/]*$`, 'i');
  return (issues || []).filter((i) => own.test(String(i.file || '')));
}

// abaplint with the relaxed dev config (dev sandbox included); returns only
// the findings for the given class file plus a total count
async function lintOnce(className, { signal, onLine } = {}) {
  const cls = String(className || '').toLowerCase();
  // the config has to sit in the corpus root (its files glob resolves from
  // there), so this server writes a file into a repository it does not own.
  // Removed again in the finally below - the way e2e-transpile.json already
  // is - rather than left behind for a .gitignore line in the other
  // repository to hide.
  const box = sandbox();
  const root = box.root;
  /* The npm sandbox lints with the abaplint the RELEASE's runtime directory
   * installs (at app-template's pin), against that release's downport/ - so
   * the first deploy on a bare machine installs the runtime (the same
   * install the build would make, queued with it, once). */
  let binRoot = root;
  let runtime = null;
  if (box.kind === 'npm') {
    const rt = await prepareRuntime({ withLint: true, onLine, signal, timeoutMs: timeoutOf('A2UI5_MCP_BUILD_TIMEOUT_MS') });
    if (!rt.ok) {
      return {
        ok: false,
        ...(rt.aborted ? { aborted: true } : {}),
        issues: [{ rule: rt.aborted ? 'cancelled' : 'runtime-missing', message: `the lint runs the abaplint of the ${RUNTIME_PKG} runtime, and it is not installed: ${rt.reason}` }],
        totalRepoIssues: -1,
      };
    }
    binRoot = runtime = rt.dir;
  }
  const abaplint = localBin(binRoot, '@abaplint/cli', 'abaplint');
  if (!abaplint) {
    return {
      ok: false,
      issues: [{
        rule: 'abaplint-missing',
        message: missingBinMessage(binRoot, '@abaplint/cli', 'abaplint',
          box.kind === 'framework' ? ' (build_backend mode prebuilt runs it when it unpacks a backend)' : ''),
      }],
      totalRepoIssues: -1,
    };
  }
  const { configPath, cfg } = devLintConfig(box, runtime);
  /* The warm worker first (lib/lint-host.mjs): the same @abaplint/core as
   * that abaplint, kept with the framework parsed, answers the CLI's JSON
   * without a process per lint. Whatever it cannot do - no core of the
   * CLI's version beside it, a config it does not mirror (the corpus'),
   * a worker that died - the CLI runs exactly as it always has. */
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let issues = null;
  try {
    const warm = await lintWarm({
      binRoot, base: root, config: cfg, sandboxDir: box.dir,
      timeoutMs: timeoutOf('A2UI5_MCP_LINT_TIMEOUT_MS'), signal, onLine,
    });
    if (warm.used) {
      ({ timedOut = false, aborted = false } = warm);
      if (warm.ok) issues = warm.issues;
    } else {
      if (onLine) onLine(`abaplint: ${warm.why} - running the CLI`);
      const spawned = await spawnWithTimeout(
        process.execPath,
        [abaplint, configPath, '--format', 'json'],
        /* the WHOLE sandbox's findings as one JSON document: cut to the last
         * 256 KiB, one app with many findings made the JSON unparsable and
         * every later deploy's lint a 'parse' failure */
        { cwd: root, timeoutMs: timeoutOf('A2UI5_MCP_LINT_TIMEOUT_MS'), signal, onLine, keepChars: 64 * 1024 * 1024 },
      );
      ({ stdout, stderr, timedOut, aborted } = spawned);
    }
  } finally {
    try { fs.rmSync(configPath, { force: true }); } catch { /* best effort */ }
  }
  if (aborted) {
    return {
      ok: false,
      aborted: true,
      issues: [{ rule: 'cancelled', message: 'abaplint cancelled by the client — its process tree was killed' }],
      totalRepoIssues: -1,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      issues: [{ rule: 'timeout', message: timedOutError('abaplint', 'A2UI5_MCP_LINT_TIMEOUT_MS') }],
      totalRepoIssues: -1,
    };
  }
  try {
    if (issues === null) {
      const start = stdout.indexOf('[');
      issues = JSON.parse(stdout.slice(start));
    }
    const mine = issuesOfClass(issues, cls);
    /* the first MAX_LINT_ISSUES, and how many of each rule: 601 findings
     * answered 78,887 characters */
    const shown = mine.slice(0, MAX_LINT_ISSUES);
    const byRule = {};
    for (const i of mine) byRule[i.key] = (byRule[i.key] || 0) + 1;
    return {
      ok: mine.length === 0,
      issues: shown.map((i) => ({
        rule: i.key,
        message: i.description,
        line: i.start && i.start.row,
      })),
      ...(mine.length > shown.length ? { more: `${mine.length - shown.length} more finding(s) not listed`, byRule } : {}),
      totalRepoIssues: issues.length,
    };
  } catch {
    return { ok: false, issues: [{ rule: 'parse', message: (stderr || stdout).slice(-800) }], totalRepoIssues: -1 };
  }
}

/** The findings one lint answer lists (the rest are counted per rule). */
const MAX_LINT_ISSUES = 100;

// ----------------------------------------------------------------- scope ----

// in/out-of-scope verdict for UI5 control entities, via the corpus'
// scripts/scope-of.mjs CLI (exit 0 = all in scope)
export async function runScopeOf(entities, { signal } = {}) {
  const { code, stdout, stderr, timedOut, aborted } = await spawnWithTimeout(
    process.execPath, // this server's node, not whichever `node` the client's PATH finds first
    [path.join(corpus(), 'scripts', 'scope-of.mjs'), ...entities],
    { cwd: corpus(), timeoutMs: timeoutOf('A2UI5_MCP_SCOPE_TIMEOUT_MS'), signal },
  );
  if (aborted) throw new Error('scope_of cancelled by the client — its process tree was killed');
  if (timedOut) throw new Error(timedOutError('scope-of', 'A2UI5_MCP_SCOPE_TIMEOUT_MS'));
  return { code, out: (stdout + stderr).trim() };
}

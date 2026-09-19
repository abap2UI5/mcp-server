/*
 * repos — locate the sibling checkouts this server orchestrates.
 *
 * mcp-server is the thin MCP layer; the machinery lives in:
 *   abap2UI5        the framework (transpiler config, express shim, node/output)
 *   samples-controls the corpus (e2e-build, capabilities map, generation
 *                   rules, the src/zz_dev deploy sandbox, @openui5 packages)
 *   linter          the view validation gates (abap2UI5-linter). Not
 *                   "optional": no other tool touches it, but validate_view
 *                   and screenshot_view — the fast loop — are dead without it
 *
 * Resolution order per repo: an explicitly set env var is authoritative — it
 * must point at a real checkout, a wrong path resolves to null so the tool
 * reports the misconfiguration instead of silently using a sibling guess —
 * otherwise the sibling directory of this server is used. Returns null when
 * absent — each tool reports what is missing instead of failing the whole
 * server.
 *
 * Several sibling repositories have been RENAMED, and every rename is absorbed
 * here rather than left to break a working setup: a checkout made from an
 * older instruction keeps its directory name, and an env var somebody set
 * months ago keeps its name too. So each repo carries a list of directory
 * names (newest first) and a list of env vars (newest first), and an existing
 * install keeps working without being touched.
 *
 * That history lives in `lib/repo-dirs.json`, not in this file, because it is
 * not only ours: abap2UI5/vscode-extension probes the same repos root and used
 * to keep a hand-written second copy in `src/repolayout.ts`, so the next rename
 * would have landed in one of the two. It now snapshots the JSON with a drift
 * gate, the way it already does for app-template and the client API. Add a
 * directory name THERE.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import os from 'os';
import { readCached } from './cache.mjs';
import { remoteRoot, remoteEnabled, isRemoteCheckout } from './remote.mjs';

/* Where this server clones a checkout it needs and nobody provided: the
 * framework, for build_backend mode prebuilt when no abap2UI5 checkout is
 * there. A per-user directory, never a sibling of an npx install (that is
 * inside node_modules), overridable for a machine that keeps its checkouts
 * elsewhere. A clone that lands here is a REAL checkout - git history, npm
 * install, a built backend - and resolves like any other local one. */
export function workspaceRoot() {
  return process.env.A2UI5_MCP_WORKSPACE || path.join(os.homedir(), '.abap2ui5-mcp');
}

export const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The rename history, read rather than transcribed. An import assertion would
 * tie this file to a Node version's JSON-module syntax for no gain; the file
 * sits next to this one and is read once at load. */
export const REPO_DIRS = JSON.parse(
  fs.readFileSync(path.join(SERVER_ROOT, 'lib', 'repo-dirs.json'), 'utf8'),
).repos;

/** Directory names a checkout of `key` can carry, newest first. */
const dirsOf = (key) => REPO_DIRS[key].dirs;
/** Env vars that override the guess for `key`, newest first. */
const envOf = (key) => REPO_DIRS[key].env;
/** A file that proves a candidate directory really is that checkout. */
const probeOf = (key) => REPO_DIRS[key].probe;
/** Extra checks where the probe file alone cannot tell two repos apart. */
const identifyOf = (key) => REPO_DIRS[key].identify || [];

/** Sibling candidates for `key`: one path per directory name it can carry. */
const siblingsOf = (key) => dirsOf(key).map((d) => path.join(SERVER_ROOT, '..', d));

/*
 * Does `dir` pass the identity checks for this repo?
 *
 * Two probes were not unique to their repository, and both failures happened
 * far from their cause. `samples` and `samplesStack` both probed `SAMPLES.md`,
 * which all three catalogue repositories generate, so a SAMPLES_HOME pointing
 * at a samples-stack checkout resolved cheerfully as `samples` and every
 * answer came from the wrong catalogue. `viewCheck` probed a bare
 * `package.json`, so ANY Node project in a directory named `linter` resolved
 * as the linter - and said so only later, inside importViewCheck, as "does not
 * export '.'", which reads as an out-of-date linter rather than as "that is
 * not a linter checkout".
 *
 * A check is SKIPPED when its file is absent, does not parse, or has no such
 * key: the probe is deliberately the cheap existence test, and a checkout made
 * before catalogue.json existed has to keep resolving (the compatibility
 * surface in AGENTS.md says so in as many words). What it must not do is
 * resolve to the WRONG repository, and a file that IS there and names another
 * repository is proof of exactly that.
 */
function identified(dir, checks) {
  for (const c of checks) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, c.file), 'utf8'));
    } catch {
      continue; // no such file, or not JSON: this check cannot tell
    }
    const value = data && typeof data === 'object' ? data[c.key] : undefined;
    /* A key that is not there usually means "written before this file carried
     * it" - except where the check reads the PROBE file itself, as the linter's
     * does: a package.json with no exports map is not an older linter, it is
     * not a linter, and `required` says so. */
    if (value === undefined || value === null) {
      if (c.required) return false;
      continue;
    }
    if (c.equals !== undefined && String(value).toLowerCase() !== String(c.equals).toLowerCase()) return false;
    if (Array.isArray(c.hasKeys)) {
      if (typeof value !== 'object') return false;
      if (!c.hasKeys.every((k) => Object.prototype.hasOwnProperty.call(value, k))) return false;
    }
  }
  return true;
}

function firstExisting(cands, probe, identify = []) {
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, probe)) && identified(c, identify)) return path.resolve(c);
  }
  return null;
}

/* The read-only GitHub mirror of `key` (lib/remote.mjs), when one has been
 * fetched: the LAST candidate, after every local one, and never when an env
 * var is set. Its marker file is its probe - a mirror is trusted by
 * construction, and the identify checks read files it need not carry. */
function mirrorOf(key) {
  if (!key || !remoteEnabled()) return null;
  const root = remoteRoot(key);
  return isRemoteCheckout(root) ? root : null;
}

// explicit env var wins outright (even when it points nowhere); the sibling
// candidates are only guessed at when the user configured nothing, and the
// mirror only after every sibling candidate failed
function resolveRepo(envVars, siblings, probe, identify = [], { key = null, local = false } = {}) {
  // the first env var that is SET decides, even if it points nowhere: that is
  // a misconfiguration to report, not a reason to fall through to a guess -
  // and not a reason to download a mirror either
  const explicit = [envVars].flat().map((v) => process.env[v]).find(Boolean);
  if (explicit) return firstExisting([explicit], probe, identify);
  return firstExisting(siblings, probe, identify) || (local ? null : mirrorOf(key));
}

/* Directory names the corpus checkout can carry, newest first. The repository
 * is github.com/abap2UI5/samples-controls today; it was `abap2UI5-api` before
 * that and `ai-demokit` before that. GitHub redirects the old paths, so a
 * clone made from an outdated README still sits in a directory named after
 * whichever name it was cloned under — all three resolve. */
export const CORPUS_DIRS = dirsOf('corpus');

/** The corpus checkout: e2e-build, the capability map, the scope gate, the
 *  deploy sandbox and the @openui5 packages the render/boot path serves. */
export function resolveSamplesControls(opts) {
  return resolveRepo(envOf('corpus'), siblingsOf('corpus'), probeOf('corpus'), [], { key: 'corpus', ...opts });
}

export function resolveA2UI5(opts) {
  // a mirror of the corpus carries no .abap2UI5 clone, so only a LOCAL corpus
  // contributes that candidate
  const corpus = resolveSamplesControls({ local: true });
  return resolveRepo(
    envOf('a2ui5'),
    [
      ...siblingsOf('a2ui5'),
      // the in-repo clone the corpus' `npm run node:setup` creates — a
      // backend built there must be found here too
      corpus && path.join(corpus, '.abap2UI5'),
      // the clone build_backend mode prebuilt makes when nothing else is there
      path.join(workspaceRoot(), dirsOf('a2ui5')[0]),
    ],
    probeOf('a2ui5'),
    [],
    { key: 'a2ui5', ...opts },
  );
}

/* The sample catalogue: what each app shows, which is what an agent asking
 * "is there already a sample for X" has to search. A different repository
 * from the corpus on purpose - samples-controls answers "which CONTROL can I
 * express" (the UI5 demo kit, ported), samples answers "which PATTERN has
 * somebody already built". Both questions come up while building an app and
 * neither answers the other.
 *
 * Sizes deliberately not quoted here: each repository states its own in its
 * generated SAMPLES.md / STATUS.md, and a number copied into a comment is one
 * nothing re-measures. This file had said 152 and 416 long after both moved. */
export const SAMPLES_DIRS = dirsOf('samples');

export function resolveSamples(opts) {
  return resolveRepo(envOf('samples'), siblingsOf('samples'), probeOf('samples'), identifyOf('samples'), { key: 'samples', ...opts });
}

/* The third catalogue: apps that need something from the STACK - an OData
 * service, a RAP behavior definition, an APC channel, the Fiori launchpad.
 * They are a separate repository because they cannot be run on a bare
 * abap2UI5 install, which is exactly what an agent has to know before
 * proposing one. */
export const SAMPLES_STACK_DIRS = dirsOf('samplesStack');

export function resolveSamplesStack(opts) {
  return resolveRepo(envOf('samplesStack'), siblingsOf('samplesStack'), probeOf('samplesStack'), identifyOf('samplesStack'), { key: 'samplesStack', ...opts });
}

/* The starter project. Not a catalogue and not a corpus: the files a new
 * repository begins with - both gate configs, the CI workflow, the abapGit
 * metadata and one working app class. An agent that has read the guide can
 * write the CLASS; what it cannot invent is the abaplint pin, the linter
 * config and the sidecar, and those are exactly what decides whether the
 * result imports into a system and passes a check. */
export const APP_TEMPLATE_DIRS = dirsOf('appTemplate');

export function resolveAppTemplate(opts) {
  return resolveRepo(envOf('appTemplate'), siblingsOf('appTemplate'), probeOf('appTemplate'), [], { key: 'appTemplate', ...opts });
}

/* The documentation site's sources. What `docs_search` reads is the same
 * markdown the published site renders - searched locally because a web search
 * mid-task is exactly what the sibling model exists to avoid. The published
 * page for docs/<path>.md is https://abap2ui5.github.io/docs/<path>.html, and
 * its raw markdown twin <path>.md is published beside it (the docs repo's
 * generate-llms.mjs writes it), so a hit can hand back both URLs. */
export const DOCS_DIRS = dirsOf('docs');

export function resolveDocs(opts) {
  return resolveRepo(envOf('docs'), siblingsOf('docs'), probeOf('docs'), identifyOf('docs'), { key: 'docs', ...opts });
}

/* Directory names a linter checkout can carry, newest first: `linter` is the
 * repository's own name (github.com/abap2UI5/linter), the other two are what
 * `git clone` produced under its earlier names. The old names still resolve on
 * GitHub, so a checkout made from an outdated instruction is still found. */
export const VIEW_CHECK_DIRS = dirsOf('viewCheck');

export function resolveViewCheck() {
  return resolveRepo(envOf('viewCheck'), siblingsOf('viewCheck'), probeOf('viewCheck'), identifyOf('viewCheck'));
}

/* Import a module from the linter checkout through its package.json `exports`
 * map — the only file-layout contract the linter maintains. Reaching for
 * lib/<file>.mjs directly would couple this server to an internal layout that
 * a refactor may change while the linter's own tests stay green. */
export async function importViewCheck(sub = '.') {
  const vc = resolveViewCheck();
  if (!vc) return null;
  // mtime-cached (lib/cache.mjs): every sub-path import re-read and re-parsed
  // this file per call; a pulled linter still invalidates it naturally
  const pkg = readCached(path.join(vc, 'package.json'), (text) => JSON.parse(text));
  const entry = (pkg.exports || {})[sub];
  // an export target is either a plain path or a conditional-exports object
  // ({ types, import, default, ... }) — resolve it the way Node would
  const target =
    typeof entry === 'string' ? entry : entry && (entry.import ?? entry.node ?? entry.default);
  if (typeof target !== 'string') {
    throw new Error(`linter checkout at ${vc} does not export '${sub}' — update the checkout (git pull)`);
  }
  return import(pathToFileURL(path.join(vc, target)).href);
}

/* Which project's abap2ui5lint.jsonc validate_view judges a source by.
 *
 * It used to be the corpus and only the corpus: an app in someone else's
 * repository was measured against samples-controls' rule overrides, allow
 * list and UI5 floor, and the tool had no argument to say otherwise — while
 * its own description promised the checked project's config was honoured.
 *
 * `find` is the linter's findConfigFrom (searches a directory upwards).
 * A named project is taken at its word: its config or none, never a silent
 * fallback onto a config the caller did not point at.
 */
export function resolveLintConfig(find, { projectDir, cwd, corpus } = {}) {
  if (projectDir) return find(projectDir) || null;
  return find(cwd) || (corpus ? find(corpus) : null) || null;
}

/* The resolvers by repo key, for the code that works over the table rather
 * than over one repository - the server's mirror step (lib/remote.mjs) asks
 * "does a LOCAL checkout of this key exist" before it downloads anything.
 * The linter has no mirror (it needs an install, not a file), so it is not
 * in this map. */
export const RESOLVERS = {
  a2ui5: resolveA2UI5,
  corpus: resolveSamplesControls,
  samples: resolveSamples,
  samplesStack: resolveSamplesStack,
  appTemplate: resolveAppTemplate,
  docs: resolveDocs,
};

/** A checkout of `key`: local, or the mirror unless `local` is asked for. */
export function resolveKey(key, opts) {
  const r = RESOLVERS[key];
  return r ? r(opts) : null;
}

/** The env var that is SET for `key` (its name), or null when the user
 *  configured nothing - the mirror is only consulted in the latter case. */
export function explicitEnv(key) {
  if (!REPO_DIRS[key]) return null;
  return envOf(key).find((v) => Boolean(process.env[v])) || null;
}

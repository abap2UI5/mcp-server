#!/usr/bin/env node
/*
 * Vendors the Adaptive Cards renderer of abap2UI5/protocol into this server:
 *
 *   renderers/adaptive-cards/render.mjs   -> lib/vendor/adaptive-cards/render.mjs
 *   renderers/adaptive-cards/mapping.mjs  -> lib/vendor/adaptive-cards/mapping.mjs
 *   renderers/adaptive-cards/submit.mjs   -> lib/vendor/adaptive-cards/submit.mjs
 *
 * What the app tools do with it: `format: "adaptive-card"` adds the screen
 * as an Adaptive Card 1.5 to app_start / app_describe / app_act
 * (lib/adaptive-card.mjs). The renderer is a prototype of the protocol
 * repository and is maintained THERE, against the protocol's portable
 * profile and its conformance suite; a second renderer written here would be
 * the copy that drifts. It is not an npm dependency either (the protocol
 * repository publishes no package the server could pin), so the code is
 * copied mechanically, at a recorded COMMIT rather than a moving branch: code
 * changes behaviour, and a bump has to go through this repository's tests.
 *
 * The one transformation: the renderer reads view XML and folds responses
 * with the agent modules the protocol repository vendors FROM this
 * repository (`conformance/frontend/adapters/vendor/mcp-server/{viewxml,
 * snapshot,appclient}.mjs`). Here those imports point at the originals in
 * lib/ (`../../viewxml.mjs`, ...) - a copy of a copy of our own modules
 * would be a second version of them in one process.
 *
 * Every copy starts with a header naming the repository, the path and the
 * commit; lib/vendor/adaptive-cards/source.json records the commit and the
 * sha256 of every file written, and test/vendor.test.mjs (npm test, offline)
 * fails when a copy no longer matches its recorded hash - a hand edit - and,
 * when a protocol checkout with that commit is next to this repository,
 * when the copies differ from what this script makes of it.
 *
 *   node scripts/vendor-adaptive-cards.mjs /path/to/protocol             (its HEAD)
 *   node scripts/vendor-adaptive-cards.mjs /path/to/protocol --ref <rev>
 *   node scripts/vendor-adaptive-cards.mjs --ref <sha>                   (GitHub raw)
 *   node scripts/vendor-adaptive-cards.mjs [/path/to/protocol] --check
 *        (regenerates from the RECORDED commit in memory and fails when a
 *         committed copy differs - the copy drifted from its source commit)
 *
 * A local checkout is read through `git show <commit>:<path>`, so its working
 * tree and branch do not matter - only that it has the commit.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'abap2UI5/protocol';
const TOOL = 'vendor-adaptive-cards';
export const VENDOR_DIR = 'lib/vendor/adaptive-cards';
export const SOURCE_RECORD = `${VENDOR_DIR}/source.json`;
const FETCH_TIMEOUT_MS = 30_000;

/** The modules, upstream path -> vendored path. The renderer shares its
 *  view and request halves with the protocol's other renderers
 *  (renderers/common/), and the view half reads the portable profile. */
export const MODULES = {
  'renderers/adaptive-cards/render.mjs': `${VENDOR_DIR}/render.mjs`,
  'renderers/adaptive-cards/mapping.mjs': `${VENDOR_DIR}/mapping.mjs`,
  'renderers/adaptive-cards/submit.mjs': `${VENDOR_DIR}/submit.mjs`,
  'renderers/common/view.mjs': `${VENDOR_DIR}/common/view.mjs`,
  'renderers/common/request.mjs': `${VENDOR_DIR}/common/request.mjs`,
};

/** Data files, copied byte for byte (no header - JSON takes no comment). */
export const DATA = {
  'profiles/portable-v1.json': `${VENDOR_DIR}/profiles/portable-v1.json`,
};

/** Where the protocol repository keeps its copies of this repository's agent modules. */
const UPSTREAM_AGENT_DIR = 'conformance/frontend/adapters/vendor/mcp-server/';

/** The header every vendored module starts with. */
export function moduleHeader(from, commit) {
  return (
    '/*\n'
    + ` * VENDORED - do not edit. ${REPO} ${from}\n`
    + ` * at commit ${commit},\n`
    + ' * copied by scripts/vendor-adaptive-cards.mjs; the only change is that the\n'
    + ' * relative paths point at the vendored folder, and the imports of the agent\n'
    + ' * modules at lib/ (the originals the protocol repository vendors) instead of\n'
    + ' * its copies. `node scripts/vendor-adaptive-cards.mjs\n'
    + ' * --check` fails when this copy drifts from that commit. Change it upstream,\n'
    + ' * then re-vendor.\n'
    + ' */\n'
  );
}

/* A relative path in `from` (upstream) -> the same target, relative to where
 * `from` is vendored: an agent module is lib/'s original, a vendored module
 * or data file its copy. Anything else is refused - extend the tables. */
function rewritePath(rel, from, commit) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), rel));
  let to;
  if (target.startsWith(UPSTREAM_AGENT_DIR) && /^(viewxml|snapshot|appclient)\.mjs$/.test(target.slice(UPSTREAM_AGENT_DIR.length))) {
    to = `lib/${target.slice(UPSTREAM_AGENT_DIR.length)}`;
  } else {
    to = MODULES[target] || DATA[target];
  }
  if (!to) throw new Error(`${from} at ${commit} refers to ${target}, which is not vendored - extend MODULES or DATA`);
  const out = MODULES[from];
  const r = path.posix.relative(path.posix.dirname(out), to);
  return r.startsWith('.') ? r : `./${r}`;
}

/** One upstream module as it is vendored. */
export function vendorModule(text, from, commit) {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/(from\s+|import\s*\(\s*|new URL\(\s*)"(\.\.?\/[^"]+)"/g, (m, lead, rel) => `${lead}"${rewritePath(rel, from, commit)}"`);
  if (body.includes('conformance/')) {
    throw new Error(`${from} at ${commit} imports something else from the protocol repository's conformance tree - extend the rewrite`);
  }
  return moduleHeader(from, commit) + body;
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function git(local, args) {
  return execFileSync('git', ['-C', local, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Where the upstream files come from: a local checkout's git objects, or GitHub raw at the commit. */
function upstream(local, commit) {
  if (local) return { read: async (file) => git(local, ['show', `${commit}:${file}`]) };
  return {
    read: async (file) => {
      const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${file}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return res.text();
    },
  };
}

async function resolveCommit(local, ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  if (local) return git(local, ['rev-parse', `${ref}^{commit}`]).trim();
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: { accept: 'application/vnd.github.sha' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cannot resolve ${REPO}@${ref} -> HTTP ${res.status}`);
  return (await res.text()).trim();
}

/** Every vendored file, path -> content, for one commit. */
export async function build(local, commit) {
  const src = upstream(local, commit);
  const files = {};
  const from = {};
  for (const [up, out] of Object.entries(MODULES)) {
    files[out] = vendorModule(await src.read(up), up, commit);
    from[out] = up;
  }
  for (const [up, out] of Object.entries(DATA)) {
    files[out] = (await src.read(up)).replace(/\r\n/g, '\n');
    from[out] = up;
  }
  const record = {
    note: `What scripts/vendor-adaptive-cards.mjs copied from ${REPO}, at which commit, and the sha256 of every file it wrote. `
      + 'Generated - do not edit; test/vendor.test.mjs holds the copies to these hashes.',
    repository: REPO,
    commit,
    files: Object.fromEntries(Object.keys(files).sort().map((out) => [out, { from: from[out], sha256: sha256(files[out]) }])),
  };
  files[SOURCE_RECORD] = `${JSON.stringify(record, null, 2)}\n`;
  return files;
}

/** What is committed under the vendor folder right now. */
export function committedFiles(root = ROOT) {
  const out = {};
  const abs = path.join(root, VENDOR_DIR);
  if (!fs.existsSync(abs)) return out;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else out[`${rel}/${e.name}`] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(abs, VENDOR_DIR);
  return out;
}

/** The differences between the committed copies and what `build` makes: [] when none. */
export function drift(want, have) {
  const problems = [];
  for (const [file, text] of Object.entries(want)) {
    if (have[file] === undefined) problems.push(`missing: ${file}`);
    else if (have[file] !== text) problems.push(`differs: ${file}`);
  }
  for (const file of Object.keys(have)) if (want[file] === undefined) problems.push(`not vendored from upstream (remove it): ${file}`);
  return problems;
}

function fail(message, code = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const refAt = argv.indexOf('--ref');
  const ref = refAt >= 0 ? argv[refAt + 1] : undefined;
  if (refAt >= 0 && (!ref || ref.startsWith('--'))) fail('--ref needs a value (a commit, tag or branch)');
  const local = argv.find((a, i) => !a.startsWith('--') && !(refAt >= 0 && i === refAt + 1));
  const recordPath = path.join(ROOT, SOURCE_RECORD);
  const recorded = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')).commit : undefined;
  try {
    if (check) {
      if (!recorded) fail(`${SOURCE_RECORD} is missing - vendor first`);
      const want = await build(local, recorded);
      const problems = drift(want, committedFiles());
      if (problems.length) {
        console.error(`${TOOL}: the vendored renderer DRIFTED from ${REPO}@${recorded}:`);
        for (const p of problems) console.error(`  ${p}`);
        console.error(`Re-vendor with \`node scripts/vendor-adaptive-cards.mjs /path/to/protocol --ref ${recorded}\` (or a newer commit) instead of editing the copies.`);
        process.exit(1);
      }
      console.log(`adaptive-cards vendor: up to date with ${REPO}@${recorded.slice(0, 12)} (${Object.keys(want).length} files)`);
    } else {
      if (!local && !ref) fail('name the source - a local checkout (its HEAD is taken) and/or --ref <commit>');
      const commit = await resolveCommit(local, ref || 'HEAD');
      const files = await build(local, commit);
      for (const file of Object.keys(committedFiles())) if (files[file] === undefined) fs.rmSync(path.join(ROOT, file));
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
        fs.writeFileSync(path.join(ROOT, file), text);
      }
      console.log(`adaptive-cards vendor: ${Object.keys(files).length} files from ${REPO}@${commit}`
        + (recorded && recorded !== commit ? ` (was ${recorded.slice(0, 12)})` : ''));
    }
  } catch (e) {
    fail(e.message, 2);
  }
}

#!/usr/bin/env node
/**
 * server.json is the listing in the official MCP Registry
 * (registry.modelcontextprotocol.io), published by release.yml after the npm
 * publish. It repeats four facts package.json already states - the version
 * (twice: the server's and the npm package's), the package name and the
 * registry name (`mcpName`, which is how the registry proves the npm package
 * belongs to the listing) - and every one of them is a publish that fails
 * AFTER npm already holds the immutable version when it drifts: the registry
 * fetches `@abap2ui5/mcp-server@<packages[].version>` from npm and compares
 * its `mcpName` with `name`.
 *
 * So this gate fails `npm test` (test/server-json.test.mjs) and the release
 * workflow when the copies disagree, and it keeps the listed environment
 * variables honest in both directions: a variable the listing names that the
 * server never reads is a lie on the registry page, and a variable the
 * server reads that the listing leaves out is a knob nobody finds. Variables
 * the server reads on purpose without listing them are named below, each
 * with its reason.
 *
 *   node scripts/check-server-json.mjs          (npm run check:server-json)
 *   node scripts/check-server-json.mjs --sync   (the `version` lifecycle script)
 *
 * --sync first writes package.json's version into both version fields of
 * server.json. package.json's `version` script runs it, so `npm version
 * patch|minor|major` - which bumps package.json and the lockfile, then runs
 * that script, then commits and tags - brings server.json along in the same
 * commit (the script `git add`s it). Nothing else is ever written.
 *
 * Exit 0 and one line when everything agrees, exit 1 and one line per
 * problem otherwise. No dependency, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read by the server, deliberately NOT in server.json. */
export const NOT_LISTED = {
  PORT: 'set by the server for the backend child it spawns (A2UI5_MCP_PORT is the knob)',
  CHROMIUM_BIN: "the linter's variable, read after A2UI5_MCP_CHROMIUM; listed under that one",
  GH_TOKEN: 'alias of GITHUB_TOKEN, named in its description',
  AI_DEMOKIT_HOME: 'pre-rename alias of SAMPLES_CONTROLS_HOME, still read for old setups',
  ABAP2UI5_MCP_HOME: "the VS Code extension's variable for a checkout of this repository; the server resolves nothing with it",
};

/** In server.json, but read by a child the server spawns rather than by its own code.
 *  (OPENUI5_SRC was, until scope_of read it too: it names the checkout
 *  scope-of.mjs reads when the answer is UNRESOLVED.) */
export const PASSED_THROUGH = {};

const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  // the timeouts are read through a helper by name (timeoutOf('A2UI5_MCP_...'))
  /\b(A2UI5_MCP_[A-Z0-9_]+)\b/g,
  // an injectable environment (`env = process.env` as a parameter, for the
  // tests): resolvePopups reads POPUPS_HOME that way, and the two patterns
  // above never saw it
  /\benv\.([A-Z][A-Z0-9_]*)/g,
  /\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
];

/** Every environment variable server.mjs and lib/ read, plus the repo-dirs.json overrides. */
export function envVarsReadByServer(root = ROOT) {
  const files = ['server.mjs', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`)];
  const names = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const re of ENV_PATTERNS) for (const m of text.matchAll(re)) names.add(m[1]);
  }
  const dirs = JSON.parse(fs.readFileSync(path.join(root, 'lib/repo-dirs.json'), 'utf8'));
  for (const repo of Object.values(dirs.repos)) for (const e of repo.env || []) names.add(e);
  return names;
}

/** Pure: the problems between package.json, server.json and the variables the code reads. */
export function serverJsonProblems({ pkg, server, envRead }) {
  const problems = [];
  const expect = (cond, msg) => { if (!cond) problems.push(msg); };

  expect(typeof pkg.mcpName === 'string' && pkg.mcpName.length > 0,
    'package.json has no "mcpName" - the registry validates npm ownership by it');
  expect(server.name === pkg.mcpName,
    `server.json name "${server.name}" differs from package.json mcpName "${pkg.mcpName}"`);
  const owner = /github\.com\/([^/]+)\//.exec(pkg.repository?.url || '')?.[1];
  expect(owner && server.name?.startsWith(`io.github.${owner}/`),
    `server.json name "${server.name}" is not in the namespace GitHub OIDC grants this repository (io.github.${owner}/*)`);
  expect(server.version === pkg.version,
    `server.json version ${server.version} differs from package.json version ${pkg.version}`);
  expect(typeof server.description === 'string' && server.description.length >= 1 && server.description.length <= 100,
    `server.json description must be 1-100 characters (is ${server.description?.length ?? 0})`);
  expect(/^[\x20-\x7e]*$/.test(server.description || ''),
    'server.json description must be plain ASCII (it is shown as-is in registry clients)');
  expect(/^https:\/\//.test(server.websiteUrl || 'https://'), 'server.json websiteUrl must use https');

  const npmPkgs = (server.packages || []).filter((p) => p.registryType === 'npm');
  expect(npmPkgs.length === 1, `server.json must list exactly one npm package (lists ${npmPkgs.length})`);
  for (const p of npmPkgs) {
    expect(p.identifier === pkg.name, `server.json package identifier "${p.identifier}" differs from package.json name "${pkg.name}"`);
    expect(p.version === pkg.version, `server.json package version ${p.version} differs from package.json version ${pkg.version}`);
    expect(p.transport?.type === 'stdio', `server.json package transport must be stdio (is ${p.transport?.type})`);
    expect(p.runtimeHint === 'npx', `server.json package runtimeHint must be npx (is ${p.runtimeHint})`);

    const listed = new Map();
    for (const v of p.environmentVariables || []) {
      expect(!listed.has(v.name), `server.json lists ${v.name} twice`);
      listed.set(v.name, v);
      expect(v.isRequired !== true, `server.json marks ${v.name} as required - every variable is optional, the server degrades without it`);
      expect(typeof v.description === 'string' && v.description.length > 0, `server.json ${v.name} has no description`);
      expect(!('default' in v), `server.json ${v.name} has a default - a client that sets it would make the guess authoritative (a set variable is never second-guessed)`);
      expect(envRead.has(v.name) || v.name in PASSED_THROUGH,
        `server.json lists ${v.name}, which the server never reads`);
    }
    for (const name of [...envRead].sort()) {
      expect(listed.has(name) || name in NOT_LISTED,
        `the server reads ${name}, but server.json does not list it (add it, or add it to NOT_LISTED in scripts/check-server-json.mjs with the reason)`);
    }
  }
  return problems;
}

export function checkRepo(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
  return { pkg, server, problems: serverJsonProblems({ pkg, server, envRead: envVarsReadByServer(root) }) };
}

/** Write package.json's version into server.json's two version fields; true when it changed. */
export function syncVersions(root = ROOT) {
  const file = path.join(root, 'server.json');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const before = fs.readFileSync(file, 'utf8');
  const server = JSON.parse(before);
  server.version = pkg.version;
  for (const p of server.packages || []) if (p.registryType === 'npm' && p.identifier === pkg.name) p.version = pkg.version;
  const after = `${JSON.stringify(server, null, 2)}\n`;
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--sync') && syncVersions()) console.log('server.json: versions synced from package.json');
  const { pkg, server, problems } = checkRepo();
  if (problems.length) {
    for (const p of problems) console.error(`server.json: ${p}`);
    process.exit(1);
  }
  console.log(`server.json ok: ${server.name} ${server.version} = ${pkg.name}@${pkg.version}, ${server.packages[0].environmentVariables.length} environment variables`);
}

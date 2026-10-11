/*
 * lint-worker — the long-lived abaplint child lib/lint-host.mjs runs.
 *
 * One lint used to be one fresh `abaplint <config> --format json` process,
 * and most of its 2.6 s was the parse of the DEPENDENCY folder - the
 * framework's sources (a release's downport/, a checkout's src/), the same
 * on every deploy. This child keeps ONE @abaplint/core Registry alive: the
 * dependency folder is read and parsed when the key its contents hang on
 * changes (lint-host computes it: the config, the folder, its files' names,
 * sizes and mtimes, the core version), and a lint since then only replaces
 * the sandbox files that changed, parses them and runs findIssues().
 *
 * Why a child and not the server's own process: findIssues( ) is
 * synchronous and seconds long on a cold registry, which would freeze the
 * stdio server for every other request, and the lint's timeout and the
 * client's cancel have to be able to END it - a child can be killed, a
 * synchronous call cannot. A killed worker costs the next lint its cold
 * parse, nothing else.
 *
 * Protocol (Node IPC, one request at a time): { id, op: 'lint', coreRoot,
 * base, config, sandboxDir, depFolders, depKey } answers { id, ok: true,
 * issues, reparsed, dependencyFiles, sandboxFiles, coreVersion } - `issues`
 * in exactly the shape the CLI's --format json writes (lint-host says why
 * that matters) - or { id, ok: false, error }. `coreRoot` is where
 * @abaplint/core is resolved from (the runtime directory or the checkout:
 * the one whose @abaplint/cli version it matches). Nothing but node
 * built-ins is imported here: this file is on the npm-backend path and runs
 * with whatever node_modules the caller names.
 *
 * The files the CLI would lint: the CLI loads `global.files` and each
 * dependency's `folder + files` through glob, keeps only names with at
 * least two dots (`zcl_a.clas.abap`, never `README.md`), and adds the
 * sandbox AFTER the dependencies so an object in both is the sandbox's.
 * Mirrored here over a directory walk that never follows a symbolic link
 * (a checkout is untrusted content).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

let core = null;
let coreFrom = null;
let registry = null;
let registryKey = null;
let sandbox = new Map(); // absolute file name -> text, as the registry holds it

/** Every regular file below `dir` whose name has two dots or more, posix
 *  absolute (the CLI's glob answers that spelling, and the issues name it). */
function lintableFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.split('.').length > 2) out.push(full.split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function loadCore(root) {
  if (core && coreFrom === root) return core;
  const req = createRequire(path.join(root, 'package.json'));
  core = req('@abaplint/core');
  coreFrom = root;
  registry = null;
  registryKey = null;
  sandbox = new Map();
  return core;
}

function serialize(issues) {
  return issues.map((issue) => ({
    description: issue.getMessage(),
    key: issue.getKey(),
    file: issue.getFilename(),
    start: { row: issue.getStart().getRow(), col: issue.getStart().getCol() },
    end: { row: issue.getEnd().getRow(), col: issue.getEnd().getCol() },
    severity: issue.getSeverity(),
  }));
}

function lint({ coreRoot, config, sandboxDir, depFolders, depKey }) {
  const { Registry, Config, MemoryFile } = loadCore(coreRoot);
  let reparsed = false;
  let dependencyFiles = 0;
  if (!registry || registryKey !== depKey) {
    registry = new Registry(new Config(JSON.stringify(config)));
    const deps = (depFolders || []).flatMap((folder) => lintableFiles(folder)).map((f) => new MemoryFile(f, fs.readFileSync(f, 'utf8')));
    dependencyFiles = deps.length;
    registry.addDependencies(deps);
    registryKey = depKey;
    sandbox = new Map();
    reparsed = true;
  }
  // the sandbox: what changed since the registry last saw it, and only that
  const now = new Map();
  for (const f of lintableFiles(sandboxDir)) now.set(f, fs.readFileSync(f, 'utf8'));
  for (const [f, text] of sandbox) {
    if (!now.has(f)) registry.removeFile(new MemoryFile(f, text));
  }
  for (const [f, text] of now) {
    const had = sandbox.get(f);
    if (had === undefined) registry.addFile(new MemoryFile(f, text));
    else if (had !== text) registry.updateFile(new MemoryFile(f, text));
  }
  sandbox = now;
  registry.parse();
  const issues = serialize(registry.findIssues());
  return {
    issues,
    reparsed,
    dependencyFiles: reparsed ? dependencyFiles : null,
    sandboxFiles: now.size,
    coreVersion: typeof Registry.abaplintVersion === 'function' ? Registry.abaplintVersion() : null,
  };
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.op === 'exit') {
    process.exit(0);
  }
  let reply;
  try {
    if (m.op !== 'lint') throw new Error(`unknown op ${m.op}`);
    reply = { id: m.id, ok: true, ...lint(m) };
  } catch (e) {
    reply = { id: m.id, ok: false, error: String((e && e.stack) || e) };
  }
  process.send(reply);
});

// the parent went away (its IPC channel closed): nothing to lint for any more
process.on('disconnect', () => process.exit(0));

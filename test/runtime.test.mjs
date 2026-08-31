// Child-process behavior of lib/runtime.mjs: per-spawn timeouts and the
// single-flight build. Sibling-free — where a checkout is needed the tests
// point the env vars at fake repos built in a temp dir (the resolvers treat a
// set env var as authoritative, see lib/repos.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnWithTimeout, buildBackend } from '../lib/runtime.mjs';

// ------------------------------------------------------- spawnWithTimeout ----

test('spawnWithTimeout kills a deliberately hung child and reports the timeout', async () => {
  const t0 = Date.now();
  const res = await spawnWithTimeout(
    process.execPath,
    ['-e', 'console.log("started"); setInterval(() => {}, 1000);'],
    { timeoutMs: 300 },
  );
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 10000, 'a hung child must not hang the call');
  assert.match(res.stdout, /started/, 'output before the kill is kept');
});

test('spawnWithTimeout kills the whole process tree, not just the direct child', { skip: !fs.existsSync('/proc') && 'needs /proc to verify' }, async () => {
  // the child prints its grandchild's pid, then both hang
  const script = `
    const { spawn } = require('child_process');
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
    console.log('grandpid=' + grand.pid);
    setInterval(() => {}, 1000);
  `;
  const res = await spawnWithTimeout(process.execPath, ['-e', script], { timeoutMs: 500 });
  assert.equal(res.timedOut, true);
  const pid = Number((res.stdout.match(/grandpid=(\d+)/) || [])[1]);
  assert.ok(pid > 0, `grandchild pid captured: ${res.stdout}`);
  await new Promise((r) => setTimeout(r, 200)); // let the SIGKILL land
  // dead = /proc entry gone, or still there as an unreaped zombie (state Z)
  let state = null;
  try {
    state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0];
  } catch {
    /* process fully gone */
  }
  assert.ok(state === null || state === 'Z', `grandchild must be dead, state=${state}`);
});

test('spawnWithTimeout leaves a fast child alone and streams its lines', async () => {
  const lines = [];
  const res = await spawnWithTimeout(
    process.execPath,
    ['-e', 'console.log("one"); console.log("two"); console.error("three");'],
    { timeoutMs: 30000, onLine: (l) => lines.push(l) },
  );
  assert.equal(res.timedOut, false);
  assert.equal(res.code, 0);
  assert.deepEqual(lines.sort(), ['one', 'three', 'two']);
});

test('spawnWithTimeout surfaces a spawn failure instead of rejecting', async () => {
  const res = await spawnWithTimeout('this-command-does-not-exist-xyz', [], { timeoutMs: 1000 });
  assert.equal(res.code, null);
  assert.match(res.stderr, /ENOENT/);
});

// ---------------------------------------------------------- buildBackend ----

// fake sibling checkouts carrying just the resolver probes and a scripted
// e2e-build; AI_DEMOKIT_HOME/A2UI5_HOME point here for the duration of a test
function fakeRepos(buildScript) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-fake-'));
  const demokit = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(demokit, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(demokit, 'scripts', 'e2e-build.mjs'), buildScript);
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');
  return { base, demokit, a2 };
}

async function withFakeRepos(buildScript, extraEnv, fn) {
  const { base, demokit, a2 } = fakeRepos(buildScript);
  const saved = {};
  /* AI_DEMOKIT_HOME is the OLDER env var (kept working on purpose - see
   * lib/repo-dirs.json), and a SAMPLES_CONTROLS_HOME set in the surrounding
   * shell outranks it by design: newest-first, first SET wins. Cleared for
   * the duration so the fake corpus decides - without this, a developer whose
   * environment points at a real samples-controls checkout runs the REAL
   * e2e-build here. The precedence itself is correct and stays; what was
   * wrong was this test leaving the competing var in place. */
  const wanted = { AI_DEMOKIT_HOME: demokit, SAMPLES_CONTROLS_HOME: '', A2UI5_HOME: a2, ...extraEnv };
  for (const [k, v] of Object.entries(wanted)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn({ demokit, a2 });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('buildBackend joins a same-mode call and fails fast on a conflicting mode', async () => {
  await withFakeRepos(
    'console.log("slow build"); setTimeout(() => process.exit(0), 1500);',
    {},
    async () => {
      const p1 = buildBackend({ mode: 'full' });
      // same effective mode joins the in-flight build: the identical promise
      const p2 = buildBackend({ mode: 'full' });
      assert.equal(p2, p1);
      // a different mode must NOT silently receive the full build's result
      const conflict = await buildBackend({ mode: 'incremental' });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.inFlight, 'full');
      assert.match(conflict.tail, /build in progress \(full\)/);
      assert.match(conflict.tail, /retry when the running build has finished/);
      const res = await p1;
      assert.equal(res.ok, true);
      assert.equal(res.mode, 'full');
      // the slot is free again: a new conflicting-mode call now starts (and
      // fails for its own reason — no prior full build in the fake repo —
      // rather than reporting an in-flight build)
      const after = await buildBackend({ mode: 'incremental' });
      assert.equal(after.inFlight, undefined);
      assert.match(after.tail, /prior full build/);
    },
  );
});

test('buildBackend kills and reports a build that exceeds its timeout', async () => {
  await withFakeRepos(
    'console.log("building forever"); setInterval(() => {}, 1000);',
    { A2UI5_MCP_BUILD_TIMEOUT_MS: '400' },
    async () => {
      const res = await buildBackend({ mode: 'full' });
      assert.equal(res.ok, false);
      assert.equal(res.timedOut, true);
      assert.match(res.tail, /timed out after 400ms/);
      assert.match(res.tail, /A2UI5_MCP_BUILD_TIMEOUT_MS/);
    },
  );
});

// ---------------------------------------------------------------- lintApp ----

/* The lint config has to sit in the corpus ROOT - abaplint resolves a config's
 * `files` glob relative to the config's own directory - so every lint writes
 * the same path into a repository this server does not own and deletes it
 * again in a finally. Two lints at once therefore raced, with one loser: the
 * first to finish removed the config the second's abaplint was still reading.
 *
 * The stand-in for abaplint is a script on PATH that records whether the
 * config was there when it started AND when it finished, which is exactly the
 * window the race opened. Without the queue in lintApp the second call records
 * a disappearance; with it, neither does. */
test('two concurrent lints do not delete each other\'s config', { skip: process.platform === 'win32' && 'needs a POSIX shell on PATH' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lint-'));
  const corpus = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(corpus, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'scripts', 'e2e-build.mjs'), '');
  fs.writeFileSync(
    path.join(corpus, 'abaplint.jsonc'),
    '{ "global": { "exclude": ["zz_dev"] }, "rules": { "object_naming": { "clas": "^Z2UI5_CL_SMPC_" } } }',
  );
  const marker = path.join(base, 'gone.txt');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  // npx abaplint <config> --format json, slow enough for the two calls to
  // overlap if nothing sequences them
  fs.writeFileSync(path.join(bin, 'npx'), [
    '#!/bin/sh',
    'cfg="$2"',
    '[ -f "$cfg" ] || echo start >> "$LINT_MARKER"',
    'sleep 0.4',
    '[ -f "$cfg" ] || echo end >> "$LINT_MARKER"',
    'echo "[]"',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'npx'), 0o755);

  const saved = { ...process.env };
  Object.assign(process.env, {
    AI_DEMOKIT_HOME: corpus,
    SAMPLES_CONTROLS_HOME: '',
    LINT_MARKER: marker,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  try {
    const { lintApp } = await import('../lib/runtime.mjs');
    const both = await Promise.all([lintApp('zcl_one'), lintApp('zcl_two')]);
    for (const r of both) assert.equal(r.ok, true, `a lint must still answer: ${JSON.stringify(r)}`);
    assert.equal(fs.existsSync(marker), false,
      `the config vanished under a running lint: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
    assert.equal(fs.existsSync(path.join(corpus, '.abaplint-mcp-dev.jsonc')), false,
      'and it is cleaned up when the lints are done');
  } finally {
    for (const k of ['AI_DEMOKIT_HOME', 'SAMPLES_CONTROLS_HOME', 'LINT_MARKER', 'PATH']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

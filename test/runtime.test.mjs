// Child-process behavior of lib/runtime.mjs: per-spawn timeouts and the
// single-flight build. Sibling-free — where a checkout is needed the tests
// point the env vars at fake repos built in a temp dir (the resolvers treat a
// set env var as authoritative, see lib/repos.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnWithTimeout, buildBackend, killChildren } from '../lib/runtime.mjs';
import { treeKillCommand } from '../lib/spawn.mjs';

// ------------------------------------------------------- spawnWithTimeout ----

test('spawnWithTimeout kills a deliberately hung child and reports the timeout', async () => {
  const t0 = Date.now();
  const res = await spawnWithTimeout(
    process.execPath,
    ['-e', 'console.log("started"); setInterval(() => {}, 1000);'],
    /* long enough for a loaded machine's node to start and print: at 300 ms
     * the kill sometimes came first and "started" was never there to keep */
    { timeoutMs: 1500 },
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

/* A chunk ends wherever the pipe buffer did: a line - or a UTF-8 character -
 * written in two pieces reached onLine as two broken halves (the build log,
 * the progress messages), and onLine got the line's index as a second
 * argument, which the progress reporter reads as `force`. */
test('spawnWithTimeout hands onLine whole lines and whole characters, one argument each', async () => {
  const calls = [];
  const script = [
    'process.stdout.write("transpile: hello wor");',
    'setTimeout(() => process.stdout.write("ld\\nsecond\\nthird"), 100);',
    'const e = Buffer.from("caf\\u00e9\\n");',
    'setTimeout(() => process.stderr.write(e.subarray(0, 4)), 200);',
    'setTimeout(() => process.stderr.write(e.subarray(4)), 300);',
  ].join('\n');
  const res = await spawnWithTimeout(process.execPath, ['-e', script], { timeoutMs: 30000, onLine: (...a) => calls.push(a) });
  assert.equal(res.code, 0);
  assert.ok(calls.every((a) => a.length === 1), `onLine got extra arguments: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.map((a) => a[0]).sort(), ['café', 'second', 'third', 'transpile: hello world']);
  assert.equal(res.stderr, 'café\n');
});

/* Cancellation: the MCP request's AbortSignal reaches the child through
 * spawnWithTimeout, and an abort kills the whole tree promptly - a cancelled
 * build must not keep transpiling under a request nobody waits for. */
test('spawnWithTimeout kills the child promptly when the signal aborts', async () => {
  const ac = new AbortController();
  // aborted once the child has spoken, not after a fixed 200 ms: a node child
  // on a loaded machine (the suite runs its files in parallel) can take longer
  // than that to print, and the kept-output assertion below then failed on
  // timing, not on the behaviour it is about
  const t0 = Date.now();
  const res = await spawnWithTimeout(
    process.execPath,
    ['-e', 'console.log("started"); setInterval(() => {}, 1000);'],
    { timeoutMs: 30000, signal: ac.signal, onLine: (l) => { if (/started/.test(l)) ac.abort(); } },
  );
  assert.equal(res.aborted, true);
  assert.equal(res.timedOut, false, 'an abort is reported as an abort, not as a timeout');
  assert.ok(Date.now() - t0 < 5000, 'the abort must not wait for the timeout');
  assert.match(res.stdout, /started/, 'output before the kill is kept');
});

/* The shutdown path: the server kills what is still running when its client
 * goes away (server.mjs shutdown). The children are process-group leaders,
 * so nothing else would - a build outlived the session that started it. */
test('killChildren kills every child spawnWithTimeout still has running', async () => {
  const t0 = Date.now();
  const running = spawnWithTimeout(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 200));
  killChildren();
  const res = await running;
  assert.equal(res.timedOut, false);
  assert.ok(Date.now() - t0 < 5000, 'the child dies at once, not at its timeout');
  killChildren(); // nothing left: a second call is a no-op
});

/* A grandchild - what npm runs git through, what a shell runs npm through
 * (cmd.exe on Windows) - dies with the child: the promise resolves at the
 * timeout, not when the grandchild would have finished and closed the pipe. */
test('a timeout ends the grandchildren too, and taskkill /T is how on Windows', async () => {
  const t0 = Date.now();
  const grandchild = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  const res = await spawnWithTimeout(process.execPath, ['-e', grandchild], { timeoutMs: 500 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 10000, `resolved after ${Date.now() - t0} ms - the grandchild held the pipe open`);

  assert.deepEqual(treeKillCommand(4242, 'win32'), ['taskkill', ['/pid', '4242', '/T', '/F']]);
  assert.equal(treeKillCommand(4242, 'linux'), null, 'POSIX signals the process group instead');
  assert.equal(treeKillCommand(undefined, 'win32'), null, 'a child that never started has no tree');
});

test('spawnWithTimeout never spawns under an already-aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  const marker = path.join(os.tmpdir(), `a2ui5-abort-${process.pid}.txt`);
  try {
    const res = await spawnWithTimeout(
      process.execPath,
      ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      { timeoutMs: 5000, signal: ac.signal },
    );
    assert.equal(res.aborted, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(marker), false, 'the child must not have run at all');
  } finally {
    fs.rmSync(marker, { force: true });
  }
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
  /* The build log (last-build.json) goes under A2UI5_MCP_SCREENSHOT_DIR, whose
   * default is the user's own <tmp>/abap2ui5-mcp-screenshots - the file a
   * live server's build_log answers from after a restart. Each test keeps it
   * in its own temp dir, or a test's fake build becomes the user's last one. */
  const wanted = { AI_DEMOKIT_HOME: demokit, SAMPLES_CONTROLS_HOME: '', A2UI5_HOME: a2, A2UI5_MCP_SCREENSHOT_DIR: path.join(base, 'shots'), ...extraEnv };
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
      assert.match(after.tail, /prior build/);
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

// ---------------------------------------------------------------- buildLog ----

/* The build's FULL retained output outlives the result's short tail: sliced
 * by tail/offset for the build_log tool, and persisted under the screenshot
 * dir so a restarted server can still answer for the previous one's build. */
test('buildLog serves the last build\'s output, sliced, with metadata, persisted', async () => {
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-shots-'));
  try {
    await withFakeRepos(
      'for (let i = 1; i <= 8; i++) console.log("line " + i); process.exit(0);',
      { A2UI5_MCP_SCREENSHOT_DIR: shots },
      async () => {
        const { buildLog } = await import('../lib/runtime.mjs');
        const res = await buildBackend({ mode: 'full' });
        assert.equal(res.ok, true);

        const log = buildLog({ tail: 3 });
        assert.equal(log.ok, true);
        assert.equal(log.mode, 'full');
        assert.equal(log.code, 0);
        assert.ok(log.startedAt && log.finishedAt, 'the log says when the build ran');
        assert.equal(log.totalLines, 8);
        assert.deepEqual(log.lines, ['line 6', 'line 7', 'line 8'], 'no offset means the LAST lines');
        assert.equal(log.start, 5);

        const paged = buildLog({ tail: 2, offset: 1 });
        assert.deepEqual(paged.lines, ['line 2', 'line 3']);
        assert.equal(paged.start, 1);

        // persisted for a server restarted after the build
        const persisted = JSON.parse(fs.readFileSync(path.join(shots, 'last-build.json'), 'utf8'));
        assert.equal(persisted.lines.length, 8);
        assert.equal(persisted.ok, true);
      },
    );
  } finally {
    fs.rmSync(shots, { recursive: true, force: true });
  }
});

/* The default screenshot dir is <tmp>/abap2ui5-mcp-screenshots - on Linux
 * under /tmp, which every local user can write. A link of that name planted
 * by another user received the build log (and the PNGs), and a restarted
 * server's build_log answered from whatever last-build.json was there. TMPDIR
 * points os.tmpdir() at a directory of this test's own. */
test('the default screenshot dir is written and read only when it is the user\'s own', { skip: process.platform === 'win32' && 'POSIX links' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-shotdir-'));
  const savedTmp = process.env.TMPDIR;
  try {
    const theirs = path.join(tmp, 'theirs');
    fs.mkdirSync(theirs);
    fs.symlinkSync(theirs, path.join(tmp, 'abap2ui5-mcp-screenshots'));
    process.env.TMPDIR = tmp;
    await withFakeRepos('console.log("built"); process.exit(0);', { A2UI5_MCP_SCREENSHOT_DIR: '' }, async () => {
      assert.equal((await buildBackend({ mode: 'full' })).ok, true);
    });
    assert.deepEqual(fs.readdirSync(theirs), [], 'no build log written through the link');

    // a fresh server reads no planted log either
    fs.writeFileSync(path.join(theirs, 'last-build.json'), JSON.stringify({ lines: ['planted'], ok: true }));
    const env = { ...process.env, TMPDIR: tmp };
    delete env.A2UI5_MCP_SCREENSHOT_DIR;
    const res = await spawnWithTimeout(process.execPath, ['--input-type=module', '-e',
      `const { buildLog } = await import(${JSON.stringify(new URL('../lib/runtime.mjs', import.meta.url).href)}); console.log(JSON.stringify(buildLog()));`],
    { env, timeoutMs: 30000 });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout.trim().split('\n').pop(), 'null');

    // a directory of the user's own is created 0700 and used
    fs.unlinkSync(path.join(tmp, 'abap2ui5-mcp-screenshots'));
    await withFakeRepos('console.log("built"); process.exit(0);', { A2UI5_MCP_SCREENSHOT_DIR: '' }, async () => {
      assert.equal((await buildBackend({ mode: 'full' })).ok, true);
    });
    const own = path.join(tmp, 'abap2ui5-mcp-screenshots');
    assert.equal(fs.statSync(own).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(path.join(own, 'last-build.json')));
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sliceLog stays within bounds however it is paged', async () => {
  const { sliceLog } = await import('../lib/runtime.mjs');
  const lines = ['a', 'b', 'c'];
  assert.deepEqual(sliceLog(lines, { tail: 10 }), { start: 0, lines: ['a', 'b', 'c'] });
  assert.deepEqual(sliceLog(lines, { tail: 1 }), { start: 2, lines: ['c'] });
  assert.deepEqual(sliceLog(lines, { tail: 5, offset: 2 }), { start: 2, lines: ['c'] });
  assert.deepEqual(sliceLog(lines, { tail: 5, offset: 99 }), { start: 3, lines: [] });
  assert.deepEqual(sliceLog([], { tail: 5 }), { start: 0, lines: [] });
});

// ---------------------------------------------------------------- lintApp ----

/* The lint config has to sit in the corpus ROOT - abaplint resolves a config's
 * `files` glob relative to the config's own directory - so every lint writes
 * the same path into a repository this server does not own and deletes it
 * again in a finally. Two lints at once therefore raced, with one loser: the
 * first to finish removed the config the second's abaplint was still reading.
 *
 * The stand-in for abaplint is the checkout's own install (lintApp runs
 * <root>/node_modules/@abaplint/cli's bin, never npx): a script that records
 * whether the config was there when it started AND when it finished, which is
 * exactly the window the race opened. Without the queue in lintApp the second
 * call records a disappearance; with it, neither does. */
function fakeAbaplint(root, script) {
  const dir = path.join(root, 'node_modules', '@abaplint', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@abaplint/cli', bin: { abaplint: './abaplint' } }));
  fs.writeFileSync(path.join(dir, 'abaplint'), script);
}

function fakeLintCorpus(base) {
  const corpus = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(corpus, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'scripts', 'e2e-build.mjs'), '');
  fs.writeFileSync(
    path.join(corpus, 'abaplint.jsonc'),
    '{ "global": { "exclude": ["zz_dev"] }, "rules": { "object_naming": { "clas": "^Z2UI5_CL_SMPC_" } } }',
  );
  return corpus;
}

async function withLintEnv(corpus, extra, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { AI_DEMOKIT_HOME: corpus, SAMPLES_CONTROLS_HOME: '', ...extra });
  try {
    return await fn();
  } finally {
    for (const k of ['AI_DEMOKIT_HOME', 'SAMPLES_CONTROLS_HOME', ...Object.keys(extra)]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('two concurrent lints do not delete each other\'s config', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lint-'));
  const corpus = fakeLintCorpus(base);
  const marker = path.join(base, 'gone.txt');
  // abaplint <config> --format json, slow enough for the two calls to
  // overlap if nothing sequences them
  fakeAbaplint(corpus, [
    "const fs = require('fs');",
    'const cfg = process.argv[2];',
    "if (!fs.existsSync(cfg)) fs.appendFileSync(process.env.LINT_MARKER, 'start\\n');",
    'setTimeout(() => {',
    "  if (!fs.existsSync(cfg)) fs.appendFileSync(process.env.LINT_MARKER, 'end\\n');",
    "  console.log('[]');",
    '}, 400);',
  ].join('\n'));
  try {
    await withLintEnv(corpus, { LINT_MARKER: marker }, async () => {
      const { lintApp } = await import('../lib/runtime.mjs');
      const both = await Promise.all([lintApp('zcl_one'), lintApp('zcl_two')]);
      for (const r of both) assert.equal(r.ok, true, `a lint must still answer: ${JSON.stringify(r)}`);
      assert.equal(fs.existsSync(marker), false,
        `the config vanished under a running lint: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
      assert.equal(fs.existsSync(path.join(corpus, '.abaplint-mcp-dev.jsonc')), false,
        'and it is cleaned up when the lints are done');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* A lint covers the whole repository; the class's own findings are picked by
 * FILE NAME. A substring test on the path used to give `z_app` the findings
 * of `zz_app` (and `yz_app`), so a clean class failed its deploy lint. */
test('a lint reports the deployed class\'s findings only, not those of a class whose name ends in its own', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lintown-'));
  const corpus = fakeLintCorpus(base);
  const findings = [
    { file: './src/zz_dev/zz_app.clas.abap', key: 'other_class', description: 'not mine', start: { row: 1 } },
    { file: './src/zz_dev/yz_app.clas.xml', key: 'other_xml', description: 'not mine either', start: { row: 1 } },
    { file: './src/zz_dev/z_app.clas.testclasses.abap', key: 'mine', description: 'my test include', start: { row: 3 } },
  ];
  fakeAbaplint(corpus, `console.log(${JSON.stringify(JSON.stringify(findings))});`);
  try {
    await withLintEnv(corpus, {}, async () => {
      const { lintApp, issuesOfClass } = await import('../lib/runtime.mjs');
      const r = await lintApp('z_app');
      assert.deepEqual(r.issues.map((i) => i.rule), ['mine']);
      assert.equal(r.totalRepoIssues, 3);
      const clean = await lintApp('zz_ap');
      assert.equal(clean.ok, true, `no finding is zz_ap's: ${JSON.stringify(clean.issues)}`);
      assert.deepEqual(issuesOfClass([{ file: 'src\\zz_dev\\z_app.clas.abap' }, { file: 'z_app.clas.xml' }], 'z_app').length, 2);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* `npx abaplint` / `npx abap_transpile` fell back to the REGISTRY when the
 * checkout had no local bin (stdin is no TTY under an MCP client, so npx
 * answered its own install prompt), and `abap_transpile` is an unclaimed npm
 * name. A missing install is a sentence now - and npx is not even consulted:
 * an `npx` on PATH that records being called must stay silent. */
test('a checkout without its own abaplint/transpiler install is reported, never fetched through npx', { skip: process.platform === 'win32' && 'needs a POSIX shell on PATH' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-nobin-'));
  const corpus = fakeLintCorpus(base);
  const bin = path.join(base, 'bin');
  const called = path.join(base, 'npx-called.txt');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\necho "[]"\n`);
  fs.chmodSync(path.join(bin, 'npx'), 0o755);
  try {
    await withLintEnv(corpus, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, async () => {
      const { lintApp, localBin } = await import('../lib/runtime.mjs');
      assert.equal(localBin(corpus, '@abaplint/cli', 'abaplint'), null);
      const r = await lintApp('zcl_one');
      assert.equal(r.ok, false);
      assert.equal(r.issues[0].rule, 'abaplint-missing');
      assert.match(r.issues[0].message, /npm ci/);
      assert.match(r.issues[0].message, new RegExp(corpus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(fs.existsSync(path.join(corpus, '.abaplint-mcp-dev.jsonc')), false, 'no config written for a lint that cannot run');
    });
    // the incremental transpile: a framework checkout with a prior build but no transpiler install
    await withFakeRepos('', { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, async ({ a2 }) => {
      fs.mkdirSync(path.join(a2, 'node/downport'), { recursive: true });
      fs.mkdirSync(path.join(a2, 'node/output'), { recursive: true });
      fs.writeFileSync(path.join(a2, 'node/output/init.mjs'), '');
      const res = await buildBackend({ mode: 'incremental' });
      assert.equal(res.ok, false);
      assert.match(res.tail, /abap_transpile is not installed/);
      assert.match(res.tail, /never lets npx fetch/);
    });
    assert.equal(fs.existsSync(called), false, `npx was called: ${fs.existsSync(called) ? fs.readFileSync(called, 'utf8') : ''}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* The incremental build clones open-abap-core when the checkout has no copy.
 * That clone was an execFileSync: the stdio server froze for its length, a
 * cancel could not stop it, and a failed clone THREW out of buildBackend -
 * a rejected build instead of a report, with no build_log record. */
test('a failed open-abap-core clone in the incremental build is a reported, logged failure', { skip: process.platform === 'win32' && 'needs a POSIX shell on PATH' }, async () => {
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-shots-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-gitbin-'));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: unable to access open-abap-core" >&2\nexit 128\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  try {
    await withFakeRepos('', { A2UI5_MCP_SCREENSHOT_DIR: shots, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, async ({ a2 }) => {
      fs.mkdirSync(path.join(a2, 'node/downport'), { recursive: true });
      fs.mkdirSync(path.join(a2, 'node/output'), { recursive: true });
      fs.writeFileSync(path.join(a2, 'node/output/init.mjs'), '');
      fs.mkdirSync(path.join(a2, 'node/setup'), { recursive: true });
      fs.writeFileSync(path.join(a2, 'node/setup/abap_transpile.json'), JSON.stringify({ libs: [{ url: 'https://github.com/open-abap/open-abap-core' }] }));
      const cli = path.join(a2, 'node_modules', '@abaplint', 'transpiler-cli');
      fs.mkdirSync(cli, { recursive: true });
      fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@abaplint/transpiler-cli', bin: { abap_transpile: './t.js' } }));
      fs.writeFileSync(path.join(cli, 't.js'), 'process.exit(0);');
      const { buildLog } = await import('../lib/runtime.mjs');
      const res = await buildBackend({ mode: 'incremental' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 128);
      assert.match(res.tail, /git clone open-abap-core exited 128/);
      assert.match(res.tail, /unable to access/);
      const log = buildLog({ tail: 50 });
      assert.equal(log.mode, 'incremental');
      assert.equal(log.ok, false);
      assert.ok(log.lines.some((l) => /exited 128/.test(l)), 'the failure is in build_log');
      assert.equal(fs.existsSync(path.join(a2, 'node/open-abap-core')), false, 'no half clone left for the next build');
      assert.equal(fs.existsSync(path.join(a2, 'e2e-transpile.json')), false);
    });
  } finally {
    fs.rmSync(shots, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- getBrowser ----

/* run_app's Chromium was cached for the server's life: one that crashed was
 * handed out again (every later run_app failed on "browser has been
 * closed" until a restart), and a failed launch stayed the answer after the
 * browser had been installed. Both clear the slot now. */
test('getBrowser launches afresh after a failed launch and after a disconnect', async () => {
  const { getBrowser, closeBrowser } = await import('../lib/runtime.mjs');
  const { EventEmitter } = await import('node:events');
  await closeBrowser();
  const fake = () => {
    const b = new EventEmitter();
    b.connected = true;
    b.isConnected = () => b.connected;
    b.close = async () => { b.connected = false; b.emit('disconnected'); };
    return b;
  };
  let launches = 0;
  await assert.rejects(getBrowser({ launch: async () => { launches += 1; throw new Error('no chromium'); } }), /no chromium/);
  const first = await getBrowser({ launch: async () => { launches += 1; return fake(); } });
  assert.equal(launches, 2, 'a failed launch is not the answer for good');
  assert.equal(await getBrowser({ launch: async () => { launches += 1; return fake(); } }), first, 'a live browser is shared');
  assert.equal(launches, 2);
  // the browser goes away under the server (a crash, an OOM kill)
  first.connected = false;
  first.emit('disconnected');
  const second = await getBrowser({ launch: async () => { launches += 1; return fake(); } });
  assert.notEqual(second, first, 'a dead browser is not handed out again');
  assert.equal(launches, 3);
  await closeBrowser();
  assert.equal(second.connected, false);
});

/* The backend binds 127.0.0.1, and its clients asked for the NAME localhost:
 * run_app's page.goto, the start's port wait (http.get's default host) and
 * the check that picks the backend's responses out of the page's. Where
 * localhost resolves to ::1 first, those reached [::1]:<port> - a port
 * another local user can listen on - or nothing at all. Every client path
 * uses BACKEND_HOST now, and the npm host's Host/Origin guard still lets
 * run_app's Chromium in at that address. */
test('every client of the backend connects to the address it binds, never to the name localhost', async () => {
  const { BACKEND_HOST, PORT, appStartUrl, backendBaseUrl, isBackendUrl, waitPort } = await import('../lib/runtime.mjs');
  const { loopbackRequest } = await import('../lib/npm-host.mjs');
  const http = await import('node:http');
  const { EventEmitter } = await import('node:events');
  assert.equal(BACKEND_HOST, '127.0.0.1');

  const start = new URL(appStartUrl('ZCL_APP', 4567));
  assert.equal(start.hostname, BACKEND_HOST, 'run_app\'s Chromium opens the bound address');
  assert.equal(start.port, '4567');
  assert.equal(start.search, '?app_start=ZCL_APP');
  assert.equal(new URL(backendBaseUrl()).hostname, BACKEND_HOST, 'the app tools post to the bound address');
  assert.equal(new URL(backendBaseUrl()).port, String(PORT));

  assert.equal(isBackendUrl(`http://127.0.0.1:${PORT}/?app_start=ZCL_APP`), true);
  assert.equal(isBackendUrl(`http://localhost:${PORT}/`), false, 'a localhost page is not the backend the page was opened on');
  assert.equal(isBackendUrl(`http://127.0.0.1:${PORT + 1}/`), false);
  assert.equal(isBackendUrl('https://sdk.openui5.org/resources/sap-ui-core.js'), false);
  assert.equal(isBackendUrl('not a url'), false);

  // what run_app's Chromium sends from that page passes the npm host's guard
  const page = new URL(appStartUrl('ZCL_APP'));
  assert.equal(loopbackRequest({ host: page.host, origin: page.origin }), true);
  assert.equal(loopbackRequest({ host: page.host }), true);

  // the port wait asks the bound address, not http.get's default (localhost)
  const asked = [];
  const fakeGet = (opts, onResponse) => {
    asked.push(opts);
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => onResponse({ destroy() {} }));
    return req;
  };
  await waitPort(4567, 1000, { get: fakeGet });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].host, BACKEND_HOST);
  assert.equal(asked[0].port, 4567);

  // and against a real server bound to 127.0.0.1 alone, as the backend is
  const srv = http.createServer((q, r) => r.end('ok'));
  await new Promise((r) => srv.listen(0, BACKEND_HOST, r));
  try {
    await waitPort(srv.address().port, 5000);
  } finally {
    await new Promise((r) => srv.close(r));
  }

  // no client path names localhost for its own backend: the code (comments
  // aside) of the server, lib/ and scripts/ - the npm host's list of the
  // names it ACCEPTS is the server side and stays
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const files = ['server.mjs',
    ...fs.readdirSync(path.join(repo, 'lib')).filter((f) => f.endsWith('.mjs') && f !== 'npm-host.mjs').map((f) => `lib/${f}`),
    ...fs.readdirSync(path.join(repo, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`)];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(repo, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l));
    const hit = code.findIndex((l) => /localhost/i.test(l));
    assert.equal(hit, -1, `${rel} names localhost in code: ${code[hit]}`);
  }
});

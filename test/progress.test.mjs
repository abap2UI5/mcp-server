// build_backend streams MCP progress: when the tools/call carries a
// progressToken, the server forwards throttled notifications/progress
// messages built from the build's output lines. Sibling-free: the env vars
// point the server at fake repos with a scripted, chatty e2e-build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('build_backend emits notifications/progress when the client sends a progressToken', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-progress-'));
  /* Deliberately the OLD directory name and (below) the old env var: the
   * corpus repo was renamed twice (ai-demokit -> abap2UI5-api ->
   * samples-controls) and an install made before that must keep working
   * untouched. Leave both spellings here — this is the compatibility path's
   * only coverage, and "modernizing" them would delete the test for it. */
  const demokit = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(demokit, 'scripts'), { recursive: true });
  // a build that prints a line every 200ms for ~2.4s — enough for the 1/s throttle
  fs.writeFileSync(
    path.join(demokit, 'scripts', 'e2e-build.mjs'),
    `let n = 0;
     const iv = setInterval(() => {
       console.log('transpiling step ' + ++n);
       if (n >= 12) { clearInterval(iv); process.exit(0); }
     }, 200);`,
  );
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');

  const p = spawn('node', [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      AI_DEMOKIT_HOME: demokit,
      /* AI_DEMOKIT_HOME is the OLDER var, and a SAMPLES_CONTROLS_HOME set in
       * the surrounding shell outranks it by design (newest-first, first SET
       * wins). Cleared here so the fake corpus above decides - without this,
       * a developer whose environment points at a real samples-controls
       * checkout watches this test run the real build instead. */
      SAMPLES_CONTROLS_HOME: '',
      A2UI5_HOME: a2,
    },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const msgs = () =>
    buf
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 20000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = msgs().find(pred);
        if (hit) {
          clearInterval(iv);
          res(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error(`timeout; got: ${buf.slice(-500)}`));
        }
      }, 50);
    });

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'progress', version: '0' } } });
    await until((m) => m.id === 1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'build_backend', arguments: { mode: 'full' }, _meta: { progressToken: 'tok-1' } } });
    const done = await until((m) => m.id === 2);
    assert.ok(!done.result.isError, `build must succeed: ${JSON.stringify(done.result)}`);
    const progress = msgs().filter((m) => m.method === 'notifications/progress');
    assert.ok(progress.length >= 1, `expected progress notifications, got: ${buf.slice(-800)}`);
    for (const n of progress) {
      assert.equal(n.params.progressToken, 'tok-1');
      assert.ok(n.params.progress > 0);
      assert.match(n.params.message, /transpiling step \d+/);
    }
  } finally {
    p.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('build_backend sends no progress notifications without a progressToken', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-noprogress-'));
  const demokit = path.join(base, 'ai-demokit');
  fs.mkdirSync(path.join(demokit, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(demokit, 'scripts', 'e2e-build.mjs'), 'console.log("one shot"); process.exit(0);');
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');

  const p = spawn('node', [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      AI_DEMOKIT_HOME: demokit,
      /* AI_DEMOKIT_HOME is the OLDER var, and a SAMPLES_CONTROLS_HOME set in
       * the surrounding shell outranks it by design (newest-first, first SET
       * wins). Cleared here so the fake corpus above decides - without this,
       * a developer whose environment points at a real samples-controls
       * checkout watches this test run the real build instead. */
      SAMPLES_CONTROLS_HOME: '',
      A2UI5_HOME: a2,
    },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 20000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = buf
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .find(pred);
        if (hit) {
          clearInterval(iv);
          res(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error('timeout'));
        }
      }, 50);
    });

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'progress', version: '0' } } });
    await until((m) => m.id === 1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'build_backend', arguments: { mode: 'full' } } });
    await until((m) => m.id === 2);
    assert.ok(!buf.includes('notifications/progress'), 'no token, no progress notifications');
  } finally {
    p.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

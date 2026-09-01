// The completions capability: the guide-chapter resource template
// (abap2ui5://guide/{chapter}) completes its argument from the guide's own
// chapter headings, read live from the abap2UI5 checkout. Sibling-free: the
// env var points at a fake checkout carrying a two-chapter guide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('guide-chapter completion answers from the live chapter headings', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-complete-'));
  const a2 = path.join(base, 'abap2UI5');
  fs.mkdirSync(path.join(a2, 'node', 'srv'), { recursive: true });
  fs.writeFileSync(path.join(a2, 'node', 'srv', 'express.mjs'), '');
  fs.mkdirSync(path.join(a2, 'docs', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(a2, 'docs', 'agents', 'building-apps.md'),
    '# Guide\n\nintro text\n\n## 1. Setup\n\nbody\n\n## 2. Events\n\nbody\n',
  );

  const p = spawn('node', [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, A2UI5_HOME: a2 },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  const until = (pred, ms = 10000) =>
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
          rej(new Error(`timeout; got: ${buf.slice(-500)}`));
        }
      }, 50);
    });

  let id = 10;
  const complete = async (ref, argument) => {
    const reqId = ++id;
    send({ jsonrpc: '2.0', id: reqId, method: 'completion/complete', params: { ref, argument } });
    const msg = await until((m) => m.id === reqId);
    assert.ok(!msg.error, `completion must not error: ${JSON.stringify(msg.error)}`);
    return msg.result.completion;
  };
  const guideRef = { type: 'ref/resource', uri: 'abap2ui5://guide/{chapter}' };

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'completion', version: '0' } } });
    const init = await until((m) => m.id === 1);
    // both new capabilities are declared - a client only asks when they are
    assert.ok(init.result.capabilities.completions, 'completions capability must be declared');
    assert.ok(init.result.capabilities.logging, 'logging capability must be declared');

    // a typed prefix narrows to the matching chapter
    const ev = await complete(guideRef, { name: 'chapter', value: 'ev' });
    assert.deepEqual(ev.values, ['2. Events']);

    // an empty value offers every chapter
    const all = await complete(guideRef, { name: 'chapter', value: '' });
    assert.ok(all.values.includes('1. Setup') && all.values.includes('2. Events'),
      `expected both chapters, got ${JSON.stringify(all.values)}`);

    // an unknown ref or argument answers empty, never an error - advisory
    const wrongRef = await complete({ type: 'ref/resource', uri: 'abap2ui5://nope/{x}' }, { name: 'x', value: '' });
    assert.deepEqual(wrongRef.values, []);
    const wrongArg = await complete(guideRef, { name: 'not-chapter', value: '' });
    assert.deepEqual(wrongArg.values, []);
  } finally {
    p.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

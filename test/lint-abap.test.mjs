// lint_abap's sandbox round trip: the class goes in for the lint and the
// sandbox is put back - a deployed class byte for byte, a new one gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotClass, restoreClass } from '../lib/deploy.mjs';
import { sandbox } from '../lib/sandbox.mjs';

function withNpmSandbox(fn) {
  return () => {
    const saved = {
      A2UI5_MCP_BACKEND: process.env.A2UI5_MCP_BACKEND,
      A2UI5_MCP_WORKSPACE: process.env.A2UI5_MCP_WORKSPACE,
      SAMPLES_CONTROLS_HOME: process.env.SAMPLES_CONTROLS_HOME,
    };
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-lint-abap-'));
    process.env.A2UI5_MCP_BACKEND = 'npm';
    process.env.A2UI5_MCP_WORKSPACE = ws;
    // a samples-controls checkout - a sibling, as in a dev setup - would be
    // the sandbox (its src/zz_dev) and the classes below would land there
    process.env.SAMPLES_CONTROLS_HOME = path.join(ws, 'no-corpus');
    try {
      const dir = sandbox().dir;
      fs.mkdirSync(dir, { recursive: true });
      fn(dir);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(ws, { recursive: true, force: true });
    }
  };
}

test('a class that was not deployed is gone again after the restore', withNpmSandbox((dir) => {
  const before = snapshotClass('zcl_new');
  assert.deepEqual(before, {});
  fs.writeFileSync(path.join(dir, 'zcl_new.clas.abap'), 'CLASS zcl_new DEFINITION.');
  fs.writeFileSync(path.join(dir, 'zcl_new.clas.xml'), '<xml/>');
  restoreClass('zcl_new', before);
  assert.deepEqual(fs.readdirSync(dir), []);
}));

test('a deployed class comes back byte for byte, its test include too, and no other class is touched', withNpmSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'zcl_app.clas.abap'), 'old source');
  fs.writeFileSync(path.join(dir, 'zcl_app.clas.testclasses.abap'), 'old tests');
  fs.writeFileSync(path.join(dir, 'zcl_app_other.clas.abap'), 'another app');
  const before = snapshotClass('zcl_app');
  assert.deepEqual(Object.keys(before).sort(), ['zcl_app.clas.abap', 'zcl_app.clas.testclasses.abap']);
  // what the lint's deploy does: new source, the test include dropped
  fs.writeFileSync(path.join(dir, 'zcl_app.clas.abap'), 'new source');
  fs.rmSync(path.join(dir, 'zcl_app.clas.testclasses.abap'));
  fs.writeFileSync(path.join(dir, 'zcl_app.clas.xml'), 'new sidecar');
  restoreClass('zcl_app', before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['zcl_app.clas.abap', 'zcl_app.clas.testclasses.abap', 'zcl_app_other.clas.abap']);
  assert.equal(fs.readFileSync(path.join(dir, 'zcl_app.clas.abap'), 'utf8'), 'old source');
  assert.equal(fs.readFileSync(path.join(dir, 'zcl_app.clas.testclasses.abap'), 'utf8'), 'old tests');
}));

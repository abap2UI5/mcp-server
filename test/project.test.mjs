// lib/project.mjs and what the npm backend takes from it: the framework
// release and the @abaplint/cli the PROJECT pins, read from the directory the
// client started the server in - so run_app boots the release the project's
// lint resolves against, not the registry's latest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDir, frameworkPinOf, projectRuntimePin, projectPinFiles, FIRST_RUNTIME_RELEASE } from '../lib/project.mjs';
import { selectRuntimeVersion, currentRuntimeVersion, lintCliVersion, npmStatus, resetNpmBackend } from '../lib/npm-backend.mjs';

const abaplintJsonc = (branch) => `{
  // the framework, for dependency resolution
  "dependencies": [
    { "url": "https://github.com/abaplint/deps", "files": "/src/**/*.*" },
    { "url": "https://github.com/abap2UI5/abap2UI5", "branch": "${branch}", "files": "/src/**/*.*" }
  ]
}`;

const ENV = ['A2UI5_MCP_PROJECT_DIR', 'A2UI5_MCP_WORKSPACE', 'A2UI5_MCP_RUNTIME_VERSION', 'A2UI5_MCP_OFFLINE', 'APP_TEMPLATE_HOME', 'A2UI5_MCP_REMOTE'];

/** A temporary project directory (with the given files) and workspace. */
function withProject(files, fn) {
  return async () => {
    const saved = Object.fromEntries(ENV.map((v) => [v, process.env[v]]));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-project-'));
    const proj = path.join(ws, 'project');
    fs.mkdirSync(proj);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(proj, f), text);
    process.env.A2UI5_MCP_PROJECT_DIR = proj;
    process.env.A2UI5_MCP_WORKSPACE = path.join(ws, 'workspace');
    process.env.APP_TEMPLATE_HOME = path.join(ws, 'no-template');
    process.env.A2UI5_MCP_REMOTE = '0';
    delete process.env.A2UI5_MCP_RUNTIME_VERSION;
    delete process.env.A2UI5_MCP_OFFLINE;
    resetNpmBackend();
    try {
      await fn({ proj, ws });
    } finally {
      resetNpmBackend();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(ws, { recursive: true, force: true });
    }
  };
}

const noRegistry = async () => { throw new Error('the registry must not be asked when the project pins a release'); };

test('the project directory: A2UI5_MCP_PROJECT_DIR, else the cwd', () => {
  assert.equal(projectDir({ A2UI5_MCP_PROJECT_DIR: '/some/where' }), path.resolve('/some/where'));
  assert.equal(projectDir({}), process.cwd());
});

test('frameworkPinOf: the abap2UI5 dependency\'s release branch, through comments', () => {
  assert.equal(frameworkPinOf(abaplintJsonc('1.149.0')), '1.149.0');
  assert.equal(frameworkPinOf(abaplintJsonc('main')), null, 'a branch name is not a release');
  assert.equal(frameworkPinOf('{ "dependencies": [] }'), null);
  assert.equal(frameworkPinOf('not json'), null);
});

test('no abaplint.jsonc: no pin, and the registry decides as before', withProject({}, async () => {
  assert.deepEqual(projectRuntimePin(), {});
  const asked = [];
  const view = async (spec) => {
    asked.push(spec);
    return { ok: true, meta: { name: '@abap2ui5/node-runtime', version: '1.151.0' } };
  };
  assert.equal((await selectRuntimeVersion({ view })).version, '1.151.0');
  assert.equal(asked.length, 1);
}));

test('a pinned project: build and status take its release, without asking the registry', withProject({ 'abaplint.jsonc': abaplintJsonc('1.149.0') }, async ({ proj }) => {
  const pin = projectRuntimePin();
  assert.deepEqual(pin, { value: '1.149.0', file: path.join(proj, 'abaplint.jsonc') });
  const sel = await selectRuntimeVersion({ view: noRegistry });
  assert.equal(sel.version, '1.149.0');
  assert.match(sel.source, /the project's pin .*abaplint\.jsonc/);
  assert.equal(currentRuntimeVersion().version, '1.149.0', 'the status follows the pin before the last build');
  assert.equal(npmStatus().version, '1.149.0');
  // the explicit override still wins
  process.env.A2UI5_MCP_RUNTIME_VERSION = '1.151.0';
  assert.deepEqual(await selectRuntimeVersion({ view: noRegistry }), { version: '1.151.0', source: 'A2UI5_MCP_RUNTIME_VERSION' });
}));

test(`a pin older than ${FIRST_RUNTIME_RELEASE}: not taken, and setup_status says why`, withProject({ 'abaplint.jsonc': abaplintJsonc('1.140.0') }, async () => {
  assert.equal(projectRuntimePin().tooOld, '1.140.0');
  const view = async () => ({ ok: true, meta: { name: '@abap2ui5/node-runtime', version: '1.151.0' } });
  assert.equal((await selectRuntimeVersion({ view })).version, '1.151.0');
  assert.match(npmStatus().projectPinNote, /1\.140\.0.*older than 1\.145\.0/);
}));

test('the lint\'s @abaplint/cli: the project\'s lockfile first, else app-template\'s, else the fallback', withProject({
  'package-lock.json': JSON.stringify({ packages: { 'node_modules/@abaplint/cli': { version: '2.120.130' } } }),
}, async () => {
  assert.deepEqual(lintCliVersion(), { version: '2.120.130', source: 'the project\'s package-lock.json' });
  assert.equal(projectPinFiles().pkgText, null);
}));

test('a project without an @abaplint/cli pin falls through to the fallback', withProject({ 'package.json': '{"name":"x"}' }, async () => {
  assert.match(lintCliVersion().source, /fallback/);
}));

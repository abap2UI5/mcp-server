// Where an INSTALLED linter is found - the layouts npm leaves behind, not a
// checkout. package.json declares @abap2ui5/linter as a peer dependency, and
// npm 7+ installs a non-optional peer by itself, hoisted next to the server:
// `npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp` therefore lands in
// `<npx cache>/node_modules/@abap2ui5/{mcp-server,linter}`. That layout, the
// nested one, a deeper hoist only Node's resolver can name, and the project's
// own install are each built out of a COPY of lib/ in a temp directory, so
// SERVER_ROOT (derived from the module's own location) is the copy's, and
// resolveViewCheck runs in a child process with AI_VIEW_CHECK_HOME unset and
// an empty cwd. The order checkout -> cwd -> server node_modules -> Node
// resolution is what viewCheckCandidates promises; this file pins the tail of
// it, test/renderer.test.mjs the authoritative env var at its head.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nodeResolvedViewCheck, viewCheckCandidates, SERVER_ROOT } from '../lib/repos.mjs';

const LIB = path.join(SERVER_ROOT, 'lib');

/* An installed linter, or something pretending to be one: the exports map the
 * identify check reads, and an entry file Node's resolver can answer with. */
function fakePackage(dir, { name = '@abap2ui5/linter', exports = { '.': './lib/index.mjs', './findings': './lib/findings.mjs' } } = {}) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.8.5', type: 'module', exports }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.mjs'), 'export const checkFiles = () => [];\n');
  fs.writeFileSync(path.join(dir, 'lib', 'findings.mjs'), 'export const SEVERITIES = ["error"];\n');
  return dir;
}

/* A copy of this server's lib/ at `serverRoot`, so the module computes that
 * directory as SERVER_ROOT. A symlink would not do: Node realpaths an
 * imported file, and SERVER_ROOT would be the real checkout's again. */
function installServer(serverRoot) {
  fs.cpSync(LIB, path.join(serverRoot, 'lib'), { recursive: true });
  return serverRoot;
}

/* resolveViewCheck() as the copied server sees it, from `cwd`, with no linter
 * env var and no mirror. Prints the resolved path or an empty line. */
function resolveFrom(serverRoot, cwd) {
  const env = { ...process.env, A2UI5_MCP_REMOTE: '0' };
  delete env.AI_VIEW_CHECK_HOME;
  const script = `import { resolveViewCheck } from ${JSON.stringify(pathToFileURL(path.join(serverRoot, 'lib', 'repos.mjs')).href)};
    process.stdout.write(String(resolveViewCheck() ?? ''));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `the copied server must load and answer:\n${r.stderr}`);
  return r.stdout.trim() || null;
}

async function withLayout(fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-vc-install-')));
  const cwd = path.join(base, 'empty-cwd');
  fs.mkdirSync(cwd);
  try {
    return await fn({ base, cwd });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('the npx layout: the peer npm hoists next to the server is found as its sibling candidate', async () => {
  await withLayout(({ base, cwd }) => {
    // <prefix>/node_modules/@abap2ui5/{mcp-server,linter} - what `npx -p
    // @abap2ui5/mcp-server` leaves in the npx cache once the peer is declared
    const scope = path.join(base, 'node_modules', '@abap2ui5');
    const server = installServer(path.join(scope, 'mcp-server'));
    const linter = fakePackage(path.join(scope, 'linter'));
    assert.equal(resolveFrom(server, cwd), linter);
  });
});

test('a linter nested under the server\'s own node_modules is found', async () => {
  await withLayout(({ base, cwd }) => {
    const server = installServer(path.join(base, 'node_modules', '@abap2ui5', 'mcp-server'));
    const linter = fakePackage(path.join(server, 'node_modules', '@abap2ui5', 'linter'));
    assert.equal(resolveFrom(server, cwd), linter);
  });
});

test('a hoist no explicit candidate names is found through Node\'s own resolution', async () => {
  await withLayout(({ base, cwd }) => {
    // the server installed under another package, the linter hoisted above
    // both: neither SERVER_ROOT/../linter nor SERVER_ROOT/node_modules has it
    const server = installServer(path.join(base, 'node_modules', 'wrapper', 'node_modules', '@abap2ui5', 'mcp-server'));
    const linter = fakePackage(path.join(base, 'node_modules', '@abap2ui5', 'linter'));
    assert.equal(resolveFrom(server, cwd), linter);
  });
});

test('the project the server runs in wins over a hoisted install, and a server beside nothing finds the project\'s', async () => {
  await withLayout(({ base }) => {
    const server = installServer(path.join(base, 'node_modules', 'wrapper', 'node_modules', '@abap2ui5', 'mcp-server'));
    fakePackage(path.join(base, 'node_modules', '@abap2ui5', 'linter'));
    const project = path.join(base, 'project');
    const own = fakePackage(path.join(project, 'node_modules', '@abap2ui5', 'linter'));
    assert.equal(resolveFrom(server, project), own, 'cwd/node_modules comes before Node resolution');

    const elsewhere = installServer(path.join(base, 'elsewhere', 'mcp-server'));
    assert.equal(resolveFrom(elsewhere, project), own, 'app-template\'s devDependency, the server started in that project');
  });
});

test('nothing installed anywhere resolves to null, and a package that is not the linter does not pass', async () => {
  await withLayout(({ base, cwd }) => {
    const server = installServer(path.join(base, 'node_modules', '@abap2ui5', 'mcp-server'));
    assert.equal(resolveFrom(server, cwd), null);
    // the identify check: a package.json without the linter's exports is not
    // a linter, whatever directory it sits in
    fakePackage(path.join(base, 'node_modules', '@abap2ui5', 'linter'), { exports: { '.': './lib/index.mjs' } });
    assert.equal(resolveFrom(server, cwd), null);
  });
});

test('nodeResolvedViewCheck answers the package root, and null for anything else', async () => {
  await withLayout(({ base }) => {
    const linter = fakePackage(path.join(base, 'node_modules', '@abap2ui5', 'linter'));
    const entry = pathToFileURL(path.join(linter, 'lib', 'index.mjs')).href;
    assert.equal(nodeResolvedViewCheck(() => entry), linter, 'walks up from the entry file to the manifest that names the linter');
    // a resolver that throws is "not installed", not an error
    assert.equal(nodeResolvedViewCheck(() => { throw new Error('ERR_MODULE_NOT_FOUND'); }), null);
    // the first manifest above the entry names another package: not the linter
    const other = fakePackage(path.join(base, 'node_modules', 'other'), { name: 'other' });
    assert.equal(nodeResolvedViewCheck(() => pathToFileURL(path.join(other, 'lib', 'index.mjs')).href), null);
    // not a file: URL (a loader hook could answer anything)
    assert.equal(nodeResolvedViewCheck(() => 'node:fs'), null);
  });
});

test('the candidate order: checkout siblings, the project, the server\'s node_modules, then Node resolution', () => {
  const cands = viewCheckCandidates({ cwd: '/some/project' });
  const siblings = cands.filter((c) => c && path.dirname(c) === path.resolve(SERVER_ROOT, '..'));
  assert.ok(siblings.length >= 1, 'the checkout siblings lead');
  assert.deepEqual(cands.slice(0, siblings.length), siblings);
  assert.equal(cands[siblings.length], path.join('/some/project', 'node_modules', '@abap2ui5', 'linter'));
  assert.equal(cands[siblings.length + 1], path.join(SERVER_ROOT, 'node_modules', '@abap2ui5', 'linter'));
  assert.equal(cands.length, siblings.length + 3, 'and the Node-resolved one (or null) last');
});

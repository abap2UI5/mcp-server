// server.json - the official MCP Registry listing - repeats the version, the
// package name and the registry name package.json already states, and a drift
// between the copies is only found by the registry, AFTER npm holds the
// immutable version (release.yml publishes to npm first, then the listing).
// scripts/check-server-json.mjs is the gate; this file runs it on every
// `npm test` and pins that it actually catches what it exists for.
//
// Sibling-free: both files and the code it scans are in this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRepo, serverJsonProblems, envVarsReadByServer, NOT_LISTED, PASSED_THROUGH,
  manifestProblems, renderSmithery, smitheryCommandFunction, SMITHERY_BIN,
} from '../scripts/check-server-json.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('server.json agrees with package.json and with the variables the server reads', () => {
  const { problems } = checkRepo();
  assert.deepEqual(problems, [], `server.json has drifted:\n${problems.join('\n')}\nrun: npm run check:server-json`);
});

test('server.json parses, carries the registry schema and names what the registry validates', () => {
  const server = JSON.parse(read('server.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(server.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(server.name, 'io.github.abap2UI5/mcp-server');
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.packages[0].registryBaseUrl, 'https://registry.npmjs.org', 'the official registry accepts npm packages from registry.npmjs.org only');
});

test('every environment variable server.json lists is read by the source, and every A2UI5_MCP_* the source reads is listed', () => {
  const server = JSON.parse(read('server.json'));
  const listed = new Set(server.packages[0].environmentVariables.map((v) => v.name));
  const envRead = envVarsReadByServer();
  for (const name of listed) assert.ok(envRead.has(name), `server.json lists ${name}, which server.mjs and lib/ never read`);
  for (const name of envRead) {
    if (!name.startsWith('A2UI5_MCP_')) continue;
    assert.ok(listed.has(name), `the source reads ${name}, which server.json does not list`);
  }
});

const clone = (o) => JSON.parse(JSON.stringify(o));

test('a version bump that forgets server.json fails the gate - both version fields', () => {
  const { pkg, server } = checkRepo();
  const envRead = envVarsReadByServer();
  const bumped = { ...pkg, version: '99.0.0' };
  const problems = serverJsonProblems({ pkg: bumped, server, envRead });
  assert.ok(problems.some((p) => /^server\.json version .* differs/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /package version .* differs/.test(p)), problems.join('\n'));
});

test('a missing or different mcpName fails the gate - npm ownership is validated by it', () => {
  const { pkg, server } = checkRepo();
  const envRead = envVarsReadByServer();
  const { mcpName, ...without } = pkg;
  assert.ok(mcpName);
  assert.ok(serverJsonProblems({ pkg: without, server, envRead }).some((p) => /no "mcpName"/.test(p)));
  assert.ok(serverJsonProblems({ pkg: { ...pkg, mcpName: 'io.github.someone/else' }, server, envRead })
    .some((p) => /differs from package\.json mcpName/.test(p)));
});

test('the environment variable list is checked in both directions', () => {
  const { pkg, server } = checkRepo();
  const envRead = envVarsReadByServer();
  // a variable the code reads that the listing leaves out
  const dropped = clone(server);
  dropped.packages[0].environmentVariables = dropped.packages[0].environmentVariables.filter((v) => v.name !== 'A2UI5_MCP_WORKSPACE');
  assert.ok(serverJsonProblems({ pkg, server: dropped, envRead }).some((p) => /reads A2UI5_MCP_WORKSPACE/.test(p)));
  // a variable the listing names that nothing reads
  const invented = clone(server);
  invented.packages[0].environmentVariables.push({ name: 'A2UI5_MCP_NOTHING', description: 'x' });
  assert.ok(serverJsonProblems({ pkg, server: invented, envRead }).some((p) => /A2UI5_MCP_NOTHING, which the server never reads/.test(p)));
  // every variable is optional, and none carries a default a client could set
  const required = clone(server);
  required.packages[0].environmentVariables[0].isRequired = true;
  required.packages[0].environmentVariables[1].default = '/somewhere';
  const problems = serverJsonProblems({ pkg, server: required, envRead });
  assert.ok(problems.some((p) => /as required/.test(p)));
  assert.ok(problems.some((p) => /has a default/.test(p)));
});

/* resolvePopups reads POPUPS_HOME through an injectable `env` parameter, not
 * as process.env.POPUPS_HOME - the scan missed that shape, and so did the
 * listing, the drift this gate exists to catch. */
test('a variable read through an injected env object is seen by the scan', () => {
  assert.ok(envVarsReadByServer().has('POPUPS_HOME'), 'lib/migrate.mjs resolvePopups reads env.POPUPS_HOME');
});

test('the exemption lists name variables that exist on the side they claim', () => {
  const envRead = envVarsReadByServer();
  for (const name of Object.keys(NOT_LISTED)) assert.ok(envRead.has(name), `NOT_LISTED names ${name}, which the server no longer reads - drop it`);
  for (const name of Object.keys(PASSED_THROUGH)) assert.ok(!envRead.has(name), `${name} is read by the server itself now - move it out of PASSED_THROUGH`);
});

/* smithery.yaml is rendered from server.json, so the two cannot say different
 * things about a variable; glama.json carries only what Glama documents. */
test('smithery.yaml is what server.json renders to, and starts the server the way the README registers it', () => {
  const { pkg, server, smithery } = checkRepo();
  assert.equal(smithery, renderSmithery({ pkg, server }), 'run: node scripts/check-server-json.mjs --sync');
  const listed = server.packages[0].environmentVariables.map((v) => v.name);
  for (const name of listed) assert.match(smithery, new RegExp(`^      ${name}:$`, 'm'), `smithery.yaml has no configSchema property ${name}`);
  const props = [...smithery.matchAll(/^      ([A-Z][A-Z0-9_]*):$/gm)].map((m) => m[1]);
  assert.deepEqual(props, listed, 'the configSchema properties are exactly the listed variables, in order');
  const fn = smitheryCommandFunction(smithery);
  const start = fn({ A2UI5_MCP_OFFLINE: '1', A2UI5_MCP_PORT: 3001, A2UI5_MCP_BACKEND: '', A2UI5_MCP_UI: undefined });
  assert.deepEqual(start.args, ['-y', '-p', pkg.name, SMITHERY_BIN]);
  assert.equal(start.command, 'npx');
  assert.deepEqual(start.env, { A2UI5_MCP_OFFLINE: '1', A2UI5_MCP_PORT: '3001' }, 'empty and unset properties are not exported');
  assert.match(read('README.md'), new RegExp(`-p ${pkg.name.replace('/', '\\/')} ${SMITHERY_BIN}`), 'the README registers the same command');
});

test('a smithery.yaml or glama.json that drifts fails the gate', () => {
  const { pkg, server, smithery, glama } = checkRepo();
  assert.deepEqual(manifestProblems({ pkg, server, smithery, glama }), []);
  // a variable added to server.json is missing from smithery.yaml until --sync runs
  const grown = clone(server);
  grown.packages[0].environmentVariables.push({ name: 'A2UI5_MCP_NEW', description: 'x', isRequired: false });
  assert.ok(manifestProblems({ pkg, server: grown, smithery, glama }).some((p) => /smithery\.yaml is not what server\.json renders to/.test(p)));
  // a description edited in one place only
  const reworded = smithery.replace(/description: "Set to 1 for no network/, 'description: "Set to 2 for no network');
  assert.notEqual(reworded, smithery);
  assert.ok(manifestProblems({ pkg, server, smithery: reworded, glama }).some((p) => /smithery\.yaml is not what/.test(p)));
  // the bin the start command names has to exist
  const { [SMITHERY_BIN]: _, ...bins } = pkg.bin;
  assert.ok(manifestProblems({ pkg: { ...pkg, bin: bins }, server, smithery, glama }).some((p) => /bin "abap2ui5-mcp"/.test(p)));
  // glama.json: the schema URL, GitHub user names, nothing undocumented
  assert.ok(manifestProblems({ pkg, server, smithery, glama: { ...glama, $schema: 'https://example.com' } }).some((p) => /glama\.json \$schema/.test(p)));
  assert.ok(manifestProblems({ pkg, server, smithery, glama: { ...glama, maintainers: [] } }).some((p) => /maintainers/.test(p)));
  assert.ok(manifestProblems({ pkg, server, smithery, glama: { ...glama, maintainers: ['not a user name'] } }).some((p) => /maintainers/.test(p)));
  assert.ok(manifestProblems({ pkg, server, smithery, glama: { ...glama, npm: pkg.name } }).some((p) => /does not describe/.test(p)));
  assert.ok(manifestProblems({ pkg, server, smithery, glama: null }).length >= 2, 'a missing glama.json is reported');
});

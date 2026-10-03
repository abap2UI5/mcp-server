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
import { checkRepo, serverJsonProblems, envVarsReadByServer, NOT_LISTED, PASSED_THROUGH } from '../scripts/check-server-json.mjs';

test('server.json agrees with package.json and with the variables the server reads', () => {
  const { problems } = checkRepo();
  assert.deepEqual(problems, [], `server.json has drifted:\n${problems.join('\n')}\nrun: npm run check:server-json`);
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

test('the exemption lists name variables that exist on the side they claim', () => {
  const envRead = envVarsReadByServer();
  for (const name of Object.keys(NOT_LISTED)) assert.ok(envRead.has(name), `NOT_LISTED names ${name}, which the server no longer reads - drop it`);
  for (const name of Object.keys(PASSED_THROUGH)) assert.ok(!envRead.has(name), `${name} is read by the server itself now - move it out of PASSED_THROUGH`);
});

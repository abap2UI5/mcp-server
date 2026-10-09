// A2UI5_MCP_TEST_RUNTIME_TGZ: run the integration tests on a LOCAL build of
// @abap2ui5/node-runtime instead of the registry's latest - the package
// abap2UI5's `npm run pack:node-runtime` writes (npm-package/*.tgz), so a
// change on that side (a new transpiler, a new output/ layout) is proven
// here before it is released. Unset, nothing changes: the tests install the
// published package, as a fresh machine does.
//
// The release is installed into the test's workspace the way
// lib/npm-backend.mjs leaves one - the package (from the tarball), the
// transpiler it records, express in its peer range, the lint's abaplint,
// the install marker - so the build finds it complete and never asks the
// registry for the package; A2UI5_MCP_RUNTIME_VERSION pins its version.
// Not a test file itself (npm test runs test/*.test.mjs only).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOCAL_RUNTIME_ENV = 'A2UI5_MCP_TEST_RUNTIME_TGZ';

/** The tarball's package.json, or null when the variable is unset. */
export function localRuntimeMeta(env = process.env) {
  const tgz = env[LOCAL_RUNTIME_ENV];
  if (!tgz) return null;
  const file = path.resolve(tgz);
  const res = spawnSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${LOCAL_RUNTIME_ENV}=${tgz}: not a package tarball (${(res.stderr || '').trim()})`);
  return { file, meta: JSON.parse(res.stdout) };
}

/**
 * Install the local tarball as the release of `workspace` (see the header).
 * Returns the env to add (`A2UI5_MCP_RUNTIME_VERSION`), or `{}` when the
 * variable is unset. `cli` is the lint's @abaplint/cli version (null: none,
 * for a test that does not lint).
 */
export async function installLocalRuntime(workspace, { cli = null } = {}) {
  const local = localRuntimeMeta();
  if (!local) return {};
  const npm = await import('../../lib/npm-backend.mjs');
  const { version } = local.meta;
  const transpiler = npm.transpilerOf(local.meta);
  if (!transpiler) throw new Error(`${local.file} records no transpiler (abap2ui5.transpiler)`);
  const dir = path.join(workspace, 'runtime', version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'abap2ui5-mcp-runtime', version: '0.0.0', private: true, dependencies: {} }, null, 2));
  const specs = [local.file, `@abaplint/transpiler-cli@${transpiler.version}`, `express@${npm.expressRangeOf(local.meta)}`, ...(cli ? [`@abaplint/cli@${cli}`] : [])];
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', ...specs], {
    cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 10 * 60_000,
  });
  if (res.status !== 0) throw new Error(`npm install of ${local.file} exited ${res.status}: ${(res.stderr || '').trim().split('\n').slice(-5).join('\n')}`);
  const installed = (name) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(dir, npm.RUNTIME_MARKER), JSON.stringify({
    note: `Installed by the tests from ${local.file} (${LOCAL_RUNTIME_ENV}).`,
    version,
    installedAt: new Date().toISOString(),
    dependencies: Object.fromEntries([npm.RUNTIME_PKG, '@abaplint/transpiler-cli', 'express', ...(cli ? ['@abaplint/cli'] : [])].map((n) => [n, installed(n)])),
  }, null, 2));
  return { A2UI5_MCP_RUNTIME_VERSION: version };
}

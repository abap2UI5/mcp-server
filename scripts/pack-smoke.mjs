#!/usr/bin/env node
/*
 * pack-smoke — run a packed tarball THE WAY USERS RUN IT.
 *
 *   node scripts/pack-smoke.mjs <path/to/abap2ui5-mcp-server-X.Y.Z.tgz>
 *
 * 0.2.0 was published with two bins, `abap2ui5-mcp` and `abap2ui5-unit`, and
 * none named after the package. `npx --yes @abap2ui5/mcp-server` - the command
 * the README, the docs, the VS Code extension's default and the template's
 * `.mcp.json` all give - then fails with "could not determine executable to
 * run": npx runs the bin named like the unscoped package, or the only bin, and
 * there was neither. The release workflow's own smoke installed the tarball
 * and called `node_modules/.bin/abap2ui5-mcp` by name, which is exactly the
 * path nobody else takes, so it stayed green.
 *
 * So this drives the three commands a user actually types, against the
 * tarball, from an empty directory:
 *
 *   npx --yes file:<tarball>                       the documented registration
 *   npx --yes -p file:<tarball> abap2ui5-mcp       the form every version answers
 *   npx --yes -p file:<tarball> abap2ui5-unit --help   the CI runner's bin
 *
 * The first two must answer an MCP `initialize` over stdio and exit once the
 * client closes stdin - a server that outlives its client leaves node, a
 * Chromium and the express backend behind every session. The third must
 * print its usage and exit 0.
 *
 * Needs the registry (npx installs the tarball's dependencies); run by the
 * release workflow, and by hand before a release that changes `bin`/`files`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tarball = process.argv[2] && path.resolve(process.argv[2]);
if (!tarball || !fs.existsSync(tarball)) {
  console.error('usage: node scripts/pack-smoke.mjs <tarball.tgz>');
  process.exit(2);
}
const expectedVersion = /-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(tarball)?.[1] || null;
/* `file:` makes npx read the argument as a PACKAGE spec, which is what
 * `@abap2ui5/mcp-server` is; a bare path is taken for a command to execute. */
const spec = `file:${tarball}`;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-pack-smoke-'));
const INSTALL_MS = Number(process.env.PACK_SMOKE_TIMEOUT_MS) || 300_000;
// no checkout anywhere and no mirror: the level-1 contract is what is tested
const env = {
  ...process.env,
  SAMPLES_CONTROLS_HOME: '/nope', SAMPLES_HOME: '/nope', SAMPLES_STACK_HOME: '/nope',
  A2UI5_HOME: '/nope', AI_VIEW_CHECK_HOME: '/nope', APP_TEMPLATE_HOME: '/nope', DOCS_HOME: '/nope',
  A2UI5_MCP_REMOTE: '0', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
};
const shell = process.platform === 'win32';

let failed = false;
const expect = (cond, what, detail = '') => {
  if (cond) console.log(`ok    ${what}`);
  else {
    failed = true;
    console.error(`FAIL  ${what}${detail ? `\n${detail}` : ''}`);
  }
};

/* Start the command, send initialize, wait for the answer, close stdin and
 * wait for the exit. Resolves with what was seen; never rejects. */
function driveServer(label, args) {
  return new Promise((resolve) => {
    const child = spawn('npx', args, { cwd, env, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let init = null;
    let exited = null;
    let closedAt = 0;
    const finish = () => {
      clearTimeout(installTimer);
      clearTimeout(exitTimer);
      resolve({ label, init, exited, exitMs: closedAt ? Date.now() - closedAt : null, err, out });
    };
    const installTimer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, INSTALL_MS);
    let exitTimer = null;
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && !init) {
          init = msg;
          // the client goes away: stdin closes, nothing else is sent
          closedAt = Date.now();
          child.stdin.end();
          exitTimer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 15_000);
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      finish();
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '0' } },
    }) + '\n');
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('npx', args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_MS);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

for (const [label, args] of [
  ['npx --yes <tarball>', ['--yes', spec]],
  ['npx --yes -p <tarball> abap2ui5-mcp', ['--yes', '-p', spec, 'abap2ui5-mcp']],
]) {
  const r = await driveServer(label, args);
  const info = r.init && r.init.result && r.init.result.serverInfo;
  expect(info && info.name === 'abap2ui5', `${label} starts the server and answers initialize`,
    (r.err || r.out).slice(-1500));
  if (info && expectedVersion) expect(info.version === expectedVersion, `${label} serves the packed version ${expectedVersion}`, `got ${info.version}`);
  expect(r.exited && r.init, `${label} exits once the client closes stdin`,
    r.exited ? '' : 'still running 15 s after stdin closed - it would outlive every client session');
}

const help = await run(['--yes', '-p', spec, 'abap2ui5-unit', '--help']);
expect(help.code === 0 && /abap2ui5-unit/.test(help.out), 'npx --yes -p <tarball> abap2ui5-unit --help prints its usage',
  `exit ${help.code}\n${(help.err || help.out).slice(-1500)}`);

fs.rmSync(cwd, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

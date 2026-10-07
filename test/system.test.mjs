// The system mode (lib/system.mjs, lib/system-tools.mjs): the app tools
// against a real SAP system, for MCP clients other than the VS Code
// extension. Sibling-free and offline: the pure halves (the endpoint, the
// configuration, the cookies, the ADT parser, the breaker) against injected
// requests, then the real server over stdio against test/helpers/fake-system
// - a local http server with Basic logon, a session cookie, a CSRF token
// layer and the ADT search, which replays a recorded sample session and
// fails on any request that differs from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  systemEndpoint, systemLocation, systemConfig, describeConfig, systemClassName, cookieJar, createSystemHttp,
  parseAdtClassRefs, adtSearchUrl, networkProblem, runPasswordCommand, checkSystem, PROBE_CLASS,
} from '../lib/system.mjs';
import { SYSTEM_TOOLS, SYSTEM_TOOL_NAMES } from '../lib/system-tools.mjs';
import { AgentError } from '../lib/appclient.mjs';
import { fakeSystem, USER, PASSWORD } from './helpers/fake-system.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------- endpoint ----

test('the endpoint is the launch URL without the class; {class} in the path is refused', () => {
  assert.deepEqual(systemEndpoint('https://h:44300/sap/bc/z2ui5?app_start={class}&sap-client=100'),
    { endpoint: 'https://h:44300/sap/bc/z2ui5?sap-client=100' });
  assert.deepEqual(systemEndpoint('https://h/sap/bc/z2ui5?sap-client=100&app_start=ZCL_X#frag'),
    { endpoint: 'https://h/sap/bc/z2ui5?sap-client=100' }, 'a URL without the placeholder is the endpoint, app_start dropped');
  assert.deepEqual(systemEndpoint('https://h/sap/bc/z2ui5'), { endpoint: 'https://h/sap/bc/z2ui5' });
  assert.match(systemEndpoint('https://h/sap/bc/{class}').problem, /into the path/);
  assert.match(systemEndpoint('not a url').problem, /is not a URL/);
  assert.match(systemEndpoint('ftp://h/x').problem, /http\(s\)/);
  assert.match(systemEndpoint('https://me:pw@h/sap/bc/z2ui5').problem, /carries credentials/);
});

test('a URL that does not parse never echoes its credentials; a malformed % sequence does not throw', () => {
  const broken = systemEndpoint('https://me:secret@h:44x/sap/bc/z2ui5').problem;
  assert.match(broken, /is not a URL/);
  assert.doesNotMatch(broken, /secret/);
  assert.match(broken, /https:\/\/\*\*\*@h:44x/);
  assert.deepEqual(systemEndpoint('https://h/sap/bc/%zz?sap-client=1'), { endpoint: 'https://h/sap/bc/%zz?sap-client=1' });
});

test('the start location is the launch URL: origin, path, query plus app_start', () => {
  assert.deepEqual(systemLocation('https://h:44300/sap/bc/z2ui5?sap-client=100&sap-theme=sap_horizon', 'zcl_app'),
    { origin: 'https://h:44300', pathname: '/sap/bc/z2ui5', search: '?sap-client=100&sap-theme=sap_horizon&app_start=zcl_app' });
});

test('class names: the customer namespace and namespaced classes, lower case', () => {
  assert.equal(systemClassName('ZCL_MY_APP'), 'zcl_my_app');
  assert.equal(systemClassName(' /NS/CL_APP '), '/ns/cl_app');
  assert.throws(() => systemClassName('cl_gui_alv_grid'), /customer namespace/);
  assert.throws(() => systemClassName('z'.repeat(31)), /<= 30/);
  assert.throws(() => systemClassName('zcl_x; drop'), /invalid class name/);
});

// -------------------------------------------------------- configuration ----

test('no URL is no system mode; a set URL is, even misconfigured - with problems that say what to set', () => {
  assert.equal(systemConfig({}), null);
  assert.equal(systemConfig({ A2UI5_MCP_SYSTEM_URL: '  ' }), null);
  const ok = systemConfig({ A2UI5_MCP_SYSTEM_URL: 'https://h/sap/bc/z2ui5?app_start={class}', A2UI5_MCP_SYSTEM_USER: 'DEV', A2UI5_MCP_SYSTEM_PASSWORD: 'x' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.endpoint, 'https://h/sap/bc/z2ui5');
  assert.equal(ok.passwordSource, 'env');
  assert.equal(ok.insecureTls, false);
  const bad = systemConfig({ A2UI5_MCP_SYSTEM_URL: 'https://h/{class}' });
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems.join('\n'), /into the path[\s\S]*A2UI5_MCP_SYSTEM_USER is not set[\s\S]*neither A2UI5_MCP_SYSTEM_PASSWORD nor/);
  const both = systemConfig({ A2UI5_MCP_SYSTEM_URL: 'https://h/x', A2UI5_MCP_SYSTEM_USER: 'U', A2UI5_MCP_SYSTEM_PASSWORD: 'p', A2UI5_MCP_SYSTEM_PASSWORD_CMD: 'echo p' });
  assert.match(both.problems[0], /not both/);
  const cmd = systemConfig({ A2UI5_MCP_SYSTEM_URL: 'https://h/x', A2UI5_MCP_SYSTEM_USER: 'U', A2UI5_MCP_SYSTEM_PASSWORD_CMD: 'echo p', A2UI5_MCP_SYSTEM_INSECURE_TLS: '1' });
  assert.equal(cmd.passwordSource, 'command');
  assert.equal(cmd.insecureTls, true);
});

test('the configuration as shown never carries the password or the command', () => {
  const env = { A2UI5_MCP_SYSTEM_URL: 'https://h/x', A2UI5_MCP_SYSTEM_USER: 'U', A2UI5_MCP_SYSTEM_PASSWORD_CMD: 'security find-generic-password -w -s s3cr3t' };
  const shown = JSON.stringify(describeConfig(systemConfig(env)));
  assert.ok(!shown.includes('s3cr3t'));
  const shown2 = JSON.stringify(describeConfig(systemConfig({ ...env, A2UI5_MCP_SYSTEM_PASSWORD_CMD: undefined, A2UI5_MCP_SYSTEM_PASSWORD: 'hunter2' })));
  assert.ok(!shown2.includes('hunter2'));
  assert.match(shown2, /set \(A2UI5_MCP_SYSTEM_PASSWORD\)/);
});

test('the password command: stdout without the line break; a failure never shows what it printed', async () => {
  assert.equal(await runPasswordCommand(`"${process.execPath}" -e "process.stdout.write('pw with spaces\\n')"`), 'pw with spaces');
  await assert.rejects(runPasswordCommand(`"${process.execPath}" -e "process.stdout.write('leaked');process.exit(3)"`),
    (e) => /exited with 3/.test(e.message) && !e.message.includes('leaked'));
  await assert.rejects(runPasswordCommand(`"${process.execPath}" -e ""`), /printed nothing/);
  await assert.rejects(runPasswordCommand(`"${process.execPath}" -e "setTimeout(()=>{},5000)"`, { timeoutMs: 200 }), /did not finish/);
});

// ---------------------------------------------------------------- wire -----

test('the cookie jar keeps, replaces and expires cookies as a browser does', () => {
  const jar = cookieJar();
  assert.equal(jar.header(), undefined);
  jar.keep({ 'set-cookie': ['A=1; path=/; HttpOnly', 'B=2'] });
  assert.equal(jar.header(), 'A=1; B=2');
  jar.keep({ 'set-cookie': 'A=3' });
  jar.keep({ 'set-cookie': ['B=; Max-Age=0'] });
  assert.equal(jar.header(), 'A=3');
  jar.keep({ 'set-cookie': ['A=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT'] });
  assert.equal(jar.size, 0);
});

const cfg = (over = {}) => ({ ...systemConfig({ A2UI5_MCP_SYSTEM_URL: 'https://h/sap/bc/z2ui5?sap-client=1', A2UI5_MCP_SYSTEM_USER: 'DEV', A2UI5_MCP_SYSTEM_PASSWORD: 'pw' }), ...over });

test('every request carries the Basic logon and the cookies the system set', async () => {
  const seen = [];
  const sys = createSystemHttp(cfg(), {
    request: async (url, init) => {
      seen.push(init);
      return { status: 200, headers: { 'set-cookie': ['SAP_SESSIONID=abc; path=/'] }, body: 'ok' };
    },
  });
  await sys.send('https://h/a', { method: 'GET' });
  await sys.send('https://h/b', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(seen[0].headers.authorization, `Basic ${Buffer.from('DEV:pw').toString('base64')}`);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[1].headers.cookie, 'SAP_SESSIONID=abc');
  assert.equal(seen[1].headers['content-type'], 'application/json');
  assert.equal(seen[1].insecureTls, false);
});

test('the breaker: a rejected logon is sent ONCE, then refused without a request', async () => {
  let calls = 0;
  const sys = createSystemHttp(cfg(), { request: async () => { calls++; return { status: 401, headers: {}, body: '<html>' }; } });
  const first = await sys.send('https://h/a');
  assert.equal(first.status, 401);
  assert.match(first.body, /rejected the logon of user DEV/);
  await assert.rejects(sys.send('https://h/a'), (e) => e instanceof AgentError && /once already/.test(e.message));
  await assert.rejects(sys.ready(), /once already/);
  assert.equal(calls, 1, 'the second attempt never reached the system');
});

test('the breaker under parallel calls: a wrong password reaches the system once, not once per call', async () => {
  let calls = 0;
  const sys = createSystemHttp(cfg(), {
    request: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { status: 401, headers: {}, body: '' };
    },
  });
  const all = await Promise.allSettled([sys.send('https://h/a'), sys.send('https://h/b'), sys.send('https://h/c')]);
  assert.equal(calls, 1, 'the calls waited for the first answer');
  assert.equal(all[0].value.status, 401);
  assert.ok(all.slice(1).every((r) => r.status === 'rejected' && /once already/.test(r.reason.message)));
});

test('accepted once, requests run side by side; parallel first calls ask the password command once', async () => {
  let asked = 0;
  let open = 0;
  let most = 0;
  const sys = createSystemHttp(cfg({ passwordSource: 'command', password: undefined, passwordCmd: 'x' }), {
    runCommand: async () => {
      asked++;
      await new Promise((r) => setTimeout(r, 5));
      return 'pw';
    },
    request: async () => {
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 10));
      open--;
      return { status: 200, headers: {}, body: '' };
    },
  });
  await Promise.all([sys.send('https://h/a'), sys.send('https://h/b')]);
  assert.equal(asked, 1);
  assert.equal(most, 1, 'one at a time until the logon was accepted');
  await Promise.all([sys.send('https://h/a'), sys.send('https://h/b'), sys.send('https://h/c')]);
  assert.equal(most, 3, 'side by side once accepted');
  assert.equal(asked, 1);
});

test('a failing password command is asked again on the next call', async () => {
  let asked = 0;
  const sys = createSystemHttp(cfg({ passwordSource: 'command', password: undefined, passwordCmd: 'x' }), {
    runCommand: async () => {
      asked++;
      if (asked === 1) throw new Error('keychain locked');
      return 'pw';
    },
    request: async () => ({ status: 200, headers: {}, body: '' }),
  });
  await assert.rejects(sys.send('https://h/a'), /keychain locked/);
  assert.equal((await sys.send('https://h/a')).status, 200);
  assert.equal(asked, 2);
});

test('the breaker with a password command: asked once, asked again after a 401, retried only with a new answer', async () => {
  const answers = ['wrong', 'wrong', 'right'];
  let asked = 0;
  const sent = [];
  const sys = createSystemHttp(cfg({ passwordSource: 'command', password: undefined, passwordCmd: 'x' }), {
    runCommand: async () => answers[asked++],
    request: async (url, init) => {
      sent.push(init.headers.authorization);
      return { status: init.headers.authorization.endsWith(Buffer.from('DEV:right').toString('base64')) ? 200 : 401, headers: {}, body: '' };
    },
  });
  assert.equal((await sys.send('https://h/a')).status, 401);
  assert.equal(asked, 1);
  await assert.rejects(sys.send('https://h/a'), /once already/, 'the command still answers the rejected one');
  assert.equal((await sys.send('https://h/a')).status, 200, 'a corrected answer is tried');
  assert.equal((await sys.send('https://h/a')).status, 200);
  assert.equal(asked, 3, 'kept after it worked - a keychain asks once');
  assert.equal(sent.length, 3);
});

test('a misconfiguration refuses before anything is sent', async () => {
  let calls = 0;
  const sys = createSystemHttp(cfg({ problems: ['A2UI5_MCP_SYSTEM_USER is not set'] }), { request: async () => { calls++; return { status: 200, headers: {}, body: '' }; } });
  await assert.rejects(sys.send('https://h/a'), /misconfigured: A2UI5_MCP_SYSTEM_USER is not set/);
  assert.equal(calls, 0);
});

test('network failures read as what to change', () => {
  assert.match(networkProblem({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'x' }, 'h:1'), /NODE_EXTRA_CA_CERTS[\s\S]*A2UI5_MCP_SYSTEM_INSECURE_TLS=1/);
  assert.match(networkProblem({ code: 'ENOTFOUND', message: 'x' }, 'h:1'), /does not resolve.*VPN/);
  assert.match(networkProblem({ code: 'ECONNREFUSED', message: 'x' }, 'h:1'), /refused the connection/);
  assert.match(networkProblem({ cause: { code: 'ETIMEDOUT' }, message: 'x' }, 'h:1'), /did not answer/);
  assert.equal(networkProblem(new Error('other'), 'h:1'), 'other');
});

test('a request that fails on the network throws the sentence, a 2xx resets nothing it should not', async () => {
  const sys = createSystemHttp(cfg(), { request: async () => { const e = new Error('self signed'); e.code = 'SELF_SIGNED_CERT_IN_CHAIN'; throw e; } });
  await assert.rejects(sys.send('https://h/a'), /certificate of h could not be verified/);
});

// ----------------------------------------------------------------- ADT -----

test('the ADT quick search: the URL, and only classes from the answer', () => {
  const url = new URL(adtSearchUrl('https://h:1/sap/bc/z2ui5?sap-client=100', 'z2ui5_cl_smp'));
  assert.equal(url.pathname, '/sap/bc/adt/repository/informationsystem/search');
  assert.equal(url.searchParams.get('query'), 'Z2UI5_CL_SMP*');
  assert.equal(url.searchParams.get('objectType'), 'CLAS/OC');
  assert.equal(url.searchParams.get('sap-client'), '100');
  assert.equal(new URL(adtSearchUrl('https://h/x', '')).searchParams.get('query'), 'Z*');
  assert.equal(new URL(adtSearchUrl('https://h/x', '*travel*')).searchParams.get('query'), '*TRAVEL*');
  const refs = parseAdtClassRefs('<adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_A" adtcore:description="A &amp; B" adtcore:packageName="ZP"/>'
    + '<adtcore:objectReference adtcore:type="INTF/OI" adtcore:name="ZIF_A"/><adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_A"/>');
  assert.deepEqual(refs, [{ name: 'ZCL_A', description: 'A & B', packageName: 'ZP' }]);
});

test('system_status: misconfigured, accepted, rejected', async () => {
  const bad = await checkSystem(cfg({ problems: ['p1'] }), createSystemHttp(cfg()));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, ['p1']);
  const ok = await checkSystem(cfg(), createSystemHttp(cfg(), { request: async () => ({ status: 200, headers: {}, body: '' }) }));
  assert.equal(ok.ok, true);
  assert.equal(ok.user, 'DEV');
  const no = await checkSystem(cfg(), createSystemHttp(cfg(), { request: async () => ({ status: 401, headers: {}, body: '' }) }));
  assert.equal(no.ok, false);
  assert.match(no.problem, /rejected the logon/);
  const gone = await checkSystem(cfg(), createSystemHttp(cfg(), { request: async () => ({ status: 404, headers: {}, body: '' }) }));
  assert.match(gone.problem, /SICF/);
  const moved = await checkSystem(cfg(), createSystemHttp(cfg(), { request: async () => ({ status: 302, headers: { location: 'https://idp/saml' }, body: '' }) }));
  assert.match(moved.problem, /HTTP 302 to https:\/\/idp\/saml.*Basic/);
  let signal;
  await checkSystem(cfg(), createSystemHttp(cfg(), { request: async (url, init) => { signal = init.signal; return { status: 200, headers: {}, body: '' }; } }));
  assert.ok(signal instanceof AbortSignal, 'the check is bounded');
});

test('every system tool has a name, a documenting description and an object schema; the acting ones say they are real', () => {
  for (const t of SYSTEM_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(t.description.length > 60, `'${t.name}' needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.equal(new Set(SYSTEM_TOOL_NAMES).size, SYSTEM_TOOLS.length);
  for (const name of ['app_start', 'app_act']) assert.match(SYSTEM_TOOLS.find((t) => t.name === name).description, /FOR REAL/);
});

// --------------------------------------------- the server, over stdio -----

function startServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, A2UI5_MCP_OFFLINE: '1', ...env },
  });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; });
  let id = 0;
  const until = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find(pred);
      if (hit) {
        clearInterval(iv);
        resolve(hit);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout; got: ${buf.slice(-500)}`));
      }
    }, 20);
  });
  const rpc = async (method, params) => {
    const reqId = ++id;
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })}\n`);
    return until((m) => m.id === reqId);
  };
  const call = async (name, args = {}) => {
    const msg = await rpc('tools/call', { name, arguments: args });
    assert.ok(!msg.error, JSON.stringify(msg.error));
    return { isError: !!msg.result.isError, text: msg.result.content[0].text, content: msg.result.content };
  };
  return { p, rpc, call, stop: () => p.kill() };
}

test('system mode over stdio: list, status, ADT search, start, act and describe against the fake system', async () => {
  const sys = await fakeSystem();
  const s = startServer({ A2UI5_MCP_SYSTEM_URL: sys.launchUrl, A2UI5_MCP_SYSTEM_USER: USER, A2UI5_MCP_SYSTEM_PASSWORD: PASSWORD });
  try {
    await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'system', version: '0' } });
    const tools = (await s.rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, SYSTEM_TOOL_NAMES, 'the system tools and nothing else');
    assert.deepEqual((await s.rpc('prompts/list', {})).result.prompts, []);

    const sandbox = await s.call('build_backend', {});
    assert.ok(sandbox.isError);
    assert.match(sandbox.text, /system mode/);

    const status = JSON.parse((await s.call('system_status')).text);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.endpoint, `${sys.origin}/sap/bc/z2ui5?sap-client=001`);
    assert.ok(!JSON.stringify(status).includes(PASSWORD));

    const list = JSON.parse((await s.call('app_list', { filter: 'z2ui5_cl_smp' })).text);
    assert.deepEqual(list.apps.map((a) => a.app), ['Z2UI5_CL_SMP_APP_381', 'ZCL_OTHER']);
    assert.equal(list.apps[0].description, 'Form & toast (Z2UI5_CL_SMP*)');

    const start = await s.call('app_start', { app: 'Z2UI5_CL_SMP_APP_381' });
    assert.ok(!start.isError, start.text);
    let snap = JSON.parse(start.text);
    assert.ok(snap.session);
    snap = JSON.parse((await s.call('app_act', { session: snap.session, values: { f1: 'hello agent', f6: true, f4: 'left top' }, event: 'SHOW' })).text);
    snap = JSON.parse((await s.call('app_act', { session: snap.session, event: 'TOAST_CLOSED' })).text);
    const described = JSON.parse((await s.call('app_describe', { session: snap.session })).text);
    assert.equal(described.session, snap.session);

    assert.deepEqual(sys.problems, [], 'every request matched the recording');
    assert.equal(sys.posted, 3);
    const posts = sys.log.filter((r) => r.method === 'POST');
    assert.ok(posts.every((r) => r.auth.startsWith('Basic ')), 'the logon on every roundtrip');
    assert.ok(sys.log.some((r) => r.method === 'HEAD' && r.csrf === 'Fetch'), 'the CSRF token was fetched by the client');
    assert.ok(posts.slice(1).every((r) => r.cookie.includes('SAP_SESSIONID_A4H_001=s1')), 'one session, its cookie sent back');

    const refused = await s.call('app_act', { session: snap.session, event: 'NO_SUCH_EVENT' });
    assert.ok(refused.isError);
    assert.equal(sys.posted, 3, 'a refused act sends nothing');
  } finally {
    s.stop();
    await sys.close();
  }
});

test('system mode over stdio: a wrong password is sent once, then every tool refuses without a request', async () => {
  const sys = await fakeSystem();
  const s = startServer({ A2UI5_MCP_SYSTEM_URL: sys.launchUrl, A2UI5_MCP_SYSTEM_USER: USER, A2UI5_MCP_SYSTEM_PASSWORD: 'wrong' });
  try {
    await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'system', version: '0' } });
    const first = await s.call('app_start', { app: 'z2ui5_cl_smp_app_381' });
    assert.ok(first.isError);
    assert.match(first.text, /HTTP 401: .*rejected the logon of user DEVELOPER/);
    for (const [name, args] of [['app_start', { app: 'z2ui5_cl_smp_app_381' }], ['app_list', {}], ['system_status', {}]]) {
      const again = await s.call(name, args);
      assert.match(again.text, /once already/, name);
    }
    assert.equal(sys.log.length, 1, 'exactly one logon attempt reached the system');
  } finally {
    s.stop();
    await sys.close();
  }
});

test('system mode over stdio: a misconfiguration starts the server and is the answer of every tool', async () => {
  const s = startServer({ A2UI5_MCP_SYSTEM_URL: 'https://h/sap/bc/{class}', A2UI5_MCP_SYSTEM_USER: '', A2UI5_MCP_SYSTEM_PASSWORD: '' });
  try {
    await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'system', version: '0' } });
    const status = JSON.parse((await s.call('system_status')).text);
    assert.equal(status.ok, false);
    assert.equal(status.problems.length, 3);
    const start = await s.call('app_start', { app: 'zcl_x' });
    assert.ok(start.isError);
    assert.match(start.text, /misconfigured/);
    assert.ok(!start.text.includes(PROBE_CLASS));
  } finally {
    s.stop();
  }
});

// The WRITE half of the system mode (lib/system-write.mjs): a class from its
// abapGit files onto a system over ADT, activation, ABAP Unit - opt-in and
// experimental. The pure halves against literals and injected requests, the
// rest through the real server over stdio against the ADT endpoints of
// test/helpers/fake-system.mjs.
//
// That fake is a stand-in written from the same request shapes as the
// client. These tests therefore prove the sequence, every refusal and that
// the lock is always given back - and NOT that a real ADT answers this way:
// nothing here was run against an SAP system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemConfig, createSystemHttp } from '../lib/system.mjs';
import {
  writeConfig, describeWrite, writableClassName, writeDisabledMessage, definedClass, sidecarFacts, sameSource, partFile,
  classPath, partPath, parseClassMetadata, parseLock, parseActivation, parseUnitRun, adtErrorText,
  createClassBody, activationBody, unitRunBody, writeClass, activateClass, DEFAULT_ALLOW, WRITE_ENV,
} from '../lib/system-write.mjs';
import { SYSTEM_TOOLS, SYSTEM_TOOL_NAMES, SYSTEM_WRITE_TOOLS, SYSTEM_WRITE_TOOL_NAMES } from '../lib/system-tools.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { fakeSystem, USER, PASSWORD } from './helpers/fake-system.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE = (name = 'zcl_mcp_demo', body = '    client->message_toast_display( `hi` ).') => [
  `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
  '  PUBLIC SECTION.',
  '    INTERFACES z2ui5_if_app.',
  'ENDCLASS.',
  '',
  `CLASS ${name} IMPLEMENTATION.`,
  '  METHOD z2ui5_if_app~main.',
  body,
  '  ENDMETHOD.',
  'ENDCLASS.',
  '',
].join('\n');
const TESTS = (methods = ['first']) => [
  'CLASS ltcl_test DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.',
  '  PRIVATE SECTION.',
  ...methods.map((m) => `    METHODS ${m} FOR TESTING.`),
  'ENDCLASS.',
  'CLASS ltcl_test IMPLEMENTATION.',
  ...methods.flatMap((m) => [`  METHOD ${m}.`, '  ENDMETHOD.']),
  'ENDCLASS.',
  '',
].join('\n');
const SIDECAR = (name = 'ZCL_MCP_DEMO', descript = 'Demo &amp; more') => '<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">\n <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n  <asx:values>\n   <VSEOCLASS>\n'
  + `    <CLSNAME>${name}</CLSNAME>\n    <LANGU>E</LANGU>\n    <DESCRIPT>${descript}</DESCRIPT>\n    <STATE>1</STATE>\n   </VSEOCLASS>\n  </asx:values>\n </asx:abap>\n</abapGit>\n`;

// ------------------------------------------------------------ the gates ----

test('the write half is off unless A2UI5_MCP_SYSTEM_WRITE is set, and a bad allow pattern is a problem, not the default', () => {
  assert.equal(writeConfig({}).enabled, false);
  assert.equal(writeConfig({ [WRITE_ENV.on]: '0' }).enabled, false);
  assert.equal(writeConfig({ [WRITE_ENV.on]: '' }).enabled, false);
  for (const on of ['1', 'true', 'yes', 'on']) assert.equal(writeConfig({ [WRITE_ENV.on]: on }).enabled, true, on);
  assert.equal(writeConfig({}).allowSource, DEFAULT_ALLOW);
  assert.match(describeWrite(writeConfig({})), /^off - the write tools are not listed \(set A2UI5_MCP_SYSTEM_WRITE=1/);
  assert.match(describeWrite(writeConfig({ [WRITE_ENV.on]: '1' })), /^ON \(experimental, tested against a fake system only\)/);

  const bad = writeConfig({ [WRITE_ENV.on]: '1', [WRITE_ENV.allow]: '^ZCL_(' });
  assert.equal(bad.allow, null);
  assert.match(bad.problems[0], /A2UI5_MCP_SYSTEM_WRITE_ALLOW '\^ZCL_\(' is not a regular expression/);
  assert.throws(() => writableClassName('zcl_ok', bad), /misconfigured/, 'no fallback to the default pattern');
  assert.match(writeDisabledMessage('system_activate'), /system_activate writes to the SAP system and is switched off: set A2UI5_MCP_SYSTEM_WRITE=1.*Nothing was sent/);
});

test('writableClassName: customer names only - never Z2UI5_*, never an SAP name, whatever the allow pattern says', () => {
  const dflt = writeConfig({});
  for (const [name, want] of [['zcl_my_app', 'ZCL_MY_APP'], ['YCL_X', 'YCL_X'], [' zcl_spaced ', 'ZCL_SPACED'], ['/acme/cl_app', '/ACME/CL_APP'], ['z2ui5x_cl_mine', 'Z2UI5X_CL_MINE']]) {
    assert.equal(writableClassName(name, dflt), want);
  }
  // the framework's own namespace
  for (const name of ['z2ui5_cl_core_app', 'Z2UI5_CL_POPUP_TO_CONFIRM', 'z2ui5_if_app']) {
    assert.throws(() => writableClassName(name, dflt), /Z2UI5_\*, the namespace of the abap2UI5 framework itself/, name);
  }
  // SAP's name range, and SAP's namespaces
  for (const name of ['cl_abap_typedescr', 'CL_GUI_FRONTEND_SERVICES', 'sapmv45a', 'lcl_local', 'if_oo_adt_classrun', 'xcl_x']) {
    assert.throws(() => writableClassName(name, dflt), /is SAP's.*never writes an SAP-owned object/, name);
  }
  for (const name of ['/sap/cl_x', '/sapapo/cl_x', '/ui5/cl_x', '/iwbep/cl_x', '/1bcdwb/cl_x', '/bobf/cl_x']) {
    assert.throws(() => writableClassName(name, dflt), /a namespace SAP delivers objects in/, name);
  }
  // not names at all
  for (const name of ['', '   ', 'zcl-app', 'zcl app', 'zcl_app;drop', '../zcl_x', 'z'.repeat(31), '/toolongnamespace/cl_x', '/ns/']) {
    assert.throws(() => writableClassName(name, dflt), /missing|longer than 30|no customer class name/, JSON.stringify(name));
  }
  assert.throws(() => writableClassName(undefined, dflt), /class_name is missing/);

  // the allow pattern narrows - and cannot widen past the hard refusals
  const narrow = writeConfig({ [WRITE_ENV.allow]: '^ZCL_ACME_' });
  assert.equal(writableClassName('zcl_acme_app', narrow), 'ZCL_ACME_APP');
  assert.throws(() => writableClassName('zcl_other_app', narrow), /does not match the allowed names \/\^ZCL_ACME_\/i \(A2UI5_MCP_SYSTEM_WRITE_ALLOW\)/);
  const wide = writeConfig({ [WRITE_ENV.allow]: '.*' });
  assert.throws(() => writableClassName('z2ui5_cl_core_app', wide), /framework itself/);
  assert.throws(() => writableClassName('cl_abap_typedescr', wide), /SAP's/);
  assert.throws(() => writableClassName('/sap/cl_x', wide), /SAP delivers/);
});

// ----------------------------------------------------- the pure halves ----

test('the abapGit files: the class a source defines, the sidecar, the file of a part, what counts as the same source', () => {
  assert.equal(definedClass(SOURCE('zcl_a')), 'ZCL_A');
  assert.equal(definedClass('\uFEFF* a comment\nCLASS /acme/cl_x DEFINITION PUBLIC.'), '/ACME/CL_X');
  assert.equal(definedClass('REPORT zreport.'), null);
  assert.equal(definedClass(undefined), null);
  assert.deepEqual(sidecarFacts(SIDECAR()), { className: 'ZCL_MCP_DEMO', description: 'Demo & more' });
  assert.deepEqual(sidecarFacts('<abapGit/>'), { className: undefined, description: undefined });
  assert.equal(partFile('ZCL_X', 'main'), 'zcl_x.clas.abap');
  assert.equal(partFile('ZCL_X', 'testclasses'), 'zcl_x.clas.testclasses.abap');
  assert.equal(partFile('ZCL_X', 'implementations'), 'zcl_x.clas.locals_imp.abap');
  assert.equal(partFile('/ACME/CL_X', 'main'), '#acme#cl_x.clas.abap');
  assert.equal(sameSource('a\r\nb\r\n', '\uFEFFa\nb'), true);
  assert.equal(sameSource('a\nb', 'a\nc'), false);
  assert.equal(classPath('/ACME/CL_X'), '/sap/bc/adt/oo/classes/%2Facme%2Fcl_x');
  assert.equal(partPath('ZCL_X', 'main'), '/sap/bc/adt/oo/classes/zcl_x/source/main');
  assert.equal(partPath('ZCL_X', 'testclasses'), '/sap/bc/adt/oo/classes/zcl_x/includes/testclasses');
});

test('the request bodies name the class, escaped, and nothing the caller did not give', () => {
  const create = createClassBody({ className: 'ZCL_X', description: 'A "quoted" <b> & more', packageName: '$TMP', responsible: 'DEVELOPER' });
  assert.match(create, /adtcore:name="ZCL_X" adtcore:type="CLAS\/OC" adtcore:responsible="DEVELOPER"/);
  assert.match(create, /adtcore:description="A &quot;quoted&quot; &lt;b&gt; &amp; more"/);
  assert.match(create, /<adtcore:packageRef adtcore:name="\$TMP"\/>/);
  assert.match(activationBody('zcl_x'), /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_x" adtcore:name="ZCL_X"/);
  const unit = unitRunBody('zcl_x');
  assert.match(unit, /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_x"/);
  assert.match(unit, /dangerous="false" critical="false"/, 'no dangerous or critical test is asked for');
});

test('the answers: class metadata, a lock, an ADT error', () => {
  const meta = parseClassMetadata('<class:abapClass xmlns:class="c" adtcore:name="ZCL_X" adtcore:version="inactive" adtcore:changedAt="2026-11-10T09:00:00Z" adtcore:changedBy="OTHER">'
    + '<adtcore:packageRef adtcore:name="$tmp"/><class:include class:includeType="testclasses"/><class:include class:includeType="main"/></class:abapClass>');
  assert.equal(meta.changedBy, 'OTHER');
  assert.equal(meta.changedAt, '2026-11-10T09:00:00Z');
  assert.equal(meta.version, 'inactive');
  assert.equal(meta.package, '$TMP');
  assert.deepEqual([...meta.includes], ['testclasses', 'main']);
  assert.equal(parseClassMetadata('').changedBy, undefined);

  assert.deepEqual(parseLock('<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><IS_LOCAL>X</IS_LOCAL></DATA></asx:values></asx:abap>'),
    { lockHandle: 'H1', corrNr: '', isLocal: true });
  assert.deepEqual(parseLock('<DATA><LOCK_HANDLE>H2</LOCK_HANDLE><CORRNR>a4hk900123</CORRNR><IS_LOCAL/></DATA>'), { lockHandle: 'H2', corrNr: 'A4HK900123', isLocal: false });
  assert.equal(parseLock('<DATA><LOCK_HANDLE/></DATA>'), null);

  assert.equal(adtErrorText({ status: 403, body: '<exc:exception><message lang="EN">m</message><localizedMessage lang="EN">User OTHER is editing &quot;ZCL_X&quot;</localizedMessage></exc:exception>' }),
    'User OTHER is editing "ZCL_X"');
  assert.equal(adtErrorText({ status: 500, body: '<html>oops</html>' }), 'HTTP 500');
});

test('parseActivation: messages by file, line and column; errors and inactive objects fail it', () => {
  // the shape of the VS Code extension's fixture (after abap-adt-api activate.ts)
  const xml = '<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">'
    + '<msg objDescr="Class ZCL_DEMO_APP, Method Z2UI5_IF_APP~MAIN" type="E" line="1" href="/sap/bc/adt/oo/classes/zcl_demo_app/source/main#start=14,8" forceSupported="true"><shortText><txt>Field "CLIENT_X" is unknown.</txt></shortText></msg>'
    + '<msg objDescr="Class ZCL_DEMO_APP, local implementations" type="W" line="1" href="/sap/bc/adt/oo/classes/zcl_demo_app/includes/implementations#start=3,2" forceSupported="true"><shortText><txt>The variable &quot;LV_UNUSED&quot; is not used.</txt></shortText></msg>'
    + '<msg objDescr="Class ZCL_DEMO_APP, test classes" type="E" line="7" href="/sap/bc/adt/oo/classes/zcl_demo_app/includes/testclasses" forceSupported="true"><shortText><txt>No position fragment.</txt></shortText></msg>'
    + '<msg objDescr="Class ZCL_DEMO_APP" type="E" line="0" href="" forceSupported="false"><shortText><txt>Class ZCL_DEMO_APP could not be activated</txt></shortText></msg>'
    + '<msg type="I" href="/sap/bc/adt/oo/classes/zcl_other/source/main#start=2,0" objDescr="Class ZCL_OTHER"/>'
    + '</chkl:messages>';
  const result = parseActivation(xml, 'ZCL_DEMO_APP');
  assert.equal(result.success, false);
  assert.deepEqual(result.messages, [
    { file: 'zcl_demo_app.clas.abap', part: 'main', line: 14, column: 8, severity: 'error', text: 'Field "CLIENT_X" is unknown.' },
    { file: 'zcl_demo_app.clas.locals_imp.abap', part: 'implementations', line: 3, column: 2, severity: 'warning', text: 'The variable "LV_UNUSED" is not used.' },
    { file: 'zcl_demo_app.clas.testclasses.abap', part: 'testclasses', line: 7, column: 0, severity: 'error', text: 'No position fragment.' },
    { file: 'zcl_demo_app.clas.abap', part: 'main', line: 1, column: 0, severity: 'error', text: 'Class ZCL_DEMO_APP: Class ZCL_DEMO_APP could not be activated' },
    { file: 'zcl_demo_app.clas.abap', part: 'main', line: 1, column: 0, severity: 'info', text: 'Class ZCL_OTHER: Syntax error' },
  ]);
  // warnings alone do not fail it; an empty answer is a success
  assert.equal(parseActivation('<chkl:messages><msg type="W" href=""><shortText><txt>w</txt></shortText></msg></chkl:messages>', 'ZCL_X').success, true);
  assert.deepEqual(parseActivation('', 'ZCL_X'), { success: true, messages: [], inactive: [] });
  // anything that stayed inactive fails it, without a message
  const inactive = parseActivation('<ioc:inactiveObjects xmlns:ioc="i"><ioc:entry><ioc:object ioc:user="D"><ioc:ref xmlns:adtcore="a" adtcore:uri="/sap/bc/adt/oo/classes/zcl_x" adtcore:name="ZCL_X"/></ioc:object></ioc:entry></ioc:inactiveObjects>', 'ZCL_X');
  assert.equal(inactive.success, false);
  assert.deepEqual(inactive.inactive, ['ZCL_X']);
});

test('parseUnitRun: one entry per test method, a failed assertion with its stack, alerts outside a method', () => {
  const uri = '/sap/bc/adt/oo/classes/zcl_x';
  const xml = '<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program adtcore:name="ZCL_X" xmlns:adtcore="a"><testClasses>'
    + '<testClass adtcore:name="LTCL_TEST"><testMethods>'
    + '<testMethod adtcore:name="FIRST" executionTime="0.01" unit="s"/>'
    + '<testMethod adtcore:name="SECOND" executionTime="0.02" unit="s"><alerts><alert kind="failedAssertion" severity="critical"><title>Critical Assertion Error: &apos;count&apos;</title>'
    + '<details><detail text="Expected [1] Actual [2]"><details><detail text="Test &apos;SECOND&apos;"/></details></detail></details>'
    + `<stack><stackEntry adtcore:uri="${uri}/includes/testclasses#start=12,0" adtcore:description="Include: &lt;ZCL_X====CCAU&gt; Line: &lt;12&gt; (SECOND)"/></stack></alert></alerts></testMethod>`
    + '<testMethod adtcore:name="THIRD" executionTime="0"><alerts><alert kind="warning" severity="tolerable"><title>Slow</title></alert></alerts></testMethod>'
    + '</testMethods></testClass>'
    + '<testClass adtcore:name="LTCL_BROKEN"><alerts><alert kind="exception" severity="fatal"><title>Exception in class_setup</title></alert></alerts><testMethods/></testClass>'
    + '</testClasses></program></aunit:runResult>';
  const run = parseUnitRun(xml, 'ZCL_X');
  assert.equal(run.ok, false);
  assert.equal(run.ran, 3);
  assert.equal(run.failed, 1);
  assert.deepEqual(run.tests[0], { class: 'LTCL_TEST', method: 'FIRST', ok: true, seconds: 0.01 });
  assert.equal(run.tests[1].ok, false);
  assert.deepEqual(run.tests[1].alerts[0], {
    kind: 'failedAssertion', severity: 'critical', title: 'Critical Assertion Error: \'count\'',
    details: ['Expected [1] Actual [2]', 'Test \'SECOND\''],
    stack: [{ file: 'zcl_x.clas.testclasses.abap', line: 12, text: 'Include: <ZCL_X====CCAU> Line: <12> (SECOND)' }],
  });
  assert.equal(run.tests[2].ok, true, 'a tolerable alert does not fail a method');
  assert.deepEqual(run.alerts, [{ class: 'LTCL_BROKEN', kind: 'exception', severity: 'fatal', title: 'Exception in class_setup' }]);
  // no test classes: nothing ran, and that is not a failure by itself
  assert.deepEqual(parseUnitRun('<aunit:runResult xmlns:aunit="x"/>', 'ZCL_X'), { ok: true, ran: 0, failed: 0, tests: [] });
});

// --------------------------------- the sequence, against injected requests ----

const cfg = () => systemConfig({ A2UI5_MCP_SYSTEM_URL: 'https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100', A2UI5_MCP_SYSTEM_USER: 'dev', A2UI5_MCP_SYSTEM_PASSWORD: 'pw' });
const LOCK_LOCAL = '<asx:abap><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><IS_LOCAL>X</IS_LOCAL></DATA></asx:values></asx:abap>';
const META = (changedBy = 'DEV') => `<class:abapClass adtcore:name="ZCL_X" adtcore:changedBy="${changedBy}"><adtcore:packageRef adtcore:name="$TMP"/><class:include class:includeType="testclasses"/></class:abapClass>`;

/** A system answering by a script: `answer(method, url)` -> { status, body } or a throw. */
function scripted(answer) {
  const seen = [];
  const sys = createSystemHttp(cfg(), {
    request: async (url, init) => {
      const u = new URL(url);
      const entry = { method: init.method, path: u.pathname, action: u.searchParams.get('_action'), lockHandle: u.searchParams.get('lockHandle'), corrNr: u.searchParams.get('corrNr'), client: u.searchParams.get('sap-client'), session: init.headers['x-sap-adt-sessiontype'], token: init.headers['x-csrf-token'], aborted: init.signal.aborted };
      seen.push(entry);
      const res = await answer(entry, init);
      return { status: 200, headers: {}, body: '', ...res };
    },
  });
  return { sys, seen };
}

test('writeClass: the unlock is sent after a write that THROWS (a dropped connection), and the answer says what was on the system', async () => {
  const { sys, seen } = scripted(async (r) => {
    if (r.method === 'GET' && r.path.endsWith('/zcl_x')) return { headers: { 'x-csrf-token': 'T1' }, body: META() };
    if (r.method === 'GET') return { body: 'old source' };
    if (r.action === 'LOCK') return { body: LOCK_LOCAL };
    if (r.method === 'PUT' && r.path.endsWith('/includes/testclasses')) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return {};
  });
  const res = await writeClass({ className: 'zcl_x', source: SOURCE('zcl_x'), testclasses: TESTS(), packageName: '$tmp' }, { config: cfg(), sys, write: writeConfig({ [WRITE_ENV.on]: '1' }) });
  assert.equal(res.ok, false);
  assert.match(res.failed, /the write of ZCL_X was interrupted - host:44300 did not answer \(ECONNRESET\)/, 'the network sentence of lib/system.mjs');
  assert.match(res.failed, /zcl_x\.clas\.abap had been written before that and is on the system, inactive/);
  assert.deepEqual(res.written, ['zcl_x.clas.abap']);
  assert.equal(res.unlocked, true);
  const order = seen.map((r) => r.action || `${r.method} ${r.path.replace('/sap/bc/adt/', '')}`);
  assert.deepEqual(order.slice(-5), ['LOCK', 'PUT oo/classes/zcl_x/source/main', 'PUT oo/classes/zcl_x/includes/testclasses', 'UNLOCK', 'GET compatibility/graph']);
  const unlock = seen.find((r) => r.action === 'UNLOCK');
  assert.equal(unlock.lockHandle, 'H1');
  // the conversation: the token fetched once and sent after, stateful from the lock to the unlock, the client on every request
  assert.equal(seen[0].token, 'fetch');
  assert.ok(seen.slice(1).every((r) => r.token === 'T1'));
  assert.ok(seen.filter((r) => r.action || r.method === 'PUT').every((r) => r.session === 'stateful'));
  assert.equal(seen[0].session, 'stateless');
  assert.equal(seen.at(-1).session, 'stateless', 'the stateful session is ended');
  assert.ok(seen.every((r) => r.client === '100'));
});

test('writeClass: a client that cancels mid-write still unlocks - the unlock has a signal of its own', async () => {
  const cancel = new AbortController();
  const { sys, seen } = scripted(async (r, init) => {
    if (r.method === 'GET' && r.path.endsWith('/zcl_x')) return { headers: { 'x-csrf-token': 'T1' }, body: META() };
    if (r.method === 'GET') return { body: 'old source' };
    if (r.action === 'LOCK') return { body: LOCK_LOCAL };
    if (r.method === 'PUT') {
      cancel.abort();
      init.signal.throwIfAborted();
    }
    return {};
  });
  const res = await writeClass({ className: 'zcl_x', source: SOURCE('zcl_x'), packageName: '$TMP' }, { config: cfg(), sys, write: writeConfig({}), signal: cancel.signal });
  assert.equal(res.ok, false);
  assert.match(res.failed, /interrupted/);
  assert.deepEqual(res.written, []);
  const unlock = seen.find((r) => r.action === 'UNLOCK');
  assert.ok(unlock, 'the unlock went out after the cancel');
  assert.equal(unlock.aborted, false);
  assert.equal(res.unlocked, true);
});

test('writeClass: an unlock the system does not confirm is said, never hidden', async () => {
  const { sys } = scripted(async (r) => {
    if (r.method === 'GET' && r.path.endsWith('/zcl_x')) return { headers: { 'x-csrf-token': 'T1' }, body: META() };
    if (r.method === 'GET') return { body: 'old source' };
    if (r.action === 'LOCK') return { body: LOCK_LOCAL };
    if (r.action === 'UNLOCK') return { status: 500, body: '' };
    return {};
  });
  const res = await writeClass({ className: 'zcl_x', source: SOURCE('zcl_x'), packageName: '$TMP' }, { config: cfg(), sys, write: writeConfig({}) });
  assert.equal(res.ok, true);
  assert.equal(res.unlocked, false);
  assert.match(res.lockNotReleased, /was not confirmed.*SM12/);
});

test('writeClass refuses before a single request: the name, the source, the package, the transport', async () => {
  const { sys, seen } = scripted(async () => ({ status: 500 }));
  const deps = { config: cfg(), sys, write: writeConfig({ [WRITE_ENV.on]: '1' }) };
  const ok = { className: 'zcl_x', source: SOURCE('zcl_x'), packageName: '$TMP' };
  await assert.rejects(writeClass({ ...ok, className: 'z2ui5_cl_core_app', source: SOURCE('z2ui5_cl_core_app') }, deps), /framework itself/);
  await assert.rejects(writeClass({ ...ok, className: 'cl_abap_x', source: SOURCE('cl_abap_x') }, deps), /SAP's/);
  for (const [input, why] of [
    [{ ...ok, source: '' }, /`source` is empty/],
    [{ ...ok, source: SOURCE('zcl_other') }, /`source` defines the class ZCL_OTHER, not ZCL_X/],
    [{ ...ok, source: 'REPORT zcl_x.' }, /has no "CLASS zcl_x DEFINITION"/],
    [{ ...ok, xml: SIDECAR('ZCL_OTHER') }, /the \.clas\.xml names the class ZCL_OTHER \(CLSNAME\), not ZCL_X/],
    [{ ...ok, packageName: '' }, /`package` is missing/],
    [{ ...ok, packageName: undefined }, /`package` is missing/],
    [{ ...ok, packageName: 'my package' }, /is no package name/],
    [{ ...ok, packageName: 'ZPKG' }, /ZPKG is transportable, so `transport` is required.*never picks a transport request and never creates one/],
    [{ ...ok, packageName: 'ZPKG', transport: 'next free one' }, /is no transport request number/],
  ]) {
    const res = await writeClass(input, deps);
    assert.equal(res.ok, false);
    assert.match(res.refused, why);
  }
  assert.equal(seen.length, 0, 'nothing reached the system');
});

test('activateClass refuses a class that does not exist before it asks for an activation', async () => {
  const { sys, seen } = scripted(async () => ({ status: 404, body: '<exc:exception><message>not found</message></exc:exception>' }));
  const res = await activateClass({ className: 'zcl_x' }, { config: cfg(), sys, write: writeConfig({}) });
  assert.match(res.refused, /ZCL_X does not exist on host:44300 - system_write_class writes it first/);
  assert.equal(seen.length, 1);
  assert.ok(!seen.some((r) => r.method === 'POST'));
});

test('the write tools: documented, marked experimental and real, and never sharing a name', () => {
  assert.deepEqual(SYSTEM_WRITE_TOOL_NAMES, ['system_activate', 'system_unit_tests', 'system_write_class']);
  for (const t of SYSTEM_WRITE_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/);
    assert.equal(t.inputSchema.type, 'object');
    assert.match(t.description, /EXPERIMENTAL/, `${t.name} says it is experimental`);
    assert.match(t.description, /never against a real one/, `${t.name} says what it was tested against`);
    assert.match(t.description, /Z2UI5_\*/, `${t.name} says which names it refuses`);
    assert.ok(!SYSTEM_TOOL_NAMES.includes(t.name) && !TOOL_NAMES.includes(t.name), `${t.name} is no other tool's name`);
  }
  for (const name of ['system_write_class', 'system_activate']) assert.match(SYSTEM_WRITE_TOOLS.find((t) => t.name === name).description, /WRITES TO THE REAL SAP SYSTEM/);
  const write = SYSTEM_WRITE_TOOLS.find((t) => t.name === 'system_write_class');
  assert.deepEqual(write.inputSchema.required, ['class_name', 'source', 'package'], 'the package is never defaulted');
  assert.match(write.description, /never picks a transport request and never creates one/);
  assert.ok(!SYSTEM_TOOLS.some((t) => /EXPERIMENTAL/.test(t.description)));
});

// --------------------------------------------- the server, over stdio -----

function startServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, A2UI5_MCP_OFFLINE: '1', A2UI5_MCP_SYSTEM_WRITE: '', A2UI5_MCP_SYSTEM_WRITE_ALLOW: '', ...env },
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
    const text = msg.result.content[0].text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // a plain-text refusal
    }
    return { isError: !!msg.result.isError, text, json };
  };
  return { rpc, call, stop: () => p.kill() };
}

/** The server in system mode against a fake system, with the write half on. */
async function withSystem(adt, fn, env = {}) {
  const sys = await fakeSystem({ adt });
  const s = startServer({ A2UI5_MCP_SYSTEM_URL: sys.launchUrl, A2UI5_MCP_SYSTEM_USER: USER, A2UI5_MCP_SYSTEM_PASSWORD: PASSWORD, A2UI5_MCP_SYSTEM_WRITE: '1', ...env });
  try {
    await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'system-write', version: '0' } });
    await fn(s, sys);
  } finally {
    s.stop();
    await sys.close();
  }
}
/** The ADT requests the fake saw, as "METHOD path[ ACTION]". */
const adtLog = (sys) => sys.log.filter((r) => r.path.startsWith('/sap/bc/adt/'))
  .map((r) => `${r.method} ${r.path.replace('/sap/bc/adt/', '')}${new URLSearchParams(r.search).get('_action') ? ` ${new URLSearchParams(r.search).get('_action')}` : ''}`);

test('without the opt-in the write tools are not listed, and a call by name is refused with nothing sent', async () => {
  await withSystem({}, async (s, sys) => {
    const tools = (await s.rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, SYSTEM_TOOL_NAMES, 'the system tools and nothing else');
    for (const [name, args] of [
      ['system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), package: '$TMP' }],
      ['system_activate', { class_name: 'zcl_mcp_demo' }],
      ['system_unit_tests', { class_name: 'zcl_mcp_demo' }],
    ]) {
      const res = await s.call(name, args);
      assert.ok(res.isError, name);
      assert.match(res.text, new RegExp(`${name} writes to the SAP system and is switched off: set A2UI5_MCP_SYSTEM_WRITE=1`));
    }
    assert.equal(sys.log.length, 0, 'not one request reached the system');
    assert.equal(sys.adt.classes.size, 0);
    assert.match((await s.call('system_status')).json.write, /^off/);
  }, { A2UI5_MCP_SYSTEM_WRITE: '' });
  // and in the sandbox mode the names do not exist at all
  const sandbox = startServer({ A2UI5_MCP_SYSTEM_URL: '', A2UI5_MCP_SYSTEM_WRITE: '1', A2UI5_MCP_REMOTE: '0' });
  try {
    await sandbox.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'system-write', version: '0' } });
    const tools = (await sandbox.rpc('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!tools.some((t) => SYSTEM_WRITE_TOOL_NAMES.includes(t)), 'A2UI5_MCP_SYSTEM_WRITE alone lists nothing');
    assert.ok((await sandbox.call('system_write_class', { class_name: 'zcl_x' })).isError);
  } finally {
    sandbox.stop();
  }
});

test('the happy path: create in $TMP, write both files, activate, run the unit tests - and write again changes nothing', async () => {
  await withSystem({}, async (s, sys) => {
    const tools = (await s.rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [...SYSTEM_TOOL_NAMES, ...SYSTEM_WRITE_TOOL_NAMES].sort());
    assert.match((await s.call('system_status')).json.write, /^ON \(experimental/);

    const written = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), testclasses: TESTS(['first', 'second']), xml: SIDECAR(), package: '$TMP' });
    assert.ok(!written.isError, written.text);
    assert.deepEqual({ ...written.json, next: undefined }, {
      ok: true,
      class: 'ZCL_MCP_DEMO',
      package: '$TMP',
      created: true,
      written: ['zcl_mcp_demo.clas.abap', 'zcl_mcp_demo.clas.testclasses.abap'],
      unchanged: [],
      unlocked: true,
      active: false,
      next: undefined,
      system: new URL(sys.origin).host,
      user: USER,
    });
    assert.match(written.json.next, /INACTIVE.*system_activate \{ class_name: "zcl_mcp_demo" \}/);
    // what the system holds: the class as given, described from the sidecar, owned by the logged-on user
    const cls = sys.adt.classes.get('ZCL_MCP_DEMO');
    assert.equal(cls.main, SOURCE());
    assert.equal(cls.testclasses, TESTS(['first', 'second']));
    assert.equal(cls.description, 'Demo &amp; more');
    assert.equal(cls.package, '$TMP');
    assert.equal(cls.responsible, USER);
    assert.equal(cls.active, false);
    assert.equal(sys.adt.locks.size, 0, 'unlocked');
    assert.deepEqual(adtLog(sys), [
      'GET oo/classes/zcl_mcp_demo',
      'POST oo/classes',
      'POST oo/classes/zcl_mcp_demo LOCK',
      'PUT oo/classes/zcl_mcp_demo/source/main',
      'PUT oo/classes/zcl_mcp_demo/includes/testclasses',
      'POST oo/classes/zcl_mcp_demo UNLOCK',
      'GET compatibility/graph',
    ]);
    const adt = sys.log.filter((r) => r.path.startsWith('/sap/bc/adt/'));
    assert.ok(adt.every((r) => r.auth.startsWith('Basic ')), 'the logon on every request');
    assert.ok(adt.every((r) => new URLSearchParams(r.search).get('sap-client') === '001'), 'the client on every request');
    assert.ok(adt.every((r) => !new URLSearchParams(r.search).has('corrNr')), 'no transport request for a local object');
    assert.deepEqual(adt.map((r) => r.session), ['stateless', 'stateless', 'stateful', 'stateful', 'stateful', 'stateful', 'stateless']);

    const activated = await s.call('system_activate', { class_name: 'ZCL_MCP_DEMO' });
    assert.ok(!activated.isError, activated.text);
    assert.equal(activated.json.activated, true);
    assert.deepEqual(activated.json.messages, []);
    assert.equal(cls.active, true);

    const unit = await s.call('system_unit_tests', { class_name: 'zcl_mcp_demo' });
    assert.ok(!unit.isError, unit.text);
    assert.equal(unit.json.ok, true);
    assert.equal(unit.json.ran, 2);
    assert.deepEqual(unit.json.tests.map((t) => `${t.class}.${t.method}`), ['LTCL_TEST.FIRST', 'LTCL_TEST.SECOND']);

    // the same files again: compared with the system, nothing locked, nothing written
    const before = sys.log.length;
    const again = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE().replace(/\n/g, '\r\n'), testclasses: TESTS(['first', 'second']), package: '$tmp' });
    assert.ok(!again.isError, again.text);
    assert.equal(again.json.created, false);
    assert.deepEqual(again.json.written, []);
    assert.deepEqual(again.json.unchanged, ['zcl_mcp_demo.clas.abap', 'zcl_mcp_demo.clas.testclasses.abap']);
    assert.ok(!sys.log.slice(before).some((r) => r.method !== 'GET'), 'reads only');
    assert.equal(cls.active, true);

    // one file changed: only that one is written
    const changed = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE('zcl_mcp_demo', '    client->message_toast_display( `again` ).'), testclasses: TESTS(['first', 'second']), package: '$TMP' });
    assert.deepEqual(changed.json.written, ['zcl_mcp_demo.clas.abap']);
    assert.deepEqual(changed.json.unchanged, ['zcl_mcp_demo.clas.testclasses.abap']);
    assert.equal(cls.active, false);
  });
});

test('a syntax error on activation: the messages by file, line and column, and the class stays inactive', async () => {
  await withSystem({}, async (s, sys) => {
    const source = SOURCE('zcl_mcp_demo', '    SYNTAX_ERROR = 1.');
    assert.ok(!(await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source, testclasses: TESTS(), description: 'Demo', package: '$TMP' })).isError);
    const res = await s.call('system_activate', { class_name: 'zcl_mcp_demo' });
    assert.ok(res.isError, 'a failed activation is a failed call');
    assert.equal(res.json.ok, false);
    assert.equal(res.json.activated, false);
    assert.equal(res.json.errors, 1);
    assert.deepEqual(res.json.messages, [
      { file: 'zcl_mcp_demo.clas.abap', part: 'main', line: 8, column: 4, severity: 'error', text: 'Field "SYNTAX_ERROR" is unknown.' },
      { file: 'zcl_mcp_demo.clas.testclasses.abap', part: 'testclasses', line: 2, column: 4, severity: 'warning', text: 'A warning in the tests.' },
    ]);
    assert.equal(source.split('\n')[7].slice(4, 16), 'SYNTAX_ERROR', 'line 8 (1-based), column 4 (0-based) is where the error is');
    assert.deepEqual(res.json.inactive, ['ZCL_MCP_DEMO']);
    assert.match(res.json.note, /was NOT activated and stays inactive/);
    assert.equal(sys.adt.classes.get('ZCL_MCP_DEMO').active, false);

    // fixed, written again, activated
    assert.ok(!(await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), package: '$TMP' })).isError);
    assert.equal((await s.call('system_activate', { class_name: 'zcl_mcp_demo' })).json.activated, true);
  });
});

test('a failing unit test is a failed call that names the method, the assertion and the line', async () => {
  await withSystem({ classes: { ZCL_MCP_DEMO: { main: SOURCE(), testclasses: TESTS(['passes', 'fails_on_count']) } } }, async (s) => {
    const res = await s.call('system_unit_tests', { class_name: 'zcl_mcp_demo' });
    assert.ok(res.isError);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.ran, 2);
    assert.equal(res.json.failed, 1);
    const bad = res.json.tests.find((t) => !t.ok);
    assert.equal(bad.method, 'FAILS_ON_COUNT');
    assert.equal(bad.alerts[0].title, 'Critical Assertion Error: \'count\'');
    assert.deepEqual(bad.alerts[0].stack[0], { file: 'zcl_mcp_demo.clas.testclasses.abap', line: 11, text: 'Include: <ZCL_MCP_DEMO====CCAU> Line: <11> (FAILS_ON_COUNT)' });
    // a class without tests ran nothing, and says so
    const none = await s.call('system_unit_tests', { class_name: 'zcl_no_such' });
    assert.ok(none.isError);
    assert.match(none.json.refused, /ZCL_NO_SUCH does not exist/);
  });
});

test('a refused name reaches the system with no request at all', async () => {
  await withSystem({ classes: { Z2UI5_CL_CORE_APP: { main: 'framework' } } }, async (s, sys) => {
    for (const [tool, name, why] of [
      ['system_write_class', 'z2ui5_cl_core_app', /Z2UI5_\*, the namespace of the abap2UI5 framework itself/],
      ['system_write_class', 'cl_abap_typedescr', /never writes an SAP-owned object/],
      ['system_write_class', '/sap/cl_thing', /a namespace SAP delivers objects in/],
      ['system_write_class', 'zcl_other_team', /does not match the allowed names \/\^ZCL_MCP_\/i/],
      ['system_activate', 'z2ui5_cl_core_app', /framework itself/],
      ['system_unit_tests', 'cl_abap_typedescr', /SAP-owned/],
    ]) {
      const res = await s.call(tool, { class_name: name, ...(tool === 'system_write_class' ? { source: SOURCE(name), package: '$TMP', overwrite: true } : {}) });
      assert.ok(res.isError, `${tool} ${name}`);
      assert.match(res.text, why);
    }
    assert.equal(sys.log.length, 0, 'not one request reached the system');
    assert.equal(sys.adt.classes.get('Z2UI5_CL_CORE_APP').main, 'framework');
    // a name inside the pattern is written
    assert.ok(!(await s.call('system_write_class', { class_name: 'zcl_mcp_ok', source: SOURCE('zcl_mcp_ok'), description: 'ok', package: '$TMP' })).isError);
  }, { A2UI5_MCP_SYSTEM_WRITE_ALLOW: '^ZCL_MCP_' });
});

test('a lock held by someone else: refused with the system\'s words, nothing written', async () => {
  await withSystem({ classes: { ZCL_MCP_DEMO: { main: 'CLASS zcl_mcp_demo DEFINITION.', lockedBy: 'OTHERUSER' } } }, async (s, sys) => {
    const res = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), package: '$TMP' });
    assert.ok(res.isError);
    assert.match(res.json.refused, /ZCL_MCP_DEMO could not be locked - User OTHERUSER is currently editing ZCL_MCP_DEMO\. Nothing was written\./);
    assert.equal(res.json.created, false);
    assert.equal(sys.adt.classes.get('ZCL_MCP_DEMO').main, 'CLASS zcl_mcp_demo DEFINITION.');
    assert.ok(!adtLog(sys).some((l) => l.startsWith('PUT')), 'no write was tried');
  });
});

test('unlock after a failure: a write the system refuses still gives the lock back, and the answer says what was written', async () => {
  await withSystem({ failPut: 'testclasses', classes: { ZCL_MCP_DEMO: { main: 'old', testclasses: 'old tests' } } }, async (s, sys) => {
    const res = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), testclasses: TESTS(), package: '$TMP' });
    assert.ok(res.isError);
    assert.match(res.json.failed, /writing zcl_mcp_demo\.clas\.testclasses\.abap failed - The testclasses include of ZCL_MCP_DEMO could not be saved/);
    assert.match(res.json.failed, /zcl_mcp_demo\.clas\.abap had been written before that and is on the system, inactive/);
    assert.deepEqual(res.json.written, ['zcl_mcp_demo.clas.abap']);
    assert.equal(res.json.unlocked, true);
    assert.equal(sys.adt.locks.size, 0, 'the lock was given back');
    const log = adtLog(sys);
    assert.ok(log.indexOf('POST oo/classes/zcl_mcp_demo UNLOCK') > log.indexOf('PUT oo/classes/zcl_mcp_demo/includes/testclasses'), 'the unlock follows the failed write');
    assert.equal(sys.adt.classes.get('ZCL_MCP_DEMO').testclasses, 'old tests');
  });
});

test('an existing class somebody else changed last is refused unless overwrite: true - and so is one in another package', async () => {
  const classes = {
    ZCL_THEIRS: { main: 'theirs', changedBy: 'COLLEAGUE', changedAt: '2026-11-20T08:00:00Z' },
    ZCL_UNKNOWN: { main: 'whose', changedBy: '' },
    ZCL_ELSEWHERE: { main: 'there', package: 'ZOTHER_PKG', corrNr: 'A4HK900001' },
  };
  await withSystem({ classes }, async (s, sys) => {
    const theirs = await s.call('system_write_class', { class_name: 'zcl_theirs', source: SOURCE('zcl_theirs'), package: '$TMP' });
    assert.ok(theirs.isError);
    assert.match(theirs.json.refused, /ZCL_THEIRS exists on .* and was last changed by COLLEAGUE \(2026-11-20T08:00:00Z\), not by DEVELOPER.*`overwrite: true` only when they said so\. Nothing was written\./);
    assert.equal(theirs.json.changedBy, 'COLLEAGUE');
    const unknown = await s.call('system_write_class', { class_name: 'zcl_unknown', source: SOURCE('zcl_unknown'), package: '$TMP' });
    assert.match(unknown.json.refused, /does not say who changed it last/);
    const elsewhere = await s.call('system_write_class', { class_name: 'zcl_elsewhere', source: SOURCE('zcl_elsewhere'), package: '$TMP' });
    assert.match(elsewhere.json.refused, /exists on .* in the package ZOTHER_PKG, not in \$TMP.*does not move a class/);
    assert.ok(!adtLog(sys).some((l) => !l.startsWith('GET')), 'three refusals, three reads, no lock');
    assert.equal(sys.adt.classes.get('ZCL_THEIRS').main, 'theirs');

    const forced = await s.call('system_write_class', { class_name: 'zcl_theirs', source: SOURCE('zcl_theirs'), package: '$TMP', overwrite: true });
    assert.ok(!forced.isError, forced.text);
    assert.deepEqual(forced.json.written, ['zcl_theirs.clas.abap']);
    assert.equal(sys.adt.classes.get('ZCL_THEIRS').main, SOURCE('zcl_theirs'));
    assert.equal(sys.adt.classes.get('ZCL_THEIRS').changedBy, USER);
    // overwrite must be a boolean: "true" is refused by the argument check, not taken for false or true
    const stringly = await s.call('system_write_class', { class_name: 'zcl_unknown', source: SOURCE('zcl_unknown'), package: '$TMP', overwrite: 'true' });
    assert.ok(stringly.isError);
    assert.match(stringly.text, /overwrite must be a boolean/);
    assert.equal(sys.adt.classes.get('ZCL_UNKNOWN').main, 'whose');
  });
});

test('the transport request is the caller\'s: required off $TMP, sent as given, and never another one than the object sits in', async () => {
  const classes = { ZCL_IN_REQUEST: { main: 'old', package: 'ZPKG', corrNr: 'A4HK900123' } };
  await withSystem({ classes }, async (s, sys) => {
    // a transportable package without a request: refused before anything is sent
    const none = await s.call('system_write_class', { class_name: 'zcl_new', source: SOURCE('zcl_new'), description: 'New', package: 'ZPKG' });
    assert.ok(none.isError);
    assert.match(none.json.refused, /ZPKG is transportable, so `transport` is required/);
    assert.equal(sys.log.length, 0);

    // create with the request the user named: on the create and on every write
    const created = await s.call('system_write_class', { class_name: 'zcl_new', source: SOURCE('zcl_new'), description: 'New', package: 'zpkg', transport: 'a4hk900200' });
    assert.ok(!created.isError, created.text);
    assert.equal(created.json.transport, 'A4HK900200');
    assert.equal(created.json.created, true);
    const corr = (method, tail) => sys.log.filter((r) => r.method === method && r.path.endsWith(tail)).map((r) => new URLSearchParams(r.search).get('corrNr'));
    assert.deepEqual(corr('POST', '/oo/classes'), ['A4HK900200']);
    assert.deepEqual(corr('PUT', '/zcl_new/source/main'), ['A4HK900200']);
    assert.equal(sys.adt.classes.get('ZCL_NEW').corrNr, 'A4HK900200');

    // an object that already sits in a request: another one is refused naming it - after the lock, so the lock is given back
    const other = await s.call('system_write_class', { class_name: 'zcl_in_request', source: SOURCE('zcl_in_request'), package: 'ZPKG', transport: 'A4HK900999' });
    assert.ok(other.isError);
    assert.match(other.json.refused, /ZCL_IN_REQUEST is already in the transport request A4HK900123, not in A4HK900999.*never picks a request by itself.*nothing was written/);
    assert.equal(other.json.inRequest, 'A4HK900123');
    assert.equal(other.json.unlocked, true);
    assert.equal(sys.adt.locks.size, 0);
    assert.equal(sys.adt.classes.get('ZCL_IN_REQUEST').main, 'old');

    const same = await s.call('system_write_class', { class_name: 'zcl_in_request', source: SOURCE('zcl_in_request'), package: 'ZPKG', transport: 'A4HK900123' });
    assert.ok(!same.isError, same.text);
    assert.deepEqual(corr('PUT', '/zcl_in_request/source/main'), ['A4HK900123']);

    // a request given for a local object is not used, and the answer says so
    const local = await s.call('system_write_class', { class_name: 'zcl_local', source: SOURCE('zcl_local'), description: 'Local', package: '$TMP', transport: 'A4HK900200' });
    assert.ok(!local.isError, local.text);
    assert.equal(local.json.transport, undefined);
    assert.match(local.json.transportNotUsed, /\$TMP is a local package - the request A4HK900200 was not used/);
    assert.deepEqual(corr('PUT', '/zcl_local/source/main'), [null]);
  });
});

test('a new class needs a description, and a wrong password is sent once - the breaker holds for the write tools too', async () => {
  await withSystem({}, async (s, sys) => {
    const res = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), package: '$TMP' });
    assert.ok(res.isError);
    assert.match(res.json.refused, /does not exist on .* and has no description/);
    assert.equal(sys.adt.classes.size, 0);
  });
  await withSystem({}, async (s, sys) => {
    const first = await s.call('system_write_class', { class_name: 'zcl_mcp_demo', source: SOURCE(), description: 'd', package: '$TMP' });
    assert.ok(first.isError);
    assert.match(first.text, /rejected the logon of user DEVELOPER/);
    const second = await s.call('system_activate', { class_name: 'zcl_mcp_demo' });
    assert.match(second.text, /rejected the logon of DEVELOPER once already/);
    assert.equal(sys.log.length, 1, 'exactly one request reached the system');
  }, { A2UI5_MCP_SYSTEM_PASSWORD: 'wrong' });
});

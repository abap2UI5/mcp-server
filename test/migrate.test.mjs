// migrate_report: a classic report converted by report2cloud, which lives in
// the abap-cloud-gui checkout (lib/migrate.mjs). The pure halves run
// everywhere; the conversion needs the checkout with `npm ci` done
// (ABAP_CLOUD_GUI_HOME or ../abap-cloud-gui) and SKIPS itself without one, the
// way the smoke test skips without samples-controls - CI has no such
// checkout. The missing-checkout message is pinned in
// test/missing-siblings.test.mjs.
//
// The deploy test (deploy: true) also needs the popups (POPUPS_HOME, or
// .deps/popups / build/popups of the checkout, or ../popups) and the network
// of test/npm-integration.test.mjs - it builds on the published
// @abap2ui5/node-runtime in a workspace of its own - and runs only under
// A2UI5_MCP_NETWORK_TESTS=1 (skipping with A2UI5_MCP_SKIP_NETWORK_TESTS=1)
// like that test does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { programNameOf, validTargetClass, resolvePopups, loadReport2cloud, migrateReport, deployFiles, POPUP_FILES, transpilerHazards, codeOfLine, KernelEscapeError } from '../lib/migrate.mjs';
import { resolveCloudGui } from '../lib/repos.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'report2cloud');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

const cloudGui = resolveCloudGui();
let noConverter = cloudGui ? false : 'no abap-cloud-gui checkout (ABAP_CLOUD_GUI_HOME or ../abap-cloud-gui)';
if (!noConverter) {
  try {
    await loadReport2cloud(cloudGui);
  } catch (e) {
    noConverter = e.message;
  }
}

test('programNameOf: the name of REPORT / PROGRAM, comment lines before it skipped', () => {
  assert.equal(programNameOf('*& Report ZX\n*&---\nREPORT zflights MESSAGE-ID zr.\n'), 'zflights');
  assert.equal(programNameOf('  program  /abc/rep.'), '/abc/rep');
  assert.equal(programNameOf('WRITE / 1.'), null);
});

test('validTargetClass: an ABAP class name of at most 30 characters', () => {
  assert.ok(validTargetClass('zcl_flights'));
  assert.ok(validTargetClass('/abc/cl_x'));
  for (const bad of ['', 'zcl-x', '../zcl_x', 'z'.repeat(31), 42, null]) assert.equal(validTargetClass(bad), false, String(bad));
});

test('resolvePopups: POPUPS_HOME is authoritative, else .deps/popups of the checkout', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-migrate-'));
  try {
    const gui = path.join(base, 'abap-cloud-gui');
    const popups = path.join(gui, '.deps', 'popups');
    fs.mkdirSync(path.join(popups, 'src'), { recursive: true });
    fs.writeFileSync(path.join(popups, 'src', 'z2ui5_cl_popup_to_select.clas.abap'), '');
    assert.equal(resolvePopups(gui, {}), popups);
    assert.equal(resolvePopups(gui, { POPUPS_HOME: path.join(base, 'nowhere') }), null, 'a set POPUPS_HOME that points nowhere is not guessed around');
    assert.equal(resolvePopups(null, {}), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deployFiles: the class, src/01 (its tables and data elements too) and the popups it calls - every file of each object, test includes left out', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-migrate-'));
  try {
    const gui = path.join(base, 'gui');
    const popups = path.join(base, 'popups');
    const put = (f, t = '') => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
    };
    put(path.join(gui, 'src', '01', 'z2ui5_cl_cgui_report.clas.abap'));
    put(path.join(gui, 'src', '01', 'z2ui5_cl_cgui_report.clas.xml'));
    put(path.join(gui, 'src', '01', 'z2ui5_cl_cgui_list.clas.testclasses.abap'));
    put(path.join(gui, 'src', '01', 'package.devc.xml'));
    put(path.join(gui, 'src', '01', 'z2ui5_cgui_var.tabl.xml'));
    put(path.join(gui, 'src', '01', 'z2ui5_cgui_var_name.dtel.xml'));
    put(path.join(popups, 'src', '00', 'z2ui5_cl_popup_context.clas.abap'));
    for (const p of POPUP_FILES.slice(1)) put(path.join(popups, p));
    put(path.join(popups, 'src', 'z2ui5_cl_popup_file_dl.clas.abap'));
    const box = path.join(base, 'box');
    const gate = (n) => {
      if (!/^[zy]/.test(n)) throw new Error(`invalid class name '${n}'`);
      return n;
    };
    const { support } = deployFiles({ files: { 'zcl_x.clas.abap': 'X', 'zcl_x.clas.xml': 'Y' }, dir: box, cloudGui: gui, popups, classNameOf: gate });
    assert.deepEqual(fs.readdirSync(box).sort(), [
      'z2ui5_cgui_var.tabl.xml', 'z2ui5_cgui_var_name.dtel.xml', 'z2ui5_cl_cgui_report.clas.abap', 'z2ui5_cl_cgui_report.clas.xml', 'z2ui5_cl_popup_context.clas.abap',
      'z2ui5_cl_popup_get_range.clas.abap', 'z2ui5_cl_popup_input_val.clas.abap', 'z2ui5_cl_popup_to_confirm.clas.abap',
      'z2ui5_cl_popup_to_select.clas.abap', 'zcl_x.clas.abap', 'zcl_x.clas.xml',
    ]);
    assert.ok(support.includes('z2ui5_cgui_var'), 'the variant store\'s table goes along');
    assert.ok(support.includes('z2ui5_cl_cgui_report'));
    assert.throws(() => deployFiles({ files: { 'bad.clas.abap': '' }, dir: box, cloudGui: gui, popups, classNameOf: gate }), /invalid class name/);
    // a refused name refuses the deploy before any file is written
    const fresh = path.join(base, 'fresh');
    assert.throws(() => deployFiles({ files: { '#abc#cl_x.clas.abap': '' }, dir: fresh, cloudGui: gui, popups, classNameOf: gate }), /invalid class name/);
    assert.equal(fs.existsSync(fresh), false, 'the support classes were copied in before the class name was refused');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('migrateReport: a report becomes a z2ui5_cl_cgui_report class with selection_screen and start_of_selection', { skip: noConverter }, async () => {
  const r = await migrateReport({ source: read('zmcp_r2c_hello.prog.abap'), textsXml: read('zmcp_r2c_hello.prog.xml') });
  assert.equal(r.ok, true);
  assert.equal(r.className, 'zcl_mcp_r2c_hello');
  assert.equal(r.program, 'zmcp_r2c_hello');
  assert.deepEqual(Object.keys(r.files).sort(), ['zcl_mcp_r2c_hello.clas.abap', 'zcl_mcp_r2c_hello.clas.xml']);
  const abap = r.files['zcl_mcp_r2c_hello.clas.abap'];
  assert.match(abap, /CLASS zcl_mcp_r2c_hello DEFINITION PUBLIC\n {2}INHERITING FROM z2ui5_cl_cgui_report/);
  assert.match(abap, /METHOD selection_screen\.[\s\S]*screen->parameter\( val {8}= p_name\n {23}text {7}= `Your name`\n {23}obligatory = abap_true/);
  assert.match(abap, /METHOD start_of_selection\.[\s\S]*list\( \)->new_line\(/);
  assert.match(abap, /set_title\( `Hello from migrate_report` \)\./, 'the title of the text pool');
  assert.match(r.report, /^# report2cloud: ZMCP_R2C_HELLO/);
  assert.deepEqual(r.refusals, []);
  // the class name is the caller's
  const named = await migrateReport({ source: read('zmcp_r2c_hello.prog.abap'), className: 'zcl_hello' });
  assert.ok(named.files['zcl_hello.clas.abap']);
});

test('migrateReport: a refused report - file:row:col and the reason, no class unless partial', { skip: noConverter }, async () => {
  const r = await migrateReport({ source: read('zmcp_r2c_refused.prog.abap') });
  assert.equal(r.ok, false);
  assert.deepEqual(r.files, {});
  assert.deepEqual(r.refusals.map((x) => x.at), ['zmcp_r2c_refused.prog.abap:4:3', 'zmcp_r2c_refused.prog.abap:5:3']);
  assert.match(r.refusals[0].message, /^CALL SCREEN/);
  assert.match(r.refusals[1].message, /^SUBMIT/);
  assert.match(r.report, /refused/i);
  const partial = await migrateReport({ source: read('zmcp_r2c_refused.prog.abap'), partial: true });
  assert.match(partial.draft['zcl_mcp_r2c_refused.clas.abap'], /report2cloud refused \(line 4\)/);
});

/* open-abap's @KERNEL escape: on SAP `WRITE '@KERNEL x'.` writes text, the
 * transpiler copies x into the module as JavaScript. Comments are no code. */
test('transpilerHazards: @KERNEL literals outside comments, any case and blank; dynamic LOOP WHERE', () => {
  assert.equal(codeOfLine(`  WRITE 'a"b'. " '@KERNEL x'`), `  WRITE 'a"b'. `);
  assert.equal(codeOfLine(`* WRITE '@KERNEL x'.`), '');
  assert.equal(codeOfLine('  x = |say "hi" { a }|. " c'), '  x = |say "hi" { a }|. ');
  const h = transpilerHazards([
    'REPORT z.',
    "* WRITE '@KERNEL commented'.",
    "  WRITE 'x'. \" WRITE '@KERNEL trailing comment'",
    '  WRITE:',
    "   '@kernel\tprocess.exit(1);'.",
    "  WRITE '@KERNELISH'.",
    '  LOOP AT lt INTO ls',
    '    WHERE (lv_cond).',
    '  ENDLOOP.',
    '  LOOP AT lt INTO ls WHERE a = b.',
    '  ENDLOOP.',
  ].join('\n'));
  assert.deepEqual(h.kernel.map((k) => [k.row, k.col]), [[5, 4]], 'the live one only - not a comment, not @KERNELISH');
  assert.deepEqual(h.dynamicWhere.map((k) => k.row), [7], 'the dynamic WHERE, not the static one');
});

test('migrateReport refuses a report with the @KERNEL escape - before report2cloud runs, nothing converted', async () => {
  const src = "REPORT zk.\nSTART-OF-SELECTION.\n  WRITE '@KERNEL require(\"child_process\").execSync(\"id\");'.\n";
  // no checkout needed: the refusal comes first (dir points nowhere)
  await assert.rejects(migrateReport({ source: src, dir: path.join(ROOT, 'test', 'does-not-exist') }), (e) => {
    assert.ok(e instanceof KernelEscapeError, e.message);
    assert.match(e.message, /zk\.prog\.abap:3:9/);
    assert.match(e.message, /JavaScript/);
    assert.match(e.message, /Nothing was converted or written/);
    return true;
  });
});

/* The output side: whatever a converter assembles, no escape leaves the tool.
 * A stand-in report2cloud that writes one into its draft. */
test('migrateReport refuses converter output that carries the escape', async () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-fake-r2c-'));
  try {
    const lib = path.join(fake, 'tools', 'report2cloud', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'convert.mjs'), `export function convert() {
  return { ok: false, className: 'zcl_k', programName: 'zk', files: {}, refusals: [], todos: [], release: [], notes: [],
    draft: { 'zcl_k.clas.locals_imp.abap': "CLASS lcl IMPLEMENTATION.\\n  METHOD m.\\n    WRITE '@KERNEL x();'.\\n  ENDMETHOD.\\nENDCLASS.\\n" } };
}`);
    fs.writeFileSync(path.join(lib, 'textpool.mjs'), 'export function parseTextpool() { return {}; }');
    fs.writeFileSync(path.join(lib, 'report.mjs'), "export function migrationReport() { return ''; }");
    await assert.rejects(migrateReport({ source: 'REPORT zk.\n', partial: true, dir: fake }),
      /report2cloud's output contains open-abap's @KERNEL escape - zcl_k\.clas\.locals_imp\.abap:3:11/);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('migrateReport: a dynamic LOOP WHERE is converted and flagged as code injection', { skip: noConverter }, async () => {
  const src = 'REPORT zk.\nDATA lt TYPE string_table.\nDATA lv TYPE string.\nPARAMETERS p TYPE string.\nSTART-OF-SELECTION.\n  LOOP AT lt INTO lv WHERE (p).\n  ENDLOOP.\n';
  const r = await migrateReport({ source: src });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].at, /zk\.prog\.abap:6:3/);
  assert.match(r.warnings[0].message, /evaluated as JavaScript/);
});

/* report2cloud copies a refused statement into the partial draft as it is:
 * the one path where the escape survived conversion verbatim. */
test('migrateReport partial: a refused local-class WRITE with the escape never reaches the draft', { skip: noConverter }, async () => {
  const src = "REPORT zk.\nCLASS lcl DEFINITION.\n  PUBLIC SECTION.\n    CLASS-METHODS m.\nENDCLASS.\nCLASS lcl IMPLEMENTATION.\n  METHOD m.\n"
    + "    WRITE '@KERNEL console.log(3);'.\n  ENDMETHOD.\nENDCLASS.\nSTART-OF-SELECTION.\n  lcl=>m( ).\n";
  await assert.rejects(migrateReport({ source: src, partial: true }), KernelEscapeError);
});

/** A minimal MCP client over the server's stdio. */
function stdioServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (waiting.has(m.id)) {
          waiting.get(m.id)(m);
          waiting.delete(m.id);
        }
      } catch {
        /* a log line */
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, call, close: () => p.kill() };
}

test('the migrate_report tool over stdio: the class, the migration report, the refusals', { skip: noConverter, timeout: 60_000 }, async () => {
  const srv = stdioServer({ ...process.env, A2UI5_MCP_REMOTE: '0' });
  try {
    await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'migrate', version: '0' } });
    const ok = await srv.call('migrate_report', { source: read('zmcp_r2c_hello.prog.abap'), texts_xml: read('zmcp_r2c_hello.prog.xml'), class_name: 'zcl_mcp_hello' });
    assert.ok(!ok.isError, ok.content[0].text);
    const a = JSON.parse(ok.content[0].text);
    assert.equal(a.ok, true);
    assert.equal(a.class_name, 'zcl_mcp_hello');
    assert.match(a.files['zcl_mcp_hello.clas.abap'], /METHOD selection_screen\./);
    assert.match(a.files['zcl_mcp_hello.clas.abap'], /METHOD start_of_selection\./);
    assert.match(a.migration_report, /## Mapped/);
    assert.deepEqual(a.refusals, []);

    const refused = JSON.parse((await srv.call('migrate_report', { source: read('zmcp_r2c_refused.prog.abap') })).content[0].text);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.files, {});
    assert.equal(refused.refusals.length, 2);
    assert.match(refused.next, /refusal/);

    const bad = await srv.call('migrate_report', { source: read('zmcp_r2c_hello.prog.abap'), class_name: 'zcl-bad' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /no ABAP class name/);
    const empty = await srv.call('migrate_report', { source: '  ' });
    assert.equal(empty.isError, true);

    // open-abap's code escape: refused with the place and the reason, deploy or not
    const kernel = await srv.call('migrate_report', { source: "REPORT zk.\nSTART-OF-SELECTION.\n  WRITE '@KERNEL x();'.\n", deploy: true });
    assert.equal(kernel.isError, true);
    assert.match(kernel.content[0].text, /^refusing to convert: the report contains open-abap's @KERNEL escape - zk\.prog\.abap:3:9/);
  } finally {
    srv.close();
  }
});

function reachable() {
  if (process.env.A2UI5_MCP_SKIP_NETWORK_TESTS) return 'A2UI5_MCP_SKIP_NETWORK_TESTS is set';
  // opt-in: the registry loop is 20 s and more per test, and a local `npm test` is the sibling-free suite (ci.yml sets it)
  if (!process.env.A2UI5_MCP_NETWORK_TESTS) return 'A2UI5_MCP_NETWORK_TESTS is not set';
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', '@abap2ui5/node-runtime', 'version', '--json'], {
    encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32',
  });
  if (npm.status !== 0) return 'the npm registry cannot be reached';
  const git = spawnSync('git', ['ls-remote', 'https://github.com/open-abap/open-abap-core', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  if (git.status !== 0) return 'GitHub cannot be reached with git';
  return null;
}

const deploySkip = noConverter || (!resolvePopups(cloudGui) && 'no popups checkout (POPUPS_HOME, .deps/popups or build/popups of abap-cloud-gui, ../popups)') || reachable() || false;

test('migrate_report deploy: true - the class runs on @abap2ui5/node-runtime and answers its selection screen', { skip: deploySkip, timeout: 15 * 60_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-migrate-it-'));
  const env = {
    ...process.env,
    A2UI5_MCP_PORT: '4461',
    A2UI5_MCP_BACKEND: 'npm',
    A2UI5_MCP_WORKSPACE: path.join(base, 'workspace'),
    SAMPLES_CONTROLS_HOME: path.join(base, 'no-corpus'),
    A2UI5_MCP_REMOTE: '0',
  };
  delete env.AI_DEMOKIT_HOME;
  const srv = stdioServer(env);
  try {
    await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'migrate-it', version: '0' } });
    const r = await srv.call('migrate_report', { source: read('zmcp_r2c_hello.prog.abap'), texts_xml: read('zmcp_r2c_hello.prog.xml'), deploy: true });
    assert.ok(!r.isError, r.content[0].text);
    const a = JSON.parse(r.content[0].text);
    assert.equal(a.deploy.ok, true, JSON.stringify(a.deploy, null, 2).slice(0, 4000));
    assert.ok(a.deploy.stages.deploy.with.includes('z2ui5_cl_cgui_report'));
    assert.equal(a.deploy.stages.build.built, true);
    const snap = a.deploy.stages.start;
    assert.equal(snap.app, 'ZCL_MCP_R2C_HELLO');
    assert.equal(snap.title, 'Hello from migrate_report');
    assert.deepEqual(snap.fields.map((f) => `${f.name}:${f.label}${f.required ? '*' : ''}`), ['P_NAME:Your name*', 'P_TIMES:Lines']);
    assert.ok(snap.actions.some((x) => x.event === 'CGUI_EXECUTE'));
    // and it runs: Execute through app_act
    const done = JSON.parse((await srv.call('app_act', { session: snap.session, values: { P_NAME: 'MCP' }, event: 'CGUI_EXECUTE' })).content[0].text);
    assert.deepEqual(done.texts, ['Hello', 'MCP', 'Line', '1', '2']);
  } finally {
    srv.close();
    await new Promise((res) => setTimeout(res, 500));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The protocol client behind app_start / app_describe / app_act
// (lib/appclient.mjs), sibling-free: the recorded sample sessions of
// test/fixtures/agent are REPLAYED through a fake fetch that insists on
// receiving exactly the request the real run sent - so the bodies this client
// builds (draft id, event, arguments, the model delta) are pinned against
// what @abap2ui5/node-runtime accepted, and every validation path is checked
// to send nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppClient, buildDelta, errorText, AgentError } from '../lib/appclient.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
const BASE = 'http://127.0.0.1:4471/';

/** A fetch that answers the fixture's exchanges in order and fails the test
 *  on any request that differs from the recorded one. */
function replay(name) {
  const exchanges = fixture(name).steps.filter((s) => s.exchange).map((s) => s.exchange);
  const sent = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, BASE);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body).value;
    sent.push(body);
    const next = exchanges[sent.length - 1];
    assert.ok(next, `request ${sent.length} was not in the recording: ${JSON.stringify(body)}`);
    assert.deepEqual(body, next.request, `request ${sent.length} differs from the recorded one`);
    return new Response(JSON.stringify(next.response), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, sent, exchanges };
}

/** Replays a whole fixture through the client: every step's request must
 *  match, and the snapshots come back. */
async function run(name, opts = {}) {
  const r = replay(name);
  const client = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl, ...opts });
  const snaps = [];
  let snap = null;
  for (const step of fixture(name).steps) {
    snap = step.op === 'start' ? await client.start(step.arg) : await client.act(snap.session, step.arg);
    snaps.push(snap);
  }
  assert.equal(r.sent.length, r.exchanges.length, 'every recorded request was sent');
  return { client, snaps, sent: r.sent };
}

const rejects = (p, re) => assert.rejects(p, (e) => e instanceof AgentError && re.test(e.message));

// ------------------------------------------------------------ buildDelta ----

test('buildDelta builds the delta the frontend builds (core/Lib.js buildDeltaFromPaths)', () => {
  const data = { NAME: 'x', S: { A: 1, B: 2 }, T: [{ Q: 1, SUB: [{ Z: 9 }] }, { Q: 2 }] };
  assert.deepEqual(buildDelta(['/NAME'], data), { NAME: 'x' });
  assert.deepEqual(buildDelta(['/S/B'], data), { S: { A: 1, B: 2 } }, 'a structure field ships the whole attribute');
  assert.deepEqual(buildDelta(['/T/1/Q', '/T/0/Q'], data), { T: { __delta: { 1: { Q: 2 }, 0: { Q: 1 } } } });
  assert.deepEqual(buildDelta(['/T/0/SUB/0/Z'], data), { T: { __delta: { 0: { SUB: { __delta: { 0: { Z: 9 } } } } } } });
  assert.deepEqual(buildDelta(['/T', '/T/0/Q'], data), { T: data.T }, 'a whole table wins over a cell');
});

test('errorText reads the backend\'s 500 page', () => {
  const t = errorText(500, '<html><body><pre>Error: boom<br> &nbsp; at x &lt;y&gt;</pre></body></html>');
  assert.equal(t, 'HTTP 500: Error: boom\n   at x <y>');
  assert.equal(errorText(502, ''), 'HTTP 502');
});

// ---------------------------------------------- replay of real sessions ----

test('form (samples 381): values go out as the model delta of the SHOW roundtrip, the typed values stay on screen', async () => {
  const { snaps, sent } = await run('form-381');
  assert.deepEqual(sent[1].MODEL, { MESSAGE: 'hello agent', DOCK_TO_ANCHOR: true, MY: 'left top' });
  assert.equal(sent[1].S_FRONT.EVENT, 'SHOW');
  assert.equal(snaps[1].fields[0].value, 'hello agent', 'the client keeps what it sent, as the browser model does');
  assert.equal(snaps[1].fields.find((f) => f.path === '/MY').value, 'left top');
  assert.equal(sent[2].MODEL, undefined, 'nothing pending, no MODEL');
});

test('table (samples 011): cell edits and the row selection travel as one __delta', async () => {
  const { snaps, sent } = await run('table-011');
  assert.deepEqual(sent[2].MODEL, { T_TAB: { __delta: { 0: { TITLE: 'changed' }, 1: { SELKZ: true } } } });
  assert.equal(snaps[2].tables[0].rowCount, 5);
});

test('popup flow (samples 009): the popup\'s own model is the one its event carries', async () => {
  const { snaps, sent } = await run('popup-009');
  assert.deepEqual(sent[1].MODEL, { S_SCREEN: { COLOR_01: '', COLOR_02: '', LASTNAME: '', NAME: 'Smith', QUANTITY: '3' } });
  assert.deepEqual(sent[2].MODEL, { T_SUGGESTION_SEL: { __delta: { 2: { SELKZ: true } } } });
  assert.equal(snaps[1].layer, 'popup');
  assert.equal(snaps[2].fields.find((f) => f.path === '/S_SCREEN/COLOR_02').value, 'BLACK');
});

test('popup closed in the browser (samples 012): @CLOSE_POPUP sends nothing, the draft id stays', async () => {
  const { snaps, sent } = await run('popup-012');
  assert.equal(sent.length, 4, 'start, BUTTON_POPUP_03, BUTTON_POPUP_06, POPUP_DECIDE_CONTINUE - the close is local');
  assert.equal(snaps[2].layer, 'main');
  assert.equal(snaps[2].session, snaps[1].session);
  assert.equal(snaps[3].app, 'Z2UI5_CL_SMP_APP_020');
  assert.equal(snaps[4].app, 'Z2UI5_CL_SMP_APP_012');
});

test('row actions: $row arguments read the row, explicit args fill what the browser computes', async () => {
  const list = await run('list-048');
  assert.deepEqual(list.sent[1].S_FRONT.T_EVENT_ARG, ['entry_03', 'this is a description3 1234567890 1234567890', 'sap-icon://employee', 'Warning', 'Warning', false]);
  const args = await run('args-537');
  assert.deepEqual(args.sent[1].S_FRONT.T_EVENT_ARG, ['Flat Basic', 120, false, 'Wed Aug 05 2026']);
  const grid = await run('grid-070');
  assert.deepEqual(grid.sent[1].S_FRONT, { ID: grid.sent[1].S_FRONT.ID, EVENT: 'ROW_ACTION_ITEM_EDIT', T_EVENT_ARG: ['4'] }, 'the action addressed by its id');
});

test('nested views and popovers replay as recorded', async () => {
  await run('nested-065');
  await run('popover-026');
  await run('messages-467');
  await run('box-382');
  await run('messages-452');
  await run('cgui-popover-07');
});

test('SelectDialog (samples-controls 623): confirm with `row` sends the picked item\'s title, search takes its value in args', async () => {
  const { snaps, sent } = await run('select-623');
  assert.deepEqual(sent[2].S_FRONT.T_EVENT_ARG, ['17']);
  assert.deepEqual(sent[3].S_FRONT, { ID: sent[3].S_FRONT.ID, EVENT: 'VH_CONFIRM', T_EVENT_ARG: ['Notebook Basic 17'] }, '${$parameters>/selectedItem}.getTitle() of row 0');
  assert.equal(sent[3].MODEL, undefined, 'no selection binding: nothing to send but the event');
  assert.equal(snaps[3].fields[0].value, 'Notebook Basic 17');
});

test('TableSelectDialog (abap-cloud-gui F4): the pick selects ZZSELKZ, and selectedContexts[0]/sPath is null as in the browser', async () => {
  const { snaps, sent } = await run('cgui-f4-06');
  assert.deepEqual(sent[3].S_FRONT.T_EVENT_ARG, ['Ber', false]);
  // a JSONModel path has no [n] syntax: UI5 reads undefined there, JSON sends null
  assert.deepEqual(sent[4].S_FRONT.T_EVENT_ARG, [null]);
  // the '*' segment of a data reference is no row: the frontend ships the whole attribute
  assert.deepEqual(sent[4].MODEL, { MR_TAB_POPUP: { '*': [{ NAME: 'Berlin', WERKS: '3000', ZZSELKZ: true }] } });
  assert.equal(snaps[4].fields.find((f) => f.name === 'P_PLANT').value, '3000');
});

// ------------------------------------------------------------ validation ----

async function started(name) {
  const r = replay(name);
  const client = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl });
  const snap = await client.start(fixture(name).steps[0].arg);
  return { client, snap, sent: r.sent };
}

test('refusals name what is allowed, and nothing goes over the wire', async () => {
  const { client, snap, sent } = await started('popup-009');
  const s = snap.session;
  await rejects(client.act(s, { event: 'NOPE' }), /no action 'NOPE' on this screen - allowed events: POPUP_TABLE_VALUE \(a1 /);
  await rejects(client.act(s, { values: { NOPE: 1 } }), /no field 'NOPE' on this screen - fields you can fill: f1 \(Input with suggestion items, \/S_SCREEN\/COLOR_01\)/);
  await rejects(client.act(s, { values: 'x' }), /`values` is an object/);
  await rejects(client.act(s, { row: 1 }), /`row` belongs to an event/);
  await rejects(client.act(s, { event: 'BUTTON_SEND', args: ['x'] }), /takes 0 argument/);
  assert.equal(sent.length, 1, 'only the start');
  const desc = client.describe(s);
  assert.equal(desc.pending, undefined, 'a refused act left nothing pending');
});

test('values without an event stay pending, and go out with the next event', async () => {
  const { client, snap, sent } = await started('popup-009');
  const p = await client.act(snap.session, { values: { 'S_SCREEN-NAME': 'Smith', '/S_SCREEN/QUANTITY': 3 } });
  assert.deepEqual(p.pending, ['/S_SCREEN/NAME', '/S_SCREEN/QUANTITY']);
  assert.equal(p.session, snap.session, 'no roundtrip, no new draft');
  assert.equal(p.fields.find((f) => f.id === 'f2').value, '3', 'a number for a string attribute stays a string');
  assert.equal(sent.length, 1);
  assert.deepEqual(client.describe(snap.session).pending, ['/S_SCREEN/NAME', '/S_SCREEN/QUANTITY']);
  // the next event carries them: the recorded request had exactly these two
  const next = await client.act(snap.session, { event: 'POPUP_TABLE_VALUE' });
  assert.equal(next.layer, 'popup');
  assert.equal(sent.length, 2);
  assert.equal(next.pending, undefined);
});

test('choices, booleans, non-editable fields and table cells are checked against the snapshot', async () => {
  const form = await started('form-381');
  const s = form.snap.session;
  await rejects(form.client.act(s, { values: { f4: 'nowhere' } }), /field f4 \(my\): 'nowhere' is not one of its values - allowed keys: 'begin top'/);
  await rejects(form.client.act(s, { values: { f6: 'maybe' } }), /is a boolean - pass true or false/);
  assert.equal((await form.client.act(s, { values: { f6: 'true' } })).fields[5].value, true, '"true" is accepted for a boolean');
  const table = await started('table-011');
  const t = table.snap.session;
  await rejects(table.client.act(t, { values: { '/T_TAB/0/TITLE': 'x' } }), /column TITLE of table t1 is not editable - editable columns: SELKZ/);
  await rejects(table.client.act(t, { values: { 't1/9/SELKZ': true } }), /table t1 has 6 row\(s\) - row 9 does not exist/);
  const ok = await table.client.act(t, { values: { 't1/2/SELKZ': true } });
  assert.deepEqual(ok.pending, ['/T_TAB/2/SELKZ']);
  assert.equal(ok.tables[0].rows[2].SELKZ, true);
});

test('a row action without a row says which rows exist; a disabled action is refused', async () => {
  const { client, snap } = await started('list-048');
  await rejects(client.act(snap.session, { event: 'EDIT' }), /action a2 \(EDIT\) is a row action of table t1 \(6 rows\) - pass `row` \(0-5\)/);
  await rejects(client.act(snap.session, { event: 'EDIT', row: 6 }), /row 6 does not exist/);
  const form = await started('popup-009');
  await rejects(form.client.act(form.snap.session, { event: 'BUTTON_SEND', row: 0 }), /`row` is for row actions - a5 \(BUTTON_SEND\) is a screen action/);
  const args = await started('args-537');
  await rejects(args.client.act(args.snap.session, { event: 'ROW', row: 0 }), /argument 1 of ROW \(\$expr:\$\{QUANTITY\} \* 10\) is computed in the browser - pass its value in args\[1\]/);
});

test('a popup in front: the page\'s fields are refused with the reason', async () => {
  const r = replay('popup-009');
  const client = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl });
  const s0 = await client.start('z2ui5_cl_smp_app_009');
  const s1 = await client.act(s0.session, { values: { f4: 'Smith', f2: '3' }, event: 'POPUP_TABLE_VALUE' });
  await rejects(client.act(s1.session, { values: { f1: 'x' } }), /a popup is open: only its fields and actions count until it closes/);
  await rejects(client.act(s1.session, { event: 'BUTTON_SEND' }), /allowed events: POPUP_TABLE_VALUE_CONTINUE .*a popup is open/);
});

test('sessions: unknown, earlier and orphaned (backend restarted) ids are refused', async () => {
  let gen = 1;
  const r = replay('table-011');
  const client = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl, generation: () => gen });
  const s0 = await client.start('z2ui5_cl_smp_app_011');
  const s1 = await client.act(s0.session, { event: 'BUTTON_EDIT' });
  assert.throws(() => client.describe('nope'), /unknown session 'nope' - start one with app_start; open sessions: /);
  assert.throws(() => client.describe(s0.session), new RegExp(`earlier state of this app session - continue with the current one: '${s1.session}'`));
  assert.deepEqual(client.sessions(), [{ session: s1.session, app: 'Z2UI5_CL_SMP_APP_011' }]);
  gen = 2;
  assert.throws(() => client.describe(s1.session), /started on a backend that has since stopped or restarted - its drafts are gone; app_start Z2UI5_CL_SMP_APP_011 again/);
  assert.throws(() => client.describe(undefined), /pass `session`/);
});

test('a backend error is a refusal with the backend\'s text, and the session is unchanged', async () => {
  let fail = false;
  const r = replay('popup-009');
  const fetchImpl = async (url, init) => (fail
    ? new Response('<pre>Error: Void type: Z_X<br>at y</pre>', { status: 500 })
    : r.fetchImpl(url, init));
  const client = createAppClient({ baseUrl: BASE, fetchImpl });
  const s0 = await client.start('z2ui5_cl_smp_app_009');
  fail = true;
  await rejects(client.act(s0.session, { values: { f4: 'Smith' }, event: 'BUTTON_SEND' }), /the backend refused the roundtrip - HTTP 500: Error: Void type: Z_X\nat y/);
  const after = client.describe(s0.session);
  assert.equal(after.session, s0.session);
  assert.equal(after.pending, undefined, 'the refused act rolled its values back');
  assert.equal(after.fields[3].value, '');
  const down = createAppClient({ baseUrl: BASE, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await rejects(down.start('z_x'), /the backend did not answer \(ECONNREFUSED\)/);
  await rejects(down.start(''), /pass `app`/);
});

// ------------------------------------------- embedding: the options ----

/** The replay as a `transport`: the same insistence on the recorded request,
 *  except for the start request's location, which the test names itself. */
function replayTransport(name, { location } = {}) {
  const exchanges = fixture(name).steps.filter((s) => s.exchange).map((s) => s.exchange);
  const calls = [];
  const transport = async (req) => {
    const body = JSON.parse(req.body).value;
    calls.push({ ...req, value: body });
    const next = exchanges[calls.length - 1];
    assert.ok(next, `request ${calls.length} was not in the recording`);
    const expected = structuredClone(next.request);
    if (location && expected.S_FRONT.ORIGIN !== undefined) {
      Object.assign(expected.S_FRONT, location);
    }
    assert.deepEqual(body, expected, `request ${calls.length} differs from the recorded one`);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(next.response) };
  };
  return { transport, calls, exchanges };
}

test('transport + location: one roundtrip per call, the start request carries the given location', async () => {
  const where = { ORIGIN: 'https://sap.example.com:44300', PATHNAME: '/sap/bc/z2ui5', SEARCH: '?sap-client=100&app_start=z2ui5_cl_smp_app_009' };
  const r = replayTransport('popup-009', { location: where });
  const asked = [];
  const client = createAppClient({
    transport: r.transport,
    location: async (app) => {
      asked.push(app);
      return { origin: where.ORIGIN, pathname: where.PATHNAME, search: `?sap-client=100&app_start=${app}` };
    },
  });
  const s0 = await client.start('z2ui5_cl_smp_app_009');
  assert.deepEqual(asked, ['z2ui5_cl_smp_app_009']);
  const s1 = await client.act(s0.session, { values: { f4: 'Smith', f2: '3' }, event: 'POPUP_TABLE_VALUE' });
  assert.equal(r.calls[0].draftId, null, 'an app start continues no draft');
  assert.equal(r.calls[1].draftId, s0.session, 'an event names the draft it continues');
  assert.deepEqual(r.calls[0].headers, { 'content-type': 'application/json', 'sap-contextid-accept': 'header' });
  assert.ok(r.calls[0].signal instanceof AbortSignal);
  assert.equal(typeof r.calls[0].body, 'string');
  assert.ok(s1.session && s1.session !== s0.session);
});

test('transport: a status outside 2xx is the backend\'s refusal, a throw is "did not answer" with the backendHint', async () => {
  const refusing = createAppClient({ transport: async () => ({ status: 403, headers: { 'x-csrf-token': 'Required' }, body: 'CSRF token validation failed' }) });
  await rejects(refusing.start('z_x'), /^the backend refused the roundtrip - HTTP 403: CSRF token validation failed$/);
  const noJson = createAppClient({ transport: async () => ({ status: 200, body: '<html>logon</html>' }) });
  await rejects(noJson.start('z_x'), /^the backend answered no JSON: <html>logon<\/html>$/);
  const down = (opts) => createAppClient({ transport: async () => { throw new Error('ECONNREFUSED'); }, ...opts });
  await rejects(down().start('z_x'), /^the backend did not answer \(ECONNREFUSED\) - is it running\? backend \{ action: "status" \} says$/);
  await rejects(down({ backendHint: 'is the system reachable? "abap2UI5: Check System Connection" says' }).start('z_x'),
    /^the backend did not answer \(ECONNREFUSED\) - is the system reachable\? "abap2UI5: Check System Connection" says$/);
  await rejects(down({ backendHint: '' }).start('z_x'), /^the backend did not answer \(ECONNREFUSED\)$/);
  const fetchDown = createAppClient({ baseUrl: BASE, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, backendHint: 'check the system' });
  await rejects(fetchDown.start('z_x'), /^the backend did not answer \(ECONNREFUSED\) - check the system$/);
});

test('location: a refusal it throws reaches the caller and sends nothing', async () => {
  let sent = 0;
  const client = createAppClient({
    transport: async () => { sent += 1; return { status: 200, body: '{}' }; },
    location: () => { throw new AgentError('the launch URL puts {class} into the path'); },
  });
  await rejects(client.start('z_x'), /^the launch URL puts \{class\} into the path$/);
  assert.equal(sent, 0);
});

test('generation absent: no restart detection; present: a session of another generation is refused', async () => {
  const plain = createAppClient({ transport: replayTransport('table-011', { location: { ORIGIN: 'x', PATHNAME: '/', SEARCH: '?app_start=z2ui5_cl_smp_app_011' } }).transport, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  const s0 = await plain.start('z2ui5_cl_smp_app_011');
  assert.equal(plain.describe(s0.session).session, s0.session, 'without `generation` a session is never orphaned');
  let gen = 'a';
  const watched = createAppClient({ baseUrl: BASE, fetchImpl: replay('table-011').fetchImpl, generation: () => gen });
  const w0 = await watched.start('z2ui5_cl_smp_app_011');
  gen = 'b';
  assert.throws(() => watched.describe(w0.session), /started on a backend that has since stopped or restarted/);
});

test('the default transport hands fetch the same request as before: POST to baseUrl, JSON, the context header', async () => {
  let seen;
  const client = createAppClient({
    baseUrl: BASE,
    fetchImpl: async (url, init) => {
      seen = { url, ...init };
      return new Response('{"nope":1}', { status: 200 });
    },
  });
  await rejects(client.start('z_x'), /answered without S_FRONT/);
  assert.equal(seen.url, BASE);
  assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.headers, { 'content-type': 'application/json', 'sap-contextid-accept': 'header' });
  assert.deepEqual(JSON.parse(seen.body), { value: { S_FRONT: { ORIGIN: 'http://127.0.0.1:4471', PATHNAME: '/', SEARCH: '?app_start=z_x' } } });
});

// ------------------------------------------- selection dialogs: the pick ----

test('a selection dialog\'s confirm: `row` is needed to pick one, it must exist, a search value comes from args', async () => {
  const r = replay('select-623');
  const c2 = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl });
  let s = await c2.start('z2ui5_cl_smpc_app_623');
  s = await c2.act(s.session, { event: 'VALUE_HELP' });
  await rejects(c2.act(s.session, { event: 'VH_CONFIRM' }), /^action a2 \(VH_CONFIRM\) picks a row of table t1 \(123 rows\) - pass `row` \(0-122\)$/);
  await rejects(c2.act(s.session, { event: 'VH_CONFIRM', row: 123 }), /^table t1 has 123 row\(s\) - row 123 does not exist \(rows are 0-based\)$/);
  await rejects(c2.act(s.session, { event: 'VH_SEARCH' }), /^argument 0 of VH_SEARCH \(\$parameters:value\) is computed in the browser - pass its value in args\[0\]$/);
  await rejects(c2.act(s.session, { event: 'VH_CANCEL', row: 1 }), /`row` is for row actions - a3 \(VH_CANCEL\) is a screen action/);
  assert.equal(r.sent.length, 2, 'refusals send nothing');
  assert.equal(c2.describe(s.session).pending, undefined);
});

/** A one-screen app: the start answers `xml` with `model`, every event an
 *  answer without MODEL; the event requests are kept. */
function fakeApp(xml, model) {
  const bodies = [];
  const transport = async ({ body }) => {
    const value = JSON.parse(body).value;
    bodies.push(value);
    const response = bodies.length === 1
      ? { S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', xml]] } }, MODEL: model }
      : { S_FRONT: { ID: `D${bodies.length}`, APP: 'Z_T' } };
    return { status: 200, body: JSON.stringify(response) };
  };
  const client = createAppClient({ transport, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  return { client, bodies };
}
const page = (body) => `<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc" xmlns:t="sap.ui.table"><Page title="T">${body}</Page></mvc:View>`;

const DIALOG = (multi, confirmArgs) => page(
  `<TableSelectDialog title="Pick" multiSelect="${multi}" items="{/T}" confirm=".eB(['OK']${confirmArgs})">`
  + '<ColumnListItem selected="{SEL}" type="Active"><cells><Text text="{A}"/><ObjectIdentifier title="{B}" text="{N}"/></cells></ColumnListItem>'
  + '<columns><Column><header><Text text="A"/></header></Column><Column><header><Text text="B"/></header></Column></columns></TableSelectDialog>',
);
const ROWS = () => ({ T: [{ A: 'a0', B: 'b0', N: 0, SEL: false }, { A: 'a1', B: 'b1', N: 10, SEL: true }, { A: 'a2', B: 'b2', N: 20, SEL: false }] });

test('the pick, single select: the picked row selected, the previous selection cleared, both sent; item arguments from the row', async () => {
  const args = ", ${$parameters>/selectedContexts/0/sPath}, ${$parameters>/selectedItem}.getCells()[1].getTitle(), ${$parameters>/selectedItem}.getCells()[1].getText()"
    + ", ${$parameters>/selectedItem}.getBindingContext().getProperty('A'), ${$parameters>/selectedItem}.getBindingContext().getPath()"
    + ", ${$parameters>/selectedItem} ? ${$parameters>/selectedItem}.getCells()[0].getText() : ''"
    + ", ${$parameters>/selectedItem}.getType(), ${$parameters>/selectedContexts/length}, ${$parameters>/selectedContexts[0]/sPath}";
  const { client, bodies } = fakeApp(DIALOG('false', args), ROWS());
  const s = await client.start('z_t');
  assert.deepEqual(s.actions[0].args.length, 9);
  await client.act(s.session, { event: 'OK', row: 2 });
  assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG, ['/T/2', 'b2', '20', 'a2', '/T/2', 'a2', 'Active', 1, null]);
  assert.deepEqual(bodies[1].MODEL, { T: { __delta: { 1: { SEL: false }, 2: { SEL: true } } } });
});

test('the pick, multi select: the row joins the selection, selectedItem is the first selected row in model order', async () => {
  const { client, bodies } = fakeApp(DIALOG('true', ', ${$parameters>/selectedContexts/1/sPath}, ${$parameters>/selectedItem}.getCells()[0].getText()'), ROWS());
  const s = await client.start('z_t');
  await client.act(s.session, { event: 'OK', row: 2 });
  assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG, ['/T/2', 'a1']);
  assert.deepEqual(bodies[1].MODEL, { T: { __delta: { 2: { SEL: true } } } });
});

test('the pick without `row`: multi select confirms what is ticked, and an item argument with nothing ticked is refused', async () => {
  const none = ROWS();
  none.T[1].SEL = false;
  const { client, bodies } = fakeApp(DIALOG('true', ', ${$parameters>/selectedContexts/0/sPath}'), none);
  let s = await client.start('z_t');
  s = await client.act(s.session, { values: { 't1/0/SEL': true } });
  await client.act(s.session, { event: 'OK' });
  assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG, ['/T/0']);
  assert.deepEqual(bodies[1].MODEL, { T: { __delta: { 0: { SEL: true } } } });
  const empty = fakeApp(DIALOG('true', ', ${$parameters>/selectedItem}.getCells()[0].getText()'), none);
  const e = await empty.client.start('z_t');
  await rejects(empty.client.act(e.session, { event: 'OK' }), /^argument 0 of OK \(\$expr:\$\{\$parameters>\/selectedItem\}\.getCells\(\)\[0\]\.getText\(\)\) reads the picked row and none is selected - pass `row`, or the value in args\[0\]$/);
  assert.equal(empty.bodies.length, 1);
});

test('the pick: a marshalled control, an id or an unknown call is asked for in args, and the refused pick leaves the selection alone', async () => {
  for (const [arg, describe] of [
    ['${$parameters>/selectedItems}', '$parameters:selectedItems'],
    ['${$parameters>/selectedItem}.getId()', '$expr:${$parameters>/selectedItem}.getId()'],
    ['${$parameters>/selectedItem}.getCells()[5].getText()', '$expr:${$parameters>/selectedItem}.getCells()[5].getText()'],
    ['${$parameters>/selectedItem}.getHighlight()', '$expr:${$parameters>/selectedItem}.getHighlight()'],
  ]) {
    const { client, bodies } = fakeApp(DIALOG('false', `, ${arg}`), ROWS());
    const s = await client.start('z_t');
    const esc = describe.replace(/[$.*+?^{}()|[\]\\/]/g, '\\$&');
    await rejects(client.act(s.session, { event: 'OK', row: 0 }), new RegExp(`^argument 0 of OK \\(${esc}\\) is computed in the browser - pass its value in args\\[0\\]$`));
    assert.equal(bodies.length, 1);
    const after = client.describe(s.session);
    assert.equal(after.pending, undefined, 'the pick was rolled back');
    assert.deepEqual(after.tables[0].rows.map((r) => r.SEL), [false, true, false]);
    await client.act(s.session, { event: 'OK', row: 0, args: ['given'] });
    assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG, ['given']);
  }
});

test('row events of tables: listItem, rowIndex/rowContext and a row action item\'s row are filled from `row`', async () => {
  const xml = page(
    '<Table items="{/T}" itemPress=".eB([\'PRESS\'], ${$parameters>/listItem}.getBindingContext().getProperty(\'B\'), ${$parameters>/listItem}.getCells()[0].getText())">'
    + '<columns><Column/></columns><items><ColumnListItem type="Active"><cells><Text text="{A}"/></cells></ColumnListItem></items></Table>'
    + '<t:Table rows="{/T}" rowSelectionChange=".eB([\'SEL\'], ${$parameters>/rowIndex}, ${$parameters>/rowContext}.getPath(), ${$parameters>/rowContext/sPath})"'
    + ' cellClick=".eB([\'CELL\'], ${$parameters>/rowBindingContext}.getProperty(\'A\'), ${$parameters>/columnIndex})">'
    + '<t:columns><t:Column><Label text="A"/><t:template><Text text="{A}"/></t:template></t:Column></t:columns>'
    + '<t:rowActionTemplate><t:RowAction><t:RowActionItem type="Navigation" press=".eB([\'NAV\'], ${$parameters>/row}.getBindingContext().getProperty(\'B\'))"/></t:RowAction></t:rowActionTemplate></t:Table>',
  );
  const { client, bodies } = fakeApp(xml, ROWS());
  let s = await client.start('z_t');
  await rejects(client.act(s.session, { event: 'PRESS' }), /^action a1 \(PRESS\) is a row action of table t1 \(3 rows\) - pass `row` \(0-2\)$/);
  s = await client.act(s.session, { event: 'PRESS', row: 1 });
  s = await client.act(s.session, { event: 'SEL', row: 2 });
  await rejects(client.act(s.session, { event: 'CELL', row: 0 }), /^argument 1 of CELL \(\$parameters:columnIndex\) is computed in the browser - pass its value in args\[1\]$/);
  s = await client.act(s.session, { event: 'CELL', row: 0, args: [null, 0] });
  s = await client.act(s.session, { event: 'NAV', row: 0 });
  assert.deepEqual(bodies.slice(1).map((b) => b.S_FRONT.T_EVENT_ARG), [['b1', 'a1'], [2, '/T/2', '/T/2'], ['a0', 0], ['b0']]);
  assert.ok(bodies.slice(1).every((b) => b.MODEL === undefined), 'a table row event selects nothing by itself');
});

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
import { createAppClient, buildDelta, errorText, AgentError, PROTOCOL, EARLIER_IDS, headerOf, validContextId } from '../lib/appclient.mjs';
import { setAt } from '../lib/snapshot.mjs';

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

test('errorText shows the error body verbatim: markup is text, nothing stripped or decoded (spec/errors.md)', () => {
  const body = 'abap2UI5 failed for <b>bold</b> &amp; <img src="x">\n\n--- error ---\n  at /?app_start=<script>x</script>  \n';
  assert.equal(errorText(500, body), 'HTTP 500: abap2UI5 failed for <b>bold</b> &amp; <img src="x">\n\n--- error ---\n  at /?app_start=<script>x</script>');
  assert.equal(errorText(500, '<pre>Error: boom<br> &nbsp; at x &lt;y&gt;</pre>'), 'HTTP 500: <pre>Error: boom<br> &nbsp; at x &lt;y&gt;</pre>', 'an HTML page too');
  assert.equal(errorText(502, ''), 'HTTP 502');
  assert.equal(errorText(502, '  \n '), 'HTTP 502', 'a body of whitespace is no body');
  assert.equal(errorText(500, 'a\r\nb\u001b[2Jc\u0000'), `HTTP 500: a\nb${String.fromCodePoint(0xfffd)}[2Jc${String.fromCodePoint(0xfffd)}`, 'control characters cannot reach a terminal');
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const cut = errorText(500, long);
  assert.ok(cut.startsWith('HTTP 500: line 0\nline 1\n'), 'a long body is shortened, from the start');
  assert.match(cut, /line 39\n\.\.\. \(\d+ more characters\)$/);
  assert.ok(!cut.includes('line 40'));
  assert.ok(errorText(500, 'x'.repeat(10000)).length < 4100, 'and capped in characters');
});

test('errorText takes linear time over a long run of whitespace inside the body', () => {
  // /\s+$/ retried each run from every one of its positions: 15 s for this body
  const body = `a${' '.repeat(100000)}b${'\n'.repeat(100000)}c \n\t `;
  const t0 = Date.now();
  const out = errorText(500, body);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.ok(out.startsWith('HTTP 500: a   '), 'the body is still shown from its start');
  assert.equal(errorText(500, 'a 　\n \t'), 'HTTP 500: a', 'trailing whitespace of every kind \\s matched is still trimmed');
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

test('a long session keeps the last EARLIER_IDS draft ids as earlier states, not every one it ever had', async () => {
  /* Every roundtrip answers a new draft id, and adopt() kept each in the
   * session's ids and the client's id index for the session's life: 10,000
   * acts held ~1.5 MB a long-running server never gave back. */
  const { client } = fakeApp(page('<Button text="Go" press=".eB([\'GO\'])"/>'), {});
  const first = await client.start('z_t');
  const seen = [first.session];
  let s = first;
  for (let i = 0; i < 1000; i += 1) {
    s = await client.act(s.session, { event: 'GO' });
    seen.push(s.session);
  }
  assert.equal(new Set(seen).size, 1001, 'a new draft id per roundtrip');
  assert.equal(client.describe(s.session).session, s.session);
  const recent = seen[seen.length - 1 - EARLIER_IDS];
  assert.throws(() => client.describe(recent), new RegExp(`'${recent}' is an earlier state of this app session - continue with the current one: '${s.session}'`));
  const gone = seen[seen.length - 2 - EARLIER_IDS];
  assert.throws(() => client.describe(gone), new RegExp(`unknown session '${gone}' - start one with app_start; open sessions: ${s.session} \\(Z_T\\)$`));
  assert.throws(() => client.describe(first.session), /unknown session /);
});

test('a backend error is a refusal with the backend\'s text, and the session is unchanged', async () => {
  let fail = false;
  const r = replay('popup-009');
  const fetchImpl = async (url, init) => (fail
    ? new Response('Error: Void type: <Z_X>\nat y', { status: 500, headers: { 'content-type': 'text/plain' } })
    : r.fetchImpl(url, init));
  const client = createAppClient({ baseUrl: BASE, fetchImpl });
  const s0 = await client.start('z2ui5_cl_smp_app_009');
  fail = true;
  await rejects(client.act(s0.session, { values: { f4: 'Smith' }, event: 'BUTTON_SEND' }), /the backend refused the roundtrip - HTTP 500: Error: Void type: <Z_X>\nat y$/);
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
  assert.equal(r.calls[0].method, 'POST', 'a roundtrip is a POST');
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

test('sessions are evicted least recently used first; one evicted while its act was in flight does not come back', async () => {
  let n = 0;
  let hold = null;
  const xml = page('<Button text="Go" press=".eB([\'GO\'])"/>');
  const transport = async ({ body }) => {
    const value = JSON.parse(body).value;
    n += 1;
    const id = `D${n}`;
    if (hold && value.S_FRONT.ID === hold.id) await hold.wait;
    const response = value.S_FRONT.ID
      ? { S_FRONT: { ID: id, APP: 'Z_T' } }
      : { S_FRONT: { ID: id, APP: 'Z_T' }, S_ACTION: undefined };
    if (!value.S_FRONT.ID) response.S_FRONT.S_ACTION = { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', xml]] };
    return { status: 200, body: JSON.stringify(response) };
  };
  const client = createAppClient({ transport, maxSessions: 2, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  let a = await client.start('z_a');
  const b = await client.start('z_b');
  a = await client.act(a.session, { event: 'GO' });
  const c = await client.start('z_c');
  assert.deepEqual(client.sessions().map((x) => x.session), [a.session, c.session], 'B went, not A that was in use');
  assert.throws(() => client.describe(b.session), /unknown session/);

  let release;
  hold = { id: a.session, wait: new Promise((r) => { release = r; }) };
  const late = client.act(a.session, { event: 'GO' });
  const d = await client.start('z_d');
  const e = await client.start('z_e');
  release();
  const answered = await late;
  assert.deepEqual(client.sessions().map((x) => x.session), [d.session, e.session]);
  assert.throws(() => client.describe(answered.session), /unknown session/, 'not back as an unlisted session');
});

test('an act queued behind one in flight runs only where its ids still name what the caller saw', async () => {
  const one = page('<Button text="Next" press=".eB([\'NEXT\'])"/>');
  const two = page('<Button text="Delete all" press=".eB([\'DELETE_ALL\'])"/>');
  const sent = [];
  let release;
  const transport = async ({ body }) => {
    const value = JSON.parse(body).value;
    sent.push(value.S_FRONT.EVENT ?? 'start');
    if (!value.S_FRONT.ID) return { status: 200, body: JSON.stringify({ S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', one]] } } }) };
    if (value.S_FRONT.EVENT === 'NEXT') await new Promise((r) => { release = r; });
    return { status: 200, body: JSON.stringify({ S_FRONT: { ID: `D${sent.length}`, APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', two]] } } }) };
  };
  const client = createAppClient({ transport, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  const s = await client.start('z_t');
  const first = client.act(s.session, { event: 'a1' });
  const second = client.act(s.session, { event: 'a1' });
  await new Promise((r) => setImmediate(r));
  release();
  const next = await first;
  await rejects(second, /^the screen changed while an earlier act was in flight - 'a1' is a1 \(DELETE_ALL\) on the new screen; nothing was sent/);
  assert.deepEqual(sent, ['start', 'NEXT'], 'DELETE_ALL was never sent');
  // queued on a screen that stays the same, it runs
  const third = client.act(next.session, { event: 'a1' });
  const fourth = client.act(next.session, { event: 'DELETE_ALL' });
  await third;
  await fourth;
  assert.deepEqual(sent, ['start', 'NEXT', 'DELETE_ALL', 'DELETE_ALL']);
});

test('evicting a session leaves a newer one with the same draft id reachable', async () => {
  const xml = page('<Button text="Go" press=".eB([\'GO\'])"/>');
  const transport = async () => ({ status: 200, body: JSON.stringify({ S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', xml]] } } }) });
  const client = createAppClient({ transport, maxSessions: 2, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  let last;
  for (let i = 0; i < 5; i += 1) last = await client.start('z_t');
  assert.equal(client.describe(last.session).session, 'D1');
});

test('an event name without `row` fires the screen action of that name before a row action', async () => {
  const xml = page(
    '<Table items="{/T}"><columns><Column/></columns><items><ColumnListItem><cells><Button text="Del" press=".eB([\'DELETE\'], ${A})"/></cells></ColumnListItem></items></Table>'
    + '<Button text="Delete selected" press=".eB([\'DELETE\'])"/>',
  );
  const { client, bodies } = fakeApp(xml, ROWS());
  let s = await client.start('z_t');
  s = await client.act(s.session, { event: 'DELETE' });
  assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG ?? [], []);
  await client.act(s.session, { event: 'DELETE', row: 1 });
  assert.deepEqual(bodies[2].S_FRONT.T_EVENT_ARG, ['a1']);
});

test('a 2xx answer that is no JSON is shown without its control characters', async () => {
  const client = createAppClient({ transport: async () => ({ status: 200, body: '<html>\u001b[2Jlogon</html>' }), location: () => ({ origin: 'x', pathname: '/', search: '' }) });
  await rejects(client.start('z_x'), new RegExp(`^the backend answered no JSON: <html>${String.fromCodePoint(0xfffd)}\\[2Jlogon</html>$`));
});

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

test('`row` is a non-negative integer: a JSON number or a string of digits; "", false, [], true, 1.5, -1 are refused', async () => {
  /* server.mjs read `row` with Number(): "", false and [] became row 0 and
   * true row 1 - a pick of a row nobody named. The client checks it now. */
  const { client, bodies } = fakeApp(DIALOG('false', ', ${$parameters>/selectedContexts/0/sPath}'), ROWS());
  const s = await client.start('z_t');
  for (const bad of ['', ' ', false, true, [], [0], {}, 1.5, -1, '1.0', '0x1', '1e0', '-0', 'Infinity', Infinity, NaN]) {
    await rejects(client.act(s.session, { event: 'OK', row: bad }), /^`row` is a row index \(0-based\) - a non-negative integer, not /);
  }
  await rejects(client.act(s.session, { row: '' }), /^`row` is a row index/);
  assert.equal(bodies.length, 1, 'refusals send nothing');
  await client.act(s.session, { event: 'OK', row: ' 2 ' });
  assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG, ['/T/2']);
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

/* Action ids follow the document order, so values that show a control
 * renumber them. The act re-read its action by id after applying the values:
 * "check the box, then SAVE" fired DELETE, the button the box made visible
 * in front of Save - an event nobody asked for, never validated. */
test('values that renumber the actions fire the action that was asked for, or are refused', async () => {
  const CHECK = '<CheckBox text="Danger zone" selected="{/SHOW}"/><Button text="Delete all" visible="{/SHOW}" press=".eB([\'DELETE\'])"/>';
  const one = fakeApp(page(`${CHECK}<Button text="Save" press=".eB(['SAVE'])"/>`), { SHOW: false });
  let s = await one.client.start('z_t');
  assert.deepEqual(s.actions.map((a) => `${a.id}:${a.event}`), ['a1:SAVE']);
  s = await one.client.act(s.session, { values: { '/SHOW': true }, event: 'SAVE' });
  assert.equal(one.bodies[1].S_FRONT.EVENT, 'SAVE', 'not DELETE, which is a1 once the box is ticked');
  assert.deepEqual(one.bodies[1].MODEL, { SHOW: true });

  // two Save buttons: which of them a1 was is no longer decidable - refused,
  // nothing sent, the value not applied
  const two = fakeApp(page(`${CHECK}<Button text="Save" press=".eB(['SAVE'])"/><Button text="Save" press=".eB(['SAVE'])"/>`), { SHOW: false });
  s = await two.client.start('z_t');
  await rejects(two.client.act(s.session, { values: { '/SHOW': true }, event: 'SAVE' }),
    /^the values change the screen - action a1 is no longer SAVE; fill the values without an event first, then fire it from the next snapshot$/);
  assert.equal(two.bodies.length, 1, 'nothing sent');
  const d = two.client.describe(s.session);
  assert.equal(d.pending, undefined);
  assert.equal(d.fields[0].value, false);
  assert.deepEqual(d.actions.map((a) => a.event), ['SAVE', 'SAVE']);
});

/* The act checked that its action is enabled BEFORE the values and fired
 * it after them without asking again: OPEN set to false together with DEL
 * pressed a Delete button whose enabled="{/OPEN}" the browser had just
 * disabled. And values that hid the action left its id with nothing behind
 * it - the action of the old snapshot was fired anyway, a control the screen
 * no longer shows. Both are refused before anything is sent, the values not
 * applied (the agent addon refuses both the same way). */
test('values that disable or hide the act\'s own action are refused, nothing sent, the values rolled back', async () => {
  const DEL = '<CheckBox text="Open" selected="{/OPEN}"/><Button text="Delete" enabled="{/OPEN}" press=".eB([\'DEL\'])"/>';
  const off = fakeApp(page(DEL), { OPEN: true });
  let s = await off.client.start('z_t');
  assert.equal(s.actions[0].enabled, true);
  await rejects(off.client.act(s.session, { values: { '/OPEN': false }, event: 'DEL' }),
    /^action a1 \(Delete\) is disabled once the values are filled - this screen offers no action/);
  assert.equal(off.bodies.length, 1, 'nothing sent');
  let d = off.client.describe(s.session);
  assert.equal(d.pending, undefined);
  assert.equal(d.fields[0].value, true);
  // the same values without the event are fine, and the button is then disabled
  d = await off.client.act(s.session, { values: { '/OPEN': false } });
  assert.equal(d.actions[0].enabled, false);

  const HIDE = '<CheckBox text="More" selected="{/SHOW}"/><Button text="Save" press=".eB([\'SAVE\'])"/><Button text="Close" visible="{/SHOW}" press=".eB([\'C\'])"/>';
  const gone = fakeApp(page(HIDE), { SHOW: true });
  s = await gone.client.start('z_t');
  assert.deepEqual(s.actions.map((a) => `${a.id}:${a.event}`), ['a1:SAVE', 'a2:C']);
  await rejects(gone.client.act(s.session, { values: { '/SHOW': false }, event: 'C' }),
    /^the values change the screen - action a2 \(C\) is no longer on it; fill the values without an event first, then fire it from the next snapshot$/);
  assert.equal(gone.bodies.length, 1, 'nothing sent');
  d = gone.client.describe(s.session);
  assert.equal(d.pending, undefined);
  assert.equal(d.fields[0].value, true);

  // an action whose id went away but which is still there under another
  // one is fired as itself
  const moved = fakeApp(page('<CheckBox text="More" selected="{/SHOW}"/><Button text="Close" visible="{/SHOW}" press=".eB([\'C\'])"/><Button text="Save" press=".eB([\'SAVE\'])"/>'), { SHOW: true });
  s = await moved.client.start('z_t');
  assert.deepEqual(s.actions.map((a) => `${a.id}:${a.event}`), ['a1:C', 'a2:SAVE']);
  await moved.client.act(s.session, { values: { '/SHOW': false }, event: 'a2' });
  assert.equal(moved.bodies[1].S_FRONT.EVENT, 'SAVE');
  assert.deepEqual(moved.bodies[1].MODEL, { SHOW: false });
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

/* `${$parameters>/}` and `${$parameters>}` name the WHOLE parameter object.
 * It holds the row as an item or a context, which this client models with
 * markers - and those ({"selectedItem":{"$item":0}, ...}) went out as the
 * event argument. The browser sends the controls marshalled there; like
 * the agent addon, the client asks for the value in args. */
test('the whole parameter object is asked for in args, never sent with the client\'s item markers', async () => {
  const TABLE = (arg) => page(`<Table items="{/T}" itemPress=".eB(['PRESS'], ${arg})"><columns><Column/></columns><items><ColumnListItem type="Active"><cells><Text text="{A}"/></cells></ColumnListItem></items></Table>`
    + `<t:Table rows="{/T}" rowSelectionChange=".eB(['SEL'], ${arg})"><t:columns><t:Column><Label text="A"/><t:template><Text text="{A}"/></t:template></t:Column></t:columns></t:Table>`);
  for (const arg of ['${$parameters>/}', '${$parameters>}']) {
    for (const [xml, event] of [[DIALOG('false', `, ${arg}`), 'OK'], [TABLE(arg), 'PRESS'], [TABLE(arg), 'SEL']]) {
      const { client, bodies } = fakeApp(xml, ROWS());
      const s = await client.start('z_t');
      await rejects(client.act(s.session, { event, row: 0 }), new RegExp(`^argument 0 of ${event} \\(\\$parameters:\\) is computed in the browser - pass its value in args\\[0\\]$`));
      assert.equal(bodies.length, 1, `${event} ${arg}: nothing sent`);
      assert.equal(client.describe(s.session).pending, undefined, 'a refused pick is rolled back');
      await client.act(s.session, { event, row: 0, args: ['given'] });
      assert.deepEqual(bodies[1].S_FRONT.T_EVENT_ARG, ['given']);
    }
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

// ------------------------------- the protocol's client rules (spec/*.md) ----

/** A scripted backend as a `transport`: `answer(req, n)` builds the n-th
 *  POST's answer ({ status?, headers?, body } or a response object); HEADs
 *  go to `head(req)`. Every request is kept, and `hold()` keeps the next
 *  POST's answer back until `release()`. */
function scripted(answer, { head } = {}) {
  const posts = [];
  const heads = [];
  let gate = null;
  const transport = async (req) => {
    if (req.method === 'HEAD') {
      heads.push(req);
      return head ? head(req) : { status: 200, headers: {}, body: '' };
    }
    const value = JSON.parse(req.body).value;
    posts.push({ ...req, value });
    const g = gate;
    gate = null;
    if (g) {
      g.received();
      await g.released;
    }
    const a = answer(req, posts.length, value);
    return a && a.S_FRONT ? { status: 200, headers: {}, body: JSON.stringify(a) } : { status: 200, headers: {}, ...a, body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) };
  };
  const hold = () => {
    let received;
    let release;
    const r = new Promise((res) => { received = res; });
    const released = new Promise((res) => { release = res; });
    gate = { received, released };
    return { received: r, release };
  };
  const client = (opts = {}) => createAppClient({ transport, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }), ...opts });
  return { transport, posts, heads, hold, client };
}

const FORM = page('<Input value="{/NAME}"/><Input value="{/ZIP}"/><Button text="Check" press=".eB([\'CHECK\'])"/><Button text="Other" press=".eB([\'OTHER\'])"/>');
const startAnswer = (extra = {}) => ({ S_FRONT: { ID: 'D1', APP: 'Z_T', PROTOCOL: 2, S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', FORM]] }, ...extra }, MODEL: { NAME: '', ZIP: '' } });
const eventAnswer = (n, extra = {}) => ({ S_FRONT: { ID: `D${n}`, APP: 'Z_T', PROTOCOL: 2, ...extra } });

test('PROTOCOL: a response declaring another number is refused whole, naming both; an absent one is let through', async () => {
  assert.equal(PROTOCOL, 2);
  const newer = scripted(() => startAnswer({ PROTOCOL: 3 }));
  const c3 = newer.client();
  await rejects(c3.start('z_t'), /^the backend answered protocol 3, this client speaks protocol 2 - the client is older; nothing of the response was adopted/);
  assert.deepEqual(c3.sessions(), [], 'no session from a refused start');
  assert.throws(() => c3.describe('D1'), /unknown session 'D1'/, 'its draft id is not adopted');
  const older = scripted(() => startAnswer({ PROTOCOL: 1 }));
  await rejects(older.client().start('z_t'), /answered protocol 1, this client speaks protocol 2 - the backend is older/);
  const absent = scripted(() => { const a = startAnswer(); delete a.S_FRONT.PROTOCOL; return a; });
  assert.equal((await absent.client().start('z_t')).session, 'D1', 'no PROTOCOL: a backend older than the field');
  // during a session: the event's answer is refused, the session stays where it was
  const mid = scripted((req, n) => (n === 1 ? startAnswer() : eventAnswer(n, { PROTOCOL: 3, S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', page('<Text text="never"/>')]] } })));
  const c = mid.client();
  const s = await c.start('z_t');
  await c.act(s.session, { values: { '/NAME': 'Ann' } });
  await rejects(c.act(s.session, { event: 'CHECK' }), /protocol 3, this client speaks protocol 2/);
  const after = c.describe(s.session);
  assert.equal(after.session, 'D1', 'the draft id of the refused response was not adopted');
  assert.ok(!after.texts.includes('never'), 'nor its view');
  assert.deepEqual(after.pending, ['/NAME'], 'the edit it carried is still pending');
  assert.throws(() => c.describe('D2'), /unknown session 'D2'/);
});

test('sap-contextid: kept from the last response that carried it, sent with every later POST of that session only', async () => {
  const contexts = { 1: 'SID:ANON:1', 3: 'SID:ANON:2' };
  const be = scripted((req, n, value) => {
    const base = value.S_FRONT.ID ? eventAnswer(n) : startAnswer({ ID: `D${n}` });
    const header = contexts[n];
    return { body: base, headers: header ? (n === 3 ? { 'Sap-ContextId': [header] } : { 'sap-contextid': header }) : {} };
  });
  const c = be.client();
  let s = await c.start('z_t');
  s = await c.act(s.session, { event: 'CHECK' });
  s = await c.act(s.session, { event: 'CHECK' });
  s = await c.act(s.session, { event: 'CHECK' });
  assert.deepEqual(be.posts.map((p) => p.headers['sap-contextid']), [undefined, 'SID:ANON:1', 'SID:ANON:1', 'SID:ANON:2'],
    'none before one was handed out, the first kept through a response without it, the newer one (any header case) after');
  assert.ok(be.posts.every((p) => p.headers['sap-contextid-accept'] === 'header'), 'every POST asks for the id in a header');
  // another session of the same client starts without one
  await c.start('z_t');
  assert.equal(be.posts[4].headers['sap-contextid'], undefined, 'a session id is per session');
  assert.ok(!('sap-contextid' in be.posts[4].headers));
  // an empty id or the text `undefined` is never adopted
  const bad = scripted((req, n, value) => ({ body: value.S_FRONT.ID ? eventAnswer(n) : startAnswer(), headers: { 'sap-contextid': n === 1 ? 'undefined' : '' } }));
  const b = bad.client();
  const t = await b.start('z_t');
  await b.act(t.session, { event: 'CHECK' });
  await b.act((b.sessions()[0]).session, { event: 'CHECK' });
  assert.ok(bad.posts.every((p) => !('sap-contextid' in p.headers)));
  assert.equal(validContextId('undefined'), false);
  assert.equal(headerOf({ 'X-A': [' a', 'b '] }, 'x-a'), 'a, b');
});

test('one roundtrip at a time: a second act while one is in flight waits and continues the new draft id', async () => {
  const be = scripted((req, n, value) => (value.S_FRONT.ID ? eventAnswer(n) : startAnswer()));
  const c = be.client();
  const s = await c.start('z_t');
  const held = be.hold();
  const first = c.act(s.session, { event: 'CHECK' });
  await held.received;
  // the agent fires again on the screen it has - the draft the first continues
  const second = c.act(s.session, { event: 'OTHER' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(be.posts.length, 2, 'no second POST while the first is in flight');
  held.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.session, 'D2');
  assert.equal(b.session, 'D3');
  assert.deepEqual(be.posts.slice(1).map((p) => [p.value.S_FRONT.ID, p.value.S_FRONT.EVENT]), [['D1', 'CHECK'], ['D2', 'OTHER']],
    'the queued act ran after the first, on the draft id it left');
  // once it is done, the old id is an earlier state again
  await rejects(c.act(s.session, { event: 'CHECK' }), /earlier state of this app session - continue with the current one: 'D3'/);
});

test('one roundtrip at a time: a failed or refused act does not block the queue', async () => {
  let fail = true;
  const be = scripted((req, n, value) => {
    if (!value.S_FRONT.ID) return startAnswer();
    if (fail) { fail = false; return { status: 500, body: 'boom' }; }
    return eventAnswer(n);
  });
  const c = be.client();
  const s = await c.start('z_t');
  const held = be.hold();
  const first = c.act(s.session, { event: 'CHECK' });
  await held.received;
  const refused = c.act(s.session, { event: 'NOPE' });
  const second = c.act(s.session, { event: 'OTHER' });
  held.release();
  await rejects(first, /HTTP 500: boom/);
  await rejects(refused, /no action 'NOPE' on this screen/);
  assert.equal((await second).session, 'D3');
  assert.equal(be.posts[2].value.S_FRONT.ID, 'D1', 'the failed roundtrip adopted nothing: the next continues D1');
});

test('edits made while a roundtrip is in flight survive its answer and travel with the next event', async () => {
  const be = scripted((req, n, value) => {
    if (!value.S_FRONT.ID) return startAnswer();
    // the first event's answer pushes the model (the backend saw NAME only)
    return n === 2 ? { ...eventAnswer(n), MODEL: { NAME: 'Ann', ZIP: '' } } : eventAnswer(n);
  });
  const c = be.client();
  const s = await c.start('z_t');
  await c.act(s.session, { values: { '/NAME': 'Ann' } });
  const held = be.hold();
  const first = c.act(s.session, { event: 'CHECK' });
  await held.received;
  // values without an event start no roundtrip: applied at once, not queued
  const typed = await c.act(s.session, { values: { '/ZIP': '75001' } });
  assert.deepEqual(typed.pending, ['/NAME', '/ZIP']);
  held.release();
  const a = await first;
  assert.deepEqual(be.posts[1].value.MODEL, { NAME: 'Ann' }, 'the in-flight request carried what was pending when it left');
  assert.deepEqual(a.pending, ['/ZIP'], 'only what it carried is done with');
  assert.equal(a.fields.find((f) => f.path === '/ZIP').value, '75001', 'the edit survives the model push');
  await c.act(a.session, { event: 'OTHER' });
  assert.deepEqual(be.posts[2].value.MODEL, { ZIP: '75001' }, 'and travels with the next event');
});

test('a view the response displays anew drops the unsent edits of the old one, as its new model does in the frontend', async () => {
  const POPOVER = '<core:FragmentDefinition xmlns="sap.m" xmlns:core="sap.ui.core"><Popover title="P"><Button text="OK" press=".eB([\'OK\'])"/></Popover></core:FragmentDefinition>';
  const be = scripted((req, n, value) => {
    if (!value.S_FRONT.ID) return startAnswer({ S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', FORM], ['VIEW_SLOTS', 'display', 'POPOVER', POPOVER, { openById: 'x' }]] } });
    // the popover's OK: the popover goes, the page is displayed again
    return n === 2 ? { ...eventAnswer(n, { S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'destroy', 'POPOVER'], ['VIEW_SLOTS', 'display', 'MAIN', FORM]] } }), MODEL: { NAME: 'fresh', ZIP: '' } } : eventAnswer(n);
  });
  const c = be.client();
  const s = await c.start('z_t');
  // the page stays editable behind a popover: typed there, not sent
  const typed = await c.act(s.session, { values: { '/NAME': 'typed' } });
  assert.deepEqual(typed.pending, ['/NAME']);
  const a = await c.act(s.session, { event: 'OK' });
  assert.equal(be.posts[1].value.MODEL, undefined, 'the popover\'s event carries its own model only');
  assert.equal(a.pending, undefined, 'the new page has nothing pending');
  assert.equal(a.fields.find((f) => f.path === '/NAME').value, 'fresh', 'and shows what the backend sent');
  await c.act(a.session, { event: 'CHECK' });
  assert.equal(be.posts[2].value.MODEL, undefined, 'the edit of the old page never goes out');
});

test('a model push re-applies an unsent edit only where its parent still exists, as JSONModel#setProperty does', async () => {
  const GRID = page('<Input value="{/NAME}"/><Table items="{/T}"><columns><Column/></columns><items><ColumnListItem><cells><Input value="{Q}"/></cells></ColumnListItem></items></Table><Button text="Check" press=".eB([\'CHECK\'])"/>');
  const POPOVER = '<core:FragmentDefinition xmlns="sap.m" xmlns:core="sap.ui.core"><Popover title="P"><Button text="OK" press=".eB([\'OK\'])"/></Popover></core:FragmentDefinition>';
  const be = scripted((req, n, value) => {
    if (!value.S_FRONT.ID) {
      return { S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', GRID], ['VIEW_SLOTS', 'display', 'POPOVER', POPOVER, {}]] } }, MODEL: { NAME: '', T: [{ Q: 1 }, { Q: 2 }, { Q: 3 }] } };
    }
    // the popover's OK closes it and pushes a model whose table shrank
    return n === 2 ? { ...eventAnswer(n, { S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'destroy', 'POPOVER']] } }), MODEL: { NAME: '', T: [{ Q: 1 }] } } : eventAnswer(n);
  });
  const c = be.client();
  const s = await c.start('z_t');
  await c.act(s.session, { values: { '/NAME': 'Ann', '/T/2/Q': 9 } });
  const a = await c.act(s.session, { event: 'OK' });
  assert.equal(a.fields.find((f) => f.path === '/NAME').value, 'Ann', 'an edit whose parent is there is re-applied');
  assert.equal(a.tables[0].rowCount, 1, 'no row is made up for the one that is gone');
  assert.deepEqual(a.tables[0].rows, [{ Q: 1 }]);
  assert.deepEqual(a.pending, ['/NAME', '/T/2/Q'], 'both stay pending, as the frontend\'s changed paths do');
  await c.act(a.session, { event: 'CHECK' });
  assert.equal(JSON.stringify(be.posts[2].value.MODEL), '{"NAME":"Ann","T":{"__delta":{"2":{}}}}', 'the delta the frontend builds from that model');
});

test('app_start values that are refused name the session the start opened, as the agent addon does', async () => {
  const be = scripted((req, n, value) => (value.S_FRONT.ID ? eventAnswer(n) : startAnswer()));
  const c = be.client();
  await rejects(c.start('z_t', { values: { '/NOPE': 'x' } }), /^no field '\/NOPE' on this screen - .* \(the app is running: session D1 - app_describe shows it\)$/);
  const s = c.describe('D1');
  assert.equal(s.session, 'D1', 'the started app is reachable');
  assert.equal(s.pending, undefined, 'and none of the refused values was applied');
  await c.act('D1', { values: { '/NAME': 'Ann' }, event: 'CHECK' });
  assert.deepEqual(be.posts[1].value.MODEL, { NAME: 'Ann' });
});

test('a number field takes a number or a decimal string, as the agent addon does - nothing Number() would bend into one', async () => {
  const VIEW = page('<Input value="{/QTY}"/><Button text="Check" press=".eB([\'CHECK\'])"/>');
  const be = scripted((req, n, value) => (value.S_FRONT.ID ? eventAnswer(n) : { S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', VIEW]] } }, MODEL: { QTY: 1 } }));
  const c = be.client();
  const s = await c.start('z_t');
  // Infinity went out as null (the field's initial value), 0x10 as 16, true as 1
  for (const bad of [true, '0x10', '1e3', 'Infinity', '1e400', '', ' ', '5 apples']) {
    await rejects(c.act(s.session, { values: { '/QTY': bad } }), /^field f1 \(QTY\) holds a number - .* is none$/);
  }
  assert.equal(c.describe(s.session).pending, undefined, 'nothing of it was applied');
  for (const [given, stored] of [[7, 7], ['-2.5', -2.5], [' 42 ', 42]]) {
    const a = await c.act(s.session, { values: { '/QTY': given } });
    assert.equal(a.fields[0].value, stored);
  }
  await c.act(s.session, { event: 'CHECK' });
  assert.deepEqual(be.posts[1].value.MODEL, { QTY: 42 });
});

test('a field bound through __proto__ writes nothing into this process\'s prototypes', async () => {
  const VIEW = page('<Input value="{/__proto__/a2ui5Polluted}"/><Input value="{/constructor/prototype/a2ui5Polluted}"/><Input value="{/NAME}"/><Button text="Check" press=".eB([\'CHECK\'])"/>');
  const be = scripted((req, n, value) => (value.S_FRONT.ID ? eventAnswer(n) : startAnswer({ S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', VIEW]] } })));
  const c = be.client();
  const s = await c.start('z_t');
  try {
    await rejects(c.act(s.session, { values: { f1: 'x' } }), /^\/__proto__\/a2ui5Polluted is no model path a value can be written to/);
    await rejects(c.act(s.session, { values: { f2: 'x', '/NAME': 'Ann' }, event: 'CHECK' }), /constructor\/prototype\/a2ui5Polluted is no model path/);
    assert.equal(({}).a2ui5Polluted, undefined, 'Object.prototype is untouched');
    assert.equal(be.posts.length, 1, 'and nothing was sent');
    assert.equal(c.describe(s.session).pending, undefined, 'the refused act changed nothing');
    // the primitive itself, for its other callers (the pick, the rollback, the card renderer's way back)
    const data = {};
    assert.equal(setAt(data, '/__proto__/a2ui5Polluted', 1), false);
    assert.equal(setAt(data, '/X/constructor/prototype/a2ui5Polluted', 1), false);
    assert.equal(({}).a2ui5Polluted, undefined);
    assert.equal(setAt(data, '/T/0/Q', 1), true);
    assert.deepEqual(data, { T: [{ Q: 1 }] });
  } finally {
    delete Object.prototype.a2ui5Polluted;
  }
});

test('an edit of a sent path made in flight stays pending; a failed roundtrip rolls back only its own edits', async () => {
  let fail = false;
  const be = scripted((req, n, value) => {
    if (!value.S_FRONT.ID) return startAnswer();
    return fail ? { status: 500, body: 'boom' } : eventAnswer(n);
  });
  const c = be.client();
  const s = await c.start('z_t');
  let held = be.hold();
  const first = c.act(s.session, { values: { '/NAME': 'Ann' }, event: 'CHECK' });
  await held.received;
  await c.act(s.session, { values: { '/NAME': 'Bob' } });
  held.release();
  const a = await first;
  assert.deepEqual(be.posts[1].value.MODEL, { NAME: 'Ann' });
  assert.deepEqual(a.pending, ['/NAME'], 'the newer value of a sent path is a new edit');
  assert.equal(a.fields.find((f) => f.path === '/NAME').value, 'Bob');
  // a failing roundtrip: its own value rolled back, the one typed meanwhile kept
  fail = true;
  held = be.hold();
  const failing = c.act(a.session, { values: { '/NAME': 'Cid' }, event: 'CHECK' });
  await held.received;
  await c.act(a.session, { values: { '/ZIP': '1010' } });
  held.release();
  await rejects(failing, /HTTP 500: boom/);
  const after = c.describe(a.session);
  assert.deepEqual(after.pending, ['/NAME', '/ZIP']);
  assert.equal(after.fields.find((f) => f.path === '/NAME').value, 'Bob', 'the failed act\'s value is taken back');
  assert.equal(after.fields.find((f) => f.path === '/ZIP').value, '1010', 'the edit made in flight is not');
});

test('CSRF: a token layer\'s 403 is answered by a HEAD token fetch and ONE re-send of the same body; the token goes with every later POST', async () => {
  let token = null;
  const posts = [];
  const heads = [];
  const transport = async (req) => {
    if (req.method === 'HEAD') {
      heads.push(req);
      token = 'tok-1';
      return { status: 200, headers: { 'X-CSRF-Token': token }, body: '' };
    }
    posts.push(req);
    if (req.headers['x-csrf-token'] !== token || !token) return { status: 403, headers: { 'x-csrf-token': 'Required' }, body: 'CSRF token validation failed' };
    const value = JSON.parse(req.body).value;
    return { status: 200, body: JSON.stringify(value.S_FRONT.ID ? eventAnswer(posts.length) : startAnswer()) };
  };
  const c = createAppClient({ transport, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  const s = await c.start('z_t');
  assert.equal(heads.length, 1);
  assert.equal(heads[0].headers['x-csrf-token'], 'Fetch');
  assert.equal(heads[0].body, undefined, 'a HEAD has no body');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body, posts[0].body, 'the same body once more');
  assert.equal(posts[1].headers['x-csrf-token'], 'tok-1');
  assert.equal(posts[0].signal, posts[1].signal, 'still the one request: one timeout');
  await c.act(s.session, { event: 'CHECK' });
  assert.equal(posts[2].headers['x-csrf-token'], 'tok-1', 'the token travels with every later POST');
  assert.equal(heads.length, 1, 'no fetch while the token is accepted');
});

test('CSRF: the backend\'s own 403 is final, and a token fetch that brings none ends in the refusal - one re-send at most', async () => {
  let n = 0;
  let heads = 0;
  const final = createAppClient({ transport: async (req) => { if (req.method === 'HEAD') heads += 1; else n += 1; return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'CSRF validation failed - cross-origin request rejected' }; } });
  await rejects(final.start('z_x'), /^the backend refused the roundtrip - HTTP 403: CSRF validation failed - cross-origin request rejected$/);
  assert.deepEqual([n, heads], [1, 0], 'no fetch, no re-send');
  n = 0;
  heads = 0;
  const noToken = createAppClient({ transport: async (req) => {
    if (req.method === 'HEAD') { heads += 1; return { status: 200, headers: { 'x-csrf-token': 'Required' }, body: '' }; }
    n += 1;
    return { status: 403, headers: { 'x-csrf-token': 'required' }, body: 'CSRF token validation failed' };
  } });
  await rejects(noToken.start('z_x'), /^the backend refused the roundtrip - HTTP 403: CSRF token validation failed$/);
  assert.deepEqual([n, heads], [1, 1], 'a fetch without a token: no re-send');
  n = 0;
  heads = 0;
  const refusedAgain = createAppClient({ transport: async (req) => {
    if (req.method === 'HEAD') { heads += 1; return { status: 200, headers: { 'x-csrf-token': `t${heads}` }, body: '' }; }
    n += 1;
    return { status: 403, headers: { 'x-csrf-token': 'Required' }, body: 'CSRF token validation failed' };
  } });
  await rejects(refusedAgain.start('z_x'), /HTTP 403: CSRF token validation failed$/);
  assert.deepEqual([n, heads], [2, 1], 'the re-sent body refused again: reported, no loop');
  const throwing = createAppClient({ transport: async (req) => {
    if (req.method === 'HEAD') throw new Error('ECONNRESET');
    return { status: 403, headers: { 'x-csrf-token': 'Required' }, body: 'CSRF token validation failed' };
  } });
  await rejects(throwing.start('z_x'), /HTTP 403: CSRF token validation failed$/, 'a failed fetch reports the refusal that asked for it');
});

test('the default transport: the token fetch is a HEAD to baseUrl without a body, the session id a request header', async () => {
  const seen = [];
  const client = createAppClient({
    baseUrl: BASE,
    fetchImpl: async (url, init) => {
      seen.push({ url, ...init });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'x-csrf-token': 'abc' } });
      if (!init.headers['x-csrf-token']) return new Response('need a token', { status: 403, headers: { 'x-csrf-token': 'Required' } });
      const value = JSON.parse(init.body).value;
      return new Response(JSON.stringify(value.S_FRONT.ID ? eventAnswer(3) : startAnswer()), { status: 200, headers: { 'sap-contextid': 'SID:1' } });
    },
  });
  const s = await client.start('z_t');
  assert.deepEqual(seen.map((r) => r.method), ['POST', 'HEAD', 'POST']);
  assert.equal(seen[1].url, BASE);
  assert.equal('body' in seen[1], false, 'no body on the HEAD');
  assert.deepEqual(seen[1].headers, { 'x-csrf-token': 'Fetch' });
  await client.act(s.session, { event: 'CHECK' });
  assert.deepEqual(seen[3].headers, { 'content-type': 'application/json', 'sap-contextid-accept': 'header', 'sap-contextid': 'SID:1', 'x-csrf-token': 'abc' });
});

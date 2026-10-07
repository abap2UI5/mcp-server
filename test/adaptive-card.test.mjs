// format "adaptive-card" (lib/adaptive-card.mjs over the renderer vendored
// from abap2UI5/protocol): every screen of the recorded sample sessions
// renders as a structurally valid Adaptive Card 1.5 whose actions name the
// session (and the row of a row action), and a submitted card maps onto ONE
// app_act call that the agent client accepts and sends exactly as the
// recorded act - the card path replays the fixtures request for request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appCard, cardContent, cardSubmitToAct, messagesOf, defaultAppFormat, CARD_MIME, APP_FORMATS } from '../lib/adaptive-card.mjs';
import { CARD_VERSION, walk } from '../lib/vendor/adaptive-cards/render.mjs';
import { FIXTURES, fixture, replayClient, actionOf, targetOf } from './helpers/agent-replay.mjs';
import { createAppClient } from '../lib/appclient.mjs';

// ------------------------------------------------- Adaptive Cards 1.5 ----
// The subset of the 1.5 schema the renderer writes (the protocol
// repository's test/adaptive-cards.test.mjs checks the same).

const ELEMENTS = new Set(['TextBlock', 'RichTextBlock', 'Image', 'Container', 'ColumnSet', 'FactSet', 'ActionSet', 'Table',
  'Input.Text', 'Input.Number', 'Input.Date', 'Input.Time', 'Input.Toggle', 'Input.ChoiceSet']);
const ACTIONS = new Set(['Action.Submit', 'Action.OpenUrl']);

export function cardProblems(card) {
  const out = [];
  if (card.type !== 'AdaptiveCard' || card.version !== '1.5' || card.$schema !== 'http://adaptivecards.io/schemas/adaptive-card.json') out.push('not an AdaptiveCard 1.5');
  if (!Array.isArray(card.body)) out.push('no body');
  const ids = new Set();
  let n = 0;
  walk(card.body, (e) => {
    n += 1;
    const where = `#${n} ${e.type}`;
    if (typeof e.type !== 'string') {
      out.push(`${where}: no type`);
      return;
    }
    if (e.type.startsWith('Action.')) {
      if (!ACTIONS.has(e.type)) out.push(`${where}: unknown action`);
      if (e.type === 'Action.Submit' && e.data !== undefined && (typeof e.data !== 'object' || Array.isArray(e.data))) out.push(`${where}: data is no object`);
      return;
    }
    if (!ELEMENTS.has(e.type)) out.push(`${where}: unknown element`);
    if (e.type === 'TextBlock' && typeof e.text !== 'string') out.push(`${where}: TextBlock without text`);
    if (e.type.startsWith('Input.')) {
      if (!e.id) out.push(`${where}: input without id`);
      if (ids.has(e.id)) out.push(`${where}: duplicate id ${e.id}`);
      ids.add(e.id);
    }
    if (e.type === 'Input.Toggle' && !e.title) out.push(`${where}: Input.Toggle without title`);
    if (e.type === 'Input.ChoiceSet' && !(e.choices && e.choices.length)) out.push(`${where}: Input.ChoiceSet without choices`);
    if (e.type === 'ActionSet' && !Array.isArray(e.actions)) out.push(`${where}: ActionSet without actions`);
    if (e.type === 'Table') {
      for (const [r, row] of e.rows.entries()) {
        if (row.type !== 'TableRow') out.push(`${where}.rows[${r}]: no TableRow`);
        if (row.cells.length > e.columns.length) out.push(`${where}.rows[${r}]: more cells than columns`);
      }
    }
  });
  return out;
}

const submits = (card) => {
  const out = [];
  walk(card.body, (e) => { if (e.type === 'Action.Submit' && e.data) out.push(e); });
  return out;
};
const inputs = (card) => {
  const out = [];
  walk(card.body, (e) => { if (e.type && e.type.startsWith('Input.')) out.push(e); });
  return out;
};

/** What a card host submits for an action: its data, merged with every input's value (strings, as a card submits them). */
function submitted(card, action, typed = {}) {
  const payload = { ...action.data };
  for (const i of inputs(card)) payload[i.id] = typed[i.id] !== undefined ? typed[i.id] : (i.value ?? '');
  return payload;
}
const asCardString = (v) => (Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? String(v) : v === null || v === undefined ? '' : String(v));

// ------------------------------------------------------------ tests ----

test('every screen of the recorded sessions renders a valid Adaptive Card 1.5 whose actions name the session', async () => {
  let cards = 0;
  for (const name of FIXTURES) {
    const { client } = replayClient(name);
    let snap = null;
    for (const step of fixture(name).steps) {
      snap = step.op === 'start' ? await client.start(step.arg) : await client.act(snap.session, step.arg);
      const { card } = appCard(client.screen(snap.session), snap.session);
      assert.equal(card.version, CARD_VERSION);
      assert.deepEqual(cardProblems(card), [], `${name}: ${JSON.stringify(card).slice(0, 300)}`);
      for (const a of submits(card)) assert.equal(a.data.session, snap.session, `${name}: every Action.Submit names the session`);
      cards++;
    }
  }
  assert.ok(cards >= 30, `${cards} cards`);
});

test('a row action in a table carries its row index', async () => {
  const { client } = replayClient('args-537');
  const snap = await client.start(fixture('args-537').steps[0].arg);
  const { card } = appCard(client.screen(snap.session), snap.session);
  const rowActs = submits(card).filter((a) => a.data.row !== undefined);
  assert.ok(rowActs.length >= 2, 'the table has row actions');
  const rows = [...new Set(rowActs.map((a) => a.data.row))].sort((x, y) => x - y);
  assert.deepEqual(rows, rows.map((_, i) => i), 'rows count from 0 in table order');
  const t = snap.tables[0];
  assert.ok(rows.length <= t.rowCount);
});

test('a submitted card maps to ONE app_act call that sends exactly the recorded request', async () => {
  let viaCard = 0;
  for (const name of FIXTURES) {
    const { client, sent, exchanges } = replayClient(name);
    let snap = null;
    for (const step of fixture(name).steps) {
      if (step.op === 'start') {
        snap = await client.start(step.arg);
        continue;
      }
      const a = step.arg;
      const action = !a.args && actionOf(snap, a.event, a.row);
      const { card } = appCard(client.screen(snap.session), snap.session);
      const candidates = action ? submits(card).filter((s) => {
        if (action.event.startsWith('@CLOSE_')) return Array.isArray(s.data.client) && `@CLOSE_${s.data.client[3]}` === action.event;
        return s.data.event === action.event && (a.row === undefined || s.data.row === a.row);
      }) : [];
      if (!candidates.length) {
        // not on the card (a toast's or a timer's event, explicit browser args): the agent's call
        snap = await client.act(snap.session, a);
        continue;
      }
      const typed = {};
      for (const [k, v] of Object.entries(a.values || {})) {
        const t = targetOf(snap, k);
        typed[t.kind === 'field' ? t.field.path : t.path] = asCardString(v);
      }
      const act = cardSubmitToAct(snap, submitted(card, candidates[0], typed));
      assert.equal(act.session, snap.session);
      const { session, ...rest } = act;
      snap = await client.act(session, rest);
      viaCard++;
    }
    assert.equal(sent.length, exchanges.length, `${name}: every recorded request was sent`);
  }
  assert.ok(viaCard >= 12, `the card path covered ${viaCard} acts`);
});

test('cardSubmitToAct: the documented mapping', () => {
  const snap = {
    snapshotVersion: 1, session: 'S1', app: 'Z', title: '', layer: 'main',
    fields: [
      { id: 'f1', path: '/NAME', name: 'NAME', label: 'Name', kind: 'text', value: 'Ada', editable: true },
      { id: 'f2', path: '/OK', name: 'OK', label: 'OK', kind: 'boolean', value: false, editable: true },
      { id: 'f3', path: '/TAGS', name: 'TAGS', label: 'Tags', kind: 'multichoice', value: ['A'], values: [{ key: 'A' }, { key: 'B' }], editable: true },
      { id: 'f4', path: '/QTY', name: 'QTY', label: 'Qty', kind: 'number', value: 3, editable: true },
    ],
    actions: [
      { id: 'a1', event: 'SAVE', args: ['$model:/NAME'], label: 'Save', control: 'sap.m.Button', trigger: 'press', enabled: true, scope: 'screen', layer: 'main' },
      { id: 'a2', event: 'CLOSED', args: ['$action'], label: 'close message box (YES | NO)', control: 'sap.m.MessageBox', trigger: 'close', enabled: true, scope: 'screen', layer: 'main' },
    ],
    tables: [{ id: 't1', path: '/T', name: 'T', label: 'T', columns: [{ name: 'X' }], rowCount: 2, rows: [{ X: 'a', SEL: false }, { X: 'b', SEL: false }], editableCells: ['SEL'], selectionField: 'SEL' }],
    messages: [], texts: [], unsupported: [],
  };
  // unchanged inputs send nothing; args and refs are app_act's to fill
  assert.deepEqual(cardSubmitToAct(snap, { event: 'SAVE', args: ['Ada'], refs: ['/NAME'], session: 'S1', '/NAME': 'Ada', '/OK': 'false', '/TAGS': 'A', '/QTY': '3', '/T/0/SEL': 'false' }),
    { session: 'S1', event: 'SAVE' });
  // changed ones go out in the shape app_act takes
  assert.deepEqual(cardSubmitToAct(snap, { event: 'SAVE', session: 'S1', '/NAME': 'Bob', '/OK': 'true', '/TAGS': 'A,B', '/QTY': '4', '/T/1/SEL': 'true', '/NAME#2': 'Bob' }),
    { session: 'S1', event: 'SAVE', values: { '/NAME': 'Bob', '/OK': true, '/TAGS': ['A', 'B'], '/QTY': '4', '/T/1/SEL': true } });
  assert.deepEqual(cardSubmitToAct(snap, { event: 'ROW', row: 1 }), { session: 'S1', event: 'ROW', row: 1 }, 'the session defaults to the snapshot\'s');
  assert.deepEqual(cardSubmitToAct(snap, { box: 'NO', session: 'S1' }), { session: 'S1', event: 'a2', args: ['NO'] });
  assert.equal(cardSubmitToAct({ ...snap, actions: [] }, { box: 'OK' }), null, 'a box without onClose sends nothing');
  assert.deepEqual(cardSubmitToAct(snap, { client: ['CONTROL_GLOBAL', 'VIEW_SLOTS', 'destroy', 'POPUP'], slot: 'POPUP' }), { session: 'S1', event: '@CLOSE_POPUP' });
  assert.throws(() => cardSubmitToAct(snap, { client: ['OPEN_NEW_TAB', 'https://x'] }), /runs in a browser only/);
  assert.throws(() => cardSubmitToAct(snap, { '/NAME': 'x' }), /names no event/);
  assert.throws(() => cardSubmitToAct(snap, null), /is an object/);
  assert.throws(() => cardSubmitToAct(null, { event: 'X' }), /snapshot/);
});

test('the card travels as an embedded resource; the format is off by default', () => {
  assert.deepEqual(APP_FORMATS, ['snapshot', 'adaptive-card']);
  assert.equal(defaultAppFormat({}), 'snapshot');
  assert.equal(defaultAppFormat({ A2UI5_MCP_APP_FORMAT: 'adaptive-card' }), 'adaptive-card');
  assert.equal(defaultAppFormat({ A2UI5_MCP_APP_FORMAT: 'html' }), 'snapshot');
  const c = cardContent({ type: 'AdaptiveCard', version: '1.5', body: [] }, 'S/1');
  assert.equal(c.type, 'resource');
  assert.equal(c.resource.mimeType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(c.resource.mimeType, CARD_MIME);
  assert.equal(c.resource.uri, 'abap2ui5://app-card/S%2F1');
  assert.deepEqual(JSON.parse(c.resource.text), { type: 'AdaptiveCard', version: '1.5', body: [] });
});

test('messagesOf reads toasts and message boxes of the last response, CONTROL_GLOBAL or not', () => {
  assert.deepEqual(messagesOf({ custom: [
    ['MESSAGE_TOAST', 'show', 'saved', { onClose: 'X' }],
    ['CONTROL_GLOBAL', 'MESSAGE_BOX', 'confirm', 'sure?', { actions: ['YES', 'NO'] }],
    ['SET_FOCUS', 'x'],
  ] }), [
    { kind: 'toast', text: 'saved' },
    { kind: 'box', type: 'confirm', text: 'sure?', actions: ['YES', 'NO'] },
  ]);
  assert.deepEqual(messagesOf({}), []);
});

test('a long table: the card shows the snapshot\'s rows only, and an untouched submit writes nothing back', async () => {
  /* The renderer wrote every row of a list binding: 5,000 rows were 5,000
   * inputs (~1 MB) next to a snapshot of 20, and Save on the untouched card
   * sent the 4,980 rows the snapshot did not show as edits. */
  const xml = '<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc"><Page title="T"><Table items="{/T}">'
    + '<columns><Column/><Column/></columns><items><ColumnListItem><cells><Text text="{NAME}"/><Input value="{QTY}"/></cells></ColumnListItem></items></Table>'
    + '<Button text="Save" press=".eB([\'SAVE\'])"/></Page></mvc:View>';
  const model = { T: Array.from({ length: 5000 }, (_, i) => ({ NAME: `n${i}`, QTY: String(i) })) };
  const transport = async () => ({
    status: 200,
    body: JSON.stringify({ S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', xml]] } }, MODEL: model }),
  });
  const client = createAppClient({ transport, location: (app) => ({ origin: 'x', pathname: '/', search: `?app_start=${app}` }) });
  const snap = await client.start('z_t');
  assert.equal(snap.tables[0].rows.length, 20);
  const { card } = appCard(client.screen(snap.session), snap.session, snap);
  assert.equal(inputs(card).length, 20, 'one input per shown row');
  assert.equal(client.screen(snap.session).models[Object.keys(client.screen(snap.session).models)[0]].data.T.length, 5000, 'the session state is not cut');
  const save = submits(card).find((a) => a.data.event === 'SAVE');
  const act = cardSubmitToAct(snap, { ...submitted(card, save), '/T/4000/QTY': '4000' });
  assert.equal(act.values, undefined, 'nothing differs from what the card showed; a row it did not show is no edit');
});

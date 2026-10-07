// The agent snapshot (lib/snapshot.mjs) and its parsers (lib/viewxml.mjs),
// sibling-free: the parsers on literal input, the snapshot on RECORDED backend
// responses - test/fixtures/agent/*.json, real request/response pairs of
// abap2UI5/samples and samples-controls apps and of abap-cloud-gui's
// report2cloud runtime harness (cgui-*) driven through lib/appclient.mjs against
// @abap2ui5/node-runtime 1.146.0 (each fixture says so). A shape change of the
// snapshot is a contract change for the VS Code extension and the ABAP addon
// (docs/agent-snapshot.md); the shape test below is where it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseViewXml, parseBinding, evalExpression, parseWire, describeArg, controlName } from '../lib/viewxml.mjs';
import { buildSnapshot, analyzeScreen, applyResponse, emptyState, nameOfPath, FRONTEND_EVENTS, SNAPSHOT_VERSION } from '../lib/snapshot.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));

/** The state after the first `n` responses of a fixture (all by default). */
function stateOf(name, n = Infinity) {
  let st = emptyState();
  const steps = fixture(name).steps.filter((s) => s.exchange).slice(0, n);
  for (const s of steps) st = applyResponse(st, s.exchange.response);
  return st;
}
const snapOf = (name, n, opts = {}) => buildSnapshot({ state: stateOf(name, n), ...opts });
const byLabel = (s, label) => s.fields.find((f) => f.label === label);
const byEvent = (s, event) => s.actions.find((a) => a.event === event);

// --------------------------------------------------------------- viewxml ----

test('parseViewXml resolves namespaces, decodes entities and nests aggregations', () => {
  const root = parseViewXml('<?xml version="1.0"?><mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc" xmlns:f="sap.ui.layout.form">'
    + '<!-- c --><f:SimpleForm><f:content><Label text="A &amp; B &#x41;"/><Input value=\'{/X}\'/></f:content></f:SimpleForm>'
    + '<core:HTML xmlns:core="sap.ui.core" content="&lt;b&gt;"/><Text>inline</Text></mvc:View>');
  const view = root.children[0];
  assert.equal(controlName(view), 'sap.ui.core.mvc.View');
  const form = view.children[0];
  assert.equal(controlName(form), 'sap.ui.layout.form.SimpleForm');
  const [label, input] = form.children[0].children;
  assert.equal(controlName(label), 'sap.m.Label');
  assert.equal(label.attrs.text, 'A & B A');
  assert.equal(input.attrs.value, '{/X}');
  assert.equal(controlName(view.children[1]), 'sap.ui.core.HTML');
  assert.equal(view.children[1].attrs.content, '<b>');
  assert.equal(view.children[2].text, 'inline');
});

test('parseBinding tells literals, paths, typed paths, expressions and composites apart', () => {
  assert.deepEqual(parseBinding('plain'), { kind: 'literal', value: 'plain' });
  assert.deepEqual(parseBinding('a \\{ b \\}'), { kind: 'literal', value: 'a { b }' });
  assert.deepEqual(parseBinding('{/S_SCREEN/NAME}'), { kind: 'path', path: '/S_SCREEN/NAME', model: '', relative: false });
  assert.deepEqual(parseBinding('{TITLE}'), { kind: 'path', path: 'TITLE', model: '', relative: true });
  assert.deepEqual(parseBinding('{i18n>title}'), { kind: 'path', path: 'title', model: 'i18n', relative: true });
  const typed = parseBinding("{ path: '/AMOUNT', type: 'sap.ui.model.type.Integer' }");
  assert.equal(typed.kind, 'path');
  assert.equal(typed.path, '/AMOUNT');
  assert.equal(typed.type, 'sap.ui.model.type.Integer');
  assert.equal(parseBinding("{path: '/T_TAB', templateShareable: false}").path, '/T_TAB');
  assert.equal(parseBinding('{= ${/X} > 1 }').kind, 'expression');
  const comp = parseBinding('Total: {/SUM} EUR');
  assert.equal(comp.kind, 'composite');
  assert.deepEqual(comp.parts.map((p) => p.text ?? p.path), ['Total: ', '/SUM', ' EUR']);
  assert.equal(parseBinding("{ path: '/D', formatter: 'f.x' }").kind, 'composite', 'a formatter makes it one-way');
});

test('evalExpression evaluates the operators views use, and nothing it cannot read', () => {
  const data = { EDIT: true, MODE: 'A', N: 3, LIST: [1, 2] };
  const get = (p) => data[p.replace(/^\//, '')];
  assert.equal(evalExpression(' ${/EDIT} ', get), true);
  assert.equal(evalExpression('!${/EDIT}', get), false);
  assert.equal(evalExpression("${/MODE} === 'A' && ${/N} > 2", get), true);
  assert.equal(evalExpression("${/MODE} !== 'A' || ${/N} <= 2", get), false);
  assert.equal(evalExpression('${/LIST}.length > 1 ? true : false', get), true);
  assert.equal(evalExpression("(${/N} + 1) * 2 === 8", get), true);
  assert.equal(evalExpression('${/N}.toFixed(2)', get), undefined, 'a call is not evaluated');
  assert.equal(evalExpression('odata.compare(1,2)', get), undefined);
  assert.equal(evalExpression('${/N} >', get), undefined);
});

test('parseWire reads eB, eBP and eF handlers and describes every argument kind', () => {
  assert.deepEqual(parseWire(".eB(['SAVE'])"), { fn: 'eB', event: 'SAVE', flags: [], args: [] });
  const w = parseWire(".eB(['ROW',false,false,false,true], ${NAME}, 'it\\'s, a', ${/S/X}, ${$source>/text}, ${$parameters>/selectedItem}, $event, ${QTY} * 10, 5)");
  assert.equal(w.event, 'ROW');
  assert.deepEqual(w.flags, ['false', 'false', 'false', 'true']);
  assert.deepEqual(w.args.map((a) => (a.static ? a.value : a.describe)), [
    '$row:NAME', "it's, a", '$model:/S/X', '$source:text', '$parameters:selectedItem', '$event', '$expr:${QTY} * 10', 5,
  ]);
  assert.equal(parseWire(".eBP($event, true, ['NAV'], 'x')").event, 'NAV');
  assert.deepEqual(parseWire(".eBP($event, true, ['NAV'], 'x')").args, [{ static: true, value: 'x' }]);
  const f = parseWire(".eF('CONTROL_GLOBAL', 'VIEW_SLOTS', 'destroy', 'POPUP')");
  assert.equal(f.fn, 'eF');
  assert.equal(f.action, 'CONTROL_GLOBAL');
  assert.deepEqual(f.args.map((a) => a.value), ['VIEW_SLOTS', 'destroy', 'POPUP']);
  assert.equal(parseWire("press('x')"), null);
  assert.equal(parseWire(".eB('SAVE')"), null, 'a string where the event array belongs is no wire');
  assert.deepEqual(describeArg("'a\\'b'"), { static: true, value: "a'b" });
});

test('parseWire takes linear time over a run of blanks after a parenthesis, and still takes one semicolon', () => {
  // \)\s*;?\s*$ retried both \s* splits of the run after every ')'
  const blanks = ' '.repeat(100000);
  const t0 = Date.now();
  assert.equal(parseWire(`.eB(['X'])${blanks}x`), null);
  assert.equal(parseWire(`.eB(['X']${') '.repeat(50000)}x`), null);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  for (const ok of [".eB(['X'])", ".eB(['X']);", ".eB(['X']) \t;", ` .eB(['X'])${blanks};${blanks}`, ".eB(['X'], 'a)') ;"]) assert.equal(parseWire(ok)?.event, 'X', JSON.stringify(ok.slice(0, 30)));
  for (const no of [".eB(['X']);;", ".eB(['X']) ; ;", ".eB(['X'])x", ".eB(['X']) ;x"]) assert.equal(parseWire(no), null, no);
});

test('nameOfPath derives the ABAP-ish name, without the old /XX/ two-way prefix', () => {
  assert.equal(nameOfPath('/MS_HEAD/KUNNR'), 'MS_HEAD-KUNNR');
  assert.equal(nameOfPath('/XX/MS_HEAD/KUNNR'), 'MS_HEAD-KUNNR');
  assert.equal(nameOfPath('/NAME'), 'NAME');
});

// --------------------------------------------------------- applyResponse ----

test('applyResponse: a popup app\'s model never overwrites the caller\'s view behind it', () => {
  // samples 012 -> BUTTON_POPUP_06 opens z2ui5_cl_smp_app_020 as a sub-app popup
  const st = stateOf('popup-012');
  // the last step navigated back: MAIN re-displayed by 012, popup gone
  assert.equal(st.app, 'Z2UI5_CL_SMP_APP_012');
  assert.equal(st.slots.POPUP, undefined);
  const mid = stateOf('popup-012', 3); // start, popup_03, popup_06
  assert.equal(mid.app, 'Z2UI5_CL_SMP_APP_020');
  assert.equal(mid.slots.MAIN.app, 'Z2UI5_CL_SMP_APP_012', 'MAIN still shows the caller');
  assert.equal(mid.slots.POPUP.app, 'Z2UI5_CL_SMP_APP_020');
  assert.equal(mid.models.POPUP.app, 'Z2UI5_CL_SMP_APP_020');
});

test('applyResponse: a response without MODEL keeps the models, a MAIN display drops popup and popover', () => {
  let st = applyResponse(emptyState(), {
    S_FRONT: { ID: '1', APP: 'Z_A', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', '<A/>'], ['VIEW_SLOTS', 'display', 'POPOVER', '<B/>', { openById: 'x' }]] } },
    MODEL: { X: 1 },
  });
  assert.deepEqual(Object.keys(st.slots).sort(), ['MAIN', 'POPOVER']);
  st = applyResponse(st, { S_FRONT: { ID: '2', APP: 'Z_A' } });
  assert.equal(st.id, '2');
  assert.deepEqual(st.models.MAIN.data, { X: 1 });
  st = applyResponse(st, { S_FRONT: { ID: '3', APP: 'Z_A' }, MODEL: { X: 2 } });
  assert.deepEqual(st.models.MAIN.data, { X: 2 }, 'a MODEL is pushed into the open slots of its app');
  assert.deepEqual(st.models.POPOVER.data, { X: 2 });
  st = applyResponse(st, { S_FRONT: { ID: '4', APP: 'Z_A', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', '<C/>']] } }, MODEL: { X: 3 } });
  assert.deepEqual(Object.keys(st.slots), ['MAIN']);
  st = applyResponse(st, { S_FRONT: { ID: '5', APP: 'Z_A', S_ACTION: { T_CUSTOM: [['MESSAGE_TOAST', 'show', 'hi']] } } });
  assert.deepEqual(st.custom, [['MESSAGE_TOAST', 'show', 'hi']]);
});

test('applyResponse: a response of another APP takes the popup and the popover down (spec/response.md "View slots")', () => {
  let st = applyResponse(emptyState(), {
    S_FRONT: { ID: '1', APP: 'Z_A', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', '<A/>'], ['VIEW_SLOTS', 'display', 'POPOVER', '<B/>', { openById: 'x' }]] } },
    MODEL: { X: 1 },
  });
  // the same app answering keeps its popover
  st = applyResponse(st, { S_FRONT: { ID: '2', APP: 'Z_A' } });
  assert.ok(st.slots.POPOVER, 'the same APP keeps the popover');
  // a popup app takes over: its own dialog, no MAIN display, no destroy
  st = applyResponse(st, { S_FRONT: { ID: '3', APP: 'Z_POP', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'POPUP', '<D/>']] } }, MODEL: { Y: 2 } });
  assert.deepEqual(Object.keys(st.slots).sort(), ['MAIN', 'POPUP'], 'the previous app\'s popover is gone, the new popup open');
  assert.equal(st.models.POPOVER, undefined, 'with its model');
  assert.equal(st.slots.POPUP.app, 'Z_POP');
  assert.deepEqual(st.models.MAIN, { app: 'Z_A', data: { X: 1 } }, 'the caller\'s page behind it keeps its model');
  // back to the caller without a destroy: the popup app's popup goes too
  st = applyResponse(st, { S_FRONT: { ID: '4', APP: 'Z_A' } });
  assert.deepEqual(Object.keys(st.slots), ['MAIN']);
  assert.equal(st.models.POPUP, undefined);
  // a response without APP changes nothing about the slots
  st = applyResponse(st, { S_FRONT: { ID: '5', APP: 'Z_A', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'POPUP', '<E/>']] } } });
  st = applyResponse(st, { S_FRONT: { ID: '6' } });
  assert.ok(st.slots.POPUP, 'no APP in the response: no app change');
});

// ------------------------------------------------------ snapshot: shape ----

const CONTRACT_KEYS = ['snapshotVersion', 'session', 'app', 'title', 'layer', 'fields', 'actions', 'tables', 'messages', 'texts', 'unsupported'];
const FIELD_KEYS = ['id', 'path', 'name', 'label', 'control', 'kind', 'value', 'required', 'editable', 'layer'];
const ACTION_KEYS = ['id', 'event', 'args', 'label', 'control', 'trigger', 'enabled', 'scope', 'layer'];
const TABLE_KEYS = ['id', 'path', 'name', 'label', 'control', 'columns', 'rowCount', 'rows', 'truncated', 'selectionMode', 'editableCells', 'layer'];
// type, text and source always; the others optional, in this order
const MESSAGE_KEYS = ['type', 'text', 'source', 'field', 'subtitle', 'description'];

test('every fixture snapshot has exactly the contract\'s shape (Contract B, snapshot v1)', () => {
  for (const file of fs.readdirSync(FIX).filter((f) => f.endsWith('.json'))) {
    const name = file.replace(/\.json$/, '');
    const s = snapOf(name);
    const where = `${name}: `;
    assert.deepEqual(Object.keys(s), CONTRACT_KEYS, `${where}top-level keys`);
    assert.equal(s.snapshotVersion, SNAPSHOT_VERSION);
    assert.ok(['main', 'popup', 'popover'].includes(s.layer), where);
    for (const f of s.fields) {
      assert.deepEqual(Object.keys(f).filter((k) => k !== 'values'), FIELD_KEYS, `${where}field ${f.id}`);
      assert.ok(['text', 'number', 'boolean', 'date', 'time', 'datetime', 'choice', 'multichoice', 'textarea'].includes(f.kind), `${where}${f.kind}`);
      if (f.values) assert.ok(['choice', 'multichoice'].includes(f.kind), `${where}values only on choices`);
    }
    for (const a of s.actions) {
      assert.deepEqual(Object.keys(a).filter((k) => k !== 'table'), ACTION_KEYS, `${where}action ${a.id}`);
      assert.ok(['screen', 'row'].includes(a.scope));
      assert.equal(a.scope === 'row', Boolean(a.table), `${where}table exactly on row actions`);
    }
    for (const t of s.tables) {
      assert.deepEqual(Object.keys(t).filter((k) => k !== 'selectionField'), TABLE_KEYS, `${where}table ${t.id}`);
      assert.ok(['None', 'Single', 'Multi'].includes(t.selectionMode));
    }
    for (const m of s.messages) {
      assert.ok(['success', 'info', 'warning', 'error'].includes(m.type), `${where}${m.type}`);
      assert.ok(['toast', 'box', 'strip', 'field', 'model', 'popover', 'messageview'].includes(m.source), `${where}${m.source}`);
      assert.deepEqual(Object.keys(m), MESSAGE_KEYS.filter((k) => k in m), `${where}message keys`);
      assert.ok(['type', 'text', 'source'].every((k) => k in m), `${where}message keys`);
    }
    assert.ok(s.texts.length <= 30);
    // ids are f1.., a1.., t1.. in order
    s.fields.forEach((f, i) => assert.equal(f.id, `f${i + 1}`));
    s.actions.forEach((a, i) => assert.equal(a.id, `a${i + 1}`));
    s.tables.forEach((t, i) => assert.equal(t.id, `t${i + 1}`));
  }
});

// ----------------------------------------------- snapshot: the samples ----

test('form (samples 381): inputs, a number input, selects with static items, checkboxes, labels from the SimpleForm', () => {
  const s = snapOf('form-381', 1);
  assert.equal(s.app, 'Z2UI5_CL_SMP_APP_381');
  assert.equal(s.title, 'abap2UI5 - Message - MessageToast via the Global Object');
  assert.equal(s.layer, 'main');
  assert.deepEqual(byLabel(s, 'Message'), {
    id: 'f1', path: '/MESSAGE', name: 'MESSAGE', label: 'Message', control: 'sap.m.Input', kind: 'text',
    value: 'This is a message toast.', required: false, editable: true, layer: 'main',
  });
  assert.equal(byLabel(s, 'Duration (ms)').kind, 'number');
  const my = byLabel(s, 'my');
  assert.equal(my.kind, 'choice');
  assert.equal(my.values.length, 15);
  assert.deepEqual(my.values[0], { key: 'begin top', text: 'begin top' });
  const collision = byLabel(s, 'collision');
  assert.deepEqual(collision.values[1], { key: 'flip flip', text: 'flip flip - flip to the opposite side' });
  const dock = s.fields.find((f) => f.path === '/DOCK_TO_ANCHOR');
  assert.equal(dock.kind, 'boolean');
  assert.equal(dock.value, false);
  assert.equal(dock.label, 'of - dock to the anchor box instead of the window');
  // the nav button is hidden (showNavButton false): no Back action
  assert.deepEqual(s.actions.map((a) => a.event), ['SHOW']);
  assert.equal(byEvent(s, 'SHOW').label, 'Show Message Toast');
  assert.ok(s.texts.includes('the onclose event: no toast closed yet'), 'a Text after a form label carries the label');
  assert.equal(s.messages[0].source, 'strip');
  assert.ok(s.unsupported.some((u) => /raw HTML/.test(u)));
  assert.ok(s.unsupported.some((u) => /frontend action CONTROL_GLOBAL\("MESSAGE_TOAST"/.test(u)));
});

test('form (samples 381): after SHOW the toast is a message, and its onClose event an action', () => {
  const s = snapOf('form-381', 2);
  // the response carries no MODEL (nothing bound changed on the backend's
  // side): the folded state alone still shows the start value - the typed
  // one lives in the client's model (test/appclient.test.mjs)
  assert.equal(s.fields[0].value, 'This is a message toast.');
  assert.deepEqual(s.messages.filter((m) => m.source === 'toast'), [{ type: 'info', text: 'hello agent', source: 'toast' }]);
  const closed = byEvent(s, 'TOAST_CLOSED');
  assert.equal(closed.control, 'sap.m.MessageToast');
  assert.equal(closed.trigger, 'close');
  const after = snapOf('form-381', 3);
  assert.equal(byEvent(after, 'TOAST_CLOSED'), undefined, 'a toast lives for one response');
  assert.ok(after.texts.some((t) => /toast closed 1 time/.test(t)));
});

test('table (samples 011): columns from the headers, selection bound to SELKZ, editable cells follow the row data', () => {
  const s = snapOf('table-011', 1, { maxRows: 2 });
  const [t] = s.tables;
  assert.equal(t.path, '/T_TAB');
  assert.equal(t.label, 'title of the table');
  assert.deepEqual(t.columns.map((c) => `${c.name}:${c.label}`), ['TITLE:Title', 'VALUE:Color', 'INFO:Info', 'DESCR:Description', 'CHECKBOX:Checkbox']);
  assert.equal(t.rowCount, 6);
  assert.equal(t.rows.length, 2);
  assert.equal(t.truncated, true);
  assert.deepEqual(t.rows[0], { TITLE: 'entry 01', VALUE: 'red', INFO: 'completed', DESCR: 'this is a description', CHECKBOX: true, SELKZ: false });
  assert.equal(t.selectionMode, 'Multi');
  assert.equal(t.selectionField, 'SELKZ');
  assert.deepEqual(t.editableCells, ['SELKZ'], 'enabled="{EDITABLE}" is false in every row');
  const edit = snapOf('table-011', 2).tables[0];
  assert.deepEqual(edit.editableCells, ['TITLE', 'VALUE', 'INFO', 'DESCR', 'CHECKBOX', 'SELKZ']);
  const deleted = snapOf('table-011', 3).tables[0];
  assert.equal(deleted.rowCount, 5);
  assert.equal(deleted.rows[0].TITLE, 'changed');
  assert.equal(deleted.rows[1].TITLE, 'entry 03', 'the selected row 1 is gone');
  assert.ok(!s.texts.includes('title of the table'), 'the table label is not repeated as a text');
});

test('popup flow (samples 009): only the popup layer is actionable, its table selection is a cell', () => {
  const main = snapOf('popup-009', 1);
  assert.deepEqual(main.fields.map((f) => f.label), [
    'Input with suggestion items', 'Input only numbers allowed', 'Input with value', 'Custom value Popup', 'Custom value Popup (lastname)',
  ]);
  const vh = byEvent(main, 'POPUP_TABLE_VALUE');
  assert.equal(vh.trigger, 'valueHelpRequest');
  assert.equal(vh.label, 'Input with value: valueHelpRequest');
  const pop = snapOf('popup-009', 2);
  assert.equal(pop.layer, 'popup');
  assert.equal(pop.title, 'abap2UI5 - Value Help');
  assert.deepEqual(pop.fields, []);
  assert.deepEqual(pop.actions.map((a) => `${a.event}/${a.layer}`), ['POPUP_TABLE_VALUE_CONTINUE/popup']);
  assert.equal(pop.tables[0].selectionMode, 'Single');
  assert.deepEqual(pop.tables[0].editableCells, ['SELKZ']);
  const back = snapOf('popup-009', 3);
  assert.equal(back.layer, 'main');
  assert.equal(byLabel(back, 'Input with value').value, 'BLACK', 'the value the popup chose');
  assert.equal(byLabel(back, 'Custom value Popup').value, 'Smith');
  assert.deepEqual(back.messages.filter((m) => m.source === 'toast').map((m) => m.text), ['value selected']);
  const sent = snapOf('popup-009', 4);
  assert.deepEqual(sent.messages.filter((m) => m.source === 'box'), [{ type: 'info', text: 'success - values sent to the server', source: 'box' }]);
});

test('popup closed in the browser (samples 012): the eF close wire is the @CLOSE_POPUP action', () => {
  const s = snapOf('popup-012', 2);
  assert.equal(s.layer, 'popup');
  assert.deepEqual(s.actions.map((a) => a.event), [FRONTEND_EVENTS.POPUP]);
  assert.deepEqual(s.unsupported, []);
  const sub = snapOf('popup-012', 3);
  assert.equal(sub.app, 'Z2UI5_CL_SMP_APP_020');
  assert.deepEqual(sub.actions.map((a) => a.event), ['POPUP_DECIDE_CANCEL', 'POPUP_DECIDE_CONTINUE']);
});

test('row actions (samples 048, 537, 070): template wires are row scope with $row arguments', () => {
  const list = snapOf('list-048', 1);
  const edit = byEvent(list, 'EDIT');
  assert.equal(edit.scope, 'row');
  assert.equal(edit.table, 't1');
  assert.deepEqual(edit.args, ['$row:TITLE', '$row:DESCR', '$row:ICON', '$row:HIGHLIGHT', '$row:INFO', '$row:SELECTED']);
  assert.equal(edit.label, 'row detailPress (Detail)');
  assert.equal(byEvent(list, 'SELCHANGE').scope, 'row', 'a row event on the list itself');
  assert.equal(list.tables[0].control, 'sap.m.List');
  assert.deepEqual(list.tables[0].columns.map((c) => c.name), ['TITLE', 'DESCR', 'ICON', 'INFO', 'HIGHLIGHT']);
  const args = snapOf('args-537', 1);
  assert.deepEqual(byEvent(args, 'ROW').args.slice(0, 2), ['$row:PRODUCT', '$expr:${QUANTITY} * 10']);
  assert.equal(byEvent(args, 'LITERAL').scope, 'screen');
  const grid = snapOf('grid-070', 1);
  const t = grid.tables[0];
  assert.equal(t.control, 'sap.ui.table.Table');
  assert.equal(t.label, 'Products');
  assert.deepEqual(t.columns.slice(1, 4).map((c) => `${c.name}:${c.label}`), ['ROW_ID:Index', 'COL3:Process Indicator', 'PRODUCT:Product']);
  assert.ok(!t.editableCells.includes('PRODUCT'), 'an Input with editable="false" is no editable cell');
  assert.deepEqual(grid.actions.filter((a) => a.scope === 'row').map((a) => a.event), ['ROW_ACTION_ITEM_NAVIGATION', 'ROW_ACTION_ITEM_EDIT']);
  assert.equal(byEvent(grid, 'SORT').scope, 'screen');
  assert.equal(byEvent(grid, 'SORT').label, 'Products: sort', 'a table event is labelled by its table');
  assert.ok(grid.fields.some((f) => f.path === '/LV_SELKZ'), 'a column header that is a control is on the screen');
});

test('messages (samples 467): the MessageManager table targets its field, typed bindings refine the kind', () => {
  const s = snapOf('messages-467');
  assert.equal(byLabel(s, 'Amount (integer only - validation collected automatically)').kind, 'number');
  assert.deepEqual(s.messages.filter((m) => m.source !== 'strip'), [
    { type: 'error', text: 'Please enter a valid name', source: 'field', field: 'f1' },
    { type: 'info', text: 'Draft saved automatically', source: 'model' },
  ]);
  assert.ok(s.unsupported.some((u) => /named model 'message'/.test(u)));
});

test('popover (samples 026) keeps the page actionable; nested views (065) are part of the main layer', () => {
  const s = snapOf('popover-026', 2);
  assert.equal(s.layer, 'popover');
  assert.equal(s.title, 'Popover Title');
  assert.deepEqual(s.fields.map((f) => f.layer), ['main', 'popover']);
  assert.ok(s.actions.some((a) => a.layer === 'popover' && a.event === 'BUTTON_CONFIRM'));
  const nest = snapOf('nested-065', 2);
  assert.deepEqual(nest.fields.map((f) => `${f.path}:${f.layer}`), ['/MV_INPUT_MAIN:main', '/MV_INPUT_NEST:main']);
  assert.equal(snapOf('nested-065', 3).fields[1].value, 'nest model updated #1', 'a MODEL push without a re-render');
});

test('message box (samples 382): the box text, typed by method', () => {
  const s = snapOf('box-382', 2);
  assert.deepEqual(s.messages.filter((m) => m.source === 'box'), [{ type: 'info', text: 'Really?', source: 'box' }]);
});

test('SelectDialog (samples-controls 623): its items are a table, confirm is the row pick, search a screen action', () => {
  const s = snapOf('select-623', 2, { maxRows: 2 });
  assert.equal(s.layer, 'popup');
  assert.equal(s.title, 'Products', 'a selection dialog titles its layer');
  const [t] = s.tables;
  assert.deepEqual({ ...t, rows: undefined }, {
    id: 't1', path: '/T_PRODUCTS', name: 'T_PRODUCTS', label: 'Products', control: 'sap.m.SelectDialog',
    columns: [{ name: 'PICURL', label: 'icon' }, { name: 'NAME', label: 'title' }, { name: 'PRODUCTID', label: 'description' }],
    rowCount: 123, rows: undefined, truncated: true, selectionMode: 'Single', editableCells: [], layer: 'popup',
  });
  assert.deepEqual(t.rows[1], { PICURL: 'https://sdk.openui5.org/test-resources/sap/ui/documentation/sdk/images/HT-1001.jpg', NAME: 'Notebook Basic 17', PRODUCTID: 'HT-1001' });
  assert.deepEqual(s.actions.map((a) => `${a.id}:${a.event}:${a.trigger}:${a.scope}:${a.table || ''}`), [
    'a1:VH_SEARCH:search:screen:', 'a2:VH_CONFIRM:confirm:row:t1', 'a3:VH_CANCEL:cancel:screen:',
  ]);
  assert.deepEqual(byEvent(s, 'VH_CONFIRM').args, ['$expr:${$parameters>/selectedItem}.getTitle()']);
  assert.equal(byEvent(s, 'VH_CONFIRM').label, 'Products: confirm');
  assert.deepEqual(byEvent(s, 'VH_SEARCH').args, ['$parameters:value']);
  assert.equal(snapOf('select-623', 3).tables[0].rowCount, 2, 'the search filtered the rows');
  const back = snapOf('select-623', 4);
  assert.equal(back.layer, 'main');
  assert.equal(back.fields[0].value, 'Notebook Basic 17', 'the title of the picked row');
});

test('TableSelectDialog (abap-cloud-gui F4 through the popups): cells and column headers, ZZSELKZ the selection field', () => {
  const s = snapOf('cgui-f4-06', 3);
  assert.equal(s.app, 'Z2UI5_CL_POPUP_TO_SELECT');
  assert.equal(s.layer, 'popup');
  assert.equal(s.title, 'Single Select');
  const [t] = s.tables;
  assert.equal(t.control, 'sap.m.TableSelectDialog');
  assert.equal(t.path, '/MR_TAB_POPUP/*');
  assert.deepEqual(t.columns, [{ name: 'WERKS', label: 'WERKS' }, { name: 'NAME', label: 'NAME' }]);
  assert.deepEqual(t.rows.map((r) => `${r.WERKS} ${r.NAME} ${r.ZZSELKZ}`), ['1000 Hamburg false', '2000 Walldorf false', '3000 Berlin false']);
  assert.equal(t.selectionMode, 'Single');
  assert.equal(t.selectionField, 'ZZSELKZ');
  assert.deepEqual(t.editableCells, ['ZZSELKZ']);
  assert.deepEqual(s.actions.map((a) => `${a.event}:${a.scope}:${JSON.stringify(a.args)}`), [
    'CANCEL:screen:[]', 'SEARCH:screen:["$parameters:value","$parameters:clearButtonPressed"]', 'CONFIRM:row:["$parameters:selectedContexts[0]/sPath"]',
  ]);
  const back = snapOf('cgui-f4-06', 5);
  assert.equal(back.app, 'Z2UI5_CL_CGUI_R2C_06');
  assert.equal(back.fields.find((f) => f.name === 'P_PLANT').value, '3000', 'the plant picked in the popup');
});

test('MessageView and MessagePopover items are messages (samples 452): type, title, subtitle, description', () => {
  const main = snapOf('messages-452', 1);
  const view = main.messages.filter((m) => m.source === 'messageview');
  assert.equal(view.length, 11);
  assert.deepEqual({ ...view[0], description: view[0].description.slice(0, 32) }, {
    type: 'error', text: 'Account 801 requires an assignment', source: 'messageview', subtitle: 'Role is invalid', description: 'First Error message description.',
  });
  assert.deepEqual(view[2].subtitle, undefined, 'an empty subtitle is left out');
  assert.deepEqual(view.map((m) => m.type).join(','), 'error,warning,warning,warning,error,info,error,warning,error,error,warning');
  assert.ok(view.every((m) => m.description.length <= 1000));
  const pop = snapOf('messages-452', 2);
  assert.equal(pop.layer, 'popover');
  assert.equal(pop.messages.filter((m) => m.source === 'popover').length, 11);
  assert.equal(pop.messages.filter((m) => m.source === 'messageview').length, 11, 'the page stays described beside a popover');
  assert.ok(pop.actions.some((a) => a.event === 'POPOVER_CLOSE' && a.control === 'sap.m.MessagePopover' && a.layer === 'popover'));
  const dlg = snapOf('messages-452', 4);
  assert.equal(dlg.layer, 'popup');
  assert.deepEqual([...new Set(dlg.messages.map((m) => m.source))], ['messageview'], 'a dialog hides the page and its messages');
  assert.deepEqual(dlg.texts, [], 'message items are not repeated as texts');
});

test('a MessagePopover in dependents (abap-cloud-gui): the run\'s messages, while the popover opens in the browser only', () => {
  const s = snapOf('cgui-popover-07', 2);
  assert.deepEqual(s.messages, [
    { type: 'warning', text: 'Number 42 is a warning', source: 'popover' },
    { type: 'info', text: 'Number 42 processed', source: 'toast' },
  ]);
  const focus = byEvent(s, 'CGUI_MESSAGE_FOCUS');
  assert.deepEqual([focus.trigger, focus.control, focus.args], ['activeTitlePress', 'sap.m.MessagePopover', ['$parameters:item']]);
  assert.ok(s.unsupported.some((u) => /CONTROL_BY_ID\("cgui_message_popover", "", "toggleBy"/.test(u)), 'the toggle is a browser-only action');
});

// ----------------------------------------------- snapshot: synthetic ----

const view = (body, extra = '') => `<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc" xmlns:core="sap.ui.core" xmlns:form="sap.ui.layout.form" ${extra}><Page title="T">${body}</Page></mvc:View>`;
const respond = (xml, model, extra = {}) => ({ S_FRONT: { ID: 'D1', APP: 'Z_T', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', xml]], ...extra } }, MODEL: model });

test('labels: labelFor, FormElement, required from the label, placeholder and tooltip as fallbacks', () => {
  const s = buildSnapshot({
    response: respond(view(
      '<Label text="Order" labelFor="ord" required="true"/><VBox><Input id="ord" value="{/ORD}"/></VBox>'
      + '<form:Form><form:formContainers><form:FormContainer><form:formElements><form:FormElement label="City"><form:fields><Input value="{/CITY}"/></form:fields></form:FormElement></form:formElements></form:FormContainer></form:formContainers></form:Form>'
      + '<Input value="{/P}" placeholder="search here"/><Input value="{/Q}" tooltip="the q"/><CheckBox selected="{/OK}" text="Accept"/>',
    ), { ORD: '1', CITY: 'X', P: '', Q: '', OK: false }),
  });
  assert.deepEqual(s.fields.map((f) => `${f.label}${f.required ? '*' : ''}`), ['Order*', 'City', 'search here', 'the q', 'Accept']);
});

test('editable, enabled and visible: literal, bound and expression-bound', () => {
  const s = buildSnapshot({
    response: respond(view(
      '<Input value="{/A}" editable="false"/><Input value="{/B}" enabled="{/ON}"/><Input value="{/C}" enabled="{= !${/ON} }"/>'
      + '<Input value="{/D}" visible="{/HIDDEN}"/><VBox visible="false"><Button text="x" press=".eB([\'X\'])"/></VBox>'
      + '<Button text="Go" enabled="{= ${/N} > 1 }" press=".eB([\'GO\'])"/><Input value="{/E}" valueState="Error" valueStateText="E is wrong"/>',
    ), { A: 1, B: 2, C: 3, D: 4, E: '', ON: true, HIDDEN: false, N: 0 }),
  });
  assert.deepEqual(s.fields.map((f) => `${f.path}:${f.editable}`), ['/A:false', '/B:true', '/C:false', '/E:true']);
  assert.deepEqual(s.actions.map((a) => `${a.event}:${a.enabled}`), ['GO:false']);
  assert.deepEqual(s.messages, [{ type: 'error', text: 'E is wrong', source: 'field', field: 'f4' }]);
});

test('choices: bound items resolve against the model, a RadioButtonGroup is keyed by index, MultiComboBox is multichoice', () => {
  const s = buildSnapshot({
    response: respond(view(
      '<Select selectedKey="{/K}" items="{/T_KEYS}"><core:Item key="{KEY}" text="{TEXT}"/></Select>'
      + '<RadioButtonGroup selectedIndex="{/IDX}"><buttons><RadioButton text="one"/><RadioButton text="two"/></buttons></RadioButtonGroup>'
      + '<MultiComboBox selectedKeys="{/KS}"><core:Item key="a" text="A"/><core:Item key="b" text="B"/></MultiComboBox>',
    ), { K: '2', T_KEYS: [{ KEY: '1', TEXT: 'One' }, { KEY: '2', TEXT: 'Two' }], IDX: 1, KS: ['a'] }),
  });
  assert.deepEqual(s.fields.map((f) => [f.kind, f.value, f.values]), [
    ['choice', '2', [{ key: '1', text: 'One' }, { key: '2', text: 'Two' }]],
    ['choice', 1, [{ key: 0, text: 'one' }, { key: 1, text: 'two' }]],
    ['multichoice', ['a'], [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }]],
  ]);
});

test('custom controls, named-model fields and unknown frontend actions are listed as unsupported', () => {
  const s = buildSnapshot({
    response: respond(view(
      '<z2ui5:Timer xmlns:z2ui5="z2ui5.cc" finished=".eB([\'TICK\'])"/><Input value="{device>/x}"/>'
      + '<Button text="tab" press=".eF(\'OPEN_NEW_TAB\', \'https://x\')"/>',
    ), {}, { T_CUSTOM: [['SET_FOCUS', 'x'], ['CONTROL_GLOBAL', 'CLIPBOARD_COPY', 'abc']] }),
  });
  assert.ok(s.unsupported.some((u) => /custom control z2ui5\.cc\.Timer/.test(u)));
  assert.ok(s.unsupported.some((u) => /named model 'device'/.test(u)));
  assert.ok(s.unsupported.some((u) => /frontend action OPEN_NEW_TAB/.test(u)));
  assert.ok(s.unsupported.some((u) => /CLIPBOARD_COPY/.test(u)));
  assert.ok(!s.unsupported.some((u) => /SET_FOCUS/.test(u)), 'benign client work is not noise');
  assert.equal(byEvent(s, 'TICK').control, 'z2ui5.cc.Timer', 'a wire on a custom control is still an action');
});

/* The object syntax names a model with its model key as {other>/A} does.
 * Read as the default model, the field was listed editable with the default
 * model's /A, the table got editable cells, and an act's value landed on /A
 * and /T/0/N of the app's own model - which the screen does not edit. */
test('a binding\'s model key names its model: no field, no table rows of the default model', () => {
  assert.deepEqual(parseBinding("{ path: '/A', model: 'other' }"), { kind: 'path', path: '/A', model: 'other', relative: false, type: '', formatter: false });
  assert.equal(parseBinding("{path: '/A', model: ''}").model, '', 'an empty model key is the default model');
  const s = buildSnapshot({
    response: respond(view(
      `<Input value="{path:'/A', model:'other'}"/>`
      + `<Table items="{path:'/T', model:'other'}"><columns><Column><Text text="N"/></Column></columns>`
      + '<items><ColumnListItem><cells><Input value="{N}"/></cells></ColumnListItem></items></Table>',
    ), { A: 'a', T: [{ N: 1 }] }),
  });
  assert.deepEqual(s.fields, []);
  assert.deepEqual(s.tables, []);
  assert.ok(s.unsupported.includes("field Input bound to the named model 'other' (main) - not editable here"), s.unsupported.join(' | '));
});

test('message box with onClose: an action whose $action argument lists the choices; START_TIMER is a timer action', () => {
  const s = buildSnapshot({
    response: respond(view('<Text text="x"/>'), {}, {
      T_CUSTOM: [['MESSAGE_BOX', 'confirm', 'Sure?', { onClose: 'BOX_CLOSED', actions: ['YES', 'NO'] }], ['START_TIMER', 'TICK', '500']],
    }),
  });
  assert.deepEqual(s.messages, [{ type: 'info', text: 'Sure?', source: 'box' }]);
  const box = byEvent(s, 'BOX_CLOSED');
  assert.deepEqual(box.args, ['$action']);
  assert.equal(box.label, 'close message box (YES | NO)');
  assert.equal(byEvent(s, 'TICK').trigger, 'timer');
});

test('maxRows bounds the rows, and the linter metadata classifies an unmapped subclass', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ N: i }));
  const xml = view('<Table items="{/T}"><columns><Column><Text text="N"/></Column></columns><items><ColumnListItem><cells><Text text="{N}"/></cells></ColumnListItem></items></Table><FancyInput value="{/F}"/>');
  const s = buildSnapshot({ response: respond(xml, { T: rows, F: 'x' }), maxRows: 5 });
  assert.equal(s.tables[0].rows.length, 5);
  assert.equal(s.tables[0].rowCount, 50);
  assert.equal(s.fields.length, 0, 'without metadata an unknown control is no field');
  const metadata = { 'sap.m.FancyInput': { parent: 'sap.m.InputBase' }, 'sap.m.InputBase': { parent: 'sap.ui.core.Control' } };
  const m = buildSnapshot({ response: respond(xml, { T: rows, F: 'x' }), metadata });
  assert.deepEqual(m.fields.map((f) => `${f.control}:${f.kind}:${f.value}`), ['sap.m.FancyInput:text:x']);
  assert.equal(m.tables[0].rows.length, 20, 'the default is 20 rows');
});

test('analyzeScreen hands the client its index, and pending paths ride along', () => {
  const { snapshot, index } = analyzeScreen({ state: stateOf('popup-009', 1), pending: ['/S_SCREEN/NAME'] });
  assert.deepEqual(snapshot.pending, ['/S_SCREEN/NAME']);
  assert.equal(index.fields.get('f4').modelKey, 'MAIN');
  assert.equal(index.actions.get('a1').wire.event, 'POPUP_TABLE_VALUE');
});

test('message lists: static items, UI5\'s default type Error, None as info, markup stripped, the 50-item cut, a named model noted', () => {
  const items = Array.from({ length: 52 }, (_, i) => ({ T: `m${i}` }));
  const s = buildSnapshot({
    response: respond(view(
      '<MessagePopover><items><MessageItem title="no type"/><MessageItem type="None" title="none"/>'
      + '<MessageItem type="Success" title="ok" description="&lt;b&gt;bold&lt;/b&gt; text" markupDescription="true"/>'
      + '<MessageItem type="Warning"/></items></MessagePopover>'
      + '<MessageView items="{/T_M}"><MessageItem type="Information" title="{T}"/></MessageView>'
      + '<MessageView items="{message>/}"><MessageItem title="{message}"/></MessageView>',
    ), { T_M: items }),
  });
  assert.deepEqual(s.messages.slice(0, 4), [
    { type: 'error', text: 'no type', source: 'popover' },
    { type: 'info', text: 'none', source: 'popover' },
    { type: 'success', text: 'ok', source: 'popover', description: 'bold text' },
    { type: 'info', text: 'm0', source: 'messageview' },
  ], 'an item without title, subtitle and description is no message');
  assert.equal(s.messages.filter((m) => m.source === 'messageview').length, 50);
  assert.ok(s.unsupported.includes('MessageView (main): 52 messages, the first 50 listed'));
  assert.ok(s.unsupported.includes("MessageView bound to the named model 'message' (main) - messages not described"));
});

test('selection dialogs: multiSelect is Multi, a bound selected is the selectionField, confirm is a row action', () => {
  const s = buildSnapshot({
    response: respond(view(
      '<TableSelectDialog title="Pick" multiSelect="true" items="{/T}" confirm=".eB([\'OK\'], ${$parameters>/selectedContexts/0/sPath})" cancel=".eB([\'NO\'])">'
      + '<ColumnListItem selected="{SEL}"><cells><Text text="{A}"/><ObjectIdentifier title="{B}"/></cells></ColumnListItem>'
      + '<columns><Column><header><Text text="Col A"/></header></Column><Column><header><Text text="Col B"/></header></Column></columns></TableSelectDialog>',
    ), { T: [{ A: 'a1', B: 'b1', SEL: false }, { A: 'a2', B: 'b2', SEL: true }] }),
  });
  const [t] = s.tables;
  assert.deepEqual([t.control, t.label, t.selectionMode, t.selectionField, t.editableCells], ['sap.m.TableSelectDialog', 'Pick', 'Multi', 'SEL', ['SEL']]);
  assert.deepEqual(t.columns, [{ name: 'A', label: 'Col A' }, { name: 'B', label: 'Col B' }]);
  assert.deepEqual(s.actions.map((a) => `${a.event}:${a.scope}:${a.table || ''}:${a.label}`), ['OK:row:t1:Pick: confirm', 'NO:screen::Pick: cancel']);
  assert.equal(s.title, 'T', 'on the page, the page titles the layer');
});

test('an element named like an Object.prototype member is a custom control, not a spec the snapshot trips over', () => {
  // lookupSpec read FIELD_SPECS['__proto__'] - Object.prototype, a "spec" without props: a TypeError out of the snapshot
  for (const tag of ['__proto__', '__defineGetter__']) {
    const s = buildSnapshot({
      response: respond(view(
        `<Table items="{/T}"><items><ColumnListItem><cells><${tag} xmlns="" text="{Q}"/><Input value="{R}"/></cells></ColumnListItem></items></Table>`
        + `<List items="{/T}"><CustomListItem><${tag} xmlns="" text="{Q}"/></CustomListItem></List>`,
      ), { T: [{ Q: 1, R: 'r' }] }),
    });
    assert.deepEqual(s.tables[0].columns.map((c) => c.name), ['Q', 'R'], tag);
    assert.deepEqual(s.tables[0].editableCells, ['R'], `${tag}: no editable cell for an element that is no input`);
    assert.deepEqual(s.tables[1].rows, [{ Q: 1 }]);
  }
});

test('an out-of-range character reference stays as written; model markup of unclosed "<" is linear', () => {
  const view = (body) => `<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc"><Page title="T">${body}</Page></mvc:View>`;
  const at = (xml, model) => buildSnapshot({ state: applyResponse(emptyState(), { S_FRONT: { ID: '1', APP: 'Z_A', S_ACTION: { T_SYSTEM: [['VIEW_SLOTS', 'display', 'MAIN', xml]] } }, MODEL: model }) });
  const snap = at(view('<Text text="a &#99999999; b &#x110000; c &#x41;"/>'), {});
  assert.match(JSON.stringify(snap), /a &#99999999; b &#x110000; c A/);
  const started = Date.now();
  const big = at(view('<FormattedText htmlText="{/H}"/>'), { H: `${'<'.repeat(80000)}<b>x</b>` });
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  assert.ok(big);
});

/*
 * adaptive-card - the app tools' screen as an Adaptive Card 1.5, for chat
 * hosts that render cards rather than HTML (Microsoft Copilot, Teams, an
 * Outlook actionable message, a Bot Framework bot).
 *
 * Off by default: `format: "adaptive-card"` on app_start / app_describe /
 * app_act - or A2UI5_MCP_APP_FORMAT=adaptive-card for every call - adds the
 * card to the result as an EMBEDDED RESOURCE of the media type
 * application/vnd.microsoft.card.adaptive, after the unchanged text snapshot.
 *
 * The card is rendered by abap2UI5/protocol's Adaptive Cards renderer,
 * vendored under lib/vendor/adaptive-cards (scripts/vendor-adaptive-cards.mjs,
 * source.json, test/vendor.test.mjs), from the session's folded screen state
 * (`client.screen(session)` - the same views and models the snapshot is
 * derived from). Two things are added to what the renderer writes, both in
 * the `data` of each Action.Submit, so that a submitted payload names
 * everything app_act needs: `session` (the draft id the card was rendered
 * for) and, on a row's action, `row` (the 0-based index of the row in its
 * table - the renderer resolves a row's arguments into the card but does not
 * say which row it was).
 *
 * The way back is `cardSubmitToAct(snapshot, payload)`: a submitted payload
 * (the action's data merged with the card's input values, keyed by input id
 * = binding path) -> the arguments of ONE app_act call, which validates it
 * like any other act. The mapping (docs/agent-snapshot.md "Adaptive Cards"):
 *
 *   data.session                 -> session
 *   data.event                   -> event (the event name; the first enabled
 *                                   action of that name, the row action when
 *                                   `row` is given - app_act's own rule)
 *   data.row                     -> row
 *   "/PATH": value               -> values["/PATH"], only when it differs from
 *   "/TAB/<row>/<COL>": value       the snapshot (a card submits every input);
 *                                   a multi-select's "a,b" becomes ["a","b"]
 *   data.box: "YES"              -> event: the message box's close action,
 *                                   args: its "$action" position = "YES"
 *                                   (a box without onClose: null - nothing to send)
 *   data.client: [CONTROL_GLOBAL, VIEW_SLOTS, destroy, POPUP|POPOVER]
 *                                -> event "@CLOSE_POPUP" / "@CLOSE_POPOVER"
 *   data.args, data.refs         -> dropped: app_act fills the arguments itself
 *                                   from the model at act time (after the
 *                                   edits), and refuses the ones only a
 *                                   browser computes, naming args[i]
 *
 * Every other frontend-only wire (`data.client`) is refused - app_act cannot
 * perform it, and neither can the agent client.
 */
import { renderCard } from './vendor/adaptive-cards/render.mjs';
import { inputsOf } from './vendor/adaptive-cards/submit.mjs';

export const CARD_MIME = 'application/vnd.microsoft.card.adaptive';
export const APP_FORMATS = ['snapshot', 'adaptive-card'];

/** The answer format of the app tools: the argument, else A2UI5_MCP_APP_FORMAT, else the snapshot alone. */
export function defaultAppFormat(env = process.env) {
  const v = String(env.A2UI5_MCP_APP_FORMAT || '').trim().toLowerCase();
  return APP_FORMATS.includes(v) ? v : 'snapshot';
}

/** The messages of the last response as the renderer takes them: toasts and message boxes of T_CUSTOM. */
export function messagesOf(state) {
  const out = [];
  for (const raw of (state && state.custom) || []) {
    const a = raw[0] === 'CONTROL_GLOBAL' ? raw.slice(1) : raw;
    if (a[0] === 'MESSAGE_TOAST') out.push({ kind: 'toast', text: String(a[2] ?? '') });
    else if (a[0] === 'MESSAGE_BOX') out.push({ kind: 'box', type: a[1], text: String(a[2] ?? ''), ...(a[3] && typeof a[3] === 'object' ? a[3] : {}) });
  }
  return out;
}

/* Adds `session` to every Action.Submit and `row` to those inside a row: a
 * TableRow of a Table (header row excluded), or a list's row Container
 * (`separator: true`, the renderer's row container; a run of them counts
 * from 0 and restarts after anything else). */
function annotate(items, session, row) {
  let listRow = -1;
  for (const e of items || []) {
    if (!e || typeof e !== 'object') continue;
    let r = row;
    if (row === undefined && e.type === 'Container' && e.separator === true) {
      listRow += 1;
      r = listRow;
    } else if (row === undefined) {
      listRow = -1;
    }
    if (e.type === 'Action.Submit' && e.data && typeof e.data === 'object') {
      e.data.session = session;
      if (r !== undefined && e.data.event !== undefined) e.data.row = r;
    }
    if (e.type === 'Table' && Array.isArray(e.rows)) {
      e.rows.forEach((tr, i) => {
        const idx = e.firstRowAsHeader ? i - 1 : i;
        for (const c of tr.cells || []) {
          annotate(c.selectAction ? [c.selectAction] : [], session, idx < 0 ? row : idx);
          annotate(c.items, session, idx < 0 ? row : idx);
        }
      });
    }
    annotate(e.items, session, r);
    annotate(e.actions, session, r);
    for (const c of e.columns || []) annotate(c.items, session, r);
    if (e.selectAction) annotate([e.selectAction], session, r);
    if (e.inlineAction) annotate([e.inlineAction], session, r);
  }
}

/** The card for a session's folded state: { card, unsupported }. */
export function appCard(state, session) {
  const { card, unsupported } = renderCard(state, { messages: messagesOf(state) });
  annotate(card.body, session || (state && state.id) || '', undefined);
  return { card, unsupported };
}

/** The card as the embedded-resource content block of a tool result. */
export function cardContent(card, session) {
  return {
    type: 'resource',
    resource: {
      uri: `abap2ui5://app-card/${encodeURIComponent(session || 'none')}`,
      mimeType: CARD_MIME,
      text: JSON.stringify(card),
    },
  };
}

const cellRe = /^(.*)\/(\d+)\/([A-Za-z_][\w-]*)$/;

function shownValue(snapshot, p) {
  const f = snapshot.fields.find((x) => x.path === p);
  if (f) return { found: true, value: f.value, field: f };
  const m = cellRe.exec(p);
  if (m) {
    const t = snapshot.tables.find((x) => x.path === m[1]);
    const row = t && t.rows[Number(m[2])];
    if (row) return { found: true, value: row[m[3]] };
  }
  return { found: false };
}

const norm = (v) => (Array.isArray(v) ? v.map(String).join(',') : v === null || v === undefined ? '' : typeof v === 'boolean' ? String(v) : String(v));

/**
 * A submitted card payload -> the arguments of one app_act call, or null when
 * nothing needs to go to the app (a message box without a close event).
 * Throws for a payload app_act cannot carry (a frontend action other than
 * the popup/popover close, no event at all).
 */
export function cardSubmitToAct(snapshot, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('a card submit payload is an object');
  if (!snapshot || snapshot.snapshotVersion !== 1) throw new Error('the snapshot the card was rendered with is needed to map its inputs');
  const act = { session: String(payload.session || snapshot.session) };
  const values = {};
  for (const [p, raw] of inputsOf(payload)) {
    const shown = shownValue(snapshot, p);
    let v = raw;
    if (shown.field && shown.field.kind === 'multichoice') v = String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (raw === 'true' || raw === 'false') {
      if ((shown.field && shown.field.kind === 'boolean') || typeof shown.value === 'boolean') v = raw === 'true';
    }
    if (shown.found && norm(v) === norm(shown.value)) continue;
    values[p] = v;
  }
  if (Object.keys(values).length) act.values = values;

  if (Array.isArray(payload.client)) {
    const [a, b, c, slot] = payload.client;
    if (a === 'CONTROL_GLOBAL' && b === 'VIEW_SLOTS' && c === 'destroy' && (slot === 'POPUP' || slot === 'POPOVER')) {
      act.event = `@CLOSE_${slot}`;
      return act;
    }
    throw new Error(`the frontend action ${payload.client.map(String).join(' ')} runs in a browser only - app_act cannot perform it`);
  }
  if (payload.box !== undefined) {
    const close = snapshot.actions.find((x) => x.control === 'sap.m.MessageBox' && Array.isArray(x.args) && x.args.includes('$action'));
    if (!close) return null;
    act.event = close.id;
    act.args = close.args.map((x) => (x === '$action' ? String(payload.box) : null));
    return act;
  }
  if (payload.event === undefined || payload.event === null || payload.event === '') throw new Error('the payload names no event - not an action of this card');
  act.event = String(payload.event);
  if (Number.isInteger(payload.row)) act.row = payload.row;
  return act;
}

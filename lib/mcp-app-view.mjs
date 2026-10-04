/*
 * mcp-app-view - the page behind the MCP Apps UI resource ui://abap2ui5/app-screen
 * (lib/mcp-app.mjs builds the HTML document around it).
 *
 * An MCP Apps host (SEP-1865, `text/html;profile=mcp-app`) renders this page
 * in a sandboxed iframe next to an app_start / app_describe / app_act result
 * and talks to it over postMessage with JSON-RPC 2.0: the page sends
 * `ui/initialize`, the host answers with its capabilities and context, the
 * page confirms with `ui/notifications/initialized`, and the host then
 * delivers the tool's arguments (`ui/notifications/tool-input`) and its
 * result (`ui/notifications/tool-result`). The result's text block IS the
 * agent snapshot v1 (docs/agent-snapshot.md), and that is all this page
 * renders: the fields, the actions, the tables, the messages and texts.
 *
 * What the user does goes back the one way the agent's own acts go: as an
 * `app_act` call (`tools/call` through the host - its `serverTools`
 * capability), built from the snapshot by `buildActCall` and validated twice:
 * here, against the snapshot on screen (an action that is not on it or
 * disabled, a field that is not editable, a choice outside its values, a row
 * that does not exist is refused before anything is posted), and again by
 * app_act itself, which refuses whatever the client's own validation refuses.
 * The page never speaks the abap2UI5 wire protocol and never reaches the
 * network - the host's default CSP (`connect-src 'none'`) would not let it,
 * and it does not need to. After an act it tells the model what happened
 * (`ui/update-model-context`, when the host offers it), so the agent's next
 * turn knows the session moved on.
 *
 * Self-contained by construction: no import, no external URL, no eval. The
 * module is inlined verbatim into the HTML document (lib/mcp-app.mjs), so it
 * must never contain the closing tag of a script element or an HTML comment
 * opener - test/mcp-app.test.mjs checks both. Everything above `boot` is
 * pure and is what the Node tests drive; `boot` is the DOM glue.
 */

/** The MCP Apps protocol version this page speaks (the stable spec, 2026-01-26). */
export const UI_PROTOCOL_VERSION = '2026-01-26';
/** The tools whose results carry a snapshot this page renders. */
export const SNAPSHOT_TOOLS = ['app_start', 'app_describe', 'app_act'];
/** The ONLY tools the page may call. */
export const CALLABLE_TOOLS = ['app_act', 'app_describe'];

const VIEW_INFO = { name: 'abap2ui5-app-screen', version: '1' };

// ---------------------------------------------------------- reading ----

/** The agent snapshot a tool result carries: `structuredContent` when it is
 *  one, else the first text block that parses as one; null otherwise. */
export function snapshotOf(result) {
  if (!result || typeof result !== 'object' || result.isError) return null;
  const sc = result.structuredContent;
  if (sc && typeof sc === 'object' && sc.snapshotVersion === 1) return sc;
  for (const c of Array.isArray(result.content) ? result.content : []) {
    if (!c || c.type !== 'text' || typeof c.text !== 'string') continue;
    try {
      const j = JSON.parse(c.text);
      if (j && typeof j === 'object' && j.snapshotVersion === 1) return j;
    } catch {
      /* not JSON - an error sentence or another tool's answer */
    }
  }
  return null;
}

/** The text of an error result (what app_act refused, verbatim), else null. */
export function errorOf(result) {
  if (!result || typeof result !== 'object' || !result.isError) return null;
  const texts = (Array.isArray(result.content) ? result.content : [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  return texts.join('\n') || 'the tool call failed';
}

/** The choices of a message box's close action, from its label
 *  ("close message box (YES | NO)" - the snapshot's documented spelling). */
export function boxChoices(action) {
  if (!action || !Array.isArray(action.args) || !action.args.includes('$action')) return [];
  const m = /\(([^()]*)\)\s*$/.exec(String(action.label || ''));
  return m ? m[1].split(' | ').map((s) => s.trim()).filter(Boolean) : ['OK'];
}

// ---------------------------------------------------------- validating ----

const cellRe = /^(.*)\/(\d+)\/([A-Za-z_][\w-]*)$/;

function editableTarget(snapshot, key) {
  const f = snapshot.fields.find((x) => x.id === key);
  if (f) return f.editable ? { kind: 'field', field: f } : { error: `field ${f.id} (${f.label}) is not editable` };
  const m = cellRe.exec(key);
  if (m) {
    const t = snapshot.tables.find((x) => x.path === m[1]);
    if (!t) return { error: `no table ${m[1]} on this screen` };
    const row = Number(m[2]);
    if (!t.editableCells.includes(m[3])) return { error: `column ${m[3]} of table ${t.id} is not editable` };
    if (row >= t.rowCount) return { error: `table ${t.id} has ${t.rowCount} row(s) - row ${row} does not exist` };
    return { kind: 'cell', table: t, row, col: m[3] };
  }
  return { error: `'${key}' is no field id and no table cell of this screen` };
}

function same(a, b) {
  const norm = (v) => (Array.isArray(v) ? v.map(String).join('\u0001') : v === null || v === undefined ? '' : String(v));
  return norm(a) === norm(b);
}

/** The value the snapshot shows for a field id or a cell path. */
export function currentValue(snapshot, key) {
  const f = snapshot.fields.find((x) => x.id === key);
  if (f) return f.value;
  const m = cellRe.exec(key);
  if (!m) return undefined;
  const t = snapshot.tables.find((x) => x.path === m[1]);
  const row = t && t.rows[Number(m[2])];
  return row ? row[m[3]] : undefined;
}

/**
 * The edits of a form: `entries` [{ key, value }] (key a field id or a cell
 * path `<table path>/<row>/<COLUMN>`) -> { key: value } of the ones that
 * differ from what the snapshot shows. Untouched inputs send nothing.
 */
export function editsFromForm(snapshot, entries) {
  const out = {};
  for (const { key, value } of entries || []) {
    if (same(value, currentValue(snapshot, key))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The app_act call for one user action on the snapshot on screen:
 *   { action: <action id>, values?: { key: value }, row?, choice?, maxRows? }
 * -> { name: 'app_act', arguments: { session, event, values?, row?, args?, max_rows? } }
 * Throws (nothing posted) when the snapshot does not allow it.
 */
export function buildActCall(snapshot, { action: actionId, values, row, choice, maxRows } = {}) {
  if (!snapshot || snapshot.snapshotVersion !== 1) throw new Error('no app screen yet');
  const action = snapshot.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`'${actionId}' is not an action of this screen`);
  if (!action.enabled) throw new Error(`action ${action.id} (${action.label}) is disabled`);
  const args = { session: snapshot.session, event: action.id };
  if (row !== undefined && row !== null) {
    if (action.scope !== 'row') throw new Error(`action ${action.id} (${action.label}) is no row action`);
    const t = snapshot.tables.find((x) => x.id === action.table);
    const count = t ? t.rowCount : 0;
    if (!Number.isInteger(row) || row < 0 || row >= count) throw new Error(`table ${action.table} has ${count} row(s) - row ${row} does not exist`);
    args.row = row;
  }
  const edits = values || {};
  for (const [key, value] of Object.entries(edits)) {
    const t = editableTarget(snapshot, key);
    if (t.error) throw new Error(t.error);
    if (t.kind === 'field' && Array.isArray(t.field.values) && (t.field.kind === 'choice' || t.field.kind === 'multichoice')) {
      const keys = t.field.values.map((v) => String(v.key));
      for (const one of Array.isArray(value) ? value : [value]) {
        if (!keys.includes(String(one))) throw new Error(`field ${t.field.id} (${t.field.label}): '${one}' is not one of its values`);
      }
    }
  }
  if (Object.keys(edits).length) args.values = { ...edits };
  const choices = boxChoices(action);
  if (choices.length) {
    const pick = choice === undefined || choice === null ? choices[0] : String(choice);
    if (!choices.includes(pick)) throw new Error(`'${pick}' is not one of ${choices.join(', ')}`);
    args.args = action.args.map((a) => (a === '$action' ? pick : null));
  } else if (choice !== undefined && choice !== null) {
    throw new Error(`action ${action.id} (${action.label}) takes no choice`);
  }
  if (Number.isInteger(maxRows)) args.max_rows = maxRows;
  return { name: 'app_act', arguments: args };
}

/** What the model is told after the user acted (ui/update-model-context). */
export function contextText(call, snapshot) {
  const lines = [
    `The user operated the abap2UI5 app in the chat UI: ${call.name} ${JSON.stringify(call.arguments)}.`,
    `Current screen: app ${snapshot.app}, session ${snapshot.session}, layer ${snapshot.layer}${snapshot.title ? `, title "${snapshot.title}"` : ''}.`,
  ];
  const msgs = (snapshot.messages || []).slice(0, 5).map((m) => `${m.type}: ${m.text}`);
  if (msgs.length) lines.push(`Messages: ${msgs.join(' | ')}`);
  lines.push(`Continue with session ${snapshot.session} - app_describe { "session": "${snapshot.session}" } answers the full snapshot without a roundtrip.`);
  return lines.join('\n');
}

// ---------------------------------------------------------- rendering ----

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text for HTML text and attribute positions: every markup character escaped. */
export function escapeHtml(value) {
  return (value === null || value === undefined ? '' : String(value)).replace(/[&<>"']/g, (c) => ESC[c]);
}
const h = escapeHtml;
const asText = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const truthy = (v) => v === true || v === 'true' || v === 'X';

function fieldHtml(f, fieldMessages) {
  const id = `in-${f.id}`;
  const msg = fieldMessages.get(f.id);
  const described = msg ? ` aria-describedby="${id}-msg" aria-invalid="${msg.type === 'error'}"` : '';
  const common = `id="${id}" data-field="${h(f.id)}"${f.editable ? '' : ' disabled'}${f.required ? ' required aria-required="true"' : ''}${described}`;
  let control;
  if (f.kind === 'boolean') {
    control = `<input type="checkbox" ${common}${truthy(f.value) ? ' checked' : ''}>`;
  } else if ((f.kind === 'choice' || f.kind === 'multichoice') && Array.isArray(f.values)) {
    const chosen = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
    const opts = f.values.map((v) => `<option value="${h(v.key)}"${chosen.includes(String(v.key)) ? ' selected' : ''}>${h(v.text || v.key)}</option>`).join('');
    control = `<select ${common}${f.kind === 'multichoice' ? ' multiple' : ''}>${opts}</select>`;
  } else if (f.kind === 'textarea') {
    control = `<textarea ${common} rows="3">${h(asText(f.value))}</textarea>`;
  } else {
    control = `<input type="text" ${common}${f.kind === 'number' ? ' inputmode="decimal"' : ''} value="${h(asText(f.value))}">`;
  }
  const note = msg ? `<span class="fmsg fmsg-${h(msg.type)}" id="${id}-msg">${h(msg.text)}</span>` : '';
  return `<div class="field${f.kind === 'boolean' ? ' field-bool' : ''}"><label for="${id}">${h(f.label || f.name)}${f.required ? ' <span aria-hidden="true">*</span>' : ''}</label>${control}${note}</div>`;
}

function actionButton(a, { row, choice, label } = {}) {
  const attrs = [`type="button"`, `data-action="${h(a.id)}"`];
  if (row !== undefined) attrs.push(`data-row="${row}"`);
  if (choice !== undefined) attrs.push(`data-choice="${h(choice)}"`);
  if (!a.enabled) attrs.push('disabled');
  return `<button ${attrs.join(' ')}>${h(label || a.label || a.event)}</button>`;
}

function cellHtml(t, rowIndex, col, value) {
  if (!t.editableCells.includes(col)) return h(asText(value));
  const key = `${t.path}/${rowIndex}/${col}`;
  const label = `${col}, row ${rowIndex + 1}`;
  if (col === t.selectionField || typeof value === 'boolean') {
    return `<input type="checkbox" data-cell="${h(key)}" aria-label="${h(label)}"${truthy(value) ? ' checked' : ''}>`;
  }
  return `<input type="text" data-cell="${h(key)}" aria-label="${h(label)}" value="${h(asText(value))}">`;
}

function tableHtml(t, rowActions) {
  const cols = t.columns.map((c) => c.name);
  const extra = t.selectionField && !cols.includes(t.selectionField) ? [t.selectionField] : [];
  const head = [...t.columns.map((c) => `<th scope="col">${h(c.label || c.name)}</th>`), ...extra.map((c) => `<th scope="col">${h(c === t.selectionField ? 'selected' : c)}</th>`)];
  if (rowActions.length) head.push('<th scope="col"><span class="sr">row actions</span></th>');
  const body = t.rows.map((r, i) => {
    const cells = [...cols, ...extra].map((c) => `<td>${cellHtml(t, i, c, r[c])}</td>`);
    if (rowActions.length) cells.push(`<td class="rowacts">${rowActions.map((a) => actionButton(a, { row: i })).join(' ')}</td>`);
    return `<tr>${cells.join('')}</tr>`;
  }).join('');
  const more = t.truncated ? `<p class="note">${t.rows.length} of ${t.rowCount} rows shown - the agent can page with max_rows</p>` : '';
  const empty = t.rows.length ? '' : '<p class="note">no rows</p>';
  return `<section class="table" aria-label="${h(t.label || t.name)}"><h2>${h(t.label || t.name)}</h2>`
    + `<div class="scroll"><table><thead><tr>${head.join('')}</tr></thead><tbody>${body}</tbody></table></div>${empty}${more}</section>`;
}

/**
 * The page for one snapshot, as an HTML string (every value escaped):
 *   view { snapshot, error?, busy?, note?, canAct? }
 */
export function renderScreen(view) {
  const { snapshot, error, busy, note, canAct = true } = view || {};
  if (!snapshot) {
    const status = error ? `<p class="error" role="alert">${h(error)}</p>` : `<p class="wait">${h(note || 'Waiting for the app screen...')}</p>`;
    return status;
  }
  const s = snapshot;
  const parts = [];
  parts.push(`<header><h1>${h(s.title || s.app)}</h1><p class="meta">${h(s.app)} &middot; ${h(s.layer)} &middot; session <code>${h(s.session)}</code></p></header>`);
  const status = [];
  if (error) status.push(`<p class="error" role="alert">${h(error)}</p>`);
  if (busy) status.push('<p class="busy">Sending to the app...</p>');
  if (note) status.push(`<p class="note">${h(note)}</p>`);
  if (!canAct) status.push('<p class="note">This chat host does not let the page call tools - ask the agent to act instead.</p>');
  parts.push(`<div class="status" role="status" aria-live="polite">${status.join('')}</div>`);

  const fieldMessages = new Map();
  const general = [];
  for (const m of s.messages || []) {
    if (m.source === 'field' && m.field && s.fields.some((f) => f.id === m.field)) fieldMessages.set(m.field, m);
    else general.push(m);
  }
  if (general.length) {
    parts.push(`<ul class="messages">${general.map((m) => `<li class="msg msg-${h(m.type)}"><strong>${h(m.type)}</strong> ${h(m.text)}${m.description ? ` <span class="desc">${h(m.description)}</span>` : ''}</li>`).join('')}</ul>`);
  }
  if (s.texts && s.texts.length) parts.push(`<ul class="texts">${s.texts.map((t) => `<li>${h(t)}</li>`).join('')}</ul>`);

  const form = [];
  if (s.fields.length) form.push(`<div class="fields">${s.fields.map((f) => fieldHtml(f, fieldMessages)).join('')}</div>`);
  for (const t of s.tables) form.push(tableHtml(t, s.actions.filter((a) => a.scope === 'row' && a.table === t.id && !boxChoices(a).length)));
  const screenActions = s.actions.filter((a) => a.scope !== 'row');
  if (screenActions.length) {
    const buttons = screenActions.flatMap((a) => {
      const choices = boxChoices(a);
      return choices.length ? choices.map((c) => actionButton(a, { choice: c, label: `${c} (message box)` })) : [actionButton(a)];
    });
    form.push(`<div class="actions" role="group" aria-label="actions">${buttons.join(' ')}</div>`);
  }
  form.push(`<div class="actions secondary"><button type="button" data-refresh="1">Refresh</button></div>`);
  parts.push(`<form id="screen" data-session="${h(s.session)}"${busy || !canAct ? ' inert' : ''}>${form.join('')}</form>`);
  if (s.pending && s.pending.length) parts.push(`<p class="note">Pending (sent with the next action): ${s.pending.map(h).join(', ')}</p>`);
  if (s.unsupported && s.unsupported.length) {
    parts.push(`<details><summary>Not shown here (${s.unsupported.length})</summary><ul>${s.unsupported.map((u) => `<li>${h(u)}</li>`).join('')}</ul></details>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------- the bridge ----

/**
 * The JSON-RPC side of the page, without a DOM:
 *   post(message)   sends one JSON-RPC message to the host
 *   render(view)    shows a view ({ snapshot, error, busy, note, canAct })
 * Answers { start(), handle(message), act(intent), refresh(), view() }.
 */
export function createBridge({ post, render = () => {} }) {
  let nextId = 1;
  const waiting = new Map();
  const view = { snapshot: null, error: null, busy: false, note: null, canAct: false };
  let host = { capabilities: {}, context: {} };
  let toolArgs = {};

  const show = () => render({ ...view });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    post({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => post({ jsonrpc: '2.0', method, params });
  const respond = (id, result) => post({ jsonrpc: '2.0', id, result });

  function adoptResult(result) {
    const snap = snapshotOf(result);
    if (snap) {
      view.snapshot = snap;
      view.error = null;
    } else {
      view.error = errorOf(result) || 'this tool result carries no app screen';
    }
  }

  /* Posts a single tools/call request - or refuses, posting nothing: a tool the page may
   * not call, a host that does not proxy tool calls, an act still running. */
  async function call(name, args) {
    const refusal = !CALLABLE_TOOLS.includes(name) ? `the page calls ${CALLABLE_TOOLS.join(' and ')} only, not ${name}`
      : !view.canAct ? 'this host does not let the page call tools'
        : view.busy ? 'one action at a time - the last one is still running' : null;
    if (refusal) {
      view.error = refusal;
      show();
      return false;
    }
    view.busy = true;
    view.error = null;
    show();
    try {
      const result = await request('tools/call', { name, arguments: args });
      adoptResult(result);
      if (!result || !result.isError) {
        const caps = host.capabilities || {};
        if (caps.updateModelContext && view.snapshot && name === 'app_act') {
          request('ui/update-model-context', { content: [{ type: 'text', text: contextText({ name, arguments: args }, view.snapshot) }] }).catch(() => {});
        }
      }
    } catch (e) {
      view.error = String((e && e.message) || e);
    } finally {
      view.busy = false;
      show();
    }
    return true;
  }

  return {
    async start() {
      show();
      try {
        const res = await request('ui/initialize', {
          appInfo: VIEW_INFO,
          appCapabilities: { availableDisplayModes: ['inline'] },
          protocolVersion: UI_PROTOCOL_VERSION,
        });
        host = { capabilities: (res && res.hostCapabilities) || {}, context: (res && res.hostContext) || {} };
        view.canAct = Boolean(host.capabilities.serverTools);
        notify('ui/notifications/initialized', {});
      } catch (e) {
        view.error = `the host refused ui/initialize: ${(e && e.message) || e}`;
      }
      show();
      return host;
    },
    handle(msg) {
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
      if (msg.id !== undefined && msg.method === undefined) {
        const w = waiting.get(msg.id);
        if (!w) return;
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else w.resolve(msg.result);
        return;
      }
      const p = msg.params || {};
      switch (msg.method) {
        case 'ui/notifications/tool-input':
          toolArgs = (p && p.arguments) || {};
          return;
        case 'ui/notifications/tool-result':
          adoptResult(p);
          show();
          return;
        case 'ui/notifications/tool-cancelled':
          view.note = `the tool call was cancelled${p.reason ? `: ${p.reason}` : ''}`;
          show();
          return;
        case 'ui/notifications/host-context-changed':
          host.context = { ...host.context, ...p };
          return;
        case 'ui/resource-teardown':
        case 'ping':
          if (msg.id !== undefined) respond(msg.id, {});
          return;
        default:
          if (msg.id !== undefined) post({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
    },
    /** A user action: { action, values?, row?, choice? } -> app_act. */
    async act(intent) {
      let c;
      try {
        const maxRows = Number.isInteger(toolArgs.max_rows) ? toolArgs.max_rows : undefined;
        c = buildActCall(view.snapshot, { ...intent, maxRows });
      } catch (e) {
        view.error = String((e && e.message) || e);
        show();
        return null;
      }
      return (await call(c.name, c.arguments)) ? c : null;
    },
    /** Re-read the screen (app_describe, no roundtrip to the app). */
    async refresh() {
      if (!view.snapshot) return null;
      const args = { session: view.snapshot.session };
      return (await call('app_describe', args)) ? { name: 'app_describe', arguments: args } : null;
    },
    view: () => ({ ...view }),
    host: () => host,
  };
}

// ---------------------------------------------------------- the DOM glue ----

/** The form's current values, as editsFromForm takes them. */
function formEntries(root) {
  const out = [];
  for (const el of root.querySelectorAll('[data-field], [data-cell]')) {
    if (el.disabled) continue;
    const key = el.getAttribute('data-field') || el.getAttribute('data-cell');
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.multiple) value = Array.from(el.selectedOptions).map((o) => o.value);
    else value = el.value;
    out.push({ key, value });
  }
  return out;
}

function applyHostContext(doc, ctx) {
  if (!ctx) return;
  if (ctx.theme === 'light' || ctx.theme === 'dark') doc.documentElement.setAttribute('data-theme', ctx.theme);
  const vars = ctx.styles && ctx.styles.variables;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) if (/^--[\w-]+$/.test(k) && typeof v === 'string') doc.documentElement.style.setProperty(k, v);
  }
}

/** Starts the page in a browser window: renders into #app, talks to window.parent. */
export function boot(win) {
  const doc = win.document;
  const root = doc.getElementById('app');
  const bridge = createBridge({
    post: (m) => win.parent.postMessage(m, '*'),
    render: (v) => {
      root.innerHTML = renderScreen(v);
    },
  });
  win.addEventListener('message', (ev) => {
    if (ev.source !== win.parent) return;
    const before = bridge.host().context;
    bridge.handle(ev.data);
    if (bridge.host().context !== before) applyHostContext(doc, bridge.host().context);
  });
  root.addEventListener('submit', (ev) => ev.preventDefault());
  root.addEventListener('click', (ev) => {
    const target = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-refresh')) {
      bridge.refresh();
      return;
    }
    const action = target.getAttribute('data-action');
    if (!action) return;
    const snap = bridge.view().snapshot;
    const rowAttr = target.getAttribute('data-row');
    bridge.act({
      action,
      values: snap ? editsFromForm(snap, formEntries(root)) : {},
      row: rowAttr === null ? undefined : Number(rowAttr),
      choice: target.getAttribute('data-choice') ?? undefined,
    });
  });
  if (typeof win.ResizeObserver === 'function') {
    let last = '';
    new win.ResizeObserver(() => {
      const el = doc.documentElement;
      const size = { width: Math.ceil(el.scrollWidth), height: Math.ceil(el.scrollHeight) };
      const key = `${size.width}x${size.height}`;
      if (key === last) return;
      last = key;
      win.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: size }, '*');
    }).observe(doc.documentElement);
  }
  bridge.start().then((host) => applyHostContext(doc, host.context));
  return bridge;
}

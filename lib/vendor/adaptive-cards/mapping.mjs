/*
 * VENDORED - do not edit. abap2UI5/protocol renderers/adaptive-cards/mapping.mjs
 * at commit 29aad60639a5ff3451d592a474cad8af082a2c55,
 * copied by scripts/vendor-adaptive-cards.mjs; the only change is that the
 * relative paths point at the vendored folder, and the imports of the agent
 * modules at lib/ (the originals the protocol repository vendors) instead of
 * its copies. `node scripts/vendor-adaptive-cards.mjs
 * --check` fails when this copy drifts from that commit. Change it upstream,
 * then re-vendor.
 */
/*
 * The mapping of portable profile v1 (profiles/portable-v1.json) onto
 * Adaptive Cards 1.5 - one entry per control: the card element(s) it
 * becomes (`card`), what is approximated or left out (`note`) and the
 * render function (the default aggregations are ../common/view.mjs's).
 * README.md's mapping table is generated from this table (node
 * scripts/render-adaptive-cards.mjs); a control of the profile without an
 * entry fails test/adaptive-cards.test.mjs.
 */
import {
  resolve, boundPath, text, truthy, falsy, children, aggregation, contentChildren, rowsOf,
  wireData, submitAction, actionSet, renderNode, renderList, inputId, readOnly, htmlToText, walk,
} from "./render.mjs";

/** Elements that carry no UI (profiles/portable.md section 2). */
export { TOLERATED } from "./common/view.mjs";

const tb = (t, extra = {}) => ({ type: "TextBlock", text: t, wrap: true, ...extra });
const heading = (t, size = "Medium") => tb(t, { size, weight: "Bolder", style: "heading" });
const container = (items, extra = {}) => (items.length ? [{ type: "Container", items, ...extra }] : []);
const attr = (node, name, ctx) => resolve(node.attrs[name], ctx);
const str = (node, name, ctx) => text(attr(node, name, ctx));
const iconName = (src) => (src ? String(src).replace(/^sap-icon:\/\/(?:[^/]+\/)?/, "").replace(/-/g, " ") : "");

const COLORS = { Error: "Attention", Warning: "Warning", Success: "Good", Information: "Accent" };
const color = (state) => COLORS[state] || undefined;

function withColor(el, state) {
  const c = color(state);
  if (c) el.color = c;
  return el;
}

/** Children side by side: one ActionSet when they are all actions, else a
 *  ColumnSet of auto-width columns. */
function row(nodes, ctx) {
  const parts = nodes.map((n) => renderNode(n, ctx)).filter((els) => els.length);
  if (!parts.length) return [];
  const flat = parts.flat();
  if (flat.every((e) => e.type === "ActionSet")) return [actionSet(flat.flatMap((e) => e.actions))];
  if (parts.length === 1) return parts[0];
  return [{ type: "ColumnSet", columns: parts.map((items) => ({ type: "Column", width: "auto", items })) }];
}

/** A control that only shows text unless it has a press wire. */
function pressable(node, ctx, event, title, el) {
  const data = node.attrs[event] !== undefined ? wireData(node, event, ctx) : null;
  if (!data) return el ? [el] : [];
  if (!ctx.interactive) return el ? [el] : [];
  return [actionSet([submitAction(title, data)])];
}

/** A disabled or read-only input is shown as text. */
function locked(node, ctx) {
  for (const p of ["enabled", "editable"]) if (node.attrs[p] !== undefined && falsy(attr(node, p, ctx))) return true;
  return false;
}

/** An input bound by `prop`: `make(id, value)` builds the card input. */
function field(node, ctx, prop, make, { shown } = {}) {
  const value = attr(node, prop, ctx);
  if (!ctx.interactive || locked(node, ctx)) return [readOnly("", shown !== undefined ? shown : value)];
  const id = inputId(node, boundPath(node.attrs[prop], ctx), ctx);
  const el = make(id, value);
  const ph = str(node, "placeholder", ctx);
  if (ph && el.type !== "Input.Toggle") el.placeholder = ph;
  return [el];
}

/** Wires of a field the card cannot raise on their own: reported, the edit
 *  travels with the next action. */
function unraised(node, ctx, events) {
  for (const e of events) if (node.attrs[e] !== undefined && ctx.interactive) ctx.report(node, `event ${e} is not raised by a card - the edit travels with the next action`);
}

/** The choices of a Select-like control. */
function choices(node, ctx, agg = "items") {
  return rowsOf(node, agg, ctx).map(({ base, node: item }) => {
    const c = ctx.with(base);
    const key = str(item, "key", c);
    const t = str(item, "text", c);
    return { title: t || key, value: key || t };
  });
}

function choiceSet(node, ctx, { prop, style, multi = false, agg = "items" }) {
  const list = choices(node, ctx, agg);
  const raw = attr(node, prop, ctx);
  const value = Array.isArray(raw) ? raw.map(String).join(",") : text(raw);
  const shown = value.split(",").map((v) => (list.find((c) => c.value === v) || {}).title || v).join(", ");
  return field(node, ctx, prop, (id) => {
    // a choice set needs a choice; without items the key is edited as text
    if (!list.length) return { type: "Input.Text", id, value };
    const el = { type: "Input.ChoiceSet", id, style, choices: list, value };
    if (multi) el.isMultiSelect = true;
    return el;
  }, { shown });
}

function toggle(node, ctx, prop, title) {
  const v = attr(node, prop, ctx);
  return field(node, ctx, prop, (id) => ({ type: "Input.Toggle", id, title: title || "On", value: truthy(v) ? "true" : "false", valueOn: "true", valueOff: "false" }), { shown: `${title ? `${title}: ` : ""}${truthy(v) ? "yes" : "no"}` });
}

/** Actions of a dialog-like control: its button aggregations. */
const buttons = (node, ctx, aggs) => renderList(children(node, aggs), ctx);

const STYLES = { Emphasized: "positive", Accept: "positive", Success: "positive", Reject: "destructive", Negative: "destructive", Critical: "destructive" };

function button(node, ctx) {
  if (!ctx.interactive) return [];
  const title = str(node, "text", ctx) || str(node, "tooltip", ctx) || iconName(str(node, "icon", ctx));
  const data = wireData(node, "press", ctx);
  const enabled = node.attrs.enabled === undefined || !falsy(attr(node, "enabled", ctx));
  return [actionSet([submitAction(title, data, { style: STYLES[str(node, "type", ctx)], enabled, tooltip: str(node, "tooltip", ctx) || undefined })])];
}

/** A row's select action: the item's press wire, or the list's row event. */
function rowAction(list, item, rowCtx, ctx) {
  if (!ctx.interactive) return null;
  const own = item.attrs.press !== undefined ? wireData(item, "press", rowCtx) : null;
  if (own) return own;
  if (list.attrs.itemPress !== undefined) return wireData(list, "itemPress", rowCtx);
  return null;
}

const SELECTABLE = new Set(["MultiSelect", "SingleSelect", "SingleSelectLeft", "SingleSelectMaster"]);

/** The selection toggle of a row in a selectable list: `selected` bound. */
function rowToggle(list, item, rowCtx, ctx, title) {
  if (!SELECTABLE.has(str(list, "mode", ctx)) || item.attrs.selected === undefined) return null;
  const els = toggle(item, rowCtx, "selected", title || "select");
  return els[0];
}

function table(node, ctx) {
  const out = [];
  if (node.attrs.headerText !== undefined) out.push(tb(str(node, "headerText", ctx), { weight: "Bolder" }));
  out.push(...renderList(aggregation(node, "headerToolbar"), ctx), ...renderList(aggregation(node, "infoToolbar"), ctx));
  if (node.attrs.selectionChange !== undefined && ctx.interactive) ctx.report(node, "event selectionChange is not raised by a card - the selection travels with the next action");
  const cols = aggregation(node, "columns").filter((c) => c.attrs.visible === undefined || !falsy(attr(c, "visible", ctx)));
  const headers = cols.map((c) => aggregation(c, "header").map((h) => str(h, "text", ctx)).join(" "));
  const rows = rowsOf(node, "items", ctx);
  if (!rows.length) {
    out.push(tb(str(node, "noDataText", ctx) || "No data", { isSubtle: true }));
    return out;
  }
  const selectable = SELECTABLE.has(str(node, "mode", ctx));
  const cellRows = rows.map(({ base, node: item, index }) => {
    const rc = ctx.with(base);
    const cells = aggregation(item, "cells").map((cell) => ({ type: "TableCell", items: renderNode(cell, rc) }));
    const toggleEl = selectable ? rowToggle(node, item, rc, ctx, `row ${index + 1}`) : null;
    if (selectable) cells.unshift({ type: "TableCell", items: toggleEl ? [toggleEl] : [] });
    const act = rowAction(node, item, rc, ctx);
    // a cell with an input keeps its clicks for the input
    if (act) for (const c of cells) if (!c.items.some((e) => /^Input\./.test(e.type))) c.selectAction = submitAction("Open", act);
    for (const c of cells) if (!c.items.length) c.items.push(tb(" "));
    return { type: "TableRow", cells };
  });
  const width = Math.max(cols.length + (selectable ? 1 : 0), ...cellRows.map((r) => r.cells.length));
  const t = { type: "Table", columns: Array.from({ length: width }, () => ({ width: 1 })), rows: [], firstRowAsHeader: headers.some(Boolean) };
  if (t.firstRowAsHeader) t.rows.push({ type: "TableRow", cells: [...(selectable ? [""] : []), ...headers].map((h) => ({ type: "TableCell", items: [tb(h || " ", { weight: "Bolder" })] })) });
  t.rows.push(...cellRows);
  out.push(t);
  return out;
}

/** The nodes of a tree binding, depth first: every array-valued property of
 *  a node is its children (the UI5 JSONModel tree binding). */
function treeRows(node, ctx) {
  const binding = node.attrs.items;
  const template = aggregation(node, "items")[0];
  const p = binding !== undefined ? boundPath(binding, ctx) : null;
  if (!p || !template) return rowsOf(node, "items", ctx).map((r) => ({ ...r, depth: 0 }));
  const out = [];
  const visit = (path, depth) => {
    const data = resolve(`{${path}}`, ctx);
    if (!Array.isArray(data)) return;
    data.forEach((entry, i) => {
      const base = `${path}/${i}`;
      out.push({ base, node: template, index: out.length, depth });
      const kids = entry && typeof entry === "object" ? Object.keys(entry).find((k) => Array.isArray(entry[k])) : null;
      if (kids) visit(`${base}/${kids}`, depth + 1);
    });
  };
  visit(p, 0);
  return out;
}

function list(node, ctx, { tree = false } = {}) {
  const out = [];
  if (node.attrs.headerText !== undefined) out.push(tb(str(node, "headerText", ctx), { weight: "Bolder" }));
  out.push(...renderList(aggregation(node, "headerToolbar"), ctx));
  if (node.attrs.selectionChange !== undefined && ctx.interactive) ctx.report(node, "event selectionChange is not raised by a card - the selection travels with the next action");
  const rows = tree ? treeRows(node, ctx) : rowsOf(node, "items", ctx).map((r) => ({ ...r, depth: 0 }));
  if (!rows.length) {
    out.push(tb(str(node, "noDataText", ctx) || "No data", { isSubtle: true }));
    return out;
  }
  const built = rows.map(({ base, node: item, depth }) => {
    const rc = ctx.with(base);
    const name = `${item.ns}.${item.local}`;
    const indent = depth ? `${"-".repeat(depth)} ` : "";
    if (name === "sap.m.CustomListItem") {
      return { items: renderList(contentChildren(item), rc), action: rowAction(node, item, rc, ctx), toggle: rowToggle(node, item, rc, ctx) };
    }
    const title = indent + str(item, "title", rc);
    const value = str(item, "description", rc) || str(item, "info", rc);
    return { title, value, info: str(item, "info", rc), infoState: str(item, "infoState", rc), description: str(item, "description", rc), action: rowAction(node, item, rc, ctx), toggle: rowToggle(node, item, rc, ctx, title || "select") };
  });
  if (built.every((b) => b.title !== undefined && !b.action && !b.toggle)) {
    out.push({ type: "FactSet", facts: built.map((b) => ({ title: b.title || " ", value: b.value || " " })) });
    return out;
  }
  for (const b of built) {
    const items = b.items ? [...b.items] : [tb(b.title || " ", { weight: "Bolder" })];
    if (!b.items && b.description) items.push(tb(b.description, { isSubtle: true, spacing: "None" }));
    if (!b.items && b.info && b.info !== b.description) items.push(withColor(tb(b.info, { spacing: "None" }), b.infoState));
    if (b.toggle) items.unshift(b.toggle);
    const c = { type: "Container", items, separator: true };
    if (b.action) c.selectAction = submitAction("Open", b.action);
    out.push(c);
  }
  return out;
}

function datePicker(node, ctx) {
  const v = str(node, "value", ctx);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) || (v === "" && /^yyyy-MM-dd$/.test(str(node, "valueFormat", ctx)));
  unraised(node, ctx, ["change"]);
  return field(node, ctx, "value", (id) => (iso
    ? { type: "Input.Date", id, value: v }
    : { type: "Input.Text", id, value: v, placeholder: str(node, "valueFormat", ctx) || str(node, "displayFormat", ctx) || undefined }));
}

const INPUT_STYLE = { Password: "password", Email: "email", Tel: "tel", Url: "url" };

/*
 * The table: control -> { card, note, render }.
 * `card` and `note` are what README.md shows.
 */
export const CONTROLS = {
  // --------------------------------------------------- layout & containers
  "sap.m.Page": {
    card: "Container (flattened): title as heading TextBlock, nav button as Action.Submit",
    note: "`showNavButton` + `navButtonPress` -> an Action.Submit \"Back\" that raises the wired event (the reserved `___ZZZ_NAL` for `_event_nav_app_leave`); header/footer bars render in place",
   
    render(node, ctx) {
      const out = [];
      const custom = aggregation(node, "customHeader");
      if (custom.length) out.push(...renderList(custom, ctx));
      else if (node.attrs.title !== undefined && !falsy(attr(node, "showHeader", ctx) ?? true)) out.push(heading(str(node, "title", ctx), "Large"));
      if (ctx.interactive && truthy(attr(node, "showNavButton", ctx)) && node.attrs.navButtonPress !== undefined) {
        const data = wireData(node, "navButtonPress", ctx);
        if (data) out.push(actionSet([submitAction("Back", data)]));
      }
      out.push(...renderList(aggregation(node, "headerContent"), ctx), ...renderList(aggregation(node, "subHeader"), ctx));
      out.push(...renderList(aggregation(node, "content"), ctx), ...renderList(aggregation(node, "footer"), ctx));
      return out;
    },
  },
  "sap.m.Shell": { card: "(none) - its app renders in place", note: "", render: (node, ctx) => renderList(contentChildren(node), ctx) },
  "sap.m.VBox": { card: "Container", note: "flexbox alignment ignored", render: (node, ctx) => container(renderList(contentChildren(node), ctx)) },
  "sap.ui.layout.form.SimpleForm": {
    card: "Container: each Label becomes the `label` of the input after it",
    note: "the grid layout properties are ignored; a Label not followed by an input is a bold TextBlock",
   
    render: (node, ctx) => container([
      ...(node.attrs.title !== undefined ? [heading(str(node, "title", ctx))] : renderList(aggregation(node, "title"), ctx)),
      ...renderList(aggregation(node, "content"), ctx),
    ]),
  },
  "sap.m.HBox": { card: "ColumnSet (auto-width columns), or one ActionSet when every child is an action", note: "", render: (node, ctx) => row(contentChildren(node), ctx) },
  "sap.m.Panel": {
    card: "Container (style emphasis), headerText as bold TextBlock",
    note: "`expandable`/`expanded` ignored - the content is always shown; `expand` not raised",
   
    render(node, ctx) {
      const head = node.attrs.headerText !== undefined ? [tb(str(node, "headerText", ctx), { weight: "Bolder" })] : [];
      return container([...head, ...renderList(aggregation(node, "headerToolbar"), ctx), ...renderList(aggregation(node, "content"), ctx)], { style: "emphasis" });
    },
  },
  "sap.ui.layout.Grid": { card: "Container", note: "spans ignored - children stack", render: (node, ctx) => container(renderList(contentChildren(node), ctx)) },
  "sap.m.FlexBox": {
    card: "Container (direction Column) or ColumnSet (Row, the default)",
    note: "alignment, gaps and wrap ignored",
   
    render: (node, ctx) => (/^Column/.test(str(node, "direction", ctx)) ? container(renderList(contentChildren(node), ctx)) : row(contentChildren(node), ctx)),
  },
  "sap.m.ScrollContainer": { card: "Container", note: "scrolling is the host's", render: (node, ctx) => container(renderList(contentChildren(node), ctx)) },
  "sap.m.IconTabFilter": {
    card: "Container with the tab text as heading",
    note: "",
   
    render(node, ctx) {
      const title = str(node, "text", ctx) || str(node, "key", ctx);
      const count = str(node, "count", ctx);
      return container([heading(count ? `${title} (${count})` : title, "Default"), ...renderList(aggregation(node, "content"), ctx)]);
    },
  },
  "sap.m.IconTabBar": {
    card: "Container: every tab stacked, each under its heading",
    note: "`selectedKey` ignored - all tabs are shown; `select` not raised",
   
    render(node, ctx) {
      if (node.attrs.select !== undefined && ctx.interactive) ctx.report(node, "event select is not raised by a card - every tab is shown");
      return container([...renderList(aggregation(node, "items"), ctx), ...renderList(aggregation(node, "content"), ctx)]);
    },
  },
  "sap.ui.layout.VerticalLayout": { card: "Container", note: "", render: (node, ctx) => container(renderList(contentChildren(node), ctx)) },
  "sap.ui.core.Title": { card: "TextBlock (heading)", note: "", render: (node, ctx) => [heading(str(node, "text", ctx))] },
  "sap.ui.layout.HorizontalLayout": { card: "ColumnSet / ActionSet (as HBox)", note: "", render: (node, ctx) => row(contentChildren(node), ctx) },

  // ------------------------------------------------------ toolbars & bars
  "sap.m.OverflowToolbar": { card: "ActionSet (all buttons) or ColumnSet", note: "no overflow menu - everything is shown", render: (node, ctx) => row(contentChildren(node), ctx) },
  "sap.m.ToolbarSpacer": { card: "(nothing)", note: "", render: () => [] },
  "sap.m.Toolbar": { card: "ActionSet (all buttons) or ColumnSet", note: "", render: (node, ctx) => row(contentChildren(node), ctx) },
  "sap.m.Bar": { card: "ActionSet or ColumnSet of contentLeft, contentMiddle, contentRight", note: "", render: (node, ctx) => row(children(node, ["contentLeft", "contentMiddle", "contentRight"]), ctx) },
  "sap.m.OverflowToolbarButton": { card: "Action.Submit", note: "as Button", render: button },

  // -------------------------------------------------------------- display
  "sap.m.Text": { card: "TextBlock (wrap)", note: "`maxLines` -> maxLines", render: (node, ctx) => [tb(str(node, "text", ctx), node.attrs.maxLines !== undefined ? { maxLines: Number(attr(node, "maxLines", ctx)) || undefined } : {})] },
  "sap.m.Label": { card: "TextBlock (bolder) - or the `label` of the input that follows", note: "", render: (node, ctx) => [tb(str(node, "text", ctx), { weight: "Bolder" })] },
  "sap.m.Title": { card: "TextBlock (heading, bolder, medium)", note: "", render: (node, ctx) => [heading(str(node, "text", ctx))] },
  "sap.m.ObjectStatus": {
    card: "TextBlock \"title: text\", colored by `state`",
    note: "`active` + `press` -> Action.Submit",
    render(node, ctx) {
      const t = [str(node, "title", ctx), str(node, "text", ctx)].filter(Boolean).join(": ");
      return pressable(node, ctx, "press", t, withColor(tb(t), str(node, "state", ctx)));
    },
  },
  "sap.m.Link": {
    card: "Action.Submit (press wire) or Action.OpenUrl (href), else TextBlock",
    note: "",
    render(node, ctx) {
      const t = str(node, "text", ctx);
      if (node.attrs.press !== undefined) return pressable(node, ctx, "press", t, tb(t, { color: "Accent" }));
      const href = str(node, "href", ctx);
      if (href && ctx.interactive && /^https?:\/\//.test(href)) return [actionSet([{ type: "Action.OpenUrl", title: t || href, url: href }])];
      return [tb(t || href, { color: "Accent" })];
    },
  },
  "sap.m.ObjectIdentifier": {
    card: "TextBlock title (bolder) + TextBlock text (subtle)",
    note: "`titleActive` + `titlePress` -> Action.Submit",
    render(node, ctx) {
      const title = str(node, "title", ctx);
      const out = node.attrs.titlePress !== undefined && truthy(attr(node, "titleActive", ctx)) ? pressable(node, ctx, "titlePress", title, tb(title, { weight: "Bolder" })) : (title ? [tb(title, { weight: "Bolder" })] : []);
      const t = str(node, "text", ctx);
      if (t) out.push(tb(t, { isSubtle: true, spacing: "None" }));
      return out;
    },
  },
  "sap.ui.core.HTML": {
    card: "TextBlock with the text of the HTML",
    note: "tags, `<style>` and `<script>` dropped - reported as approximated",
    render(node, ctx) {
      const t = htmlToText(str(node, "content", ctx));
      if (t) ctx.report(node, "HTML rendered as plain text");
      return t ? [tb(t)] : [];
    },
  },
  "sap.ui.core.Icon": { card: "(nothing), or Action.Submit titled by its tooltip/icon name when it has a press wire", note: "icons are decorative in a card", render: (node, ctx) => pressable(node, ctx, "press", str(node, "alt", ctx) || str(node, "tooltip", ctx) || iconName(str(node, "src", ctx)), null) },
  "sap.m.ObjectNumber": { card: "TextBlock \"number unit\", colored by `state`", note: "", render: (node, ctx) => [withColor(tb([str(node, "number", ctx), str(node, "unit", ctx)].filter(Boolean).join(" "), truthy(attr(node, "emphasized", ctx)) ? { weight: "Bolder" } : {}), str(node, "state", ctx))] },
  "sap.tnt.InfoLabel": { card: "TextBlock (subtle)", note: "`colorScheme` ignored", render: (node, ctx) => [tb(str(node, "text", ctx), { isSubtle: true })] },
  "sap.m.ProgressIndicator": { card: "TextBlock with `displayValue` (or \"<percent> %\")", note: "no bar", render: (node, ctx) => [withColor(tb(str(node, "displayValue", ctx) || `${str(node, "percentValue", ctx) || 0} %`), str(node, "state", ctx))] },
  "sap.m.Image": {
    card: "Image (`src` -> url, `alt` -> altText)",
    note: "only http(s) and data URLs; a press wire -> selectAction",
    render(node, ctx) {
      const src = str(node, "src", ctx);
      if (!/^(https?:|data:image\/)/.test(src)) return src ? [tb(`[image ${src}]`, { isSubtle: true })] : [];
      const img = { type: "Image", url: src };
      const alt = str(node, "alt", ctx);
      if (alt) img.altText = alt;
      const data = ctx.interactive && node.attrs.press !== undefined ? wireData(node, "press", ctx) : null;
      if (data) img.selectAction = submitAction(alt || "Open", data);
      return [img];
    },
  },

  // ---------------------------------------------------------------- input
  "sap.m.Input": {
    card: "Input.Text (Input.Number for type Number; style password/email/tel/url), id = the `value` binding path",
    note: "`submit` -> inlineAction; without it `showValueHelp` + `valueHelpRequest` -> inlineAction; `change`/`liveChange` are not raised (the edit travels with the next action); disabled or not editable -> TextBlock",
    render(node, ctx) {
      const type = str(node, "type", ctx);
      unraised(node, ctx, ["change", "liveChange"]);
      return field(node, ctx, "value", (id, v) => {
        const el = type === "Number" ? { type: "Input.Number", id, value: v === "" || v === undefined || v === null || Number.isNaN(Number(v)) ? undefined : Number(v) } : { type: "Input.Text", id, value: text(v) };
        if (INPUT_STYLE[type]) el.style = INPUT_STYLE[type];
        const max = Number(attr(node, "maxLength", ctx));
        if (max > 0 && el.type === "Input.Text") el.maxLength = max;
        const submit = node.attrs.submit !== undefined ? wireData(node, "submit", ctx) : null;
        const help = !submit && truthy(attr(node, "showValueHelp", ctx)) && node.attrs.valueHelpRequest !== undefined ? wireData(node, "valueHelpRequest", ctx) : null;
        if (submit) el.inlineAction = submitAction("Submit", submit);
        else if (help) el.inlineAction = submitAction("Value help", help);
        return el;
      });
    },
  },
  "sap.m.TextArea": { card: "Input.Text (isMultiline)", note: "`liveChange` not raised", render(node, ctx) { unraised(node, ctx, ["liveChange"]); return field(node, ctx, "value", (id, v) => ({ type: "Input.Text", id, value: text(v), isMultiline: true })); } },
  "sap.ui.core.Item": { card: "a choice (`key` -> value, `text` -> title) of its Select/ComboBox", note: "", render: (node, ctx) => [tb(str(node, "text", ctx))] },
  "sap.m.CheckBox": { card: "Input.Toggle (`text` -> title, value \"true\"/\"false\")", note: "`select` not raised", render(node, ctx) { unraised(node, ctx, ["select"]); return toggle(node, ctx, "selected", str(node, "text", ctx)); } },
  "sap.m.Switch": { card: "Input.Toggle (`state`)", note: "`change` not raised; title = `customTextOn` or \"On\"", render(node, ctx) { unraised(node, ctx, ["change"]); return toggle(node, ctx, "state", str(node, "customTextOn", ctx)); } },
  "sap.m.SegmentedButton": { card: "Input.ChoiceSet (style expanded)", note: "`selectionChange` not raised", render(node, ctx) { unraised(node, ctx, ["selectionChange"]); return choiceSet(node, ctx, { prop: "selectedKey", style: "expanded" }); } },
  "sap.m.SegmentedButtonItem": { card: "a choice of its SegmentedButton", note: "", render: (node, ctx) => [tb(str(node, "text", ctx))] },
  "sap.m.Select": { card: "Input.ChoiceSet (style compact), `selectedKey`, choices from the items (list binding or static)", note: "`change` not raised", render(node, ctx) { unraised(node, ctx, ["change", "liveChange"]); return choiceSet(node, ctx, { prop: "selectedKey", style: "compact" }); } },
  "sap.m.DatePicker": { card: "Input.Date when the value is ISO (yyyy-MM-dd), else Input.Text", note: "Input.Date speaks only yyyy-MM-dd; other `valueFormat`s stay text; `change` not raised", render: datePicker },
  "sap.m.SearchField": {
    card: "Input.Text, `search` -> inlineAction",
    note: "`liveChange`/`suggest` not raised",
    render(node, ctx) {
      unraised(node, ctx, ["liveChange", "suggest"]);
      return field(node, ctx, "value", (id, v) => {
        const el = { type: "Input.Text", id, value: text(v) };
        const data = node.attrs.search !== undefined ? wireData(node, "search", ctx) : null;
        if (data) el.inlineAction = submitAction("Search", data);
        return el;
      });
    },
  },
  "sap.m.ComboBox": { card: "Input.ChoiceSet (style filtered)", note: "`change` not raised", render(node, ctx) { unraised(node, ctx, ["change"]); return choiceSet(node, ctx, { prop: node.attrs.selectedKey !== undefined ? "selectedKey" : "value", style: "filtered" }); } },
  "sap.m.MultiInput": {
    card: "Input.Text with the token texts",
    note: "tokens are shown, not edited as tokens - approximated",
   
    render(node, ctx) {
      const tokens = rowsOf(node, "tokens", ctx).map(({ base, node: t }) => str(t, "text", ctx.with(base)) || str(t, "key", ctx.with(base)));
      if (tokens.length) ctx.report(node, "tokens shown as text");
      unraised(node, ctx, ["change", "tokenUpdate"]);
      return field(node, ctx, "value", (id, v) => ({ type: "Input.Text", id, value: text(v), ...(tokens.length ? { label: tokens.join(", ") } : {}) }));
    },
  },
  "sap.m.Token": { card: "a text of its MultiInput", note: "", render: (node, ctx) => [tb(str(node, "text", ctx))] },
  "sap.m.MultiComboBox": { card: "Input.ChoiceSet (isMultiSelect), `selectedKeys` joined by commas", note: "`selectionChange`/`selectionFinish` not raised", render(node, ctx) { unraised(node, ctx, ["selectionChange", "selectionFinish"]); return choiceSet(node, ctx, { prop: "selectedKeys", style: "compact", multi: true }); } },
  "sap.m.StepInput": { card: "Input.Number (`min`, `max`)", note: "`step` ignored; `change` not raised", render(node, ctx) { unraised(node, ctx, ["change"]); return field(node, ctx, "value", (id, v) => { const el = { type: "Input.Number", id, value: Number.isNaN(Number(v)) || v === "" || v === null || v === undefined ? undefined : Number(v) }; for (const k of ["min", "max"]) if (node.attrs[k] !== undefined) el[k] = Number(attr(node, k, ctx)); return el; }); } },
  "sap.ui.core.ListItem": { card: "a choice of its ComboBox/Select", note: "`additionalText` dropped", render: (node, ctx) => [tb(str(node, "text", ctx))] },
  "sap.m.DateTimePicker": { card: "Input.Text", note: "no date-time input in 1.5; `change` not raised", render(node, ctx) { unraised(node, ctx, ["change"]); return field(node, ctx, "value", (id, v) => ({ type: "Input.Text", id, value: text(v) })); } },

  // -------------------------------------------------------------- actions
  "sap.m.Button": { card: "Action.Submit, data { event, args } (a `.eF` wire: { client: [...] })", note: "`type` Emphasized/Accept -> style positive, Reject/Negative -> destructive; `enabled=false` -> isEnabled false; neighbouring buttons share one ActionSet", render: button },
  "sap.m.ToggleButton": { card: "Input.Toggle (`pressed`)", note: "`press` not raised - the state travels with the next action", render(node, ctx) { unraised(node, ctx, ["press"]); return toggle(node, ctx, "pressed", str(node, "text", ctx) || iconName(str(node, "icon", ctx))); } },

  // ------------------------------------------------- collections & tables
  "sap.m.Column": { card: "a column of its Table; `header` -> the header row", note: "popin and widths ignored", render: () => [] },
  "sap.m.ColumnListItem": { card: "TableRow; `press` -> selectAction of its cells; `selected` -> a leading Input.Toggle in a selectable table", note: "", render: (node, ctx) => row(aggregation(node, "cells"), ctx) },
  "sap.m.Table": { card: "Table (1.5): header row from the columns, a TableRow per row of the list binding", note: "`itemPress` -> selectAction per row; `mode` *Select + `selected` binding -> Input.Toggle per row; growing ignored (every row is shown); `selectionChange` not raised", render: table },
  "sap.m.List": { card: "FactSet (title -> value from description/info) - a Container per row when rows are pressable, selectable or custom", note: "`itemPress`/item `press` -> selectAction; `mode` *Select + `selected` binding -> Input.Toggle; `delete`/`selectionChange` not raised", render: (node, ctx) => list(node, ctx) },
  "sap.m.StandardListItem": { card: "a fact (or row Container) of its List", note: "`icon`, `counter`, `highlight` dropped", render: (node, ctx) => [tb(str(node, "title", ctx))] },
  "sap.m.CustomListItem": { card: "a row Container of its List", note: "", render: (node, ctx) => container(renderList(contentChildren(node), ctx)) },
  "sap.m.Tree": { card: "FactSet / row Containers, the tree flattened depth first (\"- \" per level)", note: "every node is shown expanded; `toggleOpenState` not raised", render: (node, ctx) => list(node, ctx, { tree: true }) },
  "sap.m.StandardTreeItem": { card: "a fact of its Tree", note: "`icon` dropped", render: (node, ctx) => [tb(str(node, "title", ctx))] },

  // ---------------------------------------------------- dialogs & popups
  "sap.m.Dialog": {
    card: "Container (style emphasis): title heading, content, buttons as one ActionSet",
    note: "rendered above the page, which turns read-only while it is open (modal); `afterClose` not raised",
   
    render(node, ctx) {
      const out = [];
      const custom = aggregation(node, "customHeader");
      if (custom.length) out.push(...renderList(custom, ctx));
      else if (node.attrs.title !== undefined) out.push(heading(str(node, "title", ctx)));
      out.push(...renderList(aggregation(node, "subHeader"), ctx), ...renderList(aggregation(node, "content"), ctx));
      out.push(...buttons(node, ctx, ["buttons", "beginButton", "endButton"]), ...renderList(aggregation(node, "footer"), ctx));
      return out;
    },
  },
  "sap.m.Popover": {
    card: "Container (style emphasis): title heading, content, footer",
    note: "no anchor - shown above the page, which turns read-only while it is open; `afterClose` not raised",
   
    render(node, ctx) {
      const out = [];
      if (node.attrs.title !== undefined) out.push(heading(str(node, "title", ctx)));
      out.push(...renderList(aggregation(node, "content"), ctx), ...buttons(node, ctx, ["beginButton", "endButton"]), ...renderList(aggregation(node, "footer"), ctx));
      return out;
    },
  },

  // ------------------------------------------------------------- messages
  "sap.m.MessageStrip": { card: "TextBlock colored by `type` (Error -> attention, Warning -> warning, Success -> good, Information -> accent)", note: "`showCloseButton`/`close` dropped; formatted text shown as text", render: (node, ctx) => [withColor(tb(truthy(attr(node, "enableFormattedText", ctx)) ? htmlToText(str(node, "text", ctx)) : str(node, "text", ctx)), str(node, "type", ctx) || "Information")] },

  // ----------------------------------------------------- tolerated (no UI)
  "sap.ui.core.CustomData": { card: "(nothing)", note: "tolerated, no UI", render: () => [] },
  "sap.m.FlexItemData": { card: "(nothing)", note: "tolerated, no UI", render: () => [] },
  "sap.ui.layout.GridData": { card: "(nothing)", note: "tolerated, no UI", render: () => [] },
  "sap.m.OverflowToolbarLayoutData": { card: "(nothing)", note: "tolerated, no UI", render: () => [] },
};

export { walk };

/*
 * VENDORED - do not edit. abap2UI5/protocol renderers/adaptive-cards/render.mjs
 * at commit 604d26769a9b7dcaa1f985f1297ff9c0a59b012e,
 * copied by scripts/vendor-adaptive-cards.mjs; the only change is that the
 * imports of the agent modules point at lib/ (the originals the protocol
 * repository vendors) instead of its copies. `node scripts/vendor-adaptive-cards.mjs
 * --check` fails when this copy drifts from that commit. Change it upstream,
 * then re-vendor.
 */
/*
 * abap2UI5 view -> Adaptive Card (schema 1.5). A pure function of the
 * folded response state (the vendored agent client's applyResponse: the views
 * in their slots, the models), no browser, no I/O:
 *
 *   renderCard(state, { messages, error, typed }) -> { card, unsupported }
 *
 * The view XML is parsed by the vendored mcp-server viewxml module (resolved
 * namespaces, bindings, event wires, expression bindings without eval); the
 * mapping of each portable control is the table in mapping.mjs, which also
 * generates the README.
 *
 * Inputs carry their binding path as id (`/NAME`, `/T_ITEMS/1/TEXT`), so an
 * Action.Submit payload names the model paths it changed (submit.mjs turns it
 * back into the next protocol request). A backend event becomes an
 * Action.Submit whose data is { event, args } - args resolved when the card
 * was rendered, `refs` naming the model path of an argument read from the
 * model, so the reverse step can read it again after the edits of the same
 * submit. A frontend-only wire (`.eF(...)`) becomes { client: [action,
 * args...] }, the reserved leave event { event: "___ZZZ_NAL" }.
 *
 * The live layers are interactive (liveSlots: a message box or a popup
 * alone - they are modal - else the popover and MAIN); the layers below a
 * modal one are rendered read-only (texts, no inputs, no actions). An action
 * of a popup or popover names its slot in its data (`slot`), so the reverse
 * step knows whose inputs and model it submits.
 */
import { parseViewXml, parseBinding, parseWire, evalExpression, isAggregation, controlName } from "../../viewxml.mjs";
import { getAt } from "../../snapshot.mjs";
import { CONTROLS, TOLERATED } from "./mapping.mjs";

export const CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const CARD_VERSION = "1.5";

/** The reserved leave event (spec/navigation.md#the-reserved-leave-event). */
export const LEAVE_EVENT = "___ZZZ_NAL";

const MODEL_OWNING = { MAIN: "MAIN", NEST: "MAIN", NEST2: "MAIN", POPUP: "POPUP", POPOVER: "POPOVER" };
export const modelKeyOf = (slot) => MODEL_OWNING[slot] || "MAIN";

/**
 * The slots whose inputs and actions are live. A message box and a popup are
 * modal: only they are. A popover is not (UI5 closes it on a press outside):
 * the popover and MAIN are live, a press in MAIN closes the popover first.
 */
export function liveSlots(state, messages = []) {
  const slots = (state && state.slots) || {};
  if (messages.some((m) => m.kind === "box")) return ["BOX"];
  if (slots.POPUP) return ["POPUP"];
  if (slots.POPOVER) return ["POPOVER", "MAIN"];
  return ["MAIN"];
}

// ------------------------------------------------------------ values ----

const join = (base, rel) => `${base.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;

/** The absolute model path of a relative or absolute binding path. */
export function absolutePath(path, base) {
  if (path.startsWith("/")) return path;
  return join(base || "", path);
}

/** A model reference of an expression or a composite binding. */
function refValue(ref, ctx) {
  const r = String(ref).trim();
  if (/^[A-Za-z_][\w.-]*>/.test(r)) return undefined; // a named model (device>): not ours
  return getAt(ctx.model, absolutePath(r, ctx.base));
}

/** A property value, with its bindings resolved against the model. */
export function resolve(value, ctx) {
  const b = parseBinding(value);
  switch (b.kind) {
    case "literal":
      return b.value;
    case "path":
      return b.model ? undefined : getAt(ctx.model, absolutePath(b.path, ctx.base));
    case "expression":
      return evalExpression(b.expression, (r) => refValue(r, ctx));
    default:
      return b.parts.map((p) => {
        if (p.text !== undefined) return p.text;
        if (p.path !== undefined && !p.model) {
          const v = getAt(ctx.model, absolutePath(p.path, ctx.base));
          return v === undefined || v === null ? "" : String(v);
        }
        return "";
      }).join("");
  }
}

/** The model path a two-way property is bound to, or null. */
export function boundPath(value, ctx) {
  if (value === undefined) return null;
  const b = parseBinding(value);
  if (b.kind !== "path" || b.model) return null;
  return absolutePath(b.path, ctx.base);
}

export const text = (v) => (v === undefined || v === null ? "" : String(v));
const truthy = (v) => v === true || v === "true" || v === "X";
const falsy = (v) => v === false || v === "false" || v === "" || v === null;

// ------------------------------------------------------------- nodes ----

/** The control children of a node: its own, and those of its aggregation
 *  elements (all of them, or the ones named). */
export function children(node, names) {
  const out = [];
  for (const c of node.children) {
    if (isAggregation(c)) {
      if (!names || names.includes(c.local)) out.push(...c.children.filter((x) => !isAggregation(x)));
    } else if (!names || names.includes(defaultAggregationOf(node))) {
      out.push(c);
    }
  }
  return out;
}

/** The children of one named aggregation (the default aggregation also
 *  takes the children written without its element). */
export function aggregation(node, name) {
  return children(node, [name]);
}

function defaultAggregationOf(node) {
  const m = CONTROLS[controlName(node)];
  return (m && m.defaultAggregation) || "content";
}

const SKIP_AGGREGATIONS = new Set(["layoutData", "customData", "dependents", "tooltip"]);

/** Every control child except the non-visual aggregations. */
export function contentChildren(node, except = []) {
  const out = [];
  for (const c of node.children) {
    if (isAggregation(c)) {
      if (SKIP_AGGREGATIONS.has(c.local) || except.includes(c.local)) continue;
      out.push(...c.children.filter((x) => !isAggregation(x)));
    } else {
      out.push(c);
    }
  }
  return out;
}

/** The rows of a list binding: [{ base, node }] per row, or the static
 *  children as rows with the current base. */
export function rowsOf(node, aggName, ctx) {
  const binding = node.attrs[aggName];
  const items = aggregation(node, aggName);
  if (binding !== undefined) {
    const p = boundPath(binding, ctx) || listPath(binding, ctx);
    const template = items[0];
    const data = p ? getAt(ctx.model, p) : undefined;
    if (!template || !Array.isArray(data)) return [];
    return data.map((_, i) => ({ base: `${p}/${i}`, node: template, index: i }));
  }
  return items.map((n, i) => ({ base: ctx.base, node: n, index: i }));
}

function listPath(binding, ctx) {
  const b = parseBinding(binding);
  if (b.kind === "composite" && b.parts.length === 1 && b.parts[0].path !== undefined && !b.parts[0].model) return absolutePath(b.parts[0].path, ctx.base);
  return null;
}

// ------------------------------------------------------------ events ----

/** An event wire of a control as Action.Submit data, or null. */
export function wireData(node, eventName, ctx) {
  const raw = node.attrs[eventName];
  if (raw === undefined) return null;
  const w = parseWire(raw);
  if (!w) {
    ctx.report(node, `event ${eventName}: "${String(raw).slice(0, 60)}" is no abap2UI5 wire`);
    return null;
  }
  const args = [];
  const refs = [];
  for (const [i, a] of w.args.entries()) {
    if (a.static) {
      args.push(a.value);
      continue;
    }
    if (a.kind === "model" || a.kind === "row") {
      const p = absolutePath(a.path, ctx.base);
      args.push(getAt(ctx.model, p) ?? null);
      if (a.kind === "model") refs[i] = p;
      continue;
    }
    if (a.kind === "source") {
      args.push(resolve(node.attrs[a.prop], ctx) ?? null);
      continue;
    }
    ctx.report(node, `event ${eventName}: argument ${a.describe} needs the UI5 runtime - sent as null`);
    args.push(null);
  }
  const data = w.fn === "eF" ? { client: [w.action, ...args] } : { event: w.event };
  if (w.fn !== "eF" && args.length) data.args = args;
  if (refs.some(Boolean)) data.refs = Array.from(refs, (r) => r || null);
  // the slot of the action, when it is not MAIN: its inputs and model are the slot's
  if (modelKeyOf(ctx.slot) !== "MAIN") data.slot = ctx.slot;
  return data;
}

/** An Action.Submit for an event wire (or a disabled one without a wire). */
export function submitAction(title, data, { style, enabled = true, tooltip } = {}) {
  const a = { type: "Action.Submit", title: title || "(action)" };
  if (style) a.style = style;
  if (tooltip) a.tooltip = tooltip;
  if (data) a.data = data;
  if (!data || !enabled) a.isEnabled = false;
  return a;
}

export const actionSet = (actions) => ({ type: "ActionSet", actions });

// ------------------------------------------------------------ render ----

/*
 * The render context: the model of the slot, the binding context of the
 * current row (`base`), whether the layer is interactive, and the sink for
 * what could not be rendered.
 */
function context({ model, slot, interactive, unsupported, ids }) {
  const ctx = {
    model: model || {},
    base: "",
    slot,
    interactive,
    ids,
    report(node, reason) {
      unsupported.push({ slot, control: controlName(node), ...(node.attrs.id ? { id: node.attrs.id } : {}), reason });
    },
    with(base) {
      return { ...ctx, base };
    },
  };
  return ctx;
}

/** One control -> card elements. */
export function renderNode(node, ctx) {
  if (isAggregation(node)) return renderList(node.children, ctx);
  if (node.attrs.visible !== undefined) {
    const v = resolve(node.attrs.visible, ctx);
    if (falsy(v)) return [];
  }
  const name = controlName(node);
  if (TOLERATED.has(name)) return [];
  const m = CONTROLS[name];
  if (!m) {
    ctx.report(node, "not in the portable profile - placeholder");
    return [{ type: "TextBlock", text: `[${name} - not rendered]`, isSubtle: true, wrap: true }];
  }
  return m.render(node, ctx) || [];
}

const INPUT_TYPES = new Set(["Input.Text", "Input.Number", "Input.Date", "Input.Time", "Input.Toggle", "Input.ChoiceSet"]);

/** A list of controls -> card elements: a Label names the input after it,
 *  neighbouring action sets merge into one. */
export function renderList(nodes, ctx) {
  const out = [];
  let label = null;
  for (const n of nodes) {
    if (isAggregation(n)) {
      out.push(...renderList(n.children, ctx));
      continue;
    }
    const name = controlName(n);
    if (name === "sap.m.Label" && ctx.interactive) {
      if (label) out.push(label.element);
      const visible = n.attrs.visible === undefined || !falsy(resolve(n.attrs.visible, ctx));
      label = visible ? { text: text(resolve(n.attrs.text, ctx)), element: CONTROLS["sap.m.Label"].render(n, ctx)[0] } : null;
      continue;
    }
    const els = renderNode(n, ctx);
    if (label) {
      const first = els[0];
      if (first && INPUT_TYPES.has(first.type) && !first.label && label.text) first.label = label.text;
      else out.push(label.element);
      label = null;
    }
    for (const e of els) {
      const prev = out[out.length - 1];
      if (e.type === "ActionSet" && prev && prev.type === "ActionSet") prev.actions.push(...e.actions);
      else out.push(e);
    }
  }
  if (label) out.push(label.element);
  return out;
}

/** A unique input id: the binding path, or the view id, or a counter. */
export function inputId(node, path, ctx) {
  let id = path || (node.attrs.id ? `${ctx.slot}:${node.attrs.id}` : `${ctx.slot}:input-${ctx.ids.size + 1}`);
  if (ctx.ids.has(id)) {
    let n = 2;
    while (ctx.ids.has(`${id}#${n}`)) n += 1;
    id = `${id}#${n}`;
  }
  ctx.ids.add(id);
  return id;
}

/** A read-only stand-in for an input in a layer that is not interactive. */
export function readOnly(labelText, value) {
  return { type: "TextBlock", text: labelText ? `${labelText}: ${text(value)}` : text(value), wrap: true };
}

// -------------------------------------------------------------- card ----

/** The text of a message box's HTML details, for a TextBlock: tags dropped,
 *  entities decoded - nothing of the markup is rendered. */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

function parseSlot(xml) {
  const root = parseViewXml(xml);
  // the document element (mvc:View / core:FragmentDefinition) carries no UI
  const doc = root.children.find((c) => !isAggregation(c)) || root;
  return /^(View|FragmentDefinition)$/.test(doc.local) ? doc.children : [doc];
}

function renderSlot(state, slot, { interactive, unsupported, ids, typed }) {
  const s = state.slots[slot];
  const key = modelKeyOf(slot);
  const model = (state.models[key] && state.models[key].data) || {};
  const ctx = context({ model, slot, interactive, unsupported, ids });
  const items = renderList(parseSlot(s.xml), ctx);
  if (typed && interactive) applyTyped(items, typed);
  return items;
}

/** Values the user typed and did not submit yet, over the rendered ones. */
function applyTyped(items, typed) {
  walk(items, (e) => {
    if (e.id && INPUT_TYPES.has(e.type) && typed.has(e.id)) e.value = typed.get(e.id);
  });
}

/** Visit every element and action of a card body. */
export function walk(items, fn) {
  for (const e of items || []) {
    if (!e || typeof e !== "object") continue;
    fn(e);
    walk(e.items, fn);
    walk(e.actions, fn);
    if (e.inlineAction) walk([e.inlineAction], fn);
    if (e.selectAction) walk([e.selectAction], fn);
    for (const c of e.columns || []) walk(c.items, fn);
    for (const r of e.rows || []) for (const c of r.cells || []) { if (c.selectAction) walk([c.selectAction], fn); walk(c.items, fn); }
    if (e.card) walk(e.card.body, fn);
  }
}

const BOX_STYLE = { error: "attention", warning: "warning", success: "good", alert: "attention", information: "accent", show: "emphasis", confirm: "emphasis" };

function renderBox(box, interactive) {
  const items = [];
  if (box.title) items.push({ type: "TextBlock", text: box.title, weight: "Bolder", size: "Medium", wrap: true, style: "heading" });
  items.push({ type: "TextBlock", text: text(box.text), wrap: true });
  // details are shown with the box, expanded (spec/actions.md#messages)
  if (box.details) items.push({ type: "TextBlock", text: htmlToText(box.details), wrap: true, isSubtle: true });
  if (interactive) {
    const actions = (box.actions && box.actions.length ? box.actions : ["OK"]).map((a) => ({ type: "Action.Submit", title: String(a), data: { box: String(a) } }));
    items.push(actionSet(actions));
  }
  return { type: "Container", id: "message-box", style: BOX_STYLE[box.type] || "emphasis", items };
}

/**
 * The card for the folded state.
 *   messages  [{ kind: "toast"|"box", ... }] of the last response (host.mjs)
 *   error     { text } - the error the frontend shows, verbatim
 *   typed     Map<input id, value> the user typed and did not submit yet
 * Resolves { card, unsupported: [{ slot, control, id?, reason }] }.
 */
export function renderCard(state, { messages = [], error = null, typed = null } = {}) {
  const unsupported = [];
  const ids = new Set();
  const body = [];
  const slots = (state && state.slots) || {};
  const box = messages.find((m) => m.kind === "box");
  const live = liveSlots(state, messages);

  if (error) {
    // verbatim: a TextRun is not markdown, nothing in the body is markup
    body.push({ type: "Container", id: "error", style: "attention", items: [{ type: "RichTextBlock", inlines: [{ type: "TextRun", text: error.text }] }] });
  }
  for (const t of messages.filter((m) => m.kind === "toast")) body.push({ type: "TextBlock", text: t.text, isSubtle: true, wrap: true });
  if (box) body.push(renderBox(box, live.includes("BOX")));
  // MAIN is rendered first, so its inputs keep the plain binding paths as ids
  const rendered = {};
  for (const slot of ["MAIN", "POPUP", "POPOVER"]) {
    if (slots[slot]) rendered[slot] = renderSlot(state, slot, { interactive: live.includes(slot), unsupported, ids, typed });
  }
  for (const slot of ["POPUP", "POPOVER", "MAIN", "NEST", "NEST2"]) {
    if (!slots[slot]) continue;
    if (slot === "NEST" || slot === "NEST2") {
      // not in portable profile v1: processed, shown as a placeholder (profiles/portable.md section 2)
      unsupported.push({ slot, control: slot, reason: "nested view slot - not in portable profile v1, placeholder" });
      body.push({ type: "Container", id: `slot-${slot}`, items: [{ type: "TextBlock", text: `[${slot} view - not rendered]`, isSubtle: true, wrap: true }] });
      continue;
    }
    const items = rendered[slot];
    const c = { type: "Container", id: `slot-${slot}`, items: items.length ? items : [{ type: "TextBlock", text: " " }] };
    if (slot !== "MAIN") c.style = "emphasis";
    body.push(c);
  }
  const card = { type: "AdaptiveCard", $schema: CARD_SCHEMA, version: CARD_VERSION, body };
  return { card, unsupported };
}

/** The text a card shows (for tests and the conformance adapter). */
export function cardText(items) {
  const out = [];
  walk(Array.isArray(items) ? items : [items], (e) => {
    if (e.type === "TextBlock") out.push(e.text);
    else if (e.type === "RichTextBlock") out.push(...e.inlines.map((i) => (typeof i === "string" ? i : i.text)));
    else if (e.type === "FactSet") for (const f of e.facts) out.push(f.title, f.value);
    else if (e.type === "Input.Toggle") out.push(e.label, e.title);
    else if (e.type === "Input.ChoiceSet") {
      const chosen = String(e.value ?? "").split(",");
      out.push(e.label, ...e.choices.filter((c) => chosen.includes(c.value)).map((c) => c.title));
    } else if (e.type && e.type.startsWith("Input.")) out.push(e.label, e.value);
    else if (e.type && e.type.startsWith("Action.")) out.push(e.title);
  });
  return out.filter((x) => x !== undefined && x !== null && x !== "").map(String).join(" ");
}

export { truthy, falsy };

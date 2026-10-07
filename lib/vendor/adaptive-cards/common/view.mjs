/*
 * VENDORED - do not edit. abap2UI5/protocol renderers/common/view.mjs
 * at commit 29aad60639a5ff3451d592a474cad8af082a2c55,
 * copied by scripts/vendor-adaptive-cards.mjs; the only change is that the
 * relative paths point at the vendored folder, and the imports of the agent
 * modules at lib/ (the originals the protocol repository vendors) instead of
 * its copies. `node scripts/vendor-adaptive-cards.mjs
 * --check` fails when this copy drifts from that commit. Change it upstream,
 * then re-vendor.
 */
/*
 * What every portable renderer of this repository does with a view before it
 * draws anything - shared by the Adaptive Cards renderer
 * (../adaptive-cards/) and the terminal renderer (../terminal/). Pure
 * functions over the folded response state of the vendored mcp-server
 * snapshot module (`applyResponse`: the views in their slots, the models);
 * the view XML itself is read by the vendored viewxml module (namespaces,
 * bindings, event wires, expression bindings without eval).
 *
 *   values   resolve, boundPath, absolutePath - bindings against a model
 *   nodes    children, aggregation, contentChildren, rowsOf - the control
 *            tree with its aggregations and list bindings
 *   events   wireData - an event wire as the action data both renderers
 *            submit ({ event, args, refs, slot } / { client: [...] })
 *   slots    parseSlot, liveSlots, modelKeyOf
 *
 * A render context `ctx` is { model, base, slot, report(node, reason),
 * with(base) } - the model of the slot, the binding context of the current
 * row and the sink for what could not be rendered.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseViewXml, parseBinding, parseWire, evalExpression, isAggregation, controlName } from "../../../viewxml.mjs";
import { getAt } from "../../../snapshot.mjs";

export { isAggregation, controlName, getAt };

export const PROFILE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../profiles/portable-v1.json", import.meta.url)), "utf8"));

/** The reserved leave event (spec/navigation.md#the-reserved-leave-event). */
export const LEAVE_EVENT = "___ZZZ_NAL";

const MODEL_OWNING = { MAIN: "MAIN", NEST: "MAIN", NEST2: "MAIN", POPUP: "POPUP", POPOVER: "POPOVER" };
/** The model a slot's bindings read: MAIN, NEST and NEST2 share one. */
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

/** Elements that carry no UI (profiles/portable.md section 2). */
export const TOLERATED = new Set(Object.entries(PROFILE.controls).filter(([, c]) => c.tolerated).map(([n]) => n));

/*
 * The aggregation the children of a control go to when they are written
 * without an aggregation element (profiles/portable.md section 2) - the
 * profile's `defaultAggregation`, plus the two controls whose items views
 * write bare though the census records no default; "content" for the rest.
 */
export const DEFAULT_AGGREGATION = {
  ...Object.fromEntries(Object.entries(PROFILE.controls).filter(([, c]) => c.defaultAggregation).map(([n, c]) => [n, c.defaultAggregation])),
  "sap.m.IconTabBar": "items",
  "sap.m.SegmentedButton": "items",
};

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
export const truthy = (v) => v === true || v === "true" || v === "X";
export const falsy = (v) => v === false || v === "false" || v === "" || v === null;

// ------------------------------------------------------------- nodes ----

const defaultAggregationOf = (node) => DEFAULT_AGGREGATION[controlName(node)] || "content";

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

/**
 * An event wire of a control as action data, or null: { event, args, refs,
 * slot } for a backend event - args resolved now, `refs` naming the model
 * path of an argument read from the model so the request step can read it
 * again after the edits that travel with it; { client: [action, args...] }
 * for a frontend-only wire (`.eF`). `params` are the event parameters a
 * renderer can provide (`${$parameters>/value}`, profiles/portable.md
 * section 5); an argument nobody can evaluate is reported and sent as null.
 */
export function wireData(node, eventName, ctx, params) {
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
    if (a.kind === "parameters" && params && Object.prototype.hasOwnProperty.call(params, a.path)) {
      args.push(params[a.path] ?? null);
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

// ------------------------------------------------------------- slots ----

/** The control nodes of a slot's document: the document element
 *  (mvc:View / core:FragmentDefinition) carries no UI. */
export function parseSlot(xml) {
  const root = parseViewXml(xml);
  const doc = root.children.find((c) => !isAggregation(c)) || root;
  return /^(View|FragmentDefinition)$/.test(doc.local) ? doc.children : [doc];
}

/* <script> and <style> blocks with their content, each to its first closing
 * tag; one without a closing tag stays (its tag goes with the other tags),
 * and so does every later one of that name - none can close either. */
function dropBlocks(s) {
  const open = /<(script|style)\b/gi;
  const unclosed = new Set();
  let out = "";
  let at = 0;
  let m;
  while ((m = open.exec(s))) {
    const name = m[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = open.lastIndex;
    const c = close.exec(s);
    if (!c) {
      unclosed.add(name);
      continue;
    }
    out += `${s.slice(at, m.index)} `;
    at = close.lastIndex;
    open.lastIndex = at;
  }
  return out + s.slice(at);
}

/** The text of HTML (a message box's details, core:HTML): tags dropped,
 *  entities decoded - nothing of the markup is rendered. */
export function htmlToText(html) {
  // no pattern here scans past the next "<": /<[^>]*>/ and the lazy
  // <script>...</script> tried every "<" to the end of the text - quadratic,
  // 100k characters of "<" held the renderer for seconds
  return dropBlocks(String(html || ""))
    .replace(/<(br|\/p|\/li|\/div|\/h[1-6])\b[^<>]*>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "- ")
    .replace(/<[^<>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

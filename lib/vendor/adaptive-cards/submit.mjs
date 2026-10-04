/*
 * VENDORED - do not edit. abap2UI5/protocol renderers/adaptive-cards/submit.mjs
 * at commit 604d26769a9b7dcaa1f985f1297ff9c0a59b012e,
 * copied by scripts/vendor-adaptive-cards.mjs; the only change is that the
 * imports of the agent modules point at lib/ (the originals the protocol
 * repository vendors) instead of its copies. `node scripts/vendor-adaptive-cards.mjs
 * --check` fails when this copy drifts from that commit. Change it upstream,
 * then re-vendor.
 */
/*
 * The way back: an Action.Submit payload of a card rendered by render.mjs ->
 * the next protocol request (spec/request.md). Pure, no I/O:
 *
 *   submitToRequest(state, payload, { pending }) ->
 *     { kind: "event",  request, model, edits }   a roundtrip to send
 *     { kind: "client", action, model, edits }    a frontend-only wire (.eF)
 *     { kind: "box",    action, model, edits }    a message box button
 *
 * An Adaptive Cards host submits the action's `data` merged with the values
 * of the card's inputs, keyed by input id - and the ids are binding paths.
 * Every input whose value differs from the model the card was rendered from
 * is an edit: it is written into a copy of the slot's model (`model`) and
 * travels as the model delta the UI5 frontend builds (the vendored
 * buildDelta: a scalar or structure whole, table cells as `__delta` rows).
 * Values arrive as strings (that is what a card submits) and are read back in
 * the type the model holds there.
 */
import { buildDelta } from "../../appclient.mjs";
import { getAt, setAt } from "../../snapshot.mjs";
import { modelKeyOf } from "./render.mjs";

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** A submitted input value in the type the model holds at that path. */
export function coerce(value, current) {
  if (typeof current === "number") {
    const n = Number(value);
    return value === "" || value === null || Number.isNaN(n) ? value : n;
  }
  if (typeof current === "boolean") return value === true || value === "true";
  if (Array.isArray(current)) return String(value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (value === null || value === undefined) return "";
  return typeof value === "boolean" || typeof value === "number" ? value : String(value);
}

const same = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

/** The input values of a payload: the keys that are model paths (`/X`,
 *  `/T/1/C`; a duplicate id carries `#<n>`) - only those of `ids` when given
 *  (the inputs of the action's slot: a card submits all of its inputs). */
export function inputsOf(payload, ids) {
  return Object.entries(payload || {})
    .filter(([k]) => k.startsWith("/") && (!ids || ids.includes(k)))
    .map(([k, v]) => [k.replace(/#\d+$/, ""), v]);
}

/**
 * state    the folded response state the card was rendered from
 * payload  { ...action.data, "<input id>": value, ... } - data.slot names
 *          the slot of the action (absent: MAIN)
 * ids      the input ids of that slot on the card (default: every path key)
 * pending  paths of the slot's model edited earlier and not sent yet
 */
export function submitToRequest(state, payload, { pending = [], ids } = {}) {
  const slot = payload.slot || "MAIN";
  const key = modelKeyOf(slot);
  const model = clone((state.models[key] && state.models[key].data) || {});
  const edits = [];
  for (const [path, raw] of inputsOf(payload, ids)) {
    const current = getAt(model, path);
    const value = coerce(raw, current);
    if (same(value, current)) continue;
    setAt(model, path, value);
    if (!edits.includes(path)) edits.push(path);
  }
  const base = { slot, model, edits };
  if (Array.isArray(payload.client)) return { kind: "client", action: payload.client, ...base };
  if (payload.box !== undefined) return { kind: "box", action: String(payload.box), ...base };
  if (!payload.event) throw new Error("the payload names no event - not an action of this renderer");
  const args = Array.isArray(payload.args) ? payload.args.slice() : [];
  // an argument read from the model reads it after this submit's own edits
  (payload.refs || []).forEach((p, i) => {
    if (p) args[i] = getAt(model, p) ?? null;
  });
  return { kind: "event", request: eventRequest(state, payload.event, args, buildDelta([...new Set([...pending, ...edits])], model)), ...base };
}

/** An event request continuing the state's draft id (spec/request.md#event-requests). */
export function eventRequest(state, event, args = [], delta = {}) {
  const front = { ID: state.id, EVENT: event };
  if (args.length) front.T_EVENT_ARG = args;
  const request = { S_FRONT: front };
  if (delta && Object.keys(delta).length) request.MODEL = delta;
  return request;
}

/** The app-start request (spec/request.md#app-start-shaped-requests). */
export function startRequest({ origin, pathname, search }) {
  const front = { ORIGIN: origin, PATHNAME: pathname };
  if (search) front.SEARCH = search;
  return { S_FRONT: front };
}

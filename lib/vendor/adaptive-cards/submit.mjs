/*
 * VENDORED - do not edit. abap2UI5/protocol renderers/adaptive-cards/submit.mjs
 * at commit 29aad60639a5ff3451d592a474cad8af082a2c55,
 * copied by scripts/vendor-adaptive-cards.mjs; the only change is that the
 * relative paths point at the vendored folder, and the imports of the agent
 * modules at lib/ (the originals the protocol repository vendors) instead of
 * its copies. `node scripts/vendor-adaptive-cards.mjs
 * --check` fails when this copy drifts from that commit. Change it upstream,
 * then re-vendor.
 */
/*
 * The way back: an Action.Submit payload of a card rendered by render.mjs ->
 * the next protocol request (spec/request.md). An Adaptive Cards host
 * submits the action's `data` merged with the values of the card's inputs,
 * keyed by input id - and the ids are binding paths. The step itself is
 * shared with the terminal renderer and lives in ../common/request.mjs.
 */
export { submitToRequest, eventRequest, startRequest, coerce, inputsOf } from "./common/request.mjs";

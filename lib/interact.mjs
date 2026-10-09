/*
 * interact — the actions interact_app performs on the running app, validated.
 *
 * run_app boots an app and photographs it: the first roundtrip, and nothing
 * after it. Everything an app DOES lives behind an event — a button pressed,
 * a value entered, a row selected — and until now no tool without an SAP
 * system could reach any of it. interact_app takes a short script of actions,
 * performs them in the booted page and photographs the result, with the same
 * error collection run_app has, so the event branch of `main( )` becomes as
 * visible as the boot.
 *
 * This module is the pure half: the shape of an action list, checked before a
 * browser is opened. A locator is one of `id` (the control id the builder
 * wrote — matched exactly or as the `--<id>` suffix UI5 gives a view-prefixed
 * id), `selector` (a CSS selector) or `text` (the exact visible text, e.g. a
 * button label). Everything else is refused with a sentence rather than
 * failing inside Playwright with a stack trace.
 */

export const ACTIONS = ['click', 'fill', 'press', 'wait'];
export const MAX_ACTIONS = 30;
const MAX_TEXT = 500;
// what a step may carry - lib/tools.mjs' items schema of interact_app
export const STEP_KEYS = ['action', 'id', 'selector', 'text', 'value', 'key', 'ms', 'commit'];
const MAX_WAIT_MS = 10_000;
const DEFAULT_WAIT_MS = 500;

function str(v, name, i, max = MAX_TEXT) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`action ${i}: \`${name}\` must be a string`);
  if (v.length > max) throw new Error(`action ${i}: \`${name}\` is longer than ${max} characters`);
  return v;
}

/**
 * The normalised action list, or a thrown Error naming the first problem.
 * Each step: { action, id?, selector?, text?, value?, key?, ms?, commit? }.
 */
export function parseActions(actions) {
  if (!Array.isArray(actions) || !actions.length) {
    throw new Error(`pass \`actions\`: a non-empty array of { action: ${ACTIONS.join(' | ')}, ... } — e.g. `
      + '[{ "action": "fill", "id": "name", "value": "World" }, { "action": "click", "text": "Save" }]');
  }
  if (actions.length > MAX_ACTIONS) throw new Error(`at most ${MAX_ACTIONS} actions per call — split the script`);
  return actions.map((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`action ${i}: must be an object`);
    /* checked like the tool's own arguments (lib/args.mjs checkStringArgs),
     * which do not reach into the steps: { comit: false } and
     * { commit: "false" } committed, { ms: true } waited 1 ms - each a step
     * performed otherwise than asked, and reported as done */
    const unknown = Object.keys(a).filter((k) => !STEP_KEYS.includes(k));
    if (unknown.length) throw new Error(`action ${i}: no field ${unknown.map((k) => `'${k.slice(0, 40)}'`).join(', ')} - a step takes ${STEP_KEYS.join(', ')}`);
    if (a.commit !== undefined && a.commit !== null && typeof a.commit !== 'boolean') {
      throw new Error(`action ${i}: \`commit\` must be true or false, not ${JSON.stringify(a.commit)?.slice(0, 40)}`);
    }
    const action = String(a.action || '').toLowerCase();
    if (!ACTIONS.includes(action)) throw new Error(`action ${i}: unknown action '${String(a.action ?? '').slice(0, 80)}' — one of ${ACTIONS.join(', ')}`);
    const id = str(a.id, 'id', i, 200);
    const selector = str(a.selector, 'selector', i);
    const text = str(a.text, 'text', i);
    const locators = [id, selector, text].filter((x) => x !== undefined && x !== '').length;
    if (locators > 1) throw new Error(`action ${i}: give ONE of id, selector or text`);
    const step = { action };
    if (id) step.id = id;
    if (selector) step.selector = selector;
    if (text) step.text = text;
    if (action === 'click' && !locators) throw new Error(`action ${i}: click needs id, selector or text`);
    if (action === 'fill') {
      if (!locators) throw new Error(`action ${i}: fill needs id, selector or text`);
      const value = str(a.value, 'value', i);
      if (value === undefined) throw new Error(`action ${i}: fill needs \`value\` (a string; "" clears the field)`);
      step.value = value;
      // the UI5 change event fires when the field loses focus; a fill that
      // stays focused never reaches the backend, so the default commits
      step.commit = a.commit !== false;
    }
    if (action === 'press') {
      const key = str(a.key, 'key', i, 40);
      if (!key) throw new Error(`action ${i}: press needs \`key\` (a Playwright key name, e.g. Enter, Tab, Escape)`);
      step.key = key;
    }
    if (action === 'wait') {
      if (a.ms !== undefined && a.ms !== null) {
        const ms = typeof a.ms === 'number' || (typeof a.ms === 'string' && a.ms.trim()) ? Number(a.ms) : NaN;
        if (!Number.isFinite(ms) || ms < 1 || ms > MAX_WAIT_MS) {
          throw new Error(`action ${i}: wait \`ms\` must be between 1 and ${MAX_WAIT_MS}`);
        }
        step.ms = Math.floor(ms);
      } else if (!locators) {
        step.ms = DEFAULT_WAIT_MS;
      }
    }
    return step;
  });
}

/** A value inside a CSS attribute selector: quotes and backslashes escaped. */
export function cssAttr(value) {
  return String(value).replace(/[\\"]/g, (c) => `\\${c}`);
}

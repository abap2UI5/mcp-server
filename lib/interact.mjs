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

export const ACTIONS = ['click', 'fill', 'press', 'wait', 'drag', 'screenshot', 'read', 'save'];
export const MAX_ACTIONS = 30;
const MAX_TEXT = 500;
// what a step may carry - lib/tools.mjs' items schema of interact_app
export const STEP_KEYS = ['action', 'id', 'selector', 'text', 'value', 'key', 'ms', 'commit',
  'to_id', 'to_selector', 'to_text', 'dx', 'dy', 'x', 'y', 'steps', 'attribute', 'property', 'name'];
const MAX_WAIT_MS = 10_000;
const DEFAULT_WAIT_MS = 500;
/* The pictures one call may take with `screenshot` steps - each is an image
 * in the answer, and the answer has a budget (the final picture comes on top). */
export const MAX_STEP_SHOTS = 5;
const MAX_OFFSET = 10_000;

function str(v, name, i, max = MAX_TEXT) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`action ${i}: \`${name}\` must be a string`);
  if (v.length > max) throw new Error(`action ${i}: \`${name}\` is longer than ${max} characters`);
  return v;
}

function num(v, name, i, { min = -MAX_OFFSET, max = MAX_OFFSET, int = false } = {}) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    throw new Error(`action ${i}: \`${name}\` must be a${int ? 'n integer' : ' number'} between ${min} and ${max}`);
  }
  return v;
}

/* A name for a file `save` writes: letters, digits, _ - . only, no leading
 * dot - it becomes part of a file name in the server's own directory. */
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;

/**
 * The normalised action list, or a thrown Error naming the first problem.
 * Each step: { action, id?, selector?, text?, value?, key?, ms?, commit? } -
 * and for drag a target (to_id | to_selector | to_text, or dx/dy) and an
 * optional start point x/y inside the element, for read an `attribute` or a
 * `property`, for save an optional `attribute` and `name`.
 */
export function parseActions(actions) {
  if (!Array.isArray(actions) || !actions.length) {
    throw new Error(`pass \`actions\`: a non-empty array of { action: ${ACTIONS.join(' | ')}, ... } — e.g. `
      + '[{ "action": "fill", "id": "name", "value": "World" }, { "action": "click", "text": "Save" }]');
  }
  if (actions.length > MAX_ACTIONS) throw new Error(`at most ${MAX_ACTIONS} actions per call — split the script`);
  const list = actions.map((a, i) => {
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
    if (action !== 'drag') {
      const stray = ['to_id', 'to_selector', 'to_text', 'x', 'y', 'dx', 'dy', 'steps'].filter((k) => a[k] !== undefined && a[k] !== null);
      if (stray.length) throw new Error(`action ${i}: ${stray.join(', ')} belong${stray.length === 1 ? 's' : ''} to a drag, not to ${action}`);
    }
    if (action === 'drag') {
      if (!locators) throw new Error(`action ${i}: drag needs id, selector or text - the element the drag starts on`);
      const toId = str(a.to_id, 'to_id', i, 200);
      const toSelector = str(a.to_selector, 'to_selector', i);
      const toText = str(a.to_text, 'to_text', i);
      const targets = [toId, toSelector, toText].filter((x) => x !== undefined && x !== '').length;
      const dx = num(a.dx, 'dx', i);
      const dy = num(a.dy, 'dy', i);
      if (targets > 1) throw new Error(`action ${i}: give ONE of to_id, to_selector or to_text`);
      if (targets && (dx !== undefined || dy !== undefined)) throw new Error(`action ${i}: a drag goes to an element (to_*) OR by an offset (dx/dy), not both`);
      if (!targets && dx === undefined && dy === undefined) {
        throw new Error(`action ${i}: drag needs where to - to_id, to_selector or to_text, or an offset dx/dy in pixels`);
      }
      if (toId) step.toId = toId;
      if (toSelector) step.toSelector = toSelector;
      if (toText) step.toText = toText;
      if (!targets) {
        step.dx = dx || 0;
        step.dy = dy || 0;
      }
      const x = num(a.x, 'x', i, { min: 0 });
      const y = num(a.y, 'y', i, { min: 0 });
      if (x !== undefined) step.x = x;
      if (y !== undefined) step.y = y;
      step.steps = num(a.steps, 'steps', i, { min: 1, max: 100, int: true }) || 10;
    }
    if (action === 'read') {
      if (!locators) throw new Error(`action ${i}: read needs id, selector or text`);
      const attribute = str(a.attribute, 'attribute', i, 100);
      const property = str(a.property, 'property', i, 100);
      if (Boolean(attribute) === Boolean(property)) {
        throw new Error(`action ${i}: read needs ONE of \`attribute\` (e.g. "src") or \`property\` (e.g. "value", "checked", "innerText")`);
      }
      if (attribute) step.attribute = attribute;
      if (property) step.property = property;
    } else if (a.property !== undefined && a.property !== null) {
      throw new Error(`action ${i}: \`property\` belongs to a read`);
    }
    if (action === 'save') {
      if (!locators) throw new Error(`action ${i}: save needs id, selector or text - the element whose src (or href) to save, e.g. { "selector": "iframe" }`);
      const attribute = str(a.attribute, 'attribute', i, 100);
      if (attribute) step.attribute = attribute;
    } else if (action !== 'read' && a.attribute !== undefined && a.attribute !== null) {
      throw new Error(`action ${i}: \`attribute\` belongs to a read or a save`);
    }
    if (a.name !== undefined && a.name !== null) {
      if (action !== 'save') throw new Error(`action ${i}: \`name\` belongs to a save`);
      const name = str(a.name, 'name', i, 80);
      if (!FILE_NAME.test(name)) throw new Error(`action ${i}: \`name\` may hold letters, digits, _ - . only (at most 80, no leading dot)`);
      step.name = name;
    }
    return step;
  });
  const shots = list.filter((s) => s.action === 'screenshot').length;
  if (shots > MAX_STEP_SHOTS) throw new Error(`at most ${MAX_STEP_SHOTS} screenshot steps per call - each is a picture in the answer`);
  return list;
}

/** A value inside a CSS attribute selector: quotes and backslashes escaped. */
export function cssAttr(value) {
  return String(value).replace(/[\\"]/g, (c) => `\\${c}`);
}

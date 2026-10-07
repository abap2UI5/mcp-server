/*
 * args — one way to read an enumerated or a numeric tool argument.
 *
 * The tool schemas declare `enum` and `type: number`, and an MCP client is
 * free to ignore both: the schema is documentation for the agent, not a
 * gate on the wire. So every enumerated argument has to be checked HERE, and
 * the checking used to be done three different ways.
 *
 * `pitfalls` and `api_reference` rejected an unknown value by name. Everything
 * else fell through: `build_backend` did `args.mode || 'auto'`, so
 * `mode: "incremental "` - one trailing space - missed
 * `mode === 'incremental'`, fell into the auto branch and started a FULL
 * build, which is tens of minutes of an agent's task spent proving that a typo
 * is not a mode. `backend` returned `status` for any action it did not
 * recognise (a `stop` that silently did nothing), and `capabilities` filtered
 * on a status nothing carries and answered "0 matches", which reads as an
 * answer rather than as a mistake.
 *
 * The numeric arguments had the mirror-image problem: unbounded and uncoerced.
 * `limit: 0` meant "no limit" and returned a 600-entry catalogue into an
 * agent's context, `limit: "abc"` became NaN and returned nothing at all, and
 * `timeout_ms` had no ceiling, so one call could hold a browser open longer
 * than the client's own timeout.
 *
 * Both helpers throw; server.mjs's CallToolRequest handler turns a throw into
 * the same `isError` tool result an explicit `toolError` produces, so an
 * invalid argument reaches the agent as a sentence naming the argument, the
 * value it sent and what is accepted instead.
 */

/** "a, b or c" — the way the existing messages already list their values. */
function listed(values) {
  if (values.length < 2) return values.join('');
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

/**
 * One enumerated argument: the value when it is one of `allowed`, `dflt` when
 * it was left out, and an error naming every accepted value otherwise.
 *
 * Deliberately strict about the SHAPE too: no trimming, no case folding. A
 * value that has to be repaired before it matches is a value the caller did
 * not mean, and quietly repairing it is how `mode: "Full "` would start an
 * incremental build.
 */
export function oneOf(value, { name, allowed, dflt = undefined }) {
  if (value === undefined || value === null || value === '') return dflt;
  if (!allowed.includes(value)) {
    throw new Error(`unknown ${name} '${String(value).slice(0, 80)}' — use ${listed(allowed)}`);
  }
  return value;
}

/**
 * One numeric argument, coerced and bounded: `dflt` when it was left out, an
 * error when it is not a number at all, and clamped into [min, max] otherwise.
 *
 * Clamped rather than refused at the edges: an agent asking for 10000 entries
 * means "all of them" and an agent asking for 0 means nothing it can act on,
 * and neither is worth failing a call over. A value that is not a number IS
 * refused - it is a mistake, and the empty answer NaN produces looks like a
 * result.
 */
/**
 * One list-of-strings argument, for values that end up as spawn argv or in a
 * path: exactly an array of non-empty strings, bounded in length, or an error
 * naming what was sent instead.
 *
 * Refused rather than coerced, because the failure modes of coercion are the
 * bad ones: a bare string passes a `.length` check and then SHATTERS into
 * one argv entry per character, a number throws inside spawn as a TypeError
 * nobody can act on, and an unbounded list is an unbounded command line.
 */
export function stringArray(value, { name, maxItems = 50, maxLength = 200, example = '["sap.m.Wizard"]' }) {
  /* The example belongs to the argument: every list used to be shown
   * ["sap.m.Wizard"], which is right for scope_of's entities and wrong for
   * run_unit_tests' class_names - an agent copying it got a second error. */
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings, not ${JSON.stringify(value)?.slice(0, 80)} — e.g. ${example}`);
  }
  if (!value.length) {
    throw new Error(`${name} is empty — pass at least one entry, e.g. ${example}`);
  }
  if (value.length > maxItems) {
    throw new Error(`${name} has ${value.length} entries — at most ${maxItems} per call`);
  }
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`every ${name} entry must be a non-empty string — got ${JSON.stringify(v)?.slice(0, 80)}`);
    }
    if (v.length > maxLength) {
      throw new Error(`${name} entry '${v.slice(0, 40)}...' is longer than ${maxLength} characters`);
    }
  }
  return value.map((v) => v.trim());
}

export function boundedInt(value, { name, dflt, min = 1, max = Number.MAX_SAFE_INTEGER }) {
  if (value === undefined || value === null || value === '') return dflt;
  // Number( ) made true 1, false, [] and '  ' 0 and [7] 7 - a page of rows
  // nobody asked for (row was fixed for exactly this)
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, not '${String(value).slice(0, 80)}' — leaving it out means ${dflt}`);
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Every argument the tool's schema declares `type: 'string'` is a string,
 * every `type: 'boolean'` one a boolean and every `type: 'object'` one a
 * plain object - or the call is refused naming it.
 *
 * The schema is documentation to the client, not a gate on the wire, and the
 * handlers called string methods on what arrived: `capabilities` with
 * `{ query: 42 }` answered "query.toLowerCase is not a function", and a
 * number for `xml` failed inside the file write. Checked once, from the
 * schema itself, before any handler runs - so an argument added to a tool
 * later is covered without anyone remembering to. Absent (undefined or
 * null) is left to the handler, which knows its defaults.
 *
 * Booleans for the same reason, and with worse failures: the handlers test
 * `=== true` / `=== false`, so a client that sends `"true"` got the DEFAULT
 * without a word - `add_agent_setup { dry_run: "true" }` wrote into the
 * project it was asked only to plan for, `migrate_report { deploy: "true" }`
 * deployed nothing, `verify_app { boot: "false" }` booted. And objects:
 * `screenshot_view { model: "..." }` was spread into the derived model
 * character by character.
 */
const TYPE_CHECKS = {
  string: { ok: (v) => typeof v === 'string', what: 'a string' },
  boolean: { ok: (v) => typeof v === 'boolean', what: 'a boolean (true or false, not a string)' },
  object: { ok: (v) => typeof v === 'object' && !Array.isArray(v), what: 'an object' },
};

export function checkStringArgs(tool, args) {
  const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
  /* An argument the tool does not know is refused, not ignored: app_act
   * { value: {...}, event } fired the event without the edits, and
   * app_start { valuse } started with nothing pending - each reported as
   * done. */
  if (tool && args && typeof args === 'object') {
    const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
    if (unknown.length) {
      const known = Object.keys(props);
      throw new Error(`${tool.name} has no argument ${unknown.map((k) => `'${k.slice(0, 40)}'`).join(', ')} - `
        + (known.length ? `its arguments: ${known.join(', ')}` : 'it takes none'));
    }
  }
  for (const [name, schema] of Object.entries(props)) {
    const check = schema && TYPE_CHECKS[schema.type];
    if (!check) continue;
    const value = args ? args[name] : undefined;
    if (value === undefined || value === null || check.ok(value)) continue;
    throw new Error(`${name} must be ${check.what}, not ${JSON.stringify(value)?.slice(0, 80)} (${Array.isArray(value) ? 'an array' : typeof value})`);
  }
}

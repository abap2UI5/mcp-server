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
    throw new Error(`unknown ${name} '${value}' — use ${listed(allowed)}`);
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
export function boundedInt(value, { name, dflt, min = 1, max = Number.MAX_SAFE_INTEGER }) {
  if (value === undefined || value === null || value === '') return dflt;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, not '${value}' — leaving it out means ${dflt}`);
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

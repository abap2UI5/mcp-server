/*
 * budget — how much one tool answer may carry.
 *
 * MCP clients cap a tool result: Claude Code refuses anything over 25,000
 * tokens (MAX_MCP_OUTPUT_TOKENS) and hands the agent an error instead of the
 * answer. scaffold_app (~280 KB - the whole template, AGENTS.md and three
 * skills included), pitfalls without a query (~120 KB - both catalogues
 * whole) and examples with a large limit (~135 KB at 200 entries) all went
 * over it by DEFAULT. The agent then saw nothing at all, which is worse than
 * seeing a part.
 *
 * So those answers are PAGED against one character budget - about 60,000
 * characters of JSON, comfortably under the token cap for code and prose -
 * and every page says what it left out and the exact arguments that fetch
 * the rest. Nothing becomes unreachable: a page is a cursor, not a cut.
 */

/** Characters of serialised JSON one answer aims to stay under. */
export const ANSWER_BUDGET = 60_000;

/** The serialised size of a value, the way text() will write it. */
export function sizeOf(value) {
  return JSON.stringify(value, null, 2).length;
}

/**
 * The longest prefix of `items` whose serialised sizes fit `budget` - at
 * least `min` items even when the first alone is larger (an item cannot be
 * split, and refusing to return it would make it unreachable). Returns
 * `{ taken, rest }`.
 */
export function takeWithin(items, budget = ANSWER_BUDGET, { min = 1 } = {}) {
  const taken = [];
  let used = 0;
  for (const item of items) {
    const n = sizeOf(item);
    if (taken.length >= min && used + n > budget) break;
    taken.push(item);
    used += n;
  }
  return { taken, rest: items.slice(taken.length) };
}

/**
 * The files that fit, choosing the SMALLEST first so one large document
 * does not crowd out a dozen small ones the project cannot work without
 * (the class, its sidecar, the configs); the answer keeps `files` in their
 * original order. At least one file is always returned. Returns
 * `{ taken, rest }`, both in the original order.
 */
export function takeSmallestWithin(files, budget = ANSWER_BUDGET) {
  const order = files.map((f, i) => ({ i, n: sizeOf(f) })).sort((a, b) => a.n - b.n || a.i - b.i);
  const keep = new Set();
  let used = 0;
  for (const { i, n } of order) {
    if (keep.size && used + n > budget) continue;
    keep.add(i);
    used += n;
  }
  return {
    taken: files.filter((_, i) => keep.has(i)),
    rest: files.filter((_, i) => !keep.has(i)),
  };
}

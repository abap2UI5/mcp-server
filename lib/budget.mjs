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

/** Characters a field value or a table cell keeps when a snapshot is cut. */
const VALUE_CAP = 2000;

/**
 * A snapshot that fits `budget` characters of JSON - the app tools answered
 * `JSON.stringify(snap)` whole: a TextArea of 120 KB or a table of 200 wide
 * rows went over the client's cap by default, and the agent saw nothing.
 * Long string values are cut to VALUE_CAP first (a cut field becomes
 * read-only in this answer, a column with a cut cell no longer editable - an
 * edit of the shown part would replace the whole value), then rows are
 * dropped from the end of the largest table (`truncated` says so). The shape
 * stays snapshot v1; `notes` says what was cut, for a text beside it.
 */
export function fitSnapshot(snap, budget = ANSWER_BUDGET) {
  if (!snap || typeof snap !== 'object' || JSON.stringify(snap).length <= budget) return { snapshot: snap, notes: [] };
  const out = JSON.parse(JSON.stringify(snap));
  const notes = [];
  const cut = (v) => (typeof v === 'string' && v.length > VALUE_CAP ? `${v.slice(0, VALUE_CAP)}...` : v);
  const cutFields = [];
  for (const f of out.fields || []) {
    const v = cut(f.value);
    if (v !== f.value) {
      f.value = v;
      f.editable = false;
      cutFields.push(f.id);
    }
  }
  if (cutFields.length) notes.push(`the values of ${cutFields.join(', ')} are cut to ${VALUE_CAP} characters and read-only in this answer`);
  for (const t of out.tables || []) {
    const cols = new Set();
    for (const r of t.rows || []) {
      for (const [k, v] of Object.entries(r)) {
        const c = cut(v);
        if (c !== v) {
          r[k] = c;
          cols.add(k);
        }
      }
    }
    if (cols.size) {
      t.editableCells = (t.editableCells || []).filter((c) => !cols.has(c));
      notes.push(`table ${t.id}: cells of ${[...cols].join(', ')} are cut to ${VALUE_CAP} characters and not editable in this answer`);
    }
  }
  const shortened = new Map();
  while (JSON.stringify(out).length > budget) {
    const big = (out.tables || []).filter((t) => t.rows && t.rows.length > 1)
      .sort((a, b) => JSON.stringify(b.rows).length - JSON.stringify(a.rows).length)[0];
    if (!big) break;
    big.rows = big.rows.slice(0, Math.max(1, Math.floor(big.rows.length / 2)));
    big.truncated = true;
    shortened.set(big.id, big.rows.length);
  }
  for (const [id, n] of shortened) notes.push(`table ${id} shows its first ${n} row(s) to fit the answer - app_describe { max_rows } pages it`);
  if (JSON.stringify(out).length > budget) notes.push('the snapshot is still larger than one answer should be');
  return { snapshot: out, notes };
}

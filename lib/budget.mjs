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

/** The serialised size of a value, the way text() will write it - `depth`
 *  levels deep in the answer, where every line of it is indented by two
 *  spaces per level (an entry of `{ entries: [...] }` is at depth 2: measured
 *  at depth 0, a page of short many-keyed entries came out ~12% over). */
export function sizeOf(value, depth = 0) {
  const json = JSON.stringify(value, null, 2);
  if (!depth || json === undefined) return json === undefined ? 0 : json.length;
  let lines = 1;
  for (let i = json.indexOf('\n'); i >= 0; i = json.indexOf('\n', i + 1)) lines += 1;
  return json.length + lines * 2 * depth;
}

/**
 * The longest prefix of `items` whose serialised sizes fit `budget` - at
 * least `min` items even when the first alone is larger (an item cannot be
 * split, and refusing to return it would make it unreachable). `depth` is
 * how deep the items sit in the answer (sizeOf). Returns `{ taken, rest }`.
 */
export function takeWithin(items, budget = ANSWER_BUDGET, { min = 1, depth = 0 } = {}) {
  const taken = [];
  let used = 0;
  for (const item of items) {
    const n = sizeOf(item, depth);
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

/**
 * A run_unit_tests result that fits `budget` characters - measured the way
 * text() writes it (sizeOf, indented): every test of a checkout's full run
 * was 1,522 entries, 194,772 characters. Past the budget the tests are
 * counted per object and only the skipped ones are listed (at most 50; a
 * failure is `failed`, which stays). `tests` is then absent - a caller that
 * reads it checks for the array first. A result that fits comes back as it
 * is; the input is never changed.
 */
export function fitUnitResult(res, budget = ANSWER_BUDGET - 5000) {
  if (!res || !Array.isArray(res.tests) || sizeOf(res) <= budget) return res;
  const testsPerObject = {};
  for (const t of res.tests) testsPerObject[t.object] = (testsPerObject[t.object] || 0) + 1;
  const { tests, ...rest } = res;
  return {
    ...rest,
    testsPerObject,
    skippedTests: tests.filter((t) => t.skipped).slice(0, 50),
    testsNote: 'too many tests to list in one answer - counted per object; class_name or class_names lists a class\'s tests',
  };
}

/**
 * The findings of a gate that fit `budget` characters, the most severe kept
 * first (`rankOf`: higher is more severe), returned in their own order. A
 * view of a few hundred defects answered half a million characters through
 * validate_view, and the client then showed the agent none of them. A
 * validator needs no paging: the agent fixes what it sees and validates
 * again, and the counts beside the findings stay whole. `cut` is how many
 * were left out. The input is never changed.
 */
export function fitFindings(findings, { budget = ANSWER_BUDGET - 10_000, rankOf = () => 0, depth = 2 } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const sized = list.map((f, i) => ({ i, rank: rankOf(f), n: sizeOf(f, depth) }));
  if (sized.reduce((n, x) => n + x.n, 0) <= budget) return { findings: list, cut: 0 };
  const keep = new Set();
  let used = 0;
  for (const x of [...sized].sort((a, b) => b.rank - a.rank || a.i - b.i)) {
    if (keep.size && used + x.n > budget) break;
    keep.add(x.i);
    used += x.n;
  }
  return { findings: list.filter((_, i) => keep.has(i)), cut: list.length - keep.size };
}

/**
 * verify_app's stages as one answer holds them. Each stage is one tool's
 * answer, fitted by itself - and together they passed the budget: a
 * validate stage that passed with a few hundred hints (advisory, so ok) and
 * a unit stage of a few hundred tests answered ~100,000 characters. A passed
 * validate stage gives up findings first (they are listed most severe
 * first, so the head stays, and validate_view lists the rest), then the
 * unit stage counts its tests per object (fitUnitResult). Stages that fit
 * come back as they are; the input is never changed.
 */
export function fitVerifyStages(stages, budget = ANSWER_BUDGET - 5000) {
  const total = (s) => sizeOf({ ok: false, stoppedAt: 'validate', stages: s });
  if (!stages || total(stages) <= budget) return stages;
  let out = stages;
  const v = out.validate;
  if (v && Array.isArray(v.findings) && v.findings.length) {
    const rest = total({ ...out, validate: { ...v, findings: [], findingsCut: 'x'.repeat(200) } });
    const { findings } = fitFindings(v.findings, { budget: Math.max(0, budget - rest), depth: 4 });
    if (findings.length < v.findings.length) {
      const counts = v.counts || {};
      const all = Math.max(v.findings.length, (counts.error || 0) + (counts.warning || 0) + (counts.hint || 0) - (Array.isArray(v.renderErrors) ? v.renderErrors.length : 0));
      out = { ...out, validate: { ...v, findings, findingsCut: `${all - findings.length} more finding(s) left out of this report - validate_view lists them, most severe first` } };
    }
  }
  if (total(out) > budget && out.unit && Array.isArray(out.unit.tests)) {
    const room = budget - total({ ...out, unit: {} });
    out = { ...out, unit: fitUnitResult(out.unit, Math.max(0, room)) };
  }
  return out;
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

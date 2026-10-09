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

/** Characters of base64 the pictures of one answer stay under (screenshot_view
 *  attaches several; guardAnswer enforces it for every tool). */
export const IMAGE_BUDGET = 8_000_000;

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
  for (const [id, n] of shortened) notes.push(`table ${id} shows its first ${n} row(s) to fit the answer - rowCount counts them all, and app_act still reaches a cell of a later row as <table path or id>/<row>/<COLUMN>`);
  if (JSON.stringify(out).length > budget) notes.push('the snapshot is still larger than one answer should be');
  return { snapshot: out, notes };
}

/**
 * The rule explanations that fit `budget` characters (validate_view's
 * `rules`, keyed by rule id). `explain: true` returns a paragraph per rule,
 * about a kilobyte each, and a view that trips a dozen distinct rules passed
 * them ALL whole - `rules` alone could pass the answer budget while
 * `fitFindings` only ever shrank the findings beside it. `order` is the rule
 * ids to keep first (the ones the shown findings are about), so a cut drops
 * the least-relevant explanations last. Returns `{ rules, cut }`; `rules` is
 * a new object in `order`-first order, the input is never changed. A rule
 * never has its own text cut - an explanation is the unit here, like a
 * finding or a section.
 */
export function fitRules(rules, { budget = ANSWER_BUDGET, order = [] } = {}) {
  if (!rules || typeof rules !== 'object') return { rules, cut: 0 };
  const ids = Object.keys(rules);
  if (sizeOf(rules, 1) <= budget) return { rules, cut: 0 };
  const ranked = [...new Set([...order.filter((id) => id in rules), ...ids])];
  const out = {};
  let used = 0;
  let kept = 0;
  for (const id of ranked) {
    const n = sizeOf({ [id]: rules[id] }, 1);
    if (kept && used + n > budget) continue;
    out[id] = rules[id];
    used += n;
    kept += 1;
  }
  return { rules: out, cut: ids.length - kept };
}

/*
 * guardAnswer - the one last-line backstop at the point answers are
 * serialised.
 *
 * Every tool FITS its own answer (the mechanisms above): that is the primary
 * contract and stays. But fitting is per field, and a composed or unbounded
 * answer can still add up past the client's cap - verify_app and
 * migrate_report { deploy: true } stack several tools' answers, validate_view
 * and fix_view carry `rules` beside their findings, and any tool that grows
 * with upstream content is one upstream edit from the edge. A client that is
 * handed more than its cap shows the agent NOTHING, so no answer may leave
 * here over the budget, whatever a per-tool fitter missed.
 *
 * This shrinks the content blocks of a tool result (the `{ content: [...] }`
 * shape) until their text fits `budget` characters - the size the client
 * measures. A JSON block is reduced the documented way: its largest array
 * fields lose their tail (a `...Cut` note names what went and how to page the
 * rest), then its longest strings are trimmed; a prose block is trimmed at
 * the end. The shape is preserved where it can be (a trimmed object still
 * parses as JSON); only when nothing else fits is a block truncated whole.
 * Image blocks have a budget of their own (IMAGE_BUDGET, base64 characters
 * across the answer): pictures past it are left out from the last one on,
 * and a text block says how many. A result already within both budgets is
 * returned unchanged.
 */
const GUARD_MARK = '__answerGuardCut';

function textLen(block) {
  if (typeof block.text === 'string') return block.text.length;
  if (block.resource && typeof block.resource.text === 'string') return block.resource.text.length;
  return 0;
}

/** Strings no longer than this are never trimmed. */
const MIN_STR = 200;
const STR_CUT = '...[cut to fit the answer]';

/*
 * The shrink below is one rule applied in a loop: halve the LARGEST
 * shrinkable node - an array of more than one element (ranked by its compact
 * JSON length) or a string longer than MIN_STR (ranked by its length), the
 * first in document order on a tie - until the indented JSON fits. It used to
 * be applied literally, re-serialising the whole value twice per step (the
 * size check, then every array's size to find the largest): quadratic, and a
 * string trimmed as far as it goes (MIN_STR characters plus the mark) was
 * then picked again and again until the 10,000-step guard - 2.5 s for a
 * 474 KB answer of 480 rule explanations, 0.6 s per case of the property
 * test in test/paging.test.mjs. Now every node is sized ONCE, bottom-up - its compact
 * length (the rank) and its length indented at its own depth (what sizeOf
 * adds up) - a cut updates the sizes of the cut node and its ancestors by the
 * difference, and a heap answers "the largest" (stale entries are dropped
 * when they surface). The cuts made are exactly the ones the literal loop
 * made, in the same order; a cut that changes nothing ends the loop, because
 * the literal loop would have picked the same node until the guard.
 */

/** Sized nodes of a parsed JSON value. `pre` is the document order, `rank`
 *  whether the node may be cut (nothing under GUARD_MARK is). */
function sizeTree(root) {
  const nodes = [];
  const build = (v, parent, key, depth, rank) => {
    const n = { v, parent, key, depth, pre: nodes.length, rank, kids: null, compact: 0, indent: 0, ver: 0, dead: false };
    nodes.push(n);
    if (Array.isArray(v)) {
      n.kids = v.map((c, i) => build(c, n, i, depth + 1, rank));
    } else if (v && typeof v === 'object') {
      n.kids = Object.keys(v).map((k) => build(v[k], n, k, depth + 1, rank && k !== GUARD_MARK));
    }
    if (!n.kids) {
      n.compact = JSON.stringify(v).length;
      n.indent = n.compact;
      return n;
    }
    const count = n.kids.length;
    let compact = 2 + Math.max(0, count - 1);
    let indent = compact;
    for (const c of n.kids) {
      compact += c.compact;
      indent += c.indent;
      if (!Array.isArray(v)) {
        const keyLen = JSON.stringify(c.key).length;
        compact += keyLen + 1; // "key":
        indent += keyLen + 2; // "key": (with the space)
      }
    }
    // each member on a line of its own, indented one level deeper, and the
    // closing bracket on a line at this level - none of it when empty
    if (count) indent += count * (1 + 2 * (depth + 1)) + 1 + 2 * depth;
    n.compact = compact;
    n.indent = indent;
    return n;
  };
  build(root, null, null, 0, true);
  return nodes;
}

/** The rank of a node that may be cut now (the size the literal loop
 *  compared), or 0. */
function cutRank(n, minStr) {
  if (n.dead || !n.rank) return 0;
  if (Array.isArray(n.v)) return n.v.length > 1 && n.compact > minStr ? n.compact : 0;
  return typeof n.v === 'string' && n.v.length > minStr ? n.v.length : 0;
}

/** A max-heap of { size, pre, n, ver }: the largest size first, the earliest
 *  in document order on a tie. */
function createHeap() {
  const a = [];
  const above = (x, y) => x.size > y.size || (x.size === y.size && x.pre < y.pre);
  return {
    push(e) {
      a.push(e);
      for (let i = a.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (!above(a[i], a[p])) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    },
    pop() {
      if (!a.length) return undefined;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && above(a[l], a[m])) m = l;
          if (r < a.length && above(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]];
          i = m;
        }
      }
      return top;
    },
  };
}

/** Shrink one parsed JSON value until `JSON.stringify(x, null, 2)` fits
 *  `budget`; mutates and returns it, marking that it was cut. */
function shrinkJson(value, budget, minStr = MIN_STR) {
  let cut = false;
  const nodes = sizeTree(value);
  const root = nodes[0];
  const heap = createHeap();
  const offer = (n) => {
    const size = cutRank(n, minStr);
    if (size) heap.push({ size, pre: n.pre, n, ver: n.ver });
  };
  nodes.forEach(offer);
  const largest = () => {
    for (let e = heap.pop(); e; e = heap.pop()) {
      if (e.ver === e.n.ver && cutRank(e.n, minStr) === e.size) return e.n;
    }
    return null;
  };
  const kill = (n) => {
    n.dead = true;
    if (n.kids) n.kids.forEach(kill);
  };
  /* Cut one node; false when the cut changes nothing. */
  const shrink = (n) => {
    let dCompact;
    let dIndent;
    if (!n.parent) return false; // the root has no slot to cut into
    if (Array.isArray(n.v)) {
      const keep = Math.max(1, Math.floor(n.v.length / 2));
      const gone = n.kids.splice(keep);
      n.v.length = keep;
      dCompact = -gone.length; // the commas
      dIndent = -gone.length * (2 + 2 * n.depth + 2); // comma, newline, indent
      for (const c of gone) {
        dCompact -= c.compact;
        dIndent -= c.indent;
        kill(c);
      }
    } else {
      const next = `${n.v.slice(0, Math.max(minStr, Math.floor(n.v.length / 2)))}${STR_CUT}`;
      if (next === n.v) return false;
      n.v = next;
      n.parent.v[n.key] = next;
      const len = JSON.stringify(next).length;
      dCompact = len - n.compact;
      dIndent = dCompact;
    }
    for (let p = n; p; p = p.parent) {
      p.compact += dCompact;
      p.indent += dIndent;
      p.ver += 1;
      offer(p);
    }
    return true;
  };
  for (let guard = 0; guard < 10_000 && root.indent > budget; guard += 1) {
    const node = largest();
    if (!node) break;
    cut = true;
    // a node a cut does not change is the largest again on every later
    // step, so the loop could only spin until the guard
    if (!shrink(node)) break;
  }
  if (cut && value && typeof value === 'object' && !Array.isArray(value)) {
    value[GUARD_MARK] = 'this answer passed the client size limit and was shrunk here as a backstop - '
      + 'the largest arrays and strings were trimmed; call the tool again with a narrower query, a page offset, or fewer sizes for the rest';
  }
  return value;
}

/**
 * A composed object fitted to `budget` characters of indented JSON, the
 * documented way: its largest array fields lose their tail and its longest
 * strings are trimmed (`shrinkJson`), and a `...Cut` note says a cut happened.
 * For a tool whose answer stacks several other tools' already-fitted answers
 * (migrate_report { deploy: true }'s deploy/build/start stages) - each fits
 * alone, together they can pass the budget. A value that fits is returned as
 * it is; the input is never changed.
 */
export function fitObject(value, budget = ANSWER_BUDGET - 5000) {
  if (!value || typeof value !== 'object' || sizeOf(value) <= budget) return value;
  return shrinkJson(JSON.parse(JSON.stringify(value)), budget);
}

const imageLen = (block) => (block && block.type === 'image' && typeof block.data === 'string' ? block.data.length : 0);

export function guardAnswer(result, budget = ANSWER_BUDGET, imageBudget = IMAGE_BUDGET) {
  if (!result || !Array.isArray(result.content)) return result;
  let pictures = result.content.reduce((n, b) => n + imageLen(b), 0);
  if (pictures > imageBudget) {
    let dropped = 0;
    for (let i = result.content.length - 1; i >= 0 && pictures > imageBudget; i -= 1) {
      const n = imageLen(result.content[i]);
      if (!n) continue;
      result.content.splice(i, 1);
      pictures -= n;
      dropped += 1;
    }
    result.content.push({ type: 'text', text: `${dropped} picture(s) left out - the answer's pictures passed the client size limit (${imageBudget} base64 characters); ask for fewer or smaller ones` });
  }
  const total = result.content.reduce((n, b) => n + textLen(b), 0);
  if (total <= budget) return result;
  /* Share the budget across the text blocks by their current size, leaving a
   * little head-room for the marks; a block with no text keeps its length. */
  const textBlocks = result.content.filter((b) => textLen(b) > 0);
  const totalText = textBlocks.reduce((n, b) => n + textLen(b), 0) || 1;
  const room = Math.max(1000, budget - 500);
  for (const block of textBlocks) {
    const share = Math.max(500, Math.floor((textLen(block) / totalText) * room));
    const ref = typeof block.text === 'string' ? block : block.resource;
    if (textLen(block) <= share) continue;
    let parsed;
    try {
      parsed = JSON.parse(ref.text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
      ref.text = JSON.stringify(shrinkJson(parsed, share), null, 2);
      if (ref.text.length > share) ref.text = `${ref.text.slice(0, share)}\n...[answer truncated to fit the client size limit]`;
    } else {
      ref.text = `${ref.text.slice(0, Math.max(500, share - 60))}\n...[answer truncated to fit the client size limit - narrow the query or page the rest]`;
    }
  }
  return result;
}

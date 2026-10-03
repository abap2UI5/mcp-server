// The task-specific checks (expect.json), judged against the views the
// linter RECONSTRUCTS from the ABAP - the same reconstruction its render gate
// loads - plus a scan of the source for the client API the task needs.
//
// expect.json shape (every key optional):
//   level       1 | 2 | 3            difficulty, for the report's breakdown
//   classes     ["zcl_bench_01"]     the app classes the task asks for; each
//                                    must exist and implement z2ui5_if_app
//   controls    [entry]              must occur in a reconstructed view
//   events      [entry]              "<control>.<event>" wired to an event
//                                    (the builder's _event / follow_up_action
//                                    stub, a ".method(...)" call in the XML)
//   bindings    [entry]              "<control>.<property>" carrying a binding
//   attrs       [entry]              "<control>.<property>" set at all - bound
//                                    or literal (a value state the app sets
//                                    when it re-renders counts as much as one
//                                    it binds). The reconstruction drops a
//                                    value it cannot compute statically
//                                    (a( n = `valueColor` v = kpi-color ) in a
//                                    LOOP), so an attribute the source writes
//                                    by that literal name on a control that
//                                    is there counts too
//   calls       [entry]              z2ui5_if_client methods the source calls
//   perClass    { "<class>": { controls, events, bindings, attrs, calls } }
//                                    the same checks, scoped to one class
// An entry is a string, an array of alternatives (any one satisfies it), or
// { "any": [...], "min": n } - at least n occurrences summed over the
// alternatives. A control name is fully qualified ("sap.m.Table"); "*" as the
// control part of an event/binding entry matches any control.
import { prepareAbap } from '@abap2ui5/linter/reconstruct';

const XMLNS = 'xmlns';

/** Fully qualified name of every element of a reconstructed tree, with the
 *  attributes it carries. Aggregations (lower-case local names) are skipped
 *  as elements but walked through. */
export function controlsOf(root) {
  const out = [];
  const visit = (node, scope) => {
    const ns = { ...scope };
    for (const [k, v] of node.attrs || []) {
      if (k === XMLNS) ns[''] = v;
      else if (k.startsWith(`${XMLNS}:`)) ns[k.slice(6)] = v;
    }
    if (node.name) {
      const local = node.name;
      const uri = ns[node.ns || ''];
      if (/^[A-Z]/.test(local)) {
        const fqn = uri ? `${uri}.${local}` : local;
        const attrs = {};
        for (const [k, v] of node.attrs || []) if (k !== XMLNS && !k.startsWith(`${XMLNS}:`)) attrs[k] = String(v);
        out.push({ name: fqn, attrs });
      }
    }
    for (const c of node.children || []) visit(c, ns);
  };
  visit(root, {});
  return out;
}

/** Strip ABAP comments and string literals, keeping offsets irrelevant -
 *  only what the code CALLS matters here. */
export function scrubAbap(src) {
  return src
    .split('\n')
    .map((line) => (/^\*/.test(line) ? '' : line))
    .join('\n')
    .replace(/`(?:``|[^`\n])*`/g, '``')
    .replace(/'(?:''|[^'\n])*'/g, "''")
    .replace(/\|(?:\\.|[^|\n])*\|/g, '||')
    .replace(/"[^\n]*/g, '');
}

/** Everything the checks look at, per class. */
export function analyze(sources) {
  const perClass = {};
  for (const [cls, src] of Object.entries(sources)) {
    let prepared = null;
    let error = null;
    try { prepared = prepareAbap(src); } catch (e) { error = String(e && e.message || e); }
    const controls = [];
    const documents = [];
    if (prepared) {
      prepared.nodes.forEach((root, i) => {
        const list = controlsOf(root);
        controls.push(...list);
        documents.push({ kind: prepared.docKinds[i] || root.displayKind || null, slot: root.displaySlot || null, controls: list.length });
      });
    }
    const code = scrubAbap(src);
    const calls = new Set();
    for (const m of code.matchAll(/->\s*([a-z_][a-z0-9_]*)\s*\(/gi)) calls.add(m[1].toLowerCase());
    const written = new Set();
    for (const m of src.matchAll(/\bn\s*=\s*[`'](\w+)[`']/g)) written.add(m[1]);
    perClass[cls] = { controls, documents, calls, written, error, docs: prepared ? prepared.docs : [] };
  }
  return perClass;
}

const alts = (entry) => (typeof entry === 'string' ? { any: [entry], min: 1 } : Array.isArray(entry) ? { any: entry, min: 1 } : { any: entry.any, min: entry.min || 1 });
const label = (entry) => { const e = alts(entry); return `${e.any.join(' | ')}${e.min > 1 ? ` (x${e.min})` : ''}`; };

function splitMember(spec) {
  const i = spec.lastIndexOf('.');
  return { control: spec.slice(0, i), member: spec.slice(i + 1) };
}

const isEventValue = (v) => /^\s*\.[A-Za-z_$][\w$.]*\s*\(/.test(v) || /\.eB\(/.test(v);
const isBindingValue = (v) => /\{[^}]*\}/.test(v) && !/^\s*\.[A-Za-z_]/.test(v);

function countControls(controls, name) {
  return controls.filter((c) => c.name === name).length;
}

function countMember(controls, spec, pred) {
  const { control, member } = splitMember(spec);
  return controls.filter((c) => (control === '*' || c.name === control) && c.attrs[member] !== undefined && pred(c.attrs[member])).length;
}

function judge(spec, scope, where) {
  const failures = [];
  const check = (key, counter) => {
    for (const entry of spec[key] || []) {
      const e = alts(entry);
      const n = e.any.reduce((s, a) => s + counter(a), 0);
      if (n < e.min) failures.push(`${where}${key}: ${label(entry)} - found ${n}`);
    }
  };
  check('controls', (a) => countControls(scope.controls, a));
  check('events', (a) => countMember(scope.controls, a, isEventValue));
  check('bindings', (a) => countMember(scope.controls, a, isBindingValue));
  check('attrs', (a) => {
    const n = countMember(scope.controls, a, (v) => v.trim() !== '');
    if (n > 0) return n;
    const { control, member } = splitMember(a);
    const present = control === '*' || countControls(scope.controls, control) > 0;
    return present && scope.written.has(member) ? 1 : 0;
  });
  check('calls', (a) => (scope.calls.has(a.toLowerCase()) ? 1 : 0));
  return failures;
}

/** Evaluate an expect.json against analyzed sources. */
export function evaluate(expect, analysis) {
  const all = { controls: [], calls: new Set(), written: new Set() };
  for (const a of Object.values(analysis)) {
    all.controls.push(...a.controls);
    for (const c of a.calls) all.calls.add(c);
    for (const w of a.written) all.written.add(w);
  }
  const failures = judge(expect, all, '');
  for (const [cls, spec] of Object.entries(expect.perClass || {})) {
    const a = analysis[cls.toLowerCase()];
    if (!a) { failures.push(`${cls}: class not delivered`); continue; }
    failures.push(...judge(spec, a, `${cls}: `));
  }
  const totalControls = all.controls.length;
  if (totalControls === 0) failures.unshift('no view could be reconstructed from the delivered classes');
  return { pass: failures.length === 0, failures, controls: summarize(all.controls) };
}

function summarize(controls) {
  const t = {};
  for (const c of controls) t[c.name] = (t[c.name] || 0) + 1;
  return t;
}

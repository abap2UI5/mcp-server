/*
 * api — the client API (z2ui5_if_client), parsed live from the framework
 * checkout into something an agent can query.
 *
 * z2ui5_if_client.intf.abap is the complete surface an app may call, and it is
 * documented where ABAP documents things: in ABAP-Doc ("!) comments on the
 * methods and in inline comments on the parameters. That is exactly the right
 * place for the documentation and exactly the wrong shape for an agent
 * mid-task, which had to pull all 669 lines through its context to answer
 * "what are the arguments of follow_up_action" or "which cs_event starts a
 * timer". This module parses the interface into methods (with parameters,
 * defaults and their docs), the cs_* constant groups (flattened to the
 * `cs_event-popup_close` paths an app actually writes) and the named types -
 * ON EVERY QUERY, like every other document this server serves, so what the
 * agent sees is always what the checkout says.
 *
 * The parser is line-based over abaplint-formatted source (the framework's CI
 * pins the formatting, which is what makes this reliable), and it must never
 * throw on a half-pulled or future revision: unrecognised lines are skipped,
 * because a thinner answer beats a dead tool (same contract as the
 * CAPABILITIES.md and SAMPLES.md parsers).
 */
import fs from 'fs';
import path from 'path';
import { resolveA2UI5 } from './repos.mjs';

export const API_PATH = ['src', '02', 'z2ui5_if_client.intf.abap'];

/** Where the interface lives inside an abap2UI5 checkout, or null without one. */
export function apiFile() {
  const a2 = resolveA2UI5();
  if (!a2) return null;
  return path.join(a2, ...API_PATH);
}

/** The raw interface source, or null when the checkout does not carry it. */
export function readApi() {
  const file = apiFile();
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

// ABAP-Doc escapes the characters that would read as markup
const undoc = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\\([{}])/g, '$1');

/* An ABAP-Doc block ("! lines) split into the general text and the per-
 * parameter texts (@parameter name | ...). Continuation lines belong to
 * whatever was last opened. */
function splitDoc(docLines) {
  let doc = [];
  const params = {};
  let current = null;
  for (const raw of docLines) {
    const m = raw.match(/^@parameter\s+(\w+)\s*\|\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      params[current] = [m[2]];
    } else if (current) {
      params[current].push(raw);
    } else {
      doc.push(raw);
    }
  }
  const join = (lines) => undoc(lines.join(' ').replace(/\s+/g, ' ').trim());
  return {
    doc: join(doc),
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, join(v)])),
  };
}

/**
 * The interface as data:
 *   methods:   [{ name, doc, obsolete, parameters: [{ name, kind, type,
 *                 optional, default, doc }] }]
 *   constants: [{ name, doc, values: [{ path, value, note }] }]
 *   types:     [{ name, doc, definition }]
 */
export function parseApi(text) {
  const lines = String(text).split('\n');
  const methods = [];
  const constants = [];
  const types = [];

  let docBuf = []; // pending "! lines
  let noteBuf = []; // pending plain " lines (parameter/entry notes)

  let i = 0;
  const flushDocs = () => {
    docBuf = [];
    noteBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    // comments accumulate until the declaration they precede
    const abapDoc = t.match(/^"!\s?(.*)$/);
    if (abapDoc) {
      docBuf.push(abapDoc[1]);
      i += 1;
      continue;
    }
    if (t.startsWith('"')) {
      noteBuf.push(t.replace(/^"\s?/, ''));
      i += 1;
      continue;
    }

    // ---- CONSTANTS: BEGIN OF cs_*, ... END OF cs_*. --------------------
    let m = t.match(/^CONSTANTS:?$/) || t.match(/^CONSTANTS:?\s+BEGIN OF/);
    if (m) {
      let groupDoc = splitDoc(docBuf).doc;
      flushDocs();
      const pathStack = [];
      const values = [];
      const innerDoc = [];
      let note = '';
      let groupName = '';
      // step past a bare CONSTANTS: line; a combined line is re-read below
      if (/^CONSTANTS:?$/.test(t)) i += 1;
      for (; i < lines.length; i += 1) {
        const c = lines[i].trim().replace(/^CONSTANTS:?\s+/, '');
        if (c.startsWith('"!')) {
          // ABAP-Doc INSIDE the block documents the group (cs_nav_mode does this)
          innerDoc.push(c.replace(/^"!\s?/, ''));
          continue;
        }
        if (c.startsWith('"')) {
          // a bare comment tags the entries after it ("experimental, "obsolet)
          note = c.replace(/^"\s?/, '').trim();
          continue;
        }
        const begin = c.match(/^BEGIN OF (\w+),/);
        if (begin) {
          pathStack.push(begin[1]);
          if (pathStack.length === 1) groupName = begin[1];
          continue;
        }
        const end = c.match(/^END OF (\w+)([,.])/);
        if (end) {
          pathStack.pop();
          if (!pathStack.length && end[2] === '.') {
            i += 1;
            break;
          }
          continue;
        }
        const entry = c.match(/^(\w+)\s+TYPE\s+\S+\s+VALUE\s+`([^`]*)`\s*,?/);
        if (entry && pathStack.length) {
          values.push({
            path: [...pathStack, entry[1]].join('-'),
            value: entry[2],
            ...(note ? { note } : {}),
          });
        }
      }
      if (!groupDoc && innerDoc.length) groupDoc = splitDoc(innerDoc).doc;
      if (groupName) constants.push({ name: groupName, doc: groupDoc, values });
      continue;
    }

    // ---- TYPES ---------------------------------------------------------
    m = t.match(/^TYPES:?$/) || t.match(/^TYPES:?\s/);
    if (m) {
      let typeDoc = splitDoc(docBuf).doc;
      flushDocs();
      const def = [];
      const innerDoc = [];
      let name = '';
      let depth = 0;
      for (; i < lines.length; i += 1) {
        const c = lines[i].trim().replace(/^TYPES:?\s*/, '');
        if (!c) continue;
        if (c.startsWith('"!')) {
          // ABAP-Doc INSIDE the block documents the definition (ty_s_get)
          innerDoc.push(c.replace(/^"!\s?/, ''));
          continue;
        }
        if (c.startsWith('"')) continue;
        if (/^BEGIN OF /.test(c)) depth += 1;
        if (/^END OF /.test(c)) depth -= 1;
        def.push(c);
        if (!name) name = (c.match(/^(?:BEGIN OF )?(\w+)/) || [])[1] || '';
        if (depth <= 0 && /[.]$/.test(c)) {
          i += 1;
          break;
        }
      }
      if (!typeDoc && innerDoc.length) typeDoc = splitDoc(innerDoc).doc;
      if (name) types.push({ name, doc: typeDoc, definition: def.join('\n') });
      continue;
    }

    // ---- METHODS -------------------------------------------------------
    m = t.match(/^METHODS:?\s+(\w+)\s*(\.)?$/);
    if (m) {
      const { doc, params } = splitDoc(docBuf);
      flushDocs();
      const method = {
        name: m[1],
        doc,
        obsolete: /^obsolete\b/i.test(doc),
        parameters: [],
      };
      if (!m[2]) {
        // multi-line declaration: IMPORTING/RETURNING blocks until the period
        let kind = null;
        let note = '';
        for (i += 1; i < lines.length; i += 1) {
          const c = lines[i].trim();
          if (c.startsWith('"')) {
            note = c.replace(/^"\s?/, '').replace(/^!\s?/, '');
            // a wrapped note keeps appending
            while (lines[i + 1] && lines[i + 1].trim().startsWith('"')) {
              i += 1;
              note += ` ${lines[i].trim().replace(/^"\s?/, '')}`;
            }
            continue;
          }
          const section = c.match(/^(IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING)\b/);
          if (section) {
            kind = section[1].toLowerCase();
            if (section[1] !== 'RETURNING') {
              if (/[.]$/.test(c)) break;
              continue;
            }
          }
          const pref = c.match(/^PREFERRED PARAMETER (\w+)/);
          if (pref) {
            const p = method.parameters.find((x) => x.name === pref[1]);
            if (p) p.preferred = true;
            if (/[.]$/.test(c)) break;
            continue;
          }
          const pm = c
            .replace(/^(IMPORTING|EXPORTING|CHANGING|RETURNING)\s+/, '')
            .match(/^(?:VALUE\((\w+)\)|(\w+))\s+TYPE\s+(.+?)(\s+DEFAULT\s+(\S+))?(\s+OPTIONAL)?\s*[,.]?$/);
          if (pm && kind) {
            const p = {
              name: (pm[1] || pm[2]).toLowerCase(),
              kind,
              type: pm[3].replace(/\s+/g, ' ').trim(),
              ...(pm[6] ? { optional: true } : {}),
              // the declaration's closing period is punctuation, not value
              ...(pm[5] ? { default: pm[5].replace(/[,.]$/, '') } : {}),
            };
            const pdoc = params[p.name] || note || '';
            if (pdoc) p.doc = pdoc;
            note = '';
            method.parameters.push(p);
          }
          if (/[.]$/.test(c)) break;
        }
        i += 1;
      } else {
        i += 1;
      }
      methods.push(method);
      continue;
    }

    // anything else (INTERFACE, ENDINTERFACE, blanks) clears pending comments
    if (t) flushDocs();
    i += 1;
  }

  return { methods, constants, types };
}

/** One line per method, the table of contents a first call answers with. */
export function apiSummary(parsed) {
  const firstSentence = (s) => {
    const plain = s.replace(/\s+/g, ' ').trim();
    const stop = plain.search(/\.(?=\s|$)/);
    const cut = stop > 20 ? plain.slice(0, stop + 1) : plain;
    return cut.length > 160 ? `${cut.slice(0, 157)}...` : cut;
  };
  return {
    methods: parsed.methods.map((m) => ({
      name: m.name,
      ...(m.obsolete ? { obsolete: true } : {}),
      ...(m.doc ? { doc: firstSentence(m.doc) } : {}),
    })),
    constants: parsed.constants.map((c) => ({
      name: c.name,
      entries: c.values.length,
      ...(c.doc ? { doc: firstSentence(c.doc) } : {}),
    })),
    types: parsed.types.map((t) => ({
      name: t.name,
      ...(t.doc ? { doc: firstSentence(t.doc) } : {}),
    })),
  };
}

/* Query semantics as everywhere else in this server: terms are AND-ed, a hit
 * anywhere in the entry counts, and matches come back WHOLE — a method with
 * its full doc and every parameter, because the parameter list is what the
 * question was about. */
export function searchApi(parsed, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const hits = (hay) => terms.every((t) => hay.includes(t));

  const methods = parsed.methods.filter((m) =>
    hits(
      [m.name, m.doc, ...m.parameters.map((p) => `${p.name} ${p.type} ${p.doc || ''}`)]
        .join('\n')
        .toLowerCase(),
    ),
  );
  const constants = parsed.constants
    .map((c) => {
      // the whole group when its name/doc matches, otherwise the matching rows
      if (hits(`${c.name} ${c.doc}`.toLowerCase())) return c;
      const values = c.values.filter((v) => hits(`${c.name} ${v.path} ${v.value} ${v.note || ''}`.toLowerCase()));
      return values.length ? { ...c, values } : null;
    })
    .filter(Boolean);
  const types = parsed.types.filter((t) => hits(`${t.name}\n${t.doc}\n${t.definition}`.toLowerCase()));
  return { methods, constants, types };
}

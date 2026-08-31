/*
 * pitfalls — the two catalogues of defects a green CI does not catch.
 *
 * The abap2UI5 repository maintains them as `abap-check` (ABAP that has to
 * survive a real SAP system: abapGit round trip and import, activation,
 * extended check, downport/transpile, runtime) and `ui5-check` (the view side:
 * names the oldest supported release does not have, layout that only works
 * from a newer release on, views that fail to LOAD rather than to render).
 * Every entry is a defect that actually shipped past a green CI, with the
 * evidence and the reason the tooling missed it.
 *
 * They exist there as Claude Code skills, which means only an agent working
 * inside that checkout ever sees them — and the whole point of this server is
 * that an agent works on its OWN app, elsewhere. Read live from the checkout
 * for the same reason `capabilities` parses CAPABILITIES.md live: a copy here
 * would be a second source of truth, and the one that goes stale.
 *
 * What is here is only locating and slicing the documents. Their content is
 * upstream's, and nothing in this file paraphrases it.
 */
import fs from 'fs';
import path from 'path';
import { resolveA2UI5 } from './repos.mjs';

/* Which catalogue answers which kind of question. The `area` a caller asks
 * for maps to one file; `all` reads both, which is what an agent starting a
 * task wants. */
export const AREAS = {
  abap: {
    skill: 'abap-check',
    title: 'abap-check — what a green CI does not prove about the ABAP',
    covers: 'abapGit round trip and import (BOM, line endings, 255-character lines, metadata sidecars), '
      + 'activation errors abaplint does not model, extended check (SLIN/ATC), downport and transpiler traps, '
      + 'runtime breakage that only shows on a real system',
  },
  view: {
    skill: 'ui5-check',
    title: 'ui5-check — what a green CI does not prove about the view',
    covers: 'names the oldest supported release (1.71) does not have — icons, controls, properties, '
      + 'aggregations, enum values, modules, themes — layout that only works from a newer release on, '
      + 'views that fail to load rather than to render, CSP and runtime traps',
  },
};

/** Where a catalogue lives inside an abap2UI5 checkout. */
export function pitfallsFile(area) {
  const a2 = resolveA2UI5();
  if (!a2) return null;
  return path.join(a2, '.claude', 'skills', AREAS[area].skill, 'SKILL.md');
}

/** The raw catalogue text, or null when the checkout does not carry it. */
export function readPitfalls(area) {
  const file = pitfallsFile(area);
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/**
 * A catalogue sliced into its `## ` sections, optionally narrowed to those a
 * query matches.
 *
 * The YAML front matter goes first: it is skill plumbing (name, description),
 * not content an agent should read. The preamble before the first heading —
 * scope, the release floor, why the existing tooling is blind to all of this —
 * is kept as a section of its own, because it is the half that says how to USE
 * the rest.
 *
 * A section is a self-contained case: symptom, evidence, and the fix. Matching
 * whole sections rather than lines is what keeps those three together, which
 * is the entire value of these files.
 */
export function sliceCatalogue(md, query = '') {
  const body = String(md).replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const out = [];
  let current = { heading: '(preamble)', body: [] };
  for (const line of body.split('\n')) {
    if (/^## /.test(line)) {
      out.push({ ...current, body: current.body.join('\n').trim() });
      current = { heading: line.replace(/^##\s*/, '').trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  out.push({ ...current, body: current.body.join('\n').trim() });

  const sections = out.filter((s) => s.body);
  const needles = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!needles.length) return sections;
  // every term has to appear somewhere in the section — heading or body
  return sections.filter((s) => {
    const hay = `${s.heading}\n${s.body}`.toLowerCase();
    return needles.every((n) => hay.includes(n));
  });
}

/**
 * The catalogues, optionally narrowed to the sections a query matches.
 *
 * Without a query the whole thing comes back: these documents are meant to be
 * read once at the start of a task, and an agent that only ever sees the
 * section it already knew to ask about learns nothing it did not know.
 *
 * Returns { area, title, covers, sections: [{heading, body}] } per catalogue,
 * or null when the abap2UI5 checkout is missing.
 */
export function searchPitfalls({ area = 'all', query = '' } = {}) {
  const areas = area === 'all' ? Object.keys(AREAS) : [area];
  const result = [];
  for (const a of areas) {
    const md = readPitfalls(a);
    if (md === null) return null;
    result.push({
      area: a,
      title: AREAS[a].title,
      covers: AREAS[a].covers,
      sections: sliceCatalogue(md, query),
    });
  }
  return result;
}

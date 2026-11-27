/*
 * addons-catalog - where the catalogue of abap2UI5-addons lives in its
 * repository, and the reader of its catalog.ts. A LEAF (no import): both
 * lib/addons.mjs (the tool) and lib/remote.mjs (the mirror, which needs the
 * catalogue to know which facts files to fetch) import it, and lib/remote.mjs
 * sits in an import cycle with lib/repos.mjs that a constant must not join.
 * lib/addons.mjs has the story.
 */

export const CATALOG_PATH = 'src/data/catalog.ts';
export const FACTS_DIR = 'src/data/addons';

/** The organisation of an entry that names none (catalog.ts `orgOf`). */
export const DEFAULT_ORG = 'abap2UI5-addons';
/** The framework itself: first in every install order, never a `dependsOn`. */
export const FRAMEWORK = 'abap2UI5/abap2UI5';

/** A repository name as it may become a file name and a path segment. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const validRepoName = (name) => typeof name === 'string' && REPO_RE.test(name) && !name.includes('..');

/* One string literal of the catalogue, as JavaScript writes it: double or
 * single quotes, backslash escapes. Template literals are not data there. */
const STRING = '"((?:[^"\\\\\\n]|\\\\.)*)"|\'((?:[^\'\\\\\\n]|\\\\.)*)\'';
const unescape = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => {
  if (e[0] === 'u' && e[1] === '{') return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
  if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
  return { n: '\n', t: '\t', r: '\r' }[e] ?? e;
});
const property = (text, key) => {
  const m = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*(?:${STRING})`).exec(text);
  return m ? unescape(m[1] ?? m[2]) : undefined;
};

/**
 * The groups of catalog.ts: `[{ id, title, lead, entries: [{ repo, org,
 * site? }] }]`, in the file's order. Reads the `groups` array literal as
 * text - each group is the stretch from one `id:` to the next, each entry a
 * `{ ... repo: "..." ... }` object in it. An entry whose repo is no plain
 * repository name is dropped (it becomes a path). Pure.
 */
export function parseCatalog(text) {
  const source = String(text ?? '');
  const from = Math.max(0, source.search(/\bgroups\b[^=\n]*=\s*\[/));
  const body = source.slice(from);
  const starts = [...body.matchAll(new RegExp(`(?:^|[\\s{,])id\\s*:\\s*(?:${STRING})`, 'g'))];
  const groups = [];
  starts.forEach((m, i) => {
    const chunk = body.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : undefined);
    const entries = [];
    for (const obj of chunk.matchAll(/\{[^{}]*\}/g)) {
      const repo = property(obj[0], 'repo');
      if (!validRepoName(repo) || entries.some((e) => e.repo === repo)) continue;
      const org = property(obj[0], 'org');
      const site = property(obj[0], 'site');
      entries.push({ repo, org: validRepoName(org) ? org : DEFAULT_ORG, ...(site ? { site } : {}) });
    }
    if (!entries.length) return;
    groups.push({
      id: unescape(m[1] ?? m[2]),
      title: property(chunk, 'title') || unescape(m[1] ?? m[2]),
      lead: property(chunk, 'lead') || '',
      entries,
    });
  });
  return groups;
}

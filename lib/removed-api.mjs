/*
 * removed-api — what an abaplint "not found" means when the name is abap2UI5
 * API that was removed or moved, and what to write instead.
 *
 * WHY: an app written from memory calls client->_bind_edit( ) or
 * z2ui5_cl_xml_view, and deploy_app's lint answered `Method "_bind_edit" not
 * found` - true, and no help: the agent cannot tell a typo from an API that
 * left the framework, and does not know the replacement. The docs site keeps
 * that table (resources/deprecations.md) and publishes it as data,
 * docs/public/api/deprecations.json - the same file the linter vendors. Read
 * from the docs checkout, else the read-only GitHub mirror; when neither is
 * there the findings go out as they are, never with a guess.
 */

import fs from 'fs';
import path from 'path';
import { resolveDocs } from './repos.mjs';
import { fetchRemoteFile } from './remote.mjs';

export const DEPRECATIONS_PATH = 'docs/public/api/deprecations.json';

/* The abaplint messages that name a missing symbol, and the kinds of entry
 * each one can be. */
const NOT_FOUND = [
  { re: /Method "([^"]+)" not found/i, kinds: ['method'] },
  { re: /^Class ([\w/~]+) not found/i, kinds: ['class'] },
  { re: /^(?:Interface|Type) ([\w/~]+) not found/i, kinds: ['interface', 'class', 'dictionary-object'] },
  { re: /Component "([^"]+)" not found/i, kinds: ['attribute', 'field', 'constant'] },
];

/** The deprecation entry for `name` of one of `kinds`: an exact entry, else
 *  the longest pattern (`*` stands for any run of characters) - the rule the
 *  file's own `matching` sentence states. Null when none. Pure. */
export function findRemoved(entries, name, kinds) {
  const n = String(name || '').toLowerCase();
  const of = (entries || []).filter((e) => e && typeof e.name === 'string' && kinds.includes(e.kind));
  const exact = of.find((e) => !e.pattern && e.name.toLowerCase() === n);
  if (exact) return exact;
  const patterns = of
    .filter((e) => e.pattern)
    .filter((e) => new RegExp(`^${e.name.toLowerCase().split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(n))
    .sort((a, b) => b.name.length - a.name.length);
  return patterns[0] || null;
}

/** The lint issues, each "not found" one that names removed abap2UI5 API
 *  carrying `removed: { name, status, replacement, since?, note? }`, and how
 *  many did. Pure; the input is not changed. */
export function annotateRemoved(issues, entries) {
  let count = 0;
  const out = (issues || []).map((issue) => {
    const message = String((issue && issue.message) || '');
    for (const { re, kinds } of NOT_FOUND) {
      const m = re.exec(message);
      if (!m) continue;
      const hit = findRemoved(entries, m[1], kinds);
      if (!hit) return issue;
      count++;
      const { name, status, replacement, since, note } = hit;
      return { ...issue, removed: { name, status, replacement, ...(since ? { since } : {}), ...(note ? { note } : {}) } };
    }
    return issue;
  });
  return { issues: out, count };
}

let cached = null;

/** The entries of deprecations.json - the docs checkout, else the mirror -
 *  or null when neither answers. Read once per process. */
export async function removedApiEntries({ fetchFile = fetchRemoteFile } = {}) {
  if (cached) return cached;
  let text = null;
  const root = resolveDocs();
  if (root) {
    try {
      text = fs.readFileSync(path.join(root, DEPRECATIONS_PATH), 'utf8');
    } catch {
      /* an older checkout without the file: the mirror */
    }
  }
  if (text === null) {
    try {
      text = fs.readFileSync(await fetchFile('docs', DEPRECATIONS_PATH), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.entries)) return null;
    cached = data.entries;
    return cached;
  } catch {
    return null;
  }
}

/** Test hook: forget the read entries. */
export function resetRemovedApi() {
  cached = null;
}

/** deploy_app / deploy_folder: the lint's issues annotated in place, and the
 *  sentence for the hint when any named removed API. Never throws. */
export async function explainRemoved(lint) {
  if (!lint || lint.ok || !Array.isArray(lint.issues) || !lint.issues.length) return null;
  if (!lint.issues.some((i) => NOT_FOUND.some(({ re }) => re.test(String((i && i.message) || ''))))) return null;
  const entries = await removedApiEntries().catch(() => null);
  if (!entries) return null;
  const { issues, count } = annotateRemoved(lint.issues, entries);
  if (!count) return null;
  lint.issues = issues;
  return `${count} finding(s) name abap2UI5 API that was removed or moved - each carries \`removed.replacement\`, `
    + 'what to write instead; validate_view finds the same calls before a deploy and fix_view rewrites the mechanical ones';
}

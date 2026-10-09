/*
 * docs — the documentation site, searched from its sources.
 *
 * The site (abap2ui5.github.io/docs) is the prose half of the ecosystem: the
 * cookbook, the setup chapters, the advanced guides. An agent that needs it
 * mid-task had two bad options: a web search (which the sibling model exists
 * to avoid, and which lands on rendered HTML wrapped in site navigation) or
 * training data (where abap2UI5 still looks like z2ui5_cl_xml_view). The
 * sources are markdown in the docs checkout, so they are searched there —
 * live on every query, like every other document this server serves.
 *
 * A hit answers with both halves of a page's identity: where it is IN THE
 * CHECKOUT (docs/<path>.md, for reading right here) and where it is PUBLISHED.
 * The published pair follows the docs repo's own generate-llms.mjs, which
 * derives every URL as SITE + /<path>: the rendered page at <path>.html and
 * its raw-markdown twin at <path>.md, published beside it for exactly this
 * kind of reader.
 */
import fs from 'fs';
import path from 'path';
import { resolveDocs } from './repos.mjs';
import { readCached } from './cache.mjs';

export const SITE = 'https://abap2ui5.github.io/docs';

/** The markdown tree inside a docs checkout, or null without one. */
export function docsRoot() {
  const root = resolveDocs();
  if (!root) return null;
  return path.join(root, 'docs');
}

/* The same exclusions the site's own generator makes: .vitepress is the build
 * machinery, public/ is published assets (including the generated markdown
 * copies - finding a page twice helps nobody), node_modules is nobody's page. */
const SKIP = new Set(['.vitepress', 'public', 'node_modules']);

/* An entry that cannot be statted - a dangling symbolic link, a file gone
 * mid-pull - is no page, and is skipped: it used to throw out of the walk,
 * and one such link anywhere in the tree failed every docs_search. */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      /* lstat, not stat: a symbolic link is NOT followed. A docs checkout is
       * untrusted content, and a link could point a page's directory at a
       * tree outside the checkout (its content would reach the client as a
       * "docs page") or back into it (a cycle that walks forever). The site's
       * own build does not publish through symlinks, so skipping them loses
       * no real page. */
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Every page as { path: 'advanced/mcp_server', text }, read live. The tree
 *  walk stays live (a new page appears on the next query); each page's TEXT is
 *  mtime-cached (lib/cache.mjs), so an unchanged file costs a stat, not a
 *  read, and an edited one invalidates itself. */
export function readPages() {
  const root = docsRoot();
  if (!root || !fs.existsSync(root)) return null;
  return walk(root).map((file) => ({
    path: path.relative(root, file).replace(/\\/g, '/').replace(/\.md$/, ''),
    // the heading slicing is cached WITH the text: searchDocs re-slices every
    // page on every query otherwise, and the slices are pure over the text
    ...readCached(file, (text) => ({ text, sliced: slicePage(text) })),
  }));
}

const stripFrontmatter = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

/*
 * The markdown links of a text, as the global pattern
 * /\[([^\]]+)\]\(([^)]*)\)/g (`emptyTarget`) or /\[([^\]]+)\]\(([^)]+)\)/g
 * matches them: `{ index, end, text, target }` per match, left to right.
 * Without the pattern's cost: from every `[` it scanned to the next `]`, and
 * from every `](` to the next `)`, so a run of `[` (or of `[a](` without a
 * closing parenthesis) in a mirrored page was quadratic - 3 s for 50k `[`.
 * Both scans only ever move right, so their last answers are kept:
 *   - the link text is everything up to the FIRST `]` after the `[` (the
 *     class excludes `]`), and must not be empty;
 *   - the target is everything from the `(` right after it up to the first
 *     `)` (the class excludes `)`), empty only where the pattern allows it;
 *   - no `]` (or no `)`) further right means no further match at all.
 * test/unit.test.mjs holds it to both patterns.
 */
export function markdownLinks(s, { emptyTarget = true } = {}) {
  const out = [];
  let close = -1;
  let paren = -1;
  for (let i = s.indexOf('['); i !== -1; i = s.indexOf('[', i + 1)) {
    if (close <= i) {
      close = s.indexOf(']', i + 1);
      if (close === -1) break;
    }
    if (close === i + 1 || s[close + 1] !== '(') continue;
    if (paren < close + 2) {
      paren = s.indexOf(')', close + 2);
      if (paren === -1) break;
    }
    if (paren === close + 2 && !emptyTarget) continue;
    out.push({ index: i, end: paren + 1, text: s.slice(i + 1, close), target: s.slice(close + 2, paren) });
    i = paren;
  }
  return out;
}

/** What s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') makes of a text. */
function linkTexts(s) {
  let out = '';
  let last = 0;
  for (const m of markdownLinks(s)) {
    out += s.slice(last, m.index) + m.text;
    last = m.end;
  }
  return out + s.slice(last);
}

// markdown flattened just enough for a snippet: link text kept, targets and
// emphasis dropped, underscores left alone (identifiers carry them)
const plain = (s) =>
  linkTexts(s)
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/*
 * The text of a heading line: what /^#{min,max}\s+(.+?)\s*$/ captures (no m
 * flag), or null - without that pattern's cost. Its lazy group retried \s*$
 * from every position of a run of blanks, quadratic in a line of a mirrored
 * GitHub page. Spelled out:
 *   - min..max hashes, then at least one blank (a line terminator counts);
 *   - text after the blanks: the text up to the first line terminator,
 *     trimmed at its end - provided nothing but blanks follows that
 *     terminator (`.` crosses none, and `$` is the end of the line);
 *   - nothing after the blanks: `.+?` takes one of them that is no line
 *     terminator (the last such after the first, as the regex backtracks),
 *     or there is no heading.
 * test/unit.test.mjs holds it to the regex.
 */
export function headingText(line, min, max) {
  let i = 0;
  while (line[i] === '#') i += 1;
  if (i < min || i > max) return null;
  let j = i;
  while (j < line.length && /\s/.test(line[j])) j += 1;
  if (j === i) return null;
  if (j === line.length) {
    for (let k = j - 1; k > i; k -= 1) if (!/[\n\r\u2028\u2029]/.test(line[k])) return line[k];
    return null;
  }
  const rest = line.slice(j);
  const t = rest.search(/[\n\r\u2028\u2029]/);
  if (t !== -1 && rest.slice(t).trim()) return null;
  return (t === -1 ? rest : rest.slice(0, t)).trimEnd();
}

/** One page cut into its heading sections; the text before the first heading
 *  keeps the page title as its heading, the way readers meet it. */
export function slicePage(text) {
  const body = stripFrontmatter(String(text));
  /* the first `# ` line, trimmed - the \s+ may cross blank lines; written
   * without `(.+?)\s*$`, which is quadratic in a run of blanks */
  const title = ((body.match(/^#\s+(\S.*)?/m) || [])[1] || '').trim();
  const sections = [];
  let current = { heading: title, body: [] };
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const h = inFence ? null : headingText(line, 1, 4);
    if (h !== null) {
      sections.push({ ...current, body: current.body.join('\n') });
      current = { heading: plain(h), body: [] };
    } else {
      current.body.push(line);
    }
  }
  sections.push({ ...current, body: current.body.join('\n') });
  return { title: plain(title), sections: sections.filter((s) => s.heading || s.body.trim()) };
}

/** ~200 flattened characters around the first term occurrence in a section. */
function snippetOf(body, terms) {
  const flat = plain(body);
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, 200);
  const start = Math.max(0, at - 60);
  const cut = flat.slice(start, start + 220);
  return `${start > 0 ? '...' : ''}${cut}${start + 220 < flat.length ? '...' : ''}`;
}

/*
 * Search: terms AND-ed over the whole page (title, headings, body), the same
 * semantics as every other search here. Ranking is deliberately simple —
 * a page whose TITLE carries every term beats one where only a heading does,
 * which beats a body-only hit; ties keep path order. Each hit names the
 * heading of the best-matching section and a snippet from it, plus the
 * published URL pair.
 */
export function searchDocs({ query, limit = 10, pages = null } = {}) {
  const all = pages ?? readPages();
  if (all === null) return null;
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = (hay) => terms.every((t) => hay.includes(t));

  const results = [];
  for (const page of all) {
    const { title, sections } = page.sliced ?? slicePage(page.text);
    const hay = `${page.path}\n${page.text}`.toLowerCase();
    if (!hits(hay)) continue;

    // the best section: all terms together beats some terms beats the intro —
    // and a section with text to quote beats an equally-matching bare heading
    const preferBody = (list) => list.find((s) => s.body.trim()) || list[0];
    const withAll = sections.filter((s) => hits(`${s.heading}\n${s.body}`.toLowerCase()));
    const withSome = sections.filter((s) => terms.some((t) => `${s.heading}\n${s.body}`.toLowerCase().includes(t)));
    const section = (withAll.length && preferBody(withAll))
      || (withSome.length && preferBody(withSome))
      || sections[0]
      || { heading: title, body: '' };

    const rank = hits(title.toLowerCase()) ? 0
      : sections.some((s) => hits(s.heading.toLowerCase())) ? 1
        : 2;

    results.push({
      rank,
      path: page.path,
      title: title || page.path,
      heading: section.heading,
      snippet: snippetOf(section.body, terms),
      url: `${SITE}/${page.path}.html`,
      markdown: `${SITE}/${page.path}.md`,
    });
  }
  results.sort((a, b) => a.rank - b.rank);
  return results.slice(0, Math.max(1, limit)).map(({ rank, ...r }) => r);
}

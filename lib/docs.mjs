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

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Every page as { path: 'advanced/mcp_server', text }, read live. */
export function readPages() {
  const root = docsRoot();
  if (!root || !fs.existsSync(root)) return null;
  return walk(root).map((file) => ({
    path: path.relative(root, file).replace(/\\/g, '/').replace(/\.md$/, ''),
    text: fs.readFileSync(file, 'utf8'),
  }));
}

const stripFrontmatter = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

// markdown flattened just enough for a snippet: link text kept, targets and
// emphasis dropped, underscores left alone (identifiers carry them)
const plain = (s) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** One page cut into its heading sections; the text before the first heading
 *  keeps the page title as its heading, the way readers meet it. */
export function slicePage(text) {
  const body = stripFrontmatter(String(text));
  const title = (body.match(/^#\s+(.+?)\s*$/m) || [, ''])[1].trim();
  const sections = [];
  let current = { heading: title, body: [] };
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const h = !inFence && line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (h) {
      sections.push({ ...current, body: current.body.join('\n') });
      current = { heading: plain(h[1]), body: [] };
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
    const { title, sections } = slicePage(page.text);
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

/*
 * guide — the app-building rulebook, read live from the abap2UI5 checkout.
 *
 * This server had exactly one rulebook to offer, `generation_rules`, and it
 * serves samples-controls' `scripts/generation-prompt.txt`, whose first line
 * is "You are porting one official UI5 demo kit sample to abap2UI5". That is
 * the right instruction for the corpus and the wrong one for everyone else:
 * an agent building a USER's app was being handed the porting brief - an input
 * sample it does not have, a `z2ui5_cl_smpc_app_<n>` naming convention that is
 * not its app's, and a 1:1-fidelity goal that is not its goal.
 *
 * The document for the other job already exists and is maintained beside the
 * framework sources: `docs/agents/building-apps.md` in abap2UI5, written
 * deliberately self-contained so an agent with no web access has the whole
 * picture ("this file exists so an agent without web access has the complete
 * picture in-repo").
 *
 * Read live from the checkout for the reason every other document here is:
 * a copy in this repository would be a second source of truth, and the one
 * that goes stale. Sliced the way `pitfalls` slices the skills - by `## `
 * heading - because the sections are the guide's own chapters and a chapter is
 * the smallest piece that still answers a question on its own.
 */
import fs from 'fs';
import path from 'path';
import { resolveA2UI5 } from './repos.mjs';

export const GUIDE_PATH = ['docs', 'agents', 'building-apps.md'];

/** Where the guide lives inside an abap2UI5 checkout, or null without one. */
export function guideFile() {
  const a2 = resolveA2UI5();
  if (!a2) return null;
  return path.join(a2, ...GUIDE_PATH);
}

/** The raw guide text, or null when the checkout does not carry it. */
export function readGuide() {
  const file = guideFile();
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/*
 * The guide cut into its `## ` chapters.
 *
 * The text before the first heading - what the guide is, what it is derived
 * from, and the "when this guide and the code disagree, the code wins" rule -
 * is kept as a section of its own under the document title, because it is the
 * half that says how to read the rest. Same decision `sliceCatalogue` makes
 * about its preamble, for the same reason.
 */
export function sliceGuide(md, { section = '', query = '' } = {}) {
  const body = String(md).trim();
  const out = [];
  let current = { heading: '(intro)', body: [] };
  for (const line of body.split('\n')) {
    if (/^## /.test(line)) {
      out.push({ ...current, body: current.body.join('\n').trim() });
      current = { heading: line.replace(/^##\s*/, '').trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  out.push({ ...current, body: current.body.join('\n').trim() });

  let sections = out.filter((s) => s.body);
  /* A chapter can be asked for by anything that identifies it: its number
   * ("5"), a word from its heading ("events"), or the whole thing. The
   * headings are numbered ("## 5. Events"), and a number is what an agent has
   * in hand after reading the table of contents a first call returned. */
  if (section) {
    const want = String(section).trim().toLowerCase();
    /* A number means THE chapter number and nothing else. Falling through to a
     * substring match made `section: "5"` return chapter 3 as well, because its
     * heading contains `z2ui5_cl_ui5_view_builder` - a digit is a terrible
     * needle in a document about a framework with one in its name. */
    const asNumber = /^\d+$/.test(want);
    sections = sections.filter((s) => {
      const h = s.heading.toLowerCase();
      if (asNumber) return /^(\d+)\./.exec(h)?.[1] === want;
      return h === want || h.includes(want);
    });
  }
  const needles = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!needles.length) return sections;
  // every term has to appear somewhere in the chapter - heading or body
  return sections.filter((s) => {
    const hay = `${s.heading}\n${s.body}`.toLowerCase();
    return needles.every((n) => hay.includes(n));
  });
}

/** Every chapter heading, so a narrowed answer can say what it left out. */
export function guideChapters(md) {
  return sliceGuide(md).map((s) => s.heading);
}

/*
 * examples — the three sample catalogues as one queryable index of working apps.
 *
 * The question this answers is "has somebody already built X". `capabilities`
 * answers the neighbouring one — "can abap2UI5 express this UI5 feature at
 * all" — from samples-controls' CAPABILITIES.md. Neither answers the other: a
 * control being expressible says nothing about how an app that uses it is put
 * together, and a pattern being demonstrated says nothing about which controls
 * are reachable.
 *
 * THREE repositories, because the answer was in three places and this tool only
 * knew one of them:
 *
 *   samples           the PATTERNS. Value help, navigation between
 *                     apps, trees, tables, timers. Runs on a bare abap2UI5.
 *   samples-stack     the same, but each needs something from the
 *                     SYSTEM: an OData service, a RAP behavior definition, an
 *                     APC channel, the Fiori launchpad. Worth proposing only
 *                     when the user has that.
 *   samples-controls  the UI5 demo kit rebuilt control by control - the largest
 *                     of the three. The answer to "how do I express
 *                     sap.m.Wizard", which the other two rarely have.
 *
 * TWO catalogue shapes per repository, read in this order:
 *
 *   catalogue.json    the machine-readable catalogue all three repositories
 *                     commit now, richer than the page: verification status
 *                     and deviation types (samples-controls), the learning-path
 *                     stage (samples), technology and what the system must
 *                     provide (samples-stack). Preferred when present.
 *   SAMPLES.md        the same catalogue rendered as a page - the ONLY shape
 *                     an older checkout has, so the row parser stays and a
 *                     checkout from before catalogue.json keeps answering.
 *
 * For `samples` the two are read TOGETHER even when the JSON is present: its
 * catalogue.json deliberately covers only src/01 (the portable set), while the
 * src/00 experimental and test apps are listed in SAMPLES.md alone - dropping
 * them would silently empty the `area: experimental-or-test` filter. The JSON
 * wins for every class it carries; the page fills in the rest.
 *
 * Parsed ON EVERY QUERY rather than indexed into a generated artefact, so what
 * the agent sees is always exactly what the file says. Each file is itself
 * generated from the classes, and each repository gates the source lines, so
 * the search terms this reads cannot quietly go missing. A catalogue.json that
 * does not parse (mid-pull, half-written) falls back to SAMPLES.md for that
 * repository rather than failing the tool.
 *
 * A missing checkout is not an error here: the tool answers from the
 * catalogues that ARE present and names the ones it could not read, because a
 * partial answer to "has somebody built this" is worth more than a refusal.
 *
 * What comes back is a POINTER, never a copy: repository, class name and path.
 * The agent reads the class - a whole app that compiles, renders and is
 * downported to every supported release - instead of a fragment that would have to be
 * kept in step with it here.
 *
 * catalogue-derived.json, beside catalogue.json in samples and samples-controls,
 * is what the LINTER knows about each class - above all every control type
 * its view BUILDS. The catalogue says what a sample is filed under and the
 * words somebody chose for it; neither is the list of controls the view
 * builds, so "sap.m.Dialog" found 7 of the 33 ports that build one. The
 * search matches those control names too (ranked below a match in the
 * catalogue's own words) and a hit names the ones it matched under `builds`.
 * Optional: a checkout without the file is searched as before.
 *
 * Parsed shape per entry:
 *   { repo, area, section, title, sub, summary, label, keywords, docs, cls, path }
 * plus, where the repository's catalogue.json says so:
 *   status, deviations (samples-controls), stage (samples),
 *   technology, needs (samples-stack)
 */
import fs from 'fs';
import path from 'path';
import { resolveSamples, resolveSamplesStack, resolveSamplesControls } from './repos.mjs';
import { readCached } from './cache.mjs';
import { remoteStatus } from './remote.mjs';
import { headingText, markdownLinks } from './docs.mjs';

/* The catalogues, in the order an agent should prefer them: a pattern that
 * runs anywhere, then a control port, then one that needs the stack. */
export const CATALOGUES = [
  {
    repo: 'samples',
    key: 'samples',
    url: 'https://github.com/abap2UI5/samples',
    env: 'SAMPLES_HOME',
    resolve: resolveSamples,
    what: 'patterns - runs on a bare abap2UI5 install',
  },
  {
    repo: 'samples-controls',
    key: 'corpus',
    url: 'https://github.com/abap2UI5/samples-controls',
    env: 'SAMPLES_CONTROLS_HOME',
    resolve: resolveSamplesControls,
    what: 'the UI5 demo kit, control by control',
  },
  {
    repo: 'samples-stack',
    key: 'samplesStack',
    url: 'https://github.com/abap2UI5/samples-stack',
    env: 'SAMPLES_STACK_HOME',
    resolve: resolveSamplesStack,
    what: 'needs something from the system - OData, RAP, APC, the launchpad',
  },
];

/** Which catalogues can be read right now, and which are missing and why.
 *  A found catalogue names its preferred `file` and `source`
 *  (catalogue.json where the checkout has one, SAMPLES.md otherwise) plus
 *  `mdFile`, the page that backs the JSON up - the fallback for a JSON that
 *  does not parse, and the only listing of samples' src/00 area. */
export function catalogueFiles() {
  const found = [];
  const missing = [];
  for (const c of CATALOGUES) {
    const root = c.resolve();
    if (!root) {
      missing.push({ ...c, why: `${c.repo} checkout not found — clone ${c.url} as a sibling of mcp-server, or point ${c.env} at an existing checkout${remoteStatus(c.key)}` });
      continue;
    }
    const json = path.join(root, 'catalogue.json');
    const md = path.join(root, 'SAMPLES.md');
    const derived = path.join(root, 'catalogue-derived.json');
    const hasJson = fs.existsSync(json);
    const hasMd = fs.existsSync(md);
    if (hasJson || hasMd) {
      found.push({
        ...c,
        root,
        file: hasJson ? json : md,
        source: hasJson ? 'catalogue.json' : 'SAMPLES.md',
        mdFile: hasMd ? md : null,
        derivedFile: fs.existsSync(derived) ? derived : null,
      });
    } else {
      missing.push({ ...c, why: `${c.repo} checkout at ${root} has neither catalogue.json nor SAMPLES.md — update it (git pull)` });
    }
  }
  return { found, missing };
}

/* One catalogue row:
 *
 *   | **Basics I** — Hello World<br>What the sample shows.<br><sub>hello world minimal</sub> | [`Z2UI5_CL_SMP_APP_493`](src/01/z2ui5_cl_smp_app_493.clas.abap) |
 *
 * The bold half is present only where the row carries a header of its own
 * (the generators drop one that would just repeat its section), so both shapes
 * have to parse.
 *
 * And the dash after it is optional, because samples-controls writes the whole
 * header in bold and nothing after it:
 *
 *   | **sap.m.Bar**<br>Each screen of a mobile application...<br><sub>bar sap.m header</sub> | [`Z2UI5_CL_SMPC_APP_002`](src/01/01/z2ui5_cl_smpc_app_002.clas.abap) |
 *
 * Requiring the dash made that whole catalogue - at the time 430 of the 614
 * apps - parse
 * as a row with NO header: the title fell back to the section, so every port in
 * the file announced itself as the LIBRARY it belongs to, and the one thing an
 * agent asks this tool for, the control, survived only inside the keyword blob
 * and inside `sub` with its asterisks still on.
 *
 * After the title come the blocks, and they are matched as ONE group and split
 * afterwards rather than as a fixed sequence. A regex that counted them would
 * match nothing at all the day another is added, and this parser failing looks
 * like "there are no samples for that" rather than like a parse error - which
 * is exactly what happened when the catalogues grew the `@docs` links, and
 * would have happened again when they grew the summary.
 *
 *   <br>text                the summary sentence (normal type)
 *   <br><sub>text</sub>     the search terms, then the docs links
 *
 * The match must not backtrack into a run of blanks (a padded table cell is
 * one, and the catalogues are mirrored GitHub content): written as
 * `\|\s*...(?<sub>[^|<]*?)\s*...\s*\|` the pattern tried every split of the
 * run between the \s* and `sub`, and a row of 1000 blanks without a sample
 * link took 85 s - cubic. Its successor kept the blanks atomically and was
 * still quadratic: every end a text block could have was tried with the
 * sample link after it, and the link's `\(([^)]+)\)` scanned to the next `)`
 * each time - 0.4 s for a 50k row of "|[`A`](" without a parenthesis.
 *
 * So matchRow is that pattern spelled out - the same rows, the same groups
 * (test/unit.test.mjs holds it to the regex, ROW_PATTERN there):
 *
 *   ^\|\s*(?:\*\*(?<title>[^*]+)\*\*\s*(?:(?:—|--)\s*)?)?(?<sub>[^|<]*)
 *   (?<blocks>(?:<br>(?:<[a-z]+>[^<]*<\/[a-z]+>|[^<]*(?!\s)))*)
 *   \s*\|\s*\[`(?<cls>[A-Z0-9_]+)`\]\((?<path>[^)]+)\)\s*\|
 *
 * with every \s* and `sub` atomic. Every piece but the blocks matches in
 * exactly one way, so the search is the regex's backtracking order over the
 * blocks: from a `<br>`, first the tagged block and whatever follows it, then
 * the plain text up to the next `<` and whatever follows that, then each
 * shorter plain text not followed by a blank (no `<br>` can follow those),
 * then no further block - and the first end the sample link matches after
 * wins. That answer depends only on where the `<br>` is, so it is worked out
 * once per `<br>`, right to left, and the link test is O(1) over arrays of
 * the next non-blank / non-class / lowercase / `<` / `)` position. Then the
 * three ways the header parses, in the regex's order: title and dash, title
 * alone, no title.
 */
const BLANK = /\s/;
const isClassChar = (c) => (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
const isLower = (c) => c >= 'a' && c <= 'z';
const EM_DASH = String.fromCharCode(0x2014);

/** One catalogue row as `{ title, sub, blocks, cls, path, end }` (`end` is
 *  the length of the match), or null. */
export function matchRow(line) {
  const s = String(line);
  if (s[0] !== '|') return null;
  const n = s.length;
  // the first position >= i that is no blank / no class character / no
  // lowercase letter / a `<` (n when there is none) / a `)` (-1)
  const noBlank = new Int32Array(n + 1);
  const noClass = new Int32Array(n + 1);
  const noLower = new Int32Array(n + 1);
  const lt = new Int32Array(n + 1);
  const paren = new Int32Array(n + 1);
  noBlank[n] = noClass[n] = noLower[n] = lt[n] = n;
  paren[n] = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = s[i];
    noBlank[i] = BLANK.test(c) ? noBlank[i + 1] : i;
    noClass[i] = isClassChar(c) ? noClass[i + 1] : i;
    noLower[i] = isLower(c) ? noLower[i + 1] : i;
    lt[i] = c === '<' ? i : lt[i + 1];
    paren[i] = c === ')' ? i : paren[i + 1];
  }
  // \s*\|\s*\[`(cls)`\]\((path)\)\s*\| at i, or null
  const link = (i) => {
    let j = noBlank[i];
    if (s[j] !== '|') return null;
    j = noBlank[j + 1];
    if (s[j] !== '[' || s[j + 1] !== '`') return null;
    const c = noClass[j + 2];
    if (c === j + 2 || s[c] !== '`' || s[c + 1] !== ']' || s[c + 2] !== '(') return null;
    const p = paren[c + 3];
    if (p === -1 || p === c + 3) return null;
    const e = noBlank[p + 1];
    if (s[e] !== '|') return null;
    return { cls: s.slice(j + 2, c), path: s.slice(c + 3, p), end: e + 1 };
  };
  // where <[a-z]+>[^<]*<\/[a-z]+> at i ends, or -1
  const tagged = (i) => {
    if (s[i] !== '<') return -1;
    const a = noLower[i + 1];
    if (a === i + 1 || s[a] !== '>') return -1;
    const b = lt[a + 1];
    if (b === n || s[b + 1] !== '/') return -1;
    const c = noLower[b + 2];
    if (c === b + 2 || s[c] !== '>') return -1;
    return c + 1;
  };
  // where the blocks end that a match takes from i on, or -1
  const fromBr = new Map();
  const after = (i) => (s.startsWith('<br>', i) ? fromBr.get(i) : (link(i) ? i : -1));
  for (let q = s.lastIndexOf('<br>'); q !== -1; q = q === 0 ? -1 : s.lastIndexOf('<br>', q - 1)) {
    let end = -1;
    const t = tagged(q + 4);
    if (t !== -1) end = after(t);
    const r = lt[q + 4];
    if (end === -1) end = after(r);
    for (let e = r - 1; end === -1 && e >= q + 4; e -= 1) {
      if (noBlank[e] === e && link(e)) end = e;
    }
    if (end === -1 && link(q)) end = q;
    fromBr.set(q, end);
  }
  const heads = [];
  const lead = noBlank[1];
  if (s[lead] === '*' && s[lead + 1] === '*') {
    const star = s.indexOf('*', lead + 2);
    if (star > lead + 2 && s[star + 1] === '*') {
      const title = s.slice(lead + 2, star);
      const t = noBlank[star + 2];
      if (s[t] === EM_DASH) heads.push({ title, at: noBlank[t + 1] });
      else if (s[t] === '-' && s[t + 1] === '-') heads.push({ title, at: noBlank[t + 2] });
      heads.push({ title, at: t });
    }
  }
  heads.push({ title: undefined, at: lead });
  for (const { title, at } of heads) {
    let p = at;
    while (p < n && s[p] !== '|' && s[p] !== '<') p += 1;
    const end = after(p);
    if (end === -1) continue;
    const l = link(end);
    return { title, sub: s.slice(at, p), blocks: s.slice(p, end), cls: l.cls, path: l.path, end: l.end };
  }
  return null;
}

/* The blocks under a row title, in order, as `{ tag, text }`.
 *
 * A block wrapped in a tag nobody here knows is kept as a block with that tag
 * and then ignored by both readers below - which is the whole reason the row
 * pattern accepts any tag rather than `<sub>` alone. Twice now a new KIND of
 * block has made every row unmatchable over here, and that failure reads as
 * "there are no samples for that" rather than as a parse error. */
function blocksOf(blocks) {
  return [...(blocks || '').matchAll(/<br>(?:<([a-z]+)>([^<]*)<\/[a-z]+>|([^<]*))/g)]
    .map((m) => (m[1] !== undefined
      ? { tag: m[1], text: (m[2] || '').trim() }
      : { tag: '', text: (m[3] || '').trim() }))
    .filter((b) => b.text);
}

/** The sentence: the first block in NORMAL type (no tag at all). */
const summaryOf = (blocks) => (blocksOf(blocks).find((b) => !b.tag)?.text || '');

/** The keywords: the first `<sub>` block that is not the `docs:` one. */
const keywordsOf = (blocks) =>
  (blocksOf(blocks).find((b) => b.tag === 'sub' && !b.text.startsWith('docs:'))?.text || '');

/*
 * The cookbook pages a sample is the worked example of, out of the row's
 * `docs:` block:
 *
 *   <sub>docs: [cookbook/model/binding](https://abap2ui5.github.io/docs/...)</sub>
 *
 * The generators put them there deliberately - somebody decided which chapter
 * each app illustrates - and this parser used to be the place they stopped: it
 * knew the block existed only well enough to SKIP it while looking for the
 * keywords. So an agent got the class to read and no way to reach the prose
 * explaining what it demonstrates, which is the half a human reviewer would
 * have opened first.
 *
 * Returned as `{ topic, url }` rather than as the raw markdown, because the
 * topic path IS the answer to "which chapter is this" and a caller should not
 * have to parse a link out of a string to get at it.
 */
/* the matches of /\[([^\]]+)\]\(([^)]+)\)/g, scanned in linear time (docs.mjs) */
const docsOf = (blocks) => {
  const block = blocksOf(blocks).find((b) => b.tag === 'sub' && b.text.startsWith('docs:'));
  if (!block) return [];
  return markdownLinks(block.text, { emptyTarget: false }).map((m) => ({ topic: m.text.trim(), url: m.target.trim() }));
};

/* src/00 is experimental (97) or a test app (98); everything else is the
 * supported set. Decided by src/00, not by src/01: samples flattened both
 * packages into one `src/` on 2026-09-22 (its catalogue.json and SAMPLES.md
 * name `src/z2ui5_cl_smp_app_540.clas.abap`), and asking for src/01 then
 * filed EVERY sample under experimental-or-test - `area: samples` answered
 * nothing at all, the one filter the description calls "what you normally
 * want". An older checkout still has src/01 and src/00 and reads as before. */
const areaOf = (repo, p) => {
  if (repo !== 'samples') return repo;
  return /^src\/00(\/|$)/.test(p) ? 'experimental-or-test' : 'samples';
};

/*
 * catalogue.json, adapted to the SAME entry shape the row parser produces -
 * one search, one ranking, one result shape regardless of which file a
 * checkout carries. The three files differ (each repository describes what IT
 * knows), so there is one adapter per repository rather than a shape guess.
 *
 * Returns null for anything that is not that repository's catalogue - a
 * truncated file, a foreign JSON, a future shape - so the caller can fall
 * back to SAMPLES.md instead of answering "there are no samples for that".
 */
export function catalogueEntries(cat, repo) {
  if (!cat || typeof cat !== 'object') return null;
  const list = repo === 'samples-controls' ? cat.ports : cat.samples;
  if (!Array.isArray(list)) return null;
  const entries = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !e.class) continue;
    const adapted = ADAPT[repo]?.(e);
    if (adapted) entries.push(adapted);
  }
  return entries;
}

const joined = (k) => (Array.isArray(k) ? k.join(' ') : String(k || ''));

/**
 * catalogue-derived.json as class (upper case) -> the control types its view
 * builds, or null for anything that is not that file: samples-controls keys
 * its list `ports`, samples `samples`, both index one `controls`
 * dictionary per entry.
 */
export function derivedControls(derived) {
  if (!derived || typeof derived !== 'object' || !Array.isArray(derived.controls)) return null;
  const list = Array.isArray(derived.ports) ? derived.ports : (Array.isArray(derived.samples) ? derived.samples : null);
  if (!list) return null;
  const map = new Map();
  for (const p of list) {
    if (!p || !p.class || !Array.isArray(p.controls)) continue;
    map.set(String(p.class).toUpperCase(), p.controls.map((i) => derived.controls[i]).filter((n) => typeof n === 'string'));
  }
  return map;
}

/* The entries with the controls their views build, as a property the
 * answer does not carry (`controlsBuilt`, non-enumerable: the search reads
 * it; a hit that needed it names what it matched under `builds`). Copies -
 * the parsed entries are cached. */
function withBuilds(entries, builds) {
  if (!builds) return entries;
  return entries.map((e) => {
    const names = builds.get(e.cls);
    if (!names) return e;
    const copy = { ...e };
    Object.defineProperty(copy, 'controlsBuilt', { value: names, enumerable: false });
    return copy;
  });
}

/* samples' docs are bare URLs in the JSON; the row parser returns
 * `{ topic, url }` with the topic being the answer to "which chapter is
 * this", so the URL's path under /docs/ is read back out. */
const docTopic = (url) => /\/docs\/([^?#]+?)(?:\.html)?$/.exec(url)?.[1] || url;

const ADAPT = {
  samples(e) {
    const file = e.file || '';
    const title = (e.title || '').trim();
    const desc = (e.description || '').trim();
    return {
      repo: 'samples',
      section: e.category || '',
      title: title || e.category || '',
      sub: desc,
      summary: e.summary || '',
      keywords: joined(e.keywords),
      docs: (Array.isArray(e.docs) ? e.docs : []).map((u) => ({ topic: docTopic(u), url: u })),
      /* the generated page drops a row header that would just repeat its
       * section; in the JSON that reads title === category, and the label
       * must not duplicate it either */
      label: title && title !== e.category
        ? [title, desc].filter(Boolean).join(' — ')
        : (desc || title),
      cls: String(e.class).toUpperCase(),
      path: file,
      area: areaOf('samples', file),
      ...(e.stage ? { stage: e.stage } : {}),
    };
  },
  'samples-controls'(e) {
    /* the control (`entity`) leads: it is what an agent asks for, and the
     * JSON carries it even for the ports whose SAMPLES.md row only names the
     * library. src/03 collection entries have no entity - their title already
     * names the control. */
    const entity = (e.entity || '').trim();
    const title = (e.title || '').trim();
    return {
      repo: 'samples-controls',
      section: e.library || e.category || '',
      title: entity || title,
      sub: entity && title !== entity ? title : '',
      summary: e.summary || '',
      keywords: joined(e.keywords),
      docs: [],
      label: entity && title !== entity ? `${entity} — ${title}` : (entity || title),
      cls: String(e.class).toUpperCase(),
      path: e.file || '',
      area: 'samples-controls',
      ...(e.status ? { status: e.status } : {}),
      ...(Array.isArray(e.deviations) && e.deviations.length ? { deviations: e.deviations } : {}),
    };
  },
  'samples-stack'(e) {
    const title = (e.title || '').trim();
    return {
      repo: 'samples-stack',
      section: e.technology || e.package || '',
      title,
      sub: '',
      summary: e.summary || '',
      keywords: joined(e.keywords),
      docs: [],
      label: title,
      cls: String(e.class).toUpperCase(),
      path: e.path || '',
      area: 'samples-stack',
      ...(e.technology ? { technology: e.technology } : {}),
      ...(e.needs ? { needs: e.needs } : {}),
    };
  },
};

/* Every entry a found catalogue has to offer: the JSON where it parses, and
 * SAMPLES.md rows for every class the JSON does not carry - which is the
 * whole page on an old checkout, samples' src/00 area on a current one, and
 * nothing at all where the JSON covers everything. */
function readCatalogue(c) {
  /* Both parses are mtime-cached (lib/cache.mjs): an unchanged catalogue
   * costs a stat per query, a pulled one invalidates itself. The try/catch
   * semantics are unchanged - a file that does not read or parse answers
   * exactly what it answered before, and nothing broken is cached. */
  const readMd = () => {
    if (!c.mdFile) return [];
    try { return readCached(c.mdFile, (text) => parseRows(text, c.repo)); } catch { return []; }
  };
  let builds = null;
  if (c.derivedFile) {
    try { builds = readCached(c.derivedFile, (text) => derivedControls(JSON.parse(text))); } catch { builds = null; }
  }
  if (c.source !== 'catalogue.json') return withBuilds(readMd(), builds);
  let fromJson = null;
  try { fromJson = readCached(c.file, (text) => catalogueEntries(JSON.parse(text), c.repo)); } catch { fromJson = null; }
  if (fromJson === null) return withBuilds(readMd(), builds);
  const have = new Set(fromJson.map((e) => e.cls));
  return withBuilds([...fromJson, ...readMd().filter((e) => !have.has(e.cls))], builds);
}

export function parseExamples(rawText = null, repo = 'samples') {
  if (rawText !== null) return parseRows(rawText, repo);
  return catalogueFiles().found.flatMap((c) => readCatalogue(c));
}

/** The SAMPLES.md row parser — the shape every checkout has, and the only one
 *  a checkout from before catalogue.json has. */
function parseRows(rawText, repo) {
  const sources = [{ repo, text: rawText }];

  const entries = [];
  for (const source of sources) {
    let section = '';
    for (const line of source.text.split('\n')) {
      const head = headingText(line, 2, 3);
      if (head !== null) { section = head.replace(/[*`]/g, '').replace(/\s+—\s+.*$/, '').trim(); continue; }
      const g = matchRow(line);
      if (!g) continue;
      entries.push({
        repo: source.repo,
        section,
        // a row without its own header is titled by the section it sits under
        title: (g.title || section).trim(),
        sub: (g.sub || '').trim(),
        summary: summaryOf(g.blocks),
        keywords: keywordsOf(g.blocks),
        docs: docsOf(g.blocks),
        /* What to call it in one line, so a caller does not reassemble it.
         * Deliberately reads the RAW header rather than `title`: a row whose
         * header would repeat its section does not carry one, and `title` falls
         * back to the section there - announcing the F4 value-help sample as
         * "Popup" rather than as what it does. */
        label: [g.title?.trim(), (g.sub || '').trim()].filter(Boolean).join(' — ')
          || section,
        cls: g.cls,
        path: g.path,
        area: areaOf(source.repo, g.path),
      });
    }
  }
  return entries;
}

/* The tie-breakers under the relevance score, both taken from what the
 * catalogues themselves assert:
 *
 * Repository order is the order an agent should prefer them in (a pattern
 * that runs anywhere, then a control port, then one that needs the stack) -
 * the order CATALOGUES already declares. It used to arrive implicitly, as
 * the stable sort preserving parse order; spelled out so the status rank
 * below cannot reorder repositories.
 *
 * Verification status is samples-controls' own scale: `checked` (a human
 * watched the port run in a real system) over `reviewed` (read against its
 * original) over `generated` (machine-written, not yet reviewed). Between
 * two equally relevant ports the one somebody has SEEN RUN is the better
 * class to copy from. `collection` (src/03, hand-written) sits with
 * reviewed: curated, not machine-generated, not run-verified either.
 * Entries without a status (the other repositories, old checkouts) rank
 * with `generated` - unclaimed, not penalized below it. */
const REPO_RANK = Object.fromEntries(CATALOGUES.map((c, i) => [c.repo, i]));
const STATUS_RANK = { checked: 3, reviewed: 2, collection: 2, generated: 1 };

/** Every term has to appear somewhere in the entry - the same AND semantics
 *  `searchCapabilities` uses, so a two-word query narrows rather than widens.
 *  `rawText` (a SAMPLES.md) and `rawCatalogue` (a parsed catalogue.json)
 *  inject a single fixture catalogue the way the other parsers here take
 *  their raw documents - tests pin the semantics without a checkout. */
export function searchExamples({ query, area, repo, limit = 20, rawText = null, rawCatalogue = null, rawDerived = null } = {}) {
  let entries = rawCatalogue !== null
    ? (catalogueEntries(rawCatalogue, repo || 'samples') || [])
    : parseExamples(rawText, repo || 'samples');
  if (rawDerived !== null) entries = withBuilds(entries, derivedControls(rawDerived));
  if (repo) entries = entries.filter((e) => e.repo === repo);
  if (area) entries = entries.filter((e) => e.area === area);
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    /* The docs links are deliberately NOT in the haystack. Almost every row in
     * `samples` carries one and almost every one of them starts `cookbook/`,
     * so a query for "cookbook" would match the entire catalogue - a search
     * term nobody chose, drowning the ones somebody did. They travel as an
     * ANSWER (the `docs` field), not as a way to be found. */
    const hay = (e) => `${e.section} ${e.title} ${e.sub} ${e.summary} ${e.keywords} ${e.cls}`.toLowerCase();
    /* and the control types the view builds (catalogue-derived.json): a
     * term may be found there instead - "sap.m.Dialog" in every port that
     * builds one, not only in those whose catalogue words say so */
    const missing = (e) => {
      const h = hay(e);
      return terms.filter((t) => !h.includes(t));
    };
    entries = entries.filter((e) => {
      const b = (e.controlsBuilt || []).join(' ').toLowerCase();
      return missing(e).every((t) => b.includes(t));
    });
    /* A hit in the KEYWORDS is a hit on a word somebody chose to be found by;
     * a hit in the title, the summary or the section may be incidental.
     * Ranked, not filtered - the weaker matches are still the answer when
     * there are no others. */
    const score = (e) => {
      const k = e.keywords.toLowerCase();
      return terms.filter((t) => k.includes(t)).length;
    };
    /* Every term in the catalogue's own words first, whatever the keyword
     * score: a control the view builds says the sample USES it, not that
     * it is about it. The keyword score came first, and a port that merely
     * built a Select outranked one whose words carry "select dialog" - a
     * match of the catalogue's words moved off the first page. Among
     * themselves the catalogue-word matches keep the order they have
     * without the derived file; the rest follow, the more terms in their
     * words the earlier. */
    const textScore = (e) => terms.length - missing(e).length;
    entries = [...entries].sort((a, b) =>
      ((textScore(b) === terms.length) - (textScore(a) === terms.length))
      || (score(b) - score(a))
      || (textScore(b) - textScore(a))
      || ((REPO_RANK[a.repo] ?? CATALOGUES.length) - (REPO_RANK[b.repo] ?? CATALOGUES.length))
      || ((STATUS_RANK[b.status] ?? 1) - (STATUS_RANK[a.status] ?? 1)));
    /* the controls a hit was found BY, named - at most a few, and only on a
     * hit that needed them: on every hit the field was noise ("button"
     * named sap.m.Button on all 20 of a page found by their own words) */
    entries = entries.map((e) => {
      const need = missing(e);
      const names = need.length ? (e.controlsBuilt || []).filter((n) => need.some((t) => n.toLowerCase().includes(t))) : [];
      return names.length ? { ...e, builds: names.slice(0, 8) } : e;
    });
  }
  /* Always bounded, whatever the caller passed. `limit > 0 ? ... : entries` used
   * to mean that 0, a negative number and the NaN a non-numeric argument
   * produces all returned the WHOLE catalogue - 600+ entries, straight into an
   * agent's context, from an argument that was meant to make the answer
   * smaller. server.mjs coerces and clamps before it gets here (lib/args.mjs);
   * this is the floor for every other caller. */
  const n = Number(limit);
  return entries.slice(0, Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 20);
}

export function exampleSummary(rawText = null) {
  const entries = parseExamples(rawText);
  const byRepo = {};
  const bySection = {};
  for (const e of entries) {
    byRepo[e.repo] = (byRepo[e.repo] || 0) + 1;
    bySection[`${e.repo}|${e.section}`] = 1;
  }
  const { found, missing } = rawText === null ? catalogueFiles() : { found: [], missing: [] };
  return {
    total: entries.length,
    byRepo,
    sections: Object.keys(bySection).length,
    // which shape each repository answered from - catalogue.json (richer:
    // status, stage, technology) or the SAMPLES.md page an older checkout has
    ...(found.length
      ? { sources: Object.fromEntries(found.map((c) => [c.repo, c.source])) }
      : {}),
    ...(missing.length
      ? { notSearched: missing.map((m) => `${m.repo}: ${m.why}`) }
      : {}),
  };
}

/**
 * The catalogue entry of one sample class - repository and path - or null.
 * What read_example needs to turn a class name an `examples` hit carried into
 * the file to read; case-blind, because the catalogues write the class upper
 * case and an agent copies whatever it saw.
 */
export function findExample(cls) {
  const want = String(cls || '').trim().toUpperCase();
  if (!want) return null;
  const hit = parseExamples().find((e) => e.cls === want && e.path);
  return hit ? { repo: hit.repo, path: hit.path, cls: hit.cls } : null;
}

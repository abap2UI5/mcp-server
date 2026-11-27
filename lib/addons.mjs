/*
 * addons - "is there an addon for this?", from the catalogue of
 * abap2UI5-addons.
 *
 * An agent building an app through this server learned the framework, the
 * samples and the docs - and never that github.com/abap2UI5-addons exists. So
 * it hand-built a confirm dialog, a file upload, a user layout store, where a
 * finished class was one nav_app_call( ) away (popups: z2ui5_cl_popup_*;
 * layout-management; ...). The catalogue of those addons is committed in the
 * repository of their site, abap2UI5-addons/abap2ui5-addons.github.io, as two
 * things, and both are read LIVE from a checkout (ADDONS_HOME, a sibling) or
 * its read-only GitHub mirror (lib/remote.mjs), like every other document:
 *
 *   src/data/catalog.ts          the groups and the order, which repository
 *                                sits in which group, its organisation and
 *                                whether it publishes a site of its own
 *   src/data/addons/<repo>.json  the facts of one addon: title, tagline,
 *                                summary, features, requirements, install
 *                                notes, a usage snippet - and, OPTIONAL,
 *                                `useWhen` (one sentence for an agent),
 *                                `entryPoints` (the classes app code calls)
 *                                and `dependsOn` ("<org>/<repo>")
 *
 * The site also publishes a projection of both (addons.json). It is not what
 * this module reads: the mirror fetches committed files of a repository from
 * raw.githubusercontent.com, and a page of a built site is neither - the raw
 * files say the same and need no build to have run.
 *
 * catalog.ts is TypeScript, read here as text: the `groups` literal is plain
 * data (ids, titles and `{ repo: "..." }` entries), and `parseCatalog` reads
 * exactly that. A catalogue it finds no group in is reported by path, never
 * answered as "there are no addons". Every optional field may be absent - an
 * older checkout, an addon nobody described for agents yet - and the answer
 * then carries what is there (the tagline in place of `useWhen`, no entry
 * points, dependencies read out of the requirements and marked as inferred).
 *
 * Pure where it can be: parseCatalog, addonRecord, searchAddons, installOrder
 * and the three answer builders take data, so test/addons.test.mjs runs them
 * on fixtures; only readAddons touches a checkout.
 */
import fs from 'fs';
import path from 'path';
import { resolveAddons } from './repos.mjs';
import { readCached } from './cache.mjs';
import { insideRoot } from './contain.mjs';
import { CATALOG_PATH, FACTS_DIR, DEFAULT_ORG, FRAMEWORK, validRepoName, parseCatalog } from './addons-catalog.mjs';

export { CATALOG_PATH, FACTS_DIR, DEFAULT_ORG, FRAMEWORK, validRepoName, parseCatalog } from './addons-catalog.mjs';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/** "<org>/<repo>" of a `dependsOn` item - a bare repo is the addons org's. */
function dependencyName(item) {
  if (typeof item !== 'string') return null;
  const [a, b, ...rest] = String(item).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
  if (rest.length) return null;
  const org = b === undefined ? DEFAULT_ORG : a;
  const repo = b === undefined ? a : b;
  return validRepoName(org) && validRepoName(repo) ? `${org}/${repo}` : null;
}

/**
 * One addon as this server answers it: the catalogue entry and its facts
 * folded into one record with every field present in ONE shape, whatever the
 * JSON carried. `facts` is the parsed src/data/addons/<repo>.json, or null
 * when the file is missing or not JSON (`factsMissing` says so).
 *
 * `dependsOn` is the file's when it has the key. Without the key - a
 * checkout from before the field - the repositories its `requirements` name
 * as "<addons org>/<repo>" stand in, and `dependsOnInferred` marks them as
 * read out of prose. The framework is never listed (it is first in every
 * install order anyway). Pure.
 */
export function addonRecord(entry, group, facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const name = `${entry.org}/${entry.repo}`;
  const github = `https://github.com/${name}`;
  const requirements = strings(f.requirements);
  const declared = Array.isArray(f.dependsOn);
  const named = declared
    ? f.dependsOn.map(dependencyName)
    : requirements.flatMap((r) => [...r.matchAll(new RegExp(`\\b${DEFAULT_ORG}/([A-Za-z0-9._-]+)`, 'g'))].map((m) => dependencyName(`${DEFAULT_ORG}/${m[1].replace(/[.]+$/, '')}`)));
  const dependsOn = [...new Set(named.filter((d) => d && d !== name && d.toLowerCase() !== FRAMEWORK.toLowerCase()))];
  const install = f.install && typeof f.install === 'object' ? f.install : {};
  return {
    repo: entry.repo,
    org: entry.org,
    name,
    github,
    ...(entry.site ? { site: entry.site } : {}),
    group: group.id,
    groupTitle: group.title,
    title: str(f.title) || entry.repo,
    tagline: str(f.tagline),
    summary: str(f.summary),
    useWhen: str(f.useWhen),
    entryPoints: strings(f.entryPoints),
    dependsOn,
    ...(!declared && dependsOn.length ? { dependsOnInferred: true } : {}),
    features: strings(f.features),
    requirements,
    install: { url: str(install.abapgit_url) || github, notes: strings(install.notes) },
    usage: typeof f.usage === 'string' ? f.usage : '',
    ...(typeof f.cloud === 'boolean' ? { cloud: f.cloud } : {}),
    ...(typeof f.nw702 === 'boolean' ? { nw702: f.nw702 } : {}),
    ...(str(f.status) && str(f.status) !== 'unknown' ? { status: str(f.status) } : {}),
    ...(facts && typeof facts === 'object' ? {} : { factsMissing: true }),
  };
}

/** The catalogue file of a checkout (or mirror), or null without one. */
export function catalogFile() {
  const root = resolveAddons();
  return root ? path.join(root, CATALOG_PATH) : null;
}

/**
 * The catalogue, read live: `{ root, groups, addons }` - or null without a
 * checkout, and `{ root, groups: [], addons: [], problem }` when the checkout
 * has no catalogue this module can read. Each file is parsed once per version
 * of the file (lib/cache.mjs) and read only while it stays inside the
 * checkout (lib/contain.mjs - a checkout is untrusted content). A facts file
 * that is missing or does not parse costs that addon its facts, never the
 * catalogue.
 */
export function readAddons() {
  const root = resolveAddons();
  if (!root) return null;
  let groups;
  try {
    groups = readCached(insideRoot(root, CATALOG_PATH, 'the addons catalogue checkout'), (text) => parseCatalog(text), 'addons-catalog');
  } catch (e) {
    return { root, groups: [], addons: [], problem: `${CATALOG_PATH} could not be read (${String((e && e.message) || e).slice(0, 200)})` };
  }
  if (!groups.length) {
    return { root, groups: [], addons: [], problem: `${CATALOG_PATH} names no group with a \`{ repo: "..." }\` entry - its shape changed` };
  }
  const addons = [];
  for (const group of groups) {
    for (const entry of group.entries) {
      let facts = null;
      try {
        const file = insideRoot(root, path.join(FACTS_DIR, `${entry.repo}.json`), 'the addons catalogue checkout');
        if (fs.existsSync(file)) facts = readCached(file, (text) => JSON.parse(text), 'addons-facts');
      } catch {
        facts = null; // not JSON, or a link out of the checkout: the addon is listed without its facts
      }
      addons.push(addonRecord(entry, group, facts));
    }
  }
  return { root, groups, addons };
}

/** The addon a `repo` argument names: "popups", "abap2UI5-addons/popups" or
 *  its GitHub URL, case-blind - or null. Pure. */
export function findAddon(addons, repo) {
  const want = String(repo ?? '').trim().toLowerCase().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!want) return null;
  return addons.find((a) => a.name.toLowerCase() === want) || addons.find((a) => a.repo.toLowerCase() === want) || null;
}

/**
 * Every repository to install for `addon`, in order: the framework, then
 * each dependency after its own dependencies (transitively - a `dependsOn`
 * that already lists them all resolves to the same list), then the addon.
 * A dependency the catalogue does not carry is kept, marked `known: false`,
 * with its GitHub URL; a cycle is cut where it closes. Pure.
 */
export function installOrder(addon, addons) {
  const byName = new Map(addons.map((a) => [a.name.toLowerCase(), a]));
  const order = [];
  const seen = new Set([FRAMEWORK.toLowerCase()]);
  const visit = (name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const known = byName.get(key);
    for (const dep of known ? known.dependsOn : []) visit(dep);
    order.push(known
      ? { repo: known.name, url: known.install.url }
      : { repo: name, url: `https://github.com/${name}`, known: false });
  };
  visit(addon.name);
  return [{ repo: FRAMEWORK, url: `https://github.com/${FRAMEWORK}` }, ...order];
}

/** What an agent reads first of an addon: when to use it. */
const lead = (a) => a.useWhen || a.tagline || a.summary.split(/(?<=\.)\s/)[0] || '';

/** One addon as a catalogue or search line. */
function line(a) {
  return {
    repo: a.repo,
    title: a.title,
    useWhen: lead(a),
    ...(a.entryPoints.length ? { entryPoints: a.entryPoints } : {}),
    ...(a.org !== DEFAULT_ORG ? { org: a.org } : {}),
  };
}

const NEXT_REPO = 'addons { repo } answers one addon in full: the usage snippet, the requirements, the install order with its dependencies';

/** The whole catalogue, grouped, one line per addon. Pure. */
export function addonsOverview({ groups, addons }) {
  return {
    total: addons.length,
    groups: groups.map((g) => ({
      group: g.id,
      title: g.title,
      ...(g.lead ? { lead: g.lead } : {}),
      addons: addons.filter((a) => a.group === g.id).map(line),
    })),
    hint: 'pass `query` (keywords, e.g. "confirm dialog" or "file upload") to rank the addons against what you are about to build',
    next: NEXT_REPO,
  };
}

/*
 * Ranked, not filtered on every term: "ask the user to confirm a delete" is
 * how the question is asked, and an AND over those words finds nothing. An
 * addon matches when ANY term hits; it ranks by WHERE the terms hit - a class
 * name app code calls, the title and the sentence written for an agent count
 * for more than the long summary - then by how many did.
 */
const FIELDS = [
  ['title', 7, (a) => `${a.title} ${a.repo}`],
  ['entryPoints', 6, (a) => a.entryPoints.join(' ')],
  ['useWhen', 4, (a) => a.useWhen],
  ['tagline', 3, (a) => a.tagline],
  ['features', 2, (a) => a.features.join('\n')],
  ['summary', 1, (a) => a.summary],
];
/* Words every question carries and no addon is about. */
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'is', 'it', 'my', 'i', 'how', 'do', 'app', 'abap2ui5',
  'before', 'after', 'ask', 'user', 'users', 'want', 'need', 'when', 'that', 'this', 'use', 'using', 'some', 'any', 'can', 'there', 'addon', 'addons']);

/* A question says "confirmation" and "deleting" where the catalogue says
 * "confirm" and "delete": a term is matched by its stem - the common English
 * endings taken off, while four letters stay. No dictionary; it only has to
 * make the obvious forms of one word meet. */
export function stem(term) {
  const m = /^(.{4,}?)(?:ations?|ings?|ions?|ed|es|e|s)$/.exec(term);
  return m ? m[1] : term;
}

export function queryTerms(query) {
  const all = String(query ?? '').toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean);
  const kept = all.filter((t) => !STOP.has(t));
  return [...new Set(kept.length ? kept : all)];
}

/** The addons matching `query`, best first: `[{ addon, terms, matchedIn }]`. Pure. */
export function searchAddons(addons, query) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits = [];
  addons.forEach((addon, position) => {
    const hay = FIELDS.map(([name, weight, get]) => [name, weight, get(addon).toLowerCase()]);
    const matched = [];
    const matchedIn = new Set();
    let score = 0;
    for (const term of terms) {
      const where = hay.filter(([, , text]) => text.includes(stem(term)));
      if (!where.length) continue;
      matched.push(term);
      score += where[0][1]; // the strongest field a term hits, once per term
      matchedIn.add(where[0][0]);
    }
    if (matched.length) hits.push({ addon, terms: matched, matchedIn: [...matchedIn], score, position });
  });
  /* the weighted score first: one term in a class name or in `useWhen` says
   * more than two in a long summary; then the number of terms, then the
   * catalogue's own order */
  hits.sort((a, b) => (b.score - a.score) || (b.terms.length - a.terms.length) || (a.position - b.position));
  return hits.map(({ addon, terms: matched, matchedIn }) => ({ addon, terms: matched, matchedIn }));
}

/** The answer to `addons { query }`. Pure. */
export function addonsSearchAnswer({ addons }, query) {
  const terms = queryTerms(query);
  const hits = searchAddons(addons, query);
  if (!hits.length) {
    return {
      matches: 0,
      hint: `no addon matches "${String(query).slice(0, 120)}" - call addons without arguments for the whole catalogue (${addons.length} entries, grouped); `
        + 'no addon for it means building it yourself: `examples` finds a sample app that does it',
    };
  }
  return {
    matches: hits.length,
    returned: hits.length,
    entries: hits.map(({ addon, terms: matched, matchedIn }) => ({
      ...line(addon),
      group: addon.group,
      matchedIn,
      // only when a term did NOT hit: with every term matched the field is noise
      ...(matched.length < terms.length ? { matchedTerms: matched } : {}),
    })),
    next: NEXT_REPO,
  };
}

/** The answer to `addons { repo }`: everything about one addon. Pure. */
export function addonDetail({ addons }, addon) {
  const abap = addon.org === DEFAULT_ORG;
  const order = abap ? installOrder(addon, addons) : null;
  const unknown = order ? order.filter((o) => o.known === false).map((o) => o.repo) : [];
  return {
    repo: addon.repo,
    name: addon.name,
    title: addon.title,
    group: addon.group,
    github: addon.github,
    ...(addon.site ? { site: addon.site } : {}),
    ...(addon.status ? { status: addon.status } : {}),
    ...(addon.tagline ? { tagline: addon.tagline } : {}),
    ...(addon.useWhen ? { useWhen: addon.useWhen } : {}),
    ...(addon.summary ? { summary: addon.summary } : {}),
    ...(addon.entryPoints.length ? { entryPoints: addon.entryPoints } : {}),
    ...(addon.features.length ? { features: addon.features } : {}),
    ...(addon.requirements.length ? { requirements: addon.requirements } : {}),
    ...(typeof addon.cloud === 'boolean' ? { cloud: addon.cloud } : {}),
    ...(typeof addon.nw702 === 'boolean' ? { nw702: addon.nw702 } : {}),
    ...(addon.usage ? { usage: addon.usage } : {}),
    install: {
      url: addon.install.url,
      ...(addon.install.notes.length ? { notes: addon.install.notes } : {}),
      ...(order ? { order } : {}),
      ...(order ? {
        orderNote: 'pull these with abapGit in this order - the framework first, each dependency before what needs it'
          + (addon.dependsOnInferred ? '; the dependencies were read out of the requirements text (this addon declares no `dependsOn` yet), so check them against `requirements`' : '')
          + (unknown.length ? `; ${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not in the catalogue - its own dependencies are not known here` : ''),
      } : {}),
    },
    ...(addon.dependsOn.length ? { dependsOn: addon.dependsOn } : {}),
    ...(abap ? {
      abaplint: `in a project made from app-template, \`npm run add-addon -- ${addon.repo}\` registers this addon and its dependencies `
        + 'for abaplint (the dependencies of abaplint.jsonc), so a class that calls its entry points passes `npm run check`; '
        + 'in any other project add the repositories of `install.order` to the `dependencies` of abaplint.jsonc by hand',
    } : {}),
    ...(addon.factsMissing ? { factsMissing: `${FACTS_DIR}/${addon.repo}.json is missing or not JSON in the catalogue - only what catalog.ts says is known` } : {}),
    next: `read ${addon.site || addon.github} for the whole guide; \`docs_search\` and \`examples\` do not cover the addons`,
  };
}

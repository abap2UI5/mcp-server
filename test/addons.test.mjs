// The `addons` tool (lib/addons.mjs): "is there an addon for this?", from the
// catalogue of abap2UI5-addons. Sibling-free and network-free: the catalogue
// is a FIXTURE written into a temp dir - catalog.ts and the facts JSON in the
// two shapes the tool has to read (with the fields written for agents, and
// without them, as a checkout from before they existed carries it) - pointed
// at through the authoritative ADDONS_HOME, and the mirror is fed by a fake
// fetch. Nothing here reads the real addons site checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCatalog, addonRecord, readAddons, findAddon, installOrder, searchAddons, queryTerms, stem,
  addonsOverview, addonsSearchAnswer, addonDetail, validRepoName, CATALOG_PATH, FACTS_DIR,
} from '../lib/addons.mjs';
import { hydrate, readMarker, resetRemote, REMOTE_FILES, REMOTE_TOOLS } from '../lib/remote.mjs';
import { resolveAddons, REPO_DIRS, RESOLVERS } from '../lib/repos.mjs';
import { clearCache } from '../lib/cache.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* catalog.ts as the site writes it: comments, the types, a `groups` array
 * with one-line and multi-line entries, `org` on the tools, single quotes
 * and an escape once - and a braces-and-repo decoy in a comment before it. */
const CATALOG = `/* The catalogue: every addon, in groups.
 * An entry is { repo: "not-an-entry" } in prose only. */
export type Entry = { repo: string; site?: string; label?: string; org?: string };
export const orgOf = (e: Entry) => e.org ?? "abap2UI5-addons";
export type Group = { id: string; title: string; lead: string; entries: Entry[] };

// Grouped by what a reader is after.
export const groups: Group[] = [
  {
    id: "building-blocks",
    title: "Building blocks",
    lead: "Pieces to build your own apps from: popups, user layouts and \\"more\\".",
    entries: [
      { repo: "popups", site: "https://abap2ui5-addons.github.io/popups/" },
      { repo: "layout-management", site: "https://abap2ui5-addons.github.io/layout-management/" },
      {
        repo: 'range-filter',
      },
      { repo: "old-addon" },
      { repo: "no-facts" },
      { repo: "../escape" },
    ],
  },
  {
    id: "developer-tools",
    title: "Developer tools",
    lead: "What goes into your editor.",
    entries: [
      { repo: "linter", org: "abap2UI5" },
    ],
  },
];

export const entries: Entry[] = groups.flatMap((g) => g.entries);
`;

const FACTS = {
  // the full shape: the three fields written for agents are there
  popups: {
    repo: 'popups',
    title: 'Popups',
    tagline: 'Ready-to-use popups and dialogs, one factory( ) call each.',
    summary: 'A library of finished dialog classes: confirm, inform, select from a list, upload and download files.',
    useWhen: 'Use before hand-building a confirm, select, input or file upload dialog: each one is a finished class.',
    entryPoints: ['z2ui5_cl_popup_to_confirm', 'z2ui5_cl_popup_to_select', 'z2ui5_cl_popup_file_ul'],
    dependsOn: ['abap2UI5-addons/layout-management'],
    features: ['Confirm, Inform, Select and Get Values popups', 'File upload and download'],
    requirements: ['abap2UI5', 'abap2UI5-addons/layout-management'],
    install: { abapgit_url: 'https://github.com/abap2UI5-addons/popups', notes: ['Branch main for ABAP Cloud; branch 702 for NetWeaver 7.02'] },
    usage: 'client->nav_app_call( z2ui5_cl_popup_to_confirm=>factory( `Delete the entry?` ) ).',
    status: 'unknown',
    cloud: true,
    nw702: true,
  },
  'layout-management': {
    repo: 'layout-management',
    title: 'Layout Management',
    tagline: 'User layouts and variants for tables.',
    summary: 'Renders an internal table with a settings button; the user saves the layout as a variant.',
    useWhen: 'Use before hand-building column personalization or saved layout variants for a table.',
    entryPoints: ['z2ui5_cl_layo_manager'],
    dependsOn: ['abap-util/abap-util'],
    features: ['Column order, visibility and sorting per user'],
    requirements: ['abap2UI5'],
    install: { abapgit_url: 'https://github.com/abap2UI5-addons/layout-management', notes: [] },
    usage: '',
  },
  // depends on popups, whose own dependency it does NOT repeat: the order has to resolve it
  'range-filter': {
    repo: 'range-filter',
    title: 'Range Filter',
    tagline: 'Select-options for any table.',
    summary: 'One select-option per field, inline or as a popup.',
    useWhen: 'Use before hand-building select-options or a filter bar with ranges.',
    entryPoints: ['z2ui5_cl_sel_multisel'],
    dependsOn: ['abap2UI5/abap2UI5', 'popups'],
    features: [],
    requirements: [],
    install: { abapgit_url: 'https://github.com/abap2UI5-addons/range-filter', notes: [] },
    usage: '',
  },
  // the shape of a checkout from before the agent fields: none of the three
  'old-addon': {
    repo: 'old-addon',
    title: 'Old Addon',
    tagline: 'A lock dialog nobody described for agents yet.',
    summary: 'Shows who holds a lock. It builds on the popups.',
    features: ['Lock overview'],
    requirements: ['abap2UI5', 'abap2UI5-addons/popups (current version).', 'NetWeaver 7.50 or higher'],
    install: { abapgit_url: 'https://github.com/abap2UI5-addons/old-addon', notes: [] },
    usage: '',
    status: 'experimental',
  },
  linter: {
    repo: 'linter',
    title: 'Linter',
    tagline: 'Check an app class and its view without an SAP system.',
    summary: 'Static and headless-render checks.',
    useWhen: 'Run it on every app class you write or change.',
    entryPoints: [],
    dependsOn: [],
    features: [],
    requirements: [],
    install: { abapgit_url: 'https://abap2ui5.github.io/docs/advanced/linter.html', notes: [] },
    usage: '',
  },
};

/** The fixture as a checkout: catalog.ts and one JSON per addon that has facts. */
function fixtureCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-addons-'));
  fs.mkdirSync(path.join(root, FACTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, CATALOG_PATH), CATALOG);
  for (const [repo, facts] of Object.entries(FACTS)) fs.writeFileSync(path.join(root, FACTS_DIR, `${repo}.json`), JSON.stringify(facts, null, 2));
  return root;
}

/** The fixture's records without a file system. */
function records() {
  const groups = parseCatalog(CATALOG);
  const addons = groups.flatMap((g) => g.entries.map((e) => addonRecord(e, g, FACTS[e.repo] || null)));
  return { groups, addons };
}

const ENV = ['ADDONS_HOME', 'A2UI5_MCP_REMOTE', 'A2UI5_MCP_OFFLINE', 'A2UI5_MCP_REMOTE_DIR', 'A2UI5_MCP_REMOTE_TTL_MS'];
function withEnv(set, fn) {
  return async () => {
    const saved = Object.fromEntries(ENV.map((v) => [v, process.env[v]]));
    for (const v of ENV) delete process.env[v];
    Object.assign(process.env, set());
    clearCache();
    resetRemote();
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetRemote();
    }
  };
}

test('parseCatalog reads the groups and their entries off catalog.ts as text', () => {
  const groups = parseCatalog(CATALOG);
  assert.deepEqual(groups.map((g) => g.id), ['building-blocks', 'developer-tools']);
  assert.equal(groups[0].title, 'Building blocks');
  assert.equal(groups[0].lead, 'Pieces to build your own apps from: popups, user layouts and "more".', 'an escaped quote is read as the quote');
  // multi-line and single-quoted entries are entries; a name that would leave the facts directory is not
  assert.deepEqual(groups[0].entries.map((e) => e.repo), ['popups', 'layout-management', 'range-filter', 'old-addon', 'no-facts']);
  assert.equal(groups[0].entries[0].site, 'https://abap2ui5-addons.github.io/popups/');
  assert.equal(groups[0].entries[0].org, 'abap2UI5-addons', 'the default organisation');
  assert.deepEqual(groups[1].entries, [{ repo: 'linter', org: 'abap2UI5' }]);
  // nothing before the groups literal is an entry - the comment's { repo: "not-an-entry" } included
  assert.ok(!groups.some((g) => g.entries.some((e) => e.repo === 'not-an-entry')));
  // a file that is no catalogue is no groups, never a throw
  assert.deepEqual(parseCatalog('export const nothing = 1;'), []);
  assert.deepEqual(parseCatalog(''), []);
  assert.deepEqual(parseCatalog(undefined), []);
  for (const bad of ['../x', 'a/b', '', '.', '..', 'a b', 'x'.repeat(101)]) assert.equal(validRepoName(bad), false, JSON.stringify(bad));
});

test('addonRecord answers one shape with and without the fields written for agents', () => {
  const { addons } = records();
  const popups = findAddon(addons, 'popups');
  assert.equal(popups.name, 'abap2UI5-addons/popups');
  assert.equal(popups.useWhen, FACTS.popups.useWhen);
  assert.deepEqual(popups.entryPoints, FACTS.popups.entryPoints);
  assert.deepEqual(popups.dependsOn, ['abap2UI5-addons/layout-management']);
  assert.equal(popups.dependsOnInferred, undefined, 'a declared dependsOn is not an inferred one');
  assert.equal(popups.status, undefined, '`unknown` is no status');

  // the old shape: no useWhen, no entry points - and the dependency read out of the requirements, marked
  const old = findAddon(addons, 'old-addon');
  assert.equal(old.useWhen, '');
  assert.deepEqual(old.entryPoints, []);
  assert.deepEqual(old.dependsOn, ['abap2UI5-addons/popups']);
  assert.equal(old.dependsOnInferred, true);
  assert.equal(old.status, 'experimental');

  // the framework is never a dependency, a bare name is the addons organisation's
  assert.deepEqual(findAddon(addons, 'range-filter').dependsOn, ['abap2UI5-addons/popups']);
  // an explicitly EMPTY dependsOn is not inferred around
  assert.deepEqual(addonRecord({ repo: 'x', org: 'abap2UI5-addons' }, { id: 'g', title: 'G' }, { dependsOn: [], requirements: ['abap2UI5-addons/popups'] }).dependsOn, []);

  // listed in the catalogue, no facts file: still an addon, said
  const bare = findAddon(addons, 'no-facts');
  assert.equal(bare.factsMissing, true);
  assert.equal(bare.title, 'no-facts');
  assert.equal(bare.install.url, 'https://github.com/abap2UI5-addons/no-facts');

  // wrong types in a facts file cost the field, not the record
  const odd = addonRecord({ repo: 'odd', org: 'abap2UI5-addons' }, { id: 'g', title: 'G' }, { title: 7, entryPoints: 'z2ui5_cl_x', dependsOn: [3, 'a/b/c', '../x'], features: [null, ' kept '], install: 'nope', usage: 5 });
  assert.equal(odd.title, 'odd');
  assert.deepEqual(odd.entryPoints, []);
  assert.deepEqual(odd.dependsOn, []);
  assert.deepEqual(odd.features, ['kept']);
  assert.equal(odd.usage, '');
});

test('findAddon takes the repository name, org/repo or the GitHub URL, case-blind', () => {
  const { addons } = records();
  for (const name of ['popups', 'Popups', 'abap2UI5-addons/popups', 'https://github.com/abap2UI5-addons/popups', 'https://github.com/abap2ui5-addons/popups.git', ' popups ']) {
    assert.equal(findAddon(addons, name)?.repo, 'popups', name);
  }
  assert.equal(findAddon(addons, 'abap2UI5/linter').repo, 'linter');
  assert.equal(findAddon(addons, 'nothing'), null);
  assert.equal(findAddon(addons, ''), null);
  assert.equal(findAddon(addons, undefined), null);
});

test('installOrder resolves dependsOn transitively: the framework first, every dependency before what needs it', () => {
  const { addons } = records();
  const order = (repo) => installOrder(findAddon(addons, repo), addons).map((o) => o.repo);
  assert.deepEqual(order('layout-management'), ['abap2UI5/abap2UI5', 'abap-util/abap-util', 'abap2UI5-addons/layout-management']);
  assert.deepEqual(order('popups'), ['abap2UI5/abap2UI5', 'abap-util/abap-util', 'abap2UI5-addons/layout-management', 'abap2UI5-addons/popups']);
  // range-filter names only popups: layout-management and abap-util come from popups' own chain
  assert.deepEqual(order('range-filter'),
    ['abap2UI5/abap2UI5', 'abap-util/abap-util', 'abap2UI5-addons/layout-management', 'abap2UI5-addons/popups', 'abap2UI5-addons/range-filter']);
  // a dependency outside the catalogue is kept and marked
  const outside = installOrder(findAddon(addons, 'popups'), addons).find((o) => o.repo === 'abap-util/abap-util');
  assert.equal(outside.known, false);
  assert.equal(outside.url, 'https://github.com/abap-util/abap-util');

  // a list that already names the whole chain resolves to the same order, nothing twice
  const g = { id: 'g', title: 'G' };
  const full = [
    addonRecord({ repo: 'a', org: 'abap2UI5-addons' }, g, { dependsOn: [] }),
    addonRecord({ repo: 'b', org: 'abap2UI5-addons' }, g, { dependsOn: ['abap2UI5-addons/a'] }),
    addonRecord({ repo: 'c', org: 'abap2UI5-addons' }, g, { dependsOn: ['abap2UI5-addons/a', 'abap2UI5-addons/b'] }),
  ];
  assert.deepEqual(installOrder(full[2], full).map((o) => o.repo), ['abap2UI5/abap2UI5', 'abap2UI5-addons/a', 'abap2UI5-addons/b', 'abap2UI5-addons/c']);

  // a cycle ends where it closes, every repository once
  const loop = [
    addonRecord({ repo: 'a', org: 'abap2UI5-addons' }, g, { dependsOn: ['abap2UI5-addons/b'] }),
    addonRecord({ repo: 'b', org: 'abap2UI5-addons' }, g, { dependsOn: ['abap2UI5-addons/a'] }),
  ];
  assert.deepEqual(installOrder(loop[0], loop).map((o) => o.repo), ['abap2UI5/abap2UI5', 'abap2UI5-addons/b', 'abap2UI5-addons/a']);
});

test('searchAddons ranks by where the terms hit, matches any term and the stem of a word', () => {
  const { addons } = records();
  const top = (q) => searchAddons(addons, q).map((h) => h.addon.repo);
  // a sentence, not keywords: "confirmation" meets "confirm", the stop words do not match everything
  assert.equal(top('ask the user for confirmation before deleting a row')[0], 'popups');
  assert.equal(top('file upload')[0], 'popups');
  assert.equal(top('table layout variant')[0], 'layout-management');
  assert.equal(top('select-options ranges')[0], 'range-filter');
  // a class name app code calls finds its addon
  assert.equal(top('z2ui5_cl_layo_manager')[0], 'layout-management');
  // without useWhen and entry points an addon is still found by its title, tagline, features and summary
  assert.equal(top('lock')[0], 'old-addon');
  assert.deepEqual(searchAddons(addons, 'lock')[0].matchedIn, ['tagline']);
  // nothing matches: an empty list, and a blank query is no query
  assert.deepEqual(top('kubernetes'), []);
  assert.deepEqual(top('   '), []);
  assert.deepEqual(queryTerms('How do I confirm the delete?'), ['confirm', 'delete']);
  assert.deepEqual(queryTerms('the app'), ['the', 'app'], 'a query of stop words alone keeps them');
  assert.equal(stem('confirmation'), 'confirm');
  assert.equal(stem('deleting'), 'delet');
  assert.equal(stem('row'), 'row');
});

test('the three answers: the grouped overview, the ranked matches, one addon in full', () => {
  const catalogue = records();
  const overview = addonsOverview(catalogue);
  assert.equal(overview.total, 6);
  assert.deepEqual(overview.groups.map((g) => g.group), ['building-blocks', 'developer-tools']);
  const [popups, , , old] = overview.groups[0].addons;
  assert.deepEqual(popups, { repo: 'popups', title: 'Popups', useWhen: FACTS.popups.useWhen, entryPoints: FACTS.popups.entryPoints });
  // no useWhen: the tagline stands in; no entry points: no field
  assert.deepEqual(old, { repo: 'old-addon', title: 'Old Addon', useWhen: FACTS['old-addon'].tagline });
  assert.equal(overview.groups[1].addons[0].org, 'abap2UI5');

  const found = addonsSearchAnswer(catalogue, 'confirm dialog');
  assert.equal(found.matches, found.entries.length);
  assert.equal(found.entries[0].repo, 'popups');
  assert.equal(found.entries[0].group, 'building-blocks');
  assert.match(found.next, /addons \{ repo \}/);
  const none = addonsSearchAnswer(catalogue, 'kubernetes');
  assert.equal(none.matches, 0);
  assert.match(none.hint, /no addon matches/);
  assert.equal(none.entries, undefined);

  const detail = addonDetail(catalogue, findAddon(catalogue.addons, 'popups'));
  assert.equal(detail.usage, FACTS.popups.usage);
  assert.deepEqual(detail.entryPoints, FACTS.popups.entryPoints);
  assert.deepEqual(detail.install.order.map((o) => o.repo), ['abap2UI5/abap2UI5', 'abap-util/abap-util', 'abap2UI5-addons/layout-management', 'abap2UI5-addons/popups']);
  assert.match(detail.install.orderNote, /abap-util\/abap-util is not in the catalogue/);
  assert.match(detail.abaplint, /npm run add-addon -- popups/);
  assert.equal(detail.cloud, true);
  assert.equal(detail.site, 'https://abap2ui5-addons.github.io/popups/');

  // inferred dependencies are said to be inferred
  const old2 = addonDetail(catalogue, findAddon(catalogue.addons, 'old-addon'));
  assert.match(old2.install.orderNote, /read out of the requirements text/);
  assert.equal(old2.useWhen, undefined);
  assert.equal(old2.entryPoints, undefined);

  // a developer tool of the framework's organisation is no abapGit dependency: no order, no add-addon
  const linter = addonDetail(catalogue, findAddon(catalogue.addons, 'linter'));
  assert.equal(linter.install.order, undefined);
  assert.equal(linter.abaplint, undefined);
  assert.equal(linter.install.url, 'https://abap2ui5.github.io/docs/advanced/linter.html');

  assert.match(addonDetail(catalogue, findAddon(catalogue.addons, 'no-facts')).factsMissing, /no-facts\.json is missing/);
});

test('readAddons reads a checkout live, survives a broken facts file and names a catalogue it cannot read', withEnv(() => ({ A2UI5_MCP_REMOTE: '0' }), async () => {
  const root = fixtureCheckout();
  try {
    process.env.ADDONS_HOME = root;
    assert.equal(resolveAddons(), root);
    const catalogue = readAddons();
    assert.equal(catalogue.problem, undefined);
    assert.equal(catalogue.addons.length, 6);
    assert.equal(findAddon(catalogue.addons, 'no-facts').factsMissing, true);

    // a facts file that is not JSON costs that addon its facts, never the catalogue
    fs.writeFileSync(path.join(root, FACTS_DIR, 'popups.json'), '{ not json');
    const broken = readAddons();
    assert.equal(broken.addons.length, 6);
    assert.equal(findAddon(broken.addons, 'popups').factsMissing, true);
    assert.equal(findAddon(broken.addons, 'layout-management').factsMissing, undefined);

    // a facts file that is a link out of the checkout is not read
    if (process.platform !== 'win32') {
      const outside = path.join(os.tmpdir(), `a2ui5-addons-outside-${process.pid}.json`);
      fs.writeFileSync(outside, JSON.stringify({ title: 'LEAKED' }));
      try {
        fs.rmSync(path.join(root, FACTS_DIR, 'linter.json'));
        fs.symlinkSync(outside, path.join(root, FACTS_DIR, 'linter.json'));
        assert.equal(findAddon(readAddons().addons, 'linter').title, 'linter');
      } finally {
        fs.rmSync(outside, { force: true });
      }
    }

    // a catalogue whose shape this server does not read is a problem by path, not "no addons"
    fs.writeFileSync(path.join(root, CATALOG_PATH), 'export const groups = makeGroups();\n');
    const unreadable = readAddons();
    assert.equal(unreadable.addons.length, 0);
    assert.match(unreadable.problem, /src\/data\/catalog\.ts names no group/);

    // a set ADDONS_HOME that is no checkout resolves to nothing - never to a sibling guess
    process.env.ADDONS_HOME = path.join(root, 'nowhere');
    assert.equal(resolveAddons(), null);
    assert.equal(readAddons(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

test('the addons repository is wired like every other mirrored sibling', () => {
  assert.equal(REPO_DIRS.addons.repository, 'abap2UI5-addons/abap2ui5-addons.github.io');
  assert.deepEqual(REPO_DIRS.addons.env, ['ADDONS_HOME']);
  assert.equal(REPO_DIRS.addons.probe, CATALOG_PATH);
  assert.equal(RESOLVERS.addons, resolveAddons, 'setup_status and the mirror step work over RESOLVERS');
  assert.deepEqual(REMOTE_FILES.addons, [CATALOG_PATH]);
  assert.deepEqual(REMOTE_TOOLS.addons, ['addons']);
});

/** A fake fetch serving `files` (url suffix -> text), recording the URLs. */
function fakeFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = Object.entries(files).find(([suffix]) => url.endsWith(suffix));
    if (!hit) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => hit[1] };
  };
  impl.calls = calls;
  return impl;
}

const MIRROR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-addons-mirror-'));
test.after(() => fs.rmSync(MIRROR_DIR, { recursive: true, force: true }));

test('the mirror follows the catalogue: catalog.ts, then one facts file per repository it places', withEnv(() => ({ A2UI5_MCP_REMOTE_DIR: path.join(MIRROR_DIR, 'ok') }), async () => {
  // every entry of the catalogue has a facts file upstream (the site's own test holds it to that)
  const upstream = { ...FACTS, 'no-facts': { repo: 'no-facts', title: 'No Facts', tagline: 't', summary: 's' } };
  const fetchImpl = fakeFetch({
    [`/${CATALOG_PATH}`]: CATALOG,
    ...Object.fromEntries(Object.entries(upstream).map(([repo, facts]) => [`/${FACTS_DIR}/${repo}.json`, JSON.stringify(facts)])),
  });
  const res = await hydrate('addons', { local: null, fetchImpl });
  assert.equal(res.fetched, true, res.error);
  assert.ok(fetchImpl.calls.every((u) => u.startsWith('https://raw.githubusercontent.com/abap2UI5-addons/abap2ui5-addons.github.io/main/')),
    'the raw files of the repository - not the published site');
  assert.deepEqual(readMarker(res.root).files,
    [CATALOG_PATH, ...['popups', 'layout-management', 'range-filter', 'old-addon', 'no-facts', 'linter'].map((r) => `${FACTS_DIR}/${r}.json`)]);
  assert.ok(!fetchImpl.calls.some((u) => u.includes('escape')), 'a repo name that is no plain name is never fetched');
  // the mirror reads like a checkout
  assert.deepEqual(parseCatalog(fs.readFileSync(path.join(res.root, CATALOG_PATH), 'utf8')).map((g) => g.id), ['building-blocks', 'developer-tools']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(res.root, FACTS_DIR, 'popups.json'), 'utf8')).title, 'Popups');
}));

test('a catalogue the mirror cannot read, or a facts file that is missing, leaves no mirror', withEnv(() => ({ A2UI5_MCP_REMOTE_DIR: path.join(MIRROR_DIR, 'bad') }), async () => {
  const noGroups = await hydrate('addons', { local: null, fetchImpl: fakeFetch({ [`/${CATALOG_PATH}`]: 'export const groups = makeGroups();' }) });
  assert.equal(noGroups.root, null);
  assert.match(noGroups.error, /names no group/);
  resetRemote();
  // popups.json is not there: all or nothing, as for the template
  const hole = await hydrate('addons', { local: null, force: true, fetchImpl: fakeFetch({ [`/${CATALOG_PATH}`]: CATALOG, [`/${FACTS_DIR}/linter.json`]: '{}' }) });
  assert.equal(hole.root, null);
  assert.match(hole.error, /HTTP 404/);
  assert.ok(!fs.existsSync(path.join(MIRROR_DIR, 'bad', 'abap2ui5-addons.github.io', CATALOG_PATH)), 'nothing was written');
  // a set env var or the switch means no download at all
  process.env.ADDONS_HOME = '/nowhere';
  const configured = await hydrate('addons', { local: null, fetchImpl: fakeFetch({}) });
  assert.equal(configured.configured, 'ADDONS_HOME');
}));

// ------------------------------------------------ the server, over stdio ----

function startServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, A2UI5_MCP_SYSTEM_URL: '', A2UI5_MCP_REMOTE: '0', ...env },
  });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; });
  let id = 0;
  const until = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find(pred);
      if (hit) {
        clearInterval(iv);
        resolve(hit);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout; got: ${buf.slice(-500)}`));
      }
    }, 20);
  });
  const rpc = async (method, params) => {
    const reqId = ++id;
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })}\n`);
    return until((m) => m.id === reqId);
  };
  const call = async (name, args = {}) => {
    const msg = await rpc('tools/call', { name, arguments: args });
    assert.ok(!msg.error, JSON.stringify(msg.error));
    return { isError: !!msg.result.isError, text: msg.result.content[0].text };
  };
  return { rpc, call, stop: () => p.kill() };
}

test('the addons tool over stdio: the catalogue, a query, one addon, and its refusals', async () => {
  const root = fixtureCheckout();
  const s = startServer({ ADDONS_HOME: root });
  try {
    await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'addons', version: '0' } });

    const overview = JSON.parse((await s.call('addons')).text);
    assert.equal(overview.total, 6);
    assert.equal(overview.source, root);
    assert.deepEqual(overview.groups[0].addons[0].entryPoints, FACTS.popups.entryPoints);
    assert.equal(overview.entryPointsCut, undefined);

    const found = JSON.parse((await s.call('addons', { query: 'ask for confirmation before deleting a row' })).text);
    assert.equal(found.entries[0].repo, 'popups');
    assert.equal(found.matches >= found.returned, true);
    assert.ok(found.entries[0].entryPoints.includes('z2ui5_cl_popup_to_confirm'));

    // paged like its neighbours: offset, returned, more
    const many = JSON.parse((await s.call('addons', { query: 'popups table lock', limit: 1 })).text);
    assert.ok(many.matches > 1);
    assert.equal(many.returned, 1);
    assert.match(many.more, /offset: 1 \(same query\)/);
    const rest = JSON.parse((await s.call('addons', { query: 'popups table lock', offset: 1 })).text);
    assert.equal(rest.offset, 1);
    assert.equal(rest.returned, many.matches - 1);
    assert.equal(rest.more, undefined);

    const nothing = JSON.parse((await s.call('addons', { query: 'kubernetes' })).text);
    assert.equal(nothing.matches, 0);

    const detail = JSON.parse((await s.call('addons', { repo: 'range-filter' })).text);
    assert.deepEqual(detail.install.order.map((o) => o.repo),
      ['abap2UI5/abap2UI5', 'abap-util/abap-util', 'abap2UI5-addons/layout-management', 'abap2UI5-addons/popups', 'abap2UI5-addons/range-filter']);
    assert.match(detail.abaplint, /npm run add-addon -- range-filter/);
    // `repo` wins over `query`
    assert.equal(JSON.parse((await s.call('addons', { repo: 'popups', query: 'lock' })).text).repo, 'popups');

    const unknown = await s.call('addons', { repo: 'no-such-addon' });
    assert.ok(unknown.isError);
    assert.match(unknown.text, /no addon 'no-such-addon' in the catalogue — it has: popups, layout-management/);

    // setup_status names the repository like every other sibling
    const status = JSON.parse((await s.call('setup_status')).text);
    assert.equal(status.repos.addons.local, root);
    assert.equal(status.repos.addons.env, 'ADDONS_HOME');
  } finally {
    s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the addons tool without a catalogue: the missing checkout, and a checkout whose catalogue changed shape', async () => {
  const root = fixtureCheckout();
  fs.writeFileSync(path.join(root, CATALOG_PATH), 'export const groups = makeGroups();\n');
  const changed = startServer({ ADDONS_HOME: root });
  const missing = startServer({ ADDONS_HOME: path.join(root, 'nowhere') });
  try {
    for (const s of [changed, missing]) await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'addons', version: '0' } });
    const shape = await changed.call('addons', { query: 'confirm' });
    assert.ok(shape.isError);
    assert.match(shape.text, /src\/data\/catalog\.ts names no group/);
    assert.match(shape.text, /git pull/);

    const gone = await missing.call('addons');
    assert.ok(gone.isError);
    assert.match(gone.text, /abap2ui5-addons\.github\.io checkout not found/);
    assert.match(gone.text, /ADDONS_HOME is set, so the read-only GitHub mirror is not consulted/);
  } finally {
    changed.stop();
    missing.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

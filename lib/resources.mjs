/*
 * resources — the knowledge documents this server already serves, as MCP
 * resources with stable URIs.
 *
 * The tools slice and search these documents; the resources hand them over
 * WHOLE, for clients that surface resources (attach-a-document UIs, context
 * pickers) and for agents that want the full text without learning a tool's
 * query arguments first. Nothing here is new content: every reader below
 * resolves the same sibling checkout the corresponding tool resolves, live,
 * per read — a copy in this repository would be a second source of truth, and
 * the one that goes stale.
 *
 * Two rules keep this list honest:
 *
 * - LISTING IS FREE. `resources/list` returns names and URIs from this array
 *   and touches no file — a client may poll it, and a missing sibling must
 *   not make the listing lie or fail. Which is why the per-chapter guide
 *   reads are a resource TEMPLATE (`abap2ui5://guide/{chapter}`) rather than
 *   one listed resource per chapter: enumerating chapters would mean reading
 *   the guide on every list.
 * - READING DEGRADES LIKE A TOOL CALL. A read against a missing checkout
 *   throws the exact message the tool returns (lib/siblings.mjs — which repo,
 *   how to clone it, which env var), so the fix is the same whichever surface
 *   the agent came through. The client sees it as the JSON-RPC error of the
 *   read request.
 */
import fs from 'fs';
import path from 'path';
import { resolveSamplesControls } from './repos.mjs';
import { readInside } from './contain.mjs';
import { missingSiblingMessage } from './siblings.mjs';
import { readGuide, sliceGuide, guideChapters, guideFile, GUIDE_PATH } from './guide.mjs';
import { readApiParsed, apiSummary, apiFile, API_PATH } from './api.mjs';
import { readPitfalls, pitfallsFile, AREAS, sliceCatalogue } from './pitfalls.mjs';
import { ANSWER_BUDGET, fitObject } from './budget.mjs';
import { APP_SCREEN_URI, APP_SCREEN_META, UI_MIME, readAppScreen } from './mcp-app.mjs';

/* A sibling can be checked out and the file still absent — an older revision,
 * a half-finished pull, a rename upstream. Same contract as the tools: name
 * the file, name the way out. */
function requireSibling(repo) {
  const miss = missingSiblingMessage(repo);
  if (miss) throw new Error(miss);
}

function guideText() {
  requireSibling('abap2UI5');
  const md = readGuide();
  if (md === null) {
    throw new Error(`the abap2UI5 checkout has no ${GUIDE_PATH.join('/')} (looked in ${guideFile()}) — `
      + 'update it (git pull); the app-building guide lives there');
  }
  return md;
}

/* The JSON-RPC error codes the MCP spec names for resources/read: a URI
 * this server does not serve is -32002 ("Resource not found"), a malformed
 * one -32602. The SDK answers a thrown error with its numeric `code`, and
 * with -32603 (internal error) when there is none - which is what every
 * unknown URI used to be, a server fault by the client's reading. A missing
 * checkout stays -32603: the resource exists, this machine cannot read it. */
const RESOURCE_NOT_FOUND = -32002;
const INVALID_PARAMS = -32602;
function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function guideChapterText(chapter) {
  const md = guideText();
  const sections = sliceGuide(md, { section: chapter });
  if (!sections.length) {
    throw protocolError(RESOURCE_NOT_FOUND, `no guide chapter matches '${chapter}' — ask by number or heading keyword; the chapters are: `
      + guideChapters(md).join(' | '));
  }
  return sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
}

function capabilitiesText() {
  requireSibling('samples-controls');
  const file = path.join(resolveSamplesControls(), 'CAPABILITIES.md');
  if (!fs.existsSync(file)) {
    throw new Error(`the samples-controls checkout has no CAPABILITIES.md (looked in ${file}) — `
      + 'update it (git pull); the capability map lives there');
  }
  return readInside(resolveSamplesControls(), 'CAPABILITIES.md', 'utf8', 'the samples-controls checkout');
}

function generationRulesText() {
  requireSibling('samples-controls');
  const file = path.join(resolveSamplesControls(), 'scripts', 'generation-prompt.txt');
  if (!fs.existsSync(file)) {
    throw new Error(`the samples-controls checkout has no scripts/generation-prompt.txt (looked in ${file}) — `
      + 'update it (git pull); the rulebook lives there');
  }
  return readInside(resolveSamplesControls(), ['scripts', 'generation-prompt.txt'], 'utf8', 'the samples-controls checkout');
}

function pitfallsText(area) {
  requireSibling('abap2UI5');
  const md = readPitfalls(area);
  if (md === null) {
    throw new Error(`the abap2UI5 checkout has no .claude/skills/${AREAS[area].skill}/SKILL.md `
      + `(looked in ${pitfallsFile(area)}) — update it (git pull); the pitfall catalogues live there`);
  }
  return md;
}

/* The API resource is the SUMMARY, not the raw interface source: one line per
 * method/constant-group/type, the same table of contents the no-argument
 * api_reference call answers with. The full signatures stay behind the tool's
 * `query` — a resource picker that attaches the whole raw interface would
 * spend more context than the summary plus one query ever does. */
function apiText() {
  requireSibling('abap2UI5');
  const api = readApiParsed();
  if (api === null) {
    throw new Error(`the abap2UI5 checkout has no ${API_PATH.join('/')} (looked in ${apiFile()}) — `
      + 'update it (git pull); the client API lives there');
  }
  return JSON.stringify(
    {
      source: 'abap2UI5/' + API_PATH.join('/'),
      about: 'z2ui5_if_client — the complete API an app may call on `client`; the api_reference tool answers `query` with full signatures',
      ...apiSummary(api.parsed),
    },
    null,
    2,
  );
}

/* The static list `resources/list` serves — names and URIs only, no reads.
 * The `read` closures next to them are what `resources/read` runs; they are
 * kept out of the listed objects so the wire carries the MCP shape and
 * nothing else. */
/* What every document resource says about its size - a client reads the
 * description, never this file. */
const CUT = ' Past about 60,000 characters it is cut at a section heading, and its last line names the tool call that reads on.';

const CATALOG = [
  {
    resource: {
      uri: 'abap2ui5://guide',
      name: 'app-building-guide',
      description: 'The abap2UI5 app-building guide, whole — the rulebook for writing a z2ui5_if_app class (live from the abap2UI5 checkout; the app_guide tool slices it by chapter and query)' + CUT,
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: guideText() }),
    sections: sliceGuide,
    rest: (k) => `app_guide { offset: ${k} } pages the rest of the guide chapter by chapter (or read abap2ui5://guide/{chapter})`,
  },
  {
    resource: {
      uri: 'abap2ui5://api',
      name: 'client-api-summary',
      description: 'The z2ui5_if_client API summary: every method, cs_* constant group and type, one line each (live-parsed from the abap2UI5 checkout; the api_reference tool answers queries with full signatures)',
      mimeType: 'application/json',
    },
    read: () => ({ mimeType: 'application/json', text: apiText() }),
    rest: () => 'api_reference without arguments pages the same list (offset, limit)',
  },
  {
    resource: {
      uri: 'abap2ui5://capabilities',
      name: 'capability-map',
      description: 'CAPABILITIES.md — the verified map of what abap2UI5 can express, every entry naming a proving port (live from the samples-controls checkout; the capabilities tool queries it)' + CUT,
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: capabilitiesText() }),
    rest: () => 'the capabilities tool answers the map entry by entry: { query } or { status }, paged by offset',
  },
  {
    resource: {
      uri: 'abap2ui5://generation-rules',
      name: 'porting-rulebook',
      description: 'The rulebook for porting a UI5 demo-kit sample into samples-controls (live from that checkout; for building an app of your own, read abap2ui5://guide instead)',
      mimeType: 'text/plain',
    },
    read: () => ({ mimeType: 'text/plain', text: generationRulesText() }),
    rest: () => 'the rest is in scripts/generation-prompt.txt of the samples-controls checkout',
  },
  {
    resource: {
      uri: 'abap2ui5://pitfalls/abap',
      name: 'pitfalls-abap',
      description: 'abap-check — the ABAP defects a green CI does not catch: abapGit round trip and import, activation, extended check, downport/transpile, runtime (live from the abap2UI5 checkout)' + CUT,
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: pitfallsText('abap') }),
    sections: sliceCatalogue,
    rest: (k) => `pitfalls { area: "abap", offset: ${k} } pages the rest of this catalogue section by section`,
  },
  {
    resource: {
      uri: 'abap2ui5://pitfalls/view',
      name: 'pitfalls-view',
      description: 'ui5-check — the view defects a green CI does not catch: names the oldest supported release does not have, layout that only works from a newer release on, views that fail to load (live from the abap2UI5 checkout)' + CUT,
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: pitfallsText('view') }),
    sections: sliceCatalogue,
    rest: (k) => `pitfalls { area: "view", offset: ${k} } pages the rest of this catalogue section by section`,
  },
  /* The one resource that is not a document: the MCP Apps screen of the app
   * tools (lib/mcp-app.mjs), a ui:// resource a host renders as a sandboxed
   * iframe next to an app_start/app_describe/app_act result. Listed so a
   * host can review it at connection time (the spec allows leaving it out);
   * it reads no checkout, so it reads the same with every sibling missing. */
  {
    resource: {
      uri: APP_SCREEN_URI,
      name: 'app-screen',
      description: 'The interactive screen of the app tools (MCP Apps, text/html;profile=mcp-app): renders the agent snapshot of app_start/app_describe/app_act as fields, actions and tables the user can operate in the chat; what the user does goes back as app_act calls (self-contained HTML, no network)',
      mimeType: UI_MIME,
      _meta: APP_SCREEN_META,
    },
    read: readAppScreen,
  },
];

export const RESOURCES = CATALOG.map((c) => c.resource);
export const RESOURCE_URIS = RESOURCES.map((r) => r.uri).sort();

export const GUIDE_CHAPTER_TEMPLATE = 'abap2ui5://guide/{chapter}';
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: GUIDE_CHAPTER_TEMPLATE,
    name: 'app-building-guide-chapter',
    description: 'One chapter of the app-building guide, by number (abap2ui5://guide/5) or heading keyword (abap2ui5://guide/events) — the whole guide is abap2ui5://guide',
    mimeType: 'text/markdown',
  },
];

const ENTRIES = new Map(CATALOG.map((c) => [c.resource.uri, c]));

/*
 * The answer budget, for a resource read.
 *
 * A client caps what it shows of a resource the way it caps a tool result
 * (lib/budget.mjs), and a read over the cap is shown as nothing - the
 * pitfalls catalogue of abap-check is 105,000 characters whole, the
 * capability map 62,000. The tools page these documents; the resources hand
 * them over whole and had no guard at all. So a document past ANSWER_BUDGET
 * is cut the way a reader of THAT document can continue: at the last chapter
 * or section heading (`## `) that leaves at least half the budget, else at a
 * `### ` heading, else at a line end - never inside a line - and a note at
 * the end says how many characters were left out and which call reads on
 * (`rest`: the tool that pages the same document, with the offset of the
 * first section that was not shown, counted the way that tool counts them -
 * `sections` is the tool's own slicer). A JSON resource is shrunk as JSON
 * (fitObject: it still parses). The MCP Apps screen is exempt: it is HTML a
 * host renders, not text a model reads, and a cut page would not run.
 */
export const RESOURCE_CUT_NOTE = 'resource cut to fit the client size limit';

function cutPoint(text, budget) {
  const head = text.slice(0, budget);
  for (const re of [/\n## /g, /\n### /g]) {
    let at = -1;
    for (const m of head.matchAll(re)) at = m.index;
    if (at >= budget / 2) return at + 1;
  }
  const nl = head.lastIndexOf('\n');
  return nl > 0 ? nl + 1 : budget;
}

export function fitResourceText(text, { budget = ANSWER_BUDGET, mimeType = 'text/plain', sections = null, rest = () => '' } = {}) {
  if (typeof text !== 'string' || text.length <= budget) return text;
  if (mimeType === 'application/json') {
    try {
      return JSON.stringify(fitObject(JSON.parse(text), budget - 500), null, 2);
    } catch { /* not JSON after all - cut as text */ }
  }
  const room = budget - 400; // the note
  const at = cutPoint(text, room);
  const kept = text.slice(0, at);
  /* the first section NOT shown whole: the one the cut falls in (or starts
   * at), counted by the paging tool's own slicer over the whole text minus
   * the rest from that section's heading on */
  let k = 0;
  if (sections) {
    const from = text.lastIndexOf('\n## ', at - 1);
    const restText = from >= 0 ? text.slice(from + 1) : text;
    k = from >= 0 ? sections(text).length - sections(restText).length : 0;
  }
  const hint = rest(k);
  return `${kept}\n\n[${RESOURCE_CUT_NOTE}: ${text.length - at} of ${text.length} characters left out`
    + `${hint ? ` - ${hint}` : ''}]\n`;
}

/* One read, fitted: a document cut on a boundary its paging tool knows, a
 * JSON shrunk as JSON; the MCP Apps screen (no `rest`) passes untouched. */
function fitted(entry, { mimeType, text, _meta }) {
  if (!entry.rest) return { mimeType, text, _meta };
  return { mimeType, text: fitResourceText(text, { mimeType, sections: entry.sections || null, rest: entry.rest }), _meta };
}

/**
 * `resources/read` for one URI: `{ contents: [{ uri, mimeType, text }] }`,
 * the text within the answer budget (fitResourceText).
 * Throws on a missing checkout (the sibling message), a missing file in a
 * present checkout, a chapter that matches nothing, and a URI this server
 * never listed.
 */
export function readResource(uri) {
  const chapter = /^abap2ui5:\/\/guide\/(.+)$/.exec(uri);
  if (chapter) {
    let name;
    try {
      name = decodeURIComponent(chapter[1]);
    } catch {
      throw protocolError(INVALID_PARAMS, `malformed resource URI: ${uri} — the chapter is percent-encoded wrongly`);
    }
    const text = fitResourceText(guideChapterText(name), {
      mimeType: 'text/markdown',
      rest: () => `app_guide { section: ${JSON.stringify(name)} } answers the chapter as the tool serves it`,
    });
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  const entry = ENTRIES.get(uri);
  if (!entry) {
    throw protocolError(RESOURCE_NOT_FOUND, `unknown resource: ${uri} — resources/list names the ones this server serves`
      + ` (${RESOURCE_URIS.join(', ')}), plus the template ${GUIDE_CHAPTER_TEMPLATE}`);
  }
  const { mimeType, text, _meta } = fitted(entry, entry.read());
  return { contents: [{ uri, mimeType, text, ...(_meta ? { _meta } : {}) }] };
}

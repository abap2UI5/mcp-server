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
import { missingSiblingMessage } from './siblings.mjs';
import { readGuide, sliceGuide, guideChapters, guideFile, GUIDE_PATH } from './guide.mjs';
import { readApi, parseApi, apiSummary, apiFile, API_PATH } from './api.mjs';
import { readPitfalls, pitfallsFile, AREAS } from './pitfalls.mjs';

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

function guideChapterText(chapter) {
  const md = guideText();
  const sections = sliceGuide(md, { section: chapter });
  if (!sections.length) {
    throw new Error(`no guide chapter matches '${chapter}' — ask by number or heading keyword; the chapters are: `
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
  return fs.readFileSync(file, 'utf8');
}

function generationRulesText() {
  requireSibling('samples-controls');
  const file = path.join(resolveSamplesControls(), 'scripts', 'generation-prompt.txt');
  if (!fs.existsSync(file)) {
    throw new Error(`the samples-controls checkout has no scripts/generation-prompt.txt (looked in ${file}) — `
      + 'update it (git pull); the rulebook lives there');
  }
  return fs.readFileSync(file, 'utf8');
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

/* The API resource is the SUMMARY, not the 669-line interface: one line per
 * method/constant-group/type, the same table of contents the no-argument
 * api_reference call answers with. The full signatures stay behind the tool's
 * `query` — a resource picker that attaches the whole raw interface would
 * spend more context than the summary plus one query ever does. */
function apiText() {
  requireSibling('abap2UI5');
  const raw = readApi();
  if (raw === null) {
    throw new Error(`the abap2UI5 checkout has no ${API_PATH.join('/')} (looked in ${apiFile()}) — `
      + 'update it (git pull); the client API lives there');
  }
  return JSON.stringify(
    {
      source: 'abap2UI5/' + API_PATH.join('/'),
      about: 'z2ui5_if_client — the complete API an app may call on `client`; the api_reference tool answers `query` with full signatures',
      ...apiSummary(parseApi(raw)),
    },
    null,
    2,
  );
}

/* The static list `resources/list` serves — names and URIs only, no reads.
 * The `read` closures next to them are what `resources/read` runs; they are
 * kept out of the listed objects so the wire carries the MCP shape and
 * nothing else. */
const CATALOG = [
  {
    resource: {
      uri: 'abap2ui5://guide',
      name: 'app-building-guide',
      description: 'The abap2UI5 app-building guide, whole — the rulebook for writing a z2ui5_if_app class (live from the abap2UI5 checkout; the app_guide tool slices it by chapter and query)',
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: guideText() }),
  },
  {
    resource: {
      uri: 'abap2ui5://api',
      name: 'client-api-summary',
      description: 'The z2ui5_if_client API summary: every method, cs_* constant group and type, one line each (live-parsed from the abap2UI5 checkout; the api_reference tool answers queries with full signatures)',
      mimeType: 'application/json',
    },
    read: () => ({ mimeType: 'application/json', text: apiText() }),
  },
  {
    resource: {
      uri: 'abap2ui5://capabilities',
      name: 'capability-map',
      description: 'CAPABILITIES.md — the verified map of what abap2UI5 can express, every entry naming a proving port (live from the samples-controls checkout; the capabilities tool queries it)',
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: capabilitiesText() }),
  },
  {
    resource: {
      uri: 'abap2ui5://generation-rules',
      name: 'porting-rulebook',
      description: 'The rulebook for porting a UI5 demo-kit sample into samples-controls (live from that checkout; for building an app of your own, read abap2ui5://guide instead)',
      mimeType: 'text/plain',
    },
    read: () => ({ mimeType: 'text/plain', text: generationRulesText() }),
  },
  {
    resource: {
      uri: 'abap2ui5://pitfalls/abap',
      name: 'pitfalls-abap',
      description: 'abap-check — the ABAP defects a green CI does not catch: abapGit round trip and import, activation, extended check, downport/transpile, runtime (live from the abap2UI5 checkout)',
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: pitfallsText('abap') }),
  },
  {
    resource: {
      uri: 'abap2ui5://pitfalls/view',
      name: 'pitfalls-view',
      description: 'ui5-check — the view defects a green CI does not catch: names the oldest supported release does not have, layout that only works from a newer release on, views that fail to load (live from the abap2UI5 checkout)',
      mimeType: 'text/markdown',
    },
    read: () => ({ mimeType: 'text/markdown', text: pitfallsText('view') }),
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

const READERS = new Map(CATALOG.map((c) => [c.resource.uri, c.read]));

/**
 * `resources/read` for one URI: `{ contents: [{ uri, mimeType, text }] }`.
 * Throws on a missing checkout (the sibling message), a missing file in a
 * present checkout, a chapter that matches nothing, and a URI this server
 * never listed.
 */
export function readResource(uri) {
  const chapter = /^abap2ui5:\/\/guide\/(.+)$/.exec(uri);
  if (chapter) {
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: guideChapterText(decodeURIComponent(chapter[1])) }],
    };
  }
  const read = READERS.get(uri);
  if (!read) {
    throw new Error(`unknown resource: ${uri} — resources/list names the ones this server serves`
      + ` (${RESOURCE_URIS.join(', ')}), plus the template ${GUIDE_CHAPTER_TEMPLATE}`);
  }
  const { mimeType, text } = read();
  return { contents: [{ uri, mimeType, text }] };
}

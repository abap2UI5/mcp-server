/*
 * siblings — the one table of sibling checkouts and what to do when one is
 * missing.
 *
 * Every tool that reads a sibling checkout degrades to the same clear,
 * actionable error when the checkout is absent (instead of a TypeError from
 * path.join(null, ...)): which repo is missing, how to clone it, which env
 * var points at an existing checkout. This table used to live inside
 * server.mjs, which was fine while tools were the only consumers — MCP
 * resources read the same documents through the same resolution, and a second
 * hand-written copy of these hints is exactly the drift AGENTS.md warns
 * about. So the table is a module: server.mjs wraps the message in a tool
 * error, lib/resources.mjs throws it as a read error, and the words are the
 * same either way (test/missing-siblings.test.mjs pins both).
 */
import {
  resolveSamplesControls,
  resolveA2UI5,
  resolveViewCheck,
  resolveSamples,
  resolveAppTemplate,
  resolveDocs,
} from './repos.mjs';

export const SIBLING_REPOS = {
  'samples-controls': {
    resolve: resolveSamplesControls,
    hint: 'clone https://github.com/abap2UI5/samples-controls as a sibling of mcp-server, or point SAMPLES_CONTROLS_HOME at an existing checkout (AI_DEMOKIT_HOME, its former name, is still read)',
  },
  abap2UI5: {
    resolve: resolveA2UI5,
    hint: 'clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server (or run `npm run node:setup` in samples-controls), or point A2UI5_HOME at an existing checkout',
  },
  samples: {
    resolve: resolveSamples,
    hint: 'clone https://github.com/abap2UI5/samples as a sibling of mcp-server, or point SAMPLES_HOME at an existing checkout',
  },
  linter: {
    resolve: resolveViewCheck,
    hint: 'clone https://github.com/abap2UI5/linter as a sibling of mcp-server, or point AI_VIEW_CHECK_HOME at an existing checkout',
  },
  'app-template': {
    resolve: resolveAppTemplate,
    hint: 'clone https://github.com/abap2UI5/app-template as a sibling of mcp-server, or point APP_TEMPLATE_HOME at an existing checkout',
  },
  docs: {
    resolve: resolveDocs,
    hint: 'clone https://github.com/abap2UI5/docs as a sibling of mcp-server, or point DOCS_HOME at an existing checkout',
  },
};

/**
 * The first missing checkout among `repos`, as the actionable one-line
 * message — or null when every one of them resolves.
 */
export function missingSiblingMessage(...repos) {
  for (const name of repos) {
    const { resolve, hint } = SIBLING_REPOS[name];
    if (!resolve()) return `${name} checkout not found — ${hint}`;
  }
  return null;
}

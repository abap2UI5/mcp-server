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
 *
 * Two kinds of "missing" since the GitHub mirror (lib/remote.mjs) exists: a
 * READ tool is served by the mirror and only reports a checkout missing when
 * the mirror could not be fetched either (the message then says why); a tool
 * that WRITES into or BUILDS out of a checkout needs a local one, and answers
 * a mirror with the clone command rather than writing into a cache directory.
 */
import {
  resolveSamplesControls,
  resolveA2UI5,
  resolveViewCheck,
  resolveSamples,
  resolveAppTemplate,
  resolveDocs,
} from './repos.mjs';
import { isRemoteCheckout, remoteStatus } from './remote.mjs';

export const SIBLING_REPOS = {
  'samples-controls': {
    key: 'corpus',
    resolve: resolveSamplesControls,
    hint: 'clone https://github.com/abap2UI5/samples-controls as a sibling of mcp-server, or point SAMPLES_CONTROLS_HOME at an existing checkout (AI_DEMOKIT_HOME, its former name, is still read)',
  },
  abap2UI5: {
    key: 'a2ui5',
    resolve: resolveA2UI5,
    hint: 'clone https://github.com/abap2UI5/abap2UI5 as a sibling of mcp-server (or run `npm run node:setup` in samples-controls), or point A2UI5_HOME at an existing checkout',
  },
  samples: {
    key: 'samples',
    resolve: resolveSamples,
    hint: 'clone https://github.com/abap2UI5/samples as a sibling of mcp-server, or point SAMPLES_HOME at an existing checkout',
  },
  linter: {
    key: 'viewCheck',
    resolve: resolveViewCheck,
    hint: 'clone https://github.com/abap2UI5/linter as a sibling of mcp-server, or point AI_VIEW_CHECK_HOME at an existing checkout',
  },
  'app-template': {
    key: 'appTemplate',
    resolve: resolveAppTemplate,
    hint: 'clone https://github.com/abap2UI5/app-template as a sibling of mcp-server, or point APP_TEMPLATE_HOME at an existing checkout',
  },
  docs: {
    key: 'docs',
    resolve: resolveDocs,
    hint: 'clone https://github.com/abap2UI5/docs as a sibling of mcp-server, or point DOCS_HOME at an existing checkout',
  },
};

/**
 * The first missing checkout among `repos`, as the actionable one-line
 * message — or null when every one of them resolves (a mirror counts).
 */
export function missingSiblingMessage(...repos) {
  for (const name of repos) {
    const { key, resolve, hint } = SIBLING_REPOS[name];
    if (!resolve()) return `${name} checkout not found — ${hint}${remoteStatus(key)}`;
  }
  return null;
}

/**
 * The same, for a tool that writes or builds: a mirror is not enough, and
 * the message says which directory is the mirror and why it will not do.
 */
export function missingLocalSiblingMessage(...repos) {
  for (const name of repos) {
    const { resolve, hint } = SIBLING_REPOS[name];
    const dir = resolve();
    if (!dir) return `${name} checkout not found — ${hint}`;
    if (isRemoteCheckout(dir)) {
      return `${name} is only available here as the read-only GitHub mirror (${dir}), which serves the `
        + `knowledge tools but cannot be written into or built — this tool needs a real checkout: ${hint}`;
    }
  }
  return null;
}

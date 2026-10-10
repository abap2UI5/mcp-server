#!/usr/bin/env node
/*
 * abap2UI5 MCP server — the generate -> deploy -> run -> LOOK loop for AI
 * coding agents, without an SAP system.
 *
 * Speaks MCP over stdio. Register it in any MCP client, e.g. Claude Code:
 *
 *   claude mcp add abap2ui5 -- node mcp-server/server.mjs
 *
 * The tool surface lives in lib/tools.mjs — the TOOLS array is the one list
 * of what this server offers, and each entry's description is its whole
 * documentation. This header used to carry a hand-written copy of that list;
 * it drifted (a missing remove_app row), so now it points instead of copying.
 *
 * The intended agent loop: examples/app_guide -> write the class (scaffold_app
 * first, when the user wants a project of their own rather than a class;
 * add_agent_setup, when the project exists but has no agent setup yet) ->
 * validate_view + screenshot_view (seconds, no system) -> deploy_app ->
 * build_backend -> run_app -> read the errors, LOOK at the running app ->
 * edit -> repeat.
 *
 * There are two ways to SEE a view here and they cost three orders of magnitude
 * apart. screenshot_view photographs the RECONSTRUCTED view in the linter's
 * render harness: seconds, no backend, no transpile, and it is blind to
 * everything that only exists at runtime (data from a SELECT, what an event
 * does). run_app boots the REAL app against the transpiled backend, which
 * costs a build first. Reach for the cheap one while writing the view and the
 * expensive one to prove the app.
 *
 * With A2UI5_MCP_SYSTEM_URL set the server is the other half instead: the
 * app tools against a REAL SAP system (lib/system.mjs, SYSTEM_TOOLS in
 * lib/system-tools.mjs) - see handleSystem below.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { searchCapabilities, capabilitySummary } from './lib/capabilities.mjs';
import { searchExamples, exampleSummary, catalogueFiles, findExample } from './lib/examples.mjs';
import { searchPitfalls } from './lib/pitfalls.mjs';
import { readGuide, sliceGuide, guideChapters, guideFile, GUIDE_PATH } from './lib/guide.mjs';
import { readApiParsed, searchApi, apiSummary, apiFile, API_PATH } from './lib/api.mjs';
import { parseSizes, screenshotSource } from './lib/screenshot.mjs';
import { resolveSamplesControls, resolveAppTemplate, importViewCheck, SERVER_ROOT, workspaceRoot } from './lib/repos.mjs';
import { searchDocs, docsRoot } from './lib/docs.mjs';
import { scaffold, readSpec, validClassName, classNameRule, templateFiles, SPEC_FILE } from './lib/scaffold.mjs';
import { agentTargetProblem, planAgentSetup, writePlan, pinProblems, pinWarning, agentSetupNextSteps } from './lib/agent-setup.mjs';
import { fixSource } from './lib/fixview.mjs';
import { lintOptionsFor } from './lib/lintopts.mjs';
import { withRenderFallback, renderSkippedNote, warmThenCold, validateHint, bySeverity } from './lib/validate.mjs';
import { ANSWER_BUDGET, sizeOf, takeWithin, takeSmallestWithin, fitSnapshot, fitUnitResult, fitFindings, fitRules, fitObject, fitVerifyStages, guardAnswer, IMAGE_BUDGET } from './lib/budget.mjs';
import { getRenderer, dropRenderer, closeRenderers, rendererLooksDead, renderPages } from './lib/renderer.mjs';
import { TOOLS } from './lib/tools.mjs';
import { RESOURCES, RESOURCE_TEMPLATES, GUIDE_CHAPTER_TEMPLATE, readResource } from './lib/resources.mjs';
import { PROMPTS, getPrompt } from './lib/prompts.mjs';
import { missingSiblingMessage, missingLocalSiblingMessage } from './lib/siblings.mjs';
import { hydrate, REMOTE_TOOLS, resourceRepos, fetchRemoteFile, isRemoteCheckout, remoteBase, resolvedInside } from './lib/remote.mjs';
import { readInside } from './lib/contain.mjs';
import { resolveKey, RESOLVERS } from './lib/repos.mjs';
import { oneOf, boundedInt, stringArray, optionalName, checkStringArgs } from './lib/args.mjs';
import {
  deployApp,
  removeApp,
  readAppSource,
  listDevApps,
  lintApp,
  runScopeOf,
  scopeOfNote,
  buildBackend,
  buildLog,
  backendBuilt,
  backendStatus,
  startBackend,
  stopBackend,
  runApp,
  interactApp,
  runUnitTests,
  sandbox,
  setupStatus,
  killChildren,
  backendKind,
  npmModeProblem,
  npmPreferenceProblem,
  backendBaseUrl,
  backendGeneration,
  builtAppClasses,
  classNameOf,
} from './lib/runtime.mjs';
import { createAppClient, AgentError } from './lib/appclient.mjs';
import { toolsWithUi, uiEnabled } from './lib/mcp-app.mjs';
import { appCard, cardContent, defaultAppFormat, APP_FORMATS } from './lib/adaptive-card.mjs';
import { migrateReport, deployFiles, resolvePopups, validTargetClass, SetupError, KernelEscapeError } from './lib/migrate.mjs';
import { explicitEnv } from './lib/repos.mjs';
import { systemConfig, createSystemHttp, createSystemClient, systemClassName, searchClasses, checkSystem, maskedUrl } from './lib/system.mjs';
import { SYSTEM_TOOLS } from './lib/system-tools.mjs';

function text(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/* Every tool that reads a sibling checkout degrades to the same clear,
 * actionable error when the checkout is missing (instead of a TypeError from
 * path.join(null, ...)): which repo is absent, how to clone it, which env var
 * points at an existing checkout. The server itself always starts. The table
 * of repos and hints lives in lib/siblings.mjs, shared with the resource
 * reads, so both surfaces degrade with the same words. */
function missingSibling(...repos) {
  const msg = missingSiblingMessage(...repos);
  return msg ? toolError(msg) : null;
}

/* The same for a tool that WRITES into or BUILDS out of a checkout: the
 * read-only GitHub mirror (lib/remote.mjs) that serves the knowledge tools
 * is refused here, with the clone command, rather than written into. */
function missingLocalSibling(...repos) {
  const msg = missingLocalSiblingMessage(...repos);
  return msg ? toolError(msg) : null;
}

/* The backend a boot, a test run or `backend start` needs: a framework
 * checkout, or the npm backend - which needs no checkout at all and is the
 * default without one (lib/runtime.mjs backendKind). What is left to refuse
 * is an A2UI5_HOME that points nowhere (reported as the missing checkout it
 * names, never built around) and A2UI5_MCP_BACKEND=clone before the clone. */
function missingBackend() {
  const kind = backendKind();
  if (kind === 'checkout' || kind === 'npm') return null;
  const msg = missingLocalSiblingMessage('abap2UI5')
    || `no backend: ${kind === 'clone' ? 'the framework is not cloned yet' : 'A2UI5_HOME points at no checkout'}`;
  return toolError(msg + (kind === 'clone'
    ? ' - A2UI5_MCP_BACKEND=clone: run build_backend first, it clones the release (or unset it to run on @abap2ui5/node-runtime)'
    : ' - or unset it: without a checkout the backend runs on the npm package @abap2ui5/node-runtime'));
}

/* The dev sandbox - the corpus' src/zz_dev, the framework's node/zz_dev when
 * there is no corpus, the npm backend's workspace sandbox when there is no
 * framework checkout either (lib/runtime.mjs sandbox) - as a tool error when
 * none of them is there. */
function missingSandbox() {
  try {
    sandbox();
    return null;
  } catch (e) {
    return toolError(String(e.message));
  }
}

/* The mirror step: before a knowledge tool (or a resource read) runs, make
 * sure every repository it reads is there - a local checkout, or the mirror
 * fetched into the cache when nothing local resolves and nothing is
 * configured. Never throws: a failed download leaves the tool to degrade with
 * its usual message, which then also names the reason (lib/siblings.mjs). */
async function hydrateRepos(keys) {
  await Promise.all((keys || []).map((key) => hydrate(key, { local: resolveKey(key, { local: true }) })));
}

/* Throttled MCP progress from a long child's output: one
 * notifications/progress per second at most, carrying the latest line as the
 * message and the number of lines seen so far as the (open-ended) progress
 * counter. Only wired up when the client asked for progress by sending a
 * progressToken (the MCP contract); notification failures never fail the
 * build.
 *
 * The counter belongs to the REQUEST, not to the reporter: verify_app hands
 * its one ctx to every stage's handler, and each stage makes a reporter of
 * its own - with a counter per reporter the progress of one progressToken
 * went 1, 3 (the deploy lint), then 1 again (the build), and the spec says
 * the value MUST increase with each notification. */
const progressCounters = new WeakMap();
function progressReporter(ctx) {
  const { progressToken, sendNotification } = ctx;
  if (progressToken === undefined || progressToken === null || !sendNotification) return undefined;
  let state = progressCounters.get(ctx);
  if (!state) {
    state = { lines: 0, lastSent: 0 };
    progressCounters.set(ctx, state);
  }
  // `force` skips the throttle for the milestones a caller must not lose -
  // the start/end marks around a phase, which are the whole progress story
  // for a child that prints little (abaplint answers in one JSON blob)
  return (line, force = false) => {
    state.lines += 1;
    const now = Date.now();
    if (!force && now - state.lastSent < 1000) return;
    state.lastSent = now;
    Promise.resolve(
      sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: state.lines, message: String(line).slice(0, 300) },
      }),
    ).catch(() => {});
  };
}

/*
 * What the rules that fired actually MEAN, keyed by rule id.
 *
 * A finding is `{ type: 'binding-to-reference', message: <one terminal line> }`.
 * The message has to fit a terminal, so the paragraph explaining why the defect
 * matters and what the fix looks like lives elsewhere — until now, only on the
 * published rules page, i.e. behind a web fetch an agent has to make mid-task
 * and may not be able to make at all.
 *
 * Keyed by the DISTINCT ids rather than attached per finding: a run reports the
 * same rule many times over, and the explanation is a property of the rule.
 * Twelve findings of one type cost one paragraph, not twelve.
 *
 * `summary` (one line) always, `detail` only on request. That split is the
 * whole size argument: a first run on an unfamiliar class can hit a dozen
 * distinct rules, and a dozen paragraphs would crowd out the findings they are
 * about — while a dozen one-line summaries is the table of contents an agent
 * needs to decide which one it does not understand. `explain: true` then
 * returns the paragraphs.
 *
 * Degrades to nothing at all. The linter is resolved as an UNPINNED sibling
 * checkout, so `./rule-docs` may simply not be in an older one's exports map —
 * that must cost the agent an explanation, never the findings.
 */
async function explainRules(findings, withDetail) {
  const ids = [...new Set((findings || []).map((f) => f.type).filter(Boolean))];
  if (!ids.length) return null;
  let RULE_DOCS;
  try {
    ({ RULE_DOCS } = await importViewCheck('./rule-docs'));
  } catch {
    return null; // an older linter checkout: findings still stand on their own
  }
  const out = {};
  for (const id of ids) {
    const doc = RULE_DOCS && RULE_DOCS[id];
    if (!doc) continue; // a rule newer than this checkout's prose
    out[id] = withDetail
      ? { summary: doc.summary, detail: doc.detail, ...(doc.example ? { example: doc.example } : {}) }
      : { summary: doc.summary };
  }
  return Object.keys(out).length ? out : null;
}

/* fixable: true on every finding that carries mechanical fixes — the flag
 * that says fix_view can clear it. Feature-detected: an older linter without
 * the ./fix export costs the agent the flag and nothing else, never the
 * findings. */
async function flagFixable(findings) {
  let isFixable;
  try {
    ({ isFixable } = await importViewCheck('./fix'));
  } catch {
    return findings;
  }
  if (typeof isFixable !== 'function') return findings;
  return findings.map((f) => (isFixable(f) ? { ...f, fixable: true } : f));
}

/* The app_* tools' protocol client (lib/appclient.mjs): one per server, its
 * sessions in memory - app_describe answers from them without a roundtrip.
 * The linter's UI5 control snapshot, when a linter resolves, refines how an
 * unmapped control is classified; without one the snapshot's own table is
 * the whole knowledge (it never needs the linter). */
let appClient = null;
let uiMetadata;
async function loadUiMetadata() {
  if (uiMetadata === undefined) {
    try {
      const { loadSnapshot } = await importViewCheck('./properties');
      uiMetadata = typeof loadSnapshot === 'function' ? loadSnapshot() : null;
    } catch {
      uiMetadata = null;
    }
  }
}
async function agentClient() {
  await loadUiMetadata();
  if (!appClient) {
    appClient = createAppClient({ baseUrl: backendBaseUrl(), generation: backendGeneration, metadata: () => uiMetadata });
  }
  return appClient;
}

/* An image block's limits: the Claude API takes no side over 8000 px, and
 * the base64 of every picture in one answer stays under IMAGE_BUDGET. */
const MAX_IMAGE_EDGE = 8000;

/** A PNG's width and height from its IHDR chunk, or null. */
function pngSize(png) {
  const buf = png && (Buffer.isBuffer(png) ? png : Buffer.from(png));
  if (!buf || buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* A snapshot as the tool answer: compact JSON - the shape is the token
 * budget's friend, indentation is not. A refusal (AgentError) is an error
 * result naming what is allowed; anything else propagates to the handler's
 * catch like every other tool's failure. */
async function snapshotAnswer(run, { format = 'snapshot', client = null } = {}) {
  try {
    // fitted to one answer: a 120 KB TextArea or 200 wide rows went over the
    // client's cap by default, and the agent saw nothing
    const { snapshot: snap, notes } = fitSnapshot(await run());
    const answer = text(JSON.stringify(snap));
    if (notes.length) answer.content.push({ type: 'text', text: `cut to fit one answer: ${notes.join('; ')}` });
    /* format "adaptive-card": the same screen as an Adaptive Card 1.5, an
     * embedded resource after the unchanged snapshot (lib/adaptive-card.mjs).
     * A card that cannot be rendered costs the card, never the act: the
     * snapshot is the answer, and the reason is said beside it. */
    if (format === 'adaptive-card' && client && snap && snap.session) {
      try {
        const card = cardContent(appCard(client.screen(snap.session), snap.session, snap).card, snap.session);
        // the card goes into the same result as the snapshot: one over the
        // budget would cost the snapshot too
        const total = answer.content[0].text.length + card.resource.text.length;
        if (total > ANSWER_BUDGET) throw new Error(`the card would make the answer ${total} characters, more than a tool answer holds - the snapshot alone describes the screen`);
        answer.content.push(card);
      } catch (e) {
        answer.content.push({ type: 'text', text: `no Adaptive Card for this screen: ${(e && e.message) || e}` });
      }
    }
    return answer;
  } catch (e) {
    if (e instanceof AgentError) return toolError(e.message);
    throw e;
  }
}

/* The SYSTEM MODE (lib/system.mjs): with A2UI5_MCP_SYSTEM_URL set, this
 * server is the app tools against a real SAP system and nothing else -
 * SYSTEM_TOOLS instead of TOOLS, no prompts (both orchestrate the sandbox
 * loop). The sandbox tools stay with a second registration of the server
 * without the variable; the two never share a tool name inside one server.
 * Read once: a desktop client restarts the server to change it. */
const SYSTEM = systemConfig(process.env);
const ACTIVE_TOOLS = SYSTEM ? SYSTEM_TOOLS : TOOLS;

let systemHttp = null;
let systemClient = null;
async function systemSide() {
  await loadUiMetadata();
  if (!systemHttp) systemHttp = createSystemHttp(SYSTEM);
  if (!systemClient) systemClient = createSystemClient(SYSTEM, systemHttp, { metadata: () => uiMetadata });
  return { sys: systemHttp, client: systemClient };
}

/* The system mode's tools. The app tools answer through snapshotAnswer like
 * the sandbox's (the same snapshot, the same Adaptive Card); a refusal of
 * the configuration or of the breaker comes back before anything is sent. */
async function handleSystem(name, args = {}, { signal } = {}) {
  const { sys, client } = await systemSide();
  switch (name) {
    case 'system_status':
      return text(await checkSystem(SYSTEM, sys));
    case 'app_list': {
      const filter = String(args.filter || '').trim();
      let refs;
      try {
        await sys.ready();
        refs = await searchClasses(sys, SYSTEM.endpoint, filter);
      } catch (e) {
        if (e instanceof AgentError) return toolError(e.message);
        throw e;
      }
      return text({
        count: refs.length,
        apps: refs.map((r) => ({ app: r.name, source: 'system', ...(r.description ? { description: r.description } : {}), ...(r.packageName ? { package: r.packageName } : {}) })),
        hint: refs.length
          ? 'app_start { app } starts one and answers with its agent snapshot; the names come from a class-name search, '
            + 'so a class that is no abap2UI5 app is refused by app_start with the backend\'s error'
          : `no class on ${sys.host} matches '${filter || 'Z'}*'`,
      });
    }
    case 'app_start': {
      const cls = systemClassName(args.app);
      const format = oneOf(args.format, { name: 'format', allowed: APP_FORMATS, dflt: defaultAppFormat() });
      const maxRows = boundedInt(args.max_rows, { name: 'max_rows', dflt: 20, min: 0, max: 200 });
      return snapshotAnswer(async () => {
        await sys.ready();
        return client.start(cls, { values: args.values, maxRows, signal });
      }, { format, client });
    }
    case 'app_describe': {
      const maxRows = boundedInt(args.max_rows, { name: 'max_rows', dflt: undefined, min: 0, max: 200 });
      const format = oneOf(args.format, { name: 'format', allowed: APP_FORMATS, dflt: defaultAppFormat() });
      return snapshotAnswer(async () => client.describe(args.session, { maxRows }), { format, client });
    }
    case 'app_act': {
      const maxRows = boundedInt(args.max_rows, { name: 'max_rows', dflt: undefined, min: 0, max: 200 });
      const format = oneOf(args.format, { name: 'format', allowed: APP_FORMATS, dflt: defaultAppFormat() });
      return snapshotAnswer(async () => {
        /* a pending-only act sends nothing, so it needs no logon either */
        if (args.event !== undefined && args.event !== null && args.event !== '') await sys.ready();
        // `row` as given: the client checks it (as the sandbox's app_act does)
        return client.act(args.session, { values: args.values, event: args.event, args: args.args, row: args.row, maxRows, signal });
      }, { format, client });
    }
    default:
      return toolError(`unknown tool: ${name}${TOOLS.some((t) => t.name === name) ? ' - this server runs in system mode (A2UI5_MCP_SYSTEM_URL is set), '
        + 'which serves the app tools against the SAP system only; the sandbox tools are a second registration of the server without that variable' : ''}`);
  }
}

/* migrate_report { deploy: true }: the converted class, z2ui5_cl_cgui_* of the
 * checkout and the popups they call into the dev sandbox, then build_backend
 * and app_start - composed out of those tools' handlers, as verify_app is,
 * each stage reported; the first that fails stops it. */
async function deployMigrated(res, ctx) {
  if (!res.ok) return { ok: false, stoppedAt: 'deploy', stages: { deploy: { ok: false, text: 'the report was refused - there is no class to deploy' } } };
  const stages = {};
  const stage = (label, r) => {
    const t = r.content && r.content.find((c) => c.type === 'text');
    let parsed;
    try {
      parsed = t ? JSON.parse(t.text) : null;
    } catch {
      parsed = t ? { text: t.text } : null;
    }
    stages[label] = { ok: !r.isError, ...(parsed && typeof parsed === 'object' ? parsed : { text: parsed }) };
    return !r.isError;
  };
  /* the composed stages are each a tool's own (fitted) answer, but together
   * they can pass the budget - the build stage's tail, the app_start
   * snapshot, a deploy note - so the composed object is fitted once more
   * (lib/budget.mjs fitObject) */
  const stop = (at) => fitObject({ ok: !at, ...(at ? { stoppedAt: at } : {}), stages });
  const box = missingSandbox();
  if (box) return (stage('deploy', box), stop('deploy'));
  const popups = resolvePopups(res.converter);
  if (!popups) {
    stage('deploy', toolError('popups checkout not found - the report runtime calls abap2UI5-addons/popups: clone https://github.com/abap2UI5-addons/popups '
      + `into ${path.join(res.converter, '.deps', 'popups')} (as abap-cloud-gui's unit.yaml does) or beside it, or point POPUPS_HOME at a checkout`));
    return stop('deploy');
  }
  try {
    const dir = sandbox().dir;
    const { support } = deployFiles({ files: res.files, dir, cloudGui: res.converter, popups, classNameOf });
    stages.deploy = { ok: true, deployed: res.className, with: support, dir };
  } catch (e) {
    stage('deploy', toolError(String(e.message)));
    return stop('deploy');
  }
  const tables = res.release.filter((x) => x.kind === 'database table').map((x) => x.name);
  if (tables.length) {
    stages.deploy.note = `the local backend has no table ${tables.join(', ')}: the selection screen runs, a run that reads them fails - `
      + 'and a class typed with their fields may not start at all';
  }
  if (!stage('build', await handle('build_backend', { mode: 'auto' }, ctx))) return stop('build');
  if (!stage('start', await handle('app_start', { app: res.className }, ctx))) return stop('start');
  return stop(null);
}

/* The whole lines from `fromLine` (1-based) that fit one answer: `{ from,
 * to, page }`. Each line is measured as the answer writes it - JSON-escaped,
 * its line break a `\n` - not raw: a class of JSON string templates went
 * out ~35% over. At least one line, however long. */
function linePage(all, fromLine) {
  const asked = boundedInt(fromLine, { name: 'from_line', dflt: 1, min: 1 });
  const from = Math.min(asked, Math.max(1, all.length));
  const page = [];
  let used = 0;
  for (let i = from - 1; i < all.length; i += 1) {
    // the escaped line between its quotes, plus the two characters of `\n`
    const n = JSON.stringify(all[i]).length;
    if (page.length && used + n > ANSWER_BUDGET - 5000) break;
    page.push(all[i]);
    used += n;
  }
  /* a from_line past the end used to be clamped without a word: the last
   * line came back - usually the empty one after the final newline - and
   * read as an empty file */
  return {
    from,
    to: from + page.length - 1,
    page,
    ...(asked > all.length ? { pastEnd: `from_line ${asked} is past the end - the file has ${all.length} lines; its last line is shown` } : {}),
  };
}

/* One page of `items` for a tool that pages by `offset` and `limit` (no
 * limit: every match that fits), cut at the answer budget like examples and
 * pitfalls. `taken` is the page; `notes` the answer's paging fields - where
 * it starts, how many it carries, and the exact arguments that fetch the
 * rest (`more`, absent when nothing is left; `same` names the arguments to
 * repeat). */
function pageWithin(items, args, same) {
  const offset = boundedInt(args.offset, { name: 'offset', dflt: 0, min: 0 });
  const limit = boundedInt(args.limit, { name: 'limit', dflt: 'every match that fits one answer', min: 1 });
  const slice = items.slice(offset, typeof limit === 'number' ? offset + limit : undefined);
  // entries sit two levels deep: { entries: [ ... ] }, { methods: [ ... ] }
  const { taken } = takeWithin(slice, ANSWER_BUDGET - 5000, { depth: 2 });
  const next = offset + taken.length;
  return {
    taken,
    notes: {
      ...(offset ? { offset } : {}),
      returned: taken.length,
      ...(next < items.length ? { more: `${items.length - next} more - call again with offset: ${next} ${same}` } : {}),
    },
  };
}

async function handle(name, args = {}, ctx = {}) {
  switch (name) {
    case 'capabilities': {
      const miss = missingSibling('samples-controls');
      if (miss) return miss;
      if (!args.query && !args.status) {
        const s = capabilitySummary();
        return text({
          summary: s,
          hint: 'pass `query` (keywords) and/or `status` to get the matching entries; statuses: direct, workaround, needs-live-test, not-expressible',
        });
      }
      /* An unknown status used to filter every entry away and answer
       * "0 matches" - which reads as "nothing does that" rather than as
       * "that is not one of the four statuses". */
      const status = oneOf(args.status, {
        name: 'status',
        allowed: ['direct', 'workaround', 'needs-live-test', 'not-expressible'],
      });
      const hits = searchCapabilities({ query: args.query, status });
      /* Paged against the answer budget (lib/budget.mjs): a one-letter query
       * matched most of the map, ~61,000 characters. */
      const { taken, notes } = pageWithin(hits, args, '(same query and status)');
      return text({ matches: hits.length, ...notes, entries: taken });
    }
    case 'examples': {
      /* Not `missingSibling`: one catalogue out of three being absent is not a
       * reason to refuse the other two. What was searched and what was not is
       * reported instead, so a thin answer is never mistaken for "nobody has
       * built this". All three absent IS an error - there is nothing to say. */
      const { found, missing } = catalogueFiles();
      if (!found.length) {
        return toolError(
          'no sample catalogue found — clone at least one of them as a sibling of mcp-server:\n'
          + missing.map((m) => `  ${m.repo}: ${m.why}`).join('\n'),
        );
      }
      const searched = found.map((c) => c.repo + (isRemoteCheckout(c.root) ? ' (GitHub mirror)' : ''));
      const notSearched = missing.map((m) => `${m.repo}: ${m.why}`);
      /* Both filters are checked before anything is read: an unknown repo or
       * area filters every entry away, and the empty result that produces is
       * indistinguishable from "nobody has built this" - the one answer this
       * tool must never give by accident. */
      const repo = oneOf(args.repo, {
        name: 'repo', allowed: ['samples', 'samples-controls', 'samples-stack'],
      });
      const area = oneOf(args.area, {
        name: 'area', allowed: ['samples', 'experimental-or-test'],
      });
      if (!args.query && !area && !repo) {
        return text({
          summary: exampleSummary(),
          hint: 'pass `query` (keywords) to get matching apps; each entry names a class to READ in its repository',
        });
      }
      const limit = boundedInt(args.limit, { name: 'limit', dflt: 20, min: 1, max: 200 });
      const offset = boundedInt(args.offset, { name: 'offset', dflt: 0, min: 0 });
      const all = searchExamples({ query: args.query, area, repo, limit: Number.MAX_SAFE_INTEGER });
      /* Paged against the answer budget too (lib/budget.mjs): 200 entries
       * were ~135 KB, over what a client accepts as one answer. */
      const page = takeWithin(all.slice(offset, offset + limit), ANSWER_BUDGET - 5000, { depth: 2 });
      const nextOffset = offset + page.taken.length;
      /* A generic word matches most of a catalogue through the controls the
       * views build ("button": 424 matches, 135 of them only because the
       * view has a Button) - said, so `matches` is not read as that many
       * samples ABOUT the word. They are ranked after the others. */
      const byBuilds = all.filter((e) => e.builds).length;
      return text({
        matches: all.length,
        ...(offset ? { offset } : {}),
        returned: page.taken.length,
        ...(nextOffset < all.length ? { more: `${all.length - nextOffset} more - call again with offset: ${nextOffset}` } : {}),
        ...(byBuilds ? { foundByBuilds: `${byBuilds} of the ${all.length} matches needed a control their view builds to match (named under \`builds\`) - they come after the ${all.length - byBuilds} that match in the catalogues' own words; a sample that only builds a control is seldom about it` } : {}),
        searched,
        ...(notSearched.length ? { notSearched } : {}),
        repositories: Object.fromEntries(found.map((c) => [c.repo, c.url])),
        next: 'read the `path` of the closest match, in the repository its `repo` names — it is a complete, gated app, not a fragment',
        entries: page.taken,
      });
    }
    case 'read_example': {
      const KEY_OF = { samples: 'samples', 'samples-controls': 'corpus', 'samples-stack': 'samplesStack' };
      let repo = args.repo;
      let file = args.path;
      if (args.class) {
        await hydrateRepos(['samples', 'corpus', 'samplesStack']);
        const hit = findExample(args.class);
        if (!hit) {
          return toolError(`no sample class '${args.class}' in the catalogues that could be read`
            + ' — `examples` answers with the class names it knows; pass repo + path for a file the catalogues do not list');
        }
        repo = hit.repo;
        file = hit.path;
      }
      repo = oneOf(repo, { name: 'repo', allowed: Object.keys(KEY_OF) });
      if (!repo || !file) return toolError('pass `class` (a sample class name from `examples`), or `repo` and `path`');
      if (typeof file !== 'string' || !/^src\/[A-Za-z0-9_./-]+\.(abap|xml|json|md)$/.test(file) || file.includes('..')) {
        return toolError(`refusing path '${file}' — a sample lives under src/ of its repository (an .abap, .xml, .json or .md file), e.g. src/01/z2ui5_cl_smp_app_493.clas.abap`);
      }
      const key = KEY_OF[repo];
      await hydrateRepos([key]);
      const root = resolveKey(key);
      let at;
      let from;
      if (root && !isRemoteCheckout(root) && fs.existsSync(path.join(root, file))) {
        /* The path passed safeRelPath's string checks, but a checkout is
         * untrusted content - a sample repo can ship src/.../x.clas.abap as a
         * symbolic link to /etc/passwd or out of the tree, and reading through
         * it would hand the client a file the repository does not contain.
         * Refuse when the resolved path leaves the checkout (lib/remote.mjs). */
        if (!resolvedInside(root, path.join(root, file))) {
          return toolError(`refusing ${repo}/${file} — it resolves, through a symbolic link, outside the checkout at ${root}; `
            + 'read_example reads files a repository actually contains');
        }
        at = path.join(root, file);
        from = root;
      } else {
        try {
          at = await fetchRemoteFile(key, file);
          from = 'GitHub (read-only mirror)';
        } catch (e) {
          return toolError(`${repo}/${file} could not be read — ${String(e.message)}`
            + (root ? `; the checkout at ${root} does not have it either (git pull?)` : ''));
        }
      }
      /* Paged by whole lines, like read_app: samples-controls' largest
       * ports answered 84,000 characters, past what a client accepts as
       * one answer - and the agent then read none of it. */
      const all = fs.readFileSync(at, 'utf8').split('\n');
      const page = linePage(all, args.from_line);
      const paged = page.from > 1 || page.to < all.length;
      const pastEnd = page.pastEnd ? { pastEnd: page.pastEnd } : {};
      return text({
        repo,
        path: file,
        from,
        lines: all.length,
        ...(paged ? { page: { from_line: page.from, to_line: page.to }, ...(page.to < all.length ? { nextPage: { from_line: page.to + 1 } } : {}) } : {}),
        ...pastEnd,
        source: page.page.join('\n'),
        next: 'take the pattern, not the file: an app of your own keeps its own class name, package and events (app_guide chapter 2)',
      });
    }
    case 'app_guide': {
      // the guide is maintained beside the framework sources, not in the corpus
      const miss = missingSibling('abap2UI5');
      if (miss) return miss;
      const md = readGuide();
      if (md === null) {
        return toolError(`the abap2UI5 checkout has no ${GUIDE_PATH.join('/')} (looked in ${guideFile()}) — `
          + 'update it (git pull); the app-building guide lives there');
      }
      const chapters = guideChapters(md);
      const sections = sliceGuide(md, { section: args.section, query: args.query });
      if (!sections.length) {
        return text({
          matches: 0,
          chapters,
          hint: `nothing in the guide matches ${args.section ? `section '${args.section}'` : ''}`
            + `${args.section && args.query ? ' and ' : ''}${args.query ? `"${args.query}"` : ''}`
            + ' — the chapters are listed above, or call it without arguments to read the whole guide',
        });
      }
      /* Paged by CHAPTER, like pitfalls (lib/budget.mjs): the whole guide was
       * 48,000 characters as written and grows with every chapter upstream -
       * a few more and the default call, the one the description tells an
       * agent to make first, would answer past the client's cap and show
       * nothing. A chapter is never cut. */
      const { taken, notes } = pageWithin(sections, args, '(same section and query)');
      return text({
        source: 'abap2UI5/' + GUIDE_PATH.join('/'),
        about: 'building an app WITH abap2UI5 (for porting a demo-kit sample, call generation_rules)',
        chapters,
        matches: sections.length,
        ...notes,
        sections: taken,
        next: 'write the class, then validate_view + screenshot_view — both answer in seconds, before any build',
      });
    }
    case 'scaffold_app': {
      const miss = missingSibling('app-template');
      if (miss) return miss;

      /* Refused rather than passed through: the name is substituted into the
       * sidecar's CLSNAME and into file names, so anything path-like or not an
       * ABAP identifier has to stop here, not at the agent's `write`.
       *
       * Judged by the TEMPLATE's rule, not by one kept here. The template also
       * ships the abaplint config that has to accept the result, and it gates
       * the two against each other — so a name blessed there is a name the
       * scaffolded project's own CI will not reject. */
      const root = resolveAppTemplate();
      const cls = (args.class || '').toLowerCase();
      if (cls && !validClassName(cls, readSpec(root))) {
        const { rule, max } = classNameRule(readSpec(root));
        return toolError(`"${String(args.class).slice(0, 80)}" is not a class name this template accepts — it has to match `
          + `${rule} and stay within ${max} characters, e.g. zcl_my_app. `
          + 'abaplint\'s object_naming in the scaffolded project accepts ZCL_ and ZCX_ only, '
          + 'so a name outside this rule produces a repository that fails its own gate.');
      }

      const { files, missing, refused, spec, noSpec } = scaffold(root, {
        cls,
        packageText: args.package,
        repo: args.repo,
      });

      /* The template describes which files a project takes, in its own
       * `template.json`. Without it there is no list to serve — and guessing
       * one here is exactly the second copy this tool stopped keeping. */
      if (noSpec) {
        return toolError(`the app-template checkout at ${root} has no ${SPEC_FILE} — `
          + 'update it (git pull), or point APP_TEMPLATE_HOME at a current checkout');
      }
      if (missing.length === templateFiles(spec).length) {
        return toolError(`the app-template checkout at ${root} has none of the files this serves — `
          + 'update it (git pull), or point APP_TEMPLATE_HOME at a complete checkout');
      }

      /* Paged (lib/budget.mjs): the whole template is ~280 KB - AGENTS.md and
       * three skills are most of it - which is over what an MCP client
       * accepts as one answer, and a refused answer is no files at all. The
       * first page carries every file that fits, smallest first so the class,
       * its sidecar and the configs always come; `remaining` names the rest,
       * which `files` fetches (in order, page by page). */
      let pick = files;
      let page;
      if (args.files !== undefined && args.files !== null) {
        const wanted = stringArray(args.files, { name: 'files', maxItems: 200, maxLength: 300, example: '["AGENTS.md"]' });
        const unknown = wanted.filter((p) => !files.some((f) => f.path === p));
        if (unknown.length) {
          return toolError(`not a file of this scaffold: ${unknown.slice(0, 10).map((p) => p.slice(0, 80)).join(', ')}${unknown.length > 10 ? ` (+${unknown.length - 10} more)` : ''} — the paths are the ones this tool returns `
            + `(with the same class): ${files.map((f) => f.path).join(', ')}`);
        }
        pick = files.filter((f) => wanted.includes(f.path));
        page = takeWithin(pick, ANSWER_BUDGET - 5000);
      } else {
        page = takeSmallestWithin(files, ANSWER_BUDGET - 5000);
      }
      const rest = page.rest;
      return text({
        source: 'abap2UI5/app-template',
        class: cls || spec.placeholderClass,
        files: page.taken,
        ...(rest.length ? {
          remaining: rest.map((f) => ({ path: f.path, chars: f.text.length })),
          more: `${rest.length} more file(s) did not fit this answer - call scaffold_app again with the same class/package/repo `
            + `and files: ${JSON.stringify(rest.map((f) => f.path))} (each answer carries what fits and lists the rest again)`,
        } : {}),
        /* Reported, never silent: this list is a claim about another
         * repository, and a project quietly missing its CI workflow is not
         * noticed until somebody wonders why nothing is checked. */
        ...(missing.length ? { missing, warning: 'the template no longer has these — the project is incomplete without them' } : {}),
        ...(refused.length ? { refused, refusedWhy: 'template.json lists these, and each is not a plain path inside the template or resolves, through a symbolic link, outside it - never served' } : {}),
        next: 'write these files, then `npm install` and `npm run check` (abaplint + the abap2UI5-linter). '
          + 'The app class is a working starting point: read app_guide before changing it.',
      });
    }
    case 'add_agent_setup': {
      /* The template's agentSetup key, executed over the project the agent
       * names (lib/agent-setup.mjs). The template may be the read-only
       * mirror - it is only READ; what is written is the project, and only
       * after every file has been decided. */
      const miss = missingSibling('app-template');
      if (miss) return miss;
      const root = resolveAppTemplate();
      const mirror = isRemoteCheckout(root);
      const spec = readSpec(root);
      if (!spec) {
        return toolError(`the app-template checkout at ${root} has no ${SPEC_FILE} — `
          + 'update it (git pull), or point APP_TEMPLATE_HOME at a current checkout');
      }
      if (!spec.agentSetup?.files) {
        return toolError(`the app-template ${mirror ? 'mirror' : 'checkout'} at ${root} has a ${SPEC_FILE} without agentSetup — `
          + 'it predates the agent setup; update it (git pull), or point APP_TEMPLATE_HOME at a current checkout');
      }
      const defaulted = args.project_dir === undefined || args.project_dir === null || args.project_dir === '';
      const dir = path.resolve(defaulted ? process.cwd() : args.project_dir);
      const problem = agentTargetProblem(dir, {
        defaulted,
        forbidden: [
          { dir: SERVER_ROOT, what: 'inside this MCP server\'s own installation' },
          { dir: root, what: 'inside the app-template checkout this setup is read from' },
          { dir: remoteBase(), what: 'inside the GitHub mirror cache' },
          { dir: workspaceRoot(), what: 'inside this server\'s workspace (A2UI5_MCP_WORKSPACE)' },
        ],
      });
      if (problem) return toolError(problem);

      const read = async (rel) => {
        const at = path.join(root, rel);
        if (!fs.existsSync(at)) {
          throw new Error(`the app-template ${mirror ? 'mirror' : 'checkout'} at ${root} has no ${rel}, which its ${SPEC_FILE} lists — `
            + 'update it (git pull), or point APP_TEMPLATE_HOME at a complete checkout');
        }
        /* what is read here is written into the user's project: a template
         * file that is a link out of the checkout (~/.ssh/id_rsa as CLAUDE.md)
         * would be copied into it - refused (lib/contain.mjs) */
        return readInside(root, rel, undefined, 'the app-template checkout');
      };
      let plan;
      try {
        plan = await planAgentSetup(spec, read, dir);
      } catch (err) {
        return toolError(`${err.message} — nothing was written`);
      }
      const dryRun = args.dry_run === true;
      if (!dryRun) {
        try {
          writePlan(dir, plan.actions);
        } catch (err) {
          return toolError(`writing into ${dir} failed: ${err.message} — files before it may have been written; `
            + 'call add_agent_setup again once the cause is fixed (it never overwrites, so a second run only completes the first)');
        }
      }

      const warnings = [...plan.warnings];
      if (!dryRun && !mirror && spec.agentSetup.files['scripts/check-pin.mjs']) {
        const problems = await pinProblems(dir, root);
        if (problems.length) {
          // whose check:pin check.yml's first step runs: the template's, or one the project kept
          const checkPin = (file) => {
            try {
              return JSON.parse(fs.readFileSync(file, 'utf8')).scripts?.['check:pin'];
            } catch {
              return undefined;
            }
          };
          const owns = fs.existsSync(path.join(dir, 'package.json'))
            && checkPin(path.join(dir, 'package.json')) === checkPin(path.join(root, 'package.json'));
          warnings.push(pinWarning(problems, owns));
        }
      }
      const of = (kind) => plan.actions.filter((a) => a.kind === kind);
      const written = of('add').map((a) => ({ path: a.path, ...(a.detail ? { detail: a.detail } : {}) }));
      const merged = of('merge').map((a) => ({ path: a.path, detail: a.detail, added: a.added }));
      const skipped = of('skip').map((a) => ({ path: a.path, reason: a.detail }));
      const wroteAgents = plan.actions.some((a) => a.path === 'AGENTS.md' && a.kind === 'add');
      const changes = written.length + merged.length;
      return text({
        source: 'abap2UI5/app-template',
        template: mirror ? 'the GitHub mirror' : root,
        project: dir,
        dryRun,
        sources: { folder: `${plan.folder}/`, from: plan.from },
        summary: `${dryRun ? 'would write' : 'wrote'} ${written.length} new, ${dryRun ? 'would merge' : 'merged'} ${merged.length}, `
          + `skipped ${skipped.length}${changes ? '' : ' - the agent setup was already complete, nothing to do'}`,
        written,
        merged,
        skipped,
        warnings,
        next: dryRun
          ? ['call add_agent_setup again without dry_run to write this', ...agentSetupNextSteps({ folder: plan.folder, wroteAgents })]
          : agentSetupNextSteps({ folder: plan.folder, wroteAgents }),
      });
    }
    case 'api_reference': {
      // the client API is an interface in the framework sources
      const miss = missingSibling('abap2UI5');
      if (miss) return miss;
      const api = readApiParsed();
      if (api === null) {
        return toolError(`the abap2UI5 checkout has no ${API_PATH.join('/')} (looked in ${apiFile()}) — `
          + 'update it (git pull); the client API lives there');
      }
      /* the singular names the same filter - `kind: "method"` is what an
       * agent asking for one method types, and a refusal of it was a
       * roundtrip for nothing. Anything else stays strict (lib/args.mjs). */
      const SINGULAR = { method: 'methods', constant: 'constants', type: 'types' };
      const kind = oneOf(Object.hasOwn(SINGULAR, args.kind ?? '') ? SINGULAR[args.kind] : args.kind, {
        name: 'kind', allowed: ['methods', 'constants', 'types', 'all'], dflt: 'all',
      });
      const parsed = api.parsed;
      // empty groups are omitted rather than sent as [], so a narrowed answer
      // is exactly as wide as what it found
      const pick = (r) => ({
        ...(kind !== 'constants' && kind !== 'types' && r.methods.length ? { methods: r.methods } : {}),
        ...(kind !== 'methods' && kind !== 'types' && r.constants.length ? { constants: r.constants } : {}),
        ...(kind !== 'methods' && kind !== 'constants' && r.types.length ? { types: r.types } : {}),
      });
      /* Both lists page the same way, by ENTRY - a method, a constant group,
       * a type, in that order. The compact list ignored offset and limit and
       * answered the whole surface to a call that asked for its second page. */
      const paged = (found, same) => {
        const flat = ['methods', 'constants', 'types'].flatMap((group) => (found[group] || []).map((entry) => ({ group, entry })));
        const { taken, notes } = pageWithin(flat, args, same);
        const groups = {};
        for (const { group, entry } of taken) (groups[group] ||= []).push(entry);
        return { total: flat.length, notes, groups };
      };
      if (!args.query) {
        const { total, notes, groups } = paged(pick(apiSummary(parsed)), '(same kind, no query)');
        return text({
          source: 'abap2UI5/' + API_PATH.join('/'),
          about: 'z2ui5_if_client — the complete API an app may call on `client`',
          entries: total,
          ...notes,
          ...groups,
          hint: 'pass `query` (keywords) for the matching methods/constants/types in full — signature, defaults, documentation',
        });
      }
      const found = pick(searchApi(parsed, args.query));
      const total = (found.methods?.length || 0) + (found.constants?.length || 0) + (found.types?.length || 0);
      if (!total) {
        return text({
          matches: 0,
          hint: `nothing in z2ui5_if_client matches "${args.query}" — call without arguments for the compact list of every method and constant group`,
        });
      }
      /* Paged by ENTRY - a method, a constant group, a type, in that order -
       * against the answer budget: "e" matched almost the whole interface,
       * ~75,000 characters. An entry is never cut (a signature belongs with
       * its documentation). */
      const { notes, groups } = paged(found, '(same query and kind)');
      return text({ matches: total, ...notes, source: 'abap2UI5/' + API_PATH.join('/'), ...groups });
    }
    case 'generation_rules': {
      const miss = missingSibling('samples-controls');
      if (miss) return miss;
      const p = path.join(resolveSamplesControls(), 'scripts', 'generation-prompt.txt');
      // the checkout can be there and the file not: an older revision, a
      // half-finished pull, a rename upstream. Say which file and what to do,
      // the way `pitfalls` does - a raw ENOENT reaches the agent as a stack
      // trace it cannot act on.
      if (!fs.existsSync(p)) {
        return toolError(`the samples-controls checkout has no scripts/generation-prompt.txt (looked in ${p}) — `
          + 'update it (git pull); the rulebook lives there');
      }
      const rules = readInside(resolveSamplesControls(), ['scripts', 'generation-prompt.txt'], 'utf8', 'the samples-controls checkout');
      return text(
        rules +
          '\n\n---\nThis is the PORTING brief. Building an app of your own instead? Call `app_guide`.\n' +
          'More depth: AGENTS.md (conventions, gates), CAPABILITIES.md via the capabilities tool, ' +
          'and https://abap2ui5.github.io/docs/cookbook/index.html for the cookbook.',
      );
    }
    case 'docs_search': {
      const miss = missingSibling('docs');
      if (miss) return miss;
      if (!args.query) return toolError('pass `query` — keywords to search the documentation for, e.g. "value help" or "launchpad"');
      const limit = boundedInt(args.limit, { name: 'limit', dflt: 10, min: 1, max: 50 });
      const offset = boundedInt(args.offset, { name: 'offset', dflt: 0, min: 0 });
      /* Every hit, then the page: `matches` said how many were RETURNED - 10
       * for a query 37 pages answer - so a narrow answer read as the whole
       * site's, and nothing said where the rest was. */
      const all = searchDocs({ query: args.query, limit: Number.MAX_SAFE_INTEGER });
      // the checkout can be there and the tree not: a half-finished pull, a
      // layout change upstream. Name the directory, the way app_guide does.
      if (all === null || !fs.existsSync(docsRoot())) {
        return toolError(`the docs checkout has no docs/ page tree (looked in ${docsRoot()}) — `
          + 'update it (git pull); the site sources live there');
      }
      if (!all.length) {
        return text({
          matches: 0,
          hint: `no documentation page carries every term of "${args.query}" — fewer or broader terms widen the net; `
            + 'app_guide covers building an app, api_reference the client API',
        });
      }
      const entries = all.slice(offset, offset + limit);
      const next = offset + entries.length;
      return text({
        matches: all.length,
        ...(offset ? { offset } : {}),
        returned: entries.length,
        ...(next < all.length ? { more: `${all.length - next} more - call again with offset: ${next} (same query), or add terms` } : {}),
        entries,
        next: 'fetch the `markdown` URL of the best hit for the whole page — or read docs/<path>.md in the checkout',
      });
    }
    case 'pitfalls': {
      // the catalogues live in the abap2UI5 checkout, not in the corpus
      const miss = missingSibling('abap2UI5');
      if (miss) return miss;
      const area = oneOf(args.area, { name: 'area', allowed: ['abap', 'view', 'all'], dflt: 'all' });
      const found = searchPitfalls({ area, query: args.query });
      if (!found) {
        return toolError('the abap2UI5 checkout has no .claude/skills/{abap-check,ui5-check}/SKILL.md — '
          + 'update it (git pull); the catalogues live there');
      }
      const total = found.reduce((n, c) => n + c.sections.length, 0);
      if (args.query && !total) {
        return text({
          matches: 0,
          hint: `nothing in the ${area} catalogue matches "${args.query}" — `
            + 'call it without a query to read the whole thing (it is meant to be read once per task)',
        });
      }
      /* Paged by SECTION (lib/budget.mjs): both catalogues whole are ~120 KB,
       * over what a client accepts as one answer - and a section is the unit
       * that must not be cut (symptom, evidence and fix belong together).
       * `offset` counts sections across the catalogues, in order. */
      const offset = boundedInt(args.offset, { name: 'offset', dflt: 0, min: 0 });
      const flat = found.flatMap((c) => c.sections.map((sec) => ({ area: c.area, sec })));
      // a section sits four levels deep: { catalogues: [ { sections: [ ... ] } ] }
      const page = takeWithin(flat.slice(offset), ANSWER_BUDGET - 5000, { depth: 4 });
      const nextOffset = offset + page.taken.length;
      const catalogues = found
        .map((c) => ({ ...c, sections: page.taken.filter((x) => x.area === c.area).map((x) => x.sec) }))
        .filter((c) => c.sections.length);
      return text({
        matches: total,
        ...(offset ? { offset } : {}),
        returned: page.taken.length,
        ...(nextOffset < total ? { more: `${total - nextOffset} more section(s) - call again with offset: ${nextOffset} (same area and query)` } : {}),
        catalogues,
      });
    }
    case 'scope_of': {
      const miss = missingLocalSibling('samples-controls');
      if (miss) return miss;
      if (args.entities === undefined || args.entities === null) {
        return toolError('pass at least one entity, e.g. ["sap.m.Wizard"]');
      }
      /* Checked HERE because these entries become spawn argv (lib/args.mjs
       * explains the contract): a bare string passes a length check and then
       * shatters into one argument per character, a number throws inside
       * spawn as a TypeError nobody can act on. */
      const entities = stringArray(args.entities, { name: 'entities' });
      const { code, out } = await runScopeOf(entities, { signal: ctx.signal });
      const note = scopeOfNote(out);
      return text(`${out}\n\n(exit ${code}: 0 = all in scope, 1 = at least one out of scope or unresolved)${note ? `\n\n${note}` : ''}`);
    }
    case 'deploy_app': {
      const miss = missingSandbox();
      if (miss) return miss;
      const res = deployApp({
        className: args.class_name,
        source: args.abap_source,
        description: args.description,
        testclasses: args.testclasses,
      });
      const reply = { deployed: res.class, file: res.abapPath, ...(res.testclassesPath ? { testclasses: res.testclassesPath } : {}) };
      if (args.lint !== false) {
        /* Progress around the lint when the client asked for it: abaplint can
         * take a minute over the whole corpus and prints nothing until its
         * one JSON answer, so the forced start/end marks are the signal that
         * the call is alive; whatever lines it does print stream throttled in
         * between. */
        const report = progressReporter(ctx);
        const home = sandbox().kind;
        if (report) {
          report(`abaplint: linting ${res.class} with ${home === 'corpus' ? 'the corpus config' : 'app-template\'s config'}`
            + (home === 'npm' ? ' (the first lint on the npm backend installs @abap2ui5/node-runtime first)' : ''), true);
        }
        reply.lint = await lintApp(res.class, { signal: ctx.signal, onLine: report });
        if (report) report(`abaplint: finished (${reply.lint.ok ? 'clean' : `${reply.lint.issues.length} finding(s)`})`, true);
        if (reply.lint.aborted) {
          return toolError('deploy_app cancelled during the lint — the class was already written to the '
            + 'dev sandbox; deploy again to lint it, or remove_app to take it back out');
        }
        if (!reply.lint.ok) {
          reply.hint = 'fix the lint findings and deploy again; build_backend is only worth running on a clean lint';
        }
      }
      if (!reply.lint || reply.lint.ok) {
        reply.next = res.testclassesPath
          ? 'run build_backend once, then run_app to see the app and run_unit_tests to run its tests'
          : 'run build_backend once, then run_app to see the app';
      }
      return text(reply);
    }
    case 'read_app': {
      const miss = missingSandbox();
      if (miss) return miss;
      const res = readAppSource(args.class_name);
      if (!res.found) {
        return toolError(`no dev app '${res.class}' in the dev sandbox (looked for ${res.file}) — `
          + 'remove_app without arguments lists the deployed ones');
      }
      /* Paged by whole lines: a class of 1,500 lines (migrate_report
       * deploys them) answered 107,304 characters. Each line is measured
       * as the answer writes it - JSON-escaped, its line break a `\n` - not
       * raw: a class of JSON string templates went out ~35% over. */
      const all = res.source.split('\n');
      const { from, to, page, pastEnd } = linePage(all, args.from_line);
      const paged = from > 1 || to < all.length;
      return text({
        ...res,
        source: page.join('\n'),
        ...(paged ? { lines: { from, to, total: all.length }, ...(to < all.length ? { next: { from_line: to + 1 } } : {}) } : {}),
        ...(pastEnd ? { pastEnd } : {}),
        ...(res.staleInBackend
          ? { hint: 'deployed after the last build — run_app still boots the older code; run build_backend' }
          : {}),
      });
    }
    case 'validate_view': {
      const miss = missingSibling('linter');
      if (miss) return miss;
      if (!args.abap_source && !args.xml) return toolError('pass abap_source or xml');
      /* All through the linter's public surface (its package exports map):
       * checkFiles carries the render pool, the helper-method skip and the
       * render-error waivers; findings/config carry severity and project
       * config semantics. No internal file paths, no re-derived logic. */
      const lib = await importViewCheck('.');
      const { severityOf, severityRank, SEVERITIES } = await importViewCheck('./findings');
      const { opt, configFile } = await lintOptionsFor(args);

      /* Progress when the client asked for it: the linter's checkFiles emits
       * { phase, done, total } through onProgress. Feature-detected by
       * nothing at all - an older linter spreads options it does not know
       * into its defaults and ignores them, so this costs an old checkout
       * nothing and may not break it. */
      const report = progressReporter(ctx);
      if (report) opt.onProgress = (p) => report(`${p.phase} ${p.done}/${p.total}`);

      const check = async (options) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-validate-'));
        const file = path.join(dir, args.xml ? 'source.view.xml' : 'source.clas.abap');
        try {
          fs.writeFileSync(file, args.xml || args.abap_source);
          const [r] = await lib.checkFiles([file], options);
          return r;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      };
      /* Warm renderer where the linter supports one (lib/renderer.mjs): the
       * render gate's Chromium cold start dominates this call, and one warm
       * browser serves every call (concurrent ones queue on its page pool).
       * An older linter gets exactly the cold path it always had; a warm
       * browser that died mid-call is dropped and the call retried cold.
       * The pool's size is `renderPages` (A2UI5_MCP_RENDER_PAGES, default 2). */
      const GATE_POOL = { pages: renderPages() };
      const checkWithRender = async () => {
        const renderer = opt.render === false ? null : await getRenderer(GATE_POOL);
        if (!renderer) return check(opt);
        // whatever threw or died, a fresh one next call - and this call cold
        return warmThenCold({
          warm: () => check({ ...opt, renderer }),
          cold: () => check(opt),
          drop: () => dropRenderer(GATE_POOL, renderer),
          looksDead: (r) => rendererLooksDead(r.renderErrors),
        });
      };
      /* A render gate that cannot START (no @abap2ui5/linter-render, a
       * Chromium that will not launch) throws out of the linter; that throw
       * used to be the whole answer and cost the property findings with it.
       * Now the property gate's answer comes back with the reason in the
       * notes (lib/validate.mjs). */
      const { result, renderSkipped } = await withRenderFallback({
        render: opt.render,
        withRender: checkWithRender,
        withoutRender: () => check({ ...opt, render: false }),
      });
      if (renderSkipped) result.notes = [...(result.notes || []), renderSkippedNote(renderSkipped)];

      /* Every finding carries its severity, a ready-made message and (where
       * the gate could place it) line/column. ok follows the linter's failOn
       * threshold (project-configurable, default: errors AND warnings block).
       * A warning here means "not on the UI5 version you target" - and the
       * system the agent targets is the entire point of this gate, so it is
       * not advisory. Only hints are: nothing handling an event is a dead
       * control, unless the roundtrip alone was the intention. */
      const counts = { error: 0, warning: 0, hint: 0 };
      for (const f of result.findings) counts[severityOf(f)]++;
      counts[result.renderSeverity || 'error'] += result.renderErrors.length;
      const failOn = opt.failOn || 'warning';
      const ok = failOn === 'never' || SEVERITIES.slice(severityRank(failOn)).every((s) => counts[s] === 0);
      const explained = await explainRules(result.findings, args.explain === true);
      // additive: fixable: true per finding fix_view can clear (older linter
      // without ./fix: no flag, findings untouched)
      /* the counts stay whole; the findings are listed most severe first,
       * in source order within a severity (bySeverity), as many as fit one
       * answer (lib/budget.mjs fitFindings) - a cut list is the head of it */
      const rank = (f) => severityRank(severityOf(f));
      /* explain: true is a paragraph per rule (~1,000 characters each), and a
       * view that trips a dozen distinct rules carried them ALL - `rules`
       * alone could pass the budget. Capped to half of it, the rules the most
       * severe findings are about kept first (lib/budget.mjs fitRules); the
       * findings then get what is left. */
      const ruleOrder = [...new Set(bySeverity(result.findings, rank).map((f) => f.type).filter(Boolean))];
      const { rules, cut: rulesCut } = explained
        ? fitRules(explained, { budget: Math.floor((ANSWER_BUDGET - 10_000) / 2), order: ruleOrder })
        : { rules: null, cut: 0 };
      const room = Math.max(10_000, ANSWER_BUDGET - 10_000 - sizeOf(rules || {}, 1));
      const fitted = fitFindings(bySeverity(await flagFixable(result.findings), rank), { budget: room, rankOf: rank });
      const findings = fitted.findings;
      return text({
        ok,
        counts,
        findings,
        ...(fitted.cut ? { findingsCut: `${fitted.cut} more finding(s) did not fit one answer - the most severe are listed, counts has them all: fix these and validate again` } : {}),
        ...(rules ? { rules } : {}),
        ...(rulesCut ? { rulesCut: `${rulesCut} more rule explanation(s) left out to fit one answer - the kept ones are for the most severe findings; the rest are on the linter's rules page` } : {}),
        renderErrors: result.renderErrors,
        reconstructedDocs: result.docs.length,
        skippedRender: result.skippedRender ? `view parts in helper methods (${result.helperTokens} calls) — not statically reconstructable` : undefined,
        notes: result.notes,
        ...(renderSkipped ? { renderSkipped } : {}),
        config: configFile || undefined,
        hint: validateHint(counts, findings),
      });
    }
    case 'fix_view': {
      const miss = missingSibling('linter');
      if (miss) return miss;
      if (!args.abap_source && !args.xml) return toolError('pass abap_source or xml');
      const lib = await importViewCheck('.');
      /* ./fix is newer than the linter's other exports; a checkout without it
       * gets an actionable sentence and validate_view stays untouched. */
      let fixLib;
      try {
        fixLib = await importViewCheck('./fix');
      } catch {
        return toolError('this linter checkout is too old for fix_view — its package exports no ./fix '
          + '(applyFixes); update it (git pull). validate_view keeps working on this checkout.');
      }
      if (typeof fixLib.applyFixes !== 'function') {
        return toolError('this linter checkout is too old for fix_view — ./fix exports no applyFixes; '
          + 'update it (git pull). validate_view keeps working on this checkout.');
      }
      const { opt, configFile } = await lintOptionsFor(args, { forceNoRender: true });
      const res = await fixSource({
        checkFiles: lib.checkFiles,
        applyFixes: fixLib.applyFixes,
        abapSource: args.abap_source,
        xml: args.xml,
        opt,
      });
      /* the corrected source is the answer's point and goes whole; the
       * findings around it get what room is left (lib/budget.mjs) */
      const room = Math.max(10_000, ANSWER_BUDGET - 10_000 - sizeOf(res.source || ''));
      const fixedFit = fitFindings(res.fixed, { budget: Math.floor(room / 3) });
      const { severityOf: sevOf, severityRank: sevRank } = await importViewCheck('./findings');
      const rank = (f) => sevRank(sevOf(f));
      const remainingFit = fitFindings(bySeverity(await flagFixable(res.remaining), rank), { budget: room - Math.floor(room / 3), rankOf: rank });
      const remaining = remainingFit.findings;
      return text({
        applied: res.applied,
        fixed: fixedFit.findings,
        ...(fixedFit.cut ? { fixedCut: `${fixedFit.cut} more fix(es) applied - all of them are in \`source\`` } : {}),
        remaining,
        ...(remainingFit.cut ? { remainingCut: `${remainingFit.cut} more remaining finding(s) did not fit one answer - validate_view the corrected source for them` } : {}),
        config: configFile || undefined,
        source: res.source,
        note: res.applied
          ? 'nothing was written — the corrected source above is yours to place; the remaining findings need decisions a mechanical fix cannot make'
          : 'no finding carried a mechanical fix — the findings under `remaining` need decisions, not renames',
      });
    }
    case 'screenshot_view': {
      const miss = missingSibling('linter');
      if (miss) return miss;
      if (!args.abap_source && !args.xml) return toolError('pass abap_source or xml');
      /* The linter's own `--screenshot` runtime, through the package exports
       * map like every other call into it: same reconstruction the gate
       * clears, same render harness, same theme compilation. Nothing about
       * taking the picture is re-implemented here — this tool writes the
       * source to a file, because that is the shape screenshotFiles takes. */
      const lib = await importViewCheck('.');
      if (typeof lib.screenshotFiles !== 'function') {
        return toolError('this linter checkout has no screenshotFiles export — update it (git pull); '
          + '--screenshot shipped after 0.2.1');
      }
      let sizes;
      try {
        sizes = parseSizes(args.sizes);
      } catch (e) {
        return toolError(String(e.message));
      }
      const reportShot = progressReporter(ctx);
      const doShots = (renderer) => screenshotSource({
        screenshotFiles: lib.screenshotFiles,
        abapSource: args.abap_source,
        xml: args.xml,
        sizes,
        theme: args.theme,
        model: args.model,
        ...(renderer ? { renderer } : {}),
        ...(reportShot ? { onProgress: (p) => reportShot(`${p.phase} ${p.done}/${p.total}`) } : {}),
      });
      /* Warm renderer per THEME (theme and css are baked in at open time —
       * lib/renderer.mjs): the browser launch and UI5 boot cost more than
       * every picture in the call put together. Cold path untouched on an
       * older linter; a dead warm browser is dropped and the call retried
       * cold, so a crashed Chromium costs one relaunch, never a wrong or
       * empty answer. */
      const shotPool = { theme: args.theme || 'sap_horizon', css: true };
      const warmShot = await getRenderer(shotPool);
      let shots;
      if (warmShot) {
        try {
          shots = await doShots(warmShot);
        } catch {
          await dropRenderer(shotPool, warmShot);
          shots = await doShots(null);
        }
        if (shots && rendererLooksDead(shots.flatMap((s) => s.errors || []))) {
          await dropRenderer(shotPool, warmShot);
          shots = await doShots(null);
        }
      } else {
        shots = await doShots(null);
      }

      /* One entry per view per viewport. A class can build more than one
       * document (a view and its popup fragment), and `index`/`kind` are what
       * tell them apart - so the report names them rather than leaving the
       * agent to guess which of three images is the popup. */
      /* The pictures are full-page: one follows the content, not the
       * viewport - 400 Texts were a 1280x7200 image, eight 4096 viewports
       * 20 MB of answer. A picture past what the Claude API takes (8000 px a
       * side) or past the answer's image budget is left out and named. */
      let imageChars = 0;
      const attached = new Set();
      const leftOut = new Map();
      for (const s of shots) {
        if (!s.png) continue;
        const dim = pngSize(s.png);
        const chars = Math.ceil(s.png.length / 3) * 4;
        if (dim && (dim.width > MAX_IMAGE_EDGE || dim.height > MAX_IMAGE_EDGE)) {
          leftOut.set(s, `the picture is ${dim.width}x${dim.height} - more than ${MAX_IMAGE_EDGE} px a side; a shorter view or a smaller size fits`);
        } else if (imageChars + chars > IMAGE_BUDGET) {
          leftOut.set(s, 'left out to keep the answer within its image budget - ask for fewer sizes');
        } else {
          imageChars += chars;
          attached.add(s);
        }
      }
      const report = shots.map((s) => ({
        index: s.index,
        kind: s.kind,
        size: s.size ? `${s.size.width}x${s.size.height}` : undefined,
        photographed: Boolean(s.png),
        ...(s.png && pngSize(s.png) ? { picture: `${pngSize(s.png).width}x${pngSize(s.png).height}` } : {}),
        ...(leftOut.has(s) ? { notAttached: leftOut.get(s) } : {}),
        errors: s.errors && s.errors.length ? s.errors : undefined,
      }));
      const taken = shots.filter((s) => attached.has(s));
      const content = [{
        type: 'text',
        text: JSON.stringify({
          images: taken.length,
          views: report,
          note: taken.length
            ? 'the images below follow `views` in order; render errors do not suppress a picture — '
              + 'the half that rendered is still worth looking at'
            : undefined,
          hint: taken.length ? undefined
            : 'nothing could be photographed — a view built in helper methods is not statically '
              + 'reconstructable (run_app sees it, after a build)',
        }, null, 2),
      }];
      // the image blocks, the way run_app returns its screenshot
      for (const s of taken) content.push({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' });
      return { content, isError: !taken.length };
    }
    case 'build_backend': {
      /* Checked BEFORE the running backend is stopped and before a build is
       * started: an unrecognised mode used to fall through to the auto branch,
       * and a typo therefore cost a full build - tens of minutes - instead of
       * a sentence. */
      const mode = oneOf(args.mode, {
        name: 'mode', allowed: ['auto', 'npm', 'incremental', 'prebuilt', 'transpile', 'full'], dflt: 'auto',
      });
      /* Which checkout a build needs depends on the mode and on the backend
       * in use (lib/runtime.mjs backendKind): the npm backend needs none -
       * auto and incremental build on it whenever no framework checkout is
       * there; the full e2e-build is the corpus' script (and can bootstrap
       * the in-repo .abap2UI5 clone); prebuilt, transpile and incremental work
       * inside the abap2UI5 checkout, and prebuilt and transpile CLONE it when
       * nothing is there and nothing is configured - a set A2UI5_HOME that
       * points nowhere is reported instead. The build reports the rest (a
       * missing prior build, a failed download or install) in its tail. */
      const kind = backendKind();
      const a2 = resolveKey('a2ui5', { local: true });
      const onNpm = mode === 'npm' || ((mode === 'auto' || mode === 'incremental') && kind === 'npm');
      const cloneable = !a2 && !explicitEnv('a2ui5') && (mode === 'prebuilt' || mode === 'transpile' || (mode === 'auto' && kind === 'clone'));
      const needsCorpus = mode === 'full' || (mode === 'auto' && kind === 'missing');
      let miss = null;
      // refused before the running backend is stopped: a build nothing would serve
      const unserved = npmPreferenceProblem({ mode, a2 });
      if (unserved) miss = toolError(unserved);
      else if (needsCorpus) miss = missingLocalSibling('samples-controls');
      else if (onNpm) miss = npmModeProblem(kind) ? toolError(npmModeProblem(kind)) : null;
      else if (!cloneable) miss = missingLocalSibling('abap2UI5');
      if (miss) return miss;
      /* the running backend is stopped once the build really starts: a call
       * the in-flight build of another mode refuses leaves it running */
      const res = await buildBackend({ mode, onLine: progressReporter(ctx), signal: ctx.signal, beforeBuild: stopBackend });
      if (res.joined) return toolError(`build_backend cancelled by the client: ${res.tail}`);
      if (res.aborted) return toolError(`build cancelled by the client (mode ${res.mode || mode}):\n${res.tail}`);
      if (!res.ok) return toolError(`build failed (exit ${res.code}, mode ${res.mode || mode}):\n${res.tail}`);
      return text({
        built: true,
        mode: res.mode,
        ...(res.runtime ? { runtime: `@abap2ui5/node-runtime ${res.runtime}` } : {}),
        /* nothing changed since the last build: nothing was transpiled, the
         * running backend was not stopped, its app sessions still stand */
        ...(res.unchanged ? { unchanged: true } : {}),
        /* an explicit prebuilt/transpile builds the framework alone; auto
         * goes on into the dev apps' incremental build by itself */
        ...(res.devAppsNotBuilt ? { devAppsNotBuilt: res.devAppsNotBuilt } : {}),
        next: res.devAppsNotBuilt
          ? `the deployed dev app(s) ${res.devAppsNotBuilt.join(', ')} are not in this ${res.mode} build - build_backend (mode auto or incremental) transpiles them into it; then run_app { class_name }`
          : res.unchanged
            ? 'nothing changed since the last build - that build still stands and a running backend was left running; run_app { class_name } to boot and screenshot the app'
            : 'run_app { class_name } to boot and screenshot the app',
        tail: res.tail.split('\n').slice(-5).join('\n'),
      });
    }
    case 'verify_app': {
      /* Composed out of the single tools' handlers, so a stage answers
       * exactly what its tool answers and there is one implementation of
       * each. A stage's tool error is the stage's failure; the loop stops
       * there, and everything before it stays in the report. */
      const stages = {};
      const result = (label, r) => {
        const text = r.content && r.content.find((c) => c.type === 'text');
        let parsed;
        try {
          parsed = text ? JSON.parse(text.text) : null;
        } catch {
          parsed = text ? { text: text.text } : null;
        }
        stages[label] = { ok: !r.isError, ...(parsed && typeof parsed === 'object' ? parsed : { text: parsed }) };
        return !r.isError;
      };
      /* A stage that failed makes the CALL an error: the report used to come
       * back with isError false and `ok: false` inside, so a client (or an
       * agent) that goes by the protocol's flag saw a green verify_app. */
      /* each stage is fitted alone; together they are fitted again
       * (lib/budget.mjs fitVerifyStages) */
      const done = (stoppedAt, extra) => ({
        ...text({ ok: !stoppedAt, ...(stoppedAt ? { stoppedAt } : {}), stages: fitVerifyStages(stages), ...(extra || {}) }),
        ...(stoppedAt ? { isError: true } : {}),
      });
      // 1. validate - skipped, not failed, without a linter checkout
      if (missingSiblingMessage('linter')) {
        stages.validate = { skipped: missingSiblingMessage('linter') };
      } else {
        const v = await handle('validate_view', { abap_source: args.abap_source, render: args.render, project_dir: args.project_dir, explain: true }, ctx);
        const vok = result('validate', v);
        if (!vok || stages.validate.ok === false) return done('validate');
      }
      // 2. deploy (+ lint)
      const d = await handle('deploy_app', { class_name: args.class_name, abap_source: args.abap_source, testclasses: args.testclasses, description: args.description }, ctx);
      if (!result('deploy', d) || (stages.deploy.lint && stages.deploy.lint.ok === false)) return done('deploy');
      // 3. build
      const b = await handle('build_backend', { mode: 'auto' }, ctx);
      if (!result('build', b)) return done('build');
      // 4. unit, when there are tests
      if (typeof args.testclasses === 'string' && args.testclasses.trim()) {
        const u = await handle('run_unit_tests', { class_name: args.class_name }, ctx);
        if (!result('unit', u) || stages.unit.ok === false) return done('unit');
      } else {
        stages.unit = { skipped: 'no testclasses given' };
      }
      // 5. boot
      if (args.boot === false) {
        stages.boot = { skipped: 'boot: false' };
        return done(null);
      }
      const r = await handle('run_app', { class_name: args.class_name, timeout_ms: args.timeout_ms }, ctx);
      const rok = result('boot', r);
      const image = r.content && r.content.find((c) => c.type === 'image');
      const reply = done(rok && stages.boot.ok !== false ? null : 'boot');
      if (image) reply.content.push(image);
      return reply;
    }
    case 'setup_status': {
      // reads only: what resolves, what is built, what is missing and why
      return text(setupStatus());
    }
    case 'build_log': {
      // no sibling needed: this reads the record the last build left behind
      const log = buildLog({
        tail: boundedInt(args.tail, { name: 'tail', dflt: 100, min: 1, max: 2000 }),
        offset: args.offset === undefined || args.offset === null
          ? undefined
          : boundedInt(args.offset, { name: 'offset', dflt: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
      });
      if (!log) {
        return toolError('no build log yet — build_backend writes it when it runs (and a log from an '
          + 'earlier server would be read from the screenshot/tmp dir)');
      }
      return text(log);
    }
    case 'run_app': {
      // the backend - a framework checkout or the npm one; samples-controls,
      // when it is there, serves the local @openui5 modules (the CDN otherwise)
      const miss = missingBackend();
      if (miss) return miss;
      /* Bounded: the boot timeout is how long this call holds a browser and a
       * backend open, and a client that sends 0, a string or a day's worth of
       * milliseconds must not decide that. */
      const res = await runApp({
        className: args.class_name,
        timeoutMs: boundedInt(args.timeout_ms, { name: 'timeout_ms', dflt: 60000, min: 5000, max: 600000 }),
        signal: ctx.signal,
      });
      const report = {
        class: res.class,
        booted: res.booted,
        ok: res.ok,
        errors: res.errors,
        ...(res.errorsCut ? { errorsCut: res.errorsCut } : {}),
        // UI5 resources that did not load while the app booted (a theme, a library)
        ...(res.ui5 ? { ui5: res.ui5 } : {}),
        screenshot: res.screenshotPath,
        ...(res.screenshotNotSaved ? { screenshotNotSaved: res.screenshotNotSaved } : {}),
        ...(res.screenshotCut ? { screenshotCut: res.screenshotCut } : {}),
      };
      const content = [{ type: 'text', text: JSON.stringify(report, null, 2) }];
      if (res.base64) content.push({ type: 'image', data: res.base64, mimeType: 'image/png' });
      return { content, isError: !res.booted };
    }
    case 'interact_app': {
      const miss = missingBackend();
      if (miss) return miss;
      let res;
      try {
        res = await interactApp({
          className: args.class_name,
          actions: args.actions,
          timeoutMs: boundedInt(args.timeout_ms, { name: 'timeout_ms', dflt: 60000, min: 5000, max: 600000 }),
          actionTimeoutMs: boundedInt(args.action_timeout_ms, { name: 'action_timeout_ms', dflt: 10000, min: 500, max: 120000 }),
          signal: ctx.signal,
        });
      } catch (e) {
        return toolError(String((e && e.message) || e));
      }
      const report = {
        class: res.class,
        booted: res.booted,
        ok: res.ok,
        actions: res.actions,
        ...(res.notPerformed ? { notPerformed: res.notPerformed } : {}),
        errors: res.errors,
        ...(res.errorsCut ? { errorsCut: res.errorsCut } : {}),
        // UI5 resources that did not load while the app booted (a theme, a library)
        ...(res.ui5 ? { ui5: res.ui5 } : {}),
        screenshot: res.screenshotPath,
        ...(res.screenshotNotSaved ? { screenshotNotSaved: res.screenshotNotSaved } : {}),
        ...(res.screenshotCut ? { screenshotCut: res.screenshotCut } : {}),
        ...(res.booted ? {} : { hint: 'the app did not boot, so no action was performed - run_app shows the boot on its own' }),
      };
      const content = [{ type: 'text', text: JSON.stringify(report, null, 2) }];
      if (res.base64) content.push({ type: 'image', data: res.base64, mimeType: 'image/png' });
      return { content, isError: !res.booted };
    }
    case 'app_list': {
      const miss = missingBackend();
      if (miss) return miss;
      const apps = builtAppClasses();
      if (!apps) return toolError('backend not built — call build_backend first; app_list reads the transpiled output it makes');
      const want = String(args.filter || '').toUpperCase();
      const hits = want ? apps.filter((a) => a.app.includes(want)) : apps;
      return text({
        count: hits.length,
        apps: hits,
        ...(hits.length ? { hint: 'app_start { app } starts one and answers with its agent snapshot' } : { hint: want ? `no built app class contains '${args.filter}'` : 'nothing built that implements z2ui5_if_app - deploy_app, then build_backend' }),
      });
    }
    case 'app_start': {
      const miss = missingBackend();
      if (miss) return miss;
      const cls = classNameOf(args.app);
      const format = oneOf(args.format, { name: 'format', allowed: APP_FORMATS, dflt: defaultAppFormat() });
      if (!backendBuilt()) return toolError('backend not built — call build_backend first (then app_start; app_list names what the build carries)');
      const maxRows = boundedInt(args.max_rows, { name: 'max_rows', dflt: 20, min: 0, max: 200 });
      await startBackend();
      const client = await agentClient();
      return snapshotAnswer(() => client.start(cls, { values: args.values, maxRows, signal: ctx.signal }), { format, client });
    }
    case 'app_describe': {
      const maxRows = boundedInt(args.max_rows, { name: 'max_rows', dflt: undefined, min: 0, max: 200 });
      const format = oneOf(args.format, { name: 'format', allowed: APP_FORMATS, dflt: defaultAppFormat() });
      const client = await agentClient();
      return snapshotAnswer(async () => client.describe(args.session, { maxRows }), { format, client });
    }
    case 'app_act': {
      const maxRows = boundedInt(args.max_rows, { name: 'max_rows', dflt: undefined, min: 0, max: 200 });
      const format = oneOf(args.format, { name: 'format', allowed: APP_FORMATS, dflt: defaultAppFormat() });
      // the client checks `row` (a non-negative integer) - Number() here made
      // "", false and [] row 0 and true row 1
      const client = await agentClient();
      return snapshotAnswer(() => client.act(args.session, {
        values: args.values, event: args.event, args: args.args, row: args.row, maxRows, signal: ctx.signal,
      }), { format, client });
    }
    case 'run_unit_tests': {
      const miss = missingBackend();
      if (miss) return miss;
      const report = progressReporter(ctx);
      /* null is absent, as for every argument here (an empty list is refused
       * by stringArray); a blank class_name is refused rather than read as
       * "every test" - on a framework checkout that is minutes */
      const everything = 'to run every deployed app\'s tests (on a framework checkout: the whole transpiled tree, which takes minutes)';
      const className = optionalName(args.class_name, { name: 'class_name', absent: everything });
      const classNames = args.class_names === undefined || args.class_names === null ? undefined : stringArray(args.class_names, { name: 'class_names', example: '["zcl_my_app", "zcl_my_other_app"]' });
      const ran = await runUnitTests({ className, classNames, signal: ctx.signal, onLine: report });
      if (ran.aborted || ran.timedOut) return toolError(ran.error);
      /* Past the budget the tests are counted per object (lib/budget.mjs) -
       * measured as text() writes the answer, indented: the compact size it
       * was measured by let a 600-test class through at 68,000 characters. */
      const res = fitUnitResult(ran);
      /* No test line at all is "no test class" only for a run that passed: a
       * class_setup that threw prints none either, and that hint sent an
       * agent to redeploy tests that were there all along. A run counted
       * per object has tests - and no `tests` array to read (it threw). */
      if (res.class && res.ok && Array.isArray(res.tests) && res.tests.length === 0) {
        return text({
          ...res,
          hint: `no test class of ${res.class} in the built backend — deploy_app with \`testclasses\`, then build_backend (a deploy after the last build is not in it yet: read_app says so)`,
        });
      }
      return text({
        ...res,
        ...(res.ok ? {} : {
          hint: res.failed
            ? (res.failed.fixture
              ? `${res.failed.object}'s test class failed in its ${res.failed.method}, before the test method it prepares ran - that stops the runner too; fix it, deploy, build, run again`
              : 'the first failing test stops the runner; fix it, deploy, build, run again')
            : 'the runner failed before or outside a test - the error is what it printed',
        }),
      });
    }
    case 'backend': {
      /* An unknown action used to fall through to `status`, so a misspelled
       * `stop` answered with a report that the backend is running - which is
       * true, and not what was asked for. */
      const action = oneOf(args.action, {
        name: 'action', allowed: ['status', 'start', 'stop', 'restart'], dflt: 'status',
      });
      if (action === 'start' || action === 'restart') {
        // status/stop work without any checkout; starting needs the backend
        const miss = missingBackend();
        if (miss) return miss;
      }
      if (action === 'start') return text(await startBackend());
      if (action === 'stop') return text(await stopBackend());
      if (action === 'restart') {
        await stopBackend();
        return text(await startBackend());
      }
      return text(backendStatus());
    }
    case 'migrate_report': {
      if (typeof args.source !== 'string' || !args.source.trim()) return toolError('source is required: the text of the report, as in <report>.prog.abap');
      /* report2cloud runs in-process from the abap-cloud-gui checkout - with
       * that checkout's node_modules, so a local one with npm ci done; there
       * is no mirror of it (lib/migrate.mjs). */
      const miss = missingLocalSibling('abap-cloud-gui');
      if (miss) return miss;
      if (args.class_name !== undefined && args.class_name !== null && !validTargetClass(args.class_name)) {
        return toolError(`class_name '${String(args.class_name).slice(0, 80)}' is no ABAP class name - letters, digits, _ and /, at most 30 characters, e.g. zcl_flights`);
      }
      let res;
      try {
        res = await migrateReport({ source: args.source, textsXml: args.texts_xml, className: args.class_name || undefined, partial: args.partial === true });
      } catch (e) {
        if (e instanceof SetupError || e instanceof KernelEscapeError) return toolError(e.message);
        throw e;
      }
      const reply = {
        ok: res.ok,
        class_name: res.className,
        program: res.program,
        files: res.ok ? res.files : (res.draft || {}),
        ...(res.ok ? {} : { files_are: res.draft ? 'the draft (partial): refused statements are marked, it does not compile as it is' : 'none - the report was refused; pass partial: true for the draft' }),
        refusals: res.refusals,
        ...(res.warnings.length ? { warnings: res.warnings } : {}),
        todos: res.todos.length,
        release: res.release.map((x) => `${x.kind} ${x.name}${x.successor ? ` (successor: ${x.successor})` : ''}`),
        migration_report: res.report,
        next: res.ok
          ? 'save the files (abapGit format) next to z2ui5_cl_cgui_report, then work the migration report: replace the unreleased objects, settle the TODOs - deploy: true runs it here first'
          : 'every refusal is a place the report does something a browser app does not do - rewrite those statements in the report (or decide on a design) and convert again',
      };
      // a big report is a big class: the mapped table goes first, never the class
      // (measured as text() writes it - indented, the size the client sees)
      if (sizeOf(reply) > ANSWER_BUDGET) {
        const cut = reply.migration_report.indexOf('\n## Mapped');
        if (cut > 0) reply.migration_report = `${reply.migration_report.slice(0, cut)}\n\n## Mapped\n\n(left out - the answer would pass the client's size limit; convert with the report2cloud CLI for the full table)\n`;
      }
      if (args.deploy === true) reply.deploy = await deployMigrated(res, ctx);
      /* then the files: a report of 2,000 lines converted to 212,028
       * characters of them - named with their size, never cut mid-file */
      if (sizeOf(reply) > ANSWER_BUDGET && reply.files && typeof reply.files === 'object') {
        reply.files = Object.fromEntries(Object.entries(reply.files).map(([k, v]) => [k, `(${String(v).length} characters - left out)`]));
        reply.files_left_out = 'the files would pass the client\'s size limit - deploy: true writes them to the dev sandbox, read_app reads them back page by page';
      }
      return text(reply);
    }
    case 'remove_app': {
      const miss = missingSandbox();
      if (miss) return miss;
      if (!args.class_name) return text({ devApps: listDevApps() });
      const removed = removeApp(args.class_name);
      return text({ removed, note: removed ? 'run build_backend to update the served backend' : 'no such dev app' });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

// the served version IS the package version — no hand-maintained copy to drift
const PKG = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));

const server = new Server(
  { name: 'abap2ui5', version: PKG.version },
  /* logging: diagnostics travel as notifications/message once the transport
   * is up (declaring the capability also gives the SDK's logging/setLevel
   * handler something to filter by); completions: the guide-chapter resource
   * template completes its {chapter} argument. */
  { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {}, completions: {} } },
);

/* One diagnostic channel. Through the MCP logging notification when the
 * transport is connected — that is where a client actually shows it — and to
 * stderr before the connect and whenever sending fails (stdout is the
 * JSON-RPC channel; a stack trace in it is a protocol error on top of the
 * original one). */
function diagnostic(level, message) {
  if (server.transport) {
    server.sendLoggingMessage({ level, logger: 'abap2ui5', data: message }).catch(() => console.error(message));
  } else {
    console.error(message);
  }
}

/* The app tools name the MCP Apps screen (ui://abap2ui5/app-screen,
 * lib/mcp-app.mjs) when the client advertised the extension in its
 * initialize - or always/never, by A2UI5_MCP_UI. The TOOLS array stays the
 * one source; only the metadata is added here. */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolsWithUi(ACTIVE_TOOLS, uiEnabled(server.getClientCapabilities())),
}));

/* The knowledge documents, as resources (lib/resources.mjs): listing is free
 * (names and URIs, no file touched), reading resolves the sibling live and
 * throws the same missing-checkout message the tools return — the client sees
 * it as the read request's JSON-RPC error. A read is fitted to the answer
 * budget inside readResource (fitResourceText), the resources' counterpart
 * of guardAnswer. */
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  await hydrateRepos(resourceRepos(req.params.uri));
  return readResource(req.params.uri);
});

/* The two workflow prompts (lib/prompts.mjs): orchestration scripts over the
 * existing tools — build-an-abap2ui5-app and port-a-ui5-sample. They read no
 * sibling checkout; the tools they send the agent to do. */
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: SYSTEM ? [] : PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (SYSTEM) throw new Error('no prompts in system mode - both orchestrate the sandbox loop, which a registration without A2UI5_MCP_SYSTEM_URL serves');
  return getPrompt(req.params.name, req.params.arguments || {});
});

/* Completion for the one resource template: abap2ui5://guide/{chapter}. The
 * chapters are the guide's own `## ` headings (guideChapters), read live like
 * every other document. Advisory by contract, so it never errors the way a
 * read does: no checkout, no guide, an unknown ref or argument all answer an
 * EMPTY list — the client is typing ahead, not reading. */
server.setRequestHandler(CompleteRequestSchema, async (req) => {
  const empty = { completion: { values: [], total: 0, hasMore: false } };
  const { ref, argument } = req.params;
  if (!ref || ref.type !== 'ref/resource' || ref.uri !== GUIDE_CHAPTER_TEMPLATE) return empty;
  if (!argument || argument.name !== 'chapter') return empty;
  await hydrateRepos(['a2ui5']);
  const md = readGuide();
  if (md === null) return empty;
  const want = String(argument.value || '').toLowerCase();
  const values = guideChapters(md)
    .filter((c) => c.toLowerCase().includes(want))
    .slice(0, 100); // the protocol's ceiling per answer
  return { completion: { values, total: values.length, hasMore: false } };
});
/* Every tool call, answered: the arguments checked, the call dispatched to
 * the system mode's handlers or the sandbox's, and a throw turned into the
 * tool error it is. Never registered on its own - answerToolCall below is. */
async function dispatchToolCall(req, extra) {
  try {
    checkStringArgs(ACTIVE_TOOLS.find((t) => t.name === req.params.name), req.params.arguments || {});
    if (SYSTEM) return await handleSystem(req.params.name, req.params.arguments || {}, { signal: extra && extra.signal });
    await hydrateRepos(REMOTE_TOOLS[req.params.name]);
    return await handle(req.params.name, req.params.arguments || {}, {
      progressToken: req.params._meta && req.params._meta.progressToken,
      sendNotification: extra && extra.sendNotification,
      /* The SDK aborts this when the client sends notifications/cancelled for
       * the request. The long-running tools hand it to spawnWithTimeout,
       * which kills the child's whole process tree - a cancelled build must
       * not keep transpiling under a request nobody is waiting for. */
      signal: extra && extra.signal,
    });
  } catch (e) {
    return toolError(String((e && e.message) || e));
  }
}

/* THE one place a tool result leaves this server - and so the one place
 * guardAnswer (lib/budget.mjs), the last-line backstop, is applied: every
 * tool fits its own answer, but a composed or unbounded one can still add up
 * past the client's cap, and an over-cap answer shows the agent nothing. It
 * wraps the dispatch whole, the error path of a throw included (an Error
 * whose message carries a build's output is as long as that output).
 * test/answer-guard.test.mjs fails when a second handler for tools/call
 * appears or a result reaches the client without passing it. */
const answerToolCall = async (req, extra) => guardAnswer(await dispatchToolCall(req, extra));
server.setRequestHandler(CallToolRequestSchema, answerToolCall);

/* A throw nobody caught costs ONE call, not the session.
 *
 * Every tool call is already wrapped (CallToolRequestSchema above), but not
 * every throw happens inside one: a Playwright page listener, a stream 'error'
 * after the call that started it has resolved, a rejected promise nothing
 * awaited. Without these handlers Node's default is to print the stack and
 * exit, which takes down the stdio server - and with it the agent's whole
 * session, its built backend and its browser - over a failure in one app's
 * page. Logged and survived instead.
 *
 * stderr, never stdout: stdout IS the JSON-RPC channel here, and a stack trace
 * written into it is a protocol error on top of the original one. */
function logCrash(kind, err) {
  const detail = (err && err.stack) || String(err);
  diagnostic('error', `abap2ui5 MCP server: ${kind} (the server stays up)\n${detail}`);
}
process.on('unhandledRejection', (reason) => logCrash('unhandled rejection', reason));
process.on('uncaughtException', (err) => logCrash('uncaught exception', err));

/* The server lives exactly as long as its client.
 *
 * It used to stop only on SIGINT/SIGTERM, and a client that goes away does
 * not necessarily send either: an MCP client ends a stdio session by closing
 * the pipe, and under `npx` a SIGTERM reaches npm (or the sh wrapper), not
 * this process. So the server kept running with nobody on the other end -
 * node, the warm Chromium, run_app's browser and the express backend - and
 * the next session's `backend start` found the old backend still holding the
 * port. An ended or closed stdin now shuts down the same way the signals do
 * (SIGHUP too, a closed terminal): warm renderers and browsers closed, the
 * backend stopped, every build/lint child's process tree killed. Single-shot,
 * and bounded - a close that hangs must not keep an orphan alive either. */
let shuttingDown = null;
function shutdown(reason) {
  if (shuttingDown) return shuttingDown;
  const hardStop = setTimeout(() => process.exit(0), 5000);
  shuttingDown = (async () => {
    try {
      killChildren();
      await Promise.all([stopBackend().catch(() => {}), closeRenderers().catch(() => {})]);
    } catch (e) {
      console.error(`abap2ui5 MCP server: shutdown (${reason}) - ${(e && e.message) || e}`);
    }
    clearTimeout(hardStop);
    process.exit(0);
  })();
  return shuttingDown;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.stdin.on('end', () => shutdown('stdin ended'));
process.stdin.on('close', () => shutdown('stdin closed'));
/* The other half of the pipe: a client whose reading end is gone (EPIPE) can
 * never receive an answer again. Without a listener the write error was an
 * uncaught exception, logCrash wrote its report as a logging notification
 * into the same broken stdout, and that write failed again - a loop that
 * held a core at 90% and piled up 'drain' listeners for as long as stdin
 * stayed open. */
process.stdout.on('error', () => shutdown('stdout closed'));

const transport = new StdioServerTransport();
await server.connect(transport);
if (SYSTEM) {
  diagnostic(SYSTEM.problems.length ? 'warning' : 'info', `abap2ui5 MCP server ready in SYSTEM MODE (${SYSTEM.endpoint || maskedUrl(SYSTEM.url)}, user ${SYSTEM.user || '-'})`
    + (SYSTEM.problems.length ? ` - misconfigured: ${SYSTEM.problems.join('; ')}` : ''));
} else diagnostic('info', `abap2ui5 MCP server ready (samples-controls: ${resolveSamplesControls({ local: true })}, backend built: ${backendBuilt()}, `
  + `GitHub mirror for missing checkouts: ${Object.keys(RESOLVERS).some((k) => !resolveKey(k, { local: true })) ? 'on demand' : 'not needed'})`);

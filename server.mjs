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
 * first, when the user wants a project of their own rather than a class) ->
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
import { searchExamples, exampleSummary, catalogueFiles } from './lib/examples.mjs';
import { searchPitfalls } from './lib/pitfalls.mjs';
import { readGuide, sliceGuide, guideChapters, guideFile, GUIDE_PATH } from './lib/guide.mjs';
import { readApiParsed, searchApi, apiSummary, apiFile, API_PATH } from './lib/api.mjs';
import { parseSizes, screenshotSource } from './lib/screenshot.mjs';
import { resolveSamplesControls, resolveAppTemplate, importViewCheck, resolveLintConfig, SERVER_ROOT } from './lib/repos.mjs';
import { searchDocs, docsRoot } from './lib/docs.mjs';
import { scaffold, readSpec, validClassName, classNameRule, templateFiles, SPEC_FILE } from './lib/scaffold.mjs';
import { fixSource } from './lib/fixview.mjs';
import { getRenderer, dropRenderer, closeRenderers, rendererLooksDead } from './lib/renderer.mjs';
import { TOOLS } from './lib/tools.mjs';
import { RESOURCES, RESOURCE_TEMPLATES, GUIDE_CHAPTER_TEMPLATE, readResource } from './lib/resources.mjs';
import { PROMPTS, getPrompt } from './lib/prompts.mjs';
import { missingSiblingMessage } from './lib/siblings.mjs';
import { oneOf, boundedInt, stringArray } from './lib/args.mjs';
import {
  deployApp,
  removeApp,
  readAppSource,
  listDevApps,
  lintApp,
  runScopeOf,
  buildBackend,
  buildLog,
  backendBuilt,
  backendStatus,
  startBackend,
  stopBackend,
  runApp,
} from './lib/runtime.mjs';

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

/* Throttled MCP progress from a long child's output: one
 * notifications/progress per second at most, carrying the latest line as the
 * message and the number of lines seen so far as the (open-ended) progress
 * counter. Only wired up when the client asked for progress by sending a
 * progressToken (the MCP contract); notification failures never fail the
 * build. */
function progressReporter({ progressToken, sendNotification }) {
  if (progressToken === undefined || progressToken === null || !sendNotification) return undefined;
  let lines = 0;
  let lastSent = 0;
  // `force` skips the throttle for the milestones a caller must not lose -
  // the start/end marks around a phase, which are the whole progress story
  // for a child that prints little (abaplint answers in one JSON blob)
  return (line, force = false) => {
    lines += 1;
    const now = Date.now();
    if (!force && now - lastSent < 1000) return;
    lastSent = now;
    Promise.resolve(
      sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: lines, message: String(line).slice(0, 300) },
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

/*
 * The lint option set validate_view and fix_view share: explicit tool
 * arguments win; the checked project's abap2ui5lint.jsonc fills the rest — an
 * agent must not report (or fix by) findings the project's own CI has
 * deliberately configured away.
 *
 * Which project's config that is, in order: the one named (project_dir), the
 * one the server was started in, the corpus. It used to be the corpus and
 * only the corpus, which is right for porting samples and wrong for everyone
 * else. The chosen file is reported back as `config`.
 *
 * `forceNoRender` is fix_view's setting: fixes ride on the property gate, so
 * the render pass would cost seconds for findings that never carry one —
 * forced off and marked as decided so no config can switch it back on.
 */
async function lintOptionsFor(args, { forceNoRender = false } = {}) {
  const { findConfigFrom, loadConfig, applyConfig } = await importViewCheck('./config');
  const opt = { minUi5: '1.71', allow: [], render: !forceNoRender, properties: true };
  const seen = new Set(['properties']);
  if (forceNoRender) seen.add('render');
  if (args.min_ui5) { opt.minUi5 = args.min_ui5; seen.add('minUi5'); }
  if (args.allow) opt.allow = args.allow;
  if (!forceNoRender && args.render === false) { opt.render = false; seen.add('render'); }
  const configFile = resolveLintConfig(findConfigFrom, {
    projectDir: args.project_dir,
    cwd: process.cwd(),
    corpus: resolveSamplesControls(),
  });
  if (configFile) {
    const cfg = loadConfig(configFile);
    delete cfg.baseline; // baseline is a repo-workflow concern; new source has no baseline entry
    applyConfig(opt, seen, cfg);
  }
  return { opt, configFile };
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
      return text({ matches: hits.length, entries: hits });
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
      const searched = found.map((c) => c.repo);
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
      const hits = searchExamples({
        query: args.query,
        area,
        repo,
        limit: boundedInt(args.limit, { name: 'limit', dflt: 20, min: 1, max: 200 }),
      });
      return text({
        matches: hits.length,
        searched,
        ...(notSearched.length ? { notSearched } : {}),
        repositories: Object.fromEntries(found.map((c) => [c.repo, c.url])),
        next: 'read the `path` of the closest match, in the repository its `repo` names — it is a complete, gated app, not a fragment',
        entries: hits,
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
      return text({
        source: 'abap2UI5/' + GUIDE_PATH.join('/'),
        about: 'building an app WITH abap2UI5 (for porting a demo-kit sample, call generation_rules)',
        chapters,
        matches: sections.length,
        sections,
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
        return toolError(`"${args.class}" is not a class name this template accepts — it has to match `
          + `${rule} and stay within ${max} characters, e.g. zcl_my_app. `
          + 'abaplint\'s object_naming in the scaffolded project accepts ZCL_ and ZCX_ only, '
          + 'so a name outside this rule produces a repository that fails its own gate.');
      }

      const { files, missing, spec, noSpec } = scaffold(root, {
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

      return text({
        source: 'abap2UI5/app-template',
        class: cls || spec.placeholderClass,
        files,
        /* Reported, never silent: this list is a claim about another
         * repository, and a project quietly missing its CI workflow is not
         * noticed until somebody wonders why nothing is checked. */
        ...(missing.length ? { missing, warning: 'the template no longer has these — the project is incomplete without them' } : {}),
        next: 'write these files, then `npm install` and `npm run check` (abaplint + the abap2UI5-linter). '
          + 'The app class is a working starting point: read app_guide before changing it.',
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
      const kind = oneOf(args.kind, {
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
      if (!args.query) {
        return text({
          source: 'abap2UI5/' + API_PATH.join('/'),
          about: 'z2ui5_if_client — the complete API an app may call on `client`',
          ...pick(apiSummary(parsed)),
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
      return text({ matches: total, source: 'abap2UI5/' + API_PATH.join('/'), ...found });
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
      const rules = fs.readFileSync(p, 'utf8');
      return text(
        rules +
          '\n\n---\nThis is the PORTING brief. Building an app of your own instead? Call `app_guide`.\n' +
          'More depth: AGENTS.md (conventions, gates), CAPABILITIES.md via the capabilities tool, ' +
          'and https://abap2ui5.github.io/docs/cookbook/overview for the cookbook.',
      );
    }
    case 'docs_search': {
      const miss = missingSibling('docs');
      if (miss) return miss;
      if (!args.query) return toolError('pass `query` — keywords to search the documentation for, e.g. "value help" or "launchpad"');
      const entries = searchDocs({
        query: args.query,
        limit: boundedInt(args.limit, { name: 'limit', dflt: 10, min: 1, max: 50 }),
      });
      // the checkout can be there and the tree not: a half-finished pull, a
      // layout change upstream. Name the directory, the way app_guide does.
      if (entries === null || !fs.existsSync(docsRoot())) {
        return toolError(`the docs checkout has no docs/ page tree (looked in ${docsRoot()}) — `
          + 'update it (git pull); the site sources live there');
      }
      if (!entries.length) {
        return text({
          matches: 0,
          hint: `no documentation page carries every term of "${args.query}" — fewer or broader terms widen the net; `
            + 'app_guide covers building an app, api_reference the client API',
        });
      }
      return text({
        matches: entries.length,
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
      return text({ matches: total, catalogues: found });
    }
    case 'scope_of': {
      const miss = missingSibling('samples-controls');
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
      return text(`${out}\n\n(exit ${code}: 0 = all in scope, 1 = at least one out of scope or unresolved)`);
    }
    case 'deploy_app': {
      const miss = missingSibling('samples-controls');
      if (miss) return miss;
      const res = deployApp({
        className: args.class_name,
        source: args.abap_source,
        description: args.description,
      });
      const reply = { deployed: res.class, file: res.abapPath };
      if (args.lint !== false) {
        /* Progress around the lint when the client asked for it: abaplint can
         * take a minute over the whole corpus and prints nothing until its
         * one JSON answer, so the forced start/end marks are the signal that
         * the call is alive; whatever lines it does print stream throttled in
         * between. */
        const report = progressReporter(ctx);
        if (report) report(`abaplint: linting ${res.class} against the corpus config`, true);
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
        reply.next = 'run build_backend once, then run_app to see the app';
      }
      return text(reply);
    }
    case 'read_app': {
      const miss = missingSibling('samples-controls');
      if (miss) return miss;
      const res = readAppSource(args.class_name);
      if (!res.found) {
        return toolError(`no dev app '${res.class}' in src/zz_dev (looked for ${res.file}) — `
          + 'remove_app without arguments lists the deployed ones');
      }
      return text({
        ...res,
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
       * browser that died mid-call is dropped and the call retried cold. */
      const GATE_POOL = { pages: 1 };
      let result;
      const renderer = opt.render === false ? null : await getRenderer(GATE_POOL);
      if (renderer) {
        try {
          result = await check({ ...opt, renderer });
        } catch (e) {
          await dropRenderer(GATE_POOL); // whatever threw, a fresh one next call
          throw e;
        }
        if (rendererLooksDead(result.renderErrors)) {
          await dropRenderer(GATE_POOL);
          result = await check(opt);
        }
      } else {
        result = await check(opt);
      }

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
      const rules = await explainRules(result.findings, args.explain === true);
      // additive: fixable: true per finding fix_view can clear (older linter
      // without ./fix: no flag, findings untouched)
      const findings = await flagFixable(result.findings);
      return text({
        ok,
        counts,
        findings,
        ...(rules ? { rules } : {}),
        renderErrors: result.renderErrors,
        reconstructedDocs: result.docs.length,
        skippedRender: result.skippedRender ? `view parts in helper methods (${result.helperTokens} calls) — not statically reconstructable` : undefined,
        notes: result.notes,
        config: configFile || undefined,
        hint: counts.error === 0 && counts.warning > 0
          ? 'what is left is about the UI5 version you target: fix it, raise min_ui5 if the system is newer, or accept it via allow'
          : counts.error === 0 && counts.hint > 0
            ? 'hints are advisory - an event without a handler is intended when the roundtrip alone is the point'
            : undefined,
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
      const remaining = await flagFixable(res.remaining);
      return text({
        applied: res.applied,
        fixed: res.fixed,
        remaining,
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
          await dropRenderer(shotPool);
          shots = await doShots(null);
        }
        if (shots && rendererLooksDead(shots.flatMap((s) => s.errors || []))) {
          await dropRenderer(shotPool);
          shots = await doShots(null);
        }
      } else {
        shots = await doShots(null);
      }

      /* One entry per view per viewport. A class can build more than one
       * document (a view and its popup fragment), and `index`/`kind` are what
       * tell them apart - so the report names them rather than leaving the
       * agent to guess which of three images is the popup. */
      const report = shots.map((s) => ({
        index: s.index,
        kind: s.kind,
        size: s.size ? `${s.size.width}x${s.size.height}` : undefined,
        photographed: Boolean(s.png),
        errors: s.errors && s.errors.length ? s.errors : undefined,
      }));
      const taken = shots.filter((s) => s.png);
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
      // the build pipeline lives in samples-controls; the abap2UI5 checkout is
      // resolved (and clearly reported) by the build itself, which can also
      // bootstrap the in-repo .abap2UI5 clone on a full build
      const miss = missingSibling('samples-controls');
      if (miss) return miss;
      /* Checked BEFORE the running backend is stopped and before a build is
       * started: an unrecognised mode used to fall through to the auto branch,
       * and a typo therefore cost a full build - tens of minutes - instead of
       * a sentence. */
      const mode = oneOf(args.mode, {
        name: 'mode', allowed: ['auto', 'incremental', 'full'], dflt: 'auto',
      });
      await stopBackend();
      const res = await buildBackend({ mode, onLine: progressReporter(ctx), signal: ctx.signal });
      if (res.aborted) return toolError(`build cancelled by the client (mode ${res.mode || mode}):\n${res.tail}`);
      if (!res.ok) return toolError(`build failed (exit ${res.code}, mode ${res.mode || mode}):\n${res.tail}`);
      return text({ built: true, mode: res.mode, next: 'run_app { class_name } to boot and screenshot the app', tail: res.tail.split('\n').slice(-5).join('\n') });
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
      // samples-controls serves the local @openui5 modules, abap2UI5 the backend
      const miss = missingSibling('samples-controls', 'abap2UI5');
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
        screenshot: res.screenshotPath,
      };
      const content = [{ type: 'text', text: JSON.stringify(report, null, 2) }];
      if (res.base64) content.push({ type: 'image', data: res.base64, mimeType: 'image/png' });
      return { content, isError: !res.booted };
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
        const miss = missingSibling('abap2UI5');
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
    case 'remove_app': {
      const miss = missingSibling('samples-controls');
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/* The knowledge documents, as resources (lib/resources.mjs): listing is free
 * (names and URIs, no file touched), reading resolves the sibling live and
 * throws the same missing-checkout message the tools return — the client sees
 * it as the read request's JSON-RPC error. */
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri));

/* The two workflow prompts (lib/prompts.mjs): orchestration scripts over the
 * existing tools — build-an-abap2ui5-app and port-a-ui5-sample. They read no
 * sibling checkout; the tools they send the agent to do. */
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => getPrompt(req.params.name, req.params.arguments || {}));

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
  const md = readGuide();
  if (md === null) return empty;
  const want = String(argument.value || '').toLowerCase();
  const values = guideChapters(md)
    .filter((c) => c.toLowerCase().includes(want))
    .slice(0, 100); // the protocol's ceiling per answer
  return { completion: { values, total: values.length, hasMore: false } };
});
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  try {
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
});

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

process.on('SIGINT', async () => {
  await Promise.all([stopBackend().catch(() => {}), closeRenderers()]);
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await Promise.all([stopBackend().catch(() => {}), closeRenderers()]);
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
diagnostic('info', `abap2ui5 MCP server ready (samples-controls: ${resolveSamplesControls()}, backend built: ${backendBuilt()})`);

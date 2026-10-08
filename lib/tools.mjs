/*
 * tools — the server's tool surface, the array MCP clients see in tools/list.
 *
 * In a module of its own, away from server.mjs, for two reasons. The practical
 * one: server.mjs connects the stdio transport at module scope, so nothing that
 * wants the tool list — a test, a doc check — may import it without hanging.
 * The structural one: this list used to be duplicated by hand in four places
 * (the server.mjs header comment, the README table, AGENTS.md, the test name
 * lists), and each copy drifted in its own way. Now the array is the source:
 * the tests import TOOL_NAMES, and test/tool-surface.test.mjs fails the build
 * when the README table or a written-out tool count stops matching it.
 *
 * A tool DESCRIPTION is the only documentation the agent reads. It never sees
 * the README or AGENTS.md — it picks a tool from the sentence here. So two
 * tools that answer neighbouring questions have to say which is which IN those
 * sentences (app_guide vs generation_rules, screenshot_view vs run_app).
 */
export const TOOLS = [
  {
    name: 'setup_status',
    description:
      'What this server can do RIGHT NOW, in one read - call it first, or whenever a tool says something is '
      + 'missing: per repository whether a local checkout, the read-only GitHub mirror or nothing resolves '
      + '(and the env var or clone that fixes it), which dev sandbox deploy_app writes into (the corpus, the '
      + 'framework checkout, or the npm backend\'s workspace sandbox when there is neither) and what is deployed '
      + 'there, which backend runs the apps (a framework checkout, or the npm package @abap2ui5/node-runtime: its '
      + 'release, where it is installed, its transpiler and abaplint, the open-abap-core commit, what the next '
      + 'build_backend would do), whether it is built and running, whether the unit-test runner exists, and '
      + 'whether git, tar, npm, npx and a Chromium are on this machine. Reads only; changes nothing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'capabilities',
    description:
      'Query what abap2UI5 can express, from the verified capability map (CAPABILITIES.md — every entry ' +
      'names a proving port). Call this BEFORE deciding a UI5 feature cannot be built. ' +
      'Without arguments returns a summary; with `query` returns matching entries ' +
      '(status: direct | workaround | needs-live-test | not-expressible) - paged: an answer stops at about ' +
      '60,000 characters, and `more` names the `offset` to continue at.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords matched against feature/how/evidence, e.g. "tree binding" or "dialog"' },
        status: {
          type: 'string',
          enum: ['direct', 'workaround', 'needs-live-test', 'not-expressible'],
          description: 'optional filter on the capability status',
        },
        limit: { type: 'number', description: 'maximum entries to return (default: every match that fits about 60,000 characters)' },
        offset: { type: 'number', description: 'skip this many matches - the paging cursor a `more` hint names (default 0)' },
      },
    },
  },
  {
    name: 'examples',
    description:
      'Find a WORKING APP that already does what you are about to build, across ALL THREE sample '
      + 'repositories (live-read from their committed catalogues — catalogue.json, or SAMPLES.md on '
      + 'an older checkout): abap2UI5/samples '
      + '(patterns — value help, navigation, trees, tables), abap2UI5/samples-controls (the UI5 demo '
      + 'kit rebuilt control by control — ask this for "how do I express sap.m.Wizard") and '
      + 'abap2UI5/samples-stack (apps that need an OData service, RAP, APC or the launchpad — only '
      + 'propose one when the user has that). This is the pattern question and it differs from '
      + '`capabilities`, which answers whether a UI5 control can be expressed at all. Ask this before '
      + 'writing an app from scratch. What comes back is a repository, a class name and its path: '
      + 'READ that class. It is a whole app that compiles, renders and is downported to every '
      + 'release the ecosystem supports, which is worth more than any snippet. A repository that is not checked out is '
      + 'reported, not fatal — the others are still searched. Entries also carry `docs` (the cookbook '
      + 'pages that sample is the worked example of) and, where the catalogue says so: `status` for a '
      + 'control port — checked (a human watched it run in a real system) over reviewed over '
      + 'generated, which breaks ties in the ranking — plus its `deviations` from the original, '
      + '`stage` (the learning-path stage in samples), and `technology`/`needs` (what a stack sample '
      + 'requires from the system). Without arguments returns a summary.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'keywords matched against the catalogue title, description and search terms, e.g. "value help f4" or "table binding" or "routing"',
        },
        repo: {
          type: 'string',
          enum: ['samples', 'samples-controls', 'samples-stack'],
          description:
            'optional filter to one repository. Use `samples-controls` when the question is about a '
            + 'specific UI5 CONTROL, `samples-stack` when the app may depend on the system (OData, RAP, '
            + 'APC, launchpad), `samples` for everything else.',
        },
        area: {
          type: 'string',
          enum: ['samples', 'experimental-or-test'],
          description:
            'optional filter WITHIN abap2UI5/samples. `samples` is the supported set (src/, src/01 on an '
            + 'older checkout) and what you normally want; `experimental-or-test` is src/00 of an older '
            + 'checkout — work in progress and apps that exercise the framework from the outside, useful '
            + 'to read, not to copy wholesale (a current checkout has none).',
        },
        limit: { type: 'number', description: 'maximum entries to return (default 20); an answer also stops at about 60,000 characters and says `more` with the offset to continue at' },
        offset: { type: 'number', description: 'skip this many matches - the paging cursor a `more` hint names (default 0)' },
      },
    },
  },
  {
    name: 'read_example',
    description:
      'READ the source of a sample the `examples` tool pointed at — the whole class, from the '
      + 'repository the hit named — without leaving the conversation. Pass `class` (the entry\'s '
      + 'class name, looked up across the three catalogues) or `repo` + `path` (as the entry '
      + 'carries them). Read live from the local checkout when there is one, fetched from GitHub '
      + 'otherwise, so an `examples` hit is always one call away from its code. A sample is a '
      + 'complete, gated app: read it whole, then take the pattern, not the file. A long one comes in '
      + 'pages of whole lines (`page`, `nextPage`).',
    inputSchema: {
      type: 'object',
      properties: {
        class: { type: 'string', description: 'the sample class, e.g. Z2UI5_CL_SMP_APP_493 — resolved to its repository and path through the catalogues' },
        repo: { type: 'string', enum: ['samples', 'samples-controls', 'samples-stack'], description: 'with `path`: the repository the examples entry named' },
        path: { type: 'string', description: 'with `repo`: the file path the examples entry carries, e.g. src/01/z2ui5_cl_smp_app_493.clas.abap' },
        from_line: { type: 'number', description: 'optional: the first line to return (1-based) - a long sample comes in pages, each answer names the next from_line' },
      },
    },
  },
  {
    name: 'app_guide',
    description:
      'READ THIS BEFORE WRITING ABAP for an app of your own. The complete guide to BUILDING an '
      + 'abap2UI5 app, live from the framework checkout (abap2UI5 docs/agents/building-apps.md, '
      + 'written to be self-contained so no web access is needed): the app class template and its '
      + 'lifecycle (check_on_init / check_on_event / check_on_navigated), the '
      + 'z2ui5_cl_ui5_view_builder chain, data binding, events, popups, navigation, and the rules '
      + 'that keep an app portable to the oldest supported UI5. Without arguments the whole guide '
      + 'comes back, chapter by chapter — it is meant to be read once at the start of a task. '
      + '`section` (a chapter number or a word from its heading) or `query` narrows it once you know '
      + 'what you are looking for. Paged by chapter: an answer stops at about 60,000 characters, and '
      + '`more` names the `offset` to continue at. This is the BUILD rulebook; `generation_rules` is the different '
      + 'one for PORTING an existing UI5 demo-kit sample into the samples-controls corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'one chapter: its number ("5") or a word from its heading ("events", "binding")',
        },
        query: {
          type: 'string',
          description: 'optional keywords — returns only the chapters carrying every term, e.g. "popup" or "value help"',
        },
        offset: {
          type: 'number',
          description: 'skip this many of the matching chapters (the `more` of the previous answer names it); default 0',
        },
        limit: {
          type: 'number',
          description: 'at most this many chapters; default every one that fits one answer',
        },
      },
    },
  },
  {
    name: 'api_reference',
    description:
      'The client API an app calls at runtime — z2ui5_if_client, parsed live from the framework '
      + 'checkout WITH its ABAP-Doc, so a signature is looked up instead of guessed from training '
      + 'data or fished out of the whole z2ui5_if_client source. Without arguments returns the compact '
      + 'surface: every method one line each (obsolete ones marked — they exist only so '
      + 'old apps keep compiling), the cs_* constant groups (cs_event, cs_view, cs_device, '
      + 'cs_nav_mode) and the named types. With `query` the matching entries come back WHOLE: a '
      + 'method with its full documentation and every parameter (type, default, per-parameter '
      + 'doc), a constant with its path (`cs_event-start_timer`) and value, a type with its '
      + 'fields. Both lists are paged by entry (`offset`, `limit`): an answer stops at about 60,000 characters, and `more` names the '
      + '`offset` to continue at. Ask it "toast", "follow_up_action", "prevent default", "timer". This answers '
      + 'what EXACTLY can be called and with which arguments; `app_guide` is the prose on how an '
      + 'app is built, and `examples` finds a whole app to read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'keywords AND-ed over method names, documentation, parameter names/docs and constant '
            + 'paths/values, e.g. "toast", "_bind omit", "nav_app" or "clipboard"',
        },
        kind: {
          type: 'string',
          enum: ['methods', 'constants', 'types', 'all'],
          description: 'optional filter on what comes back (default all)',
        },
        limit: { type: 'number', description: 'maximum entries to return - methods, constant groups and types, in that order (default: every entry that fits about 60,000 characters); pages the compact list too' },
        offset: { type: 'number', description: 'skip this many entries - the paging cursor a `more` hint names (default 0); pages the compact list too' },
      },
    },
  },
  {
    name: 'generation_rules',
    description:
      'The rulebook for PORTING one official UI5 demo-kit sample to abap2UI5 as a '
      + 'z2ui5_cl_smpc_app_<n> class in the samples-controls corpus: what to do with the original '
      + 'Component.js/view.xml/controller, the corpus naming and file conventions, and the 1:1 '
      + 'fidelity rules its gates enforce. Use it when you are porting a named demo-kit sample. '
      + 'If you are building an app of your own, `app_guide` is the one you want — this document '
      + 'assumes an input sample you do not have and a corpus you are not writing into.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'scaffold_app',
    description:
      'The files a NEW abap2UI5 project starts from, named after the app you are writing — served '
      + 'live from abap2UI5/app-template, the repository this ecosystem points people at to begin. '
      + 'Call this when the user wants an app of their own rather than a class to paste somewhere: '
      + '`app_guide` tells you how to write the CLASS, this hands you everything AROUND it that you '
      + 'cannot invent — the abaplint config with the framework pinned at a release, the '
      + 'abap2ui5lint config the render gate needs, the CI workflow, the abapGit metadata, an '
      + 'AGENTS.md briefing for whoever works on the project next, and one working app class with '
      + 'its .clas.xml sidecar. Pass `class` and the class is renamed throughout, INCLUDING the '
      + "sidecar's CLSNAME and the file names — renaming only the ABAP produces an object that "
      + 'looks right and does not activate. Returns file paths and contents for you to write; it '
      + 'writes nothing itself. For a project that ALREADY EXISTS, call add_agent_setup instead.',
    inputSchema: {
      type: 'object',
      properties: {
        class: {
          type: 'string',
          description:
            'the app class, lower case, e.g. `zcl_my_app` (^z(cl|cx)_, letters digits underscore, at most 30 characters - '
            + 'the rule the template\'s abaplint object_naming enforces). '
            + 'Left out, the files come back on the template\'s own `zcl_app_001`.',
        },
        package: {
          type: 'string',
          description: "short text of the ABAP package, e.g. \"My App\" (the sidecar's CTEXT)",
        },
        repo: {
          type: 'string',
          description: 'the abapGit repository name written into .abapgit.xml, e.g. `my-app`',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'only these paths (as this tool returns them, with the same class). One answer carries about '
            + '60,000 characters: the first one every file that fits, smallest first - the class, its sidecar and the '
            + 'configs always among them - and `remaining` lists the rest, which this argument fetches.',
        },
      },
    },
  },
  {
    name: 'add_agent_setup',
    description:
      'Set up an EXISTING abap2UI5 project for AI work - what `npm create abap2ui5-app -- --agent-setup` does, '
      + 'executed from abap2UI5/app-template\'s own template.json (`agentSetup`): adds AGENTS.md (the app-building '
      + 'reference), CLAUDE.md, the agent skills, .mcp.json (this server), the .claude permission allowlist, the '
      + 'two gates (abaplint.jsonc with the framework pinned, abap2ui5lint.jsonc), the CI workflow that runs them and '
      + 'the scripts it calls. WRITES into the project directory, safely: a file the project has is never '
      + 'overwritten (skipped and named); package.json and .gitignore are merged and only ever GAIN entries (a '
      + 'script, devDependency or pattern you have keeps its value, and each one kept on a different value is a '
      + 'warning); the configs follow the source folder .abapgit.xml names (STARTING_FOLDER), and nothing is written '
      + 'into that folder. Re-running changes nothing. Answers what was written, merged and skipped, the warnings '
      + 'and the next steps (npm install, npm run check). This is for a project that is already there - most '
      + 'abapGit repositories never started from the template; for a NEW project call scaffold_app, which hands '
      + 'back the whole template, app class included, for you to write.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: {
          type: 'string',
          description: 'the project\'s root directory (where .abapgit.xml and .git are). Defaults to the server\'s working '
            + 'directory, which then has to look like a project (a .git, .abapgit.xml or package.json in it).',
        },
        dry_run: {
          type: 'boolean',
          description: 'decide everything and answer the same report, but write nothing (default false)',
        },
      },
    },
  },
  {
    name: 'docs_search',
    description:
      'Full-text search over the abap2UI5 documentation site (abap2ui5.github.io/docs), from its '
      + 'markdown sources in the local docs checkout — the cookbook chapters, setup and '
      + 'configuration, the advanced guides. Use it for the prose the other tools do not carry: '
      + 'how a feature is meant to be used, which cookbook chapter walks through it, what the '
      + 'setup for a stack looks like. Each hit names the page, the best-matching heading, a '
      + 'snippet, and the published URL pair — `url` (the rendered page for a human) and '
      + '`markdown` (the raw page, the one to fetch). Terms are AND-ed. This searches the whole '
      + 'SITE; `app_guide` is the one self-contained build rulebook served chapter by chapter, '
      + 'and `api_reference` is the exact client API — reach for those first when the question '
      + 'is "how do I build" or "what can I call".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'keywords, e.g. "value help", "launchpad setup" or "custom control" — every term must match',
        },
        limit: { type: 'number', description: 'maximum pages to return (default 10, at most 50); `matches` counts every page that matched' },
        offset: { type: 'number', description: 'skip this many matching pages - the paging cursor a `more` hint names (default 0)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pitfalls',
    description:
      'The catalogues of defects a green CI does NOT catch, read live from the abap2UI5 checkout: '
      + '`abap` covers ABAP that has to survive a real SAP system (abapGit round trip and import, '
      + 'activation, extended check, downport/transpiler, runtime), `view` covers the view side '
      + '(names the 1.71 floor does not have, layout that only works on a newer release, views that '
      + 'fail to load rather than to render, CSP). Every entry is a defect that actually shipped. '
      + 'Read it before finishing a change — validate_view catches what a rule can decide, this is '
      + 'the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ['abap', 'view', 'all'],
          description: 'which catalogue (default: all)',
        },
        query: {
          type: 'string',
          description: 'optional keywords — returns only the matching sections, e.g. "icon" or "abapgit sidecar"',
        },
        offset: {
          type: 'number',
          description: 'skip this many sections: an answer carries about 60,000 characters (both catalogues whole are '
            + 'twice that), and `more` names the offset the next page starts at (default 0)',
        },
      },
    },
  },
  {
    name: 'scope_of',
    description:
      'Authoritative in/out-of-scope verdict for UI5 control entities (exists since UI5 <= 1.71, not ' +
      'deprecated), read from the OpenUI5 source JSDoc. Needs an OpenUI5 checkout (OPENUI5_SRC or ' +
      '../fork-openui5).',
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'control entities, e.g. ["sap.m.Wizard", "sap.f.SidePanel"]',
        },
      },
      required: ['entities'],
    },
  },
  {
    name: 'deploy_app',
    description:
      'Deploy an abap2UI5 app: writes <class_name>.clas.abap (+ abapGit sidecar) into the dev sandbox - ' +
      'samples-controls\' src/zz_dev/, else the abap2UI5 checkout\'s node/zz_dev/, else (no checkout at all, the ' +
      'default) the npm backend\'s ~/.abap2ui5-mcp/sandbox - and lints it (the corpus\' abaplint config, or ' +
      'app-template\'s with the framework sources as the dependency: the lint a real project runs; on the npm ' +
      'backend the first lint installs its runtime, once). The class must implement ' +
      'z2ui5_if_app; ANY customer-namespace class name is accepted (zcl_my_app as much as ' +
      'z2ui5_cl_my_app), so an app of your own keeps the name it has in your repository. After ' +
      'deploying, run build_backend once (rebuilds the transpiled Node backend), then run_app to see ' +
      'it. Set lint:false to skip the lint (faster, not recommended).',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'lowercase ABAP class name starting z or y, <= 30 chars, e.g. zcl_my_app or z2ui5_cl_my_app' },
        abap_source: { type: 'string', description: 'full ABAP source of the class (CLASS ... DEFINITION + IMPLEMENTATION)' },
        description: { type: 'string', description: 'short class description (abapGit DESCRIPT; default "MCP dev app <class>" - unique per class, as abaplint identical_descriptions demands)' },
        testclasses: {
          type: 'string',
          description: 'optional: the local test classes (the .clas.testclasses.abap include — `CLASS ltcl_... FOR TESTING`, '
            + 'typically with a local z2ui5_if_client double, see app_guide chapter 9). Written beside the class and '
            + 'run by run_unit_tests after the next build_backend. Omitting it on a redeploy removes a previous one.',
        },
        lint: { type: 'boolean', description: 'run abaplint after writing (default true)' },
      },
      required: ['class_name', 'abap_source'],
    },
  },
  {
    name: 'read_app',
    description:
      'Read back the source of a DEPLOYED dev app exactly as it sits in the dev sandbox — the file '
      + 'run_app\'s backend was (or will be) built from — plus staleness: `staleInBackend: true` '
      + 'means the file is newer than the built backend, so run_app still boots the OLDER code '
      + 'until the next build_backend. Use it to check what is actually deployed before blaming '
      + 'an edit that never arrived; deploy_app writes, remove_app lists and deletes. A long class comes in '
      + 'pages of whole lines (`lines`, `next`).',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'the deployed dev app class, e.g. zcl_my_app (remove_app without arguments lists them)' },
        from_line: { type: 'number', description: 'optional: the first line to return (1-based) - a long class comes in pages, each answer names the next from_line' },
      },
      required: ['class_name'],
    },
  },
  {
    name: 'validate_view',
    description:
      'Fast static validation via abap2UI5-linter, BEFORE the build/run loop: reconstructs the view from the ' +
      'z2ui5_cl_ui5_view_builder calls (or takes raw view XML), runs the UI5 property gate (@since floor, ' +
      'deprecation) and renders it headless with a typed mock model. Seconds instead of a build+boot — use it ' +
      'after writing ABAP, then deploy_app once it is clean. Each finding carries severity (error = the app ' +
      'breaks, warning = not necessarily on your target UI5, hint = advisory), a message and the line/column ' +
      'in the source you passed in; ok is false while any error or warning is left (hints are advisory). Each rule ' +
      'that fired also comes back explained under `rules` (pass explain:true for the full paragraph), so a finding ' +
      'never needs a web search. The checked project\'s abap2ui5lint.jsonc (rule overrides, allow list, UI5 floor) ' +
      'is honoured; explicit arguments win. Pair it with screenshot_view, which photographs the same reconstructed ' +
      'view: this says whether the view is legal, that says what it looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        abap_source: { type: 'string', description: 'ABAP class source building its view with z2ui5_cl_ui5_view_builder' },
        xml: { type: 'string', description: 'alternatively: raw view/fragment XML' },
        project_dir: {
          type: 'string',
          description:
            'the project this source belongs to — its abap2ui5lint.jsonc (searched upwards from here) supplies '
            + 'the rule overrides, allow list and UI5 floor, so a finding matches what that project\'s own CI says. '
            + 'Defaults to the working directory, then to the samples-controls corpus.',
        },
        min_ui5: { type: 'string', description: 'UI5 floor for the property gate (default 1.71)' },
        allow: { type: 'array', items: { type: 'string' }, description: 'accepted deviations, e.g. ["sap.m.GenericTile.systemInfo"]' },
        render: { type: 'boolean', description: 'run the headless render gate (default true)' },
        explain: {
          type: 'boolean',
          description:
            'add the full explanation of every rule that fired — why the defect matters and what the '
            + 'fix looks like (default false; the one-line summary of each rule is always included)',
        },
      },
    },
  },
  {
    name: 'fix_view',
    description:
      'Apply the linter\'s MECHANICAL fixes to a source and get the corrected source back — '
      + 'nothing is written anywhere, you decide where it goes. Takes abap_source or xml exactly '
      + 'like validate_view (whose findings mark what this can clear with `fixable: true`): runs '
      + 'the property-gate findings, applies the fixes they carry (an obsolete client call '
      + 'renamed, a bare ABAP boolean moved onto the boolean parameter, a missing namespace '
      + 'declared), repeats until nothing more applies, and reports which findings were fixed and '
      + 'which remain — a remaining finding needs a decision a mechanical fix cannot make. The '
      + 'checked project\'s abap2ui5lint.jsonc is honoured the same way validate_view honours it.',
    inputSchema: {
      type: 'object',
      properties: {
        abap_source: { type: 'string', description: 'ABAP class source building its view with z2ui5_cl_ui5_view_builder' },
        xml: { type: 'string', description: 'alternatively: raw view/fragment XML' },
        project_dir: {
          type: 'string',
          description:
            'the project this source belongs to — its abap2ui5lint.jsonc (searched upwards from here) supplies '
            + 'the rule overrides, allow list and UI5 floor. Defaults to the working directory, then to the '
            + 'samples-controls corpus.',
        },
        min_ui5: { type: 'string', description: 'UI5 floor for the property gate (default 1.71)' },
        allow: { type: 'array', items: { type: 'string' }, description: 'accepted deviations, e.g. ["sap.m.GenericTile.systemInfo"]' },
      },
    },
  },
  {
    name: 'screenshot_view',
    description:
      'LOOK at the view your ABAP builds, in seconds and without a system, a build or a backend. '
      + 'The view is reconstructed from the z2ui5_cl_ui5_view_builder calls (or taken as raw XML), '
      + 'seeded with a model derived from the class\'s own TYPES/DATA, rendered against the local '
      + 'OpenUI5 runtime and returned as an IMAGE. Use it while writing the view — beside '
      + 'validate_view, which says whether the view is legal; this says what it looks like, which is '
      + 'the half no finding can tell you (a control in the wrong aggregation, a layout that '
      + 'collapses, a table that is empty). Ask for several viewports at once (`sizes`) — one '
      + 'browser session renders them all, so a phone/desktop pair costs barely more than one '
      + 'picture. What it cannot show: anything that only exists at runtime — rows a SELECT would '
      + 'fetch (pass `model` for preview data), and whatever an event does. run_app is the '
      + 'expensive tool that shows those, after a build.',
    inputSchema: {
      type: 'object',
      properties: {
        abap_source: { type: 'string', description: 'ABAP class source building its view with z2ui5_cl_ui5_view_builder' },
        xml: { type: 'string', description: 'alternatively: raw view/fragment XML' },
        sizes: {
          type: 'array',
          items: { type: 'string' },
          description: 'viewports as WIDTHxHEIGHT, e.g. ["390x844", "1280x900"] (default one 1280x900)',
        },
        theme: { type: 'string', description: 'UI5 theme, e.g. sap_horizon (default) or sap_horizon_dark' },
        model: {
          type: 'object',
          description:
            'preview data merged over the derived model — the way to photograph a list with rows in '
            + 'it, e.g. { "T_ITEMS": [{ "TEXT": "first" }, { "TEXT": "second" }] }',
        },
      },
    },
  },
  {
    name: 'build_backend',
    description:
      'Rebuild the transpiled Node backend so run_app and run_unit_tests pick up deployed/edited ABAP. ' +
      'Without an abap2UI5 checkout (the default on a fresh machine) mode auto is npm: the framework comes ' +
      'transpiled in the npm package @abap2ui5/node-runtime, installed once per release into ~/.abap2ui5-mcp ' +
      '(the registry\'s latest, or the release A2UI5_MCP_RUNTIME_VERSION pins; a minute the first time), and ' +
      'only the deployed apps are transpiled against it - seconds; no clone, no framework devDependencies. ' +
      'With a checkout (A2UI5_HOME or a sibling) auto is incremental when a prior build exists (only the dev ' +
      'sandbox re-copied and re-transpiled, ~1-2 min) and otherwise prebuilt, followed in the same call by that incremental build of the deployed apps. mode prebuilt (alone: the framework, no dev app) downloads the ' +
      'backend the framework\'s release workflow built (backend-<version>.tar.gz) into the checkout, and clones ' +
      'the release into the workspace first when there is none - the explicit way to a framework clone (refused under ' +
      'A2UI5_MCP_BACKEND=npm, which keeps the package the backend: prebuilt, transpile and full would build nothing it serves). mode ' +
      'transpile runs the framework\'s own build in its checkout (npm run downport + auto_transpile, a few ' +
      'minutes, cloning the same way) - what auto falls back to when the release carries no asset yet. mode ' +
      'full runs the complete e2e-build (tens of minutes, needs samples-controls). A failed download or install ' +
      'is reported, never silently turned into a tens-of-minutes full build; a construct the transpiler rejects ' +
      'fails with its message (simplify the ABAP). Stops a running backend first. Only one build runs at a time: a second call with the ' +
      'same effective mode joins the in-flight build and returns its result; a call with a different mode fails ' +
      'fast with "build in progress" — retry when the running build has finished (a full build is never silently ' +
      'downgraded to an incremental result, and vice versa). Long builds emit MCP progress notifications (at most ' +
      'one per second, carrying the latest build output line) when the call includes a progressToken.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'npm', 'incremental', 'prebuilt', 'transpile', 'full'], description: 'default auto' },
      },
    },
  },
  {
    name: 'build_log',
    description:
      'Read the full output of the LAST build_backend run — the tool result itself carries only a '
      + 'short tail, so this is how to see the error that tail cut off without paying another '
      + 'build. Returns the requested line slice plus when the build ran, its mode and how it '
      + 'ended (exit code, timeout, cancellation). Without `offset` the last `tail` lines come '
      + 'back; with it, `tail` lines from that line on (`start` and `totalLines` in the answer '
      + 'are the paging cursor; lines that do not fit one answer are left out and `cut` names the '
      + 'call that reads them, and a line longer than 4000 characters is shown shortened). The log survives a server restart. Nothing to read until a '
      + 'build has run.',
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'number', description: 'how many lines (default 100, max 2000)' },
        offset: {
          type: 'number',
          description: '0-based line to start from; leave out to get the LAST `tail` lines',
        },
      },
    },
  },
  {
    name: 'run_app',
    description:
      'Boot an app class headless in Chromium against the local backend (?app_start=<class>) and LOOK at it: ' +
      'returns booted/ok, real page errors + failed backend calls (benign UI5 noise filtered; a repeated one listed once with ' +
      'its count, at most 20 distinct), and a full-page ' +
      'screenshot as an image. The RUNNING app, so it is the only tool that sees what the ABAP does — the data ' +
      'a SELECT fetched, what an event changes — and it needs a build_backend first. To look at the view alone ' +
      'while writing it, screenshot_view answers in seconds with no build at all. Also works for the existing ' +
      'ports and z2ui5_cl_smpc_app_overview.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'the app class to start, e.g. zcl_my_app, z2ui5_cl_my_app or z2ui5_cl_smpc_app_005' },
        timeout_ms: { type: 'number', description: 'boot timeout in ms (default 60000)' },
      },
      required: ['class_name'],
    },
  },
  {
    name: 'interact_app',
    description:
      'Boot an app class headless like run_app, then DRIVE it: a short script of actions — click a control '
      + '(by its builder `id`, a CSS `selector` or its exact visible `text`), fill an input (`value`; the field is '
      + 'committed with Tab so the change event and its roundtrip fire), press a key, wait — performed in order '
      + 'against the running app, then the roundtrips settle and the result is photographed. This is the only '
      + 'tool that reaches the EVENT branch of `main( )` without a system: what a button does, what an input '
      + 'changes, whether a popup opens. Returns run_app\'s report plus one entry per action (performed, or why '
      + 'not — the first failing action stops the script, the picture is still taken) and the screenshot as an '
      + 'image. Needs a build_backend first; run_app boots and looks, this one boots, acts and looks.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'the app class to start, e.g. zcl_my_app' },
        actions: {
          type: 'array',
          description: 'the script, at most 30 steps: { action: click | fill | press | wait, id? | selector? | text?, value? (fill), key? (press, e.g. Enter), ms? (wait, <= 10000), commit? (fill: false leaves the field focused) }',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'fill', 'press', 'wait'] },
              id: { type: 'string', description: 'the control id the builder wrote (`a( n = `id` v = `save` )`) — matched as is or as the UI5 view-prefixed `--save`' },
              selector: { type: 'string', description: 'a CSS selector, when there is no id' },
              text: { type: 'string', description: 'the exact visible text, e.g. a button label' },
              value: { type: 'string', description: 'fill: the text to enter ("" clears)' },
              key: { type: 'string', description: 'press: a Playwright key name (Enter, Tab, Escape, ArrowDown, ...)' },
              ms: { type: 'number', description: 'wait: milliseconds (default 500, max 10000); with a locator instead: wait until it is visible' },
              commit: { type: 'boolean', description: 'fill: press Tab afterwards so the change event fires (default true)' },
            },
            required: ['action'],
          },
        },
        timeout_ms: { type: 'number', description: 'boot timeout in ms (default 60000)' },
        action_timeout_ms: { type: 'number', description: 'per-action timeout in ms (default 10000)' },
      },
      required: ['class_name', 'actions'],
    },
  },
  {
    name: 'app_list',
    description:
      'The app classes the built backend can start with app_start: the deployed dev apps (source "dev") and the '
      + 'framework\'s own (its z2ui5_cl_pop_* popups, the startup app; source "framework"), read from the transpiled '
      + 'output - an app deployed after the last build_backend is not in it yet. Optional `filter`: a substring of the '
      + 'class name. Needs a build_backend first; starts nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'substring of the class name, case-insensitive (e.g. "smp_app_00")' },
      },
    },
  },
  {
    name: 'app_start',
    description:
      'Start an app class on the local backend and get its screen as an AGENT SNAPSHOT (v1): the fields you can fill '
      + '(id, model path, label, kind, current value, editable, choice values), the actions you can fire (the event name '
      + 'and arguments of each button/link/row/value-help wire), the tables (columns, the first rows, selection), the '
      + 'messages (toast, message box, MessageStrip, field value states) and some static text - read from the real '
      + 'abap2UI5 JSON protocol, no browser, no CSS selector, no screenshot. Continue with app_act using the snapshot\'s '
      + '`session`. Optional `values` are applied as pending edits right after the start. The cheap way to operate an '
      + 'app: interact_app clicks and photographs it in Chromium; this speaks the wire protocol the frontend speaks. '
      + 'In a chat host that renders MCP Apps the screen is also shown to the user, who can operate it - what they do arrives as '
      + 'app_act calls, so re-read the session if it moved on. '
      + 'Needs a build_backend first (the backend is started like run_app starts it).',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'the app class to start, e.g. z2ui5_cl_smp_app_009 or zcl_my_app (app_list names the built ones)' },
        values: { type: 'object', description: 'optional { "<field id, model path or name>": value } kept as pending edits (sent with the next app_act event)' },
        max_rows: { type: 'number', description: 'table rows per table in the snapshot (default 20, max 200)' },
        format: { type: 'string', enum: ['snapshot', 'adaptive-card'], description: 'optional: "adaptive-card" adds the screen as an Adaptive Card 1.5 (an embedded resource, application/vnd.microsoft.card.adaptive) after the snapshot - for hosts that render cards (Copilot, Teams); default "snapshot" (or the server\'s A2UI5_MCP_APP_FORMAT)' },
      },
      required: ['app'],
    },
  },
  {
    name: 'app_describe',
    description:
      'The current agent snapshot of a running app session (see app_start) - answered from the last response this '
      + 'server kept, no roundtrip, so it is free. Pending edits (values sent without an event) show as the fields\' '
      + 'values and are listed under `pending`.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'the `session` of the last snapshot (the draft id to continue with)' },
        max_rows: { type: 'number', description: 'table rows per table (default: what app_start used)' },
        format: { type: 'string', enum: ['snapshot', 'adaptive-card'], description: 'optional: "adaptive-card" adds the screen as an Adaptive Card 1.5 (an embedded resource, application/vnd.microsoft.card.adaptive) after the snapshot - for hosts that render cards (Copilot, Teams); default "snapshot" (or the server\'s A2UI5_MCP_APP_FORMAT)' },
      },
      required: ['session'],
    },
  },
  {
    name: 'app_act',
    description:
      'Operate a running app session semantically: fill fields and fire an event, then get the new agent snapshot. '
      + '`values` { "<field id | model path | name>": value } (table cells as "<table path or id>/<row>/<COLUMN>", e.g. '
      + '"/T_TAB/2/SELKZ" to select a row) go out as the model delta of the roundtrip; `event` is an action\'s event name '
      + 'or its id ("a3"); `row` (0-based) fills the row-dependent arguments of a row action ("$row:FIELD", '
      + '"$source:text", and the row-valued event parameters such as ${$parameters>/listItem}.getBindingContext()...); '
      + 'on a SelectDialog/TableSelectDialog the `confirm` action is the pick: `row` selects that row as a click does '
      + '(its selectionField, sent as the model delta) and fills selectedItem/selectedContexts arguments from it; '
      + '`args` (positional, null = let the client fill it) supplies arguments the browser would compute '
      + '("$expr:...", "$parameters:...", a message box\'s "$action"). Without `event` the values stay pending, as typing '
      + 'does in the browser. Strict: an event that is not among the snapshot\'s actions, a field that is not on the '
      + 'screen or not editable, a choice outside its values is refused - the error names what is allowed - and nothing '
      + 'is sent. "@CLOSE_POPUP" / "@CLOSE_POPOVER" actions close the dialog locally, as the browser does without a '
      + 'roundtrip.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'the `session` of the last snapshot' },
        values: { type: 'object', description: '{ "<field id, model path or name>": value, "<table path>/<row>/<COLUMN>": value }' },
        event: { type: 'string', description: 'the action to fire: its event name (e.g. "SAVE") or its id ("a3")' },
        args: { type: 'array', items: {}, description: 'event arguments, positional to the action\'s `args`; null where the client fills the value in' },
        row: { type: 'number', description: 'for a row action: the row index (0-based) in its table - for a selection dialog\'s confirm, the row to pick' },
        max_rows: { type: 'number', description: 'table rows per table in the answer (default: what app_start used)' },
        format: { type: 'string', enum: ['snapshot', 'adaptive-card'], description: 'optional: "adaptive-card" adds the screen as an Adaptive Card 1.5 (an embedded resource, application/vnd.microsoft.card.adaptive) after the snapshot - for hosts that render cards (Copilot, Teams); default "snapshot" (or the server\'s A2UI5_MCP_APP_FORMAT)' },
      },
      required: ['session'],
    },
  },
  {
    name: 'run_unit_tests',
    description:
      'Run the ABAP Unit tests in the transpiled backend — the local test classes deployed with an app '
      + '(deploy_app `testclasses`, built by build_backend) — and get ASSERTIONS instead of a picture: which '
      + 'test methods ran, which the framework skips, and the first failure with its error. With `class_name` '
      + 'only that object\'s test classes run (the generated runner is filtered on it); without it every deployed '
      + 'app\'s tests run on the npm backend, and on a framework checkout every test of the transpiled tree, the '
      + 'framework\'s own included, which takes minutes. A test that passes here '
      + 'passes on the system too, short of what the open-abap runtime cannot model (see pitfalls, area abap). '
      + 'Needs a build_backend after the deploy that carried the tests.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'the app class whose test classes to run, e.g. zcl_my_app; omit for the whole tree' },
        class_names: { type: 'array', items: { type: 'string' }, description: 'several classes in one run (the deployed apps of a project, say)' },
      },
    },
  },
  {
    name: 'verify_app',
    description:
      'The whole loop in ONE call, stopping at the first stage that fails: validate (the linter\'s gates over the '
      + 'source, seconds), deploy (write the class and its test include into the sandbox, abaplint it), build '
      + '(build_backend mode auto - incremental after the first time), unit (run_unit_tests for the class, when '
      + 'test classes were given) and boot (run_app: the running app, its errors and a screenshot). Returns every '
      + 'stage\'s result under `stages`, `ok`, and `stoppedAt` naming the stage that failed (the call is then an error '
      + 'result, isError) - so one call answers '
      + '"is this app right", and the stage that says no is the one to read. The single tools stay for iterating on '
      + 'one stage; this is for the end of an iteration and for a first look at somebody else\'s class.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'lowercase ABAP class name, e.g. zcl_my_app' },
        abap_source: { type: 'string', description: 'full ABAP source of the class' },
        testclasses: { type: 'string', description: 'optional: the local test classes (see deploy_app)' },
        description: { type: 'string', description: 'short class description (abapGit DESCRIPT; default "MCP dev app <class>" - unique per class, as abaplint identical_descriptions demands)' },
        boot: { type: 'boolean', description: 'run the boot stage (default true; false stops after the unit tests, or after the build)' },
        render: { type: 'boolean', description: 'validate with the render gate (default: what the project config says)' },
        project_dir: { type: 'string', description: 'the project whose abap2ui5lint.jsonc validate judges by (as in validate_view)' },
        timeout_ms: { type: 'number', description: 'boot timeout in ms (default 60000)' },
      },
      required: ['class_name', 'abap_source'],
    },
  },
  {
    name: 'migrate_report',
    description:
      'Convert a CLASSIC ABAP REPORT (REPORT ... PARAMETERS / SELECT-OPTIONS, event blocks, WRITE list, ALV) into an '
      + 'abap2UI5 app class of the abap-cloud-gui addon (inherits z2ui5_cl_cgui_report: selection_screen( ), '
      + 'start_of_selection( ), write( ), alv( ), message( )) - deterministically, by its converter report2cloud. Answers '
      + 'the generated files (class source, abapGit sidecar, local-class includes), the MIGRATION REPORT (markdown: the TODOs, '
      + 'the unreleased tables and APIs to replace for ABAP Cloud with successor hints, what was not carried over, every '
      + 'mapped construct by line) and the REFUSALS (file:row:col and the reason - dynpros, batch input, SUBMIT, native SQL; '
      + 'a refused report yields no class unless `partial`). Pass the .prog.xml as `texts_xml` for the real selection texts '
      + 'and text symbols. `deploy: true` also writes the class with the addon\'s runtime and popups into the dev sandbox, '
      + 'builds the local backend and answers app_start\'s agent snapshot of its selection screen (continue with app_act). '
      + 'For a NEW app use app_guide and scaffold_app instead; this tool is for an existing report.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'the report source, as in <report>.prog.abap' },
        texts_xml: { type: 'string', description: 'optional: the report\'s abapGit <report>.prog.xml - its text pool (selection texts, text symbols, title); without it the texts are placeholders and TODOs' },
        class_name: { type: 'string', description: 'optional: the class to generate (default zcl_ + the report name, e.g. zcl_flights for ZFLIGHTS)' },
        partial: { type: 'boolean', description: 'optional: on refusals, still return the draft class with the refused statements marked (default false)' },
        deploy: { type: 'boolean', description: 'optional: deploy the class (with abap-cloud-gui\'s src/01 - its classes, interfaces and the variant/layout store tables - and the popups it calls) into the dev sandbox, build_backend and app_start it; the answer gains `deploy` with each stage (default false)' },
      },
      required: ['source'],
    },
  },
  {
    name: 'backend',
    description: 'Manage the local express backend serving the transpiled apps: status | start | stop | restart. ' +
      'run_app starts it automatically; use this for diagnostics or to free the port.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], description: 'default: status' },
      },
    },
  },
  {
    name: 'remove_app',
    description: 'Remove a previously deployed dev app from the dev sandbox (takes effect in the served backend after the next build_backend). Without class_name lists the deployed dev apps.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'the dev app class to remove; omit to list deployed dev apps' },
      },
    },
  },
];

/** Every tool name, sorted — what tools/list must answer, in test-comparable
 *  form. Derived, never written out: the count and the names follow the array. */
export const TOOL_NAMES = TOOLS.map((t) => t.name).sort();

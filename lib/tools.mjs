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
    name: 'capabilities',
    description:
      'Query what abap2UI5 can express, from the verified capability map (CAPABILITIES.md — every entry ' +
      'names a proving port). Call this BEFORE deciding a UI5 feature cannot be built. ' +
      'Without arguments returns a summary; with `query` returns matching entries ' +
      '(status: direct | workaround | needs-live-test | not-expressible).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords matched against feature/how/evidence, e.g. "tree binding" or "dialog"' },
        status: {
          type: 'string',
          enum: ['direct', 'workaround', 'needs-live-test', 'not-expressible'],
          description: 'optional filter on the capability status',
        },
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
      + 'READ that class. It is a whole app that compiles, renders and is downported to three '
      + 'releases, which is worth more than any snippet. A repository that is not checked out is '
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
            'optional filter WITHIN abap2UI5/samples. `samples` is the supported set (src/01) and what '
            + 'you normally want; `experimental-or-test` is src/00 — work in progress and apps that '
            + 'exercise the framework from the outside, useful to read, not to copy wholesale.',
        },
        limit: { type: 'number', description: 'maximum entries to return (default 20)' },
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
      + 'what you are looking for. This is the BUILD rulebook; `generation_rules` is the different '
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
      },
    },
  },
  {
    name: 'api_reference',
    description:
      'The client API an app calls at runtime — z2ui5_if_client, parsed live from the framework '
      + 'checkout WITH its ABAP-Doc, so a signature is looked up instead of guessed from training '
      + 'data or fished out of the 669-line interface. Without arguments returns the compact '
      + 'surface: every method one line each (obsolete ones marked — seven methods exist only so '
      + 'old apps keep compiling), the cs_* constant groups (cs_event, cs_view, cs_device, '
      + 'cs_nav_mode) and the named types. With `query` the matching entries come back WHOLE: a '
      + 'method with its full documentation and every parameter (type, default, per-parameter '
      + 'doc), a constant with its path (`cs_event-start_timer`) and value, a type with its '
      + 'fields. Ask it "toast", "follow_up_action", "prevent default", "timer". This answers '
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
      + 'writes nothing itself.',
    inputSchema: {
      type: 'object',
      properties: {
        class: {
          type: 'string',
          description:
            'the app class, lower case, e.g. `zcl_my_app` (^[zy]c[lx]_, letters digits underscore). '
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
        limit: { type: 'number', description: 'maximum pages to return (default 10)' },
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
      'Deploy an abap2UI5 app: writes <class_name>.clas.abap (+ abapGit sidecar) into the gitignored ' +
      'dev sandbox src/zz_dev/ and lints it with the repo abaplint config. The class must implement ' +
      'z2ui5_if_app; ANY customer-namespace class name is accepted (zcl_my_app as much as ' +
      'z2ui5_cl_my_app), so an app of your own keeps the name it has in your repository. After ' +
      'deploying, run build_backend once (rebuilds the transpiled Node backend), then run_app to see ' +
      'it. Set lint:false to skip the lint (faster, not recommended).',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'lowercase ABAP class name starting z or y, <= 30 chars, e.g. zcl_my_app or z2ui5_cl_my_app' },
        abap_source: { type: 'string', description: 'full ABAP source of the class (CLASS ... DEFINITION + IMPLEMENTATION)' },
        description: { type: 'string', description: 'short class description (abapGit DESCRIPT)' },
        lint: { type: 'boolean', description: 'run abaplint after writing (default true)' },
      },
      required: ['class_name', 'abap_source'],
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
      'Rebuild the transpiled Node backend so run_app picks up deployed/edited ABAP. mode auto (default) is ' +
      'incremental when a prior full build exists: only src/zz_dev/ is re-copied and re-transpiled (~1-2 min). ' +
      'mode full runs the complete e2e-build (downport + transpile, tens of minutes) — needed once initially, or ' +
      'when framework/port sources changed, or when the incremental transpile rejects a construct (then simplify ' +
      'the ABAP or go full). Stops a running backend first. Only one build runs at a time: a second call with the ' +
      'same effective mode joins the in-flight build and returns its result; a call with a different mode fails ' +
      'fast with "build in progress" — retry when the running build has finished (a full build is never silently ' +
      'downgraded to an incremental result, and vice versa). Long builds emit MCP progress notifications (at most ' +
      'one per second, carrying the latest build output line) when the call includes a progressToken.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'incremental', 'full'], description: 'default auto' },
      },
    },
  },
  {
    name: 'run_app',
    description:
      'Boot an app class headless in Chromium against the local backend (?app_start=<class>) and LOOK at it: ' +
      'returns booted/ok, real page errors + failed backend calls (benign UI5 noise filtered), and a full-page ' +
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
    description: 'Remove a previously deployed dev app from src/zz_dev/ (takes effect in the served backend after the next build_backend). Without class_name lists the deployed dev apps.',
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

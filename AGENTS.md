# AGENTS.md — mcp-server

Single source of truth for agents working on the **abap2UI5 MCP server** —
the `app_guide → validate_view/screenshot_view → deploy_app → build_backend →
run_app` loop exposed to MCP clients, no SAP system required.

**The loop has a cheap half and an expensive half, and keeping them apart is
the point.** `validate_view` and `screenshot_view` both work from SOURCE
through the linter's render harness: seconds, no backend, no transpile, and
blind to everything that only exists at runtime. `build_backend`/`run_app`
boot the real transpiled app: seconds per build on the npm backend after a
first install (tens of minutes for a full corpus build), and the only place
the ABAP actually runs. A tool that moves work from the second half
to the first is worth more here than almost anything else — the expensive half
is what an agent's feedback loop is made of.

> This entire project is in **English**. No non-ASCII **literal** goes in a
> source file — the CAPABILITIES.md status marks are built with
> `String.fromCodePoint` for exactly this reason (`lib/capabilities.mjs`), so
> a parser's data can never depend on how an editor saved a glyph. Prose is a
> different matter: comments and the tool descriptions have always used em
> dashes and stay as they are. (This paragraph said "source files are 7-bit
> ASCII", which no file in the repo has ever been, `lib/capabilities.mjs`
> included.) **`test/ascii.test.mjs` is the gate**, over `server.mjs` and every
> `lib/*.mjs`: everything above U+007F fails except the prose punctuation
> listed there by code point (em dash, en dash, section sign), each with the
> reason it is allowed. An emoji, an invisible character or a homoglyph letter
> is refused by file and line — build it from its code point instead, the way
> `lib/capabilities.mjs` builds the status marks.

## The one thing to understand first: this repo cannot work alone

mcp-server **bundles no content**. Every tool reads live from sibling checkouts,
resolved per call in `lib/repos.mjs` (explicit env var, then the `../<name>`
sibling of this repo — plus, for abap2UI5, the in-repo `.abap2UI5` clone that
samples-controls' `npm run node:setup` creates). A **set env var is
authoritative**: when it points at a directory without the expected checkout,
the repo resolves to null and the tool reports the misconfiguration — there
is no silent fallback to the sibling guess.

The one thing that is not read from a checkout is the BACKEND when there is
no framework checkout: the npm package `@abap2ui5/node-runtime`, installed
per release into the workspace (see "The expensive half with one checkout —
or none"). It is still not bundled - the server installs the release the
registry (or `A2UI5_MCP_RUNTIME_VERSION`) names, at exact versions, and
reads it live like a checkout.

| Env var | Default sibling | Used for |
| --- | --- | --- |
| `SAMPLES_CONTROLS_HOME` (was `AI_DEMOKIT_HOME`, still read) | `../samples-controls`, `../abap2UI5-api`, `../ai-demokit` | CAPABILITIES.md (re-parsed on every query), `catalogue.json` + `SAMPLES.md` (the control catalogue `examples` searches), `scripts/generation-prompt.txt`, `scripts/scope-of.mjs`, `scripts/e2e-build.mjs`, `abaplint.jsonc`, `src/zz_dev/` (deploy target), `node_modules/@openui5/*` (UI5 runtime for screenshots) |
| `A2UI5_HOME` | `../abap2UI5` | `.claude/skills/{abap-check,ui5-check}/SKILL.md` (`pitfalls`), `docs/agents/building-apps.md` (`app_guide`), `src/02/z2ui5_if_client.intf.abap` (`api_reference`) - and, WHEN a checkout is there, the backend: `node/srv/express.mjs` (backend server), `node/downport/` + `node/setup/abap_transpile.json` (incremental build), `node/output/`. Without one the backend is the npm package `@abap2ui5/node-runtime` (below), and nothing needs this checkout |
| `SAMPLES_HOME` | `../samples`, `../abap2UI5-samples` | `catalogue.json` (preferred) + `SAMPLES.md` (fallback, and the src/00 area) — one of the three catalogues `examples` searches |
| `SAMPLES_STACK_HOME` | `../samples-stack`, `../abap2UI5-samples-stack` | `catalogue.json` (preferred) + `SAMPLES.md` (fallback) — the stack-dependent catalogue (OData, RAP, APC, launchpad) |
| `APP_TEMPLATE_HOME` | `../app-template`, `../abap2UI5-app-template` | `template.json` and the files it lists — what `scaffold_app` serves and renames, and what `add_agent_setup` writes into an existing project by the `agentSetup` key (both are dead without this checkout or its mirror) |
| `DOCS_HOME` | `../docs` | `docs/**/*.md` — the documentation site's sources, searched live by `docs_search` |
| `ABAP_CLOUD_GUI_HOME` | `../abap-cloud-gui` | `tools/report2cloud/lib/{convert,textpool,report}.mjs` — the report converter `migrate_report` imports in-process, with the checkout's own `node_modules` (`npm ci` there; LOCAL only, no mirror - `resolveCloudGui`, not in `RESOLVERS`); with `deploy: true` also its `src/01`, and the popups beside it (`POPUPS_HOME`, else `.deps/popups` of the checkout, `../popups` beside it, its `build/popups` - in that order, `resolvePopups`) |
| `AI_VIEW_CHECK_HOME` | `../linter` (legacy aliases: `../abap2UI5-linter`, `../ai-view-check`) — which for an npm/npx install is ALSO where npm hoists the declared peer `@abap2ui5/linter` (`node_modules/@abap2ui5/{mcp-server,linter}`), then an INSTALLED one elsewhere: `<cwd>/node_modules/…` (app-template's devDependency), the server's own `node_modules/…`, then wherever Node's resolver finds the package from `lib/repos.mjs` (`viewCheckCandidates`, `nodeResolvedViewCheck`) | `validate_view` + `fix_view` + `screenshot_view`: dynamic import of the linter's package `exports` entries `.`, `./findings`, `./config`, `./rule-docs` (via `importViewCheck`) |

One more checkout is read but not by this server: **`OPENUI5_SRC`** (default
`../fork-openui5`, relative to the SAMPLES-CONTROLS checkout, not to this one)
is where samples-controls' `scripts/scope-of.mjs` reads the OpenUI5 JSDoc from,
so `scope_of` needs it as much as it needs the corpus. It used to be named
only inside that tool's description in `lib/tools.mjs`, which is the one place
a maintainer setting a machine up does not look.

Also: `A2UI5_MCP_PORT`, `A2UI5_MCP_OFFLINE=1` (no CDN fallback for UI5, and
no GitHub mirror either), `A2UI5_MCP_CHROMIUM` (browser path; `CHROMIUM_BIN`,
the linter's variable, is read after it — then Playwright's managed browser,
then a system binary, `resolveChromium`),
`A2UI5_MCP_SCREENSHOT_DIR` (where `run_app` and `interact_app` write their
PNGs; default `<tmp>/abap2ui5-mcp-screenshots`, and deliberately not the
install directory — that is inside `node_modules` for an npx/npm install),
`A2UI5_MCP_PREBUILT_URL` (where `build_backend` mode `prebuilt` downloads
from; default the framework release asset, see below), the mirror knobs
`A2UI5_MCP_REMOTE=0` / `A2UI5_MCP_REMOTE_DIR` / `A2UI5_MCP_REMOTE_TTL_MS`
(below), `GITHUB_TOKEN`/`GH_TOKEN` (sent to `api.github.com` only — it raises
the docs tree listing's rate limit; never to `raw.githubusercontent.com`, which
answers a token it rejects with 404, and a token the API refuses is dropped
with a warning), `A2UI5_MCP_WORKSPACE` (where the npm backend installs, its
sandbox lives and a framework clone lands, below; a relative path is taken
from the directory the server runs in, once - `workspaceRoot` resolves it,
because the backend hands its paths to children running elsewhere), `A2UI5_MCP_BACKEND`
(`npm`: the npm backend even beside a framework checkout; `clone`: the
framework clone as the answer to "no checkout", the default before the npm
backend), `A2UI5_MCP_RUNTIME_VERSION` (the `@abap2ui5/node-runtime` release,
X.Y.Z; default the registry's latest - `A2UI5_MCP_OFFLINE` also stops that
question), `A2UI5_MCP_SKIP_NETWORK_TESTS` (the three `npm test` files that
reach the registry - npm-integration, agent-integration and migrate's
deploy test - skip themselves), and the child-process timeouts `A2UI5_MCP_LINT_TIMEOUT_MS` /
`A2UI5_MCP_SCOPE_TIMEOUT_MS` (default 5 min), `A2UI5_MCP_UI` (`auto`/`on`/`off`:
whether the app tools declare their MCP Apps screen, below),
`A2UI5_MCP_APP_FORMAT` (`snapshot`/`adaptive-card`: the app tools' default
answer format, below), `A2UI5_MCP_BUILD_TIMEOUT_MS`
(default 30 min, also the prebuilt download and the npm install) and
`A2UI5_MCP_UNIT_TIMEOUT_MS` (default 10 min, the test runner).

### The read-only GitHub mirror — the cheap half without any checkout

The knowledge tools read committed FILES and nothing else: the guide, the
interface, the two catalogues of pitfalls, the capability map, the porting
brief, three sample catalogues, the docs tree, the template. None of that
needs an npm install or a build, and yet every one of those tools was dead
until three to six repositories had been cloned next to this one — in a fresh
project that is the whole first hour. So `lib/remote.mjs` gives the cheap half
a fallback: when NO local checkout resolves and NOTHING is configured, the
files a tool reads are fetched from `raw.githubusercontent.com` (the docs tree
listed through the repository tree API) into a per-user cache directory that
looks like a checkout — same relative paths, plus a marker file
`.abap2ui5-mirror.json` — and the resolvers hand that directory out as the
repo. Every reader keeps reading files from a root; nothing is bundled or
paraphrased; the copy is at most a day old (`A2UI5_MCP_REMOTE_TTL_MS`).
`lib/repo-dirs.json` names the GitHub repository per key (the `a2ui5` entry
exists for this — the framework's resolver used to carry its names as
literals), `REMOTE_FILES` in `lib/remote.mjs` says which files each mirror
carries, and `REMOTE_TOOLS` which tools trigger which mirror; `server.mjs`
hydrates before the tool runs and before a resource read.

Three rules, each pinned by `test/remote.test.mjs` and
`test/missing-siblings.test.mjs`:

- **A set env var stays authoritative.** `A2UI5_HOME=/nowhere` is a
  misconfiguration to report, never to download around — the mirror is only
  the answer to "nothing configured, nothing next to me", and the
  missing-checkout message says so when an env var is the reason.
- **The mirror is read-only, and the tools that write or build refuse it.**
  `deploy_app`, `read_app`, `remove_app`, `scope_of`, `build_backend`,
  `run_app`, `interact_app`, `run_unit_tests` and `backend start` resolve
  with `{ local: true }` (`missingLocalSiblingMessage` in `lib/siblings.mjs`)
  and never write into or build out of a mirror. `corpus()` and `a2Local()`
  in `lib/runtime.mjs` are the two doors to the sandbox and the backend, and
  both are local-only - a mirror of the framework is simply no checkout, so
  with nothing else there the npm backend runs the apps and the mirror goes
  on serving the guide. `add_agent_setup` is a writer that READS a mirror:
  the template it executes is only read (like `scaffold_app`'s), what it
  writes is the project the agent named - and the one piece of the template
  it would run as code, `scripts/check-pin.mjs` for the pin warning, it
  imports from a local checkout only and skips over a mirror.
- **A failed download degrades to what was there before.** With a cached
  mirror the stale copy stands in (`stale: true`); without one the tool
  degrades with its usual message plus the reason (`remoteStatus`). A
  half-fetched mirror is never written: every file arrives first, then all of
  them are written, then the marker.

`read_example` is the tool that made the mirror worth having: an `examples`
hit is a class name and a path, and an agent without the checkout could not
read it. It fetches single files on demand (`fetchRemoteFile`, under the same
path whitelist `safeRelPath`), from the checkout when there is one.

### The expensive half with one checkout — or none

The corpus used to be a precondition of every tool past `validate_view`, and
then the framework checkout was; neither is any more. **Which backend runs
the apps is decided per call** (`backendKind` in `lib/runtime.mjs`, the pure
half `decideBackend`), from what is there - nothing is remembered but the
checkouts themselves:

- **checkout** - a framework checkout resolves (`A2UI5_HOME`, a sibling, the
  corpus' `.abap2UI5`, or a clone `build_backend` made in the workspace).
  Everything under "With a framework checkout" below applies, unchanged.
- **npm** - no checkout, nothing configured: `@abap2ui5/node-runtime`
  (`lib/npm-backend.mjs`, the next section). The default on a bare machine;
  `A2UI5_MCP_BACKEND=npm` chooses it beside a checkout (which keeps serving
  the guide, the interface and the pitfalls).
- **missing** - `A2UI5_HOME` is set and is not a checkout: reported, never
  built around (the rule every repository follows here; the missing-siblings
  suite pins it).
- **clone** - `A2UI5_MCP_BACKEND=clone` and no checkout yet: the old
  default, `build_backend` clones the release first.

Once a clone exists it IS a checkout: the choice persists as the directory,
and deleting `~/.abap2ui5-mcp/abap2UI5` goes back to the npm default
(`setup_status` says so beside it). `build_backend` mode `prebuilt` and
`transpile` clone when there is no checkout - they genuinely need one - and
are therefore the explicit way to the clone; mode `npm` is refused while a
checkout is the backend in use (it would build a backend nothing serves),
before the running backend is stopped - and the mirror case the same way:
under `A2UI5_MCP_BACKEND=npm` the package stays the backend in use whatever
a build makes, so modes `prebuilt`, `transpile` and `full` are refused
(`npmPreferenceProblem`) instead of building a checkout (or cloning one)
that run_app then ignores while build_backend reports it built.

#### The npm backend - `lib/npm-backend.mjs`, `lib/npm-host.mjs`

WHY: without a checkout, `build_backend` used to shallow-clone the framework
and run `npm ci` there - its whole development toolchain (186 MB of
node_modules for 1.145.0: Playwright, @ui5/cli, eslint, c8, terser) only to
get a transpiler and abaplint - then download the release's backend asset.
Every CI run of every app repository paid that through `abap2ui5-unit`. The
package carries what the loop needs from ONE release commit: `output/` (the
framework transpiled; `init.mjs` boots it), `downport/` (the same commit's
ABAP, what apps are transpiled against), `srv/host.mjs` (`initialize`,
`createHandler`, `createApp`, `serve`) and in its package.json
`abap2ui5.transpiler` (from the release after 1.145.0 also
`abap2ui5.openAbapCore`). The workspace (`A2UI5_MCP_WORKSPACE`, default
`~/.abap2ui5-mcp`):

    runtime/<version>/   package.json + package-lock.json (exact versions),
                         node_modules (--ignore-scripts), apps/, and the
                         install marker .abap2ui5-mcp-runtime.json
    runtime/current.json the release the last build used
    runtime/registry.json the registry's latest, as last asked
    open-abap-core/<sha>/ the standard library, by commit
    sandbox/             the dev apps' sources - outside runtime/, so a new
                         release keeps every deployed app

- **The release**: `A2UI5_MCP_RUNTIME_VERSION`, else the registry's latest -
  asked through `npm view`, so the registry, proxy and CA npm is configured
  with are the ones asked, the same the install then uses: both run in the
  workspace (`npm view` in `runtime/`, the install in `runtime/<version>`),
  so both read the user's npm config and `npm_config_*` - and neither a
  project `.npmrc` of the directory the server was started in (the lookup
  used to, the install never did); cached for the
  mirror's TTL (a cached release the install then cannot find - unpublished,
  or npm pointed at another registry since - is asked again once instead of
  failing every build until the cache expires) - else (offline, or the
  registry unreachable) the newest
  installed release. `currentRuntimeVersion` is the synchronous answer the
  boot, test and status paths use: the pin, the last build's, the newest
  installed. Versions and shas from the registry are validated before they
  become a path or an argument.
- **The install**: the package, express within its peer range (recorded
  exact by `--save-exact`), `@abaplint/transpiler-cli` at
  `abap2ui5.transpiler` (else the package's `@abaplint/runtime` pin - the two
  are released in lockstep) and, for the lint, `@abaplint/cli` at
  app-template's pin (its lockfile, its package.json, then
  `ABAPLINT_CLI_FALLBACK`, said in `setup_status`). Queued per directory, so
  a lint and a build never run two npm processes over one node_modules; a
  complete directory costs two file reads. `abap2ui5-unit`, which does not
  lint, leaves abaplint out.
- **open-abap-core** at the release's commit: `abap2ui5.openAbapCore`, else
  `KNOWN_OPEN_ABAP_CORE` (1.145.0: b2d219df, abap2UI5's `fetch-deps.mjs` at
  tag 1.145.0 = the package's `abap2ui5.commit`), else HEAD resolved to a sha
  and said so. `git init` / `fetch --depth 1 <sha>` / `checkout` into a
  temp dir, `rev-parse` verified, renamed into place: shared by sha, never
  half there.
- **The build** (`buildApps`): the transpiler has no option to leave its
  libraries out of the output - it transpiles and writes every dependency
  object too (737 objects, 1148 files for one app class) - so it writes into
  a staging directory, and `apps/` receives only the files of the sandbox's
  own objects. Their imports of anything else (`const {cx_root} = await
  import("./cx_root.clas.mjs")`) are pointed at the package's `./output/*`
  export (`rewriteImports`): **a second copy of a framework module is the
  bug to avoid** - cx_root's copy would register itself over the package's
  in `abap.Classes`, and every `e instanceof abap.Classes['CX_ROOT']` the
  framework's CATCH compiles to would then miss the exceptions of the first.
  (The package README's own recipe, `import("./output/zcl_my_app.clas.mjs")`
  beside a full transpiler output, has exactly that second copy.) An import
  shape the rewrite does not know fails the build (`strayImports`) instead
  of the boot. `apps/index.mjs` is the transpiler's runner, which lists no
  dependency's tests - the dev apps' alone; `apps/init.mjs` is the ONE boot
  (`initialize()`, `accelerate()` when the release exports it, the dev
  modules in the transpiler's own order) that the runner and the host both
  import. apps/ is swapped in whole, which is what prunes a removed app, and
  a failed build leaves the last good one served.
- **Database tables** (TABL, with their DTELs): a sandbox may hold them -
  `migrate_report { deploy: true }` brings abap-cloud-gui's variant and
  layout stores (`z2ui5_cgui_var`, `z2ui5_cgui_lay`, the default stores
  since its PR #8), and `abap2ui5-unit` brings a project's tables
  (`<name>.tabl.xml` / `<name>.dtel.xml`, their XML alone). They are
  transpiler input (`transpileConfig` input_filter `clas|intf|tabl|dtel`),
  their `*.tabl.mjs` / `*.dtel.mjs` (the `abap.DDIC` registrations) are dev
  modules, and the transpiler's init.mjs - thrown away with the staging -
  holds their `sqlite.push(\`CREATE TABLE ...\`)`: `tableSchema` takes the
  statements of the sandbox's own transparent tables out of it
  (`transparentTables`: `<TABCLASS>TRANSP</TABCLASS>` - a structure is a
  TABL too and has none), and `apps/init.mjs` runs them on the runtime's
  `DEFAULT` connection after `initialize()`, before the dev modules (`IF
  NOT EXISTS`: a table the package already has is left alone). A
  transparent table without a statement fails the build - the transpiler's
  output shape changed. The tables are empty at every boot, like the
  package's own. A sandbox without tables builds and boots byte for byte as
  before. The recipe is abap-cloud-gui's runtime test
  (`tools/report2cloud/test/runtime/backend.mjs`). On a checkout (and the
  clone `build_backend` mode prebuilt makes, which is one) nothing is
  needed: the incremental build copies every file of the sandbox into
  `node/downport`, and the framework's `node/setup/setup.mjs` creates every
  table the transpile found. With `A2UI5_MCP_BACKEND=clone` and no clone yet
  there is no sandbox at all, and the deploy says so (run `build_backend`
  first).
- **The host** (`lib/npm-host.mjs`, spawned by `startBackend` in place of
  `node/srv/express.mjs`): resolves the package from the runtime directory,
  imports `apps/init.mjs`, puts a `compress` export in front of the handler
  when the release has one (an express middleware, or a factory returning
  one), serves on 127.0.0.1, prints a banner (release, dev modules,
  accelerate, compression - `backend status` shows it) and the "Listening
  on" the start waits for. Start, stop, port and orphan handling are the
  checkout's, unchanged.
- **Unit tests**: `apps/index.mjs`, filtered like the checkout's runner.
  NEVER the package's `output/index.mjs` - that is the framework's own suite.
- **Lint**: app-template's `abaplint.jsonc` retargeted
  (`frameworkLintConfig(text, npmLintTarget(...))`): the sandbox as the
  files, the release's `downport/` as the framework dependency; the config
  at the workspace root, abaplint from the runtime directory. The first lint
  on a bare machine installs the runtime.
- **Measured** (this container, cold npm cache): install 10 s, open-abap-core
  1 s, a build 7-8 s (the transpile of the dependency graph - see above - is
  all of it), unit tests 1 s, backend start 1 s.
  `test/npm-integration.test.mjs` runs that whole loop against the registry.

#### With a framework checkout - and what both backends share

- **The dev sandbox has three homes** (`sandbox()` in `lib/runtime.mjs`): the
  corpus' `src/zz_dev` when a corpus checkout is there, the framework
  checkout's `node/zz_dev` otherwise (the framework gitignores it), the npm
  workspace's `sandbox/` when the npm backend is in use. All answer
  `{ kind, root, dir }`, and `deployApp`, `readAppSource`, `removeApp`,
  `listDevApps`, the lint and the builds ask `sandbox()` and nothing else.
  The lint differs per home on purpose: the corpus' relaxed config for the
  corpus (`corpusLintConfig`), and for the framework and npm sandboxes
  **app-template's `abaplint.jsonc`** retargeted at them
  (`frameworkLintConfig`: `global.files` on the sandbox, the framework's
  sources as the local `dependencies[].folder` instead of the clone the
  template asks abaplint for, the customer namespace as the naming rule) -
  the lint a real project runs, read from the template checkout or its
  mirror (`REMOTE_TOOLS.deploy_app` hydrates the template for that one
  read). Measured with a checkout: 2.6 s for a lint, 9 s for the
  incremental transpile, 1.4 s for the class's unit tests. Deploying into
  the framework sandbox is also what found that `deploy_app`'s sidecar had
  no BOM: the template config enables `xml_bom`, the corpus config never
  asked.
- **`build_backend` mode `prebuilt` (and `transpile`) clone the framework
  when nothing is there** (`cloneFramework`): a shallow clone of the latest
  release (the highest plain `X.Y.Z` in the GitHub release list -
  `latestPlainRelease`; not `releases/latest`, which names the `X.Y.Z-702`
  downport the framework publishes seconds after each release; the default
  branch when the list cannot be read) into `A2UI5_MCP_WORKSPACE`, default
  `~/.abap2ui5-mcp/abap2UI5`, which `resolveA2UI5` lists as its last LOCAL
  candidate - a real checkout, not a mirror. Only when no `A2UI5_HOME` is
  set: a set env var that points nowhere is reported, never cloned around.
  `auto` clones only under `A2UI5_MCP_BACKEND=clone`; otherwise no checkout
  means the npm backend.
- **`run_app` serves UI5 from the CDN** when no corpus is there to serve the
  local `@openui5` packages (`libRoots` answers an empty list; `A2UI5_MCP_OFFLINE`
  keeps the hermetic 404) - on either backend.
- **`setup_status`** is the read that says which of the above applies right
  now: per repository local / mirror / missing (with the env var or clone
  that fixes it), the sandbox and what is deployed there, the backend kind
  and why (for npm: the release and where the choice came from, the
  workspace, the transpiler, express and abaplint versions, the
  open-abap-core commit, what apps/ holds and `nextBuild` - what the next
  build_backend would do), built, running, the unit-test runner, the clone
  target, and whether git, tar, npm, npx and a Chromium are on the machine.
  Reads only - no registry, no npm, no git. `test/sandbox.test.mjs` pins the
  sandbox rules against a fake framework checkout under `A2UI5_HOME`,
  `test/npm-runtime.test.mjs` the npm backend's wiring against a fake
  workspace; `test/missing-siblings.test.mjs` pins that the sandbox message
  names both env vars and that `setup_status` answers with every checkout
  absent.

What still needs the corpus: `scope_of` (its script and the OpenUI5 checkout),
`generation_rules` and `capabilities` (mirrored when absent), and
`build_backend` mode `full`.

**`build_backend` mode `transpile`** is the framework's own build
(`transpileFramework`: `npm ci` when the checkout has no node_modules, then
`npm run downport` and `npm run auto_transpile` in it) - what the release
workflow runs to make the asset, run here for a checkout no asset exists for.
Measured: 2 min 16 s on this machine. `auto` takes it when the prebuilt
download answers 404, announced in the log; an explicit `prebuilt` does not.

**`verify_app`** is the loop as ONE call, composed in `server.mjs` out of the
single tools' handlers (`handle('validate_view', …)` and so on — one
implementation per stage, never a second): validate, deploy, build, unit (when
test classes were given), boot; the first failing stage stops it, everything
before it stays in `stages`, `stoppedAt` names it, and a missing linter skips
the validate stage rather than failing it.

**`app_start` / `app_act` / `app_describe` / `app_list`** operate a running
app without a browser: `lib/appclient.mjs` speaks the abap2UI5 JSON protocol
to the backend `startBackend` serves (the app start, then `S_FRONT.ID` /
`EVENT` / `T_EVENT_ARG` plus the model delta, exactly as the UI5 frontend
sends them), keeps per session what the frontend keeps per component (the
views in their five slots, the models and who owns them, the draft id, the
unsent edits - `applyResponse` in `lib/snapshot.mjs`), and answers with the
**agent snapshot v1** `analyzeScreen` derives from the view XML and the
model. The normative snapshot v1 is the semantic profile of
abap2UI5/protocol (`profiles/semantic.md`, moved there from
`docs/agent-snapshot.md`, which points to it and stays the reference for
this implementation) - the VS Code extension and the ABAP agent addon
implement the same shape, so a change to the snapshot is a change to that
page in the same commit (and to the profile), and the shape test in
`test/snapshot.test.mjs` is where it shows. The client follows the
protocol's frontend rules - the `PROTOCOL` check, `sap-contextid` per
session, the CSRF token handshake, one roundtrip at a time per session
(a second `act` with an event queues), the error body verbatim, the
popup/popover teardown on an `APP` change; the protocol's frontend suite
checks them (`abap2ui5-conformance frontend --adapter agent` in an
abap2UI5/protocol checkout, with `MCP_SERVER_HOME` pointing here), and
`test/appclient.test.mjs` has a unit test for each. Three rules:
**validate before sending** (an event that is not an action of the current
snapshot, a field that is not on it or not editable, a choice outside its
values is an error result naming what IS allowed, and a refused act changes
nothing - no blind wiring); **values without an event stay pending**, as
typing does in the browser (the frontend never sends a roundtrip without an
event, and apps branch on `check_on_event`); **a session is bound to the
backend process** that wrote its drafts (`backendGeneration`) - after a
restart it is refused with the reason, never answered with a backend error.
Every local-backend assumption of the client is an option of
`createAppClient` (`transport`, `location`, `generation`, `backendHint` -
docs/agent-snapshot.md "Embedding the client") because the VS Code extension
vendors the three modules unchanged and runs them against a real system: a
new assumption about the local backend goes behind an option with today's
behaviour as the default, never into a code path the extension has to wrap.
The snapshot module is pure and takes the linter's UI5 metadata
(`./properties` `loadSnapshot`) only as an optional refinement for controls
its own table lacks: the tools need a backend, never the linter.
`test/fixtures/agent/*.json` are real request/response pairs of
abap2UI5/samples and samples-controls apps and of abap-cloud-gui's
report2cloud runtime harness (recorded by driving the client against
`@abap2ui5/node-runtime`; the `cgui-*` ones through that harness, with the
popups addon); `test/appclient.test.mjs` replays them and fails
on any request that differs from the recorded one. Re-record them when the
protocol moves (the fixture's `note` says against which release). Values the
browser computes are filled only where the browser's own rule is known and
ported - a selection dialog's pick, the row-valued event parameters, read
with UI5's JSONModel path semantics (`selectedContexts[0]/sPath` is `null`
there, so it is `null` here) - and refused naming `args[i]` everywhere else;
docs/agent-snapshot.md "Row event parameters" is the list.

### The screen in the chat — `lib/mcp-app.mjs`, `lib/adaptive-card.mjs`

The snapshot is the agent's view; two optional surfaces show the same screen
to the USER, and both send what the user does back as `app_act` calls - never
as protocol requests of their own. That is the rule to keep: **a chat surface
is not a second protocol client.** It builds an `app_act` from the snapshot
on screen and lets the client's validation decide, so nothing the snapshot
does not allow can be fired and the agent's session sees every act (an agent
act with the session it last saw is refused naming the current one).

- **MCP Apps** (SEP-1865, `io.modelcontextprotocol/ui`, stable spec
  2026-01-26 in modelcontextprotocol/ext-apps - the source of every key used
  here, not a blog): the three app tools carry `_meta.ui.resourceUri =
  ui://abap2ui5/app-screen` (and the deprecated flat `ui/resourceUri` the
  spec's SDK still writes) when the client's `initialize` advertised the
  extension with `text/html;profile=mcp-app` - the spec's "servers SHOULD
  check client capabilities" - or under `A2UI5_MCP_UI=on`; added in the
  `tools/list` handler (`toolsWithUi`), the TOOLS array stays the one source.
  The resource is in `RESOURCES` (a `ui://` URI, the one entry that is not a
  document and reads no checkout) and carries `_meta.ui` on the listing and
  the read. The page is `lib/mcp-app-view.mjs` inlined verbatim into one HTML
  document (`appScreenHtml`): **no external URL, no network API, no eval, no
  import** - the spec's default CSP when a resource declares no `csp`
  (`connect-src 'none'`, scripts and styles inline only) runs it, and
  `test/mcp-app.test.mjs` fails on anything that would need more (and on
  `</script` or `<!--` in the module, which would break the inline script).
  Why not the UI5 Web Components frontend (abap2UI5/frontend-webcomponent):
  it is a protocol client with its own draft (it would bypass app_act), and
  its build is 106 files / 14.7 MB loaded through dynamic chunk imports,
  which an inline document under that CSP cannot load. The pure half of the
  page (`buildActCall`, `editsFromForm`, `renderScreen`, `createBridge`) is
  tested in Node - every recorded fixture act is rebuilt by `buildActCall`
  and must send the recorded request - and the real page runs once in
  headless Chromium under the default CSP with a host page speaking the
  bridge (skipped without a Chromium).
- **Adaptive Cards**: `format: "adaptive-card"` (or `A2UI5_MCP_APP_FORMAT`)
  appends the card as an embedded resource
  (`application/vnd.microsoft.card.adaptive`) after the unchanged snapshot;
  off by default. Rendered by abap2UI5/protocol's renderer from
  `client.screen(session)` (an additive, read-only method of the client);
  `appCard` adds `session` and a row action's `row` to each Action.Submit,
  `cardSubmitToAct` maps a submitted payload to ONE `app_act`
  (docs/agent-snapshot.md has the table). `test/adaptive-card.test.mjs`
  validates every fixture screen's card against the 1.5 subset and replays
  the fixtures with their acts submitted through the card. A card that
  cannot be rendered costs the card, never the act.

### Vendored code — `lib/vendor/`, `scripts/vendor-adaptive-cards.mjs`

`lib/vendor/adaptive-cards/{render,mapping,submit}.mjs` are COPIES of
abap2UI5/protocol `renderers/adaptive-cards/`, at the commit
`lib/vendor/adaptive-cards/source.json` records, with the sha256 of each.
Rules: never edit a copy - change it upstream and re-vendor (`node
scripts/vendor-adaptive-cards.mjs /path/to/protocol --ref <commit>`); the only
transformation is that the renderer's imports of the protocol repository's
copies of OUR agent modules point back at `lib/` (a copy of a copy would be a
second version of `viewxml`/`snapshot` in one process). `test/vendor.test.mjs`
fails offline on a hash mismatch, a missing header, an unrecorded file or an
import into the protocol tree, and - with a protocol checkout that has the
commit (`PROTOCOL_HOME` or `../protocol`) - when the copies differ from what
the script makes of it (`--check` is the same from the command line). This is
the mirror image of how the VS Code extension and the protocol repository
vendor `lib/{viewxml,snapshot,appclient}.mjs` from here: a change to those
three modules is re-vendored there, and a bump of the renderer here goes
through this repository's tests. The vendored files are under the ASCII gate
too, and they ship (`lib/` is in the package).

### The CI runner — `scripts/ci-unit.mjs`, `action.yml`, the `abap2ui5-unit` bin

The same code as the tools, for a repository's CI and for a terminal: the
framework at the release the PROJECT pins (the `branch` of the abap2UI5
dependency in its `abaplint.jsonc` — the framework its lint already assumes;
`--framework` or, on the npm backend, `A2UI5_MCP_RUNTIME_VERSION` override
it), **on the npm backend by default**: `@abap2ui5/node-runtime` at that
release, installed once into the workspace without `@abaplint/cli` (the
runner does not lint); every class AND interface under the paths
(`collectObjects`) deployed with all of its files as the repository carries
them - source, XML, test include, local-class includes (`writeObjects`,
under the sandbox's name gate). NOT through `deploy_app`'s gate: that one
asks for `z2ui5_if_app`, which refused every helper class - its tests never
ran and the run still exited 0 - and it never deployed an interface or a
locals include. On the npm backend into a sandbox and a build of the run's
OWN (`<workspace>/unit-*`, `runtime/<v>/apps-unit-*`: `buildNpm` with an
`appsName`, which records no `current.json`; `runUnitTests({ appsDir })`),
removed afterwards - an MCP session's sandbox on the same machine used to
be built with the project (its unfinished app failed `npm run test:unit`)
and lost every class the run had tested. ONE build after the deploy
(open-abap-core at the release's commit, the classes transpiled against the
package - the framework never); `runUnitTests({ classNames })` over the
classes that carry tests (all, or the `--class` ones; the generated runner
is filtered to the SET — `filteredRunner`); a markdown summary, also into
`GITHUB_STEP_SUMMARY`. Exit 1 on a failing test, 2 on a build or transpile
failure or an object that could not be deployed (a namespaced name) - never
0 with a class left untested. Which backend is `chooseBackend` (pure, pinned in
`test/sandbox.test.mjs`): a checkout somebody NAMED (`--home`, `A2UI5_HOME`,
a sibling) is used as before, with the incremental build; the clone this
script makes in the workspace only with `--backend clone`
(`A2UI5_MCP_BACKEND=clone`) - a CI cache or a developer's machine that still
carries one from 0.2.0 must not fall back to the slow path by accident. The
clone path is also what a pin gets by itself when the registry has no
package for it (anything before 1.145.0) and what a `--framework` that is a
branch gets, both said in the log.

It imports NONE of this package's dependencies (no playwright, no MCP SDK on
this path), which is what lets `action.yml` - a composite GitHub Action at
the repository root (`abap2UI5/mcp-server@v1`, a floating tag the release
workflow's `move-major-tag` job moves to each release of its major; `@v0`
stays at 0.3.0, the last 0.x) - run it without an
`npm ci`. The action caches `~/.abap2ui5-mcp` per backend and pin (weekly
for an unpinned project, so a new release is picked up) and deliberately
without restore-keys: a restored cache of another pin carries that
release's install into the new key and grows with every bump, while
everything in the workspace heals itself (an install checks its versions,
open-abap-core is stored by commit, the run's own sandbox and build are
removed after it).
Measured against app-template's starter app (three tests), one machine:

|  | clone path (0.2.0) | npm package |
| --- | --- | --- |
| cold (empty workspace, empty npm cache) | 26.9 s + 3.2 s `npm ci` of this package | 16.3 s, no `npm ci` |
| warm (cached workspace) | 23.2 s - the whole framework transpiled twice | 8.2 s |
| workspace | 231 MB | 67 MB |

`package.json` ships the script as a bin of its own, so `npx -p
@abap2ui5/mcp-server abap2ui5-unit src` is the local form. **The bins are a
contract too**: `mcp-server` (the package's unscoped name — what `npx --yes
@abap2ui5/mcp-server` runs; without it npx cannot pick between the others
and refuses), `abap2ui5-mcp` (the explicit form, `npx -p
@abap2ui5/mcp-server abap2ui5-mcp`, which every version answers) and
`abap2ui5-unit`. `test/unit.test.mjs` pins the first, and
`scripts/pack-smoke.mjs` — a release workflow step — runs all three through
npx against the packed tarball. app-template's `check.yml` runs the action and its
`npm run test:unit` the bin — that job and that script are consumers of this
contract: the action's inputs (`paths`, `framework`, `backend`,
`node-version`), the bin's name, its options and its exit codes.
`test/sandbox.test.mjs` pins the pure half (the pin reader, the class
collector, the argument parser, the backend choice, the summary,
`filteredRunner`).

`interact_app`'s hands are proven without UI5: `test/interact-browser.test.mjs`
serves a static page with a wrapper-plus-inner input, two buttons and a
delayed answer, and drives `performAction` through the four actions in the
headless Chromium `run_app` would use (skipped where there is none) — the
view-prefixed id, the inner input, the Tab commit, the click by text, the
wait for text. What it cannot prove is the UI5 page itself, which needs the
CDN or the corpus' packages; that half is the manual one.
`setup.sh --no-corpus` is the setup for the corpus-free loop.

A missing checkout degrades **per tool** (the server still starts;
`resolve*` returns null and the affected tool returns a uniform, actionable
error — which repo, how to clone it, which env var; the repo-and-hint table is
`lib/siblings.mjs`, wrapped by `missingSibling` in `server.mjs` and thrown
as the read error by `lib/resources.mjs`, so tools and resources degrade
with the same words) — `validate_view`/`screenshot_view` need the linter,
`run_app`/`backend`/`run_unit_tests` need a build - on the npm backend no
checkout at all, and the core repo only when `A2UI5_HOME` names one
(`missingBackend` in `server.mjs`) - `pitfalls`, `app_guide` and
`api_reference` need the core repo (their documents and interface are
maintained beside the framework sources; mirrored when absent), almost
everything else needs samples-controls. The README used to call the linter
"optional" — true for every tool but the two that ARE the fast loop, and
therefore the wrong word; its tool table now carries a **Needs** column naming
the sibling each tool is dead without, and that column must keep saying what
this section says. `test/missing-siblings.test.mjs` pins this contract per
tool by pointing every env var at a nonexistent directory.

`examples` is the ONE exception and deliberately so: it reads three
catalogues, and one of them missing is not a reason to refuse the other two.
It answers from what it can read, names what it could not under
`notSearched`, and only fails when all three are absent — a thinner answer to
"has somebody built this" is worth more than a refusal.

### The compatibility surface — renames upstream break tools here silently

These upstream file names/shapes are load-bearing for mcp-server. When one
changes upstream, this repo must change in the same breath:

- samples, samples-controls, samples-stack: **`catalogue.json`**, the
  machine-readable catalogue all three commit at repo root — the file
  `examples` PREFERS when a checkout has it. The three shapes differ per
  repository and each is load-bearing: samples' `samples[]` (class, file,
  category, learning-path `stage`, keywords as an array, docs as bare URLs),
  samples-controls' `ports[]` (entity, library, upstream sample id,
  verification `status` checked/reviewed/generated/collection, `deviations`,
  keywords as one string), samples-stack's `samples[]` (package, `technology`,
  `needs`, keywords as an array). One adapter per repository
  (`lib/examples.mjs` `catalogueEntries`) folds them into the single entry
  shape the row parser produces; a shape change upstream is a change here. A
  JSON that does not parse falls back to the page below, never to an error.
- the same three repos: the `SAMPLES.md` **row shape** —
  `| **title** — sub<br>summary<br><sub>keywords</sub> | [`CLASS`](path) |`.
  All three generate it identically and one parser reads all three
  (`lib/examples.mjs`), so a change to it in any of them is a change here. The
  parser matches the `<br>` blocks as a GROUP and classifies them afterwards
  rather than expecting a fixed sequence — twice now a new block would
  otherwise have made every row unmatchable, and that failure reads as "there
  are no samples for that" rather than as an error. This parser is NOT
  superseded by catalogue.json: it is the whole answer on a checkout from
  before that file existed (which must keep working untouched — that IS the
  compatibility surface), and on a current `samples` checkout it still
  carries the src/00 experimental/test area, which samples' catalogue.json
  deliberately leaves to the page — `examples` merges those rows in so the
  `area: experimental-or-test` filter keeps answering.
- samples-controls: `CAPABILITIES.md` **table format** (4 columns, status emoji —
  parser + legend in `lib/capabilities.mjs`), `scripts/generation-prompt.txt`,
  `scripts/scope-of.mjs` CLI output, `scripts/e2e-build.mjs`, `abaplint.jsonc`,
  the `src/zz_dev/` package convention.
- samples-controls' SAMPLES.md carries its row header entirely in bold with no
  dash after it (`| **sap.m.Bar**<br>…`), which is the shape the row pattern
  had to learn. 241 of its 430 rows used to carry only the LIBRARY there
  (`| **sap.m**<br>…`) rather than the control — an upstream generator gap,
  fixed in samples-controls' `generate-samples-md` (rows now lead with the
  control entity, `| **sap.ui.table.Table** — Basic<br>…`); the row pattern
  reads both the old and the fixed shape, so pre-fix checkouts keep working.
- abap2UI5 core: `node/srv/express.mjs`, `node/setup/abap_transpile.json`
  (its `libs[].folder` entries are what the incremental transpile checks for
  under the checkout before it clones open-abap-core itself), `node/downport/`,
  `node/output/init.mjs`, **`node/output/index.mjs`** (the transpiler's
  generated unit-test runner — `run_unit_tests` filters it on the one loop
  line `for (const st of getData()) {`, `RUNNER_LOOP` in `lib/runtime.mjs`;
  a template change in `@abaplint/transpiler` costs the filter, reported, not
  the run. The runner prints a test's `running` line AFTER the test class's
  class_setup, constructor and setup ran, so a failure there is read off the
  stack - a frame in `<object>.clas.testclasses.mjs` naming the fixture,
  `parseUnitOutput`, with the runner started under `--stack-trace-limit=100`
  so a deep failure keeps that frame - and never pinned on the test printed
  last), the **release asset `backend-<version>.tar.gz`** with
  `backend-manifest.json` at its root (packed by the framework's
  `node/setup/pack-backend.mjs`, attached by `backend-prebuilt.yaml`; the
  name, the three directories and the manifest are the contract
  `downloadPrebuilt` reads — a rename over there is a failed download here,
  reported by URL), the two `.claude/skills/*-check/`
  catalogues, and **`docs/agents/building-apps.md`** — the app-building guide
  `app_guide` serves. Its `## ` headings are the chapters that tool slices on;
  a rename of the file is a broken tool here (reported, not silent — the tool
  names the path it looked in). **`src/02/z2ui5_if_client.intf.abap`** is
  load-bearing the same way: `api_reference` parses it live (`lib/api.mjs` —
  methods, `cs_*` constants, types, the ABAP-Doc and inline notes), relying on
  the abaplint-pinned formatting; a move of the file is reported by path, and
  a formatting change upstream is a parser change here.
- abap2UI5 core: **the frontend wire protocol** the app tools speak
  (`lib/appclient.mjs`, `lib/snapshot.mjs`, `lib/viewxml.mjs`) - the request
  and response format documented at the top of `app/webapp/core/Server.js`
  (`{ value: { S_FRONT: { ID, EVENT, T_EVENT_ARG, ORIGIN, PATHNAME, SEARCH },
  MODEL } }`, `PROTOCOL` 2), the delta format of `core/Lib.js`
  `buildDeltaFromPaths` (ported as `buildDelta`), the `VIEW_SLOTS`
  display/destroy actions and the per-slot model ownership of
  `core/actions/Slots.js`, the toast/box options of
  `core/actions/ControlCall.js` (`onClose`, `actions`), and the event wire
  grammar `z2ui5_cl_ui5_srv_event` writes into view XML (`.eB(['EVENT',
  flags], args)`, `.eBP($event, cond, [...])`, `.eF(...)`, the quoting rule
  for static arguments). A protocol bump upstream is a change here and a
  re-recording of `test/fixtures/agent/`.
- **@abap2ui5/node-runtime** (npm; packed by abap2UI5's
  `node/setup/pack-npm.mjs`): the `.` export's `initialize` and `serve` (and
  `createApp`, for the compress path); the OPTIONAL `accelerate` and
  `compress`, feature-detected - a release without them boots and serves as
  before; the **`./output/*` export**, which every rewritten import of a dev
  module goes through (a narrowed exports map is every dev app failing to
  load, reported by the host as a module not found); `./package.json` - the
  version, `abap2ui5.transpiler`, `abap2ui5.openAbapCore` (from the release
  after 1.145.0; `KNOWN_OPEN_ABAP_CORE` covers the one before), the express
  peer range; `downport/` (the transpile's library and the lint's
  dependency - a move is a failed build and lint); `output/init.mjs` (the
  install check). And the TRANSPILER's output shape, which the build now
  reads rather than merely runs: the `await import("./x.mjs")` lines at the
  start of a line (`rewriteImports`; a shape it does not know fails the
  build through `strayImports`), a runner `index.mjs` that imports
  `"./init.mjs"` (without it the build fails - the runner would boot nothing)
  and lists only non-dependency tests, `init.mjs`'s import order (the boot
  order; sorted when unreadable), and `RUNNER_LOOP`.
- abap-cloud-gui: **`tools/report2cloud/lib/convert.mjs`** (`convert(source,
  { file, className, textpool })` answering `{ ok, className, programName,
  files, draft, refusals, todos, release, notes }`), `textpool.mjs`
  (`parseTextpool`) and `report.mjs` (`migrationReport(result, { source,
  texts })`) - imported by `lib/migrate.mjs`, which checks the three exports
  and answers a checkout without them (or without `npm ci`) as a setup
  message. With `deploy: true` also the layout `src/01` and the popup set of
  the addon's `unit.yaml` (`POPUP_FILES`). A renamed export or a moved file
  over there is a broken `migrate_report` here, said by path.
- docs: the `docs/` markdown tree (everything but `.vitepress`, `public` and
  `node_modules` is a page) and the **published URL scheme** its
  `scripts/generate-llms.mjs` derives — `https://abap2ui5.github.io/docs/<path>`
  plus `.html` for the rendered page and `.md` for the raw twin published
  beside it. `docs_search` (`lib/docs.mjs`) walks the same tree with the same
  exclusions and hands back that URL pair; a change to either upstream is a
  change here.
- app-template: **`abaplint.jsonc`** — the framework sandbox lints with it
  (`frameworkLintConfig` rewrites `global.files`, `dependencies` and
  `rules.object_naming` and keeps everything else), so a renamed key there is
  a lint that judges by other rules here. And **`template.json`** — the template's own description of what a
  project takes from it (the placeholder class, `files.shared` / `files.named`,
  and the substitutions that make them somebody's). `lib/scaffold.mjs` EXECUTES
  that description and keeps no list of its own; a checkout without the file is
  reported (`scaffold_app` says to pull), never guessed at. The template's
  `node scripts/rename.mjs` and the VS Code extension's "New Project from Template" are
  the other two executors — three programs, one description, so a file added to
  the template reaches all three at once. The **`agentSetup`** key of the same
  file (the subset of `files.shared` an EXISTING project takes, which two files
  are merged and how - `json` over named keys, `lines` - the
  `sourceFolder` edits and `existingVariants`) has two executors: the
  template's `create/agent-setup.mjs` (`npm create abap2ui5-app --
  --agent-setup`) and `lib/agent-setup.mjs` (`add_agent_setup`), which ports
  that file's planner rule for rule; `test/agent-setup.test.mjs` compares the
  two plans byte for byte when the sibling checkout has `create/`. A new merge
  kind there is a refusal here ("cannot do - update it") until it is ported.
- abap2UI5/protocol: **`renderers/adaptive-cards/`** - vendored, not read
  live (above); its `renderCard(state, { messages })`, `walk` and `inputsOf`
  and the card's input-id-is-the-binding-path convention are what
  `lib/adaptive-card.mjs` relies on. A re-vendor that changes them fails
  `test/adaptive-card.test.mjs`.
- modelcontextprotocol/ext-apps: the **MCP Apps spec** (2026-01-26) - the
  `ui://` scheme, `text/html;profile=mcp-app`, `_meta.ui.resourceUri`, the
  extension id in the client capabilities, the `ui/*` postMessage methods
  and the default CSP. The wire protocol is unchanged between the SDK's 1.x
  and 2.x; a new spec version is a change of `lib/mcp-app*.mjs` and its test.
- abap2UI5-linter: the package `exports` map entries `.`, `./findings`,
  `./config` and `./rule-docs` (and the shapes behind them: `checkFiles` and
  `screenshotFiles`, `severityOf` / `severityRank` / `SEVERITIES`,
  `findConfigFrom` / `loadConfig` / `applyConfig`, `RULE_DOCS`) — imported
  **via the exports map** by `importViewCheck` in `lib/repos.mjs`, so internal
  file-layout refactors there are safe, but a removed or renamed export breaks
  a tool here even while the linter's own tests stay green. Two of those are
  read **defensively**, because a linter CHECKOUT is an unpinned sibling and
  can be older than this server: a checkout without `screenshotFiles` gets a
  message saying so, and one without `./rule-docs` costs the agent the
  explanations and nothing else. Neither may cost it the findings. The npm
  side is declared since the release after 0.3.0: `package.json` names `@abap2ui5/linter` as a
  peer dependency at `>=0.8.0 <0.9.0` (npm 7+ installs a non-optional peer
  with the server, so `npx -p @abap2ui5/mcp-server` carries the property
  gate; `test/view-check-install.test.mjs` pins that the hoisted install is
  found) and `@abap2ui5/linter-render` as an OPTIONAL peer in the same range
  (a statement of compatibility, never an install - npm does not install
  optional peers, and the 123 MB of UI5 behind it must stay a choice). The
  range is a contract: when the linter's next minor lands, the exports the
  server imports are checked against it and the range moved, the way the
  linter moves its own range for linter-render (`npm run sync-peer-range`
  there). A range that is not moved is a working linter that `npm install`
  refuses with ERESOLVE beside this server - the same for an optional peer
  that IS installed, so making linter-render optional buys the user the
  choice, not a laxer check. `npm install` here installs the root's own
  regular peer too, so a bare checkout's `node_modules/@abap2ui5/linter`
  resolves after the siblings (CI's unit job runs the lintopts and fix-view
  suites against it); the tarball ships none of it.

## Side effects on sibling repos — expected, not a bug

The server **writes into the sibling checkouts**. When you (or another
agent) find these artifacts in a dirty sibling worktree, mcp-server caused them:

- `<samples-controls>/src/zz_dev/*.clas.abap` + `.clas.xml` (+
  `.clas.testclasses.abap` when `deploy_app` was given `testclasses`) +
  `package.devc.xml` — deployed dev apps (`remove_app` deletes them again).
- `<abap2UI5>/e2e-transpile.json` — temporary incremental-build config
  (deleted on close).
- `<abap2UI5>/node/` — a clone of `open-abap-core` during builds; and, after
  `build_backend` mode `prebuilt`, the unpacked release archive:
  `node/downport`, `node/output`, `node/deps` plus `backend-manifest.json`
  at the checkout root (the framework gitignores all four — its
  `backend-prebuilt.yaml` workflow is what packs them).
- `<abap2UI5>/node/downport/<class>.clas.*` — the incremental build's copies
  of the deployed dev apps, listed in `node/downport/.abap2ui5-mcp-dev-copies.json`
  (`syncDevCopies` in `lib/runtime.mjs`). Only files that manifest lists are
  ever removed — once their sandbox source is gone, by the next incremental
  build or by `remove_app` — because the framework keeps its own sources in
  that directory too.
- `<abap2UI5>/node/zz_dev/*.clas.abap` + `.clas.xml` (+ `.clas.testclasses.abap`)
  — the dev sandbox when there is no corpus checkout (gitignored there;
  `remove_app` deletes them again), and `<abap2UI5>/.abaplint-mcp-dev.jsonc`
  while a lint of it runs (removed in a `finally`, queued like the corpus one).
- `<abap2UI5>/node/output/index-mcp-<class>-<pid>-<n>.mjs` (or
  `index-mcp-selection-<pid>-<n>.mjs` for several classes; on the npm
  backend in `runtime/<version>/apps/`) — the filtered copy of the unit-test
  runner `run_unit_tests` writes, one per run (two runs at once must not
  share one), removed in a `finally`.
- `~/.abap2ui5-mcp/abap2UI5` (`A2UI5_MCP_WORKSPACE`) — the framework clone
  `build_backend` mode `prebuilt` or `transpile` (or `A2UI5_MCP_BACKEND=clone`)
  makes when no checkout is there at all: a real checkout with its npm
  install and its unpacked backend - and from then on the backend in use.
- `~/.abap2ui5-mcp/` (`A2UI5_MCP_WORKSPACE`) — the npm backend, not a
  sibling either but written by nobody else: `runtime/<version>/` (an npm
  project of its own - package.json, package-lock.json, node_modules, the
  install marker - and `apps/`, the transpiled dev apps), `runtime/current.json`
  and `runtime/registry.json`, `open-abap-core/<sha>/`, `sandbox/` (the dev
  apps when no checkout is there; `remove_app` deletes them again) and
  `.abaplint-mcp-dev.jsonc` at its root while a lint of that sandbox runs.
  `runtime/<version>/.staging-*` and `.apps-*` exist only during a build,
  `unit-*` and `runtime/<version>/apps-unit-*` only during an
  `abap2ui5-unit` run (with `--keep`, until deleted), `open-abap-core/.tmp-*`
  only during a fetch - unless the process was killed first (a session
  closed mid-build, a SIGKILL, Ctrl+C): their names carry the pid that made
  them, and the next build removes those whose process is gone
  (`sweepLeftovers`; ten minutes' grace, a day at most whatever the pid).
  Deleting any of it is safe: it is installed, fetched or built again.
- the dev sandbox (any of its three homes) after `migrate_report { deploy:
  true }`: the converted class's files and, beside it, every
  `z2ui5_cl_cgui_*` class, interface, table and data element of
  abap-cloud-gui's `src/01` (the variant and layout stores' `z2ui5_cgui_var`,
  `z2ui5_cgui_lay` and their DTELs) and the popups it
  calls (`z2ui5_cl_popup_context`, `z2ui5_cx_popup_error`, `_get_range`,
  `_to_confirm`, `_to_select`, `_input_val`) with all their files - what the
  class needs to transpile and run; `remove_app` takes the classes out one
  by one (the tables' XML stays until deleted by hand).
- the PROJECT an agent passes to `add_agent_setup` (or the server's working
  directory, when that has a `.git`, `.abapgit.xml` or `package.json`) - not
  a sibling, but the one place outside a sandbox or workspace this server
  writes into, and only when asked: the files template.json's `agentSetup`
  lists, new ones only, plus additions to `package.json` and `.gitignore`.
  Never a file the project has (beyond those two merges), never the source
  folder `.abapgit.xml` names, never through a symbolic link out of the
  project, and never the file system root, the home directory, this
  server's installation, the template checkout, the mirror cache or the
  workspace (`agentTargetProblem`).
- `<tmp>/abap2ui5-mcp-remote/<repo>/` — the read-only GitHub mirrors (not a
  sibling worktree, but the same question "where did this come from": a
  directory that carries `.abap2ui5-mirror.json` is one, and deleting it is
  always safe). The default base is under the shared temp dir by a fixed
  name, so it is read and written only while it is a real directory of the
  user's own that nobody else can write - created 0700, refused with the
  reason otherwise (`remoteBaseProblem`, `lib/private-dir.mjs`); a base
  `A2UI5_MCP_REMOTE_DIR` names is not checked.

`<samples-controls>/.abaplint-mcp-dev.jsonc` (the patched lint config for
deployed dev apps, gitignored there) used to be on that list and is not any
more: `lintApp` removes it in a `finally`, so it exists only while a lint is
actually running. It keeps that exact file name because that is the name the
corpus gitignores — which is why `lintApp` QUEUES lints rather than giving each
one a suffix of its own: two concurrent lints over the one path meant the first
to finish deleted the config the second was still being linted against.

## Build & verify

```bash
npm install          # @modelcontextprotocol/sdk + playwright + the @abap2ui5/linter peer (npm 7+ installs a root peer too)
npm start            # run the server on stdio (for an MCP client)
```

```bash
npm test             # node --test: sibling-free units + the stdio smoke
```

`test/unit.test.mjs` covers the units that need no sibling checkout
(stripJsonc, the CAPABILITIES.md parser via its rawText parameter, the
SAMPLES.md row parser, the deployApp/removeApp name gate — including that a
wider namespace is still no way out of `src/zz_dev` — the guide slicer, the
viewport parser, the BENIGN console filter). **Import from `lib/`, never from
`server.mjs`**: that file connects the stdio transport at module scope, so
importing it in a test hangs the run rather than failing it — which is why
`parseSizes` lives in `lib/screenshot.mjs` and not next to the tool that uses
it. `test/missing-siblings.test.mjs` boots the real server with the sibling env
vars pointed at nonexistent directories and asserts every sibling-dependent
tool degrades with its actionable error (this one runs everywhere);
`test/view-check-install.test.mjs` copies `lib/` into the layouts npm leaves
behind (the npx hoist, a nested install, a deeper hoist, a project's own
devDependency) and asserts `resolveViewCheck` finds the installed linter in
each, from a child process with the env var unset;
`test/smoke.test.mjs` boots the real server over stdio (initialize, the full
tool surface,
a capabilities query, the resource list and a resource read, the prompt list
and a rendered prompt) and **skips itself when the samples-controls sibling is
absent**, so `npm test` is green in a bare checkout and exercises the full
path in a sibling workspace. The npm backend has four files:
`test/npm-backend.test.mjs` (the release choice, the pin and the offline
fallback, the install's flags and specs, open-abap-core by sha, the import
rewrite, the build keeping only the dev apps and pruning - against an
injected registry and npm/git/transpiler stand-ins), `test/npm-runtime.test.mjs`
(the wiring - backend choice, the sandbox, the lint's retargeted config,
build/unit/status - against the fake workspace of `test/helpers/npm-fixture.mjs`),
`test/npm-host.test.mjs` (the host through `startBackend`, accelerate and
compress detected, and the server's gates over stdio; ports 4431-4432) and
`test/npm-integration.test.mjs` - the test that reaches the network: the
whole loop against the published package (install, open-abap-core, lint,
build, unit tests, boot, GET and a POST roundtrip), about 30 s cold, skipped
by itself when the registry or GitHub cannot be reached and with
`A2UI5_MCP_SKIP_NETWORK_TESTS=1`. `test/agent-integration.test.mjs` sits
behind the same gate: it builds `test/fixtures/agent-app/zcl_agent_mcp`
(a form, a table with a row action and selection, a popup) and
`zcl_agent_mcp_pick` (a SelectDialog value help, a MessagePopover) on the published
package and operates it through `lib/appclient.mjs` and through the server's
app tools over stdio (about 25 s). The agent snapshot's pure halves are
`test/snapshot.test.mjs` (the parsers, the slot bookkeeping, the snapshot on
the recorded sample sessions of `test/fixtures/agent/`, the contract shape)
and `test/appclient.test.mjs` (the replay of those sessions, every
validation path). CI (`.github/workflows/ci.yml`) runs `npm test`
on every push/PR. **`bench/`** is abap2UI5-bench, a separate package (own
`package.json`, not shipped, not in `npm test`) that measures agents with and
without this server; [bench/README.md](bench/README.md) is its contract, and
`bench-verify.yml` gates changes to it. Manual stdio driving, when a test is not enough:

```bash
node -e '
const { spawn } = require("child_process");
const p = spawn("node", ["server.mjs"], { stdio: ["pipe","pipe","inherit"] });
p.stdout.on("data", (d) => process.stdout.write(d));
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"smoke",version:"0"}}});
send({jsonrpc:"2.0",id:2,method:"tools/list"});
setTimeout(() => { send({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"capabilities",arguments:{query:"popup"}}}); setTimeout(()=>p.kill(),2000); }, 500);
'
```

Expect: an `initialize` result, every tool the TOOLS array defines in
`tools/list`, and capability rows
for "popup". Pure units that are testable without any sibling checkout (add
tests here first): `stripJsonc` (`lib/runtime.mjs`), the CAPABILITIES.md
table parser (`lib/capabilities.mjs`), the class-name/`z2ui5_if_app`
validation in `deployApp`, the `BENIGN` console-noise filter.

## Timing expectations

`build_backend` full build is **tens of minutes** (transpiles the whole
framework); the incremental path is ~1–2 minutes. On the npm backend the
first build installs the release (about 10 s here with a cold npm cache) and
fetches open-abap-core (about 1 s), and every build is 7-8 s - the transpile
of the dependency graph the transpiler cannot be told to skip; its output is
thrown away, but the parse and the type check of the dev apps need it. Set tool/agent timeouts
accordingly — a "hung" build is usually just a slow transpile. Every spawned
child carries its own hard timeout (`spawnWithTimeout` in `lib/spawn.mjs`
kills the whole process tree on expiry): lint and scope default to 5 minutes
(`A2UI5_MCP_LINT_TIMEOUT_MS`, `A2UI5_MCP_SCOPE_TIMEOUT_MS`), the build to 30
minutes (`A2UI5_MCP_BUILD_TIMEOUT_MS`) — raise the env var when a machine is
legitimately slower.

## Maintenance traps (learned, do not repeat)

- The **tool surface has one source: the `TOOLS` array in `lib/tools.mjs`.**
  It used to be duplicated by hand in four places (the `server.mjs` header
  comment, the README table, this file, the test name lists) and each copy
  drifted in its own way — a missing `remove_app` row in the header, counts
  that lagged a tool behind. Now the stdio suites import the derived
  `TOOL_NAMES`, and `test/tool-surface.test.mjs` fails `npm test` when the
  README table or any written-out "N tools" count in the prose stops matching
  the array. Adding a tool therefore means: the array, its `handle` case, a
  README table row — and the gate tells you about every count left behind.
  The server `version` is read from `package.json` at startup and asserted by
  the tests.
- **`server.json` is the MCP Registry listing, and it repeats `package.json`.**
  Its `version`, its npm package's `version` and `identifier`, and its `name`
  (= `package.json`'s `mcpName`, the registry's npm ownership proof) are
  copies, and the registry only notices a drift after npm holds the version
  (`release.yml`'s `mcp-registry` job runs after the publish).
  `scripts/check-server-json.mjs` (`npm run check:server-json`, a CI step,
  a release step, and `test/server-json.test.mjs`) fails on any of them, and
  checks the listed environment variables in BOTH directions against what
  `server.mjs` and `lib/` read (plus `lib/repo-dirs.json`'s overrides): a new
  env var therefore means a `server.json` entry - optional, no `default`,
  since a set variable is authoritative here - or an entry in the script's
  `NOT_LISTED` with the reason. `npm version` syncs the two version fields by
  itself (the `version` script).
- **The resource surface has the same one source: `lib/resources.mjs`.** The
  `RESOURCES` array (plus `RESOURCE_TEMPLATES` for the per-chapter guide) is
  what `resources/list` serves, and the same gate file checks the README's
  Resources table and every written-out "N resources" count against it. Two
  rules are load-bearing: **listing reads no file** (a client may poll it, and
  a missing sibling must not make the list shrink or fail — which is why the
  guide chapters are a template, not enumerated entries), and **a read
  degrades exactly like a tool call** (the `lib/siblings.mjs` message, thrown,
  reaching the client as the read request's JSON-RPC error —
  `test/missing-siblings.test.mjs` pins both). The resources hand over the
  same documents the tools slice; nothing may be bundled or paraphrased here.
- **The prompt surface: `lib/prompts.mjs`, two prompts, deliberately no
  more** — `build-an-abap2ui5-app` and `port-a-ui5-sample`, one per job this
  server serves (the same split app_guide vs generation_rules draws). A
  prompt is an ORCHESTRATION script over the existing tools, never a copy of
  what a tool serves — the gate renders both and fails when a prompt names a
  tool the `TOOLS` array does not define, so a tool rename cannot leave a
  stale prompt behind. Prompts read no sibling checkout (the tools they
  point at carry the degradation), which `test/missing-siblings.test.mjs`
  pins by rendering one with every env var pointed at nowhere.
- **A tool description is the only documentation the agent reads.** It never
  sees this file, the README or a comment — it picks a tool from the sentence
  in `TOOLS`. So two tools that answer neighbouring questions have to say
  which is which IN those sentences: `app_guide` (building an app) against
  `generation_rules` (porting a demo-kit sample), and `screenshot_view`
  (seconds, the view alone) against `run_app` (a build, the running app).
  Both pairs were mis-served exactly this way — `generation_rules` described
  itself as "the canonical rulebook for writing an abap2UI5 app" while
  serving a document that opens "You are porting one official UI5 demo kit
  sample". The same holds for `scaffold_app` (a NEW project, handed back, nothing
  written) against `add_agent_setup` (an EXISTING project, written into):
  that is also why the agent setup is a tool of its own rather than an option
  of `scaffold_app` - different input (a directory, where `class`, `package`
  and `repo` mean nothing, as the create package refuses them beside
  `--agent-setup`), a different side effect, and a result shape of its own
  (`written` / `merged` / `skipped` / `warnings` / `next`) that would
  otherwise have made one tool's answer two contracts under the 1.0 promise.
- **`lib/repo-dirs.json` is THE rename history of the ecosystem**, and this
  repo owns it because this is the component that resolves the repos root.
  Per repo it carries the directory names a checkout can carry (newest first —
  `linter`, then the pre-rename aliases `abap2UI5-linter` and `ai-view-check`;
  `samples-controls`, then `abap2UI5-api` and `ai-demokit`; and so on), the env
  vars that override the guess, and the probe file that proves a candidate
  really is that checkout — plus, where that file alone cannot tell two repos
  apart, an `identify` check on a JSON key (`samples` and `samples-stack` both
  commit `SAMPLES.md`; the linter probe was a bare `package.json`, so any Node
  project in a directory named `linter` resolved as the linter and failed later
  and elsewhere). Those checks only ever rule a candidate OUT, and are skipped
  when the file they read is absent, so a checkout from before `catalogue.json`
  keeps resolving. `lib/repos.mjs` reads it — the constants it still
  exports (`VIEW_CHECK_DIRS`, `CORPUS_DIRS`, …) are views on the JSON, not
  literals. **Add a name here and nowhere else.** The VS Code extension used to
  keep a hand-written second copy in `src/repolayout.ts`; it now snapshots this
  file into `src/data/repo-dirs.json` with a weekly drift gate
  (`npm run repo-dirs:check`, `bump-repo-dirs.yml`), so a rename lands in one
  place and propagates. Dropping an alias still un-finds somebody's working
  checkout — do that only deliberately.
- **An answer has a size limit, and it is the client's.** Claude Code refuses
  a tool result over 25,000 tokens and the agent then sees nothing at all.
  `lib/budget.mjs` (`ANSWER_BUDGET`, about 60,000 characters) is what the
  tools that can grow past it page against — `scaffold_app` (`files`),
  `pitfalls` and `examples` (`offset`) — and each page names the arguments
  that fetch the rest; `test/paging.test.mjs` walks the pages to the end
  over fake checkouts. A tool whose answer can grow with upstream content
  pages the same way, never by dropping content.
- **Never `npx <tool>` inside a checkout.** Under an MCP client stdin is no
  TTY, so npx answers its own install prompt and runs whatever the registry
  holds under that name when the checkout has no local bin — `abap_transpile`
  is an unclaimed npm name, which made the incremental build a
  dependency-confusion hole. `localBin` in `lib/runtime.mjs` resolves a
  checkout's own `node_modules/<pkg>` bin and spawns it with node; a missing
  install is a sentence (`missingBinMessage`), pinned by
  `test/runtime.test.mjs` with an `npx` on PATH that must stay uncalled.
- **Never let a second copy of a framework module into the npm backend's
  runtime.** Transpiled modules register themselves in `abap.Classes` when
  they load, and the framework's CATCH compiles to `e instanceof
  abap.Classes['CX_ROOT']` - a dev module importing its own `cx_root` from a
  full transpiler output replaces the package's class, and every framework
  exception after that is uncatchable. The build keeps only the dev
  objects' files and points every other import at the package's
  `./output/*` (`rewriteImports`); keep it that way when the build changes,
  and keep the failing-build answer to an import shape it does not know.
  The package README's "Your own apps" recipe (`import("./output/...")`
  beside a full output) has exactly this flaw - which is why this server
  does not follow it literally.
- **`KNOWN_OPEN_ABAP_CORE` is for releases that predate
  `abap2ui5.openAbapCore`** - 1.145.0 only. From the release after it the
  package records the commit itself; add an entry here only for a release
  without the field, verified against abap2UI5's `node/setup/fetch-deps.mjs`
  at that release's tag, never from memory.
- **`abap2ui5-unit` must stay dependency-free** - the action runs it without
  an `npm ci` (that is a third of its old cold time). An import of
  `@modelcontextprotocol/sdk`, of `playwright` or of anything under
  `node_modules` on its path breaks every app repository's CI; the lazy
  `import('playwright')` in `lib/runtime.mjs` is only reached by `run_app`.
- The README's setup section and the sibling-layout table above must stay in
  sync — the README is the user-facing copy, this file is the contract.

## Related repositories

| Repository | Relation |
| --- | --- |
| [samples-controls](https://github.com/abap2UI5/samples-controls) | Content substrate: capabilities, rules, scope, deploy target, UI5 runtime — and one of the three `examples` catalogues |
| [samples](https://github.com/abap2UI5/samples) | The pattern catalogue `examples` searches |
| [samples-stack](https://github.com/abap2UI5/samples-stack) | The stack-dependent catalogue `examples` searches |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Runtime substrate: transpiled backend + express server — and the client API `api_reference` parses |
| [app-template](https://github.com/abap2UI5/app-template) | The starter project `scaffold_app` serves and renames, and the agent setup `add_agent_setup` adds to an existing project, both executing the template's own `template.json` (`APP_TEMPLATE_HOME`) |
| [docs](https://github.com/abap2UI5/docs) | The documentation site `docs_search` reads, in source form |
| [abap2UI5-linter](https://github.com/abap2UI5/linter) | `validate_view` implementation (imported via its package `exports` map) |
| [vscode-extension](https://github.com/abap2UI5/vscode-extension) | Registers this server for MCP clients in the editor (`src/mcp.ts`) |

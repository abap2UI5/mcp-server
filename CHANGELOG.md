# Changelog

## Unreleased

- **The app screen in the chat (MCP Apps).** `app_start`, `app_describe` and
  `app_act` name the new UI resource `ui://abap2ui5/app-screen`
  (`text/html;profile=mcp-app`, SEP-1865 stable 2026-01-26) when the client
  advertises the `io.modelcontextprotocol/ui` extension - `A2UI5_MCP_UI=on|off`
  overrides. A host that renders MCP Apps shows the snapshot as a page the
  user can operate: fields, buttons, row actions, editable cells, messages.
  What the user does goes back as `app_act` calls through the host (validated
  like the agent's own) and is reported to the model with
  `ui/update-model-context`. The page is one self-contained HTML document -
  no external URL, no network - so it runs under the spec's default CSP.
- **Adaptive Cards.** `format: "adaptive-card"` on the three app tools (or
  `A2UI5_MCP_APP_FORMAT=adaptive-card`) adds the screen as an Adaptive Card
  1.5 - an embedded resource `application/vnd.microsoft.card.adaptive` - for
  Copilot/Teams-style hosts; off by default. Its submit payloads map to
  `app_act` arguments (docs/agent-snapshot.md). The renderer is
  abap2UI5/protocol's, vendored under `lib/vendor/adaptive-cards` with a
  source record and a sha256 drift test (`scripts/vendor-adaptive-cards.mjs`).
- `createAppClient` gains `screen(session)`: a copy of a session's folded
  state, for renderers other than the snapshot (additive; the vendored
  copies elsewhere keep working unchanged).
- **A deploy lint reports the deployed class's findings only.** They were
  picked from the repository-wide abaplint run by a substring of the path,
  so `z_app` was handed the findings of `zz_app` (any class whose name ends
  in its own) and a clean class failed `deploy_app` - and `verify_app`
  stopped at deploy. Matched on the file name now (`issuesOfClass`).
- **A backend that cannot be spawned fails its start at once.** With no
  `node` on the PATH the server was started with (a desktop client's
  minimal one), the backend child emitted only `error`: an uncaught
  exception, and `run_app` / `app_start` / `backend start` waited 30 s to
  report "did not start" with an empty output. The start now fails with
  the spawn error right away.
- **`read_example` re-fetches a mirrored sample once it is a day old.** A
  file fetched on demand into the GitHub mirror was served from the cache
  whenever the mirror's marker was fresh - and the marker is refreshed by
  every knowledge tool once a day, the on-demand files never - so a sample
  read once stayed at that first copy for good. The file's own age counts
  now (`A2UI5_MCP_REMOTE_TTL_MS`).
- **`server.json` lists `POPUPS_HOME`.** `migrate_report { deploy: true }`
  reads it (through an injectable `env` parameter), and
  `scripts/check-server-json.mjs` only looked for `process.env.X`, so the
  variable was missing from the registry listing without the gate noticing.
  The scan reads `env.X` too.
- **`setup.sh` reuses a corpus checked out as `abap2UI5-api`.** Its list of
  pre-rename directory names left that one out (lib/repo-dirs.json has it),
  so such a checkout was cloned a second time as `samples-controls`. A test
  now holds the script's lists against the JSON.
- **`remove_app` removes every file of the class.** It removed the source,
  the sidecar and the test include, and left the local-class includes
  (`locals_imp`, `locals_def`, `macros`) that `migrate_report { deploy:
  true }` writes - the class disappeared from the deployed-apps list while
  its includes stayed in the next build's input.

## 1.0.0 - 2026-10-03

**1.0 is a stability promise, not a feature release.** This server's tool
names and result shapes are a contract with every agent configuration that
registers it (RELEASING.md, "What a release is for"); from 1.0.0 on that
contract follows semantic versioning, so an unpinned `npx` registration -
the form the README, the VS Code extension and the app template all use -
does not break an agent setup between two 1.x releases:

- **Major** (2.0.0): a tool, resource URI, prompt, bin or GitHub Action input
  removed or renamed; a tool argument removed, renamed, retyped or made
  required; a field of a tool result removed, renamed or retyped, or an
  answer that was a JSON object no longer being one; an environment variable
  removed or renamed; a Node.js floor raised.
- **Minor**: a new tool, resource, prompt, optional argument, result field or
  environment variable; a new backend or mode; the linter peer range moving
  to the linter's next minor.
- **Patch**: fixes, and the wording of tool descriptions, hints and messages.

What the promise does NOT cover, because this server bundles no content: the
documents it serves (the guide, the client interface, the pitfall catalogues,
the capability map, the sample catalogues, the docs) are read live from the
abap2UI5 repositories and change when they do, and the backend runs the
`@abap2ui5/node-runtime` release the npm registry names unless
`A2UI5_MCP_RUNTIME_VERSION` pins one. Human-readable text - a description, a
degradation message, a hint - is for the agent to read, not to parse.

What 1.0 contains:

- **30 tools.** `setup_status` (what works on this machine right now, and
  why not); the knowledge half - `capabilities`, `examples`, `read_example`,
  `app_guide`, `api_reference`, `generation_rules`, `scaffold_app`,
  `docs_search`, `pitfalls`, `scope_of`; the project's own setup -
  `add_agent_setup`; the cheap view half, seconds and no backend -
  `validate_view`, `fix_view`, `screenshot_view`; the dev sandbox -
  `deploy_app`, `read_app`, `remove_app`; the expensive half on a real
  transpiled backend - `build_backend`, `build_log`, `backend`, `run_app`,
  `interact_app`, `run_unit_tests`, and `verify_app`, the whole loop in one
  call; operating a running app without a browser - `app_list`,
  `app_start`, `app_describe`, `app_act`; and `migrate_report`, a classic
  ABAP report as an abap2UI5 app class.
- **Six resources** (`abap2ui5://guide`, `abap2ui5://api`,
  `abap2ui5://capabilities`, `abap2ui5://generation-rules`,
  `abap2ui5://pitfalls/abap`, `abap2ui5://pitfalls/view`) plus the
  per-chapter template `abap2ui5://guide/{chapter}`, and **two prompts**,
  `build-an-abap2ui5-app` and `port-a-ui5-sample`.
- **No checkout needed**: the knowledge tools fall back to a read-only GitHub
  mirror, and the expensive half runs on `@abap2ui5/node-runtime` without a
  framework clone; a sibling checkout or a set `*_HOME` variable still wins,
  and a misconfigured one is reported, never worked around.
- **Three bins** - `mcp-server`, `abap2ui5-mcp`, `abap2ui5-unit` - and the
  composite GitHub Action `abap2UI5/mcp-server@v1`, which runs an app
  repository's ABAP Unit tests without an SAP system. The release workflow
  moves the floating major tag to `v1` with this release; `v0` stays at
  0.3.0, so a workflow pinned to `@v0` keeps working and moves to `@v1` when
  its owner decides to.

- **Listed in the official MCP Registry as `io.github.abap2UI5/mcp-server`.**
  `server.json` describes the npm package (stdio, `npx`) and every
  environment variable the server reads - all optional, none with a default,
  because a set variable is authoritative here. `package.json` carries the
  `mcpName` the registry checks npm ownership by, and the release workflow
  publishes the listing after the npm publish, in a job of its own, logged in
  with GitHub OIDC (no secret) through a pinned, checksum-verified
  `mcp-publisher`. `npm run check:server-json` (CI, the release workflow and
  `npm test`) fails when `server.json`'s versions, package name or registry
  name drift from `package.json`, or when its variable list and the code
  disagree in either direction; `npm version` keeps the versions in step by
  itself (the new `version` script).
- **One-click install in the README**: VS Code and VS Code Insiders badges, a
  Cursor badge and the direct `vscode:` / `cursor://` links beside the
  `claude mcp add` line - all registering `npx --yes -p @abap2ui5/mcp-server
  abap2ui5-mcp`, which `test/install-links.test.mjs` decodes from every link
  and holds against the registration the README shows in clear - and the
  Claude Code plugin (`/plugin marketplace add abap2UI5/abap2UI5`, `/plugin
  install abap2ui5@abap2ui5`), which bundles the framework's agent skills with
  this server.
- **The linter is a declared peer dependency, and `npx -p @abap2ui5/mcp-server`
  brings it along.** The server had no dependency on `@abap2ui5/linter` at
  all: the registration every document gives installed a server whose
  `validate_view`, `fix_view` and `screenshot_view` were dead unless the user
  also typed `-p @abap2ui5/linter -p @abap2ui5/linter-render` (the VS Code
  extension 0.30.1 grew a warning for exactly this). `package.json` now names
  `@abap2ui5/linter` as a regular peer at `>=0.8.0 <0.9.0` - npm 7+ installs
  a non-optional peer by itself, for `npm install` and for `npx -p` alike,
  hoisted beside the server where the sibling lookup already finds it, so
  the plain one-liner carries the property gate (1.9 MB) - and
  `@abap2ui5/linter-render` as an optional peer in the same range: the
  compatible range is declared, the 123 MB of UI5 behind the render gate is
  not installed for you (npm never installs an optional peer); add
  `-p @abap2ui5/linter-render` for `screenshot_view`. The resolver gained a
  last candidate after the checkout siblings, the project's and the server's
  own `node_modules`: the `@abap2ui5/linter` Node's own module resolution
  finds from the server's location, for a hoist the explicit paths cannot
  name. `test/view-check-install.test.mjs` pins the npx layout, a nested
  install, that deeper hoist and the project's own devDependency against
  copies of `lib/`. The missing-linter hints and the README say what npm
  installs and what it only declares.

- **`add_agent_setup`: an existing project set up for AI work.** What
  `npm create abap2ui5-app -- --agent-setup` does, for any MCP client's
  agent: app-template's `template.json` `agentSetup` key, executed over the
  project directory the agent names (`project_dir`; the server's working
  directory by default, when it has a `.git`, `.abapgit.xml` or
  `package.json`) - AGENTS.md, CLAUDE.md, the agent skills, `.mcp.json`, the
  `.claude` allowlist, `abaplint.jsonc` and `abap2ui5lint.jsonc`, the CI
  workflow and the scripts it runs. A file the project has is never
  overwritten (skipped, and named); `package.json` and `.gitignore` are
  merged and only gain entries, every value kept that differs from the
  template's a warning; the configs follow the project's `.abapgit.xml`
  `STARTING_FOLDER`, and nothing is written into that folder; a second run
  changes nothing; `dry_run` answers the same report and writes nothing. The
  answer: `written`, `merged` (with what was added), `skipped` (with why),
  `warnings` (kept values, an `abaplint.json` beside the new `abaplint.jsonc`,
  a missing source folder, the framework pin `check:pin` would fail on) and
  `next`. The template comes from the checkout or the read-only mirror, as
  for `scaffold_app`; every path it lists is checked before anything is
  written (a plain relative path, a shared file of the template, outside the
  source folder - else the whole call refuses), a symbolic link is never
  written through, and the file system root, the home directory, the
  server's installation, the template, the mirror cache and the workspace
  are refused as targets. A tool of its own rather than an option of
  `scaffold_app`, which hands a NEW project back and writes nothing.
  `lib/agent-setup.mjs` ports the template's `create/agent-setup.mjs`
  planner; `test/agent-setup.test.mjs` drives the tool over stdio (a fresh
  directory, an existing project skipped and merged, another
  `STARTING_FOLDER`, idempotence, the refusals, symbolic links, the pin
  check) and compares its plan byte for byte with the create package's when
  an app-template checkout is beside this repository.
- **Every abap2UI5 app is agent-operable: `app_list`, `app_start`,
  `app_describe`, `app_act`.** `interact_app` drives an app with CSS
  selectors in a headless Chromium and answers with a picture; the new tools
  speak the abap2UI5 JSON protocol itself against the local backend - the app
  start, the event with its arguments, the model delta of what was typed,
  exactly as the UI5 frontend sends them - and answer with an **agent
  snapshot v1**: the fields an agent may fill (model path, label, kind,
  value, choice values, required, editable), the actions it may fire (event
  name, static arguments, row-dependent ones as `$row:FIELD`), the tables
  (columns, the first rows, selection mode, editable cells), the messages
  (toast, message box, MessageStrip, value states, the app's message table)
  and some static text, from the view XML of every open slot (main, nested,
  popup, popover) and the model. An act is validated against the snapshot
  before anything is sent - an unknown event, a field that is not on the
  screen or not editable, a choice outside its values is refused naming what
  is allowed; values without an event stay pending, as typing does in the
  browser; the popup close the browser performs alone is `@CLOSE_POPUP`.
  `app_describe` answers from the last response kept, no roundtrip.
  `lib/snapshot.mjs` (pure: the frontend's slot and model bookkeeping, and
  the snapshot), `lib/viewxml.mjs` (the view, binding, expression and
  event-wire parsers) and `lib/appclient.mjs` (the roundtrips, sessions and
  validation); the linter's UI5 metadata, when it resolves, classifies
  controls the snapshot has no entry for. The shape is shared with the VS
  Code extension and the ABAP agent addon: `docs/agent-snapshot.md` is its
  reference, including where it deviates from the contract it started from
  (no `/XX/` two-way prefix in the current protocol, pending values,
  `selectionField`, `@CLOSE_POPUP`) and what it cannot see yet.
  `test/snapshot.test.mjs` and `test/appclient.test.mjs` run on eleven
  recorded sample sessions (`test/fixtures/agent/`, real request/response
  pairs of abap2UI5/samples apps on `@abap2ui5/node-runtime` 1.146.0) - the
  replay insists on the exact request the real run sent;
  `test/agent-integration.test.mjs` operates a form, a table with a row
  action and selection, and a popup on the published runtime, through the
  client and through the server over stdio (network-gated like
  `test/npm-integration.test.mjs`).
- **The app client embeds without wrappers.** `createAppClient` takes
  `transport` (one roundtrip: the serialized request with its headers,
  timeout signal and the draft id it continues in, `{ status, headers?,
  body }` out), `location` (the app start's ORIGIN/PATHNAME/SEARCH),
  an optional `generation` (absent: no restart detection) and `backendHint`
  (the words after "the backend did not answer (...)"). The defaults are the
  local backend's, so the MCP server's requests and refusals are unchanged
  (the recorded sessions replay as before); the VS Code extension, which
  vendors the client for a real SAP system, drops the request rewriting and
  message patching it needed. `docs/agent-snapshot.md` "Embedding the
  client" is the reference; `test/appclient.test.mjs` covers every option.
- **`migrate_report`: a classic ABAP report as an abap2UI5 app.** The source
  of a report (and optionally its `.prog.xml` text pool and the class name)
  in; the class of the abap-cloud-gui addon out - `INHERITING FROM
  z2ui5_cl_cgui_report`, the selection screen as `selection_screen( )`, the
  event blocks as its methods, the list as `write( )`, the ALV as `alv( )` -
  with the migration report (TODOs, unreleased tables and APIs with their
  successors, what was not carried over, every mapped construct) and the
  refusals (`file:row:col` and the reason; no class unless `partial`). The
  converter is the addon's `report2cloud`, imported from an abap-cloud-gui
  checkout (`ABAP_CLOUD_GUI_HOME` or `../abap-cloud-gui`, `npm ci` done) -
  not bundled, not on npm, and reported with the clone command when it is
  missing (`lib/siblings.mjs`, `setup_status` lists it). `deploy: true`
  writes the class with the addon's `src/01` and the popups it calls into the
  dev sandbox, builds the backend and answers `app_start`'s snapshot of the
  selection screen, stage by stage like `verify_app`. `lib/migrate.mjs`;
  `test/migrate.test.mjs` converts a fixture report and a refused one (skipped
  without the checkout) and runs the deploy on `@abap2ui5/node-runtime`
  through Execute (behind the network gate).
- **Agent snapshot: selection dialogs and message lists.** `SelectDialog`
  and `TableSelectDialog` are tables now (`control` names them,
  `selectionMode` from `multiSelect`, the dialog's `title` titles its layer),
  and their `confirm` is a row action: `app_act({ event, row })` picks the row
  as a click does - its `selectionField` (`selected="{ZZSELKZ}"`) set, the
  other rows' cleared in single select, all sent as the model delta - and
  fills the confirm's `$parameters` from the selected rows
  (`selectedItem`, `selectedItems`, `selectedContexts`). The row-valued
  parameters of table row events (`listItem`, `rowIndex`, `rowContext`,
  `rowBindingContext`, a row action item's `row`) are filled from `row` too,
  for the shapes views write (`.getBindingContext().getProperty('X')`,
  `.getPath()`, `.get<Prop>()`, `.getCells()[n].get<Prop>()`, the `? :`
  guard); paths follow UI5's JSONModel, so `selectedContexts[0]/sPath` is
  `null` as in the browser. Anything else is refused naming `args[i]`. The
  items of a `MessagePopover` / `MessageView` are messages with `source`
  `popover` / `messageview` and the optional `subtitle` and `description`.
  All additive - `snapshotVersion` stays 1, and `docs/agent-snapshot.md` now
  says what may change within a version. New recorded sessions: samples-
  controls 623 (SelectDialog), samples 452 (MessageView, MessagePopover) and
  two abap-cloud-gui report2cloud reports (the F4 TableSelectDialog of the
  popups, the message popover); the agent integration test picks a row
  through `app_act` on `@abap2ui5/node-runtime`.
- **The agent client follows the protocol's frontend rules** (abap2UI5/protocol
  frontend suite, adapter `agent`: 53 pass / 5 MUST failures / 3 warnings
  before, 61 pass / 0 / 0 now; the 20 skips are capabilities a client without
  a browser does not have). `lib/appclient.mjs`: a response declaring a
  `PROTOCOL` other than 2 is refused whole - its draft id, view and model -
  with both numbers named (an absent one is let through); the last
  `sap-contextid` response header of a session is sent with every later POST
  of that session (never empty, never `undefined`; a response without it
  keeps it), so a stateful ABAP app keeps its work process; a token layer's
  `403` + `X-CSRF-Token: Required` is answered by a `HEAD` token fetch and
  one re-send of the same body, the token then sent with every POST (a `403`
  without `Required` stays final); one roundtrip at a time per session - an
  `app_act` with an event while another is in flight waits for it and runs on
  the draft id it left, instead of posting the same draft id twice; a
  roundtrip clears only the edits it carried, so values set while it is in
  flight stay pending, survive its model push and travel next (a failed one
  rolls back only its own edits); the error body is shown verbatim - no tag
  stripping, no entity decoding, only shortened (40 lines, 4000 characters)
  and control characters shown as U+FFFD. `lib/snapshot.mjs`
  `applyResponse`: a response of another `APP` tears the popup and the
  popover down. **Embedders:** the `transport` option now also receives
  `method` (`'POST'`, or `'HEAD'` for the token fetch, without a body) and
  the `sap-contextid` / `x-csrf-token` headers to send; the client reads
  both from the answer's `headers` and does the handshakes itself, so a
  transport must not repeat them. New exports: `PROTOCOL`, `headerOf`,
  `validContextId`. `docs/agent-snapshot.md` points to the normative
  semantic profile (abap2UI5/protocol `profiles/semantic.md`).
- **Database tables in the npm backend's sandbox.** A sandbox's transparent
  tables (TABL, with their data elements) are transpiled with the classes
  and created in the runtime's SQLite database at boot: the build takes
  their `CREATE TABLE` out of the transpiler's init.mjs and `apps/init.mjs`
  runs it after the package's boot, before the apps load (a structure is a
  TABL too and creates nothing; a sandbox without tables builds and boots as
  before; a transparent table the transpiler wrote no statement for fails the
  build with that reason). `migrate_report { deploy: true }` deploys
  abap-cloud-gui's tables and data elements with its classes - since its
  PR #8 the variant and layout stores (`z2ui5_cgui_var`, `z2ui5_cgui_lay`)
  are the default, and the deploy failed at app start with `Void type:
  Z2UI5_CGUI_VAR`; `abap2ui5-unit` deploys a project's `*.tabl.xml` /
  `*.dtel.xml` too, so a class under test can INSERT and SELECT its own
  tables (`test/fixtures/table-app`, run in `test/npm-integration.test.mjs`).
  A framework checkout (and the clone of `A2UI5_MCP_BACKEND=clone`, once
  `build_backend` made it) already created every deployed table through the
  framework's own setup; without a clone yet there is no sandbox, as before.

## 0.3.0 - 2026-09-30

- **npm 12.** `npm view --json` prints an array there, and the registry
  lookup read it as an object without a `version`: every lint, build and
  unit run without a pinned release failed with "the registry could not be
  asked". The lookup takes both shapes.
- **The expensive half runs on the npm package `@abap2ui5/node-runtime` -
  no framework clone.** Without a framework checkout, `build_backend`
  shallow-cloned abap2UI5 and ran `npm ci` of its devDependencies there
  (205 packages, 186 MB of node_modules for 1.145.0: Playwright, @ui5/cli,
  eslint, ...) just to get a transpiler and abaplint, then downloaded the
  release's backend. The default backend without a checkout is now the
  package: installed once per release into
  `~/.abap2ui5-mcp/runtime/<version>` with the transpiler it records,
  express within its peer range and app-template's abaplint for the lint -
  exact versions, a lockfile, `npm --ignore-scripts`; open-abap-core fetched
  with git at the commit the release was built with; and every build
  transpiles ONLY the deployed apps against the package (7-8 s), whose
  imports of framework modules are pointed at the package's own so the
  runtime never holds a second copy. `deploy_app` (into
  `~/.abap2ui5-mcp/sandbox`, linted with app-template's config against the
  package's sources), `build_backend`, `run_app`, `interact_app`,
  `run_unit_tests` (the apps' own tests, never the framework's suite) and
  `verify_app` need no checkout at all. The release is the registry's
  latest, asked through npm and cached a day, unless
  `A2UI5_MCP_RUNTIME_VERSION` pins one; a release that exports `accelerate()`
  or `compress` gets them used. A framework checkout (`A2UI5_HOME`, a
  sibling, a workspace clone made earlier) keeps every behaviour it had;
  `A2UI5_MCP_BACKEND=npm` runs on the package beside one, `=clone` restores
  the clone as the default, `build_backend` mode `npm` builds on it
  explicitly and modes `prebuilt`/`transpile` clone the framework when there
  is no checkout. `setup_status` reports which backend is in use and why,
  and for the package the release, workspace, tool versions, open-abap-core
  commit and what the next build would do. Measured here, cold npm cache:
  the install 10 s, the first build 8 s, a warm build 7 s, the unit tests
  1 s.
- **`abap2ui5-unit` and the GitHub Action run on the package too.** Against
  app-template's starter app: 16.3 s cold and 8.2 s warm, where the clone
  took 26.9 s plus 3.2 s for the action's `npm ci` and 23.2 s warm (the
  whole framework was transpiled twice per run); the workspace is 67 MB
  instead of 231 MB. The action no longer runs `npm ci` - the script
  imports none of this package's dependencies - takes a `backend` input and
  caches the workspace per backend and pin. The release is `--framework`,
  else `A2UI5_MCP_RUNTIME_VERSION`, else the project's `abaplint.jsonc`
  pin, else the latest; `--backend clone` keeps the old path, which a pin
  without a package (before 1.145.0) and a branch take by themselves. A
  workspace clone an earlier version left behind is no longer picked up
  unless the clone is asked for.
- **`abap2ui5-unit` tests every class, and a class it cannot test fails the
  run.** It deployed each class through `deploy_app`'s gate, which asks for
  `z2ui5_if_app`: a helper or model class was reported "not deployed", its
  tests never ran - and the run exited 0, a green CI over a failing test.
  Interfaces and local-class includes were never deployed at all, so a class
  using one did not transpile. Every class and interface under the paths is
  now deployed with all of its files as the repository carries them, `--class`
  narrows the tests that run (not what is deployed), and an object that
  cannot be deployed (a namespaced name) exits 2. On the package the run
  builds in a sandbox of its own: it used to share the MCP server's, so an
  unfinished app an agent had deployed failed `npm run test:unit`, and the
  run deleted the session's copy of every class it had tested.
- **A failing `setup` or `class_setup` is reported as its own class's
  failure.** The generated runner prints a test's line only after the test
  class's constructor and `setup` ran (and `class_setup` before the class's
  first line), and the failure was pinned on the test printed last: another
  class's PASSING test showed as failed in `run_unit_tests` and in the
  `abap2ui5-unit` summary, and the class whose fixture threw read "a test
  include, but the runner found no test method". The stack now names the
  fixture (`failed.fixture`, with the method that threw), and the runner
  keeps 100 stack frames instead of 10, so a failure deep in the code under
  test keeps the test class's frame. `run_unit_tests` on a class whose
  `class_setup` threw no longer answers "no test class of X in the built
  backend - deploy_app with testclasses": that hint is for a run that passed.
- **`build_backend` refuses a checkout build under
  `A2UI5_MCP_BACKEND=npm`.** Mode `npm` was already refused beside a
  checkout in use, but the mirror case went through: with the package
  chosen as the backend, modes `prebuilt`, `transpile` and `full` built a
  checkout (or cloned one first) and answered `built: true`, while
  `run_app` and `run_unit_tests` kept running on the package and said
  "backend not built". They are refused now, before a running backend is
  stopped, and `setup_status`'s hint no longer suggests them there.
- **A relative `A2UI5_MCP_WORKSPACE` works.** It was used as given, and the
  npm backend hands workspace paths to children that run in another
  directory: with `A2UI5_MCP_WORKSPACE=.abap2ui5-mcp` the lint and the
  transpiler failed with "Cannot find module" on a doubled path. It is
  resolved against the directory the server runs in now.
- **`deploy_app` refuses a name the framework or the corpus already
  defines.** The customer namespace a dev app may use holds the
  framework's own `z2ui5_*` classes and interfaces too, and `zcl_sicf`, the
  ICF handler every host boots. A dev app of such a name was written and
  built beside the original: a second copy that failed the transpile, or -
  on a checkout, whose incremental build copies the sandbox over the output
  - replaced the framework's class in what the host served. The name is
  checked against the release's `downport/` (npm backend), `src/` and
  `node/srv/` of a checkout, and the corpus' own samples, and the refusal
  says where the original is.
- **On Windows a timeout or a cancel ends the whole child tree, and no
  console window opens.** Windows has no process groups, so killing a child
  ended that child alone - and npm runs through `cmd.exe` there, so a
  timed-out or cancelled install ended the wrapper while npm and the git it
  started kept running, holding the output open: the call returned only
  when they had finished on their own. The tree is ended with `taskkill /T`
  now. And a server a desktop client starts has no console, so every child
  it spawned (npm, git, the transpiler, the backend) opened a console window
  of its own; they are started hidden.
- **`setup_status` names the abaplint install the next build makes.** After
  `abap2ui5-unit` installed a release (without the lint's `@abaplint/cli`),
  or after app-template moved its pin, the next `build_backend` ran an npm
  install that `nextBuild` did not mention.
- **A build killed half-way no longer leaves its output behind for good.**
  The npm backend's build, open-abap-core fetch and `abap2ui5-unit` run
  clean up in a `finally` that a killed process never reaches - and closing
  the MCP session mid-build is such a kill: every one left a staging
  directory of up to 22 MB in `~/.abap2ui5-mcp/runtime/<version>`. Their
  names now carry the process id, and the next build removes those whose
  process is gone.
- **A cached "latest" the registry no longer has is asked again.** The
  registry's latest release is cached a day; when the release it named
  could not be installed any more (unpublished, or npm pointed at another
  registry since), every lint and build failed with npm's "notarget" until
  the cache expired. The registry is now asked again, once, and the release
  it names now is installed. A pinned release is never swapped for another.
- **The registry lookup and the install read the same npm config.** `npm
  view` ran in the directory the server was started in, the install in the
  workspace: a project `.npmrc` there decided which registry was asked for
  the latest release, never which one it was installed from. Both run in
  the workspace now and follow the user's npm config and `npm_config_*`.
- **The GitHub Action no longer runs its `paths` input as shell code.** The
  test step read `set -- ${{ inputs.paths }}`, and the runner pastes an
  expression into the script before bash parses it: a `paths` of
  `src; exit 0 #` passed the step without running a test, and any `$`, `;`
  or backtick in a path was code. Every input now reaches the scripts
  through `env:`, and the pin and backend the cache key is made of are
  reduced to a name before they go to `$GITHUB_OUTPUT` (a newline in the
  `framework` input was a second output line).

- **Answers fit the client.** Claude Code refuses a tool result over 25,000
  tokens, and three defaults went far over: `scaffold_app` (~280 KB, the
  whole template), `pitfalls` without a query (~120 KB) and `examples` with a
  large `limit` (~135 KB at 200). Each is now paged at about 60,000
  characters (`lib/budget.mjs`) and names the arguments that fetch the rest:
  `scaffold_app` returns every file that fits, smallest first (the class,
  its sidecar and the configs always), lists the others under `remaining`
  and takes them back through the new `files` argument; `pitfalls` pages by
  whole section and `examples` by entry, both with a new `offset`. `examples`'
  `matches` is now the total, with `returned` for the page.
- **`setup_status` sees a Playwright-managed Chromium.** It only probed three
  hard-coded paths (one of them the `/opt/pw-browsers` link of a sandbox
  image) and reported a machine with `npx playwright install chromium` done
  as having no browser. `resolveChromium` asks Playwright for its own
  executable after `A2UI5_MCP_CHROMIUM` and `CHROMIUM_BIN` (the linter's
  variable, now honoured by `run_app` too), keeps the system paths as the
  fallback with the sandbox link last, and `setup_status` reports the source.
- **A failed `verify_app` is a failed call.** It answered `isError: false`
  with `ok: false` inside when a stage stopped it; a client going by the
  protocol's flag saw it green. `isError` is now set whenever `stoppedAt` is.
- **String arguments are checked against the schema.** `capabilities` with
  `{ query: 42 }` answered "query.toLowerCase is not a function"; every
  argument a tool's schema declares a string is now refused by name when it
  is not one, once, before any handler runs.
- **Three wrong pointers.** `generation_rules` linked
  `docs/cookbook/overview`, a page the site never had (now the cookbook's
  index; a test checks every docs link against a local docs checkout);
  `scaffold_app`'s schema advertised `^[zy]c[lx]_` while the template enforces
  `^z(cl|cx)_`; and `run_unit_tests`' `class_names` errors showed the example
  `["sap.m.Wizard"]`, which is `scope_of`'s.
- **`validate_view` keeps the property findings when the render gate cannot
  start.** Without `@abap2ui5/linter-render`, or with a Chromium that will not
  launch, the linter throws, and the tool returned that throw - an error or
  5 KB of Playwright's ANSI launch log - instead of the findings the property
  gate had already computed. It now repeats the check with `render: false`,
  says why in `notes` and `renderSkipped`, and answers.
- **The project's own linter is found.** app-template ships
  `@abap2ui5/linter` as a devDependency, yet the server started in such a
  project said "linter checkout not found - clone it as a sibling". After the
  sibling checkouts, `<cwd>/node_modules/@abap2ui5/linter` and the server's
  own `node_modules` are candidates now; the missing-linter message and the
  README's Level 1 name all the ways in, including
  `npx -p @abap2ui5/mcp-server -p @abap2ui5/linter -p @abap2ui5/linter-render
  abap2ui5-mcp`. The README's "~3 MB" for Level 1 was the linter without its
  render runtime; with it (the `@openui5` libraries and Playwright) the
  install is ~150-200 MB, and it now says so.
- **The framework clone is the release, not its 7.02 downport.** Without a
  checkout, `build_backend` and an unpinned `abap2ui5-unit` cloned the tag
  GitHub's `releases/latest` names - and the framework publishes every
  version twice, `X.Y.Z` and seconds later `X.Y.Z-702`, so "latest" was the
  downport (downported sources, no prebuilt backend). The release list is
  read instead and the highest plain `X.Y.Z` taken.
- **`scaffold_app` escapes what it writes.** The package text and the
  repository name were spliced into the XML sidecars and `package.json` raw,
  as a `String.replace` replacement string: `R&D <tools>` produced
  unparseable XML, `my"repo` an unparseable `package.json`, and `$&` was
  expanded into the matched text. Both are now escaped for the format they
  land in and substituted through replacer functions.
- **The mirror stays inside its directory.** The template mirror joined
  every path `template.json` lists (and the docs mirror every path the tree
  listing names) onto the cache directory unchecked, so an entry like
  `../../x` was fetched and written outside it. Listed paths now pass the
  same whitelist as an agent's path; one bad entry refuses the mirror.
- **A stale `GITHUB_TOKEN` no longer breaks the GitHub mirror.** The token
  was sent to `raw.githubusercontent.com` too, which answers a token it does
  not accept with 404 - every knowledge tool then reported every file as
  missing. It now goes to `api.github.com` only, and a token the API refuses
  (401/403) is dropped with one warning on stderr and the request repeated
  without it. A used-up unauthenticated API limit (the docs tree listing) is
  reported as that, with the token as the remedy, instead of a bare
  `HTTP 403`.
- **`run_app` boots with the corpus' local UI5, and honours `timeout_ms`.**
  The framework page's hash-only CSP blocks the inline scripts the SOURCE
  `sap-ui-core.js` from the local `@openui5` packages `document.write()`s, so
  with a samples-controls checkout beside it no app ever booted; the browser
  context now bypasses CSP exactly when local sources are served (with the
  CDN the page keeps its own policy). The boot wait passed `{ timeout }` as
  `waitForFunction`'s page argument instead of its options, so `timeout_ms`
  (run_app, interact_app, verify_app) was ignored and every boot waited
  Playwright's default 30 s.
- **The second dev app lints.** `deploy_app` without a `description` wrote
  the constant `MCP dev app` into every sidecar, and abaplint's
  `identical_descriptions` (on in app-template's config, which lints the
  framework sandbox) failed every app after the first - `verify_app` stopped
  at deploy. The default now names the class.
- **Removed apps leave the build.** The incremental build copied the sandbox
  into the framework's `node/downport` and never took anything out: after
  `remove_app` the class was still transpiled (a broken one kept failing
  every `build_backend`), a redeploy without `testclasses` kept the old test
  include running, and `abap2ui5-unit` left every class it tested in a
  developer's checkout. The copies are now tracked in a manifest inside
  `node/downport` (`.abap2ui5-mcp-dev-copies.json`) and removed once their
  sandbox source is gone - by the build and by `remove_app` itself; the
  framework's own files there are never touched. The sandbox's
  `package.devc.xml` is no longer copied over the framework's.
- **Security: no registry fallback for abaplint and the transpiler.** The
  lint ran `npx abaplint` and the incremental build `npx abap_transpile`;
  in a checkout without its own install npx did not fail but, with no TTY
  to prompt on, installed whatever the registry has under that name - and
  `abap_transpile` is an unclaimed name there (dependency confusion). Both
  now run the checkout's own `node_modules/@abaplint/cli` /
  `@abaplint/transpiler-cli` bin with node, and a missing install is a
  message naming the checkout and `npm ci`.
- **`npx --yes @abap2ui5/mcp-server` runs the server.** 0.2.0 shipped two
  bins, `abap2ui5-mcp` and `abap2ui5-unit`, and none named after the package,
  so npx stopped with "could not determine executable to run" - the command
  the README, the docs, the VS Code extension and app-template's `.mcp.json`
  all give. The bin `mcp-server` fixes that from this version on; the README
  now leads with `npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp`, which 0.2.0
  answers too. The release workflow runs the packed tarball through npx the
  way users do (`scripts/pack-smoke.mjs`) and moves the floating major tag
  `v0` - which `uses: abap2UI5/mcp-server@v0` names and which never existed -
  to each release; until then the README pins `@v0.2.0`.
- **The server exits with its client.** It stopped only on SIGINT/SIGTERM,
  but a client ends a stdio session by closing the pipe, and under `npx` a
  SIGTERM reaches npm rather than the server - so node, the warm Chromium and
  the express backend outlived every session, and the next one's `backend
  start` met the old backend on the port. An ended or closed stdin and SIGHUP
  now shut down like the signals do: browsers closed, the backend stopped,
  every running build/lint child's process tree killed, with a five-second
  hard stop.
- **Dependencies:** `@modelcontextprotocol/sdk` ^1.30.1 and `playwright`
  ^1.63.0 (lockfile refreshed within range). The linter's render runtime is
  now published as `@abap2ui5/linter-render` (formerly
  `@abap2ui5/render-runtime`); the docs and comments that name the install
  say so.

## 0.2.0 - 2026-09-25

- **Review round over the new tools, six fixes.** `build_backend` mode
  `transpile` passed the schema and the build but not the server's own mode
  gate; `verify_app` never hydrated the app-template mirror its deploy stage
  reads, so its message named a remedy that did not work through it; the
  `abap2ui5-unit` bin did nothing when started through npm's symlink (the
  main guard compared the link, not the real path) and `--help` printed its
  shebang; a workspace clone on another release than the project's pin was
  used instead of replaced; a download that died mid-stream could turn the
  "never rejects" download into a rejection on Windows; and the mirror tests
  failed in a sibling workspace although nothing was wrong.

- **Unit tests in CI, without a system.** `scripts/ci-unit.mjs` — shipped as
  the bin `abap2ui5-unit` and wrapped by `action.yml` as the composite GitHub
  Action `abap2UI5/mcp-server@v0` — clones the framework at the release the
  project's `abaplint.jsonc` pins, gets its backend (the release asset, or
  the framework's own build), deploys every class under `src` with its test
  include into the framework sandbox, transpiles once and runs the tests
  through the generated runner filtered to those classes; a step summary
  names every test method and the first failure. Measured against
  app-template's starter app: 17 s with a built framework next door.
- **New tool `verify_app`.** Validate, deploy, build, unit and boot in one
  call, stopping at the first failing stage; `stages` carries every result,
  `stoppedAt` the stage to read.
- **`build_backend` mode `transpile`.** The framework's own build in its
  checkout (`npm run downport` + `auto_transpile`, a few minutes, no corpus)
  — what `auto` falls back to when the release carries no prebuilt asset
  yet, said in the log. `run_unit_tests` takes `class_names` for several
  classes in one run.

- **The whole loop with one checkout, or none.** The dev sandbox has a second
  home: with no samples-controls checkout, `deploy_app` writes into the
  abap2UI5 checkout's `node/zz_dev` and lints with app-template's own
  `abaplint.jsonc` (the framework sources as the dependency — the lint a real
  project runs, 2-3 s), the incremental build copies from there, `read_app`,
  `remove_app` and `run_unit_tests` follow. `build_backend` mode `prebuilt`
  (and `auto` without a prior build) clones the framework's latest release
  into `~/.abap2ui5-mcp` (`A2UI5_MCP_WORKSPACE`) when no checkout is there
  and nothing is configured. `deploy_app`'s sidecar now carries the UTF-8 BOM
  abapGit writes — the template's `xml_bom` rule caught its absence on the
  first deploy into the new sandbox.
- **New tool `setup_status`.** One read: which checkout each tool would use
  (local, GitHub mirror, or missing and why), the sandbox and what is
  deployed in it, whether the backend is built, prebuilt and running, where a
  framework clone would land, and whether git, tar, npx and a Chromium are
  there.

- **The cheap half works without a single checkout.** When no local checkout
  resolves and no env var is set, the knowledge tools (`app_guide`,
  `api_reference`, `pitfalls`, `capabilities`, `examples`, `docs_search`,
  `scaffold_app`, `generation_rules`) and the resources read their files from
  GitHub into a per-user cache that the server treats as a read-only checkout
  (`lib/remote.mjs`; a day old at most, `A2UI5_MCP_REMOTE=0` or
  `A2UI5_MCP_OFFLINE=1` switch it off). A set env var stays authoritative and a
  failed download degrades to the old message plus the reason. The tools that
  write or build refuse the mirror with the clone command. `lib/repo-dirs.json`
  gained the framework's own entry (`a2ui5`) for the mirror URL.
- **New tool `read_example`.** The source of a sample an `examples` hit named,
  by class or by repo + path — from the checkout, or fetched from GitHub.
- **`build_backend` mode `prebuilt`, and `auto` uses it first.** The
  framework's release workflow attaches `backend-<version>.tar.gz` to every
  release; the server downloads and unpacks it into the abap2UI5 checkout in
  about a minute instead of the tens-of-minutes full build, and needs only that
  checkout for it. The incremental transpile now works on top of it (the
  framework's own `node/deps` libraries are used when they are there; the
  corpus-style clone and patch only otherwise). `run_app` no longer requires
  samples-controls: UI5 comes from the CDN when the corpus is not there to
  serve it locally. A failed download is reported, never turned into a full
  build.
- **New tool `interact_app`.** Boot an app, then click, fill, press and wait
  through a short script and photograph the result — the event branch of
  `main( )`, which no tool without a system could reach before. The first
  failing action stops the script; the picture is still taken.
- **New tool `run_unit_tests`, and `deploy_app` takes `testclasses`.** The
  local test classes are written beside the app (the sidecar carries
  `WITH_UNIT_TESTS`), transpiled by the next build, and run in the open-abap
  runtime — filtered to the one class through the generated runner, or the
  whole tree. `remove_app` and `read_app` know about the include.

- **Three new tools.** `fix_view` applies the linter's mechanical fixes to a
  source and returns the corrected source (it writes nothing — the agent
  decides where it goes), reporting which findings were fixed and which
  remain; `validate_view` findings now carry `fixable: true` where `fix_view`
  can clear them. `build_log` pages through the last build's full retained
  output — the error a 30-line tail cut off used to cost another
  tens-of-minutes build to see — persisted across server restarts. `read_app`
  reads a deployed dev app back from `src/zz_dev/` (same name gate as
  deploy/remove) and says whether the built backend already carries it.
- **Cancellation reaches the children.** The MCP request's abort signal
  (`notifications/cancelled`) now kills the spawned process tree of
  `build_backend`, `run_app`, `deploy_app`'s lint and `scope_of` — a
  cancelled build no longer keeps transpiling under a request nobody is
  waiting for.
- **Two backend-lifecycle bugs.** A killed backend's late exit event cleared
  the NEW backend's reference (kill() is asynchronous), leaving a live
  express server that status denied and stop could not reach; and two
  concurrent starts could spawn two servers onto one port — startBackend is
  single-flight now, the way buildBackend already was.
- **Logging and completions declared.** Diagnostics travel as MCP
  `notifications/message` once the transport is up (stderr stays the
  fallback), and the `abap2ui5://guide/{chapter}` template completes its
  argument from the guide's live chapter headings — advisory, so a missing
  checkout answers an empty list, never an error.
- **A warm renderer for the fast loop.** Where the linter accepts an
  already-open renderer (its `{ renderer }` option and `./render` export),
  validate_view and screenshot_view keep one Chromium warm across calls —
  the cold start dominated both — keyed per theme, shared by concurrent
  calls (the renderer's own page pool queues them), closed on shutdown, and
  dropped-and-relaunched when it dies (that call falls back cold). All
  feature-detected: an older linter keeps exactly the cold path it had.
- **Progress from the fast loop.** `validate_view` and `screenshot_view`
  forward the linter's onProgress phases when a progressToken is sent (an
  older linter simply ignores the option), and `deploy_app` marks its
  abaplint pass with start/end progress.
- **The live-read contract, made affordable.** Parses are cached per file
  version (path, mtimeMs, size) — a pulled or edited file invalidates
  itself — for the docs tree, the three sample catalogues, the client
  interface and CAPABILITIES.md; the linter's package.json is no longer
  re-parsed per import, and the benign-noise list is resolved per call
  instead of frozen at server start, so a corpus checked out later is found
  without a restart.
- **Arguments that reach spawn argv are validated** (`scope_of` entities: an
  array of bounded, non-empty strings, refused by name otherwise), and the
  prose stopped quoting sizes of sibling artifacts ("the 669-line
  interface") that nothing re-measures — a gate now refuses line-count
  claims in tool and resource descriptions.

## 0.1.1 - 2026-08-31

- **Every enumerated argument is checked, and every numeric one is bounded.**
  The schemas declare `enum` and `type: number`; a client is free to send
  anything anyway, and only `pitfalls` and `api_reference` said so. The rest
  fell through: `build_backend` read `args.mode || 'auto'`, so
  `mode: "incremental "` started a full build - tens of minutes to prove that a
  typo is not a mode; `backend` answered `status` for any action it did not
  recognise; `capabilities`, and `examples` for `repo`/`area`, filtered every
  entry away and reported no matches, which reads as an answer. `limit: 0`
  returned the entire catalogue and `limit: "abc"` returned nothing;
  `timeout_ms` had no ceiling and a viewport could be `99999x99999`. One helper
  (`lib/args.mjs`) now does both jobs, and an invalid argument comes back as a
  sentence naming what is accepted.
- **A sibling checkout is identified, not just probed for a file two
  repositories share.** `samples` and `samples-stack` both probed `SAMPLES.md`,
  so `SAMPLES_HOME` pointed at the wrong one resolved cheerfully and answered
  from the wrong catalogue; the linter probed a bare `package.json`, so any Node
  project in a directory named `linter` resolved as the linter and failed later
  and elsewhere. `lib/repo-dirs.json` entries can now carry identity checks,
  which only ever rule a candidate out and are skipped where the file they read
  is absent - a checkout from before `catalogue.json` still resolves.
- **Lints no longer race over one config file.** `deploy_app` writes
  `.abaplint-mcp-dev.jsonc` into the corpus root and deletes it in a `finally`;
  two calls at once meant the first to finish removed the config the second was
  still being linted against. Lints are queued now, keeping the file name the
  corpus gitignores.
- **The server survives an uncaught throw**, logging it to stderr instead of
  taking the stdio session, the built backend and the browser down with it. And
  `run_app` writes its screenshot to `<tmp>/abap2ui5-mcp-screenshots` rather
  than into the install directory - which is inside `node_modules` for an npm
  install - with `A2UI5_MCP_SCREENSHOT_DIR` to put it somewhere you keep.
- **Gates for the rules that had none.** CI clones the framework checkout, so
  the four tools and five resources that read it are exercised rather than
  skipped; the stdio smoke calls `examples`, the parser that has silently
  broken twice; the count drift gate reads spelled-out numbers and every
  `lib/*.mjs`; the ASCII rule is checked over the sources; and the release
  workflow refuses a tag whose changelog section is missing or whose
  `Unreleased` block is not empty. Plus tests for the scaffold substitution
  engine, the linter exports-map resolution and the prompt dispatch, which is a
  map now rather than a ternary that gave every unrecognised prompt the porting
  brief.

- **MCP resources and prompts, next to the tools.** The server used to declare
  `{ tools: {} }` and nothing else — a client that surfaces resources or
  prompts saw an empty server, and an agent had to learn from sixteen
  descriptions that `app_guide` comes first. The knowledge documents the tools
  slice are now also readable whole, under stable `abap2ui5://` URIs (the
  app-building guide plus a `guide/{chapter}` template, the client API
  summary, CAPABILITIES.md, the porting rulebook, both pitfall catalogues) —
  same live reads from the sibling checkouts, listing free of any file access,
  and a read against a missing checkout failing with the same actionable
  message the tool returns (the sibling table moved to `lib/siblings.mjs` so
  there is one copy of those words). Two prompts render the workflow itself:
  `build-an-abap2ui5-app` and `port-a-ui5-sample`, orchestration scripts over
  the existing tools that duplicate none of their content. The tool-surface
  drift gate covers both new surfaces: README tables and counts are checked
  against the arrays, and every tool a rendered prompt names must exist.

- **The README installs from npm.** Level 1 no longer asks for a clone of this
  repository — `npx --yes @abap2ui5/mcp-server` is the command, and a checkout
  is named only as what you need to work ON the server. The client-registration
  snippets show the same shape, with `node /path/to/server.mjs` as the
  alternative rather than the default. The `npm ci` install is ~45 MB and
  19 MB of that is the Playwright driver only `run_app` imports, so the README
  says so where somebody first pays it.
- **`npm run check`** — the ecosystem-wide name for "what CI will say about
  this tree". Here CI runs the test suite and nothing else, so it is `npm test`.

## 0.1.0 - 2026-08-18

The first version on npm. Before it, the server was installable only as
`npx --yes github:abap2UI5/mcp-server` — whatever `main` held that minute.
Everything below is what 0.1.0 carries.

- **Renamed: the repository is `mcp-server`, the package is `@abap2ui5/mcp-server`.**
  `mcp` names a protocol; `mcp-server` names the thing, which is what somebody
  scanning the organisation's repository list needs to read without clicking.
  The rename happened before the first publish on purpose: a package name is
  the one thing a release cannot take back, and a repository whose name differs
  from its only package is a discrepancy nobody has to inherit.

  `lib/repo-dirs.json` — the ecosystem's rename history — now carries an entry
  for this server itself, listing `mcp-server` and `ai-mcp`. It resolves
  nothing for its own sake, but a consumer that looks for a local checkout by
  directory name (abap2UI5/vscode-extension does, before falling back to npx)
  would otherwise miss one carrying the previous name.

- **`scaffold_app`: the files a new project starts from.** The server could
  tell an agent how to write a class (`app_guide`) and where to put one so it
  could be run (`deploy_app`, into the corpus' scratch package) — but not how
  to start a REPOSITORY, which is what somebody building an app of their own
  actually needs. Everything around the class is the part an agent cannot
  invent: the abaplint config with the framework pinned at a release under the
  `branch` key, the `abap2ui5lint.jsonc` the render gate needs to run rather
  than skip, the CI workflow, the `.abapgit.xml`, and the `.clas.xml` sidecar
  whose `CLSNAME` must match the class or the object does not activate at all.
  Served live from abap2UI5/app-template, the repository this ecosystem
  already points people at, rather than embedded — a copy here would be a
  second answer to "what does a new project look like".

  `class` renames it throughout: the ABAP, the sidecar's `CLSNAME` (upper case
  there, lower in the source — that asymmetry is why the template ships a
  rename script rather than an instruction) and the file names. The name is
  validated before it is substituted, since it reaches file paths. Proven end
  to end: a scaffolded project installs and passes `npm run check` — abaplint
  0 issues, linter 0 findings with the render gate on.

- **`screenshot_view`: an agent can SEE the view in seconds.** The linter
  gained `--screenshot` — it reconstructs the view from the builder calls,
  seeds it from the class's own `TYPES`/`DATA` and photographs it in the same
  headless harness its render gate already runs — and this server had no way
  to reach it. The only way to look at anything was `run_app`, which boots the
  REAL app and therefore needs the whole framework transpiled first: tens of
  minutes for the first build, minutes for every rebuild after an edit. So the
  loop was "write ABAP, get a verdict in seconds, then pay a build to look at
  it, or never look at it". A dedicated tool rather than a flag on
  `validate_view`, because it is a different question (is this legal / what
  does it look like), it takes different arguments (viewports, theme, preview
  data) and it needs the render runtime and a browser, which the property gate
  does not. Several viewports come back from ONE browser session, each as an
  MCP `image` block — the way `run_app` has always returned its screenshot.

- **`app_guide`: the rulebook for the job this server is for.** The one
  rulebook on offer, `generation_rules`, serves samples-controls'
  `generation-prompt.txt`, whose first line is *"You are porting one official
  UI5 demo kit sample to abap2UI5"* — while the tool described itself as "the
  canonical rulebook for writing an abap2UI5 app". An agent building a user's
  app was being handed the porting brief: an input sample it does not have, a
  `z2ui5_cl_smpc_app_<n>` convention that is not its app's, and 1:1 fidelity
  to something that does not exist. abap2UI5 maintains the right document
  beside its sources (`docs/agents/building-apps.md`, deliberately
  self-contained so no web access is needed); it is served live and sliced by
  chapter, the way `pitfalls` slices the skills. The porting brief stays where
  it was, and both descriptions now say which job they are for.

- **An agent can deploy the app it actually wrote.** `deploy_app` enforced
  `^z2ui5_cl_[a-z0-9_]+$` — the naming convention of the demo-kit PORTS — and
  the ecosystem's own starting point, `abap2UI5/app-template`, ships
  `zcl_app_001`. So an agent that followed the recommended path could not
  deploy, build or look at the thing it had just been told to write. Any
  customer-namespace class name is accepted now (`^[zy][a-z0-9_]*$`, <= 30
  chars), and the dev lint config was widened the same way — it forced
  `^Z2UI5_CL_` one layer down, which would have failed the very name this
  server had just accepted. The safety property is unchanged and tested: the
  name becomes a PATH under `src/zz_dev`, so it is still a whitelist admitting
  no separator, dot or space, and no name can reach outside the sandbox.

- **A finding arrives explained.** `validate_view` returned a rule id and a
  one-line message; the paragraph saying why the defect matters and what the
  fix looks like existed only on the published rules page — a web fetch
  mid-task, and one an agent may not be able to make at all. The linter now
  exports that prose (`./rule-docs`), and each rule that fired comes back
  under `rules`, keyed by id so twelve findings of one type cost one
  explanation. The one-line summary always, the full paragraph on
  `explain: true` — a first run on an unfamiliar class can hit a dozen
  distinct rules, and a dozen paragraphs would crowd out the findings they are
  about. An older linter checkout without that export costs the explanations
  and nothing else.

- **The catalogue rows are read whole.** Two things the parser dropped on the
  floor: the per-sample `docs:` links — the cookbook chapters somebody decided
  each app is the worked example of, which it knew about only well enough to
  SKIP while looking for the keywords — and, worse, the TITLE of every port in
  samples-controls. Its rows carry the whole header in bold with no dash after
  it (`| **sap.m.Bar**<br>…`) and the row pattern required the dash, so 430 of
  the 614 apps parsed as rows with no header at all: the title fell back to
  the section, and every port announced itself as the LIBRARY it belongs to
  while the control an agent asked for survived only inside the keyword blob.
  The docs links are searchable by nobody on purpose — almost every row in
  `samples` carries one starting `cookbook/`, so a query for "cookbook" would
  match the whole catalogue.

- **`examples` searches all three sample repositories, not one.** The tool
  read `abap2UI5/samples` and nothing else, so two thirds of the answer was
  invisible to it: `samples-controls` (430 ports of the UI5 demo kit — the
  answer to "how do I express sap.m.Wizard") and `samples-stack` (32 apps that
  need an OData service, RAP, APC or the launchpad, which is exactly what an
  agent must know before proposing one). 152 apps searchable, 614 now. Each
  entry names its `repo`, and a new `repo` filter narrows to one. A repository
  that is not checked out is REPORTED rather than fatal — a thinner answer to
  "has somebody built this" beats a refusal — and only all three missing is an
  error. This became possible because the three catalogues now render the
  identical row from the same two lines on the class (`" @summary`,
  `" @keywords`), so one parser reads all of them.

- **The row parser reads the summary sentence, and could not have.** The
  catalogues grew a second kind of block under the row title — the sentence, in
  normal type rather than in `<sub>` — and the old pattern matched `<br><sub>`
  blocks only. It would have matched no rows at all, and that failure looks
  like "there are no samples for that" rather than like a parse error. The
  blocks are matched as a group and classified afterwards, which is the same
  fix the `@docs` links needed, and the tests now cover both kinds.

- **`validate_view` judges a source by its own project's config.** It read
  samples-controls' `abap2ui5lint.jsonc` unconditionally, which is right when
  porting demo-kit samples and wrong for everyone else: an app in another
  repository was measured against that corpus' rule overrides, allow list and
  UI5 floor, with no argument to say otherwise — while the tool's own
  description promised the opposite. New `project_dir` argument; without it,
  the working directory, then the corpus. A named project is taken at its
  word: its config or none, never a silent fallback onto someone else's.

- **`stripJsonc` deleted the wrong character.** Trailing-comma offsets were
  collected in UTF-16 code units and dropped by code point, so one astral
  character — an emoji in a description is enough — shifted every later index
  and left unparseable JSON behind. It reads `abaplint.jsonc` out of a
  repository this server does not own, so the input was never ours to
  constrain.

- **The dev lint config is removed again.** `devLintConfig( )` writes
  `.abaplint-mcp-dev.jsonc` into the ROOT of the samples-controls checkout on
  every lint (it has to — the config's `files` glob resolves from there) and
  left it behind. That it never showed up in a commit rested on one line in
  another repository's `.gitignore`.

- **Two live reads say what is missing.** A checkout can be present and a file
  absent — an older revision, a half-finished pull, a rename upstream — and
  `generation_rules` and `capabilities` answered that with a raw `ENOENT`
  stack trace. They now name the file and say `git pull`, as `pitfalls`
  already did.

- **Setup is documented in three levels**, because the tools do not all cost
  the same: validating views needs one 3 MB checkout, the catalogues need two
  more, and the screenshot loop needs a browser and a first build that takes
  tens of minutes. Registering the server was documented for `claude mcp add`
  alone while the first paragraph promised Cursor, VS Code and any MCP client;
  there is a plain `mcp.json` block for those now.

- **CI clones `samples-controls`,** not `ai-demokit` — that repository was
  renamed, and the clone worked only through GitHub's redirect.

- **The release proves the tarball, not just the working tree.** `npm test`
  runs where every file exists whether or not `files` lists it, so the one
  defect this package can ship — a `lib/` module left out of the allowlist —
  was invisible to the entire suite, and the release job only printed the
  tarball contents. It now installs the tarball into a scratch project and
  drives the installed `bin` over stdio: initialize, `tools/list`, and one
  tool call with every checkout absent, which has to come back as the
  actionable message rather than a crash.

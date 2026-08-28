# Changelog

## Unreleased

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

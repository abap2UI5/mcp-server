# AGENTS.md — mcp-server

Single source of truth for agents working on the **abap2UI5 MCP server** —
the `app_guide → validate_view/screenshot_view → deploy_app → build_backend →
run_app` loop exposed to MCP clients, no SAP system required.

**The loop has a cheap half and an expensive half, and keeping them apart is
the point.** `validate_view` and `screenshot_view` both work from SOURCE
through the linter's render harness: seconds, no backend, no transpile, and
blind to everything that only exists at runtime. `build_backend`/`run_app`
boot the real transpiled app: tens of minutes for the first build, and the
only place the ABAP actually runs. A tool that moves work from the second half
to the first is worth more here than almost anything else — the expensive half
is what an agent's feedback loop is made of.

> This entire project is in **English**. No non-ASCII **literal** goes in a
> source file — the CAPABILITIES.md status marks are built with
> `String.fromCodePoint` for exactly this reason (`lib/capabilities.mjs`), so
> a parser's data can never depend on how an editor saved a glyph. Prose is a
> different matter: comments and the tool descriptions have always used em
> dashes and stay as they are. (This paragraph said "source files are 7-bit
> ASCII", which no file in the repo has ever been, `lib/capabilities.mjs`
> included.)

## The one thing to understand first: this repo cannot work alone

mcp-server **bundles no content**. Every tool reads live from sibling checkouts,
resolved per call in `lib/repos.mjs` (explicit env var, then the `../<name>`
sibling of this repo — plus, for abap2UI5, the in-repo `.abap2UI5` clone that
samples-controls' `npm run node:setup` creates). A **set env var is
authoritative**: when it points at a directory without the expected checkout,
the repo resolves to null and the tool reports the misconfiguration — there
is no silent fallback to the sibling guess.

| Env var | Default sibling | Used for |
| --- | --- | --- |
| `SAMPLES_CONTROLS_HOME` (was `AI_DEMOKIT_HOME`, still read) | `../samples-controls`, `../abap2UI5-api`, `../ai-demokit` | CAPABILITIES.md (re-parsed on every query), `catalogue.json` + `SAMPLES.md` (the control catalogue `examples` searches), `scripts/generation-prompt.txt`, `scripts/scope-of.mjs`, `scripts/e2e-build.mjs`, `abaplint.jsonc`, `src/zz_dev/` (deploy target), `node_modules/@openui5/*` (UI5 runtime for screenshots) |
| `A2UI5_HOME` | `../abap2UI5` | `node/srv/express.mjs` (backend server), `node/downport/` + `node/setup/abap_transpile.json` (incremental build), `node/output/`, `.claude/skills/{abap-check,ui5-check}/SKILL.md` (`pitfalls`), `docs/agents/building-apps.md` (`app_guide`) |
| `SAMPLES_HOME` | `../samples`, `../abap2UI5-samples` | `catalogue.json` (preferred) + `SAMPLES.md` (fallback, and the src/00 area) — one of the three catalogues `examples` searches |
| `SAMPLES_STACK_HOME` | `../samples-stack`, `../abap2UI5-samples-stack` | `catalogue.json` (preferred) + `SAMPLES.md` (fallback) — the stack-dependent catalogue (OData, RAP, APC, launchpad) |
| `DOCS_HOME` | `../docs` | `docs/**/*.md` — the documentation site's sources, searched live by `docs_search` |
| `AI_VIEW_CHECK_HOME` | `../linter` (legacy aliases: `../abap2UI5-linter`, `../ai-view-check`) | `validate_view` + `screenshot_view`: dynamic import of the linter's package `exports` entries `.`, `./findings`, `./config`, `./rule-docs` (via `importViewCheck`) |

Also: `A2UI5_MCP_PORT`, `A2UI5_MCP_OFFLINE=1` (no CDN fallback for UI5),
`A2UI5_MCP_CHROMIUM` (browser path), and the child-process timeouts
`A2UI5_MCP_LINT_TIMEOUT_MS` / `A2UI5_MCP_SCOPE_TIMEOUT_MS` (default 5 min)
and `A2UI5_MCP_BUILD_TIMEOUT_MS` (default 30 min).

A missing checkout degrades **per tool** (the server still starts;
`resolve*` returns null and the affected tool returns a uniform, actionable
error — which repo, how to clone it, which env var; the repo-and-hint table is
`lib/siblings.mjs`, wrapped by `missingSibling` in `server.mjs` and thrown
as the read error by `lib/resources.mjs`, so tools and resources degrade
with the same words) — `validate_view`/`screenshot_view` need the linter,
`run_app`/`backend` need the core repo (and so do `pitfalls`, `app_guide` and
`api_reference`, whose documents and interface are maintained beside the
framework sources), almost everything else needs samples-controls. The README used to call the linter
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
- abap2UI5 core: `node/srv/express.mjs`, `node/setup/abap_transpile.json`,
  `node/downport/`, `node/output/init.mjs`, the two `.claude/skills/*-check/`
  catalogues, and **`docs/agents/building-apps.md`** — the app-building guide
  `app_guide` serves. Its `## ` headings are the chapters that tool slices on;
  a rename of the file is a broken tool here (reported, not silent — the tool
  names the path it looked in). **`src/02/z2ui5_if_client.intf.abap`** is
  load-bearing the same way: `api_reference` parses it live (`lib/api.mjs` —
  methods, `cs_*` constants, types, the ABAP-Doc and inline notes), relying on
  the abaplint-pinned formatting; a move of the file is reported by path, and
  a formatting change upstream is a parser change here.
- docs: the `docs/` markdown tree (everything but `.vitepress`, `public` and
  `node_modules` is a page) and the **published URL scheme** its
  `scripts/generate-llms.mjs` derives — `https://abap2ui5.github.io/docs/<path>`
  plus `.html` for the rendered page and `.md` for the raw twin published
  beside it. `docs_search` (`lib/docs.mjs`) walks the same tree with the same
  exclusions and hands back that URL pair; a change to either upstream is a
  change here.
- app-template: **`template.json`** — the template's own description of what a
  project takes from it (the placeholder class, `files.shared` / `files.named`,
  and the substitutions that make them somebody's). `lib/scaffold.mjs` EXECUTES
  that description and keeps no list of its own; a checkout without the file is
  reported (`scaffold_app` says to pull), never guessed at. The template's
  `npm run rename` and the VS Code extension's "New Project from Template" are
  the other two executors — three programs, one description, so a file added to
  the template reaches all three at once.
- abap2UI5-linter: the package `exports` map entries `.`, `./findings`,
  `./config` and `./rule-docs` (and the shapes behind them: `checkFiles` and
  `screenshotFiles`, `severityOf` / `severityRank` / `SEVERITIES`,
  `findConfigFrom` / `loadConfig` / `applyConfig`, `RULE_DOCS`) — imported
  **via the exports map** by `importViewCheck` in `lib/repos.mjs`, so internal
  file-layout refactors there are safe, but a removed or renamed export breaks
  a tool here even while the linter's own tests stay green. Two of those are
  read **defensively**, because the linter is an UNPINNED sibling and can be
  older than this server: a checkout without `screenshotFiles` gets a message
  saying so, and one without `./rule-docs` costs the agent the explanations
  and nothing else. Neither may cost it the findings.

## Side effects on sibling repos — expected, not a bug

The server **writes into the sibling checkouts**. When you (or another
agent) find these artifacts in a dirty sibling worktree, mcp-server caused them:

- `<samples-controls>/src/zz_dev/*.clas.abap` + `.clas.xml` + `package.devc.xml` —
  deployed dev apps (`remove_app` deletes them again).
- `<abap2UI5>/e2e-transpile.json` — temporary incremental-build config
  (deleted on close).
- `<abap2UI5>/node/` — a clone of `open-abap-core` during builds.

`<samples-controls>/.abaplint-mcp-dev.jsonc` (the patched lint config for
deployed dev apps, gitignored there) used to be on that list and is not any
more: `lintApp` removes it in a `finally`, so it exists only while a lint is
actually running. It keeps that exact file name because that is the name the
corpus gitignores — which is why `lintApp` QUEUES lints rather than giving each
one a suffix of its own: two concurrent lints over the one path meant the first
to finish deleted the config the second was still being linted against.

## Build & verify

```bash
npm install          # @modelcontextprotocol/sdk + playwright
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
`test/smoke.test.mjs` boots the real server over stdio (initialize, 16 tools,
a capabilities query, the resource list and a resource read, the prompt list
and a rendered prompt) and **skips itself when the samples-controls sibling is
absent**, so `npm test` is green in a bare checkout and exercises the full
path in a sibling workspace. CI (`.github/workflows/ci.yml`) runs `npm test`
on every push/PR. Manual stdio driving, when a test is not enough:

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

Expect: an `initialize` result, 16 tools in `tools/list`, and capability rows
for "popup". Pure units that are testable without any sibling checkout (add
tests here first): `stripJsonc` (`lib/runtime.mjs`), the CAPABILITIES.md
table parser (`lib/capabilities.mjs`), the class-name/`z2ui5_if_app`
validation in `deployApp`, the `BENIGN` console-noise filter.

## Timing expectations

`build_backend` full build is **tens of minutes** (transpiles the whole
framework); the incremental path is ~1–2 minutes. Set tool/agent timeouts
accordingly — a "hung" build is usually just a slow transpile. Every spawned
child carries its own hard timeout (`spawnWithTimeout` in `lib/runtime.mjs`
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
  sample".
- **`lib/repo-dirs.json` is THE rename history of the ecosystem**, and this
  repo owns it because this is the component that resolves the repos root.
  Per repo it carries the directory names a checkout can carry (newest first —
  `linter`, then the pre-rename aliases `abap2UI5-linter` and `ai-view-check`;
  `samples-controls`, then `abap2UI5-api` and `ai-demokit`; and so on), the env
  vars that override the guess, and the probe file that proves a candidate
  really is that checkout. `lib/repos.mjs` reads it — the constants it still
  exports (`VIEW_CHECK_DIRS`, `CORPUS_DIRS`, …) are views on the JSON, not
  literals. **Add a name here and nowhere else.** The VS Code extension used to
  keep a hand-written second copy in `src/repolayout.ts`; it now snapshots this
  file into `src/data/repo-dirs.json` with a weekly drift gate
  (`npm run repo-dirs:check`, `bump-repo-dirs.yml`), so a rename lands in one
  place and propagates. Dropping an alias still un-finds somebody's working
  checkout — do that only deliberately.
- The README's setup section and the sibling-layout table above must stay in
  sync — the README is the user-facing copy, this file is the contract.

## Related repositories

| Repository | Relation |
| --- | --- |
| [samples-controls](https://github.com/abap2UI5/samples-controls) | Content substrate: capabilities, rules, scope, deploy target, UI5 runtime — and one of the three `examples` catalogues |
| [samples](https://github.com/abap2UI5/samples) | The pattern catalogue `examples` searches |
| [samples-stack](https://github.com/abap2UI5/samples-stack) | The stack-dependent catalogue `examples` searches |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Runtime substrate: transpiled backend + express server — and the client API `api_reference` parses |
| [docs](https://github.com/abap2UI5/docs) | The documentation site `docs_search` reads, in source form |
| [abap2UI5-linter](https://github.com/abap2UI5/linter) | `validate_view` implementation (imported via its package `exports` map) |
| [vscode-extension](https://github.com/abap2UI5/vscode-extension) | Registers this server for MCP clients in the editor (`src/mcp.ts`) |

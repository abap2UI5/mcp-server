# mcp-server

**The MCP server for abap2UI5** — gives any AI coding agent (Claude Code,
Cursor, VS Code Copilot, or any MCP client) the full abap2UI5 development
loop, without an SAP system:

```
examples -> app_guide -> validate_view + screenshot_view -> deploy_app -> build_backend -> run_app -> pitfalls
(has somebody  (how an app  (SECONDS, no system:        (write ABAP,  (transpile      (boot headless,  (what a green
 built it       is built)    is the view legal,          lint)         to Node)        errors +         run still
 already?)                   and what does it LOOK like)                               SCREENSHOT)      does not prove)
```

The agent writes an ABAP class, validates the view **and looks at a picture of
it** in seconds, deploys it, boots it in a real browser and looks at the
running app — then iterates. Everything runs locally on infrastructure that
already guards the abap2UI5 ecosystem in CI: the abaplint transpiler +
open-abap runtime, the framework's express shim, the
[samples-controls](https://github.com/abap2UI5/samples-controls) build and boot
gates, and the [linter](https://github.com/abap2UI5/linter) validation core.

## Documentation

**→ [The MCP server, in full](https://abap2ui5.github.io/docs/advanced/mcp_server.html)**
— what MCP means here, the three setup levels and what each one buys, how to
register the server with your client, every tool with what the agent gets from
it, and the loop they are meant to be used in.

**→ [Building with AI](https://abap2ui5.github.io/docs/get_started/ai.html)** —
the whole AI setup in rising order of effort. This server is the top rung; the
cheaper ones matter first.

## Quick start

### One-click install

[![Install in VS Code](https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF)](https://insiders.vscode.dev/redirect/mcp/install?name=abap2ui5&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22--yes%22%2C%22-p%22%2C%22%40abap2ui5%2Fmcp-server%22%2C%22abap2ui5-mcp%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20Server&color=24bfa5)](https://insiders.vscode.dev/redirect/mcp/install?name=abap2ui5&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22--yes%22%2C%22-p%22%2C%22%40abap2ui5%2Fmcp-server%22%2C%22abap2ui5-mcp%22%5D%7D&quality=insiders)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=abap2ui5&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyItLXllcyIsIi1wIiwiQGFiYXAydWk1L21jcC1zZXJ2ZXIiLCJhYmFwMnVpNS1tY3AiXX0%3D)

Every button registers the same stdio server, named `abap2ui5`:

```json
{"command":"npx","args":["--yes","-p","@abap2ui5/mcp-server","abap2ui5-mcp"]}
```

The badges go through a web redirect because GitHub does not render links to
an editor's own URL scheme; the direct links, to paste into a browser or
`xdg-open`/`open`, are:

```text
vscode:mcp/install?%7B%22name%22%3A%22abap2ui5%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22--yes%22%2C%22-p%22%2C%22%40abap2ui5%2Fmcp-server%22%2C%22abap2ui5-mcp%22%5D%7D
cursor://anysphere.cursor-deeplink/mcp/install?name=abap2ui5&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyItLXllcyIsIi1wIiwiQGFiYXAydWk1L21jcC1zZXJ2ZXIiLCJhYmFwMnVpNS1tY3AiXX0%3D
```

(`vscode-insiders:` in place of `vscode:` for Insiders.) Claude Code:

```sh
claude mcp add abap2ui5 -- npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp
```

**Claude Code plugin.** The abap2UI5 plugin bundles the framework's agent
skills (building an app, the ABAP and UI5 pitfall catalogues, the view-chain
layout, ...) together with this server, registered the same way as above —
one install for both:

```text
/plugin marketplace add abap2UI5/abap2UI5
/plugin install abap2ui5@abap2ui5
```

Releases from 1.0.0 on are also listed in the
[official MCP Registry](https://github.com/modelcontextprotocol/registry) as
`io.github.abap2UI5/mcp-server` ([`server.json`](server.json)), for clients
that install from the registry.

That is level 1 below: `validate_view` and `fix_view` work out of the box,
and `setup_status` tells the agent what else works on this machine and what
is missing.

### What each install brings

Level 1 — `validate_view`, `fix_view` and `screenshot_view`, the tools most
work happens at. They need the [linter](https://github.com/abap2UI5/linter),
which the server declares as a **peer dependency** (`@abap2ui5/linter`,
`>=0.8.0 <0.9.0` — the range this server is built against). npm 7+ installs a
non-optional peer by itself, so the one-liner below brings the linter along
and `validate_view`/`fix_view` work out of the box. The render gate behind
`screenshot_view` needs the UI5 libraries and Playwright on top
(`@abap2ui5/linter-render`, declared as an **optional** peer: the compatible
range is stated, the package is NOT installed for you — plan on
**~150–200 MB** and a few minutes the first time you add it):

```sh
claude mcp add abap2ui5 -- npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp                            # validate_view, fix_view
claude mcp add abap2ui5 -- npx --yes -p @abap2ui5/mcp-server -p @abap2ui5/linter-render abap2ui5-mcp # + screenshot_view
```

The server looks for the linter, in this order: `AI_VIEW_CHECK_HOME`; a
`linter` checkout next to the server (which is also where npm puts the peer
for an npx run: `node_modules/@abap2ui5/{mcp-server,linter}`); the project it
is started in (`node_modules/@abap2ui5/linter` — app-template has it as a
devDependency, so `npm install` there is all it takes); the server's own
`node_modules`; whatever Node's module resolution finds from the server's
location. A set env var decides alone. Or work from a checkout:

```sh
git clone https://github.com/abap2UI5/linter        # AI_VIEW_CHECK_HOME
cd linter && npm ci
```

The server itself is on npm, so it needs no checkout; the registration above
is the whole install. (With npm 6 or `--legacy-peer-deps`, add
`-p @abap2ui5/linter` yourself.)

(`-p … abap2ui5-mcp` names the bin explicitly, which every published version
answers. The shorter `npx --yes @abap2ui5/mcp-server` needs a bin named after
the package, which 0.2.0 and earlier do not have — npx stops there with "could
not determine executable to run".)

(The install is ~47 MB: 19 MB of it a Playwright driver only `run_app` uses,
2 MB the linter — paid on the first start, cached after. From a checkout instead:
`git clone https://github.com/abap2UI5/mcp-server && cd mcp-server && npm ci`,
then `claude mcp add abap2ui5 -- node /path/to/mcp-server/server.mjs`.)

Cursor, VS Code and Claude Desktop take the standard stdio shape — the
[documentation](https://abap2ui5.github.io/docs/advanced/mcp_server.html#registering-it-with-your-client)
has the JSON, and the two further levels (the sample catalogues and deploying,
then the headless build-and-boot loop). A tool whose prerequisites are missing
answers with a message naming what it needs; the server starts either way.

The [abap2UI5 VS Code extension](https://github.com/abap2UI5/vscode-extension)
registers this server for you, and adds a second one of its own for the tools
that need a real SAP system.

**Everything in one command** — for a machine (or
[Codespace](https://codespaces.new/abap2UI5/mcp-server?quickstart=1)) dedicated
to the full build-and-boot loop, [`setup.sh`](setup.sh) clones the framework,
corpus and linter checkouts next to this repo, installs their dependencies and
the headless browser (existing checkouts are reused, safe to re-run):

```sh
git clone https://github.com/abap2UI5/mcp-server && ./mcp-server/setup.sh
```

`setup.sh --no-corpus` clones the framework and the linter only, which is
the whole loop for an app of your own since the framework sandbox exists;
the corpus is for `scope_of`, the full build and the locally served UI5.

A Claude Code started inside the checkout picks the server up automatically
via the committed [`.mcp.json`](.mcp.json); the
[devcontainer](.devcontainer/devcontainer.json) runs the same setup on create.

**Level 0 — no checkout at all.** The knowledge tools (`app_guide`,
`api_reference`, `pitfalls`, `capabilities`, `examples`, `read_example`,
`docs_search`, `scaffold_app`, `generation_rules`) read committed files, so
when no checkout resolves and no env var is set they read them from GitHub
instead: the files land in a per-user cache (`<tmp>/abap2ui5-mcp-remote`, a
day at a time - used only while it is a directory of the user's own, created
0700; `A2UI5_MCP_REMOTE_DIR` moves it) that the server treats as a read-only checkout; `add_agent_setup`
reads the template from there too, and writes only into the project it is
given. And the
expensive half runs on the npm package `@abap2ui5/node-runtime` (below), so
`npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp` in a fresh project covers
`deploy_app`, `build_backend`, `run_app`, `interact_app`, `run_unit_tests`
and `verify_app` too, with no clone of anything. What still needs a checkout
is the corpus' part (`scope_of`, `build_backend` mode `full`, the locally
served UI5). `A2UI5_MCP_REMOTE=0` or `A2UI5_MCP_OFFLINE=1` switches the
mirror off. The docs mirror lists its pages through GitHub's API, which
allows 60 unauthenticated requests an hour per address; a `GITHUB_TOKEN` (or
`GH_TOKEN`) in the environment raises that and is sent to `api.github.com`
only.

**The backend without a framework checkout: `@abap2ui5/node-runtime`.**
The framework is published on npm already transpiled, with the ABAP sources
of the same release commit to transpile apps against. With no abap2UI5
checkout (and none configured), `build_backend` installs that package once
per release into `~/.abap2ui5-mcp/runtime/<version>` — with the transpiler
it names, express, and app-template's abaplint for the lint, at exact
versions with a lockfile, `--ignore-scripts` — fetches open-abap-core at the
commit the release was built with, and then transpiles **only the deployed
apps** against it: seconds, never the framework. `deploy_app` writes into
`~/.abap2ui5-mcp/sandbox` (and lints with app-template's own config against
the package's sources), `run_app` boots the package's server with the apps
registered, `run_unit_tests` runs the apps' own tests. The release is the
registry's latest (asked through npm, cached a day) unless
`A2UI5_MCP_RUNTIME_VERSION` pins one. Measured here with a cold npm cache:
the first install about 10 s, open-abap-core about 1 s, then 7–8 s per build
and about a second for the unit tests. `setup_status` shows the release, the
workspace and what the next build would do.

**With a framework checkout** (`A2UI5_HOME` or a sibling) everything works
as before: `build_backend` downloads the release's prebuilt backend
(`backend-<version>.tar.gz`) into the checkout the first time and
re-transpiles the deployed apps from its `node/zz_dev` afterwards.
`A2UI5_MCP_BACKEND=npm` runs on the package beside a checkout;
`build_backend` mode `prebuilt` (or `A2UI5_MCP_BACKEND=clone`) clones the
release into `~/.abap2ui5-mcp/abap2UI5` instead — the path this server took
without a checkout until the package existed. The full corpus build stays
available as `mode: "full"` for a checkout on an unreleased commit.

## Tools

Every tool reads live from a sibling checkout, and each one needs a specific
sibling — there is no "optional" repository, only tools you do or do not use.
The **Needs** column says which checkout a tool is dead without: the linter
alone carries `validate_view`, `fix_view` and `screenshot_view` (the fast
loop, where most iterations happen — and the one dependency npm installs with
the server, as its declared peer), the framework checkout carries the guide, the pitfalls and
the interface (all three mirrored from GitHub when it is absent), the npm
package `@abap2ui5/node-runtime` carries the backend when no framework
checkout is there, and the corpus carries almost everything else. A tool
whose checkout is missing answers with the clone command and env var that
fix it.

| Tool | What it does | Needs |
|---|---|---|
| `setup_status` | What resolves, what is built, what is missing and how to fix it — one read, call it first | nothing |
| `capabilities` | Whether abap2UI5 can express a UI5 feature at all, from the verified capability map | samples-controls |
| `app_guide` | How to build an app, live from the framework checkout | abap2UI5 |
| `api_reference` | The client API (`z2ui5_if_client`) with its ABAP-Doc: methods, parameters, defaults, the `cs_*` constants | abap2UI5 |
| `scaffold_app` | The files a new project starts from, live from app-template; `{ class: … }` renames throughout, sidecar `CLSNAME` included | app-template |
| `add_agent_setup` | Set up an **existing** project for AI work — what `npm create abap2ui5-app -- --agent-setup` does: AGENTS.md, the skills, `.mcp.json`, the allowlist, both gates and the CI job, written into `project_dir`; never overwrites, merges `package.json`/`.gitignore`, follows the `STARTING_FOLDER` | app-template |
| `examples` | Search the three sample catalogues, verification status and all — answers with a class to read, never a snippet to trust | any of samples / samples-controls / samples-stack (or the GitHub mirror) |
| `read_example` | Read the source of a sample an `examples` hit named — from the checkout, or fetched from GitHub | the sample's repository (or the GitHub mirror) |
| `docs_search` | Full-text search over the documentation site's pages: page, heading, snippet and the published URL | docs |
| `generation_rules` | The rulebook for porting a UI5 demo-kit sample into samples-controls | samples-controls |
| `pitfalls` | The defects a green run does not catch: `{ area: "abap" }` and `{ area: "view" }` | abap2UI5 |
| `scope_of` | In/out-of-scope verdict for a UI5 control | samples-controls + an OpenUI5 checkout |
| `validate_view` | The linter's gates in seconds, judged by your project's own `abap2ui5lint.jsonc` | linter |
| `fix_view` | Apply the linter's mechanical fixes and get the corrected source back — writes nothing | linter |
| `screenshot_view` | See the view in seconds — no build, no backend | linter |
| `deploy_app` | Write the class + abapGit sidecar (+ test include) into the dev sandbox, then abaplint it | nothing (the npm backend's `~/.abap2ui5-mcp/sandbox`); samples-controls' `src/zz_dev` or abap2UI5's `node/zz_dev` when present |
| `read_app` | Read a deployed dev app's source back, and whether the built backend already carries it | the sandbox (as deploy_app) |
| `build_backend` | Get the transpiled Node backend: without a checkout `@abap2ui5/node-runtime` from npm and only the dev apps transpiled (seconds); with one `prebuilt` downloads the framework's released backend and `incremental` re-transpiles the dev apps on top; `prebuilt`/`transpile` clone the framework when asked to; `full` runs the corpus' e2e-build | nothing (npm), or abap2UI5 (`full` needs samples-controls) |
| `build_log` | Page through the last build's full output — the error the result's short tail cut off | nothing (reads the record the last build left) |
| `run_app` | Boot an app headless: status, real page errors, and a **screenshot** | a build (npm backend or abap2UI5 checkout); samples-controls serves UI5 locally when present, the CDN otherwise |
| `interact_app` | Boot an app, then click, fill, press and wait through a short script — the **event branch**, photographed | a build (same as run_app) |
| `app_list` | The app classes the built backend can start — the deployed dev apps and the framework's own | a build (npm backend or abap2UI5 checkout) |
| `app_start` | Start an app and get its **agent snapshot**: fields (path, label, kind, value), actions (event + arguments), tables, messages — over the abap2UI5 JSON protocol, no browser; in an MCP Apps host also an interactive screen, with `format: "adaptive-card"` also an Adaptive Card | a build (same as run_app) |
| `app_describe` | The current agent snapshot of a session, from memory — no roundtrip | a session from app_start |
| `app_act` | Fill fields and fire an event by name — validated against the snapshot, sent as the real model delta — and get the next snapshot | a session from app_start |
| `run_unit_tests` | Run the deployed apps' test classes (on a checkout: or the whole transpiled tree) in the open-abap runtime: assertions, not pictures | a build (npm backend or abap2UI5 checkout) |
| `verify_app` | The whole loop in one call — validate, deploy, build, unit, boot — stopping at the first stage that fails | what the stages need |
| `migrate_report` | Convert a **classic ABAP report** into an abap-cloud-gui app class (report2cloud): the class files, the migration report (TODOs, unreleased tables with successors), the refusals with `file:row:col`; `deploy: true` builds it here and answers its selection screen's agent snapshot | abap-cloud-gui (with `npm ci`); `deploy` also the popups and a build |
| `backend` | `status` / `start` / `stop` / `restart` of the local express backend | a build (start/restart; status and stop always work) |
| `remove_app` | Delete a dev app from the sandbox, or list the deployed ones | the sandbox (as deploy_app) |

`verify_app` is the loop in one call: validate, deploy, build, unit tests and
boot, stopping at the first stage that fails and reporting every stage before
it. `interact_app` is `run_app` with hands: after the boot it clicks, fills and
presses through a short script and photographs the result, which is how the
event branch of an app becomes visible without a system; `run_unit_tests`
runs the test classes `deploy_app` wrote beside the app (a local
`z2ui5_if_client` double, see the app guide's chapter 9) in the open-abap
runtime and answers with assertions.

`scaffold_app` and `add_agent_setup` both execute app-template's own
`template.json`, for the two kinds of project. `scaffold_app` hands back a
whole NEW project, app class included, and writes nothing. `add_agent_setup`
is for the abapGit repository that already exists - most of them never
started from the template - and does what
`npm create abap2ui5-app -- --agent-setup` does there, by the template's
`agentSetup` key: it writes the agent setup and the two gates into
`project_dir` (default: the server's
working directory, when that looks like a project), never overwrites a file
the project has (each one is listed as skipped), merges `package.json` and
`.gitignore` by only adding what is missing (each value kept that differs
from the template's is a warning), points the configs at the source folder
`.abapgit.xml` names and writes nothing into it. A second run changes
nothing; `dry_run: true` answers the same report without writing. Every path
it writes comes from the template's file list and is checked first - a plain
relative path, a shared file of the template, outside the source folder; one
that fails refuses the whole call before anything is written. A symbolic
link, or a folder that leads out of the project through one, is never
written through: that file is skipped, and the answer says why.

`examples` degrades per catalogue instead of failing: it searches the
checkouts it finds and names the ones it could not, so a thinner answer never
reads as "nobody has built this". It reads each repository's committed
`catalogue.json` where the checkout has one — which is what carries a control
port's verification status (checked over reviewed over generated, used to
break ranking ties), the learning-path stage, and what a stack sample needs
from the system — and falls back to parsing `SAMPLES.md` on a checkout from
before that file existed. `screenshot_view` and `run_app` answer the
same question at three orders of magnitude apart: the first photographs the
reconstructed **view** with no backend, the second the **running app** after a
build. Most iterations should end at the first.

### Operating an app without a browser

`app_start`, `app_act` and `app_describe` make every abap2UI5 app
agent-operable: they speak the JSON protocol the UI5 frontend speaks — the
app start, the event with its arguments, the model delta of what was typed —
against the local backend, and answer with an **agent snapshot** derived from
the response's view XML and model: the fields an agent may fill (model path,
label, kind, current value, choice values, editable), the actions it may fire
(event name, static and row-dependent arguments), the tables (columns, the
first rows, selection - a SelectDialog/TableSelectDialog is a table too, and
`app_act` with `row` picks from it), the messages (toast, message box,
MessageStrip, field value states, MessagePopover and MessageView items) and
some static text. An act is validated against the snapshot
before anything is sent: an unknown event, a field that is not on the screen
or not editable, a choice outside its values is refused with the list of what
is allowed. A short session against `z2ui5_cl_smp_app_009` of
abap2UI5/samples:

```text
app_start { app: "z2ui5_cl_smp_app_009" }
  -> fields f1..f5 (f3 "Input with value", /S_SCREEN/COLOR_02, text, ""),
     actions a1 POPUP_TABLE_VALUE (valueHelpRequest of f3), ..., a5 BUTTON_SEND
app_act { session, values: { f4: "Smith" }, event: "POPUP_TABLE_VALUE" }
  -> layer "popup", table t1 /T_SUGGESTION_SEL (6 rows, Single, editableCells [SELKZ]),
     action a1 POPUP_TABLE_VALUE_CONTINUE
app_act { session, values: { "/T_SUGGESTION_SEL/2/SELKZ": true }, event: "POPUP_TABLE_VALUE_CONTINUE" }
  -> layer "main", f3 = "BLACK", f4 = "Smith", message { toast, "value selected" }
```

The snapshot shape is shared with the VS Code extension and the ABAP agent
addon; [docs/agent-snapshot.md](docs/agent-snapshot.md) is its reference —
the derivation rules, the operations, the deviations from the original
contract and what the snapshot cannot see yet. `interact_app` stays the tool
for what only a browser shows (the rendered page, client-side behaviour).

### The screen in the chat: MCP Apps and Adaptive Cards

The snapshot is text for the agent. Two optional surfaces show the same
screen to the **user** in the chat, and send what the user does back through
`app_act` - the same validation as the agent's own acts, so nothing the
snapshot does not allow can be fired, and the agent sees the act:

- **MCP Apps** ([SEP-1865](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
  stable 2026-01-26, extension `io.modelcontextprotocol/ui`). `app_start`,
  `app_describe` and `app_act` name the UI resource `ui://abap2ui5/app-screen`
  (`_meta.ui.resourceUri`, MIME type `text/html;profile=mcp-app`) when the
  client advertises the extension in its `initialize`. A host that renders MCP
  Apps (the extension's own README lists Claude, ChatGPT, VS Code and Goose)
  shows it as a sandboxed iframe beside the result: fields to fill, buttons,
  row actions, table cells, messages. A click is a `tools/call` of `app_act`
  through the host, built from the snapshot on screen; afterwards the page
  tells the model what happened (`ui/update-model-context`) and renders the
  new snapshot. The page is one self-contained HTML document - no external
  URL, no network, no eval - so it runs under the spec's restrictive default
  CSP; it needs nothing else. `A2UI5_MCP_UI=on` declares the screen for a host
  that renders MCP Apps without advertising the extension, `off` never; the
  tools' text answers do not change either way.
- **Adaptive Cards** for Copilot/Teams-style hosts: `format: "adaptive-card"`
  on `app_start`, `app_describe` and `app_act` (or `A2UI5_MCP_APP_FORMAT=adaptive-card` for every call)
  adds the screen as an Adaptive Card 1.5 - an embedded resource of type
  `application/vnd.microsoft.card.adaptive` after the unchanged snapshot -
  rendered by abap2UI5/protocol's renderer (vendored under
  `lib/vendor/adaptive-cards`). Off by default. Each `Action.Submit` carries
  `session` (and `row` for a row's action); a submitted payload maps to one
  `app_act` call: `event` and `row` as they are, every input whose value
  changed as `values["<binding path>"]`, a message box button as the box's
  close action with the button as its `$action` argument, the popup/popover
  close wire as `@CLOSE_POPUP` / `@CLOSE_POPOVER` (`cardSubmitToAct` in
  `lib/adaptive-card.mjs`; the full table is in
  [docs/agent-snapshot.md](docs/agent-snapshot.md#the-screen-in-the-chat-mcp-apps-and-adaptive-cards)).

### Migrating a classic report

`migrate_report` takes the source of a classic report (`REPORT`,
`PARAMETERS`, `SELECT-OPTIONS`, the event blocks, a `WRITE` list, an ALV) and
its `.prog.xml` text pool, and answers the class of the
[abap-cloud-gui](https://github.com/abap2UI5-addons/abap-cloud-gui) addon
that keeps its programming model — `selection_screen( )`,
`start_of_selection( )`, `write( )`, `alv( )`, `message( )` — together with
the migration report (the TODOs, the tables and APIs not released on ABAP
Cloud with their successors, what the list does not carry over) and the
statements it refused with `file:row:col` (dynpros, batch input, `SUBMIT`,
native SQL). The converter is the addon's own `report2cloud`, run from a
checkout of the addon — it is not on npm:

```sh
git clone https://github.com/abap2UI5-addons/abap-cloud-gui   # ABAP_CLOUD_GUI_HOME
cd abap-cloud-gui && npm ci
```

With `deploy: true` the class is also written into the dev sandbox together
with the addon's runtime (`src/01`, its database tables included - the
backend creates a deployed table at boot) and the popups it calls (a checkout of
[popups](https://github.com/abap2UI5-addons/popups) at `POPUPS_HOME`, else
the addon's `.deps/popups`, `../popups` beside it or the addon's
`build/popups`, in that order), the backend is
built, and the answer carries `app_start`'s snapshot of the selection screen —
`app_act` with `CGUI_EXECUTE` runs the report. The database tables a report
reads are not in the local backend: the screen runs, a run that reads them
does not.

## System mode: operating apps on a real SAP system

Everything above runs without a system. With `A2UI5_MCP_SYSTEM_URL` set, the
same server is something else: the app tools against a **real SAP system**,
logged on as the configured user — for MCP clients that are not the VS Code
extension (whose own system server does this for the clients of its window):
Claude Desktop, Claude Code, Cursor, any stdio client. The sandbox tools are
not offered in this mode; register the server twice, once with and once
without the variable, to have both.

| Tool | What it does |
|---|---|
| `system_status` | The endpoint and user (never the password) and ONE request that shows whether the host answers, the certificate is accepted and the logon works — call it first |
| `app_list` | Class names on the system, from the ADT quick search (`filter`: start of the name, `*` as wildcard; at most 50) |
| `app_start` | Start an app on the system and get its agent snapshot — the same snapshot, arguments and refusals as the sandbox's `app_start` |
| `app_describe` | The current snapshot of a session, from memory — nothing is sent |
| `app_act` | Fill fields and fire an event, validated against the snapshot, sent as the real model delta — **runs for real** |

Claude Desktop (`claude_desktop_config.json`: Settings → Developer → Edit
Config), the sandbox server beside the system one:

```json
{
  "mcpServers": {
    "abap2ui5": {
      "command": "npx",
      "args": ["--yes", "-p", "@abap2ui5/mcp-server", "abap2ui5-mcp"]
    },
    "abap2ui5-dev-system": {
      "command": "npx",
      "args": ["--yes", "-p", "@abap2ui5/mcp-server", "abap2ui5-mcp"],
      "env": {
        "A2UI5_MCP_SYSTEM_URL": "https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100",
        "A2UI5_MCP_SYSTEM_USER": "DEVELOPER",
        "A2UI5_MCP_SYSTEM_PASSWORD_CMD": "security find-generic-password -s abap2ui5-dev -w"
      }
    }
  }
}
```

Claude Code, the same as one command:

```sh
claude mcp add abap2ui5-dev-system \
  -e A2UI5_MCP_SYSTEM_URL='https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100' \
  -e A2UI5_MCP_SYSTEM_USER=DEVELOPER \
  -e A2UI5_MCP_SYSTEM_PASSWORD_CMD='security find-generic-password -s abap2ui5-dev -w' \
  -- npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp
```

| Variable | |
|---|---|
| `A2UI5_MCP_SYSTEM_URL` | The launch URL as the VS Code extension's F9 knows it, `{class}` as a query parameter — or the endpoint without the class. Switches the mode on |
| `A2UI5_MCP_SYSTEM_USER` | The SAP user (Basic authentication) |
| `A2UI5_MCP_SYSTEM_PASSWORD` | Its password — in the client's configuration file, in plain text |
| `A2UI5_MCP_SYSTEM_PASSWORD_CMD` | Instead: a shell command that prints the password, run once and kept in memory. macOS keychain: store it with `security add-generic-password -s abap2ui5-dev -a DEVELOPER -w`, read it as above; Linux: `secret-tool lookup service abap2ui5-dev` |
| `A2UI5_MCP_SYSTEM_INSECURE_TLS` | `1` accepts a certificate that cannot be verified (a development system's self-signed one). Better: `NODE_EXTRA_CA_CERTS` pointing at the system's CA certificate (PEM) |

What to know before switching it on:

- **It acts for real.** An `app_act` event runs on the system as the
  configured user and may save, post or delete data. Use a development
  system and a user whose authorizations fit what the agent may do; the
  agent sees only what that user may see.
- **A rejected logon is sent once.** SAP locks a user after a few failed
  logons, and an agent retries. After a `401` nothing more is sent with that
  password — every tool says so — until the server is restarted with the
  corrected one (Claude Desktop: quit and reopen), or the password command
  answers a different one.
- **Basic authentication only.** SAML, X.509 or SSO logons are not
  supported in this mode; the VS Code extension's system server (its auth
  proxy) is the way there.
- **One system per registration.** Two systems are two entries with two
  names.
- **No proxy support.** The requests go straight to the host;
  `HTTPS_PROXY` is not read.
- The protocol client is the sandbox's (`lib/appclient.mjs`): it does the
  CSRF token handshake and keeps the stateful session's `sap-contextid`
  itself; this mode adds the logon, the system's cookies and the start
  location (`lib/system.mjs`). `app_list` needs the ADT services and the
  user's authorization for them — `app_start` works without both when the
  class name is known.

## Unit tests in CI, without a system

The same runtime runs an app repository's ABAP Unit tests in GitHub Actions
(or at a terminal): `@abap2ui5/node-runtime` at the release the project's
`abaplint.jsonc` pins, installed once and cached, the classes transpiled
against it, the tests run through the generated runner — no framework
clone, none of the framework's devDependencies, and no `npm ci` of this
package either (the runner imports none of its dependencies). Against
app-template's starter app, measured on one machine: 16 s cold and 8 s
with the cache, where the clone of 0.2.0 took 30 s and 23 s and left a
231 MB workspace instead of 67 MB.

```yaml
- uses: abap2UI5/mcp-server@v1
  with:
    paths: src
```

`framework: X.Y.Z` pins another release than the project's, `backend:
clone` takes the old path (the release cloned, its backend downloaded or
built) — which is also what a pin older than the package (1.145.0) gets by
itself.

`@v1` is a floating major tag: the release workflow moves it to every 1.x
release it publishes, so a workflow naming it picks up fixes without
picking up a breaking change. It is created by the 1.0.0 release; until that
release is out, pin `@v0` (0.3.0, where it stays) or a release tag such as
`@v0.3.0`.

```sh
npx -p @abap2ui5/mcp-server abap2ui5-unit src     # the same, locally
```

Every class and interface under `paths` is deployed with all of its files
(an app or not; test and local-class includes too), and every test include
runs. On the package the run uses a sandbox and a build of its own, so an
MCP session's apps on the same machine are neither part of it nor touched by
it. The result is the job's verdict plus a step summary naming every test
method and the first failure; an object that cannot be deployed (a
namespaced name) fails the run rather than leaving its tests out. [app-template](https://github.com/abap2UI5/app-template)
ships the job in its `check.yml` and the command as `npm run test:unit`. What
the runner cannot see is what the open-abap runtime cannot model (see
`pitfalls`, area `abap`); a test that passes here passes on the system short of
that, and a `PARTIALLY IMPLEMENTED` test double has to implement every method
the code under test calls, because the runtime generates no empty stubs.

## Resources

The knowledge documents behind those tools are also MCP **resources**, for
clients that surface them (context pickers, attach-a-document UIs) and for
agents that want a document whole instead of sliced. Same live reads from the
same sibling checkouts: listing is free (no checkout needed), reading a
resource whose checkout is missing answers with the same actionable error the
tool gives.
The one resource that is not a document is `ui://abap2ui5/app-screen`, the
MCP Apps screen of the app tools (see "The screen in the chat" above); it is
part of this server and needs no checkout.

| Resource | Content | Needs |
|---|---|---|
| `abap2ui5://guide` | The app-building guide, whole (`app_guide` slices it) | abap2UI5 |
| `abap2ui5://guide/{chapter}` | One guide chapter, by number or heading keyword (a resource template) | abap2UI5 |
| `abap2ui5://api` | The client API summary — every `z2ui5_if_client` method, constant group and type, one line each | abap2UI5 |
| `abap2ui5://pitfalls/abap` | abap-check — the ABAP defects a green CI does not catch | abap2UI5 |
| `abap2ui5://pitfalls/view` | ui5-check — the view defects a green CI does not catch | abap2UI5 |
| `abap2ui5://capabilities` | CAPABILITIES.md — the verified capability map | samples-controls |
| `abap2ui5://generation-rules` | The rulebook for porting a UI5 demo-kit sample | samples-controls |
| `ui://abap2ui5/app-screen` | The MCP Apps screen of the app tools (`text/html;profile=mcp-app`) - the snapshot as a page the user operates in the chat | - |

## Prompts

Two prompts — one per job this server serves — put an agent straight into the
loop instead of leaving it to reconstruct the order from the tool
descriptions alone. Each renders an orchestration script over the tools above and
duplicates none of their content:

- **`build-an-abap2ui5-app`** (argument: `task`, what the app should do) —
  orient with `examples`/`capabilities`, learn the shape from `app_guide`,
  write the class, iterate through `validate_view`/`screenshot_view` in
  seconds, prove it with `deploy_app` → `build_backend` → `run_app`, close
  with `pitfalls`.
- **`port-a-ui5-sample`** (argument: `sample`, the demo-kit sample) — the
  corpus job: `generation_rules` as the brief, `scope_of` and `capabilities`
  before writing, neighbouring ports from `examples`, then the same
  validate/screenshot/deploy/run loop.

## Notes

- **Dev sandbox:** deployed apps land in the samples-controls checkout's
  gitignored `src/zz_dev/`, else the abap2UI5 checkout's gitignored
  `node/zz_dev/`, else `~/.abap2ui5-mcp/sandbox` (`A2UI5_MCP_WORKSPACE`
  moves it) — nothing an agent deploys can leak into a commit.
- **Backend:** without a framework checkout the npm package
  `@abap2ui5/node-runtime` — `A2UI5_MCP_RUNTIME_VERSION` pins its release
  (default: the registry's latest, asked once a day), `A2UI5_MCP_BACKEND=npm`
  uses it beside a checkout too, `A2UI5_MCP_BACKEND=clone` restores the
  framework clone as the default. Everything it installs lives in
  `~/.abap2ui5-mcp` and is safe to delete.
- **Port:** the backend listens on 3000 (`A2UI5_MCP_PORT` overrides).
- **Timeouts:** every spawned child is killed (whole process tree) when it
  exceeds its limit — lint/scope 5 min, unit tests 10 min, build (with the
  prebuilt download and the npm install) 30 min by default;
  `A2UI5_MCP_LINT_TIMEOUT_MS`, `A2UI5_MCP_SCOPE_TIMEOUT_MS`,
  `A2UI5_MCP_UNIT_TIMEOUT_MS` and `A2UI5_MCP_BUILD_TIMEOUT_MS` override
  (values in ms).
- **Download limits:** what is read from GitHub is capped by size as well as
  by time - 8 MB for a file of the read-only mirror, the docs tree listing
  and the release list (the largest today is 0.34 MB), 200 MB for the
  prebuilt backend archive (2.7 MB for 1.146.0). An answer over the cap is
  refused (when it declares its size) or cut at the cap, and the tool says
  so by URL; a cached mirror or the previous build stays in place.
- **UI5 sources** are served from the samples-controls checkout's `@openui5`
  packages, so booting needs no network. The built theme CSS is not in those
  packages — with network access it loads from the CDN (styled screenshots);
  without, apps render unstyled but structurally complete. `A2UI5_MCP_OFFLINE=1`
  forces the hermetic behaviour.
- **Chromium:** `A2UI5_MCP_CHROMIUM` (or `CHROMIUM_BIN`, which the linter
  reads too) names the executable; otherwise the Playwright-managed browser
  (`npx playwright install chromium`); otherwise a system chromium.
  `setup_status` says which one it found and where it came from.
- **Screenshots:** `run_app` writes its PNG to
  `<tmp>/abap2ui5-mcp-screenshots/<class>.png` and returns the path beside the
  image — deliberately not into the install directory, which is inside
  `node_modules` when you install from npm. That directory is created 0700 and
  used only while it is your own (`/tmp` is shared on Linux); otherwise the
  image is returned but not saved, and `screenshotNotSaved` says why.
  `A2UI5_MCP_SCREENSHOT_DIR` puts them somewhere you keep.
- **`scope_of` needs an OpenUI5 checkout** as well as the corpus: it reads the
  JSDoc from `OPENUI5_SRC`, or from `../fork-openui5` beside the
  **samples-controls** checkout when that variable is unset.
- **If you set this up earlier:** the corpus repository was `ai-demokit`, then
  `abap2UI5-api`, and is `samples-controls` today. Nothing needs changing — an
  existing checkout is still found under any of the three directory names, and
  `AI_DEMOKIT_HOME` is still read alongside `SAMPLES_CONTROLS_HOME`.
- **Real-system deployment** stays what it is today: abapGit. This server is
  the inner dev loop; the real-system half lives in the
  [VS Code extension](https://github.com/abap2UI5/vscode-extension), whose own
  MCP server exposes it as `run_app_on_system`. Both servers are registered in
  the same editor window, which is why that tool is not called `run_app`.

## Working on this repository

```sh
npm ci
npm test
```

`AGENTS.md` carries the conventions, `CONTRIBUTING.md` and `RELEASING.md` the
rest of the workflow.

`bench/` is [abap2UI5-bench](bench/README.md): how often an AI agent's
abap2UI5 app passes the template's gates, with and without this server. It is
a package of its own and not part of the published server.

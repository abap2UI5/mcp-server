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
day at a time) that the server treats as a read-only checkout. And the
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
| `app_start` | Start an app and get its **agent snapshot**: fields (path, label, kind, value), actions (event + arguments), tables, messages — over the abap2UI5 JSON protocol, no browser | a build (same as run_app) |
| `app_describe` | The current agent snapshot of a session, from memory — no roundtrip | a session from app_start |
| `app_act` | Fill fields and fire an event by name — validated against the snapshot, sent as the real model delta — and get the next snapshot | a session from app_start |
| `run_unit_tests` | Run the deployed apps' test classes (on a checkout: or the whole transpiled tree) in the open-abap runtime: assertions, not pictures | a build (npm backend or abap2UI5 checkout) |
| `verify_app` | The whole loop in one call — validate, deploy, build, unit, boot — stopping at the first stage that fails | what the stages need |
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
first rows, selection), the messages (toast, message box, MessageStrip, field
value states) and some static text. An act is validated against the snapshot
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
- uses: abap2UI5/mcp-server@v0.2.0
  with:
    paths: src
```

`framework: X.Y.Z` pins another release than the project's, `backend:
clone` takes the old path (the release cloned, its backend downloaded or
built) — which is also what a pin older than the package (1.145.0) gets by
itself.

Pin a release tag. The release workflow moves a floating major tag (`@v0`)
to every release it publishes; until the first release after 0.2.0 has done
that, `@v0` does not exist and a workflow naming it fails to resolve the
action.

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

| Resource | Content | Needs |
|---|---|---|
| `abap2ui5://guide` | The app-building guide, whole (`app_guide` slices it) | abap2UI5 |
| `abap2ui5://guide/{chapter}` | One guide chapter, by number or heading keyword (a resource template) | abap2UI5 |
| `abap2ui5://api` | The client API summary — every `z2ui5_if_client` method, constant group and type, one line each | abap2UI5 |
| `abap2ui5://pitfalls/abap` | abap-check — the ABAP defects a green CI does not catch | abap2UI5 |
| `abap2ui5://pitfalls/view` | ui5-check — the view defects a green CI does not catch | abap2UI5 |
| `abap2ui5://capabilities` | CAPABILITIES.md — the verified capability map | samples-controls |
| `abap2ui5://generation-rules` | The rulebook for porting a UI5 demo-kit sample | samples-controls |

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
  exceeds its limit — lint/scope 5 min, build 30 min by default;
  `A2UI5_MCP_LINT_TIMEOUT_MS`, `A2UI5_MCP_SCOPE_TIMEOUT_MS` and
  `A2UI5_MCP_BUILD_TIMEOUT_MS` override (values in ms).
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
  `node_modules` when you install from npm. `A2UI5_MCP_SCREENSHOT_DIR` puts them
  somewhere you keep.
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

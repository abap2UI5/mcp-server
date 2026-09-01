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

Level 1 — `validate_view` and `screenshot_view`, the two tools most work
happens at (~3 MB, a minute):

```sh
git clone https://github.com/abap2UI5/linter        # AI_VIEW_CHECK_HOME
cd linter && npm ci
```

The server itself is on npm, so it needs no checkout. Register it with Claude
Code:

```sh
claude mcp add abap2ui5 -- npx --yes @abap2ui5/mcp-server
```

(The install is ~45 MB, 19 MB of it a Playwright driver only `run_app` uses —
paid on the first start, cached after. From a checkout instead:
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

A Claude Code started inside the checkout picks the server up automatically
via the committed [`.mcp.json`](.mcp.json); the
[devcontainer](.devcontainer/devcontainer.json) runs the same setup on create.

## Tools

Every tool reads live from a sibling checkout, and each one needs a specific
sibling — there is no "optional" repository, only tools you do or do not use.
The **Needs** column says which checkout a tool is dead without: the linter
alone carries `validate_view` and `screenshot_view` (the fast loop, where most
iterations happen), the framework checkout carries the guide, the pitfalls and
the backend, and the corpus carries almost everything else. A tool whose
checkout is missing answers with the clone command and env var that fix it.

| Tool | What it does | Needs |
|---|---|---|
| `capabilities` | Whether abap2UI5 can express a UI5 feature at all, from the verified capability map | samples-controls |
| `app_guide` | How to build an app, live from the framework checkout | abap2UI5 |
| `api_reference` | The client API (`z2ui5_if_client`) with its ABAP-Doc: methods, parameters, defaults, the `cs_*` constants | abap2UI5 |
| `scaffold_app` | The files a new project starts from, live from app-template; `{ class: … }` renames throughout, sidecar `CLSNAME` included | app-template |
| `examples` | Search the three sample catalogues, verification status and all — answers with a class to read, never a snippet to trust | any of samples / samples-controls / samples-stack |
| `docs_search` | Full-text search over the documentation site's pages: page, heading, snippet and the published URL | docs |
| `generation_rules` | The rulebook for porting a UI5 demo-kit sample into samples-controls | samples-controls |
| `pitfalls` | The defects a green run does not catch: `{ area: "abap" }` and `{ area: "view" }` | abap2UI5 |
| `scope_of` | In/out-of-scope verdict for a UI5 control | samples-controls + an OpenUI5 checkout |
| `validate_view` | The linter's gates in seconds, judged by your project's own `abap2ui5lint.jsonc` | linter |
| `fix_view` | Apply the linter's mechanical fixes and get the corrected source back — writes nothing | linter |
| `screenshot_view` | See the view in seconds — no build, no backend | linter |
| `deploy_app` | Write the class + abapGit sidecar into the gitignored sandbox, then abaplint it | samples-controls |
| `read_app` | Read a deployed dev app's source back, and whether the built backend already carries it | samples-controls |
| `build_backend` | Rebuild the transpiled Node backend; incremental after the first full build | samples-controls + abap2UI5 |
| `build_log` | Page through the last build's full output — the error the result's short tail cut off | nothing (reads the record the last build left) |
| `run_app` | Boot an app headless: status, real page errors, and a **screenshot** | samples-controls + abap2UI5 |
| `backend` | `status` / `start` / `stop` / `restart` of the local express backend | abap2UI5 (start/restart; status and stop always work) |
| `remove_app` | Delete a dev app from the sandbox, or list the deployed ones | samples-controls |

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
  gitignored `src/zz_dev/` — nothing an agent deploys can leak into a commit.
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
- **Chromium:** uses the Playwright-managed browser; if absent, falls back to a
  system chromium (`A2UI5_MCP_CHROMIUM` overrides the executable path).
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

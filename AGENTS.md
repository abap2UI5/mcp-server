# AGENTS.md — mcp-server

Single source of truth for agents working on the **abap2UI5 MCP server** —
the `capabilities → deploy_app → build_backend → run_app` loop exposed to MCP
clients, no SAP system required.

> This entire project is in **English**. Source files are **7-bit ASCII**
> (stated at `lib/capabilities.mjs` — keep it that way repo-wide).

## The one thing to understand first: this repo cannot work alone

mcp-server **bundles no content**. Every tool reads live from sibling checkouts,
resolved per call in `lib/repos.mjs` (env var → `../<name>` → committed
absolute fallback paths from the original dev sandbox):

| Env var | Default sibling | Used for |
| --- | --- | --- |
| `AI_DEMOKIT_HOME` | `../samples-controls` (or `../ai-demokit`) | CAPABILITIES.md (re-parsed on every query), `scripts/generation-prompt.txt`, `scripts/scope-of.mjs`, `scripts/e2e-build.mjs`, `abaplint.jsonc`, `src/zz_dev/` (deploy target), `node_modules/@openui5/*` (UI5 runtime for screenshots) |
| `A2UI5_HOME` | `../abap2UI5` | `node/srv/express.mjs` (backend server), `node/downport/` + `node/setup/abap_transpile.json` (incremental build), `node/output/` |
| `AI_VIEW_CHECK_HOME` | `../linter` (legacy aliases: `../abap2UI5-linter`, `../ai-view-check`) | `validate_view`: dynamic import of `lib/index.mjs` + `lib/render.mjs`, snapshot `data/properties.json` |

Also: `A2UI5_MCP_PORT`, `A2UI5_MCP_OFFLINE=1` (no CDN fallback for UI5),
`A2UI5_MCP_CHROMIUM` (browser path).

A missing checkout degrades **per tool** (the server still starts;
`resolve*` returns null and the affected tool errors) — `validate_view`
needs the linter, `build_backend`/`run_app`/`backend` need the core repo,
almost everything else needs samples-controls. The README calls the linter
"optional"; that is true for 7 of 9 tools and fatal for `validate_view`.

### The compatibility surface — renames upstream break tools here silently

These upstream file names/shapes are load-bearing for mcp-server. When one
changes upstream, this repo must change in the same breath:

- samples-controls: `CAPABILITIES.md` **table format** (4 columns, status emoji —
  parser + legend in `lib/capabilities.mjs`), `scripts/generation-prompt.txt`,
  `scripts/scope-of.mjs` CLI output, `scripts/e2e-build.mjs`, `abaplint.jsonc`,
  the `src/zz_dev/` package convention.
- abap2UI5 core: `node/srv/express.mjs`, `node/setup/abap_transpile.json`,
  `node/downport/`, `node/output/init.mjs`.
- abap2UI5-linter: `lib/index.mjs`, `lib/render.mjs`, `data/properties.json`
  — imported **by path**, not via the package `exports` map, so even a pure
  file-layout refactor there breaks `validate_view`.

## Side effects on sibling repos — expected, not a bug

The server **writes into the sibling checkouts**. When you (or another
agent) find these artifacts in a dirty sibling worktree, mcp-server caused them:

- `<samples-controls>/.abaplint-mcp-dev.jsonc` — patched lint config for deployed
  dev apps (gitignored there).
- `<samples-controls>/src/zz_dev/*.clas.abap` + `.clas.xml` + `package.devc.xml` —
  deployed dev apps (`remove_app` deletes them again).
- `<abap2UI5>/e2e-transpile.json` — temporary incremental-build config
  (deleted on close).
- `<abap2UI5>/node/` — a clone of `open-abap-core` during builds.

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
deployApp validation error paths, the BENIGN console filter);
`test/smoke.test.mjs` boots the real server over stdio (initialize, 9 tools,
a capabilities query) and **skips itself when the samples-controls sibling is
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

Expect: an `initialize` result, 9 tools in `tools/list`, and capability rows
for "popup". Pure units that are testable without any sibling checkout (add
tests here first): `stripJsonc` (`lib/runtime.mjs`), the CAPABILITIES.md
table parser (`lib/capabilities.mjs`), the class-name/`z2ui5_if_app`
validation in `deployApp`, the `BENIGN` console-noise filter.

## Timing expectations

`build_backend` full build is **tens of minutes** (transpiles the whole
framework); the incremental path is ~1–2 minutes. Set tool/agent timeouts
accordingly — a "hung" build is usually just a slow transpile.

## Maintenance traps (learned, do not repeat)

- The **tool list in the `server.mjs` header comment** and the **server
  `version`** are duplicated by hand — update both when adding a tool or
  bumping `package.json` (they have drifted before: a missing `remove_app`
  row, `1.0.0` vs `0.1.0`).
- `lib/repos.mjs` exports **`VIEW_CHECK_DIRS`**: the checker's own directory
  name `linter` plus the **pre-rename aliases** `abap2UI5-linter` and
  `ai-view-check`, in that order. The VS Code extension mirrors the same list
  by hand in `src/mcp.ts` and `src/viewcheck.ts` — change all three together,
  and drop an alias only in a coordinated change across both repos.
- The committed **absolute fallback paths** (`/home/user/...`) exist for the
  original dev sandbox; in any other environment set the env vars instead of
  editing them.
- The README's setup section and the sibling-layout table above must stay in
  sync — the README is the user-facing copy, this file is the contract.

## Related repositories

| Repository | Relation |
| --- | --- |
| [samples-controls](https://github.com/abap2UI5/samples-controls) | Content substrate: capabilities, rules, scope, deploy target, UI5 runtime |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Runtime substrate: transpiled backend + express server |
| [abap2UI5-linter](https://github.com/abap2UI5/linter) | `validate_view` implementation (path-imported) |
| [vscode-extension](https://github.com/abap2UI5/vscode-extension) | Registers this server for MCP clients in the editor (`src/mcp.ts`) |

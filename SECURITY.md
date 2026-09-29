# Security policy

## Reporting a vulnerability

Please use the GitHub Security Advisory
["Report a Vulnerability"](https://github.com/abap2UI5/mcp-server/security/advisories/new)
tab. Do not open a public issue for a security report.

Expect an acknowledgement within a few days. This project is developed
alongside other work, so a fix is agreed rather than promised by a date — the
advisory is where that conversation happens.

## Supported versions

Only the **latest published version** of `@abap2ui5/mcp-server` is supported.
It is still on the `0.x` line, so a fix ships as the next release rather than
as a patch to an older line.

## What this server is, from a security point of view

Worth knowing before assessing a report:

- **It is a local stdio server, not a network service.** The transport is
  `StdioServerTransport` — it speaks to the MCP client that started it over its
  own stdin and stdout. It opens no socket and listens on no port, so it has no
  attack surface reachable from another machine.
- **It runs with the privileges of whoever started it**, over the checkouts
  beside it, and the expensive half of its tool loop (`build_backend`,
  `run_app`) **executes code**: it transpiles the ABAP and boots the resulting
  app. A tool call is therefore as trusted as the repository it is pointed at.
  Treat an MCP client that can reach this server the way you would treat a
  shell in the same directory.
- **Every spawned child gets a hard timeout and is killed as a process group**
  (`lib/runtime.mjs`), so a hung or forking build cannot outlive the call that
  started it.
- **It runs only tools the checkouts installed themselves.** The lint and
  the incremental transpile start `<checkout>/node_modules/@abaplint/cli`
  and `@abaplint/transpiler-cli` directly. They used to go through `npx`,
  which — with no local bin and no TTY to answer its prompt — fetched
  whatever the registry held under that name (`abap_transpile` is not a
  claimed package name there). A missing install is now reported with the
  `npm ci` that fixes it; nothing is downloaded to be executed.
- **What the npm backend installs, and how.** Without a framework checkout
  the expensive half installs `@abap2ui5/node-runtime` (the release the
  registry names as latest, or `A2UI5_MCP_RUNTIME_VERSION`), `express`
  within that package's peer range, `@abaplint/transpiler-cli` at the
  version the package records and `@abaplint/cli` at app-template's pin -
  four direct dependencies, about 76 packages in all, where the framework
  clone's `npm ci` installed about 205. They go into a directory of their
  own under `~/.abap2ui5-mcp/runtime/<version>`, through the user's own npm
  and its registry configuration (the user-level config and `npm_config_*`;
  the registry lookup and the install both run in that workspace, so a
  project `.npmrc` where the server was started is read by neither), with
  `--ignore-scripts` (no install
  script of any dependency runs), the exact versions recorded
  (`--save-exact`) and a `package-lock.json` whose integrity hashes npm
  checks on every reinstall. Versions and commits read from the registry
  are validated (a plain `X.Y.Z`, a 40-character sha) before they become a
  path or an argument, and npm runs without a shell except on Windows,
  where it is a `.cmd` script and its arguments are quoted.
  **open-abap-core** is fetched with git at the exact commit the release
  records (`git fetch --depth 1 <sha>`, the checkout's `rev-parse` verified
  before it is used) - never a branch, except for a release that records
  none, which gets the default branch's HEAD resolved to a sha and says
  so. The backend it boots listens on 127.0.0.1 only. What runs is still
  code from npm and GitHub: the package's transpiled framework in the
  backend process, the transpiler and abaplint during a build and a lint.
  Trusting them is trusting the abap2UI5 and abaplint publishers, as the
  clone's `npm ci` did - over far fewer packages.
- **The cheap half never executes what it reads.** `validate_view` and
  `screenshot_view` work from source through the linter's render harness:
  the ABAP is parsed and the reconstructed view is loaded in headless
  Chromium. That browser step does run markup — reconstructed, not fetched —
  so treat it as you would any build step over untrusted input.
- **It is published with provenance.** Releases go out from
  `.github/workflows/release.yml` through npm trusted publishing (OIDC), so
  there is no long-lived npm token in this repository to leak, and every
  published tarball carries an attestation linking it to the commit and
  workflow that built it. Verify with `npm audit signatures`.

## Out of scope

- What a tool *reports* about your ABAP or your views — that is the product,
  not a vulnerability. Open an issue.
- A wrong or missing finding from the linter behind `validate_view`. That
  belongs in [abap2UI5/linter](https://github.com/abap2UI5/linter/issues).

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
  attack surface reachable from another machine. The backend it starts for
  `run_app` and the app tools is a child listening on 127.0.0.1 only - the
  npm host binds loopback itself, and a framework checkout's
  `node/srv/express.mjs` (which binds every interface without `HOST`) is
  started with `HOST=127.0.0.1`. Loopback is reachable from every browser
  page on the machine, though, so the npm host also answers only requests
  addressed to `127.0.0.1`, `localhost` or `[::1]` (the `Host` header) and,
  when they carry an `Origin`, sent from a page there - a page cannot drive
  or read the dev apps through DNS rebinding. The server's own clients of
  that backend (the start's port wait, `run_app`'s Chromium, the app tools)
  connect to `127.0.0.1` itself, never to the name `localhost`, which can
  resolve to `::1` - a port another local user may hold. A framework checkout's
  `express.mjs` checks neither header; that check belongs to the framework.
- **A default directory under the shared temp dir is used only when it is
  the user's own.** The GitHub mirror's default base,
  `<tmp>/abap2ui5-mcp-remote`, and the default screenshot dir,
  `<tmp>/abap2ui5-mcp-screenshots` (the PNGs of `run_app` and
  `interact_app`, and the build log `build_log` reads after a restart), have
  fixed names under `os.tmpdir()` - `/tmp` on Linux, which every local user
  can write. Each is read and written only
  when it is a real directory (no symbolic link), owned by the user running
  the server and writable by nobody else; the server creates it 0700 and
  narrows one of its own that others can read (`lib/private-dir.mjs`).
  Anything else is refused with the reason - a screenshot is then returned
  but not saved - and `A2UI5_MCP_REMOTE_DIR` / `A2UI5_MCP_SCREENSHOT_DIR` put
  them elsewhere (a directory those variables name is not checked - below).
- **A directory the operator names is trusted like the operator's shell.**
  `A2UI5_MCP_REMOTE_DIR`, `A2UI5_MCP_SCREENSHOT_DIR` and
  `A2UI5_MCP_WORKSPACE` (and a checkout env var such as `A2UI5_HOME`) are
  used as they are: no owner, mode or symbolic-link check, because the
  person who set the variable chose the place, and refusing a shared team
  directory or a symlinked home they set up on purpose would be the server
  second-guessing its operator. What follows from that is the operator's to
  keep true: whoever can write into such a directory decides what the
  server serves and runs. The mirror directory is what the knowledge tools
  answer with and what `add_agent_setup` copies into a project; the
  workspace holds the `node_modules` the backend, the transpiler and
  abaplint run from; the screenshot directory receives the pictures of the
  user's apps and the build log `build_log` reads back. Point them at
  directories only you can write - never at a world-writable place such as
  `/tmp` itself. The defaults are checked (above) precisely because nobody
  chose them.
- **A child that runs the app gets an allowlisted environment.** The
  backend and the unit-test runner execute the transpiled ABAP, and
  open-abap's `@KERNEL` escape gives that code `process.env`. They inherit
  only what Node, the runtime and an app's outbound HTTP need - `PATH`, the
  home and temp directories (`HOME`, `USERPROFILE`, `TMPDIR`, `TMP`,
  `TEMP`), `TZ` and the locale (`LANG`, `LANGUAGE`, `LC_*`), `NODE_ENV` and
  `DEBUG` (express reads them), `NODE_OPTIONS`, `NODE_ICU_DATA`, the CA and
  TLS variables (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `OPENSSL_CONF`, and `LD_LIBRARY_PATH` for the libraries they load), the
  proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`,
  `NODE_USE_ENV_PROXY` - a proxy URL may carry its credentials: it is passed
  because an app's HTTP needs it as much as the server's), the Windows
  system variables (`SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`,
  `SYSTEMDRIVE`, `APPDATA`, `LOCALAPPDATA`, `USERNAME`, `USERDOMAIN`,
  `PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS`) - plus `PORT` and the
  loopback `HOST` (`appChildEnv` in `lib/runtime.mjs` lists each with its
  reader; `test/security.test.mjs` fails when this list and that one
  differ).
  The GitHub token, the system-mode SAP credentials and anything else the
  user's shell exports (cloud keys, registry tokens) stay with the server.
  Defence in depth: deploying ABAP is running code with your privileges, and
  an allowlist does not change that. The build, lint, git and npm children
  run no app code and keep the full environment their own configuration
  lives in.
- **A checkout's symbolic links are not followed out of it.** A checkout is
  untrusted content - a sample, docs or template repository cloned from
  GitHub, a sandbox an earlier deploy filled - and a repository can ship a
  symbolic link (`docs/agents/building-apps.md -> ~/.ssh/id_rsa`). Every
  file a tool answers with or copies (the guide, the interface, the
  pitfalls, the capability map, the porting brief, the sample catalogues,
  the docs tree, a sample `read_example` reads, the template files
  `scaffold_app` serves and `add_agent_setup` copies into a project, the
  support classes `migrate_report { deploy: true }` copies, the sandbox the
  npm build transpiles) is read only when it resolves inside its checkout,
  and every write into the sandbox or a checkout is refused when its path
  leaves it - a dangling link included, since writing through one creates
  its target wherever it points - and opened with `O_NOFOLLOW`, so a link
  that appears after the check fails the write instead of redirecting it
  (`lib/contain.mjs`). Checkouts whose CODE this server runs anyway - the
  framework (its backend), samples-controls' scripts (`scope_of`, the full
  build), abap-cloud-gui's converter (imported in-process), app-template's
  `scripts/check-pin.mjs` - are trusted the way that code is; the link
  checks still apply to what is read from them.
- **`migrate_report` refuses a report that carries the transpiler's code
  escape.** On an SAP system `WRITE '@KERNEL <text>'.` writes a line; the
  transpiler copies `<text>` into the generated module as JavaScript. No
  classic report has a reason to contain it, so the tool refuses such a
  source (and any converter output that contains one) before anything is
  converted or written. A dynamic `LOOP AT ... WHERE (<condition>)` is
  ordinary ABAP and is converted, but flagged: `@abaplint/runtime`
  evaluates the condition with `eval()`, so one built from user input is
  code injection on the backend - an upstream property of the runtime this
  server reports rather than fixes.
- **It runs with the privileges of whoever started it**, over the checkouts
  beside it, and the expensive half of its tool loop (`build_backend`,
  `run_app`) **executes code**: it transpiles the ABAP and boots the resulting
  app. A tool call is therefore as trusted as the repository it is pointed at.
  Treat an MCP client that can reach this server the way you would treat a
  shell in the same directory.
- **What it downloads from GitHub is capped in size, not only in time.**
  A file of the read-only mirror, the docs tree listing and the framework's
  release list are read up to 8 MB (the largest is 0.34 MB today), the
  prebuilt backend archive up to 200 MB (2.7 MB today) - so a proxy or
  mirror in between that answers with a huge or endless body cannot fill
  the memory or the temp disk. An answer that declares more is refused
  unread, one that streams more is cut at the cap; either is reported by URL
  (`TEXT_MAX_BYTES` in `lib/remote.mjs`, `PREBUILT_MAX_BYTES` in
  `lib/runtime.mjs`).
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

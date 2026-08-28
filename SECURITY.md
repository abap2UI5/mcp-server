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

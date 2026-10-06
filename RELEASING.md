# Releasing

One tag publishes one package: **`@abap2ui5/mcp-server`** on the public npm
registry — and then lists that version in the
[official MCP Registry](https://github.com/modelcontextprotocol/registry) as
**`io.github.abap2UI5/mcp-server`**, from [`server.json`](server.json).
Everything mechanical lives in
[`.github/workflows/release.yml`](.github/workflows/release.yml); its header
comment is the reference. This file is the human checklist.

## What a release is for

Merging to `main` is the release for everyone reading the repository. npm is
the one channel that needs a deliberate, immutable version, and this server
needs it more than most: its **tool names and result shapes are a contract**
with every agent configuration that registers it. `npx --yes
github:abap2UI5/mcp-server` resolves to whatever `main` holds that day, so an
agent setup that worked on Monday can behave differently on Tuesday without
anyone having decided that.

## How reversible is it?

A published version cannot be changed or replaced. `npm unpublish` is limited
to the first 72 hours and, for a package others depend on, is worse than the
bug it would remove.

The everyday correction is a new version. What genuinely cannot be taken back
is the **package name** — `@abap2ui5/mcp-server` — so that is the one thing worth
getting right the first time. The same holds for the registry name
`io.github.abap2UI5/mcp-server`: a registry version cannot be edited either
(`mcp-publisher status` can only mark it deprecated or deleted).

## One-time setup — what a maintainer still has to do by hand

Everything below needs a human with npm credentials; no workflow can do it.

The npm organisation `abap2ui5` already owns the scope (`@abap2ui5/linter`
and `@abap2ui5/linter-render`, formerly `@abap2ui5/render-runtime`, are
published under it), so step 1 of the linter's checklist does not apply here.

Trusted publishing can only be configured for a package that **already
exists**, so the first publish is manual:

```sh
npm login
npm publish --access public
```

(No `--provenance` on that one: npm generates an attestation only from a
supported CI and aborts anywhere else. The bootstrap version ships without it;
every release the workflow cuts has it.)

Then, on npmjs.com → `@abap2ui5/mcp-server` → **Settings → Trusted Publisher**, point
it at this repository and `release.yml`. From the second release on the
workflow publishes with no token at all.

**The MCP Registry needs no setup.** The `mcp-registry` job logs in with
`mcp-publisher login github-oidc`: GitHub's OIDC token for this workflow run is
traded for a registry token that may publish `io.github.<repository owner>/*` —
no secret, no PAT, nobody's account. The registry proves the npm package
belongs to the listing by fetching the version `server.json` names from npm and
comparing its `mcpName` (`package.json`) with `server.json`'s `name`. So the
first version that can be listed is the first one published WITH `mcpName` —
1.0.0 — and the listing can only follow the npm publish. Done by hand instead
(an org **Owner** of abap2UI5 — the registry grants the org namespace to
owners only), from a checkout at the released tag:

```sh
mcp-publisher login github     # device flow in the browser
mcp-publisher publish          # reads ./server.json
```

Two things follow the first publish, in other repositories. Both were done
when 0.1.0 landed; what they still are is the checklist for the release after
a **rename**, and that list is under [After a release](#after-a-release) rather
than here — it used to be in both places, in the present tense here and in the
past tense there, so the file contradicted itself about work that was finished.

## Cutting a release

1. `CHANGELOG.md` — move the `Unreleased` entries under the new version. The
   release workflow refuses to publish a tag whose version has no section, or
   one that still has entries left under `Unreleased`: a published version
   whose changes are filed under `Unreleased` forever can only be corrected by
   burning another version number.
2. Bump and tag:

   ```sh
   npm version patch|minor|major
   git push --follow-tags
   ```

   `npm version` commits and creates an **annotated** tag here — there is no
   workspace to keep in step, unlike in `abap2UI5/linter`. The version lives
   in three files, and the command keeps all three in step: it bumps
   `package.json` and `package-lock.json` itself, and then runs the
   `version` script, which writes the new version into both version fields of
   `server.json` and stages it (`scripts/check-server-json.mjs --sync`), so
   one commit carries all three.

   **When the bump arrived through a pull request** instead (a release PR,
   as for 1.0.0, with the version and the changelog section already on
   `main`), do not run `npm version` — it would bump once more. Tag the merge
   commit:

   ```sh
   git tag -a v1.0.0 -m 1.0.0 && git push origin v1.0.0
   ```
3. Watch the run. It refuses to publish if the tag and `package.json`
   disagree, if `server.json` disagrees with `package.json`
   (`npm run check:server-json`: both versions, the package name, `mcpName`,
   and the environment variables against the ones the code reads) or if the
   changelog is not in the shape step 1 leaves it in, runs the sibling-free
   test suite on the exact commit, and prints the tarball contents before the
   publish step.
4. The `mcp-registry` job then publishes `server.json`. It fails on its own,
   after npm already holds the version: npm can take a moment to serve a
   version it just accepted (the job retries for about four minutes), the
   registry is still a preview service, and an `mcp-publisher` that is too old
   for the registry deployment answers "invalid audience". The npm release
   and the major tag stand either way; fix the cause and **re-run the failed
   job** from the run's page. For "invalid audience", move
   `MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` in `release.yml` to the
   newest [registry release](https://github.com/modelcontextprotocol/registry/releases)
   (the sha256 of `mcp-publisher_linux_amd64.tar.gz` is in its
   `registry_<version>_checksums.txt`) — on `main`, and publish that one
   version by hand as above, since a re-run uses the tagged workflow.

To rehearse everything except the publish, dispatch the workflow by hand from
the Actions tab — same gates, same tarball, no registry write (neither npm
nor the MCP Registry: the `mcp-registry` job runs for tags only).

## What the first release was checked against

Done once, by hand, before there was anything on npm — repeat it if
`package.json`'s `files`, `bin`, `dependencies` or `peerDependencies` ever
change (the peer declaration after 0.3.0 did: `pack-smoke` and a `setup_status`
over the npx-installed tarball, which resolved the hoisted linter):

- **The manifest carries everything a published package needs**: `name`,
  `version`, `description`, `bin` (`mcp-server` and `abap2ui5-mcp` →
  `server.mjs`, which has its shebang; `abap2ui5-unit` → the CI runner),
  `files`, `engines` (node >= 22), `repository`, `homepage`,
  `bugs`, `license`, `keywords`, `publishConfig.access: public` — and, from
  1.0.0, `mcpName` (`io.github.abap2UI5/mcp-server`), the MCP Registry's
  proof that the package belongs to the listing. No `main` and
  no `exports`, deliberately: this is a program, not a library. `server.json`
  is not in `files`: the registry reads it from the checkout at publish time,
  not from the tarball.
- **The tarball is `server.mjs`, `lib/`, `scripts/ci-unit.mjs` (the
  `abap2ui5-unit` bin), `action.yml`, `README.md`, `LICENSE` and
  `package.json`** — no tests, no workflows, no lockfile, none of the other
  scripts (`npm pack --dry-run` lists it; `package.json` `files` is the list). `AGENTS.md` used to
  ship too, on the reasoning that an agent could read the contract of the thing
  it is driving; it cannot, because that file is written for an agent working
  ON this repository (build & verify, the sibling checkouts the server writes
  into, the maintenance traps). What an agent driving the server needs is the
  tool descriptions it already receives over the protocol, and the README.
  Re-measure the packed/unpacked size the next time this list changes.
- **The packed tarball starts and answers.** Installed into a scratch project
  and driven over stdio through its `bin`: initialize, `tools/list`, and a
  tool call with every checkout absent, which has to come back as the
  actionable message rather than a crash. That is now a workflow step
  (`The packed tarball starts and answers`) instead of a thing to remember —
  `npm test` runs against the working tree, where a `lib/` module missing from
  `files` still exists, so nothing else in the suite can see that defect.
- **npx runs the tarball the way users do.** 0.2.0 had no bin named after
  the package, so `npx --yes @abap2ui5/mcp-server` — the registration every
  document gives — failed with "could not determine executable to run", and
  the step above stayed green because it called the bin by name. The bin
  `mcp-server` is that name; `scripts/pack-smoke.mjs` (the workflow step
  `npx runs the packed tarball the way users do`) runs `npx --yes <tarball>`,
  `npx -p <tarball> abap2ui5-mcp` and `npx -p <tarball> abap2ui5-unit
  --help`, answers an MCP `initialize` and checks the server exits when stdin
  closes. Run it by hand (`npm pack && node scripts/pack-smoke.mjs
  abap2ui5-mcp-server-*.tgz`) before tagging a release that touches `bin`
  or `files`.
- **The level-1 tools work from the tarball**: with only `AI_VIEW_CHECK_HOME`
  pointed at a linter checkout, `validate_view` returned `ok: true` on a clean
  view and `screenshot_view` returned a PNG. Neither needs the corpus.

One thing worth knowing before the first `npm publish`: **the install is
~45 MB**, and 19 MB of that is `playwright` + `playwright-core`, which only
`run_app` uses (via a dynamic import). `npx --yes @abap2ui5/mcp-server` therefore
pays for a browser driver before it validates a single view. Marking the
dependency `optional` would not help — npm installs optional dependencies by
default — so the fix is the shape `@abap2ui5/linter` arrived at: a separate
package carrying the heavy runtime, declared as an optional PEER. Worth doing,
not worth blocking the first release on.

The half of that split that costs nothing is done (the release after
0.3.0): **the linter is declared.** `package.json` names `@abap2ui5/linter` as a REGULAR peer
(`>=0.8.0 <0.9.0`) and `@abap2ui5/linter-render` as an OPTIONAL one in the
same range. Regular, not optional, on purpose, and measured rather than
assumed (npm 10): `npx -p <pkg>` and `npm install` both install a
non-optional peer by themselves, hoisted beside the package
(`node_modules/@abap2ui5/{mcp-server,linter}` — the server's first sibling
candidate, so no new lookup was needed), and both leave an optional peer
alone. So `npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp` now carries the
property gate: 1.9 MB unpacked on top of a 45 MB install, against
`validate_view` and `fix_view` being dead for everyone who did not also type
`-p @abap2ui5/linter` (the VS Code extension's 0.30.1 had to grow a warning
for exactly that). linter-render stays optional because it is the 123 MB of
UI5 plus Playwright's browser, and because the range alone is what a user
needs from the declaration: npm checks an optional peer that IS installed as
strictly as a regular one (an out-of-range linter answers ERESOLVE either
way — tested), so optional buys the choice, not a laxer install. What the
declaration costs: the range has to MOVE with the linter's minor (the
`compatibility surface` in AGENTS.md says how), and `npm install` in this
checkout now installs the linter too (npm installs a root's own regular
peer), which is why the lockfile carries it and `npm ci` in CI runs the
lintopts and fix-view suites against the published linter. The playwright
half — a separate package carrying the browser driver — is still the open
part.

## What is NOT covered by the release gate

`npm test` on a bare checkout is the sibling-free half: the parsers, the
config resolution, the process-tree timeouts, the degradation contract - and,
since the npm backend, the backend half of the expensive loop:
`test/npm-integration.test.mjs` installs the published
`@abap2ui5/node-runtime`, fetches open-abap-core, lints, builds, runs a test
class, boots the backend and does a GET and a POST roundtrip (about 30 s;
it skips itself when the registry or GitHub cannot be reached, so read the
test count). It does **not** cover the BROWSER half of `run_app` and
`interact_app`, nor the render half of `validate_view`: those need UI5 - the
CDN, or the `@openui5` packages of a corpus or linter install - and a
Chromium.

So a release is verified for everything up to a served backend, and
verified by hand for the screenshot loop. If that loop breaks, it breaks
after the tag. Worth remembering before cutting one.

**`@abap2ui5/node-runtime` is a dependency of the loop without being one
of `package.json`'s**: the server installs whatever release the registry
names as latest (or `A2UI5_MCP_RUNTIME_VERSION` pins), at runtime. A new
framework release reaches users of an unchanged server within a day. What
has to hold across such a release is written down in AGENTS.md (the
compatibility surface); the integration test is the check - run it after
the framework publishes, not only before this server does.

## After a release

**The floating major tag.** The composite action is used as
`abap2UI5/mcp-server@v1`; the workflow's `move-major-tag` job points the
major of each release it publishes (`v1` for 1.x) at it (it needs `contents:
write`, and nothing in the publishing jobs does). A new major creates a new
tag and leaves the previous one where it was: `v0` stays at 0.3.0, so a
workflow pinned to `@v0` keeps working and keeps 0.3.0 until somebody moves
it to `@v1`. **After 1.0.0**: app-template's `check.yml` and any other
`@v0` consumer move to `@v1` — a change in those repositories. Should a run
ever fail before the job, the tag is set by hand:
`git tag -f v1 v1.0.0^{} && git push -f origin refs/tags/v1`.

Both of these were done when 0.1.0 landed; they are here as the checklist for
the release after a **rename**, which is when they come back:

- The [VS Code extension](https://github.com/abap2UI5/vscode-extension)
  registers this server via `npx --yes @abap2ui5/mcp-server` — unpinned, because
  the server's compatibility is with the corpora it reads and not with that
  extension. A rename of this package is a change in that repository.
- The README's setup section leads with `npx --yes -p @abap2ui5/mcp-server
  abap2ui5-mcp` (the form every version answers) and mentions
  a checkout only for working on the server itself.

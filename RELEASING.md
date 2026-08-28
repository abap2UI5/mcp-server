# Releasing

One tag publishes one package: **`@abap2ui5/mcp-server`** on the public npm
registry. Everything mechanical lives in
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
getting right the first time.

## One-time setup — what a maintainer still has to do by hand

Everything below needs a human with npm credentials; no workflow can do it.

The npm organisation `abap2ui5` already owns the scope (`@abap2ui5/linter`
and `@abap2ui5/render-runtime` are published under it), so step 1 of the
linter's checklist does not apply here.

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
   workspace to keep in step, unlike in `abap2UI5/linter`.
3. Watch the run. It refuses to publish if the tag and `package.json`
   disagree or if the changelog is not in the shape step 1 leaves it in, runs
   the sibling-free test suite on the exact commit, and prints the tarball
   contents before the publish step.

To rehearse everything except the publish, dispatch the workflow by hand from
the Actions tab — same gates, same tarball, no registry write.

## What the first release was checked against

Done once, by hand, before there was anything on npm — repeat it if
`package.json`'s `files`, `bin` or `dependencies` ever change:

- **The manifest carries everything a published package needs**: `name`,
  `version`, `description`, `bin` (`abap2ui5-mcp` → `server.mjs`, which has
  its shebang), `files`, `engines` (node >= 22), `repository`, `homepage`,
  `bugs`, `license`, `keywords`, `publishConfig.access: public`. No `main` and
  no `exports`, deliberately: this is a program, not a library.
- **The tarball is `server.mjs`, `lib/`, `README.md`, `LICENSE` and
  `package.json`** — no tests, no workflows, no lockfile. `AGENTS.md` used to
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

## What is NOT covered by the release gate

`npm test` on a bare checkout is the sibling-free half: the parsers, the
config resolution, the process-tree timeouts, the degradation contract. It
does **not** cover `run_app`, `build_backend` or the render half of
`validate_view`, because those need the samples-controls checkout, its own
`npm ci` and a Chromium — minutes of setup for a check that then takes tens
of minutes to transpile.

So a release is verified for everything that can run without a corpus, and
verified by hand for the screenshot loop. If that loop breaks, it breaks
after the tag. Worth remembering before cutting one.

## After a release

Both of these were done when 0.1.0 landed; they are here as the checklist for
the release after a **rename**, which is when they come back:

- The [VS Code extension](https://github.com/abap2UI5/vscode-extension)
  registers this server via `npx --yes @abap2ui5/mcp-server` — unpinned, because
  the server's compatibility is with the corpora it reads and not with that
  extension. A rename of this package is a change in that repository.
- The README's setup section leads with `npx @abap2ui5/mcp-server` and mentions
  a checkout only for working on the server itself.

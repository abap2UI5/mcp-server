# abap2UI5-bench

A reproducible benchmark for one question: **how often does an AI coding
agent hand you an abap2UI5 app that passes the gates, with and without the
abap2UI5 agent tooling?** Twenty app-building tasks, each run under four
conditions, graded by the same gates a project made from
[app-template](https://github.com/abap2UI5/app-template) runs in CI.

It lives in the mcp-server repository because the MCP server is one of the
things it measures; it is not part of the npm package (`package.json` ships a
`files` whitelist that does not name `bench/`), and it has its own
`package.json` so the server keeps its dependency list.

## What is measured

Every trial is one agent, one task, one condition, one fresh workspace. When
the agent stops, the abapGit objects it created or changed are copied out and
graded:

| Check | What decides it |
| --- | --- |
| `deliverable` | the classes the task names exist and implement `z2ui5_if_app` |
| `abaplint` | app-template's `abaplint.jsonc`, unchanged except that the abap2UI5 dependency is the release it pins, cloned once instead of on every run |
| `lint` | `@abap2ui5/linter`'s static gate with app-template's `abap2ui5lint.jsonc` (UI5 1.71 floor, `failOn: warning`, `chain-house-layout` on) |
| `render` | the same run's render gate: every view the classes build is reconstructed from the ABAP and loaded with `XMLView.create` in headless Chromium. A class whose view cannot be reconstructed (a hand-written XML string, the frozen `z2ui5_cl_xml_view`) has not been rendered and does not pass |
| `expect` | the task's `expect.json`: the controls, wired events, bindings and client API calls the task needs, judged on the reconstructed views |

**The headline number is "lint and render clean"**: `deliverable` and
`abaplint` and `lint` and `render` - exactly what `npm run check` in a project
made from the template decides. "All checks" adds `expect`. The report also
shows abaplint without the three abapGit-metadata rules (`xml_bom`,
`xml_consistency`, `description_empty`), because the `.clas.xml` sidecar
conventions are the one part an agent cannot derive from ABAP knowledge alone,
and a reader should be able to see how much of a gap they make.

The gate versions are not the bench's choice: `verify.mjs` fails when
`package.json` here differs from the pinned template's `package-lock.json`.

## The four conditions

| Condition | Workspace | Prompt |
| --- | --- | --- |
| `baseline` | empty | the task |
| `llms` | empty | the "Paste the essentials" block of the docs page [Developing with AI](https://abap2ui5.github.io/docs/get_started/ai.html) (llms.txt, building-apps.md, the linter), then the task |
| `template` | the app-template project at the pin - AGENTS.md with the full app-building guide, CLAUDE.md, the four skills, `.claude/settings.json`, the gates installed with `npm ci` - but without its `.mcp.json` | the task |
| `full` | `template` plus the abap2UI5 MCP server registered (the template's own `.mcp.json`, with the version resolved once per run and pinned for all its trials) | the task |

Everything else is the same in every condition: the task text, the autonomy
note (`prompts/common.md`), the tool allowlist (the MCP server's tools are
added where it is registered), the time and cost budget, the model. Each
trial's exact prompt is kept in its result directory.

## Tasks

| Task | Level | What it asks for |
| --- | :-: | --- |
| `01-hello-toast` | 1 | Greeting: input, button, message toast |
| `02-counter` | 1 | Counter: three buttons, a lower bound with a toast |
| `03-confirm-delete` | 1 | Delete with confirmation: message box with actions, its close event, a disabled button |
| `04-stock-check` | 1 | Stock check: message boxes of three severities |
| `05-form-validation` | 2 | Registration form with validation: value states and texts per field |
| `06-cascading-select` | 2 | Shipping destination: two dependent dropdowns |
| `07-table-sort-filter` | 2 | Product catalog: table, search, sort |
| `08-tabs` | 2 | Sales order with tabs: icon tab bar with a table, a form and a text area |
| `09-tree` | 2 | Organization tree: three-level tree, item press with the node's text |
| `10-tile-dashboard` | 2 | Sales dashboard: tiles with numeric content, one critical, no charts |
| `11-todo-list` | 2 | To-do list: add, tick off, filter, remove done |
| `12-editable-table` | 2 | Price list maintenance: editable table, add/delete rows, save with validation |
| `13-popover` | 3 | Order details: a popover anchored to the pressed row's button |
| `14-value-help` | 3 | Supplier value help: F4 dialog with a searchable table |
| `15-dialog-create` | 3 | Contacts: a create dialog with validation that stays open on error |
| `16-date-filter` | 2 | Bookings by travel date: date range filter in the backend |
| `17-master-detail` | 3 | Customer list and detail: two apps, navigation there and back, data handed back |
| `18-file-upload` | 3 | Material list upload: CSV upload, parsed into a table |
| `19-wizard` | 3 | Leave request wizard: three steps, validated submit |
| `20-object-page` | 3 | Product object page: header, three sections with form, table and list |

Each task directory holds `task.md` (the prompt, in business language; it
names the class, asks for abapGit files in `src/` and names the targets -
abap2UI5 1.145.0, SAPUI5 1.71 - the way a requester would), `expect.json` and
`reference/src/` - a hand-written solution that passes every check.

## Running it

Once per machine:

```bash
cd bench
npm ci                 # the gates, at the template's versions
# the render gate needs a Chromium: Playwright's (npx playwright install chromium,
# or PLAYWRIGHT_BROWSERS_PATH pointing at one) or CHROMIUM_BIN
node verify.mjs        # pins resolve, 20 references pass, 7 broken variants fail as intended
node run.mjs --dry-run --concurrency 4   # the whole pipeline with the references as the "agent": 80 trials, must be 100%
```

The first `verify` clones the pinned app-template and the abap2UI5 release it
pins into `bench/.cache/` (network, a few seconds); after that grading is
offline. A grade takes 5-8 s (abaplint and the render gate run in parallel).

**The headline numbers** (Claude Code, 20 tasks x 4 conditions x 3
repetitions = 240 trials):

```bash
export ANTHROPIC_API_KEY=...                  # isolated trials start without a login
node run.mjs --reps 3 --concurrency 4 --run-id launch-$(date +%Y%m%d)
node report.mjs results/launch-<date> --out results/launch-<date>/report.md
```

Add `--model <id>` to fix the model; without it the CLI's default is used, and
either way the model each trial actually ran on is read from its transcript
and printed in the report. Other knobs: `--tasks 01,05`, `--conditions
baseline,full`, `--timeout-min 20` (default), `--max-budget-usd 5` (default,
per trial), `--max-turns <n>` (passed through to `claude`; a hidden flag in
some CLI versions), `--resume <run-id>` (keeps graded trials, reruns the
rest), `--seed` (the trial order is shuffled reproducibly so the conditions
share the same hours of API weather), `--mcp-server local` (this checkout's
`server.mjs` instead of the published package), `--keep-workspaces`.

**Expected cost and time.** Depends on the model; as an order of magnitude,
a trial is 10-40 turns and 2-10 minutes, about USD 0.20-2.00. The full 240
trials are therefore roughly USD 50-400 and 4-10 hours at `--concurrency 4`
(the agent is the bottleneck; grading adds about 10 s per trial). Run a pilot
first: `--reps 1` is 80 trials, a third of that. The per-trial cap
(`--max-budget-usd 5`) bounds the worst case at USD 1,200 for 240 trials.

### Isolation

Workspaces are created under the OS temp directory (`--workspace-root`), never
inside this checkout. Each Claude Code trial gets a fresh `CLAUDE_CONFIG_DIR`,
`--setting-sources project,local` and `--strict-mcp-config`, so no user-level
CLAUDE.md, skill, plugin, hook or MCP server of the machine reaches any
condition; that is why it needs `ANTHROPIC_API_KEY` (or another provider's
credentials). `--no-isolate` uses your own login and configuration and is
recorded in `run.json`. The environment variables that point the MCP server at
local checkouts (`A2UI5_HOME`, `SAMPLES_CONTROLS_HOME`, ...) are removed from
the agent's environment, so `full` gets what an npx user gets.

An agent with a shell can still read anything on the machine, including this
directory. Every tool call in the transcript is scanned for the bench's path
(`bench/tasks`, `bench/verify`); a hit marks the trial `contaminated` and the
report excludes it and says how many. Run on a machine (or container) without
this checkout where you can.

### In GitHub Actions

Two workflows carry the bench, neither of them part of the server's `ci.yml`:

- **`bench-verify`** runs on every push and pull request that touches
  `bench/` (or the two workflows): `node verify.mjs`, then the whole
  `run.mjs` -> `report.mjs` pipeline through the Claude Code adapter with
  `verify/fake-claude.mjs` standing in for the CLI (task 01, all four
  conditions, `full` against this checkout's `server.mjs`). No API call, no
  secret, about 5 minutes with the installs. A change under `bench/` that
  turns it red has broken the grader or the harness, not the agents.
- **`bench`** is the one-click run, `workflow_dispatch` only - it never starts
  from a push or a pull request, because every run spends money.

To run `bench`:

1. Add the repository secret **`ANTHROPIC_API_KEY`** (Settings > Secrets and
   variables > Actions > New repository secret). Use a key of its own with a
   spend limit set in the Anthropic console: the agent runs with that key in
   its environment and has a shell.
2. Actions > **bench** > Run workflow, and fill in the inputs: `reps`
   (default 1), `tasks` (empty = all 20), `conditions` (default all four),
   `model` (empty = the CLI's default), `concurrency` (default 4),
   `max_budget_usd` (per trial, default 5), `seed`, and
   `claude_code_version` (default `latest`; the version a run used is in its
   `run.json`, pass it here to repeat the run).
3. The job checks the secret and the inputs, installs the gates, Chromium and
   the CLI, runs `node verify.mjs` (a broken grader stops the run before it
   costs anything), runs `run.mjs` with isolated trials, writes the report
   table to the job summary and uploads `bench/results/<run-id>/` as the
   artifact `bench-<run-id>` (90 days) - also when the run fails or hits its
   time limit, so the trials that finished are kept.

The cost is the one under "Expected cost and time" above: a `reps 1` run over
everything is 80 trials, roughly USD 16-160, with the per-trial cap bounding it
at USD 400. Try `tasks: 01` and `conditions: baseline,full` (2 trials) first.
GitHub-hosted jobs stop after 6 hours, which a `reps 1` run fits at
concurrency 4; for the three repetitions of the headline dispatch three runs
with different seeds, download the artifacts and report them together
(`node report.mjs results/<run1> results/<run2> results/<run3>`).

**The honest limitation.** The runner that runs the agent also holds the
bench checkout. The workflow removes the reference solutions and `verify/`
from the working tree before the first trial (a non-dry run never reads them;
they are marked skip-worktree, so `run.json` still records a clean bench
commit), the workspaces lie under the runner's temp directory and the checkout
keeps no token. But the task texts, the expect checks and the git objects
(`git show` brings the references back) stay on the machine, and an agent with
a shell can find them. The contamination flag is the only guard against that:
read the contaminated count in the report before quoting a number, and when it
is not zero, look at those transcripts.

### Results

```
results/<run-id>/
  run.json        what ran on what: agent and CLI version, requested model, pins,
                  gate versions, MCP server version, limits, seed, bench commit
  trials.jsonl    one line per trial (the report reads the meta.json files)
  trials/<task>/<condition>/r<k>/
    prompt.md         the exact prompt
    transcript.jsonl  the agent's stream-json transcript
    agent.stderr.log
    output/           the abapGit objects the agent created or changed
    grade.json        every check, with abaplint issues, linter findings, render errors
    meta.json         timings, model, turns, cost, tokens, tool calls, MCP connection
```

`results/` is gitignored. To publish a number, publish the run directory
behind it (a release asset, a gist) together with the bench commit in
`run.json`, so anybody can regrade the outputs: `node grade.mjs --task <id>
results/<run>/trials/<task>/<cond>/r<k>/output`.

Excluded from the rates, and counted in the report: trials whose agent never
started (no session, an auth error), trials whose grading failed for a harness
reason, contaminated trials. A timeout or a budget stop is the agent's result
and counts as a failure. A `full` trial whose MCP server did not connect is
kept (that is what the user would have got) and flagged.

## Adding a task

1. `tasks/NN-slug/task.md` - business language, names the class
   `zcl_bench_NN`, ends with the same deliverable paragraph as the others.
2. `tasks/NN-slug/reference/src/` - the solution, `.clas.abap` plus
   `.clas.xml` (UTF-8 with BOM, LF). Write it the way the guide says; `npx
   abap2ui5lint --fix` from `bench/` lays out the chains.
3. `tasks/NN-slug/expect.json` - `level` (1-3), `classes`, and the checks the
   task needs (`controls`, `events`, `bindings`, `attrs`, `calls`, `perClass`;
   the shape is documented at the top of `lib/expect.mjs`). Ask only for what
   the task text demands, and list every reasonable alternative (`["sap.m.Table",
   "sap.ui.table.Table"]`): the checks are static, a control built in a LOOP
   or a bound template counts once, and a value the reconstruction cannot
   compute is dropped - an `attrs` entry falls back to the property name
   written in the source for that reason.
4. `node verify.mjs` - the reference must pass. Add a broken variant under
   `verify/broken/` when the task introduces a check nothing else exercises.

Changing a task changes the experiment: never compare runs across a change to
`tasks/`, `prompts/` or `bench.config.json`.

## Adding an agent

An adapter is a module in `adapters/<name>.mjs` whose default export has:

```js
export default {
  name: 'my-agent',
  async info() { return { name, version } },        // recorded in run.json
  preflight({ isolate }) {},                         // throw to refuse to start
  async run({ workspace, prompt, task, mcpConfig, model, limits, logDir, env, isolate }) {
    // run the agent in `workspace` with `prompt`; `mcpConfig` is the path of
    // an { mcpServers } JSON in the full condition, null otherwise; honour
    // limits.timeoutMs / maxTurns / maxBudgetUsd where the CLI can; write the
    // transcript into logDir/transcript.jsonl
    return { exitCode, timedOut, durationMs, infraError, model, turns, costUsd,
             tokens, toolCalls, mcpToolCalls, mcpServers, contaminated };
  },
};
```

and `node run.mjs --agent my-agent` uses it. `adapters/claude-code.mjs` is the
worked example; `verify/fake-claude.mjs` tests its plumbing without an API
call (`CLAUDE_BIN=verify/fake-claude.mjs node run.mjs --tasks 01 --no-isolate`).
Notes for the next ones (from the CLIs' documentation at the time of
writing - check `--help` of the version you run, these move fast):

- **Codex CLI**: a non-interactive `codex exec` with JSON event output and
  automatic approval in the workspace; MCP servers come from its config file
  (`config.toml`), so `full` needs a per-trial config home carrying the
  `abap2ui5` server - which is also the isolation. It reads `AGENTS.md`
  natively, so `template` works unchanged.
- **GitHub Copilot CLI**: a prompt mode (`-p`) with tool approval switched to
  allow-all; MCP servers from its user config directory, so again a per-trial
  config directory. Usage is reported in premium requests rather than USD:
  return `costUsd: null` and record the count in the transcript.
- **Cursor CLI** (`cursor-agent`): a print mode with JSON output; MCP servers
  from the workspace's `.cursor/mcp.json`, so `full` writes that file (from
  the same `mcpServers` object) instead of passing a flag.

Whatever the CLI, keep the four conditions' difference to the workspace and
the paste block, keep the tool allowlist equal across conditions, and never
let a trial see this directory.

## Threats to validity

Say these next to any number this produces.

- **Small N.** 20 tasks x 3 repetitions is 60 trials per condition; the report
  prints a 95% Wilson interval for the headline, and at this size intervals of
  +-10-15 points are normal. A difference smaller than the intervals is not a
  finding.
- **Model drift.** A hosted model changes under the same name, and the CLI
  changes its system prompt and tools between versions. A number is only valid
  for the model, CLI version and date in its `run.json`; rerun rather than
  compare against an old run.
- **The project wrote the tasks, the references and the grader.** The tasks
  are shaped by what abap2UI5 does well, the expect checks by how the authors
  would build the app, and the gates are the project's own. The reference
  solutions are in this public repository and may end up in training data.
  Mitigations: the gates are the ones every template user runs, unchanged; the
  expect checks list alternatives and ask only for what the task text demands;
  everything is published for others to rerun and to add tasks to.
- **The gates are not correctness.** Lint and render clean means the app
  compiles against the pinned framework, follows its rules and its view loads
  in UI5 1.71-era metadata. It does not mean the app does what the task says:
  nothing is executed (the expect checks look at the view and the API calls,
  not at behaviour), and an app can pass with wrong business logic.
- **Static reconstruction has blind spots.** A view built from a raw XML string
  or the frozen `z2ui5_cl_xml_view` cannot be rendered and fails `render` and
  `expect` - deliberately (the linter says so too), but it penalises an
  approach that runs. Views built in loops or from data are reconstructed once.
- **The conditions differ in more than knowledge.** `template` and `full` start
  with the gates installed and the guide in context, `baseline` and `llms`
  start with nothing and may not be able to run abaplint at all - which is the
  point of the tooling, but it is the tooling AND its installation that is
  measured. The template also states the abapGit sidecar conventions that the
  bare conditions have to guess; the abaplint (code only) column separates
  that part.
- **The task text names targets** (abap2UI5 1.145.0, SAPUI5 1.71, abapGit
  files). A requester would; without it the bare conditions could not know the
  bar they are judged by.
- **Contamination detection is a heuristic.** It catches a tool call naming
  the bench's path, not an agent that found the reference another way.

## Moving the pins

`bench.config.json` pins app-template by commit; the abap2UI5 release follows
from that template's `abaplint.jsonc`; the gate versions must match its
lockfile (`verify.mjs` checks). To move: set the new `templateRef`, align
`package.json` with the template's lockfile, `npm install`, `node verify.mjs`,
and treat every run after it as a new series.

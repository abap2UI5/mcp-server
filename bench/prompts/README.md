# Prompt parts

What an agent is given, besides the task's own `task.md`. `run.mjs` builds
every prompt from these files and nothing else, and writes the exact prompt of
each trial into its result directory (`prompt.md`).

| File | Sent in | Source |
| --- | --- | --- |
| `common.md` | every condition, after the task | written for the bench - the same autonomy note for all four conditions, so the only difference between them is the tooling |
| `llms-paste-block.txt` | `llms`, before the task | verbatim the "Paste the essentials" block of the docs page "Developing with AI" (`docs/get_started/ai.md` in abap2UI5/docs, commit f159c7ac1b55623556b613d1478e3a01fc14aa75, also on abap2UI5's README) |

When the docs page changes its block, copy the new one here in a commit of its
own and say so in the next report: runs on either side of that commit are
different experiments.

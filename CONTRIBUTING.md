_This project is open source and developed alongside other projects or during free time. Contributions are greatly appreciated!_

Check out the contribution guidelines [here.](https://abap2ui5.github.io/docs/resources/contribution.html)

## Before opening a pull request

```bash
npm ci
npm test               # the sibling-free half: parsers, resolution, timeouts
```

This server bundles no content — every tool reads live from sibling checkouts,
so the half of the suite that needs `abap2UI5` and `samples-controls` next to
this repository only runs when they are there. [AGENTS.md](AGENTS.md) is the
full contract: the compatibility surface (upstream file names and shapes that
break tools here silently), the side effects on sibling checkouts, and the
degradation rule — a missing checkout is an actionable message, never a crash.

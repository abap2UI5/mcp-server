/*
 * prompts — the two workflows this server exists for, as MCP prompts.
 *
 * A prompt here is an ORCHESTRATION script, not content: it names the tools
 * in the order the loop wants them and says what each answer is for, and it
 * duplicates nothing those tools serve — the guide, the rulebook, the
 * pitfalls all stay upstream, read live when the agent calls the tool. The
 * whole point is that an agent (or a user picking a slash-command in a
 * client that surfaces prompts) starts inside the loop instead of having to
 * discover from sixteen tool descriptions that app_guide comes first and
 * run_app comes last.
 *
 * Two prompts, deliberately not more: one per job this server serves —
 * building an app of your own, and porting a demo-kit sample. The same split
 * the tools already draw between app_guide and generation_rules, for the
 * same reason: the two jobs share their machinery and disagree on their
 * brief, and a prompt that tried to cover both would mis-brief one of them.
 */

export const PROMPTS = [
  {
    name: 'build-an-abap2ui5-app',
    title: 'Build an abap2UI5 app',
    description:
      'Walks the full development loop for an app of your own: examples/app_guide first, then write the '
      + 'class, validate_view + screenshot_view every iteration (seconds, no system), deploy/build/run to '
      + 'prove it, pitfalls before calling it done. Takes what the app should do as its argument.',
    arguments: [
      {
        name: 'task',
        description: 'what the app should do, in a sentence or two — e.g. "a table of flights with a search field and a detail popup"',
        required: true,
      },
    ],
  },
  {
    name: 'port-a-ui5-sample',
    title: 'Port a UI5 demo-kit sample',
    description:
      'The corpus job: rebuild one official UI5 demo-kit sample as an abap2UI5 port class. Starts from '
      + 'generation_rules (the canonical brief), checks scope_of and capabilities, imitates neighbouring '
      + 'ports, then iterates through the same validate/screenshot/deploy/run loop. Takes the sample as '
      + 'its argument.',
    arguments: [
      {
        name: 'sample',
        description: 'the demo-kit sample to port — control and sample name or id, e.g. "sap.m.Wizard, Basic Wizard"',
        required: true,
      },
    ],
  },
];

export const PROMPT_NAMES = PROMPTS.map((p) => p.name).sort();

function buildAnApp(task) {
  return `You are building an abap2UI5 app. The task: ${task}

Work the loop this server is built around - the cheap feedback first, the build last:

1. ORIENT. Call \`examples\` with keywords from the task: what comes back is a complete, gated
   app to READ in its repository, worth more than any snippet. Call \`capabilities\` before
   deciding any UI5 feature cannot be built - it answers direct / workaround / needs-live-test /
   not-expressible, each entry naming a proving port.
2. LEARN THE SHAPE. Call \`app_guide\` without arguments once and read it whole - it is the
   rulebook for exactly this job. While writing, \`api_reference\` answers what \`client\` can do
   (methods, cs_* constants, types) with real signatures, and \`docs_search\` finds the cookbook
   page when you need the longer story.
3. WRITE the class: one global ABAP class implementing z2ui5_if_app. If the user wants a
   standalone project rather than a class, call \`scaffold_app\` first and build inside it.
4. VALIDATE CHEAPLY, EVERY ITERATION. \`validate_view\` and \`screenshot_view\` answer in seconds
   with no backend and no build - fix every finding (pass explain: true when a rule is unclear)
   and LOOK at the picture until the view is right. Most iterations must end here.
5. PROVE IT RUNS. \`deploy_app\`, then \`build_backend\` (the first full build takes tens of
   minutes - that is normal, not a hang), then \`run_app\`: read the status, the real page errors
   and the screenshot of the running app. Iterate; \`remove_app\` cleans up when you are done.
6. BEFORE CALLING IT DONE, call \`pitfalls\` and check the app against both catalogues - they are
   the defects a green run does not catch ({ area: "abap" } and { area: "view" }).

A tool that answers "checkout not found" is naming the sibling repository to clone and the env
var that points at it - do that and retry rather than working around the tool.`;
}

function portASample(sample) {
  return `You are porting one official UI5 demo-kit sample to abap2UI5. The sample: ${sample}

1. Call \`generation_rules\` FIRST and treat it as the brief - it is the canonical porting
   rulebook (naming, fidelity, deviations), and where anything below disagrees with it, it wins.
2. CHECK THE GROUND. \`scope_of\` gives the in/out-of-scope verdict for the sample's controls;
   \`capabilities\` says whether each feature is expressible and how (direct, workaround,
   needs-live-test, not-expressible) - do not discover mid-port what was never in scope.
3. IMITATE. \`examples\` with repo "samples-controls" finds the neighbouring ports; read the
   closest one (checked beats reviewed beats generated) before writing a line.
4. WRITE the port class, then iterate with \`validate_view\` and \`screenshot_view\` - seconds,
   no backend - until the view is legal and the picture matches the original sample.
5. PROVE IT. \`deploy_app\`, \`build_backend\` (tens of minutes on the first full build), then
   \`run_app\` and compare the running app against the original. Call \`pitfalls\` before
   declaring the port finished, and record any deviation the way the rulebook prescribes.`;
}

/*
 * Which renderer belongs to which prompt, said once and explicitly.
 *
 * This used to be a two-way ternary — `name === 'build-an-abap2ui5-app' ? … : …`
 * — which is not a dispatch but a default: ANY name that was not the first one
 * got the PORTING brief. With two prompts that is merely fragile; the day a
 * third is added it is a silent mis-brief, an agent told to rebuild a demo-kit
 * sample it was never given. A map cannot do that: a prompt without a renderer
 * fails, by name, the first time it is rendered.
 */
const RENDERERS = {
  'build-an-abap2ui5-app': (args) => buildAnApp(String(args.task).trim()),
  'port-a-ui5-sample': (args) => portASample(String(args.sample).trim()),
};

/**
 * `prompts/get` for one prompt: `{ description, messages }`. Throws on an
 * unknown name and on a missing required argument — the two mistakes a
 * client can actually make here.
 */
export function getPrompt(name, args = {}) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) {
    throw new Error(`unknown prompt: ${name} — this server has ${PROMPT_NAMES.map((n) => `'${n}'`).join(' and ')}`);
  }
  for (const a of prompt.arguments) {
    if (a.required && !(args[a.name] && String(args[a.name]).trim())) {
      throw new Error(`prompt '${name}' needs the argument '${a.name}': ${a.description}`);
    }
  }
  const render = RENDERERS[name];
  if (!render) {
    // declared in PROMPTS and never given a renderer: a bug here, not a client
    // mistake, and it must say so rather than serve another prompt's brief
    throw new Error(`prompt '${name}' is declared but has no renderer — add one in lib/prompts.mjs`);
  }
  const text = render(args);
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

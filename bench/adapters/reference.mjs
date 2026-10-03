// Adapter: the reference solution, standing in for an agent.
//
// Used by `run.mjs --dry-run`: every step of a real run happens - the
// workspace is prepared for the condition, the prompt is written, the output
// is collected from the workspace and graded - except that instead of an
// agent writing the classes, the task's reference/ is copied into the
// workspace. Free, offline once the pins are cached, and it proves the
// harness end to end: a dry run must come out 100% in every condition.
import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'reference',

  async info() {
    return { name: 'reference', version: 'n/a' };
  },

  preflight() {},

  async run({ workspace, prompt, task, logDir }) {
    const started = Date.now();
    fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), `${JSON.stringify({ type: 'reference', promptChars: prompt.length })}\n`);
    fs.cpSync(path.join(task.dir, 'reference'), workspace, { recursive: true });
    return {
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - started,
      infraError: null,
      model: 'reference',
      models: [],
      turns: 0,
      costUsd: 0,
      tokens: null,
      toolCalls: {},
      mcpToolCalls: 0,
      mcpServers: [],
      contaminated: false,
    };
  },
};

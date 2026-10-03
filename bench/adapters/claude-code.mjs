// Adapter: Claude Code, headless (`claude -p`).
//
// One trial = one `claude -p "<prompt>"` in the workspace, streamed as
// stream-json so the whole transcript is kept (turns, tool calls, which MCP
// servers connected) - the final `result` event carries what
// `--output-format json` would print (cost, usage, turns, model usage).
//
// Isolation: by default every trial gets a fresh CLAUDE_CONFIG_DIR, so no
// user-level CLAUDE.md, skill, plugin, hook or MCP server of the machine
// leaks into a condition; only the project's own files (the template's
// CLAUDE.md, skills, settings) and --mcp-config reach the agent. A fresh
// config directory has no login, so this needs ANTHROPIC_API_KEY (or another
// provider's credentials in the environment). --no-isolate uses the user's
// own configuration instead and is recorded as such.
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_DIR, run } from '../lib/util.mjs';

const BIN = process.env.CLAUDE_BIN || 'claude';

/* The same tools in every condition; the MCP server's tools are added only
 * where it is registered. dontAsk denies anything else instead of hanging
 * on a prompt nobody answers. */
const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill'];

export default {
  name: 'claude-code',

  /** Static facts recorded once per run. */
  async info() {
    const r = await run(BIN, ['--version'], { timeoutMs: 30000 });
    if (r.code !== 0) throw new Error(`${BIN} --version failed - is Claude Code installed? ${r.stderr.trim()}`);
    return { name: 'claude-code', bin: BIN, version: r.stdout.trim() };
  },

  /** What has to be true before the first trial. */
  preflight({ isolate }) {
    const creds = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN'];
    if (isolate && !creds.some((k) => process.env[k])) {
      throw new Error('isolated trials start from an empty CLAUDE_CONFIG_DIR, which has no login: set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN, or a Bedrock/Vertex setup), or pass --no-isolate to use your own configuration (then recorded as not isolated)');
    }
  },

  async run({ workspace, prompt, mcpConfig, model, limits, logDir, env, isolate }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk',
      '--allowedTools', [...TOOLS, ...(mcpConfig ? ['mcp__abap2ui5'] : [])].join(','),
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--no-session-persistence'];
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    if (model) args.push('--model', model);
    if (limits.maxTurns) args.push('--max-turns', String(limits.maxTurns));
    if (limits.maxBudgetUsd) args.push('--max-budget-usd', String(limits.maxBudgetUsd));

    const childEnv = { ...env };
    if (isolate) {
      const cfg = path.join(logDir, 'claude-config');
      fs.mkdirSync(cfg, { recursive: true });
      childEnv.CLAUDE_CONFIG_DIR = cfg;
    }
    const transcript = fs.createWriteStream(path.join(logDir, 'transcript.jsonl'));
    let buf = '';
    const events = [];
    const r = await run(BIN, args, {
      cwd: workspace,
      env: childEnv,
      timeoutMs: limits.timeoutMs,
      onStdout: (d) => {
        transcript.write(d);
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { events.push(JSON.parse(line)); } catch { /* a non-JSON line stays in the transcript */ }
        }
      },
    });
    if (buf.trim()) { try { events.push(JSON.parse(buf.trim())); } catch { /* ignore */ } }
    await new Promise((res) => transcript.end(res));
    fs.writeFileSync(path.join(logDir, 'agent.stderr.log'), r.stderr);
    if (isolate) fs.rmSync(path.join(logDir, 'claude-config'), { recursive: true, force: true });
    return summarize(events, r);
  },
};

/** Fold the stream into the trial's metadata. Exported for the tests of the
 *  harness (verify.mjs feeds it a recorded stream). */
export function summarize(events, proc) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') || null;
  const result = [...events].reverse().find((e) => e.type === 'result') || null;
  const toolCalls = {};
  let contaminated = false;
  const benchMarkers = [BENCH_DIR, 'bench/tasks', 'bench/verify'];
  for (const e of events) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      if (c.type !== 'tool_use') continue;
      toolCalls[c.name] = (toolCalls[c.name] || 0) + 1;
      const input = JSON.stringify(c.input || {});
      if (benchMarkers.some((m) => input.includes(m))) contaminated = true;
    }
  }
  const mcpServers = init && Array.isArray(init.mcp_servers) ? init.mcp_servers.map((s) => ({ name: s.name, status: s.status })) : [];
  const models = result && result.modelUsage ? Object.keys(result.modelUsage) : [];
  const usage = result && result.usage ? result.usage : null;
  return {
    exitCode: proc.code,
    timedOut: proc.timedOut,
    durationMs: proc.durationMs,
    // the agent never got going: no init event, or no result and no timeout
    infraError: !init ? `no session started (exit ${proc.code}): ${proc.stderr.slice(-500)}`
      : (!result && !proc.timedOut ? `no result event (exit ${proc.code}): ${proc.stderr.slice(-500)}` : null),
    model: (init && init.model) || models[0] || null,
    models,
    claudeCodeVersion: init && init.claude_code_version || null,
    turns: result ? result.num_turns : null,
    costUsd: result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    tokens: usage ? {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
    } : null,
    resultSubtype: result ? result.subtype : null,
    isError: result ? !!result.is_error : null,
    resultText: result && typeof result.result === 'string' ? result.result.slice(0, 2000) : null,
    toolCalls,
    mcpToolCalls: Object.entries(toolCalls).filter(([k]) => k.startsWith('mcp__')).reduce((s, [, v]) => s + v, 0),
    mcpServers,
    contaminated,
  };
}

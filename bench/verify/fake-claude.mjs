#!/usr/bin/env node
// A stand-in for the `claude` binary, for testing the Claude Code adapter's
// plumbing without an API call:
//
//   CLAUDE_BIN=verify/fake-claude.mjs node run.mjs --tasks 01 --no-isolate
//
// It checks the arguments the adapter passes against the workspace it is run
// in (an MCP config exactly where the workspace registers the server, the
// same tool list otherwise, stream-json output), copies the named task's
// reference solution into the workspace the way an agent would write it, and
// prints a stream-json transcript shaped like the real one. Any mismatch is
// an exit 3 with the reason on stderr, which the run records as an agent
// infrastructure error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('0.0.0 (fake-claude)\n'); process.exit(0); }

const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const fail = (m) => { process.stderr.write(`fake-claude: ${m}\n`); process.exit(3); };
const ws = process.cwd();
const prompt = opt('-p');
if (!prompt) fail('no -p prompt');
if (opt('--output-format') !== 'stream-json' || !argv.includes('--verbose')) fail('expected --output-format stream-json --verbose');
if (opt('--permission-mode') !== 'dontAsk') fail('expected --permission-mode dontAsk');
if (!argv.includes('--strict-mcp-config')) fail('expected --strict-mcp-config');
const mcpConfig = opt('--mcp-config');
const tools = (opt('--allowedTools') || '').split(',');
const hasMcpJson = fs.existsSync(path.join(ws, '.mcp.json'));
if (!!mcpConfig !== hasMcpJson) fail(`--mcp-config ${mcpConfig ? 'given' : 'missing'} but the workspace ${hasMcpJson ? 'registers' : 'does not register'} a server`);
if (tools.includes('mcp__abap2ui5') !== !!mcpConfig) fail('mcp__abap2ui5 allowed without an MCP config, or the reverse');
if (fs.existsSync(path.join(ws, 'AGENTS.md')) && !fs.existsSync(path.join(ws, 'node_modules', '@abap2ui5', 'linter'))) fail('a template workspace without the installed gates');

const cls = (/`(zcl_bench_\d\d)`/.exec(prompt) || [])[1];
if (!cls) fail('the prompt names no zcl_bench_NN class');
const tasksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks');
const taskDir = fs.readdirSync(tasksDir).find((d) => d.startsWith(cls.slice(-2) + '-'));
fs.cpSync(path.join(tasksDir, taskDir, 'reference'), ws, { recursive: true });

const servers = mcpConfig ? Object.keys(JSON.parse(fs.readFileSync(mcpConfig, 'utf8')).mcpServers).map((name) => ({ name, status: 'connected' })) : [];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'system', subtype: 'init', model: opt('--model') || 'fake-default', mcp_servers: servers, claude_code_version: '0.0.0' });
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `src/${cls}.clas.abap` } }] } });
if (mcpConfig) emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__abap2ui5__validate_view', input: {} }] } });
emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [opt('--model') || 'fake-default']: {} }, result: 'done' });

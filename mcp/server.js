#!/usr/bin/env node
// circuit-agent-mcp — an MCP server that lets any MCP client (Claude Desktop, Claude
// Code, IDEs) drive a running circuit-agent. It is a thin wrapper over the agent's
// existing local dashboard HTTP API — it adds no dependencies to the agent itself and
// runs as a separate process, so the agent's runtime is untouched.
//
// Transport: stdio (the MCP standard for local servers).
//
// Config via env:
//   CIRCUIT_AGENT_URL      base URL of the agent dashboard (default http://127.0.0.1:18800)
//   CIRCUIT_AGENT_API_KEY  x-api-key, if the dashboard has one set
//   CIRCUIT_AGENT_TRADING  '1' to expose pause/resume + chat-driven trading (default off)
//
// Read-only tools are always on. Trading control (pause/resume) is gated behind
// CIRCUIT_AGENT_TRADING=1 so the safe default can't move money or halt the agent.
'use strict';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE     = (process.env.CIRCUIT_AGENT_URL || 'http://127.0.0.1:18800').replace(/\/$/, '');
const API_KEY  = process.env.CIRCUIT_AGENT_API_KEY || '';
const TRADING  = process.env.CIRCUIT_AGENT_TRADING === '1';

// ── agent API helper ────────────────────────────────────────────────────────
async function agentFetch(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`agent ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

// ── tool catalog ──────────────────────────────────────────────────────────────
const READ_TOOLS = [
  { name: 'agent_status',   description: "The agent's live status: open positions, P&L, wallet balances, scanner state.",
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/status') },
  { name: 'agent_positions', description: 'Current open positions with live P&L.',
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/positions') },
  { name: 'agent_trades',   description: 'Closed trade history (net-of-fees P&L, exit reasons, timestamps).',
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/trades') },
  { name: 'agent_wallet',   description: 'Agent wallet: SOL + CIRC balances and address.',
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/wallet') },
  { name: 'agent_last_scan', description: 'Most recent market scan results (scored candidates).',
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/last-scan') },
  { name: 'agent_swarm',    description: 'Recent swarm signals and peer registry the agent sees.',
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/swarm') },
  { name: 'agent_config',   description: 'Current editable agent config (secrets stripped).',
    schema: { type: 'object', properties: {} }, run: () => agentFetch('/api/config') },
  {
    name: 'agent_chat',
    description: "Ask the agent's own LLM a question (research a token, explain a decision, run a scan). Returns the agent's reply. This is how you talk to the agent conversationally.",
    schema: { type: 'object', properties: { message: { type: 'string', description: 'What to ask the agent' } }, required: ['message'] },
    run: (a) => agentFetch('/api/chat', { method: 'POST', body: { message: String(a.message ?? ''), source: 'openrouter' } }),
  },
];

const TRADING_TOOLS = [
  {
    name: 'agent_pause',
    description: 'Pause the agent from opening NEW positions. The position monitor keeps running (exits still fire). Optional minutes; omit for indefinite.',
    schema: { type: 'object', properties: { minutes: { type: 'number', description: 'Auto-resume after N minutes (optional)' } } },
    run: (a) => agentFetch('/api/chat', { method: 'POST', body: { message: a.minutes ? `Pause trading for ${a.minutes} minutes.` : 'Pause trading.', source: 'openrouter' } }),
  },
  {
    name: 'agent_resume',
    description: 'Resume the agent opening new positions.',
    schema: { type: 'object', properties: {} },
    run: () => agentFetch('/api/chat', { method: 'POST', body: { message: 'Resume trading.', source: 'openrouter' } }),
  },
];

const TOOLS = TRADING ? [...READ_TOOLS, ...TRADING_TOOLS] : READ_TOOLS;
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ── server ──────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'circuit-agent', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOL_BY_NAME[req.params.name];
  if (!tool) return err(`unknown tool: ${req.params.name}`);
  try {
    return ok(await tool.run(req.params.arguments ?? {}));
  } catch (e) {
    return err(e.message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs (stdout is the MCP channel)
process.stderr.write(`circuit-agent-mcp ready → ${BASE} (trading tools ${TRADING ? 'ENABLED' : 'off'})\n`);

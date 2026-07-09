# circuit-agent-mcp

Control and query your running **circuit-agent** from any MCP client — Claude Desktop,
Claude Code, or any IDE that speaks the Model Context Protocol.

It's a thin wrapper over the agent's existing local dashboard API, running as a separate
process. It adds **no dependencies to the agent itself** and never touches its runtime.

## What you can do

Sit in Claude and say things like:

> "Check my circuit-agent's positions, and if today's net P&L is worse than −0.02 SOL, pause it for 6 hours."

> "Ask my agent to research this token and tell me whether it would buy it."

## Tools

**Read-only (always on):** `agent_status`, `agent_positions`, `agent_trades`,
`agent_wallet`, `agent_last_scan`, `agent_swarm`, `agent_config`, `agent_chat`
(talk to the agent's own LLM — research, explanations, scans).

**Trading control (opt-in, `CIRCUIT_AGENT_TRADING=1`):** `agent_pause`, `agent_resume`.

By default trading tools are **off**, so the server can read and converse but can't halt the
agent or move money.

## Setup

```bash
cd circuit-agent/mcp
npm install
```

Then add it to your MCP client. For **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "circuit-agent": {
      "command": "node",
      "args": ["/absolute/path/to/circuit-agent/mcp/server.js"],
      "env": {
        "CIRCUIT_AGENT_URL": "http://127.0.0.1:18800",
        "CIRCUIT_AGENT_TRADING": "0"
      }
    }
  }
}
```

## Config (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `CIRCUIT_AGENT_URL` | `http://127.0.0.1:18800` | Agent dashboard base URL |
| `CIRCUIT_AGENT_API_KEY` | — | Sent as `x-api-key` if the dashboard has one set |
| `CIRCUIT_AGENT_TRADING` | `0` | `1` to enable pause/resume tools |

## Remote agents

The agent dashboard binds to loopback. To reach an agent on a VPS, tunnel it —
`ssh -L 18800:localhost:18800 user@vps` — and point `CIRCUIT_AGENT_URL` at
`http://127.0.0.1:18800`. Set an `apiKey` on the dashboard and pass it via
`CIRCUIT_AGENT_API_KEY` for defence in depth.

MIT.

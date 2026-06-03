# Agent Setup Walkthrough

Step-by-step guide from zero to a running agent. Covers single-agent and multi-agent deployments.

---

## Single Agent

### 1. Clone the repo

```bash
git clone https://github.com/Circuit-LLM/circuit-agent
cd circuit-agent
npm install
```

### 2. Initialize — generate wallet + run setup wizard

```bash
node agent.js init
```

This will:
- Generate a fresh Solana keypair
- Open the interactive setup wizard (5 steps, ~2 minutes)
- Register your agent with the CIRCUIT swarm

The wizard walks you through:

| Step | What it asks | Default if you skip |
|------|-------------|---------------------|
| 1 — Helius RPC URL | Paste your Helius RPC endpoint | Public Solana RPC (rate-limited, works) |
| 2 — LLM provider | OpenRouter or Ollama | OpenRouter |
| 3 — OpenRouter key | Paste your `sk-or-…` key | LLM disabled (trading still runs) |
| 4 — Telegram bot token | Paste your bot token from @BotFather | Skipped — use CLI commands instead |
| 5 — CIRCUIT Data API | API base URL | `https://api.circuitllm.xyz` |

When it finishes it prints your wallet address. Copy it.

### 3. Fund the wallet

Send to your wallet address:
- **0.1 SOL minimum** — covers gas and entry trades
- **50,000 CIRCUIT** — covers API call costs (agent earns more from trading profits)

No SOL = no trades. No CIRCUIT = no market data.

Check balances at any time:

```bash
node agent.js wallet
```

### 4. Test before starting

```bash
node agent.js wallet   # SOL + CIRCUIT balances
node agent.js status   # Open positions (empty on first run)
node agent.js scan     # Live market scan — prints top candidates with scores
```

If `scan` returns results, the agent is connected and ready.

### 5. Start the agent

```bash
node agent.js start
```

Five loops start in parallel:
- **Auto-scanner** — every 5 min: scan → score → rug check → buy best candidate
- **Position monitor** — every 10s: check stops → auto-sell on trigger
- **Heartbeat** — every 5 min: build status → exception alerts → registry ping
- **Agent-loop** — every 90 min: LLM sets session mode, pattern filters, buy cap
- **Reflect** — every 4h: review trades → tune config → share insights to swarm

Without Telegram, use the CLI to interact:

```bash
node agent.js send "what are you watching right now?"
node agent.js send "pause buying for 30 minutes"
node agent.js send "reflect now"
node agent.js status
```

---

## Run as a systemd Service (Recommended)

Keeps the agent running after you close the terminal and auto-restarts on crash or reboot.

### Create the service file

Replace `YOUR_USERNAME` with your Linux username and `/path/to/circuit-agent` with the full path to this folder.

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/circuit-agent.service << 'EOF'
[Unit]
Description=circuit-agent — autonomous Solana trading agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/circuit-agent
ExecStart=/usr/bin/node agent.js start
Restart=on-failure
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
```

### Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable --now circuit-agent
```

### Common commands

```bash
systemctl --user status circuit-agent        # Check status
journalctl --user -u circuit-agent -f        # Live logs
systemctl --user restart circuit-agent       # Restart
systemctl --user stop circuit-agent          # Stop
systemctl --user disable circuit-agent       # Remove from autostart
```

---

## Multi-Agent Setup (deployedswarm)

Run multiple independent agents from separate directories. Each agent has its own wallet, .env, config, data, and positions — completely isolated.

### Directory structure

```
~/deployedswarm/
  agent1/   ← full circuit-agent clone
  agent2/   ← full circuit-agent clone
  agent3/   ← full circuit-agent clone
  agent4/   ← full circuit-agent clone
```

### Set up each agent

Repeat this for `agent1`, `agent2`, `agent3`, `agent4`:

```bash
cd ~/deployedswarm

# Clone
git clone https://github.com/CircuitLLM/circuit-agent agent1
cd agent1
npm install

# Initialize — generates a fresh wallet for THIS agent
node agent.js init

# Note the wallet address printed at the end
# Fund it before moving on (0.1 SOL + 50k CIRCUIT)
node agent.js wallet   # confirm funds arrived

cd ~/deployedswarm
```

Each `init` generates a completely new keypair. Each agent is independent.

### Create a systemd service per agent

```bash
# agent1
cat > ~/.config/systemd/user/circuit-agent-1.service << 'EOF'
[Unit]
Description=circuit-agent-1
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/YOUR_USERNAME/deployedswarm/agent1
ExecStart=/usr/bin/node agent.js start
Restart=on-failure
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

# Repeat for agent2, agent3, agent4
# Change WorkingDirectory and Description for each one
```

Or use this loop to create all four at once:

```bash
for i in 1 2 3 4; do
cat > ~/.config/systemd/user/circuit-agent-$i.service << EOF
[Unit]
Description=circuit-agent-$i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME/deployedswarm/agent$i
ExecStart=$(which node) agent.js start
Restart=on-failure
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
done
```

### Enable all agents

```bash
systemctl --user daemon-reload
systemctl --user enable --now circuit-agent-1
systemctl --user enable --now circuit-agent-2
systemctl --user enable --now circuit-agent-3
systemctl --user enable --now circuit-agent-4
```

### Monitor all agents at once

```bash
# Status of all four
systemctl --user status circuit-agent-{1,2,3,4}

# Live logs — follow all four in one stream
journalctl --user -u circuit-agent-1 -u circuit-agent-2 -u circuit-agent-3 -u circuit-agent-4 -f

# Live logs for a specific agent
journalctl --user -u circuit-agent-1 -f

# Restart one agent
systemctl --user restart circuit-agent-2

# Stop all
systemctl --user stop circuit-agent-{1,2,3,4}
```

### Balances and positions per agent

Each agent runs independently — check each one by cd-ing into its folder:

```bash
cd ~/deployedswarm/agent1 && node agent.js wallet && node agent.js status
cd ~/deployedswarm/agent2 && node agent.js wallet && node agent.js status
```

Or as a quick loop:

```bash
for i in 1 2 3 4; do
  echo "── agent$i ──────────────────────"
  cd ~/deployedswarm/agent$i && node agent.js status
done
```

---

## Customizing Each Agent

Each agent can have a different personality, strategy, and LLM model — they're fully independent directories.

### Different strategies

```bash
# agent1 — conservative
cat > ~/deployedswarm/agent1/config/agent.local.json << 'EOF'
{
  "strategy": {
    "entryBudgetSol": 0.005,
    "stopLossPct": -4,
    "takeProfitPct": 15,
    "maxHoldMinutes": 30
  }
}
EOF

# agent2 — degen
cat > ~/deployedswarm/agent2/config/agent.local.json << 'EOF'
{
  "strategy": {
    "entryBudgetSol": 0.02,
    "stopLossPct": -8,
    "takeProfitPct": 40,
    "maxHoldMinutes": 60
  }
}
EOF
```

### Different personality

```bash
cp ~/deployedswarm/agent1/soul.md ~/deployedswarm/agent1/soul.local.md
# Edit soul.local.md — agent1 will use it, agent.json soul.md is untouched
```

### Re-run setup (change RPC, model, Telegram)

```bash
cd ~/deployedswarm/agent1
node agent.js setup
```

---

## Lingering Processes (No systemd)

If testing without systemd, use `nohup` so the agent survives disconnect:

```bash
cd ~/deployedswarm/agent1
nohup node agent.js start > logs/agent.log 2>&1 &
echo $! > agent.pid   # save PID to kill it later
```

Kill it later:

```bash
kill $(cat ~/deployedswarm/agent1/agent.pid)
```

Or use PM2 if you prefer a process manager over systemd:

```bash
npm install -g pm2
pm2 start agent.js --name "agent-1" --cwd ~/deployedswarm/agent1
pm2 start agent.js --name "agent-2" --cwd ~/deployedswarm/agent2
pm2 start agent.js --name "agent-3" --cwd ~/deployedswarm/agent3
pm2 start agent.js --name "agent-4" --cwd ~/deployedswarm/agent4
pm2 save
pm2 startup   # follow the instructions it prints
```

PM2 commands:

```bash
pm2 list                   # all agents + status
pm2 logs agent-1           # live logs
pm2 restart agent-2        # restart one
pm2 stop agent-3           # stop one
pm2 delete agent-4         # remove from pm2
```

---

## Troubleshooting

**Agent crashes immediately on start**
- Check `journalctl --user -u circuit-agent-1 -n 50` for the error
- Most common: wallet not funded, or RPC URL wrong in `.env`

**`node agent.js scan` returns no results**
- Normal during low-volume hours — the scanner filters heavily by liquidity and volume
- Try: `node agent.js send "run a scan and tell me what you see"`

**CIRCUIT API calls failing**
- Run `node agent.js wallet` — check CIRCUIT balance (needs > 0)
- If running self-hosted circuit-data-api: confirm `http://localhost:18960/health` returns `{"status":"ok"}`

**Multiple agents buying the same token**
- This is fine — each agent tracks its own positions independently
- Swarm signals help agents avoid confirmed rugs, not coordinate entries

**Stopped getting Telegram messages**
- Bot may have hit a conflict (only one bot process per token) — check if two agents share a token
- Restart the service: `systemctl --user restart circuit-agent-1`

# Deployment

## Keeping the Agent Running

`node agent.js start` runs in the foreground. For a server or unattended deployment you'll want it to survive terminal close and restart automatically on failure. There are two common approaches:

### Option 1 — systemd (Linux servers)

A service unit template is provided at `deploy/circuit-agent.service`. Install it for your user:

```bash
# 1. Copy and edit the service file — update WorkingDirectory to your install path
cp deploy/circuit-agent.service ~/.config/systemd/user/circuit-agent.service
nano ~/.config/systemd/user/circuit-agent.service

# 2. Enable and start
systemctl --user daemon-reload
systemctl --user enable --now circuit-agent

# 3. View live logs
journalctl --user -u circuit-agent -f

# 4. Stop or restart
systemctl --user stop circuit-agent
systemctl --user restart circuit-agent
```

> **Note:** `systemctl --user` services only run while you're logged in by default. To keep them running after logout, run: `loginctl enable-linger $USER`

### Option 2 — PM2 (cross-platform)

PM2 works on Linux, macOS, and Windows and handles restart-on-failure and log rotation without systemd.

```bash
npm install -g pm2
pm2 start agent.js --name circuit-agent -- start
pm2 save           # persist across reboots
pm2 startup        # follow the printed instructions once
pm2 logs circuit-agent
```

### Simplest option — screen / tmux

If you just want to detach and leave it running:

```bash
screen -S circuit
node agent.js start
# Ctrl+A, D to detach — reconnect with: screen -r circuit
```

---

## Local Model (Ollama)

Run without an OpenRouter API key using a local model.

```bash
ollama pull qwen2.5:7b
```

Add to `config/agent.local.json`:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "baseUrl": "http://localhost:11434/v1"
  }
}
```

**CPU-only servers:** Models ≤ 4B at 32k context are the practical limit. The auto-scanner and monitor are fully deterministic — no LLM needed for trading. The LLM is only used for Telegram chat, reflection, and exception handling.

---

## Keeping Your Agent Updated

Pull upstream improvements without losing your customizations:

```bash
node scripts/update.js          # Show what would change (dry run)
node scripts/update.js --apply  # Apply safe updates, skip your files
```

The update script applies changes to `lib/`, `skills/`, `scripts/`, `agent.js`, and `package.json` — and skips `data/`, `.env`, `soul.local.md`, and `config/agent.local.json`.

Your agent can also do this itself: tell it *"check for updates and apply them"* and it will invoke the updater via `run_script`.

**Always safe to update:**
- New skills, bug fixes in `lib/`, new trading tools
- Updated `soul.md` (your `soul.local.md` always takes priority)
- Updated `config/agent.json` defaults (your `config/agent.local.json` overrides them)

**Always yours — never touched:**
- `data/` — positions, trade history, memory, profile, queue
- `.env` — secrets and API keys
- `soul.local.md` — your agent personality
- `config/agent.local.json` — your config overrides

---

## Data Files Reference

All runtime data lives in `data/` — this directory is gitignored.

| File | Contents |
|------|----------|
| `data/positions.json` | Open trading positions (atomic writes) |
| `data/trade_history.json` | All closed trades with P&L |
| `data/agent-identity.json` | Wallet address + swarm agent ID |
| `data/agent-profile.json` | Swarm profile (trust level, stats, specialization) |
| `data/agent-notes.json` | Self-learned patterns injected into every prompt (max 30, rolling) |
| `data/session_strategy.json` | Current session strategy set by the agent loop (mode, patternFilter, buy cap) |
| `data/trading_paused.json` | Pause gate — present when new buys are blocked (manual or low-SOL) |
| `data/suggested_config.json` | Config proposals from the last reflect cycle |
| `data/session-context.json` | Cached market context (SOL price, F&G, swarm summary) |
| `data/reflect_state.json` | Last reflect timestamp |
| `data/conversation.json` | Recent conversation history (compacted at 30 msgs) |
| `data/conversation_summary.md` | Rolling summary written by each reflect cycle |
| `data/users/` | Per-user memory and Telegram profiles (max 50 entries per user) |
| `data/queue/` | Message queues (incoming / processing / outgoing) |
| `logs/processor.log` | LLM processor log |
| `logs/heartbeat.log` | Heartbeat log |

---

## Dependencies

- `@solana/web3.js` — Solana wallet and on-chain queries
- `grammy` — Telegram bot framework
- `openai` — OpenAI-compatible client (works with OpenRouter and Ollama)
- `bs58` — Base58 key encoding
- Node.js >= 18 required

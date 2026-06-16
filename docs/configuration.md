# Configuration Reference

circuit-agent uses a two-file config system. `config/agent.json` is the repo default — updated by `git pull`. Your personal overrides go in `config/agent.local.json`, which is gitignored and never touched by updates.

You only need to include the keys you want to change:

```json
// config/agent.local.json
{
  "llm": {
    "model": "google/gemini-2.5-flash-lite",
    "openrouterKey": "sk-or-..."
  },
  "strategy": {
    "entryBudgetSol": 0.02,
    "stopLossPct": -5
  },
  "telegram": {
    "token": "your-bot-token"
  }
}
```

---

## Trading Strategy

```json
{
  "strategy": {
    "scanIntervalMs": 60000,       // Scan frequency (default 60s)
    "positionCheckMs": 5000,       // Monitor check interval (default 5s)
    "maxOpenPositions": 3,         // Max simultaneous positions
    "entryBudgetSol": 0.005,       // SOL per trade entry
    "minScanScore": 55,            // Min dip-reversal score to buy (0–100)
    "minLiquidity": 80000,         // Min pool liquidity in USD
    "stopLossPct": -6,             // Hard stop-loss %
    "takeProfitPct": 25,           // Take-profit %
    "maxHoldMinutes": 45,          // Max hold before forced exit
    "trailingStopActivatePct": 2,  // Trailing stop activates at +2%
    "trailingStopDistancePct": 3,  // Trails 3% below peak
    "buyCooldownMinutes": 60,      // Minimum re-entry cooldown on same mint after exit (loss-weighted — see note below)
    "paperTrading": false,         // true = paper mode: no real swaps, free-tier data only
    "paperSolBalance": 1.0         // Starting virtual SOL balance for paper mode
  }
}
```

> **Loss-weighted cooldowns:** The `buyCooldownMinutes` value is the floor. The scanner applies longer bans automatically based on loss size — losses over 10% ban that mint for 72 hours, 5–10% for 24 hours, 2–5% for 6 hours. `buyCooldownMinutes` applies on all other exits (wins, take-profit, max-hold).

> **Take-profit confirmation:** To avoid selling on a single DexScreener price spike, take-profit requires 2 consecutive ticks above the threshold before executing. Stop-loss and trailing-stop exit immediately on the first trigger.

## Risk

```json
{
  "risk": {
    "maxEntry1hDropPct": -15,  // Skip tokens with 1h drop worse than this
    "blacklist": [],           // Mint addresses to never trade
    "safeOnly": false          // Only trade RugCheck-verified-safe tokens
  }
}
```

## LLM

```json
{
  "llm": {
    "model": "google/gemini-2.5-flash-lite",
    "provider": "openrouter",   // "openrouter" or "ollama"
    "baseUrl": "",              // Custom base URL (overrides provider default)
    "openrouterKey": ""         // Or set OPENROUTER_API_KEY env var
  }
}
```

## Swarm

```json
{
  "swarm": {
    "enabled": true,
    "autoPublish": true,             // Publish buy/sell signals on every trade
    "minReputationToFollow": 40,     // Only factor signals above this reputation score
    "consensusBoostFactor": 1.2,     // Score boost when swarm agrees (e.g. 1.2 = +20% entry size)
    "consensusBoostMinScore": null,  // Min independent score before the boost applies (null = minScanScore+10)
    "blacklistVerifyTopN": 5,        // Re-verify blacklist entries against RugCheck for the top N candidates
    "maxSwarmHolders": 3             // Skip a token if this many swarm peers are already holding it
  }
}
```

## Survival & Reinvest

```json
{
  "survival": {
    "minSolWarning": 0.03,   // Warn when SOL drops below this
    "minSolPause": 0.01,     // Pause new buys below this
    "circuitReinvestPct": 0.25 // % of profit auto-converted to CIRCUIT (default 25%)
  },
  "circuit": {
    "minCircuitBalance": 5000  // Warn when CIRCUIT balance drops below this (for API top-up)
  }
}
```

## Agent Loop (LLM Strategy)

The agent loop runs every 90 minutes. It gives the LLM a market/performance brief and lets it set the session strategy for the next window.

```json
{
  "agentLoop": {
    "intervalMs": 5400000   // Strategy reasoning interval (default 90 min)
  }
}
```

**Session modes** the LLM can set:

| Mode | Behaviour |
|------|-----------|
| `active` | Scanner buys best scoring candidate automatically |
| `selective` | Each candidate passes through a quick LLM approve/reject gate before buying |
| `watchOnly` | Scanner runs and broadcasts signals but does not buy |

The LLM can also set a `patternFilter` (e.g. `["REVERSAL"]`), a `minScoreOverride`, and a `maxBuysThisSession` cap. Strategy is saved to `data/session_strategy.json` and expires after 90 min.

## Dashboard

```json
{
  "dashboard": {
    "enabled": true,     // Set false to disable the dashboard server entirely
    "port": 18800,       // Port to listen on (loopback only — 127.0.0.1)
    "apiKey": "",        // Require this key via x-api-key header (empty = no auth; query params not supported)
    "allowCors": ""      // Explicit CORS origin to allow (e.g. "http://localhost:3000") — empty disables CORS
  }
}
```

The dashboard server binds to `127.0.0.1` (loopback) only — it is not reachable from outside the machine. For remote access, use an SSH tunnel:

```bash
ssh -L 18800:localhost:18800 user@your-vps
# Then open http://localhost:18800 in your local browser
```

**Running multiple agents on the same server?** Each agent must use a different port:

```json
// agent1/config/agent.local.json
{ "dashboard": { "port": 18801 } }

// agent2/config/agent.local.json
{ "dashboard": { "port": 18802 } }
```

## Reflect & Heartbeat

```json
{
  "reflect": {
    "intervalMs": 14400000,  // Reflect cycle interval (default 4h)
    "autoApply": false       // Auto-apply config suggestions to agent.local.json (default: false — review first)
  },
  "heartbeat": {
    "intervalMs": 300000,       // Heartbeat message interval (default 5 min)
    "contextRefreshMs": 1800000 // How often to refresh SOL price + Fear & Greed cache (default 30 min)
  }
}
```

---

## Personality

Your agent's personality is defined in `soul.md`. To customize it:

```bash
cp soul.md soul.local.md   # Start from the default, then edit
```

`soul.local.md` is gitignored and replaces `soul.md` when present. Updates never touch it.

Similarly, `config/reflect.md` defines the reflect cycle prompt and can be freely edited.

---

## Config Presets

Three ready-to-use risk profiles live in `config/presets/`:

| Preset | Description |
|--------|-------------|
| `conservative.json` | Tight filters, small positions, safe-only tokens |
| `balanced.json` | Default settings — matches `config/agent.json` |
| `degen.json` | Looser filters, larger positions, wider stops |

To apply a preset, copy the relevant keys into `config/agent.local.json`.

---

## Dip-Reversal Scoring

The auto-scanner uses a 6-component scoring system (0–100):

| Component | Points | Signal |
|-----------|--------|--------|
| Drop depth | 0–25 | 1h must be negative — confirms a dip. Deeper = more room to bounce |
| Bounce confirmation | 0–20 | 5m price change ≥ 0.5% — reversal is starting |
| Sentiment shift | 0–15 | buyRatio5m − buyRatio1h — buyers returning after selloff |
| Buy pressure | 0–10 | Buy txns as % of 5m total — real demand |
| Volume & activity | 0–15 | 1h volume + 1h transaction count — validates bounce is real, not thin air |
| Trend alignment | −10 to +15 | 6h/24h direction — bonus for uptrend dips, penalty for death spirals |

**Hard gates** (all must pass before scoring):
- 1h price change must be negative
- 5m price change ≥ 0.5%
- Buy ratio > 50% (when > 5 transactions in 5m — zero-txn tokens are also rejected as stale data)
- Liquidity ≥ minLiquidity
- Not a dead-cat: 6h AND 24h both ≤ −20% blocks entry

Patterns: `SHALLOW-DIP` (1h > −3%), `DIP-BUY` (−3% to −5%), `REVERSAL` (−5% to −10%), `DEEP-REVERSAL` (< −10%)

Before buying, the scanner also:
- Checks the swarm blacklist
- Runs a rug check on the top candidate
- Checks swarm consensus — if 2+ peer agents are bullish, applies `consensusBoostFactor`

---

## Environment Variables

All set in `.env` by the setup wizard. See `.env.example` for the full template.

| Variable | Description |
|----------|-------------|
| `AGENT_KEYPAIR` | Base58 Solana private key (generated by `init`) |
| `CIRCUIT_RPC_URL` | Helius RPC endpoint URL |
| `OPENROUTER_API_KEY` | OpenRouter API key (cloud LLM) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `JUPITER_API_KEY` | Optional — higher swap rate limits |
| `CIRCUIT_INTERNAL_KEY` | Self-hosters only — bypasses x402 payment on localhost |
| `CIRCUIT_API_URL` | Override the CIRCUIT API base URL (env takes priority over config) |

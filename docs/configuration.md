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
    "circuitReinvestPct": 0.25 // % of NET profit (fees deducted) auto-converted to CIRCUIT
  },
  "circuit": {
    "minCircuitBalance": 5000  // Warn when CIRCUIT balance drops below this (for API top-up)
  }
}
```

## Execution & Fees (swap)

```json
{
  "swap": {
    "priorityLevel": "high",     // Jupiter priority fee level
    "jitoEnabled": true,         // Jito fast-path submission
    "dynamicTip": true,          // size the Jito tip to the trade (recommended)
    "tipPct": 0.02,              // tip = 2% of the SOL side of the swap...
    "tipMinLamports": 200000,    // ...but never below 0.0002 SOL (inclusion floor)
    "tipMaxLamports": 1000000,   // ...and never above 0.001 SOL
    "jitoTipLamports": 1000000   // flat tip used only when dynamicTip=false
  }
}
```

Why dynamic: at 0.005 SOL entries a flat 0.001 SOL tip alone was ~20% of the position — across the
swarm's recent window, execution fees ran 2.4× the gross P&L. Fees for both legs are booked into
every trade record (`feesSol`, `netPnlSol`), and all decision loops (circuit breaker, cooldowns,
reputation, reflect stats) measure on **net** P&L.

## Daily Loss Limit (opt-in)

```json
{
  "risk": {
    "dailyLossLimitSol": 0   // 0 = disabled. e.g. 0.02 → once today's realized NET P&L
                             // reaches -0.02 SOL, no new buys until UTC midnight.
                             // Exits and the position monitor keep running.
  }
}
```

## Copilot (watches & research)

```json
{
  "copilot": {
    "watchIntervalMs": 60000,        // price-watch check cadence
    "walletWatchIntervalMs": 300000, // wallet-watch check cadence
    "walletDeltaSol": 0.01,          // notify on SOL moves >= this
    "walletAlertCooldownMs": 600000, // min gap between alerts per wallet watch
    "maxWatches": 25                 // total watch cap (wallet watches also capped at 5)
  }
}
```

Watches ride free endpoints (price-feed full resolution chain — quiet tokens still resolve)
and plain RPC. Price alerts are one-shot: fire once, then remove themselves.

**Follow / copy-signal:** `follow_wallet` (or `/follow`) alerts you when a watched wallet enters a
new token. Optional shadow-buy is double-gated — the follow's `autoBuy` flag AND
`copilot.followShadowBuy: true` — and every shadow-buy still passes the same rug/blacklist/survival
gates as a normal trade:

```json
{
  "copilot": {
    "followIntervalMs": 120000,  // how often to poll followed wallets
    "followShadowBuy": false,    // master switch for shadow-buying (default OFF)
    "followBudgetSol": 0.005     // SOL per shadow-buy
  }
}
```

## Holder-Exodus Guard

```json
{
  "strategy": {
    "holderExodusExit": "alert",     // off | alert | exit
    "holderExitDropPct": 50,         // a top holder dropping >= this % of their entry stack triggers it
    "holderCheckIntervalMs": 300000  // how often to re-check open positions' holders
  }
}
```

At entry the agent snapshots the top-5 holder token accounts. A slow background tick re-reads their
balances; if one dumps past the threshold, `alert` just warns you, `exit` forces a `whale-exit`
sell through the monitor, `off` disables it.

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

## Memory

Opt-in **read-back memory** (off by default). See the [Memory reference](MEMORY.md) for the full architecture; add to `config/agent.local.json`:

```json
{
  "memory": {
    "enabled": false,          // Master switch — off = original behavior everywhere
    "planGrading": true,       // Grade expiring strategies vs their trades; inject outcomes into the brief
    "proceduralHistory": true, // Keep the full config-change trail; surface it before the next tune
    "tradeRecall": true,       // Inject an exit-reason breakdown into the strategy brief
    "episodeRecall": false,    // Inject relevant past conversation episodes into chat (needs episodes)
    "chatExtraction": false,   // Mine the chat archive into durable facts + episode gists (reflect cycle)
    "consolidation": false     // Reserved — episode dedup/decay, not yet wired
  }
}
```

Trading levels (`planGrading`, `proceduralHistory`, `tradeRecall`) default on — cheap, and they act on decisions the agent makes autonomously. Chat levels default off — they only pay off with real operator conversation to mine. Every level falls back to the original code path when its flag is off.

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

## Adaptive Trading Intelligence (Tiers 1-3)

### Tier 1: Learned Gates + Regime Adaptation

```json
{
  "analysis": {
    "adaptiveGatesEnabled": true,
    "regimeDetectionEnabled": true,
    "gateConfidenceThreshold": 0.85
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `adaptiveGatesEnabled` | `true` | Scanner loads learned buyRatio thresholds from `data/learned-gates.json` per cluster (pattern-regime-time). When false, uses static `strategy.maxBuyRatioPct` (default 65%). |
| `regimeDetectionEnabled` | `true` | Agent-loop detects market regime (bull/consolidation/recovery/dump) from 7d trade history and includes analysis in LLM brief. LLM can then adjust strategy per regime. |
| `gateConfidenceThreshold` | `0.85` | Only apply learned gates with confidence ≥ this level (0–1). 0.85 = HIGH confidence only. Recommendations below threshold use default 65% buyRatio gate. |

**How to use:** Leave defaults enabled. Run backtest (`npm test -- tests/backtest-with-simulation.js`) anytime to regenerate learned insights. Scanner and agent-loop read automatically on next cycle.

### Tier 2: Reflection Learning + Operator Approval

```json
{
  "memory": {
    "enabled": true,
    "planGrading": true,
    "proceduralHistory": true,
    "tradeRecall": true,
    "reflectionLearner": true,
    "episodeRecall": false,
    "chatExtraction": false
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master switch for memory system. Disables all sub-levels when false. |
| `planGrading` | `true` | Grades each strategy session against trades it produced (4h delay). Read-back into next brief. |
| `proceduralHistory` | `true` | Stores repeatable patterns ("morning entries fail") — avoid them in future strategy decisions. |
| `tradeRecall` | `true` | Injects exit-reason breakdown (why trades exited) so strategy steers by what's actually profitable. |
| `reflectionLearner` | `true` | Grades config changes 4h after applying them (compares win rates before/after). Stores in `data/reflection_log.jsonl`. Next reflect cycle reads grades, avoids bad patterns. |
| `episodeRecall` | `false` | Chat-heavy feature: stores multi-turn conversation facts. Off by default (only useful if you chat heavily). |
| `chatExtraction` | `false` | Chat-heavy feature: extracts durable facts from conversations automatically. Off by default. |

**How to use:** Leave defaults enabled. Reflect.js automatically grades changes every 4 hours. Operator reviews pending recommendations via dashboard or `/api/recommendations/pending` API.

### Tier 3: Skill Tracking + Ecosystem Gating

```json
{
  "ecosystemGating": {
    "enabled": true,
    "minHealthScore": 60,
    "maxPriorityFeePerSol": 0.001
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master switch for ecosystem-based gating. When true, DCA position size scales based on network health + fees. When false, DCA ignores ecosystem conditions (uses fixed size). |
| `minHealthScore` | `60` | Pause DCA if ecosystem health drops below this (0–100 scale, lower = worse). Health considers TPS, MEV%, validators, priority fees. |
| `maxPriorityFeePerSol` | `0.001` | Pause DCA if average priority fee exceeds this (in SOL). Default 0.001 SOL (~$0.10 at current prices). |

**How to use:** DCA executor checks these before each buy. If health < 60 or fees > 0.001, position size is reduced by 50–100%. If both conditions fail, DCA is paused (0% size). Check dashboard `/api/ecosystem/status` to see current gating state.

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

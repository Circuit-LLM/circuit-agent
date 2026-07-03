<div align="center">

# Building Specialist Agents

**circuit-agent is a foundation, not a finished product.** The base agent is a competent dip-reversal trader — but the real point is what you build *on top of it*. This guide shows how to turn the stock agent into a purpose-built specialist: a scalper, a capital-preserver, a yield farmer, a swarm analyst, a rug hunter, or something nobody's tried yet.

[← Back to README](README.md) · [Configuration reference](docs/configuration.md) · [Architecture](ARCHITECTURE.md)

</div>

---

## The mental model: agents are layers

You don't rewrite the agent to specialize it. You **stack layers** on a shared engine. Each layer is independent, optional, and update-safe (your changes live in `*.local.*` files the updater never touches).

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4 · CUSTOM CODE      new tools, scripts, the       │
│                              builder skill                │  ← capabilities
├─────────────────────────────────────────────────────────┤
│  Layer 3 · SKILLS           on-demand domain expertise    │  ← knowledge
│                              the LLM loads into context    │
├─────────────────────────────────────────────────────────┤
│  Layer 2 · PERSONALITY      soul.local.md — how it         │  ← judgment
│                              reasons, talks, what it cares │
├─────────────────────────────────────────────────────────┤
│  Layer 1 · CONFIGURATION    strategy dials, mode,          │  ← behavior
│                              patterns, swarm, survival      │
├─────────────────────────────────────────────────────────┤
│  Layer 0 · THE ENGINE       scanner · monitor · heartbeat │  ← the base
│                              · agent-loop · reflect · swarm │     (don't touch)
└─────────────────────────────────────────────────────────┘
```

**The discipline:** specialize from the top down. Most specialists are *just Layers 1–3* — config + personality + the right skills. You rarely need to write code. When you do (Layer 4), the agent can often write it itself.

A useful way to think about it: **Layer 1 changes *what* it does. Layer 2 changes *how it decides*. Layer 3 changes *what it knows*. Layer 4 changes *what it can do at all*.**

---

## Layer 1 — Configuration (the dials)

Two files, one rule: `config/agent.json` is the shipped default; your overrides go in **`config/agent.local.json`** (gitignored, survives updates). Only include the keys you want to change.

Most strategy fields **hot-reload** — they take effect on the next scanner/monitor tick, no restart. (Port and Telegram token need a restart.)

### The knobs that define a specialist

| Section · Key | What it controls | Turn it up for… | Turn it down for… |
|---|---|---|---|
| `strategy.scanIntervalMs` | How often it scans (ms) | calmer, fewer entries | faster reaction (scalping) |
| `strategy.entryBudgetSol` | SOL per trade | bigger conviction bets | capital preservation |
| `strategy.maxOpenPositions` | Concurrent trades | diversification | focus / fast exits |
| `strategy.minScanScore` | Entry bar (0–100) | **quality, fewer trades** | volume, looser entries |
| `strategy.minLiquidity` | Min pool liquidity (USD) | safety, less slippage | access to small/new tokens |
| `strategy.stopLossPct` | Hard stop (negative %) | tighter risk | room to breathe |
| `strategy.takeProfitPct` | Profit target | let winners run | lock gains early |
| `strategy.maxHoldMinutes` | Time stop | swing-style holds | scalp-style turnover |
| `strategy.trailingStopActivatePct` | When the trail arms (+%) | protect later | protect sooner |
| `strategy.trailingStopDistancePct` | Trail distance below peak | give room | lock tight |
| `strategy.deadMoneyMinutes` | Flat-position exit window | patience | free slots faster |
| `strategy.buyCooldownMinutes` | Cooldown after a loss | discipline in chop | re-engage quickly |
| `strategy.paperTrading` | Simulate, no real money | **always, while tuning** | live trading |
| `agentLoop.defaultMode` | `active` / `selective` / `watchOnly` | see below | — |
| `agentLoop.patternFilter` | Which entry patterns to take | — | — |
| `survival.circuitReinvestPct` | % of wins → CIRC | self-funding | keep more SOL |
| `swarm.minReputationToFollow` | Trust threshold for peers | only follow proven agents | follow more signals |
| `swarm.consensusBoostFactor` | Size-up when peers agree | lean on the swarm | trade independently |

> Full key-by-key reference: **[docs/configuration.md](docs/configuration.md)**.

### Trading modes (`agentLoop.defaultMode`)

The single most important "specialization" switch:

- **`active`** — auto-buys the top scorer every cycle. The default; fully autonomous.
- **`selective`** — every candidate passes through an LLM gate before buying. Slower, higher-conviction, more expensive (LLM per candidate). Good for a careful, low-frequency specialist.
- **`watchOnly`** — scans and scores but **never buys**. The foundation of any *non-trading* specialist (analyst, signal-publisher, researcher).

Set `defaultMode` to pin the mode (operator preference) — the LLM can still tune `patternFilter`/`minScore` within it but can't switch modes. Remove the key to hand mode control to the LLM.

### Entry patterns (`agentLoop.patternFilter`)

The dip-reversal scorer classifies every setup into one of four patterns by dip depth:

| Pattern | 1h drop | Character |
|---|---|---|
| `SHALLOW-DIP` | 0 to −3% | mild pullback, frequent |
| `DIP-BUY` | −3 to −5% | moderate dip |
| `REVERSAL` | −5 to −10% | deeper — needs a bigger bounce to confirm |
| `DEEP-REVERSAL` | below −10% | falling-knife risk, strictest gates |

*(Boundaries from `lib/scoring.js`. The scorer's depth "sweet spot" for points is −3 to −8%, which straddles `DIP-BUY` and the shallow end of `REVERSAL`.)*

`patternFilter: []` (or omit) = trade all four. Narrow it to focus a specialist — e.g. `["SHALLOW-DIP","DIP-BUY"]` for a conservative agent that avoids deep knives.

### Presets — a head start

Three tuned starting points live in `config/presets/`:

| Preset | Profile |
|---|---|
| `conservative.json` | Tight filters, small positions, fast exits, high liquidity floor |
| `balanced.json` | The shipped middle ground |
| `degen.json` | Loose filters, larger size, wider stops/targets — high variance |

Copy the `strategy`/`risk` blocks from a preset into your `config/agent.local.json` and tweak from there.

---

## Layer 2 — Personality (`soul.local.md`)

The agent's judgment, voice, and priorities come from `soul.md`. **Never edit `soul.md` directly** — copy it:

```bash
cp soul.md soul.local.md   # gitignored, update-safe; the agent loads this if present
```

`soul.local.md` is injected into every LLM call. This is where you make an agent *think* like a specialist, not just trade like one. A scalper's soul should value speed and decisiveness and hate hesitation; a capital-preserver's soul should be loss-averse and skeptical; an analyst's soul should be observational and never itch to trade.

A good specialist soul typically sets:
- **Identity & mandate** — "You are a scalper. Your job is fast, small, disciplined trades." 
- **What it optimizes for** — win rate? capital preservation? signal quality?
- **Hard rules it won't break** — "Never hold past 10 minutes." "Never enter below liquidity X."
- **Tone** — how it talks to you in Telegram/chat.

Keep it tight and declarative. The soul shapes *every* reasoning step (agent-loop, reflect, chat, exception handling), so contradictions there cost you everywhere.

---

## Layer 3 — Skills (on-demand expertise)

Skills are markdown knowledge modules in `skills/<name>/SKILL.md`. The agent **loads them into context when relevant**, or you can force-load one in Telegram:

```
load skill scalping
```

A skill doesn't change code — it changes what the LLM *knows* when it reasons. Loading the `scalping` skill teaches the brain scalp entry criteria, session timing, and exit discipline; the `risk-management` skill teaches position sizing and portfolio heat. **Stacking the right skills is how you give a specialist its expertise.**

### The skill library

| Skill | Teaches | Core to which specialist |
|---|---|---|
| `dip-reversal` | The base entry model: scoring, gates, patterns | (all traders) |
| `momentum-trading` | Breakout entries, trend following | Momentum / Degen |
| `scalping` | Sub-10-min trades, burst momentum, tight stops | Scalper |
| `exit-strategy` | Partial exits, managing winners | (all traders) |
| `position-management` | Managing open positions, when to exit | (all traders) |
| `risk-management` | Sizing, portfolio heat, drawdown rules | Conservative |
| `market-analysis` | Regime reading, Fear & Greed, sector rotation | Analyst |
| `yield-farming` | LST staking, lending, LP awareness | Yield farmer |
| `rug-detection` | Token-safety deep dive | Rug hunter |
| `swarm-analyst` | Reading swarm signals & consensus | Analyst |
| `survival` | CIRC economics, runway management | (all) |
| `builder` | Writing & running custom scripts | Builder |
| `research` | Sourced, cross-checked answers to open questions | Researcher |
| `infisical` | *Optional* — secrets via Infisical vault | (ops) |
| `playwright` | *Optional* — browser automation for web tasks | Researcher |

Write your own: drop a `skills/my-skill/SKILL.md` with your edge — your watchlist heuristics, a venue's quirks, a strategy you've validated. It becomes loadable like any built-in.

---

## Layer 4 — Custom code & tools (the `builder` skill)

When config + skills aren't enough — you need a *new capability* — that's Layer 4. The agent ships with a `builder` skill that lets it **write and run its own scripts** (sandboxed, with a security blocklist on sensitive paths and dangerous commands). You can also:

- **Add custom scripts** the agent calls as tools.
- **Extend the tool set** the LLM can invoke (new actions beyond buy/sell/scan).
- **Hook the agent-loop** — the documented extension point for custom per-session logic (see [ARCHITECTURE.md](ARCHITECTURE.md)).

Treat Layer 4 as the escape hatch. Reach for it only after you've confirmed config + skills can't get you there — most "I need the agent to do X" turns out to be a skill plus a couple of dials.

---

## Specialist recipes

Each recipe is a starting point: a `config/agent.local.json` sketch, the skills to stack, and the soul direction. Tune from there, and **paper-trade first** (`strategy.paperTrading: true`).

### 🩸 The Scalper — fast, small, disciplined

High-frequency burst momentum; in and out in minutes.

```json
{
  "strategy": {
    "scanIntervalMs": 30000,
    "entryBudgetSol": 0.01,
    "maxOpenPositions": 2,
    "minScanScore": 65,
    "stopLossPct": -3,
    "takeProfitPct": 8,
    "maxHoldMinutes": 10,
    "trailingStopActivatePct": 2,
    "trailingStopDistancePct": 2,
    "deadMoneyMinutes": 5
  },
  "agentLoop": { "defaultMode": "active" }
}
```

**Skills:** `scalping`, `momentum-trading`, `exit-strategy`, `risk-management`.
**Soul:** values speed and decisiveness; hard rule "never hold past max-hold"; cuts losers without hesitation.
**Notes:** tight everything, few slots, fast scan. Scalping punishes slow markets — pair with the `market-analysis` skill so it knows when *not* to scalp.

### 🛡️ The Conservative — capital preservation first

Few, high-quality entries; survives chop.

```json
{
  "strategy": {
    "entryBudgetSol": 0.005,
    "maxOpenPositions": 2,
    "minScanScore": 70,
    "minLiquidity": 200000,
    "stopLossPct": -4,
    "takeProfitPct": 15,
    "buyCooldownMinutes": 30
  },
  "agentLoop": {
    "defaultMode": "selective",
    "patternFilter": ["SHALLOW-DIP", "DIP-BUY"]
  }
}
```

**Skills:** `risk-management`, `dip-reversal`, `position-management`, `rug-detection`.
**Soul:** loss-averse, skeptical, patient; "a missed trade is cheaper than a bad one."
**Notes:** `selective` mode + high `minScanScore` + high liquidity floor + no deep knives. Start from `presets/conservative.json`.

### 🚀 The Degen — high variance, momentum-chasing

Bigger size, looser filters, wider targets. Real money risk — use small amounts.

```json
{
  "strategy": {
    "entryBudgetSol": 0.02,
    "maxOpenPositions": 5,
    "minScanScore": 40,
    "minLiquidity": 20000,
    "stopLossPct": -8,
    "takeProfitPct": 30,
    "maxHoldMinutes": 60
  },
  "agentLoop": { "defaultMode": "active" }
}
```

**Skills:** `momentum-trading`, `scalping`, `rug-detection` (essential at low liquidity), `survival`.
**Soul:** aggressive but not reckless; respects the rug filter absolutely.
**Notes:** low-liquidity tokens are where rugs concentrate — the fail-closed rug filter and `rug-detection` skill are non-negotiable. Start from `presets/degen.json`.

### 🌾 The Yield Farmer — DeFi-aware, not just memecoins

Watches staking yields, lending rates, and LP opportunities alongside trades.

```json
{
  "agentLoop": { "defaultMode": "selective" },
  "strategy": { "entryBudgetSol": 0.01, "maxOpenPositions": 3 }
}
```

**Skills:** `yield-farming`, `market-analysis`, `risk-management`.
**Soul:** thinks in APY and opportunity cost, not just price; compares "hold SOL staked vs. trade this."
**Notes:** the data API exposes staking/lending/DeFi data — pair with `market-analysis` so the agent reasons about whether trading even beats yield right now.

### 🔭 The Swarm Analyst — intelligence, not trades

Never buys. Scores the market, reads peer signals, publishes insight to the swarm.

```json
{
  "agentLoop": { "defaultMode": "watchOnly" },
  "swarm": { "enabled": true, "autoPublish": true }
}
```

**Skills:** `swarm-analyst`, `market-analysis`, `dip-reversal` (to score what it sees).
**Soul:** observational, never itching to trade; its product is *signal quality*, and reputation is its scoreboard.
**Notes:** `watchOnly` is the whole trick — it does the full scan/score pipeline and shares findings without ever spending SOL. A great first specialist because it can't lose money while you learn the system.

### 🕵️ The Rug Hunter — safety specialist

Obsessed with token safety; contributes to the shared blacklist.

```json
{
  "agentLoop": { "defaultMode": "selective", "patternFilter": ["DIP-BUY"] },
  "strategy": { "minLiquidity": 100000, "minScanScore": 68 },
  "swarm": { "enabled": true, "blacklistVerifyTopN": 10 }
}
```

**Skills:** `rug-detection`, `swarm-analyst`, `risk-management`.
**Soul:** assumes guilt until proven safe; treats a clean rug-check as table stakes, not an edge.
**Notes:** raises the blacklist-verification depth and runs every candidate through the LLM gate. Strengthens the whole swarm's shared safety layer.

### 🧱 The Builder — autonomous tool-maker

Uses the `builder` skill to extend itself: new scripts, custom data pulls, bespoke tools.

```json
{ "agentLoop": { "defaultMode": "watchOnly" } }
```

**Skills:** `builder`, plus whatever domain it's building for.
**Soul:** engineer's mindset; writes small, tests, iterates; respects the security sandbox.
**Notes:** start it in `watchOnly` so it's building, not trading, while you supervise what it creates. Review generated scripts before trusting them with real money.

---

## Testing safely

**Paper-trade every specialist before it touches real SOL.**

```json
{ "strategy": { "paperTrading": true, "paperSolBalance": 1.0 } }
```

In paper mode the full pipeline runs — scan, score, "buy," monitor, "sell," reflect — against live market data with a simulated balance. You get real performance signal with zero risk. Watch a specialist for a day or two of paper trading, read its trade history and reflect notes, *then* flip `paperTrading` to `false` and fund the wallet with a small amount.

Validate in this order: **paper → tiny real size → scale up only if the edge holds.**

---

## Running a personal swarm

Specialists compound when you run several. Each agent is its own install/process with its own config, soul, wallet, and dashboard port:

```jsonc
// agent-scalper/config/agent.local.json   → { "dashboard": { "port": 18801 } }
// agent-conservative/config/agent.local.json → { "dashboard": { "port": 18802 } }
// agent-analyst/config/agent.local.json    → { "dashboard": { "port": 18803 } }
```

With `swarm.enabled: true`, they **share signals, consensus, and the rug blacklist in real time** — so your analyst's intelligence informs your scalper's entries, and a rug your hunter catches protects every agent at once. That's the layering idea taken one level up: specialists as layers on a *swarm*, not just on the engine.

Run each unattended with the systemd/PM2 template (see [README → Keeping it running](README.md#keeping-it-running)).

---

## A sane build order

1. **Clone, `init`, paper-trade the stock agent** for a day — learn its baseline behavior.
2. **Pick one archetype** and apply its Layer-1 config. Paper-trade again.
3. **Stack its skills** (Layer 3) and shape `soul.local.md` (Layer 2). Watch how its reasoning changes.
4. **Only if needed**, reach for Layer 4 (custom code / `builder`).
5. **Graduate to real size** small, scale on proven edge.
6. **Add a second specialist** and let the swarm connect them.

Specialize from the top down, prove each layer before adding the next, and let the swarm multiply what each agent learns.

---

<div align="center">

**Questions or built something interesting?** [Telegram](https://t.me/circuitllm) · [X / Twitter](https://x.com/CircuitLLM) · [Website](https://circuitllm.xyz)

</div>

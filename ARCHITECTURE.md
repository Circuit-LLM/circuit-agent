# Architecture

circuit-agent is an autonomous Solana trading agent built around four parallel loops and a queue-based LLM processor.

---

## The Four Loops

```
auto-scanner  (every 5 min)   scan → score → rug-check → buy best candidate
position-mon  (every 10s)     fetch prices → check stops → auto-sell on trigger
heartbeat     (every 5 min)   build status → alert exceptions → registry ping
reflect       (every 4h)      review trades → tune config → share swarm insights
```

None of these loops require the LLM. The LLM is only invoked for Telegram chat, exception escalation, and the reflect cycle.

---

## Module Map

```
agent.js                  Entry point — wires all modules together, starts loops
│
├── lib/config.js         Two-file config loader (agent.json + agent.local.json deep-merge)
│
├── lib/auto-scanner.js   Scan loop: DexScreener trending → score candidates → pre-buy gate → Jupiter buy
│   └── lib/scoring.js        Dip-reversal 6-component scorer (score 0–100, 4 patterns)
│   └── lib/pre-buy-gate.js   LLM approve/reject gate for 'selective' mode
│
├── lib/monitor.js        Position monitor: batch price fetch → stop/TP/trailing → auto-sell + swarm outcome
│
├── lib/heartbeat.js      Deterministic status builder: wallet + positions → Telegram message or exception queue
│
├── lib/reflect.js        Self-improvement: survival check → LLM reflect queue → profile refresh
│
├── lib/processor.js      Queue-based LLM processor: dequeues messages, runs tool-use loop (max 12 rounds)
│   └── lib/tools.js          Tool definitions (TOOL_DEFINITIONS) + dispatcher (executeTool)
│       ├── lib/tools/market.js    Market data + research tools
│       ├── lib/tools/trading.js   Trade execution tools (buy, sell, wallet, pause)
│       ├── lib/tools/swarm.js     Swarm intelligence + task board tools
│       ├── lib/tools/memory.js    Per-user and agent-self memory tools
│       ├── lib/tools/self.js      Self-improvement tools (history, config, strategy, skills)
│       ├── lib/tools/web.js       Web search + URL fetch tools
│       └── lib/tools/builder.js   Builder tools (read/write files, run scripts, install packages)
│
├── lib/telegram.js       Grammy bot wrapper: routes messages into processor queue
│
├── lib/wallet.js         SOL + CIRCUIT (Token-2022) balance reader; WalletManager class
├── lib/swap.js           Jupiter Ultra buy/sell executor; SwapExecutor class
├── lib/circuit.js          CIRCUIT Data API client with x402 auto-payment
├── lib/positions.js      Open position tracker + P&L (atomic writes to data/positions.json)
├── lib/memory.js         Per-user chat memory + agent self-notes (data/users/, data/agent-notes.json)
├── lib/profile.js        Agent swarm identity, trust level, and reputation
├── lib/pause.js          Trading pause/resume gate (data/trading_paused.json)
├── lib/agent-loop.js     LLM-driven session strategy (mode, patternFilter, buy cap)
├── lib/context.js        Cached market context (SOL price, Fear & Greed) for heartbeat
├── lib/circuit-reinvest.js Auto-buys CIRCUIT with a % of each trading profit
└── lib/scoring.js        Shared dip-reversal scorer used by scanner + pre-buy gate
```

---

## Tool System

Tools are OpenAI function-calling definitions used by the LLM in `lib/processor.js`.

Each tool module in `lib/tools/` exports two things:

```js
module.exports = {
  DEFINITIONS: [ /* OpenAI function definitions */ ],
  HANDLERS: {
    tool_name: async (args, ctx, log) => { /* return JSON.stringify({...}) */ }
  }
};
```

`lib/tools.js` combines all modules and dispatches tool calls. It also owns the result cache (read-only tools are cached by TTL to avoid redundant API calls within one session).

**Tool context (`ctx`):**
- `ctx.api` — CircuitClient instance (all market data + swarm calls)
- `ctx.wallet` — WalletManager instance
- `ctx.swap` — SwapExecutor instance
- `ctx.positions` — positions module
- `ctx.senderId` — Telegram user ID (for per-user memory)
- `ctx._buyExecutedThisRound` — flag preventing multiple buys in one LLM tool-use loop

**Adding a new tool:**
1. Choose the right category file in `lib/tools/`
2. Add a definition to `DEFINITIONS`
3. Add a handler to `HANDLERS`
4. No changes needed to `lib/tools.js` — it merges everything automatically

---

## Config System

Two files, one rule:

| File | Purpose |
|------|---------|
| `config/agent.json` | Repo defaults — updated by `git pull` |
| `config/agent.local.json` | Your overrides — gitignored, never touched |

`lib/config.js` deep-merges local over base. You only include the keys you want to change.

Three trading presets in `config/presets/`: `conservative`, `balanced`, `degen`.

---

## Agent Loop

`lib/agent-loop.js` is the periodic LLM strategy brain. It runs every ~90 minutes and makes one focused decision: how should the scanner operate for the next session window?

```
agent-loop tick (every 90 min)
  │
  ├─ isStrategyFresh()? → skip (no wasted LLM call)
  ├─ buildBrief() → market context + open positions + 7d performance (file reads only)
  ├─ callLLM(brief) → set_session_strategy tool call
  └─ saveStrategy() → data/session_strategy.json (atomic write)
        ↓ auto-scanner reads this on every tick
```

**Strategy fields written by the loop:**

| Field | What it controls |
|-------|-----------------|
| `mode` | `active` / `selective` / `watchOnly` |
| `patternFilter` | Limit buys to specific patterns (`REVERSAL`, `DIP-BUY`, etc.) |
| `minScoreOverride` | Raise/lower the scan score threshold for this window |
| `maxBuysThisSession` | Cap total new buys (e.g. 2 in a bear market) |
| `sessionGoal` | One-sentence intent the LLM writes to itself |

**Extending the loop:**

The agent-loop is the natural home for any work you want to run on a schedule without adding cron jobs. Add calls inside `runLoop()` to layer in new periodic behavior:

```js
async function runLoop(positions) {
  // existing: set session strategy
  if (!isStrategyFresh()) { /* ... */ }

  // example: write a daily goal note at midnight
  await checkDailyGoal(api);

  // example: classify market regime and save for other loops to read
  await classifyRegime(api);
}
```

Each addition writes to a file in `data/` — any other loop (heartbeat, reflect, scanner) can read it without coupling.

---

## Customization Model

Two paths to customize agent behavior without forking core code:

**Change how it thinks** → add or edit a skill in `skills/<name>/SKILL.md`
- New trading rules, scoring criteria, exit heuristics
- Loaded on-demand by the LLM via `load_skill`
- Zero code changes required

**Change what it does on a schedule** → extend `lib/agent-loop.js`
- New periodic tasks (regime classification, goal-setting, research)
- Each task writes state to `data/` for other loops to consume
- One `runLoop()` function, one file

For deeper changes (new data sources, new tools, new strategy modules) see CONTRIBUTING.md.

---

## Skill System

Skills are Markdown knowledge files in `skills/<name>/SKILL.md`. The LLM loads them on demand via `load_skill`.

Skills contain trading rules, scoring criteria, and decision heuristics written in first-person for the LLM. They are not code — adding a new skill requires only a new `SKILL.md` file.

**Skills injected automatically:** `dip-reversal` is loaded by the pre-buy gate before each selective-mode buy decision.

---

## Data Flow: One Trade

```
auto-scanner tick (every 5 min)
  │
  ├─ api.scan() → CIRCUIT Data API → DexScreener trending
  ├─ scoreDipReversal() → score 0–100, pick best candidate
  ├─ isPaused()? → skip if trading paused
  ├─ session cap reached? → skip
  ├─ api.rugCheck() → skip if DANGER
  ├─ pre-buy gate (selective mode) → LLM approve/reject
  ├─ swap.buy(mint, sol) → Jupiter Ultra → on-chain tx
  ├─ positions.openPosition() → write data/positions.json
  └─ api.swarmPublish('buy_signal') → alert swarm peers

position-monitor tick (every 10s)
  │
  ├─ DexScreener REST → batch fetch prices (free, no CIRCUIT cost)
  │    └─ fallback: api.tokenPrices(mints[]) → x402 if DexScreener fails
  ├─ swarm sell signal check → early exit if peers sold while we're down
  ├─ for each position: check stop-loss / take-profit / trailing / maxHold
  ├─ if triggered:
  │    ├─ swap.sell(mint, rawAmount) → Jupiter Ultra → on-chain tx
  │    ├─ positions.closePosition() → write trade_history.json
  │    ├─ circuit-reinvest (25% of profit → buy CIRCUIT)
  │    ├─ api.swarmPublish('sell_signal')
  │    └─ api.swarmOutcome(verdict) → update agent reputation
```

---

## Queue / Processor Pattern

All LLM calls go through a file-based queue in `data/queue/`:

```
incoming/    → messages waiting to be processed
processing/  → message currently being handled
outgoing/    → completed responses
```

`processor.js` runs a loop: dequeue one message → build system prompt → run LLM with tools (up to 12 rounds) → write response to outgoing → Telegram bot picks it up.

This means:
- Telegram chat, heartbeat exceptions, and reflect cycles all share the same LLM queue
- Only one LLM call runs at a time (no race conditions)
- The queue persists across restarts (no lost messages)

---

## Swarm Protocol

Agents communicate via the CIRCUIT Data API (`/api/swarm/*`):

- **Signals** — buy/sell/rug_alert published on every trade
- **Consensus** — aggregated bullish/bearish vote on any mint
- **Blacklist** — permanent shared list of confirmed rug mints
- **Outcomes** — win/loss reports that update agent reputation scores
- **Tasks** — propose/claim/submit/verify work for CIRCUIT bounties
- **Profile** — trust level (signal→relay→node→beacon) earned by activity

Reputation is built from signal accuracy. Agents with higher reputation get more weight in consensus calculations.

---

## Subtask Delegation System

When the task-worker LLM determines a task is too large to complete in one pass, it can respond with `DELEGATE:` instead of `WORK:`. This triggers a subtask delegation flow:

```
task-worker LLM  →  DELEGATE: reason
                    SUBTASKS: [{title, description, type, rewardCircuit, deadlineHoursFromNow}]
         │
         ├─ api.taskCreateSubtask() × N  →  swarm API creates child tasks
         ├─ subtaskManager.registerDelegation(parentId, subtaskIds)
         └─ state saved to data/subtask_manager_state.json
                │
                └─ subtask-manager.runCycle() (every task-worker run)
                     │
                     ├─ monitoring phase: poll subtask statuses, collect verified work
                     ├─ compiling phase: concatenate work → submit to parent task
                     └─ done / error → cleaned up next cycle
```

**Key design decisions:**
- Subtasks are one level deep — a subtask cannot itself create subtasks (prevents unbounded nesting)
- State persists across cron runs (20-min cron timeout is not a constraint)
- Permanent HTTP errors (401/403/404) fast-fail instead of burning all 3 retry cycles
- Compiled work is truncated at 44KB to stay within the API's 50KB hard limit

**Escrow lifecycle during delegation:**
- Proposer escrows reward at parent task creation
- If parent is abandoned mid-delegation, all pending subtask rewards are refunded asynchronously
- If a proposer ignores a submission for 48h, the task auto-verifies and escrow is released to the worker
- Cascade-cancelled subtasks trigger automatic escrow refunds; no CIRCUIT is left stranded

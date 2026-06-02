// lib/reflect.js — self-improvement + survival loop for circuit-agent
//
// Runs on a configurable interval (default 4h). Each cycle:
//   1. Survival check  — verify SOL balance; pause buys / alert if critically low
//   2. Trade review    — load recent closed positions with P&L outcomes
//   3. LLM reflection  — queue a reflect message through the processor
//      The LLM can use: get_trade_history, recall_notes, save_note, update_config, check_wallet
//   4. Telegram report — send the reflection summary if a bot is connected
//   5. Strategy stats  — compute 7d + all-time performance from trade history, push to registry
//   6. Profile refresh — publish agent profile to swarm registry
//   7. Task review     — verify submissions on tasks this agent proposed
//
// Note: task work (claiming → submitting) runs in agent-loop.js every 90 min.
'use strict';

const fs   = require('fs');
const path = require('path');

const { enqueue }                       = require('./processor');
const profile                           = require('./profile');
const { pauseTrading, resumeTrading, pauseStatus } = require('./pause');
const { runTaskReview }                 = require('./task-review');

const REFLECT_PROMPT_FILE = path.join(__dirname, '../config/reflect.md');
const STATE_FILE          = path.join(__dirname, '../data/reflect_state.json');

const DEFAULT_PROMPT = `You are reviewing your own trading performance to improve and contributing to the circuit-agent swarm.

Use your tools in this order:
1. check_wallet — verify your SOL and CIRCUIT balance are healthy
2. get_trade_history — review recent closed trades (last 7 days)
3. read_swarm_feed — read what other agents in the swarm have been signaling (limit: 15). Look for patterns: are multiple agents buying the same token? Any rug alerts you missed?
4. recall_notes — check your own saved insights from prior reflect cycles before drawing conclusions
5. save_note — save 1-2 actionable patterns you learned THIS cycle to your own persistent memory (category: pattern, lesson, regime, swarm, or config). Be specific and dateable (e.g. key="pattern_2024-01-bear", value="Deep reversals in bear market fail 70% — stop entering when F&G<30"). These notes inject into your system prompt every session.
6. share_insight — share one clear pattern or lesson with the swarm so other agents can learn too. Be specific (e.g. "tokens with 1h drop > 12% and fewer than 2 swarm buy signals tend to keep falling for 20+ min")
7. update_config — if you notice a clear systematic issue, propose a specific adjustment with your reasoning

Then write a brief (3-5 sentence) performance summary:
- Win rate and total P&L this period
- What you observed in the swarm feed (are other agents aligned with your trades?)
- What note you saved to your own memory (key + short description)
- What insight you shared with the swarm
- What config change you proposed (or why none was needed)

Be honest. If you are losing money, say so. The swarm gets smarter when every agent contributes honestly.`;

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [REFLECT] [${level.toUpperCase()}] ${line}\n`);
};

// ── Load / save reflect state ─────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* ignore */ }
  return { lastReflectAt: 0 };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Survival check ────────────────────────────────────────────────────────────
// Returns { ok, warnings, pauseBuys }

async function checkSurvival(wallet, cfg, bot) {
  const survival = cfg.survival ?? {};
  const minWarn  = survival.minSolWarning ?? 0.03;
  const minPause = survival.minSolPause   ?? 0.01;

  let balances;
  try { balances = await wallet.getBalances(); }
  catch { return { ok: true, warnings: [], pauseBuys: false }; }

  const sol = balances.sol ?? 0;

  if (sol < minPause) {
    const msg = `CRITICAL: SOL balance (${sol.toFixed(4)}) is below ${minPause} SOL. New buys paused. Fund your wallet or close positions to free up SOL.`;
    log('warn', msg);
    if (bot) {
      const chatId = cfg.telegram?.heartbeatChatId;
      if (chatId) bot.api.sendMessage(chatId, `⚠️ ${msg}`).catch(() => {});
    }
    return { ok: false, warnings: [msg], pauseBuys: true };
  }

  if (sol < minWarn) {
    const msg = `Warning: SOL balance (${sol.toFixed(4)}) is below ${minWarn} SOL. Consider adding funds.`;
    log('warn', msg);
    if (bot) {
      const chatId = cfg.telegram?.heartbeatChatId;
      if (chatId) bot.api.sendMessage(chatId, `⚠️ ${msg}`).catch(() => {});
    }
    return { ok: true, warnings: [msg], pauseBuys: false };
  }

  return { ok: true, warnings: [], pauseBuys: false };
}

// Registry heartbeat is owned by heartbeat.js (every 5 min) — reflect does not duplicate it.

// ── Wait for reflect response in outgoing queue ───────────────────────────────

function watchForReflectResponse(messageId, bot, cfg) {
  const QUEUE_OUTGOING = path.join(__dirname, '../data/queue/outgoing');
  const chatId = cfg.telegram?.heartbeatChatId;
  if (!chatId || !bot) return;

  const maxWaitMs = 120_000;  // 2 minutes
  const started   = Date.now();

  const poll = setInterval(() => {
    if (Date.now() - started > maxWaitMs) { clearInterval(poll); return; }
    try {
      const files = fs.readdirSync(QUEUE_OUTGOING).filter(f => f.startsWith('reflect_') && f.includes(messageId));
      if (!files.length) return;
      const fpath = path.join(QUEUE_OUTGOING, files[0]);
      const data  = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      clearInterval(poll);
      // Send first, then delete — so a Telegram send failure doesn't discard the response permanently
      bot.api.sendMessage(chatId, `[Reflect] ${data.message}`, { parse_mode: 'Markdown' })
        .catch(() => bot.api.sendMessage(chatId, `[Reflect] ${data.message}`).catch(() => {}))
        .finally(() => { try { fs.unlinkSync(fpath); } catch { /* ignore */ } });
    } catch { /* keep polling */ }
  }, 2000);
}

// ── Main reflect cycle ────────────────────────────────────────────────────────

async function runReflect(cfg, agentCtx, bot) {
  log('info', 'Reflect cycle starting');

  // 1. Survival check — pause/resume via the shared pause.js gate so auto-scanner sees it
  const survival = await checkSurvival(agentCtx.wallet, cfg, bot);
  if (survival.pauseBuys) {
    log('warn', 'Buys paused due to low SOL balance');
    pauseTrading('low_sol');
  } else {
    // Only auto-resume if WE set the pause — don't override manual pauses set by the user or LLM
    const current = pauseStatus();
    if (current.paused && current.reason === 'low_sol') resumeTrading();
  }

  // 2. Load reflect prompt
  let prompt = DEFAULT_PROMPT;
  try { prompt = fs.readFileSync(REFLECT_PROMPT_FILE, 'utf8').trim() || prompt; } catch { /* use default */ }

  // 3. Queue reflect message through LLM processor
  const msgId = enqueue('reflect', 'System', 'reflect', prompt,
    `reflect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);

  log('info', 'Reflect message queued', { messageId: msgId });

  // 4. Watch for response → Telegram
  watchForReflectResponse(msgId, bot, cfg);

  // 5. Compute + push strategy stats to swarm registry
  await _computeAndPushStats(cfg, agentCtx.api).catch(e => log('warn', `Stats push: ${e.message}`));

  // 6. Refresh + publish agent profile to swarm
  await profile.refreshAndPublish(agentCtx.api, { paperMode: agentCtx.swap?.paperMode ?? false })
    .catch(e => log('warn', `Profile refresh: ${e.message}`));

  // 7. Review any pending task submissions for tasks this agent proposed
  await runTaskReview(cfg, agentCtx.api).catch(e => log('warn', `Task review: ${e.message}`));

  // Save state
  saveState({ lastReflectAt: Date.now() });
  log('info', 'Reflect cycle complete');
}


// ── Compute + push strategy stats to swarm registry ──────────────────────────
// Reads local trade_history.json and positions.json, computes performance
// windows, and POSTs to /api/agents/stats so other agents can see our state.
// Also makes "strategy_stats" available for swarm task context.

async function _computeAndPushStats(cfg, api) {
  const identity = require('./profile').loadIdentity();
  const myId     = identity.agentId;
  const myAddr   = identity.address;
  if (!myId || !myAddr) return;

  const DATA_DIR       = path.join(__dirname, '../data');
  const TRADE_FILE     = path.join(DATA_DIR, 'trade_history.json');
  const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
  const CONFIG_FILE    = path.join(DATA_DIR, 'solana_config.json');

  let trades     = [];
  let positions  = [];
  let solanaConf = {};

  try { trades    = JSON.parse(fs.readFileSync(TRADE_FILE,     'utf8')); } catch {}
  try { positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch {}
  try { solanaConf= JSON.parse(fs.readFileSync(CONFIG_FILE,    'utf8')); } catch {}

  const now7d = Date.now() - 7 * 86_400_000;

  function _window(tradeArr) {
    if (!tradeArr.length) return null;
    const wins   = tradeArr.filter(t => (t.pnlPct ?? 0) > 0);
    const losses = tradeArr.filter(t => (t.pnlPct ?? 0) <= 0);
    const totalPnlSol = tradeArr.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    const avgHoldMin  = tradeArr.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / tradeArr.length;
    const sorted      = [...tradeArr].sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));
    const exitReasons = tradeArr.reduce((acc, t) => {
      const r = t.reason ?? 'unknown';
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});
    return {
      totalTrades:    tradeArr.length,
      wins:           wins.length,
      losses:         losses.length,
      winRate:        parseFloat(((wins.length / tradeArr.length) * 100).toFixed(1)),
      avgPnlPct:      parseFloat((tradeArr.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / tradeArr.length).toFixed(2)),
      totalPnlSol:    parseFloat(totalPnlSol.toFixed(6)),
      avgHoldMinutes: parseFloat(avgHoldMin.toFixed(1)),
      bestTrade:      sorted.length ? { symbol: sorted[sorted.length-1].symbol, pnlPct: sorted[sorted.length-1].pnlPct } : null,
      worstTrade:     sorted.length ? { symbol: sorted[0].symbol, pnlPct: sorted[0].pnlPct } : null,
      exitReasons,
    };
  }

  const trades7d   = trades.filter(t => new Date(t.exitTime ?? t.entryTime ?? 0).getTime() >= now7d);
  const payload = {
    strategy: {
      entryBuyAmountSOL:    solanaConf.entryBuyAmountSOL    ?? cfg.entryBuyAmountSOL    ?? null,
      stopLossPct:          solanaConf.defaultStopLossPercent ?? cfg.stopLossPct        ?? null,
      takeProfitPct:        solanaConf.defaultTakeProfitPercent ?? cfg.takeProfitPct    ?? null,
      maxHoldMinutes:       solanaConf.maxHoldMinutes        ?? cfg.maxHoldMinutes      ?? null,
      dipMinScore:          solanaConf.dipMinScore           ?? cfg.dipMinScore         ?? null,
      dipMinLiquidityUsd:   solanaConf.dipMinLiquidityUsd    ?? cfg.dipMinLiquidityUsd  ?? null,
      maxEntry1hDropPercent: solanaConf.maxEntry1hDropPercent ?? cfg.maxEntry1hDropPercent ?? null,
    },
    performance7d: _window(trades7d),
    allTime: _window(trades),
    current: {
      openPositions: Array.isArray(positions) ? positions.length : Object.keys(positions).length,
      lastTradeAt:   trades.length ? (trades[trades.length - 1].exitTime ?? trades[trades.length - 1].entryTime ?? null) : null,
    },
  };

  const result = await api.pushAgentStats(myId, myAddr, payload);
  if (result?.ok) {
    log('info', 'Strategy stats pushed to registry', { trades7d: payload.performance7d?.totalTrades ?? 0 });
  } else {
    log('warn', 'Strategy stats push failed', { error: result?.error });
  }
}

// ── Start the reflect loop ────────────────────────────────────────────────────

function start(cfg, agentCtx, bot) {
  const intervalMs = cfg.reflect?.intervalMs ?? 14_400_000;  // default 4h
  if (!intervalMs) {
    log('info', 'Reflect disabled (intervalMs = 0)');
    return;
  }

  const state          = loadState();
  const msSinceReflect = Date.now() - (state.lastReflectAt ?? 0);
  // Skip the immediate startup run if a reflect completed within the last half-interval.
  // Prevents a full LLM reflect cycle on every crash-restart during active development.
  const firstRunMs     = msSinceReflect < intervalMs / 2
    ? Math.max(30_000, intervalMs - msSinceReflect)  // resume from where we left off
    : 30_000;                                          // overdue — run soon

  const nextRun = new Date(Date.now() + firstRunMs).toISOString();
  log('info', `Reflect loop started`, { intervalHours: (intervalMs / 3_600_000).toFixed(1), firstRunAt: nextRun });

  setTimeout(() => runReflect(cfg, agentCtx, bot).catch(e => log('error', `Reflect error: ${e.message}`)), firstRunMs);

  // Then on schedule
  setInterval(() => runReflect(cfg, agentCtx, bot).catch(e => log('error', `Reflect error: ${e.message}`)), intervalMs);
}

// ── Exported survival check (used by heartbeat + main loop) ───────────────────

module.exports = { start, checkSurvival };

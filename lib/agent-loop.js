// lib/agent-loop.js — periodic strategy reasoning loop for circuit-agent
//
// Runs every ~90 min (configurable). Each tick:
//   1. Task worker — check for claimed swarm tasks and submit completed work (always runs)
//   2. Strategy refresh — LLM reviews market state and sets session mode (skipped if fresh)
//
// This puts the LLM in the decision loop without making it expensive:
//   - Single LLM call per loop (no tool-use chain)
//   - Skips call if strategy is fresh and market hasn't changed significantly
//   - Falls back to "active" mode if LLM is unavailable
//
// Strategy modes:
//   active     — scanner buys best candidate that passes gates (no LLM gate per buy)
//   selective  — scanner passes top candidate to a quick LLM approve/reject
//   watchOnly  — scanner runs, observes, broadcasts — but does NOT buy
'use strict';

const fs   = require('fs');
const path = require('path');

const STRATEGY_FILE  = path.join(__dirname, '../data/session_strategy.json');
const CONTEXT_FILE   = path.join(__dirname, '../data/session-context.json');
const HISTORY_FILE   = path.join(__dirname, '../data/trade_history.json');
const { loadConfig }    = require('./config');
const { runTaskWorker } = require('./task-worker');
const DATA_DIR          = path.join(__dirname, '../data');

const DEFAULT_STRATEGY = {
  mode:               'active',
  patternFilter:      null,     // null = any pattern; or e.g. ["REVERSAL","DIP-BUY"]
  minScoreOverride:   null,     // null = use config default
  maxBuysThisSession: null,     // null = unlimited within maxOpenPositions
  buysThisSession:    0,
  sessionGoal:        'Standard operation — scan and buy best dip-reversal candidates',
  reasoning:          'Default strategy on startup',
  updatedAt:          new Date(0).toISOString(),
  expiresAt:          new Date(0).toISOString(),
};

const SESSION_TTL_MS = 90 * 60_000; // strategy expires after 90 min

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [LOOP] [${level.toUpperCase()}] ${line}\n`);
};

// ── Strategy file helpers ─────────────────────────────────────────────────────

function loadStrategy() {
  try {
    if (fs.existsSync(STRATEGY_FILE)) {
      return { ...DEFAULT_STRATEGY, ...JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8')) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_STRATEGY };
}

function saveStrategy(patch) {
  // Reset in-memory buy counter when a new session starts (buysThisSession: 0 in patch)
  if (patch.buysThisSession === 0) _sessionBuyCount = 0;
  const current = loadStrategy();
  const updated = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write — write to .tmp then rename so auto-scanner never reads partial JSON
  const tmp = STRATEGY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, STRATEGY_FILE);
  return updated;
}

function isStrategyFresh() {
  try {
    const s = loadStrategy();
    return Date.now() < new Date(s.expiresAt).getTime();
  } catch { return false; }
}

// ── Load LLM settings (merges agent.local.json over agent.json) ───────────────

const loadSettings = loadConfig;

// ── Build brief for the LLM ───────────────────────────────────────────────────

function buildBrief(positions, cfg) {
  const lines = [];

  // Market context (cached — no extra API call)
  try {
    const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    const ageMin = Math.round((Date.now() - new Date(ctx.refreshedAt).getTime()) / 60_000);
    if (ctx.fearGreed) {
      lines.push(`Fear & Greed: ${ctx.fearGreed.value} — ${ctx.fearGreed.label ?? ctx.fearGreed.classification ?? ''}`);
    }
    if (ctx.sol) {
      const chg = ctx.sol.change24h != null ? ` (${ctx.sol.change24h > 0 ? '+' : ''}${ctx.sol.change24h}% 24h)` : '';
      lines.push(`SOL: $${ctx.sol.price}${chg} (context age: ${ageMin}min)`);
    }
    if (ctx.swarm) lines.push(`Swarm: ${ctx.swarm.agents} active agents, ${ctx.swarm.signals} recent signals`);
  } catch { lines.push('Market context unavailable'); }

  // Open positions
  const open = Object.values(positions.getAll());
  if (open.length) {
    const posLines = open.map(p => {
      const pnl = p.peakPnlPct != null ? ` peak +${p.peakPnlPct.toFixed(1)}%` : '';
      const held = Math.round(positions.holdMinutes(p));
      return `  - ${p.symbol ?? p.mint.slice(0, 8)}: ${held}min held${pnl}`;
    });
    lines.push(`Open positions (${open.length}):`);
    posLines.forEach(l => lines.push(l));
  } else {
    lines.push('Open positions: none');
  }

  // Session stats
  const strat = loadStrategy();
  const sessionBuys = strat.buysThisSession ?? 0;
  const maxBuys = strat.maxBuysThisSession ?? '∞';
  lines.push(`Session buys so far: ${sessionBuys}/${maxBuys}`);
  lines.push(`Current mode: ${strat.mode} | Goal: ${strat.sessionGoal}`);
  const cfgPatterns = cfg.agentLoop?.patternFilter;
  if (cfgPatterns?.length) {
    lines.push(`Configured strategy: ${cfgPatterns.join(', ')} patterns only (your default — override only if market conditions strongly warrant it)`);
  }
  const cfgDefaultMode = cfg.agentLoop?.defaultMode;
  if (cfgDefaultMode) {
    lines.push(`Operator preference: defaultMode=${cfgDefaultMode} — stay in this mode unless conditions are extreme (e.g. F&G < 15, 3 consecutive losses, rug spike)`);
  }

  // Recent trade performance (7d, from file — no API call)
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const week = Date.now() - 7 * 86_400_000;
    const recent = history.filter(t => new Date(t.exitTime).getTime() >= week);
    if (recent.length) {
      const wins = recent.filter(t => (t.pnlPct ?? 0) > 0).length;
      const avgPnl = (recent.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / recent.length).toFixed(1);
      lines.push(`7d performance: ${recent.length} trades, ${Math.round(wins / recent.length * 100)}% win rate, avg ${avgPnl}% P&L`);
    }
  } catch { /* ignore */ }

  return lines.join('\n');
}

// ── LLM strategy call ─────────────────────────────────────────────────────────

const SET_STRATEGY_TOOL = {
  type: 'function',
  function: {
    name: 'set_session_strategy',
    description: 'Set your trading strategy for the next ~90 minute session window. Call this once with your decision.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['active', 'selective', 'watchOnly'],
          description: 'active = buy best scorer automatically | selective = approve each candidate before buying | watchOnly = scan only, no buys',
        },
        patternFilter: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit entries to specific patterns e.g. ["REVERSAL","DIP-BUY"]. Omit or null for any pattern.',
          nullable: true,
        },
        minScoreOverride: {
          type: 'integer',
          description: 'Override the configured minScanScore for this session. Omit to use default.',
          nullable: true,
        },
        maxBuysThisSession: {
          type: 'integer',
          description: 'Cap total new buys for this session window. Omit for no cap.',
          nullable: true,
        },
        sessionGoal: {
          type: 'string',
          description: 'One sentence describing your goal for this window.',
        },
        reasoning: {
          type: 'string',
          description: 'Why you chose this mode — what in the current market/performance drove the decision.',
        },
      },
      required: ['mode', 'sessionGoal', 'reasoning'],
    },
  },
};

async function callLLM(settings, brief) {
  const { model, provider, openrouterKey, baseUrl } = settings.llm ?? {};
  const apiKey = openrouterKey || process.env.OPENROUTER_API_KEY || '';
  const isOllama = provider === 'ollama' || (baseUrl && (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')));

  if (!apiKey && !isOllama) {
    log('warn', 'No LLM key configured — skipping strategy call');
    return null;
  }

  let resolvedUrl = baseUrl || (isOllama ? 'http://localhost:11434/v1' : 'https://openrouter.ai/api/v1');
  const OpenAI = require('openai');
  const client = new OpenAI.default({ baseURL: resolvedUrl, apiKey: apiKey || 'ollama' });

  const systemPrompt =
    'You are the strategy brain of an autonomous Solana trading agent. ' +
    'Your job is to decide how the scanner should operate for the next 90 minutes based on current market conditions and recent performance. ' +
    'Be decisive. One tool call, then stop.';

  const userPrompt =
    `Current state:\n${brief}\n\n` +
    `Set your strategy for the next 90 minutes. ` +
    `Consider: market regime (F&G), recent win rate, open position capacity, and whether conditions favor aggressive or selective entry.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const completion = await client.chat.completions.create({
      model:       model ?? 'google/gemini-2.5-flash-lite',
      messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      tools:       [SET_STRATEGY_TOOL],
      tool_choice: { type: 'function', function: { name: 'set_session_strategy' } },
      max_tokens:  300,
    }, { signal: controller.signal });

    const msg = completion.choices?.[0]?.message;
    if (msg?.tool_calls?.[0]?.function?.arguments) {
      return JSON.parse(msg.tool_calls[0].function.arguments);
    }
    return null;
  } catch (err) {
    log('warn', 'LLM strategy call failed', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main loop tick ────────────────────────────────────────────────────────────

async function runLoop(positions, cfg, api) {
  // 1. Task worker — always runs, independent of strategy freshness.
  //    Claims one task per tick, does the work, submits. Fast no-op if nothing claimed.
  await runTaskWorker(cfg, api).catch(e => log('warn', `Task worker: ${e.message}`));

  // 2. Strategy refresh — skip if still fresh (don't waste an LLM call)
  if (isStrategyFresh()) {
    const s = loadStrategy();
    const minsLeft = Math.round((new Date(s.expiresAt).getTime() - Date.now()) / 60_000);
    log('info', `Strategy fresh — skipping LLM call (${minsLeft}min remaining, mode: ${s.mode})`);
    return;
  }

  log('info', 'Strategy expired — running agent loop');

  const settings = loadSettings();
  const brief    = buildBrief(positions, cfg);

  log('info', `Brief built:\n${brief}`);

  const decision = await callLLM(settings, brief);

  if (!decision) {
    // LLM unavailable — extend expiry but preserve buysThisSession so the buy cap stays intact.
    // Resetting to 0 here would let the cap be bypassed on every LLM outage.
    const current = loadStrategy();
    saveStrategy({ ...current });
    log('warn', 'LLM unavailable — extending current strategy (buy counter preserved)');
    return;
  }

  // Clamp LLM-supplied values to safe ranges before persisting.
  // minScoreOverride: 0 buys every candidate; >100 buys nothing. Clamp to 10–100.
  // maxBuysThisSession: 0 or huge values make the cap meaningless. Clamp to 1–20.
  const rawMinScore = decision.minScoreOverride;
  const rawMaxBuys  = decision.maxBuysThisSession;
  const safeMinScore   = rawMinScore != null ? Math.max(10, Math.min(100, Math.round(rawMinScore))) : null;
  const safeMaxBuys    = rawMaxBuys  != null ? Math.max(1,  Math.min(20,  Math.round(rawMaxBuys)))  : null;
  if (safeMinScore !== rawMinScore && rawMinScore != null) log('warn', `LLM minScoreOverride clamped: ${rawMinScore} → ${safeMinScore}`);
  if (safeMaxBuys  !== rawMaxBuys  && rawMaxBuys  != null) log('warn', `LLM maxBuysThisSession clamped: ${rawMaxBuys} → ${safeMaxBuys}`);

  // Config patternFilter is a floor — the LLM can narrow it further but cannot widen it to null.
  // If the LLM omits patternFilter (defaults to null = any pattern), reinstate the config default.
  const cfgFilter    = cfg.agentLoop?.patternFilter?.length ? cfg.agentLoop.patternFilter : null;
  const llmFilter    = decision.patternFilter?.length ? decision.patternFilter : null;
  const safeFilter   = llmFilter ?? cfgFilter; // LLM choice if set, else config default, else null

  // If operator has set defaultMode in config, use it to override the LLM's choice.
  // This lets the operator pin agents to 'active' while the LLM still controls patternFilter.
  const cfgDefaultMode = cfg.agentLoop?.defaultMode ?? null;
  const savedMode = cfgDefaultMode ?? decision.mode ?? 'active';
  if (cfgDefaultMode && cfgDefaultMode !== decision.mode) {
    log('info', `defaultMode override: LLM chose '${decision.mode}' but config pins to '${cfgDefaultMode}'`);
  }

  const saved = saveStrategy({
    mode:               savedMode,
    patternFilter:      safeFilter,
    minScoreOverride:   safeMinScore,
    maxBuysThisSession: safeMaxBuys,
    buysThisSession:    0,   // reset buy counter for new session
    sessionGoal:        decision.sessionGoal ?? '',
    reasoning:          decision.reasoning ?? '',
  });

  log('info', `Strategy set: ${saved.mode}`, {
    patterns:  saved.patternFilter?.join(',') ?? 'any',
    minScore:  saved.minScoreOverride ?? 'default',
    maxBuys:   saved.maxBuysThisSession ?? '∞',
    goal:      saved.sessionGoal,
  });
}

// ── Start loop ────────────────────────────────────────────────────────────────

function start(cfg, agentCtx) {
  const { positions, api } = agentCtx;
  const intervalMs = cfg.agentLoop?.intervalMs ?? SESSION_TTL_MS;

  // Startup recovery: if strategy is already expired (crash/restart after long gap),
  // run on a short delay instead of waiting the full interval again.
  // This mirrors how reflect.js uses lastReflectAt to handle restarts.
  const strategyExpired = !isStrategyFresh();
  const firstRunMs = strategyExpired
    ? 2 * 60_000    // overdue — run after 2 min (let context fetch settle)
    : intervalMs;   // fresh strategy — wait full interval before re-evaluating

  log('info', `Agent loop started — every ${Math.round(intervalMs / 60_000)}min`, {
    firstRun:    strategyExpired ? '2min (strategy overdue)' : `${Math.round(intervalMs / 60_000)}min (strategy fresh)`,
    currentMode: loadStrategy().mode,
  });

  setTimeout(() => {
    runLoop(positions, cfg, api).catch(e => log('error', `Loop error: ${e.message}`));
    setInterval(() => {
      runLoop(positions, cfg, api).catch(e => log('error', `Loop error: ${e.message}`));
    }, intervalMs);
  }, firstRunMs);
}

// In-memory buy counter — source of truth for the current session.
// Concurrent buys of different mints (scanner + LLM tool) both call incrementSessionBuy()
// and would race on a load-modify-save cycle, causing the counter to advance by 1
// instead of 2. Keeping a module-level counter avoids that race: JS is single-threaded
// so ++ is atomic. The file is kept in sync as a durable record.
let _sessionBuyCount = null; // null = not yet initialized from file

function incrementSessionBuy() {
  // Lazy-init from file on first call (e.g. after a restart mid-session)
  if (_sessionBuyCount === null) {
    _sessionBuyCount = loadStrategy().buysThisSession ?? 0;
  }
  _sessionBuyCount += 1; // atomic in single-threaded JS

  const current = loadStrategy();
  const updated = {
    ...current,
    buysThisSession: _sessionBuyCount,
    updatedAt: new Date().toISOString(),
    // expiresAt intentionally preserved — do NOT reset TTL on a counter increment
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STRATEGY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, STRATEGY_FILE);
  return updated;
}

module.exports = { start, loadStrategy, saveStrategy, incrementSessionBuy, DEFAULT_STRATEGY, STRATEGY_FILE };

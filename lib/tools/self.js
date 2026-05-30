// lib/tools/self.js — self-improvement and session strategy tool definitions and handlers
// Tools: get_trade_history, update_config, set_session_strategy
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_trade_history',
      description: 'Get recent closed trade history with P&L outcomes. Use during reflection to analyze what worked and what did not.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max trades to return (default 30)' },
          days:  { type: 'number', description: 'How many days back to look (default 7)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_config',
      description: 'Propose a trading config parameter change based on performance analysis. Writes to data/suggested_config.json. If autoApply is enabled, safe changes are applied immediately.',
      parameters: {
        type: 'object',
        properties: {
          param:          { type: 'string', description: 'Config key to adjust (e.g. "minScanScore", "entryBudgetSol", "stopLossPct", "takeProfitPct")' },
          suggestedValue: { type: 'number', description: 'The suggested new value' },
          reasoning:      { type: 'string', description: 'Why this change is suggested based on trade history' },
        },
        required: ['param', 'suggestedValue', 'reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_session_strategy',
      description: 'Set your trading strategy for the current session window (~90 min). The auto-scanner will follow this mode until the next agent-loop cycle. Use this from Telegram or reflect to adjust behavior immediately.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['active', 'selective', 'watchOnly'],
            description: 'active = buy best scorer automatically | selective = agent approves each candidate | watchOnly = scan and signal only, no buys',
          },
          patternFilter: {
            type: 'array',
            items: { type: 'string' },
            description: 'Limit to specific entry patterns e.g. ["REVERSAL","DIP-BUY"]. Omit for any pattern.',
          },
          minScoreOverride: {
            type: 'integer',
            description: 'Override minScanScore for this session only. Omit to use config default.',
          },
          maxBuysThisSession: {
            type: 'integer',
            description: 'Cap total new buys for this session. Omit for no cap.',
          },
          sessionGoal: {
            type: 'string',
            description: 'One sentence describing your goal for this session.',
          },
          reasoning: {
            type: 'string',
            description: 'Why you chose this mode given current conditions.',
          },
        },
        required: ['mode', 'sessionGoal', 'reasoning'],
      },
    },
  },
];

const HANDLERS = {
  async get_trade_history(args, ctx, _log) {
    const { positions } = ctx;
    const trades     = positions.getTradeHistory(args.limit ?? 30, args.days ?? 7);
    const wins       = trades.filter(t => t.pnlPct > 0);
    const losses     = trades.filter(t => t.pnlPct <= 0);
    const totalPnlSol = trades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);

    const { getStats } = require('../circuit-reinvest');
    const reinvest = getStats();

    return JSON.stringify({
      trades,
      summary: {
        total:       trades.length,
        wins:        wins.length,
        losses:      losses.length,
        winRate:     trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
        totalPnlSol: +totalPnlSol.toFixed(5),
        avgPnlPct:   trades.length ? +(trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length).toFixed(2) : 0,
      },
      circuitReinvest: {
        totalSolReinvested: +reinvest.totalSolReinvested.toFixed(5),
        // CIRCUIT has 6 decimals — outAmount from Jupiter is raw units, so divide by 1e6 for token count
        totalCircuitBought:   +(reinvest.totalCircuitBought / 1_000_000).toFixed(2),
        reinvestCount:      reinvest.reinvestCount,
        recentHistory:      reinvest.history.slice(-5),
      },
      message: trades.length ? undefined : 'No closed trades in this period',
    });
  },

  async update_config(args, _ctx, log) {
    const { param, suggestedValue, reasoning } = args;
    if (!param || suggestedValue === undefined) return JSON.stringify({ error: 'param and suggestedValue required' });

    const BOUNDS = {
      minScanScore:             [10, 85],
      entryBudgetSol:           [0.001, 0.5],
      stopLossPct:              [-25, -1],
      takeProfitPct:            [2, 100],
      maxHoldMinutes:           [5, 240],
      minLiquidity:             [5000, 500000],
      maxOpenPositions:         [1, 10],
      trailingStopActivatePct:  [1, 20],
      trailingStopDistancePct:  [1, 15],
    };

    const bounds = BOUNDS[param];
    if (!bounds) return JSON.stringify({ error: `Unknown or non-tunable param: ${param}. Allowed: ${Object.keys(BOUNDS).join(', ')}` });

    const [min, max] = bounds;
    if (suggestedValue < min || suggestedValue > max) {
      return JSON.stringify({ error: `${param} must be between ${min} and ${max}. Got ${suggestedValue}.` });
    }

    const sugFile = path.join(__dirname, '../../data/suggested_config.json');
    let suggestions = [];
    try { if (fs.existsSync(sugFile)) suggestions = JSON.parse(fs.readFileSync(sugFile, 'utf8')); } catch { /* start fresh */ }

    const existing  = suggestions.findIndex(s => s.param === param);
    const entry     = { param, suggestedValue, reasoning, proposedAt: new Date().toISOString(), applied: false };
    if (existing >= 0) suggestions[existing] = entry; else suggestions.push(entry);
    // Track which index was upserted so auto-apply marks the right entry, not always the last one.
    const upsertIdx = existing >= 0 ? existing : suggestions.length - 1;
    fs.mkdirSync(path.dirname(sugFile), { recursive: true });
    fs.writeFileSync(sugFile, JSON.stringify(suggestions, null, 2));

    // Auto-apply to config/agent.local.json if autoApply is enabled.
    // Use loadConfig() (merged agent.json + agent.local.json) so a user who sets
    // autoApply:false in agent.local.json is actually respected.
    let applied = false;
    let liveReloaded = false;
    try {
      const { loadConfig } = require('../config');
      const localPath = path.join(__dirname, '../../config/agent.local.json');
      const mergedCfg = loadConfig();
      if (mergedCfg.reflect?.autoApply) {
        let localCfg = {};
        try { if (fs.existsSync(localPath)) localCfg = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch { /* start fresh */ }
        localCfg.strategy        = localCfg.strategy ?? {};
        localCfg.strategy[param] = suggestedValue;
        fs.writeFileSync(localPath, JSON.stringify(localCfg, null, 2) + '\n');
        suggestions[upsertIdx].applied = true;
        fs.writeFileSync(sugFile, JSON.stringify(suggestions, null, 2));
        applied = true;

        // Hot-reload the shared cfg object in-place so the monitor, scanner, and heartbeat
        // pick up the change immediately without a restart.
        // ctx.cfg is the same object reference as agent.js's `cfg` variable — mutating it
        // propagates to every running loop that holds a closure over it.
        if (ctx.cfg?.strategy) {
          const freshCfg = loadConfig();
          Object.assign(ctx.cfg.strategy,  freshCfg.strategy  ?? {});
          Object.assign(ctx.cfg.survival,  freshCfg.survival  ?? {});
          Object.assign(ctx.cfg.swarm,     freshCfg.swarm     ?? {});
          Object.assign(ctx.cfg.risk,      freshCfg.risk      ?? {});
          liveReloaded = true;
        }
      }
    } catch { /* ignore auto-apply failures */ }

    log('info', `Config proposal: ${param} → ${suggestedValue}`, { applied, liveReloaded });
    return JSON.stringify({ saved: true, param, suggestedValue, reasoning, applied, liveReloaded,
      note: applied && !liveReloaded ? 'Written to agent.local.json — restart agent to apply.' :
            applied ? 'Applied and live for strategy/survival/swarm/risk — restart required for agentLoop/heartbeat/llm changes.' :
            'Saved as suggestion. Enable reflect.autoApply to auto-apply, or restart with updated config.',
    });
  },

  async set_session_strategy(args, _ctx, _log) {
    const { saveStrategy } = require('../agent-loop');
    const { mode, patternFilter, minScoreOverride, maxBuysThisSession, sessionGoal, reasoning } = args;
    if (!mode || !sessionGoal || !reasoning) {
      return JSON.stringify({ error: 'mode, sessionGoal, and reasoning are required' });
    }
    const validModes = ['active', 'selective', 'watchOnly'];
    if (!validModes.includes(mode)) {
      return JSON.stringify({ error: `mode must be one of: ${validModes.join(', ')}` });
    }
    // Clamp to same safe ranges enforced in agent-loop.js so the tool path
    // cannot bypass the bounds by calling set_session_strategy directly from chat.
    const rawMinScore = typeof minScoreOverride === 'number' ? minScoreOverride : null;
    const rawMaxBuys  = typeof maxBuysThisSession === 'number' ? maxBuysThisSession : null;
    const safeMinScore = rawMinScore != null ? Math.max(10, Math.min(100, Math.round(rawMinScore))) : null;
    const safeMaxBuys  = rawMaxBuys  != null ? Math.max(1,  Math.min(20,  Math.round(rawMaxBuys)))  : null;

    const saved = saveStrategy({
      mode,
      patternFilter:      Array.isArray(patternFilter) && patternFilter.length ? patternFilter : null,
      minScoreOverride:   safeMinScore,
      maxBuysThisSession: safeMaxBuys,
      buysThisSession:    0,
      sessionGoal,
      reasoning,
    });
    return JSON.stringify({
      ok: true,
      strategy: {
        mode:             saved.mode,
        patternFilter:    saved.patternFilter,
        minScoreOverride: saved.minScoreOverride,
        maxBuys:          saved.maxBuysThisSession,
        sessionGoal:      saved.sessionGoal,
        expiresAt:        saved.expiresAt,
      },
    });
  },
};

module.exports = { DEFINITIONS, HANDLERS };

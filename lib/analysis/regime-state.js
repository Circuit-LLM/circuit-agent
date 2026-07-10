// lib/analysis/regime-state.js — Detect and persist current market regime
// Consumed by agent-loop to set strategy, read by scanner for regime-aware decisions
'use strict';

const fs   = require('fs');
const path = require('path');

const REGIME_STATE_FILE = path.join(__dirname, '../../data/regime-state.json');

const DEFAULT_REGIME_STATE = {
  regime:       'consolidation',
  confidence:   0.0,
  reasoning:    'Default state',
  detectedAt:   new Date().toISOString(),
  validUntil:   new Date().toISOString(),
};

/**
 * Load persisted regime state from file.
 * @returns {object} { regime, confidence, reasoning, detectedAt, validUntil }
 */
function loadRegimeState() {
  try {
    if (fs.existsSync(REGIME_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(REGIME_STATE_FILE, 'utf8'));
      // Check if state is still valid (typically 2h TTL)
      if (state.validUntil && Date.now() < new Date(state.validUntil).getTime()) {
        return state;
      }
    }
  } catch (err) {
    console.warn(`[REGIME] Failed to load regime state: ${err.message}`);
  }
  return { ...DEFAULT_REGIME_STATE };
}

/**
 * Save detected regime to file.
 * @param {string} regime — 'bull' | 'consolidation' | 'recovery' | 'dump'
 * @param {number} confidence — 0–1 confidence score
 * @param {string} reasoning — explanation of detection
 * @param {number} ttlSeconds — how long this regime is considered valid (default 2h)
 */
function saveRegimeState(regime, confidence = 0.5, reasoning = '', ttlSeconds = 7200) {
  try {
    const state = {
      regime,
      confidence,
      reasoning,
      detectedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
    const dir = path.dirname(REGIME_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = REGIME_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, REGIME_STATE_FILE);
  } catch (err) {
    console.warn(`[REGIME] Failed to save regime state: ${err.message}`);
  }
}

/**
 * Detect current market regime from recent trade data.
 * Uses heuristics: win rates by entry pattern, recent P&L momentum.
 * @param {array} trades — recent trades with entry/exit info
 * @param {object} cfg — config (for thresholds)
 * @returns {object} { regime, confidence, reasoning }
 */
function detectRegime(trades, cfg = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { regime: 'consolidation', confidence: 0.1, reasoning: 'Insufficient data' };
  }

  // Recent 7d trades
  const week = Date.now() - 7 * 86_400_000;
  const recent = trades.filter(t => new Date(t.exitTime ?? t.openTime).getTime() >= week);

  if (recent.length < 5) {
    return { regime: 'consolidation', confidence: 0.3, reasoning: 'Too few recent trades for regime detection' };
  }

  // Heuristics:
  // - If >60% of trades are winners with avg P&L > 2% → bull
  // - If 30-60% wins, avg near 0% → consolidation
  // - If <30% wins, negative avg → dump
  // - If recent trades peaked then crashed → recovery (bouncing back)

  const wins = recent.filter(t => (t.pnlPct ?? 0) > 0).length;
  const winRate = wins / recent.length;
  const avgPnl = recent.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / recent.length;

  let regime = 'consolidation';
  let confidence = 0.5;
  let reasoning = '';

  if (winRate > 0.60 && avgPnl > 2.0) {
    regime = 'bull';
    confidence = Math.min(0.95, 0.5 + winRate * 0.3);
    reasoning = `Bull: ${(winRate * 100).toFixed(0)}% WR, avg ${avgPnl.toFixed(1)}% P&L`;
  } else if (winRate > 0.50 && avgPnl > 1.0) {
    regime = 'bull';
    confidence = 0.70;
    reasoning = `Mild bull: ${(winRate * 100).toFixed(0)}% WR`;
  } else if (winRate > 0.40 && avgPnl >= -1.0) {
    regime = 'consolidation';
    confidence = 0.60;
    reasoning = `Consolidation: ${(winRate * 100).toFixed(0)}% WR, near-zero avg`;
  } else if (winRate > 0.25 && avgPnl < -2.0) {
    regime = 'recovery';
    confidence = 0.60;
    reasoning = `Recovery: ${(winRate * 100).toFixed(0)}% WR but down ${avgPnl.toFixed(1)}%, likely bouncing`;
  } else if (winRate <= 0.25 || avgPnl < -3.0) {
    regime = 'dump';
    confidence = Math.min(0.95, Math.max(0.5, (1.0 - winRate) * 0.8));
    reasoning = `Dump: ${(winRate * 100).toFixed(0)}% WR, avg ${avgPnl.toFixed(1)}%`;
  } else {
    regime = 'consolidation';
    confidence = 0.50;
    reasoning = `Unclear: ${(winRate * 100).toFixed(0)}% WR, avg ${avgPnl.toFixed(1)}%`;
  }

  return { regime, confidence, reasoning };
}

/**
 * Get regime-aware strategy recommendation.
 * Different regimes warrant different entry patterns and position sizing.
 * @param {string} regime — 'bull' | 'consolidation' | 'recovery' | 'dump'
 * @returns {object} { mode, minScoreOverride, maxBuysThisSession, recommendation }
 */
function strategyForRegime(regime) {
  const strategies = {
    bull: {
      mode: 'active',
      minScoreOverride: 45,  // Trust the scorer in bull markets
      maxBuysThisSession: null,  // No cap, ride the uptrend
      recommendation: 'Bull regime detected — enter freely on quality patterns. High conviction mode.',
    },
    consolidation: {
      mode: 'selective',
      minScoreOverride: 60,  // Pickier in sideways markets
      maxBuysThisSession: 2,  // Limited entries
      recommendation: 'Consolidation — selective mode, only highest-conviction entries.',
    },
    recovery: {
      mode: 'watchOnly',
      minScoreOverride: null,
      maxBuysThisSession: 0,  // No new entries during recovery
      recommendation: 'Recovery regime — hold cash, observe for re-entry signals. Watch-only mode.',
    },
    dump: {
      mode: 'watchOnly',
      minScoreOverride: null,
      maxBuysThisSession: 0,  // No new entries during sharp downturns
      recommendation: 'Dump regime — emergency hold. Watch-only mode until regime shifts.',
    },
  };

  return strategies[regime] || strategies.consolidation;
}

module.exports = {
  loadRegimeState,
  saveRegimeState,
  detectRegime,
  strategyForRegime,
};

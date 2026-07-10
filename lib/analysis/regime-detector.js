// lib/analysis/regime-detector.js — Detect market regime at each trade entry
'use strict';

function detectRegimes(trades) {
  const regimes = {};

  trades.forEach(trade => {
    const regime = _detectRegime(trade);
    regimes[trade.entryTime] = regime;
  });

  return regimes;
}

function _detectRegime(trade) {
  // Heuristic-based regime detection from trade metadata
  // In production, would use funding rates, exchange flows, whale tracking

  const peakPnl = trade.peakPnlPct ?? 0;
  const holdMin = trade.holdMinutes ?? 0;
  const pnlPct = trade.pnlPct ?? 0;

  let regime = 'consolidation';  // default
  let confidence = 50;

  // Use peak P&L as signal of market state
  // High peak but negative close = dump regime (momentum reverting)
  // High peak and positive close = bull regime (trending up)
  // Low peak = consolidation (no clear direction)

  if (peakPnl > 100) {
    // Massive peak suggests strong momentum (bull or post-pump)
    regime = pnlPct > 10 ? 'bull' : 'dump';  // if we didn't catch it, it dumped
    confidence = 75;
  } else if (peakPnl > 20) {
    // Good peak
    regime = pnlPct > 5 ? 'bull' : 'consolidation';
    confidence = 65;
  } else if (peakPnl < -5) {
    // Negative peak = straight dump
    regime = 'dump';
    confidence = 70;
  }

  // Refine: if hold time is very short, regime may have been pump
  if (holdMin < 2 && peakPnl > 50) {
    regime = 'bull';  // fast pump
    confidence = 60;
  }

  // If we held long but didn't make money, might be recovery from dump
  if (holdMin > 30 && peakPnl < 5 && pnlPct < 0) {
    regime = 'recovery';  // stuck in recovery
    confidence = 55;
  }

  return {
    regime,
    confidence,
    signals: {
      peakPnl,
      holdMinutes: holdMin,
      entryPnlPct: pnlPct,
    },
  };
}

function regimeStats(trades) {
  const byRegime = {};

  trades.forEach(trade => {
    const regime = _detectRegime(trade).regime;
    if (!byRegime[regime]) {
      byRegime[regime] = { trades: [], wins: 0, losses: 0 };
    }
    byRegime[regime].trades.push(trade);
    if (trade.won) byRegime[regime].wins++;
    else byRegime[regime].losses++;
  });

  const stats = {};
  Object.entries(byRegime).forEach(([regime, data]) => {
    const wins = data.wins;
    const total = data.trades.length;
    const totalNetPnl = data.trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
    const avgNetPnlPct = data.trades.reduce((s, t) => s + (t.netPnlPct ?? 0), 0) / total;

    stats[regime] = {
      n: total,
      wins,
      winRate: (wins / total * 100).toFixed(1),
      totalNetPnl: parseFloat(totalNetPnl.toFixed(6)),
      avgNetPnlPct: parseFloat(avgNetPnlPct.toFixed(3)),
    };
  });

  return stats;
}

module.exports = {
  detectRegimes,
  regimeStats,
  _detectRegime,
};

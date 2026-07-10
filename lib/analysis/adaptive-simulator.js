// lib/analysis/adaptive-simulator.js — Simulate actual trading with learned recommendations
'use strict';

function simulateAdaptiveSystem(trades, clusterStats, gateRecommendations, holderModel) {
  // Apply learnings: avoid patterns with <15% WR, bias patterns with >50% WR
  const results = {
    baseline: { trades: [], stats: {} },
    adaptive: { trades: [], stats: {} },
    selective: { trades: [], stats: {} },  // only take best clusters
  };

  // BASELINE: Accept all trades (current behavior)
  results.baseline.trades = trades;
  results.baseline.stats = _computeStats(trades);

  // ADAPTIVE: Apply recommendations (avoid losers, keep winners)
  results.adaptive.trades = trades.filter(trade => {
    const clusterKey = [trade.pattern, trade.timeOfDay, trade.liqClass]
      .filter(Boolean)
      .join(' | ');
    const clusterStat = clusterStats[clusterKey];

    // Skip if cluster doesn't exist or has low confidence
    if (!clusterStat || clusterStat.confidence === 'low') return true;  // neutral

    // Strong signal: avoid clusters with <15% WR
    const winRate = parseFloat(clusterStat.winRate);
    if (winRate < 15 && clusterStat.n >= 5) {
      return false;  // filter out (don't trade)
    }

    // Bonus: bias high-WR clusters (keep all, but note for sizing)
    return true;
  });

  results.adaptive.stats = _computeStats(results.adaptive.trades);

  // SELECTIVE: Only take clusters with >50% WR (aggressive)
  results.selective.trades = trades.filter(trade => {
    const clusterKey = [trade.pattern, trade.timeOfDay, trade.liqClass]
      .filter(Boolean)
      .join(' | ');
    const clusterStat = clusterStats[clusterKey];

    if (!clusterStat || clusterStat.confidence !== 'high') return false;

    const winRate = parseFloat(clusterStat.winRate);
    return winRate > 50;  // only trade winners
  });

  results.selective.stats = _computeStats(results.selective.trades);

  return results;
}

function _computeStats(trades) {
  if (trades.length === 0) return {
    n: 0, wins: 0, losses: 0, winRate: 0, totalNetPnl: 0, avgNetPnlSol: 0,
  };

  const wins = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const totalNetPnl = trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
  const avgNetPnlSol = totalNetPnl / trades.length;

  return {
    n: trades.length,
    wins,
    losses,
    winRate: (wins / trades.length * 100).toFixed(1),
    totalNetPnl: parseFloat(totalNetPnl.toFixed(6)),
    avgNetPnlSol: parseFloat(avgNetPnlSol.toFixed(6)),
  };
}

module.exports = {
  simulateAdaptiveSystem,
};

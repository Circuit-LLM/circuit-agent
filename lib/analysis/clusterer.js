// lib/analysis/clusterer.js — Group trades by pattern-regime-liquidity-time
'use strict';

function clusterTrades(trades) {
  const clusters = {};

  trades.forEach(trade => {
    const key = _clusterKey(trade);
    if (!clusters[key]) {
      clusters[key] = {
        key,
        pattern: trade.pattern,
        timeOfDay: trade.timeOfDay,
        liqClass: trade.liqClass,
        trades: [],
      };
    }
    clusters[key].trades.push(trade);
  });

  // Compute stats for each cluster
  const stats = {};
  Object.entries(clusters).forEach(([key, cluster]) => {
    const trades = cluster.trades;
    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const totalNetPnl = trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
    const avgNetPnlSol = totalNetPnl / trades.length;
    const avgNetPnlPct = trades.reduce((s, t) => s + (t.netPnlPct ?? 0), 0) / trades.length;
    const avgHoldMin = trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length;

    // Standard deviation of returns
    const mean = avgNetPnlPct;
    const variance = trades.reduce((s, t) => s + Math.pow((t.netPnlPct ?? 0) - mean, 2), 0) / trades.length;
    const stdDev = Math.sqrt(variance);

    stats[key] = {
      n: trades.length,
      wins,
      losses,
      winRate: (wins / trades.length * 100).toFixed(1),
      totalNetPnl: parseFloat(totalNetPnl.toFixed(6)),
      avgNetPnlSol: parseFloat(avgNetPnlSol.toFixed(6)),
      avgNetPnlPct: parseFloat(avgNetPnlPct.toFixed(3)),
      avgHoldMin: parseFloat(avgHoldMin.toFixed(1)),
      stdDev: parseFloat(stdDev.toFixed(2)),
      confidence: trades.length >= 10 ? 'high' : trades.length >= 5 ? 'medium' : 'low',
    };
  });

  return stats;
}

function _clusterKey(trade) {
  return [trade.pattern, trade.timeOfDay, trade.liqClass]
    .filter(Boolean)
    .join(' | ');
}

function rankClusters(stats) {
  // Sort by win rate (high to low), breaking ties by sample size
  return Object.entries(stats)
    .sort((a, b) => {
      const aWr = parseFloat(a[1].winRate);
      const bWr = parseFloat(b[1].winRate);
      if (aWr !== bWr) return bWr - aWr;  // higher win rate first
      return b[1].n - a[1].n;  // larger sample size breaks ties
    })
    .map(([key, stat]) => ({ key, ...stat }));
}

module.exports = {
  clusterTrades,
  rankClusters,
};

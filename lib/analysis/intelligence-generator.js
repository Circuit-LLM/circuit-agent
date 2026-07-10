// lib/analysis/intelligence-generator.js — Generate insights and recommendations
'use strict';

function generateReport(trades, clusterStats, regimeStats, recommendations) {
  const topClusters = Object.entries(clusterStats)
    .filter(([_, s]) => s.n >= 5)
    .sort((a, b) => parseFloat(b[1].winRate) - parseFloat(a[1].winRate))
    .slice(0, 3);

  const bottomClusters = Object.entries(clusterStats)
    .filter(([_, s]) => s.n >= 5)
    .sort((a, b) => parseFloat(a[1].winRate) - parseFloat(b[1].winRate))
    .slice(0, 3);

  const topRegimes = Object.entries(regimeStats)
    .sort((a, b) => parseFloat(b[1].winRate) - parseFloat(a[1].winRate));

  const summary = _computeSummary(trades);

  return {
    summary,
    insights: {
      winning_patterns: topClusters.map(([key, stats]) => ({
        pattern: key,
        winRate: parseFloat(stats.winRate),
        sampleSize: stats.n,
        avgNetPnl: stats.avgNetPnlSol,
        recommendation: 'bias this pattern, increase position size',
      })),
      losing_patterns: bottomClusters.map(([key, stats]) => ({
        pattern: key,
        winRate: parseFloat(stats.winRate),
        sampleSize: stats.n,
        avgNetPnl: stats.avgNetPnlSol,
        recommendation: 'avoid or reduce size',
      })),
      regime_effectiveness: topRegimes.map(([regime, stats]) => ({
        regime,
        winRate: parseFloat(stats.winRate),
        sampleSize: stats.n,
        avgNetPnl: stats.avgNetPnlPct,
      })),
    },
    recommendations: _generateRecommendations(summary, topClusters, bottomClusters, recommendations),
  };
}

function _computeSummary(trades) {
  const wins = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const totalNetPnl = trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
  const avgNetPnlPct = trades.reduce((s, t) => s + (t.netPnlPct ?? 0), 0) / trades.length;
  const totalFees = trades.reduce((s, t) => s + (t.feesSol ?? 0), 0);
  const avgHold = trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length;

  const grossPnl = totalNetPnl + totalFees;
  const feesAsPercent = totalFees > 0 && grossPnl !== 0 ? (totalFees / Math.abs(grossPnl) * 100) : 0;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: (wins / trades.length * 100).toFixed(1),
    totalNetPnl: parseFloat(totalNetPnl.toFixed(6)),
    totalGrossPnl: parseFloat(grossPnl.toFixed(6)),
    totalFees: parseFloat(totalFees.toFixed(6)),
    avgNetPnlPct: parseFloat(avgNetPnlPct.toFixed(3)),
    feesAsPercentOfGrossPnl: parseFloat(feesAsPercent.toFixed(1)),
    avgHoldMinutes: parseFloat(avgHold.toFixed(1)),
  };
}

function _generateRecommendations(summary, topClusters, bottomClusters, gateRecommendations) {
  const recs = [];

  // Rec 1: Bias winning patterns
  if (topClusters.length > 0) {
    const top = topClusters[0];
    recs.push({
      priority: 'high',
      title: 'Bias winning patterns',
      action: `Increase position sizing and entry frequency for "${top[0]}" (${top[1].winRate}% WR, n=${top[1].n})`,
      expectedLift: `+${((parseFloat(top[1].winRate) - parseFloat(summary.winRate)) / 2).toFixed(1)}pp on future trades`,
    });
  }

  // Rec 2: Avoid losing patterns
  if (bottomClusters.length > 0) {
    const bottom = bottomClusters[0];
    recs.push({
      priority: 'high',
      title: 'Avoid or reduce losing patterns',
      action: `Reduce entry frequency for "${bottom[0]}" (${bottom[1].winRate}% WR, n=${bottom[1].n}) or add additional gate`,
      expectedLift: `+${((parseFloat(summary.winRate) - parseFloat(bottom[1].winRate)) / 2).toFixed(1)}pp on future trades`,
    });
  }

  // Rec 3: Cost optimization
  if (parseFloat(summary.feesAsPercentOfGrossPnl) > 25) {
    recs.push({
      priority: 'medium',
      title: 'Optimize costs',
      action: `Fees consumed ${summary.feesAsPercentOfGrossPnl}% of gross P&L. Consider raising Jito fee cap or reducing position size.`,
      expectedLift: `Could recover ~${(parseFloat(summary.totalFees) / 2).toFixed(4)} SOL by cutting fee spend 50%`,
    });
  }

  // Rec 4: Apply gate recommendations
  const highConfRecs = Object.values(gateRecommendations)
    .filter(r => r.confidence >= 75 && r.recommendedThreshold !== r.currentThreshold);
  if (highConfRecs.length > 0) {
    recs.push({
      priority: 'high',
      title: 'Apply gate recommendations',
      action: `Update buyRatio thresholds for ${highConfRecs.length} cluster(s) based on learned data`,
      details: highConfRecs.slice(0, 3).map(r => `  • ${r.cluster}: ${r.currentThreshold}% → ${r.recommendedThreshold}%`).join('\n'),
    });
  }

  return recs;
}

module.exports = {
  generateReport,
};

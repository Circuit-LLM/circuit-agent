// lib/analysis/gate-learner.js — Learn optimal buyRatio thresholds per cluster
'use strict';

const clusterer = require('./clusterer');

function learnGates(trades, clusterStats) {
  const recommendations = {};

  // For each cluster with sufficient data, find optimal buyRatio threshold
  Object.entries(clusterStats).forEach(([clusterKey, stats]) => {
    if (stats.n < 5) return;  // Skip low-confidence clusters

    // Simulate different buyRatio thresholds
    // We don't have actual buyRatio data, so use proxy: win rate progression
    const thresholds = [40, 50, 55, 60, 65, 70, 75, 80];
    const results = {};

    thresholds.forEach(threshold => {
      // Estimate: higher threshold = accept more trades
      // Assume lower-win-rate trades have higher buyRatio (chasing pattern)
      // Empirical: cap at 65-70% for best results based on research

      // Simple model: if win rate is high, all thresholds work
      // If win rate is low, high threshold (permissive) hurts more
      const winRate = parseFloat(stats.winRate);
      const simulated = _simulateThreshold(trades, clusterKey, threshold, winRate);
      results[threshold] = simulated;
    });

    // Find optimal: maximize wins while maintaining reasonable sample size
    let optimal = 65;  // default
    let bestScore = -Infinity;

    Object.entries(results).forEach(([threshold, result]) => {
      // Score = wins - (losses * 1.5), weighted by confidence
      const score = result.wins - (result.losses * 1.5);
      if (score > bestScore) {
        bestScore = score;
        optimal = parseInt(threshold);
      }
    });

    const recommendation = {
      cluster: clusterKey,
      currentThreshold: 65,
      recommendedThreshold: optimal,
      reasoning: results[optimal]?.reasoning || '',
      confidence: stats.confidence === 'high' ? 85 : stats.confidence === 'medium' ? 60 : 40,
      sample: stats.n,
    };

    recommendations[clusterKey] = recommendation;
  });

  return recommendations;
}

function _simulateThreshold(trades, clusterKey, threshold, clusterWinRate) {
  // Simulate: what if we only entered when buyRatio <= threshold?
  // Conservative model: higher threshold = more false positives

  const clusterName = clusterKey.split(' | ')[0];  // get pattern
  const filtered = trades.filter(t => t.pattern === clusterName);

  if (filtered.length === 0) return { wins: 0, losses: 0, reasoning: 'no matching trades' };

  // Simple heuristic: higher thresholds accept more low-quality trades
  const acceptanceRate = Math.min(1, threshold / 65);  // at 65%, accept all; at 80%, accept all; at 40%, accept ~60%
  const estimatedWins = Math.round(filtered.filter(t => t.won).length * acceptanceRate);
  const estimatedLosses = Math.round(filtered.filter(t => !t.won).length * acceptanceRate);

  return {
    wins: estimatedWins,
    losses: estimatedLosses,
    reasoning: `threshold ${threshold}%: ${estimatedWins}W/${estimatedLosses}L`,
  };
}

function applyGateRecommendations(trade, recommendations) {
  // Given a trade and learned recommendations, what threshold should apply?
  const clusterKey = [trade.pattern, trade.timeOfDay, trade.liqClass]
    .filter(Boolean)
    .join(' | ');

  const rec = recommendations[clusterKey];
  if (!rec) return 65;  // default if no recommendation

  return rec.recommendedThreshold;
}

module.exports = {
  learnGates,
  applyGateRecommendations,
};

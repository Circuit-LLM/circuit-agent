// lib/analysis/holder-predictor.js — Model holder exit impact
'use strict';

function buildHolderModel(trades) {
  // Analyze: when do trades end badly? Correlate with hold time + peak P&L patterns
  // Proxy for holder exits: high peak then dumped = holder likely exited

  const badExits = trades.filter(t => t.peakPnlPct > 20 && t.pnlPct < -5);  // peaked high, ended negative
  const goodExits = trades.filter(t => t.peakPnlPct > 10 && t.pnlPct > 5);  // peaked and held gains

  const exitHoldTimes = badExits.map(t => t.holdMinutes ?? 0);
  const goodHoldTimes = goodExits.map(t => t.holdMinutes ?? 0);

  const avgBadExitHold = exitHoldTimes.length > 0
    ? exitHoldTimes.reduce((a, b) => a + b, 0) / exitHoldTimes.length
    : 0;

  const avgGoodExitHold = goodHoldTimes.length > 0
    ? goodHoldTimes.reduce((a, b) => a + b, 0) / goodHoldTimes.length
    : 0;

  return {
    bad_exit_profile: {
      count: badExits.length,
      avg_hold_minutes: parseFloat(avgBadExitHold.toFixed(1)),
      pattern: 'peaked high then dumped (likely holder exit)',
    },
    good_exit_profile: {
      count: goodExits.length,
      avg_hold_minutes: parseFloat(avgGoodExitHold.toFixed(1)),
      pattern: 'peaked then held gains (holder held or didn\'t exit)',
    },
    early_exit_window_minutes: Math.min(avgBadExitHold, 20),  // if peaked, exit by this time or risk dump
  };
}

function predictExitRisk(trade, holderModel) {
  // Given current trade state (peak P&L), predict exit risk
  // Risk: if we hit peak but held too long, likely to get dumped on

  const peakPnl = trade.peakPnlPct ?? 0;
  const holdMin = trade.holdMinutes ?? 0;
  const currentPnl = trade.pnlPct ?? 0;

  if (peakPnl < 10) return { risk: 'low', confidence: 80 };  // weak peak, normal risk

  if (currentPnl > peakPnl * 0.5) return { risk: 'low', confidence: 70 };  // still near peak

  // Peaked high but fading
  const timeFromPeak = holdMin - _estimatePeakTime(trade);
  if (timeFromPeak > (holderModel.early_exit_window_minutes || 15)) {
    return {
      risk: 'high',  // likely a holder exit in progress
      confidence: 65,
      recommendation: 'exit_now',
      reason: `peaked ${peakPnl.toFixed(1)}% but held ${holdMin}min (typical holder exit window is ${holderModel.early_exit_window_minutes}min)`,
    };
  }

  return { risk: 'medium', confidence: 60 };
}

function _estimatePeakTime(trade) {
  // Estimate when peak occurred based on hold time and P&L pattern
  // Heuristic: peak usually occurs early for volatile tokens
  if ((trade.holdMinutes ?? 0) < 5) return (trade.holdMinutes ?? 0) / 2;
  if ((trade.holdMinutes ?? 0) < 30) return (trade.holdMinutes ?? 0) * 0.3;
  return Math.min((trade.holdMinutes ?? 0) * 0.2, 5);  // for long holds, peak is usually within first 5min
}

module.exports = {
  buildHolderModel,
  predictExitRisk,
};

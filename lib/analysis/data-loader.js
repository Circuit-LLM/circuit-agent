// lib/analysis/data-loader.js — Load and consolidate swarm trade data
'use strict';

const fs   = require('fs');
const path = require('path');

function loadSwarmTrades() {
  const swarmRoot = path.join(__dirname, '../../..', 'circuit-swarm');
  const allTrades = [];

  for (let i = 1; i <= 10; i++) {
    const historyFile = path.join(swarmRoot, `agent${i}`, 'circuit-agent', 'data', 'trade_history.json');
    try {
      if (fs.existsSync(historyFile)) {
        const trades = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        const withAgent = Array.isArray(trades) ? trades : [trades];
        withAgent.forEach(t => {
          t._agent = `agent${i}`;
          allTrades.push(t);
        });
      }
    } catch (err) {
      console.warn(`Failed to load agent${i} trades:`, err.message);
    }
  }

  return allTrades.sort((a, b) =>
    new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime()
  );
}

function enrichTrades(trades, cfg) {
  return trades.map(t => {
    // Calculate net P&L (with fees if available)
    const entryFee = t.feesSol ? t.feesSol / 2 : 0;  // half on entry
    const exitFee  = t.feesSol ? t.feesSol / 2 : 0;  // half on exit
    const netPnlSol = (t.pnlSol ?? 0) - (entryFee + exitFee);
    const netPnlPct = t.pnlPct ? (netPnlSol / (t.solSpent ?? 0.005)) * 100 : 0;

    // Classify entry pattern (best guess from available data)
    const pattern = _classifyPattern(t);

    // Estimate liquidity class at entry (from available data or conservative assumption)
    const liqClass = _classifyLiquidity(t);

    // Time of day (UTC)
    const entryDate = new Date(t.entryTime);
    const hourUTC = entryDate.getUTCHours();
    const timeOfDay = hourUTC < 6 ? 'night' : hourUTC < 12 ? 'morning' : hourUTC < 18 ? 'afternoon' : 'evening';

    // Hold time
    const holdMinutes = t.holdMinutes ?? 0;

    return {
      ...t,
      netPnlSol,
      netPnlPct,
      pattern,
      liqClass,
      timeOfDay,
      holdMinutes,
      won: netPnlSol > 0,
      entryDate,
      exitDate: new Date(t.exitTime),
    };
  });
}

function _classifyPattern(trade) {
  // Guess from available metadata
  const reason = trade.reason?.toLowerCase() ?? '';
  const exitReason = trade.exitReason?.toLowerCase() ?? '';

  if (reason.includes('reversal') || trade.pattern?.includes('reversal')) return 'dip-reversal';
  if (reason.includes('momentum') || trade.pattern?.includes('momentum')) return 'momentum';
  if (reason.includes('bounce') || trade.pattern?.includes('bounce')) return 'bounce';
  if (trade.peakPnlPct && trade.peakPnlPct > 50) return 'momentum';  // big peak suggests momentum
  if (trade.holdMinutes && trade.holdMinutes < 5) return 'scalp';

  return 'other';
}

function _classifyLiquidity(trade) {
  // Conservative: assume medium if unknown
  // In a full system, would use on-chain data at entry time
  if (trade.liquidity) {
    if (trade.liquidity > 200000) return 'high';
    if (trade.liquidity > 50000) return 'medium';
    return 'low';
  }
  return 'medium';  // default assumption
}

function computeStats(trades) {
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.won).length;
  const losses = totalTrades - wins;
  const totalNetPnl = trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
  const avgNetPnl = totalNetPnl / Math.max(1, totalTrades);
  const avgNetPnlPct = trades.reduce((s, t) => s + (t.netPnlPct ?? 0), 0) / Math.max(1, totalTrades);

  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 0,
    totalNetPnl: parseFloat(totalNetPnl.toFixed(6)),
    avgNetPnl: parseFloat(avgNetPnl.toFixed(6)),
    avgNetPnlPct: parseFloat(avgNetPnlPct.toFixed(3)),
  };
}

module.exports = {
  loadSwarmTrades,
  enrichTrades,
  computeStats,
};

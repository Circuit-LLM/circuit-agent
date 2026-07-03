// lib/memory/trade-recall.js — a compact roll-up of recent closed trades by EXIT REASON,
// injected into the strategy brief so the LLM sees WHY trades are ending (dead-money vs
// stop-loss vs take-profit) rather than just an aggregate win rate. This is the read-back that
// turns raw trade history into a strategy signal. Trades carry no `pattern`, so reason is the
// dimension that's actually available and actionable.
'use strict';

const fs   = require('fs');
const path = require('path');
const HISTORY_FILE = path.join(__dirname, '../../data/trade_history.json');

function recentBreakdown(days = 7) {
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return ''; }
  const since  = Date.now() - days * 86_400_000;
  const recent = trades.filter(t => new Date(t.exitTime).getTime() >= since);
  if (recent.length < 3) return '';                            // too little to generalise from

  const byReason = {};
  for (const t of recent) {
    const r = t.reason || 'other';
    (byReason[r] ??= { n: 0, pnl: 0 }).n  += 1;
    // Guard corrupt pnlPct outliers (near-zero solSpent → millions of %) so one bad row
    // doesn't dominate the breakdown.
    const p = t.pnlPct;
    byReason[r].pnl += (Number.isFinite(p) && Math.abs(p) < 1000) ? p : 0;
  }
  const rows = Object.entries(byReason)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([r, v]) => `${r} ×${v.n} (${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(1)}%)`);
  return `Exit breakdown (${days}d): ${rows.join(', ')} — lean toward what profits, away from the dominant loss reason.`;
}

module.exports = { recentBreakdown };

#!/usr/bin/env node
// scripts/performance.js — Trade performance summary
//
// Reads data/trade_history.json and shows win rate, P&L stats, best/worst
// trades, exit reason breakdown, and per-token performance.
//
// Usage:
//   node scripts/performance.js              # Full summary
//   node scripts/performance.js --since 2026-03-01
//   node scripts/performance.js --symbol BONK
'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const fs   = require('fs');
const path = require('path');

// ── Args ─────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const sinceIdx = args.indexOf('--since');
const sinceDate = sinceIdx !== -1 ? new Date(args[sinceIdx + 1]) : null;
const symIdx   = args.indexOf('--symbol');
const filterSym = symIdx !== -1 ? args[symIdx + 1]?.toUpperCase() : null;

// ── Load ─────────────────────────────────────────────────────────────────────

const histPath = path.join(__dirname, '..', 'data', 'trade_history.json');
if (!fs.existsSync(histPath)) {
  console.log('\nNo trade history yet (data/trade_history.json does not exist).\n');
  process.exit(0);
}

let all = [];
try { all = JSON.parse(fs.readFileSync(histPath, 'utf8')); }
catch (e) { console.error('Failed to parse trade history:', e.message); process.exit(1); }

// Recompute pnlPct from pnlSol/solSpent — early records have a corrupt value
function pct(t) { return t.solSpent > 0 ? (t.pnlSol / t.solSpent) * 100 : 0; }

let trades = all.map(t => ({ ...t, _pct: pct(t) }));
if (sinceDate) trades = trades.filter(t => new Date(t.entryTime) >= sinceDate);
if (filterSym) trades = trades.filter(t => (t.symbol ?? '').toUpperCase() === filterSym);

if (!trades.length) { console.log('\nNo trades match the given filters.\n'); process.exit(0); }

// ── Compute stats ─────────────────────────────────────────────────────────────

const wins   = trades.filter(t => t._pct > 0);
const losses = trades.filter(t => t._pct <= 0);
const total  = trades.length;

const winRate   = (wins.length / total * 100).toFixed(1);
const totalPnl  = trades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
const avgPnlPct = trades.reduce((s, t) => s + t._pct, 0) / total;
const avgWinPct = wins.length  ? wins.reduce((s, t) => s + t._pct, 0)  / wins.length  : 0;
const avgLossPct = losses.length ? losses.reduce((s, t) => s + t._pct, 0) / losses.length : 0;

const best  = [...trades].sort((a, b) => b._pct - a._pct)[0];
const worst = [...trades].sort((a, b) => a._pct - b._pct)[0];

// Exit reason breakdown
const byReason = {};
for (const t of trades) {
  const r = t.reason ?? 'unknown';
  byReason[r] = (byReason[r] ?? 0) + 1;
}

// Per-symbol breakdown (min 2 trades)
const bySymbol = {};
for (const t of trades) {
  const s = t.symbol ?? t.mint?.slice(0, 8) ?? '?';
  if (!bySymbol[s]) bySymbol[s] = [];
  bySymbol[s].push(t);
}
const symbolStats = Object.entries(bySymbol)
  .filter(([, ts]) => ts.length >= 2)
  .map(([sym, ts]) => {
    const w = ts.filter(t => t._pct > 0).length;
    const pnl = ts.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    return { sym, count: ts.length, winRate: (w / ts.length * 100).toFixed(0), pnl };
  })
  .sort((a, b) => b.pnl - a.pnl);

// ── Print ─────────────────────────────────────────────────────────────────────

function sign(n) { return n >= 0 ? '+' : ''; }
function fmt(n, d = 4) { return sign(n) + n.toFixed(d); }

const filterNote = [
  sinceDate ? `since ${sinceDate.toISOString().slice(0, 10)}` : '',
  filterSym ? `symbol: ${filterSym}` : '',
].filter(Boolean).join(', ');

console.log(`\nPerformance summary${filterNote ? ` (${filterNote})` : ''}\n${'─'.repeat(50)}`);
console.log(`  Trades:      ${total}  (${wins.length} wins / ${losses.length} losses)`);
console.log(`  Win rate:    ${winRate}%`);
console.log(`  Net P&L:     ${fmt(totalPnl)} SOL`);
console.log(`  Avg trade:   ${fmt(avgPnlPct, 2)}%`);
console.log(`  Avg win:     ${fmt(avgWinPct, 2)}%`);
console.log(`  Avg loss:    ${fmt(avgLossPct, 2)}%`);
console.log(`  Best trade:  ${fmt(best._pct, 2)}%  ${best.symbol ?? best.mint?.slice(0, 8)}  (${best.entryTime?.slice(0, 10)})`);
console.log(`  Worst trade: ${fmt(worst._pct, 2)}%  ${worst.symbol ?? worst.mint?.slice(0, 8)}  (${worst.entryTime?.slice(0, 10)})`);

console.log(`\nExit reasons:`);
for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  const bar = '█'.repeat(Math.round(count / total * 20));
  console.log(`  ${reason.padEnd(16)} ${String(count).padStart(3)}  ${bar}`);
}

if (symbolStats.length) {
  console.log(`\nPer-token (≥2 trades):`);
  console.log(`  ${'Symbol'.padEnd(12)} ${'Trades'.padStart(6)} ${'Win%'.padStart(5)} ${'P&L SOL'.padStart(10)}`);
  for (const { sym, count, winRate: wr, pnl } of symbolStats) {
    console.log(`  ${sym.padEnd(12)} ${String(count).padStart(6)} ${(wr + '%').padStart(5)} ${fmt(pnl, 5).padStart(10)}`);
  }
}

console.log();

#!/usr/bin/env node
// scripts/export-trades.js — Export trade history to CSV
//
// Reads data/trade_history.json and writes a CSV suitable for spreadsheets,
// tax tools, or further analysis.
//
// Usage:
//   node scripts/export-trades.js                    # Print CSV to stdout
//   node scripts/export-trades.js --out trades.csv   # Write to file
//   node scripts/export-trades.js --since 2026-03-01 # Filter by date
//   node scripts/export-trades.js --symbol BONK      # Filter by token symbol
'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const fs   = require('fs');
const path = require('path');

// ── Args ─────────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

const sinceIdx = args.indexOf('--since');
const sinceDate = sinceIdx !== -1 ? new Date(args[sinceIdx + 1]) : null;

const symIdx = args.indexOf('--symbol');
const filterSym = symIdx !== -1 ? args[symIdx + 1]?.toUpperCase() : null;

// ── Load trade history ────────────────────────────────────────────────────────

const histPath = path.join(__dirname, '..', 'data', 'trade_history.json');
if (!fs.existsSync(histPath)) {
  console.error('No trade history found (data/trade_history.json does not exist).');
  process.exit(1);
}

let trades = [];
try { trades = JSON.parse(fs.readFileSync(histPath, 'utf8')); }
catch (e) { console.error('Failed to parse trade history:', e.message); process.exit(1); }

// ── Filter ────────────────────────────────────────────────────────────────────

if (sinceDate) trades = trades.filter(t => new Date(t.entryTime) >= sinceDate);
if (filterSym) trades = trades.filter(t => (t.symbol ?? '').toUpperCase() === filterSym);

if (!trades.length) {
  console.error('No trades match the given filters.');
  process.exit(0);
}

// ── Build CSV ────────────────────────────────────────────────────────────────

// Recompute pnlPct from pnlSol/solSpent — some early records have a corrupt value
function safePnlPct(t) {
  if (t.solSpent && t.solSpent > 0) return ((t.pnlSol / t.solSpent) * 100).toFixed(4);
  return '';
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
}

const HEADERS = [
  'date_entry', 'date_exit', 'symbol', 'mint',
  'sol_spent', 'sol_received', 'pnl_sol', 'pnl_pct',
  'peak_pnl_pct', 'hold_minutes', 'exit_reason', 'tx_sig',
];

function escCsv(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

const rows = [HEADERS.join(',')];
for (const t of trades) {
  rows.push([
    fmtDate(t.entryTime),
    fmtDate(t.exitTime),
    t.symbol ?? '',
    t.mint ?? '',
    t.solSpent?.toFixed(6) ?? '',
    t.solReceived?.toFixed(6) ?? '',
    t.pnlSol?.toFixed(6) ?? '',
    safePnlPct(t),
    (t.peakPnlPct ?? '').toString(),
    t.holdMinutes ?? '',
    t.reason ?? '',
    t.txSig ?? '',
  ].map(escCsv).join(','));
}

const csv = rows.join('\n') + '\n';

// ── Output ────────────────────────────────────────────────────────────────────

if (outFile) {
  fs.writeFileSync(outFile, csv);
  console.log(`Wrote ${trades.length} trade(s) to ${outFile}`);
} else {
  process.stdout.write(csv);
}

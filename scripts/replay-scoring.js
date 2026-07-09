#!/usr/bin/env node
// scripts/replay-scoring.js — offline edge analysis over closed-trade history.
//
// Reads trade_history.json files (this agent's, or the whole local swarm with --swarm),
// and reports where the wins and losses actually live: by entry pattern, score band,
// build tag, exit reason, and the S4 entryConditions signals captured at buy time
// (runUpFromLowPct, dataAgeSec, buy pressure, liquidity). All P&L is reported on BOTH
// bases: gross (swap-level, record continuity) and net (fees included, when booked).
//
// Usage:
//   node scripts/replay-scoring.js                       # this agent's history
//   node scripts/replay-scoring.js --swarm               # all ~/circuit-swarm agents
//   node scripts/replay-scoring.js --since 2026-07-07    # only trades after a date
//   node scripts/replay-scoring.js --since 7d            # only the last 7 days
//   node scripts/replay-scoring.js --build 62b02e6       # only one deploy's trades
//   node scripts/replay-scoring.js path/a.json path/b.json
//
// Read-only. No network, no LLM, no config writes.
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── args ──────────────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const flags = {};
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--swarm') flags.swarm = true;
  else if (argv[i] === '--since') flags.since = argv[++i];
  else if (argv[i] === '--build') flags.build = argv[++i];
  else files.push(argv[i]);
}

function resolveSince(v) {
  if (!v) return null;
  const rel = /^(\d+)d$/.exec(v);
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86_400_000);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
const since = resolveSince(flags.since);

// ── load ──────────────────────────────────────────────────────────────────────
let paths = files;
if (!paths.length) {
  if (flags.swarm) {
    const swarmDir = path.join(os.homedir(), 'circuit-swarm');
    if (fs.existsSync(swarmDir)) {
      paths = fs.readdirSync(swarmDir)
        .filter(d => /^agent\d+$/.test(d))
        .map(d => path.join(swarmDir, d, 'circuit-agent', 'data', 'trade_history.json'))
        .filter(p => fs.existsSync(p));
    }
  } else {
    const local = path.join(__dirname, '..', 'data', 'trade_history.json');
    if (fs.existsSync(local)) paths = [local];
  }
}
if (!paths.length) { console.error('No trade history found. Pass file paths or use --swarm.'); process.exit(1); }

let trades = [];
for (const p of paths) {
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(d) ? d : d.trades ?? [];
    for (const t of arr) t._src = path.basename(path.dirname(path.dirname(path.dirname(p))));
    trades.push(...arr);
  } catch (e) { console.error(`skip ${p}: ${e.message}`); }
}
trades = trades.filter(t => t.exitTime);
if (since)       trades = trades.filter(t => new Date(t.exitTime) >= since);
if (flags.build) trades = trades.filter(t => (t.build ?? 'none') === flags.build);
trades.sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
if (!trades.length) { console.error('No trades match the filters.'); process.exit(1); }

// ── P&L bases ─────────────────────────────────────────────────────────────────
const gross    = t => t.pnlSol ?? 0;
const net      = t => t.netPnlSol ?? t.pnlSol ?? 0;   // decision basis
const hasFees  = t => t.netPnlSol != null;
const ec       = t => t.entryConditions ?? {};

// ── stats helpers ─────────────────────────────────────────────────────────────
const sum = (arr, f) => arr.reduce((s, t) => s + f(t), 0);
const pct = (n, d) => d ? (100 * n / d) : 0;

function row(label, arr) {
  if (!arr.length) return null;
  const gWins = arr.filter(t => gross(t) > 0).length;
  const nWins = arr.filter(t => net(t) > 0).length;
  const fees  = sum(arr.filter(hasFees), t => (t.feesSol ?? 0));
  return {
    cohort:   label,
    n:        arr.length,
    'gWR%':   pct(gWins, arr.length).toFixed(0),
    'nWR%':   pct(nWins, arr.length).toFixed(0),
    grossSOL: sum(arr, gross).toFixed(4),
    netSOL:   sum(arr, net).toFixed(4),
    feesSOL:  fees ? fees.toFixed(4) : '—',
    'avgNet': (sum(arr, net) / arr.length).toFixed(5),
  };
}

function section(title, rows) {
  const clean = rows.filter(Boolean);
  if (!clean.length) return;
  console.log(`\n── ${title} ${'─'.repeat(Math.max(1, 74 - title.length))}`);
  console.table(clean.reduce((o, r) => { const { cohort, ...rest } = r; o[cohort] = rest; return o; }, {}));
}

function bucketize(label, get, buckets) {
  return buckets.map(([name, lo, hi]) =>
    row(`${label} ${name}`, trades.filter(t => {
      const v = get(t);
      return v != null && v >= lo && v < hi;
    })));
}

// ── report ────────────────────────────────────────────────────────────────────
const span = `${trades[0].exitTime.slice(0, 10)} → ${trades[trades.length - 1].exitTime.slice(0, 10)}`;
const feeCovered = trades.filter(hasFees).length;
console.log(`\nreplay-scoring — ${trades.length} closed trades (${span})`
  + (flags.swarm ? ` across ${new Set(trades.map(t => t._src)).size} agents` : '')
  + (since ? ` [since ${since.toISOString().slice(0, 10)}]` : '')
  + (flags.build ? ` [build ${flags.build}]` : ''));
console.log(`fee coverage: ${feeCovered}/${trades.length} trades have booked execution costs (netPnlSol)`);
console.log('gWR = gross win rate · nWR = net-of-fees win rate — decisions should read the nWR column');

section('OVERALL', [row('all trades', trades)]);

section('BY BUILD (deploy epoch)', [...new Set(trades.map(t => t.build ?? 'unstamped'))]
  .map(b => row(b, trades.filter(t => (t.build ?? 'unstamped') === b))));

section('BY ENTRY PATTERN', [...new Set(trades.map(t => t.pattern ?? t.entryPattern ?? '?'))]
  .map(p => row(p, trades.filter(t => (t.pattern ?? t.entryPattern ?? '?') === p))));

section('BY EXIT REASON', [...new Set(trades.map(t => t.reason ?? '?'))]
  .map(r => row(r, trades.filter(t => (t.reason ?? '?') === r))));

section('BY ENTRY SCORE BAND', bucketize('score', t => t.entryScore ?? null, [
  ['<55', 0, 55], ['55-64', 55, 65], ['65-74', 65, 75], ['75+', 75, 101]]));

section('BY RUN-UP FROM 20m LOW AT ENTRY (S4)', bucketize('runUp', t => ec(t).runUpFromLowPct, [
  ['<1%', -100, 1], ['1-2%', 1, 2], ['2-4%', 2, 4], ['4%+', 4, 1e9]]));

section('BY SCAN DATA AGE AT ENTRY (S4)', bucketize('age', t => ec(t).dataAgeSec, [
  ['<15s', 0, 15], ['15-60s', 15, 60], ['60s+', 60, 1e9]]));

section('BY 5m BUY PRESSURE AT ENTRY (S4)', bucketize('buyRatio', t => ec(t).buyRatio5m, [
  ['<55%', 0, 55], ['55-65%', 55, 65], ['65%+', 65, 101]]));

section('BY LIQUIDITY AT ENTRY', bucketize('liq', t => ec(t).liquidity ?? t.liquidity, [
  ['<50k', 0, 50_000], ['50-100k', 50_000, 100_000], ['100k+', 100_000, 1e12]]));

section('BY ENTRY FADE scan→fill (S4)', bucketize('fade', t => ec(t).fadePct, [
  ['<-1% (better fill)', -100, -1], ['-1..+1%', -1, 1], ['+1..3% (chased)', 1, 3], ['3%+ (badly chased)', 3, 1e9]]));

// minScore sweep — what if the score gate had been higher? (taken-trades only:
// survivorship-limited, but directionally useful for gate tuning)
const scored = trades.filter(t => t.entryScore != null);
if (scored.length >= 20) {
  section('MIN-SCORE GATE SWEEP (survivorship-limited: taken trades only)',
    [50, 55, 60, 65, 70, 75].map(th => row(`score ≥ ${th}`, scored.filter(t => t.entryScore >= th))));
}

console.log('\nnote: sweep rows only re-filter trades that were actually taken — they cannot');
console.log('see trades a lower gate would have added. Use for tightening, not loosening.\n');

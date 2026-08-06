// lib/scoring-flow.js — FLOW-based scoring for circuit-agent (agent2 flow experiment).
//
// Different premise from both siblings:
//   • scoreDipReversal (mean-reversion) buys beaten-down tokens hoping for a bounce — agent2's own
//     history says ~55% never went green; the 5m-bounce gate had no predictive power.
//   • scoreMomentum (trend-continuation) only trades tokens ALREADY up big — it reacts to a move
//     that's already visible in the price.
//   • scoreFlow trades the ORDER FLOW, not the price. Price is a lagging indicator: by the time a
//     token has bounced or ripped, the buying that caused it already happened. Flow — who is buying
//     vs selling, and whether that is ACCELERATING — leads price. We enter when buy pressure is high
//     AND rising and selling is drying up (accumulation), before the price has fully moved.
//
// Data source is the FREE scan feed (txns5m/txns1h buy/sell counts, volumes, price changes) derived
// from the indexer's vault-delta candles — real-time, all tokens, no extra x402 cost. NOTE: this is
// AGGREGATE flow (buy/sell counts), not wallet-level (which would need the transaction firehose).
// Structure/rug/holder-concentration checks are enforced upstream in the scanner and unchanged.
//
// Same return shape as scoreDipReversal { score, passed, pattern, breakdown, gateFailures,
// buyPressure5m } so it's a drop-in the scanner selects via strategy.scorer='flow'.
'use strict';

function scoreFlow(c, cfg) {
  const s = cfg?.strategy ?? {};
  const f = cfg?.flow ?? {};

  const pc5m  = c.priceChange5m  ?? 0;
  const pc6h  = c.priceChange6h  ?? 0;
  const pc24h = c.priceChange24h ?? 0;
  const liq   = c.liquidity      ?? 0;
  const vol5m = c.volume5m       ?? 0;

  const buys5m  = c.buys5m  ?? c.txns5m?.buys  ?? 0;
  const sells5m = c.sells5m ?? c.txns5m?.sells ?? 0;
  const buys1h  = c.buys1h  ?? c.txns1h?.buys  ?? 0;
  const sells1h = c.sells1h ?? c.txns1h?.sells ?? 0;
  const totalTxns5m = buys5m + sells5m;
  const totalTxns1h = buys1h + sells1h;
  const buyRatio5m  = totalTxns5m > 0 ? buys5m / totalTxns5m : 0;
  const buyRatio1h  = totalTxns1h > 0 ? buys1h / totalTxns1h : 0;
  // Sell RATE per minute — exhaustion is when the recent sell rate falls below the hourly average.
  const sellRate5m  = sells5m / 5;
  const sellRate1h  = sells1h / 60;

  // ── tunables (config.flow.*, sensible defaults) ──────────────────────────────
  const minActivity  = f.minActivityTxns5m ?? 12;                 // real participation floor
  const minLiq       = f.minLiquidity      ?? (s.minLiquidity ?? 40_000);
  const minBuyRatio  = f.minBuyRatio5m     ?? 0.55;               // buyers in control right now
  const maxCrash5m   = f.maxCrash5mPct     ?? -8;                 // not free-falling this second
  const maxTrend6h   = f.maxTrend6hPct     ?? 120;               // reject parabolic/exhausted moves
  const maxTrend24h  = f.maxTrend24hPct    ?? 500;
  const maxRunUp     = f.maxRunUpFromLowPct ?? null;              // opt-in: reject an already-spent move
  const hotTrend6h   = f.hotTrend6hPct     ?? 70;                 // above this the move is getting extended
  // Rug-frenzy gate (OPT-IN, both must be set). Forensics on agent2's first 34 flow trades: all 3
  // rugs hit during a txn frenzy (~186 txns5m vs ~69 normal) on a recently-pumped token. This gate
  // rejects that pump+frenzy fingerprint. UNPROVEN / overfit-risk (n=3) — a forward experiment, not
  // a validated filter. Caught 2/3 rugs with 0 winner casualties in-sample. Disabled unless configured.
  const rugFrenzyTxns = f.rugFrenzyTxns5m ?? null;
  const rugFrenzyPc6h = f.rugFrenzyPc6h    ?? null;

  // ── hard gates ───────────────────────────────────────────────────────────────
  const gateFailures = [];
  const PLAUSIBLE = 500;
  if (!Number.isFinite(pc5m) || !Number.isFinite(pc6h) || Math.abs(pc5m) > PLAUSIBLE) {
    gateFailures.push(`implausible price data (5m ${pc5m}%) — corrupt candle`);
    return { score: 0, passed: false, pattern: null, breakdown: {}, gateFailures, buyPressure5m: buyRatio5m };
  }
  if (totalTxns5m < minActivity)          gateFailures.push(`flow too thin (${totalTxns5m} txns5m < ${minActivity}) — no real order flow`);
  if (liq < minLiq)                       gateFailures.push(`liquidity ${Math.round(liq/1000)}k < ${minLiq/1000}k`);
  if (buyRatio5m < minBuyRatio)           gateFailures.push(`buyers not in control (${(buyRatio5m*100).toFixed(0)}% < ${minBuyRatio*100}%)`);
  if (pc5m < maxCrash5m)                  gateFailures.push(`free-falling now (5m ${pc5m.toFixed(1)}% < ${maxCrash5m}%) — not accumulation`);
  if (pc6h > maxTrend6h)                  gateFailures.push(`parabolic 6h (+${pc6h.toFixed(0)}% > ${maxTrend6h}%) — move already spent`);
  if (pc24h > maxTrend24h)                gateFailures.push(`parabolic 24h (+${pc24h.toFixed(0)}% > ${maxTrend24h}%)`);
  if (maxRunUp != null && Number.isFinite(c.runUpFromLowPct) && c.runUpFromLowPct > maxRunUp)
                                          gateFailures.push(`already ran +${c.runUpFromLowPct.toFixed(1)}% off the low (> ${maxRunUp}%) — late`);
  if (rugFrenzyTxns != null && rugFrenzyPc6h != null && totalTxns5m > rugFrenzyTxns && pc6h > rugFrenzyPc6h)
                                          gateFailures.push(`rug-frenzy risk (${totalTxns5m} txns5m > ${rugFrenzyTxns} & 6h +${pc6h.toFixed(0)}% > ${rugFrenzyPc6h}%) — pump+frenzy rug pattern`);

  if (gateFailures.length) return { score: 0, passed: false, pattern: 'FLOW', breakdown: {}, gateFailures, buyPressure5m: buyRatio5m };

  // ── score (0-100): flow strength + acceleration + sell-exhaustion + participation ──
  const breakdown = {};

  // 1. Buy pressure NOW (0-25) — banded: one-sided extremes (>95%) are often a fake/exhausted rip.
  let bp; const r = buyRatio5m;
  if (r >= 0.95) bp = 14; else if (r >= 0.80) bp = 25; else if (r >= 0.68) bp = 20; else if (r >= 0.60) bp = 14; else bp = 8;
  breakdown.buyPressure = { value: +(r * 100).toFixed(0) + '%', points: bp };

  // 2. Buy-pressure ACCELERATION (0-30) — THE leading signal: buying rising vs the hour = fresh accumulation.
  const accel = buyRatio5m - buyRatio1h;
  let ap; if (accel >= 0.15) ap = 30; else if (accel >= 0.08) ap = 22; else if (accel >= 0.03) ap = 14; else if (accel > 0) ap = 7; else ap = 0;
  breakdown.acceleration = { value: +(accel * 100).toFixed(1) + 'pp', points: ap };

  // 3. Sell exhaustion (0-25) — recent sell rate below the hourly average = sellers drying up.
  let se; const ratio = sellRate1h > 0 ? sellRate5m / sellRate1h : 1;
  if (ratio <= 0.4) se = 25; else if (ratio <= 0.7) se = 17; else if (ratio <= 1.0) se = 9; else se = 0;
  breakdown.sellExhaustion = { value: 'sellRate ' + ratio.toFixed(2) + 'x', points: se };

  // 4. Participation (0-20) — real, active flow, not a couple of noise trades.
  let pt; if (vol5m >= 50_000 && totalTxns5m >= 40) pt = 20; else if (vol5m >= 15_000 && totalTxns5m >= 20) pt = 13; else if (totalTxns5m >= minActivity) pt = 7; else pt = 2;
  breakdown.participation = { vol5m: Math.round(vol5m), txns5m: totalTxns5m, points: pt };

  // 5. Overextension penalty (0..-15) — flow leads price; don't chase a move that's already extended.
  let ex = 0; if (pc6h > hotTrend6h) ex = -Math.min(15, Math.round((pc6h - hotTrend6h) / 5));
  breakdown.extension = { pc6h: +pc6h.toFixed(0), points: ex };

  const score = Math.max(0, Math.min(100, bp + ap + se + pt + ex));
  const pattern = accel >= 0.08 ? 'ACCUMULATION' : 'FLOW';
  return { score, passed: true, pattern, breakdown, gateFailures: [], buyPressure5m: buyRatio5m };
}

module.exports = { scoreFlow };

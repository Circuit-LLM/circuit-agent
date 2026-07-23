// lib/scoring-momentum.js — Trend-continuation scoring for circuit-agent (agent2 momentum test).
//
// OPPOSITE thesis to scoreDipReversal. The dip scorer buys beaten-down tokens hoping they bounce
// (mean-reversion) — agent2's own history says that's a loser: 84% of those entries never got
// even +2%, and the 5m-bounce gate had zero predictive power. This scorer instead only trades
// tokens that are ALREADY WINNING — a confirmed, HEALTHY (not parabolic) uptrend with real
// participation — and enters on continuation (a breakout, or a shallow pullback that's resuming).
//
// Grounded in agent2's backtest of its own 36 instrumented trades: the winners clustered in
// high-activity (txns5m ~27 vs 13 for dead picks), high-liquidity ($308k vs $111k), strong-24h
// (+47% vs +5%) names. Filtering to just "active + liquid" flipped that sample from -2.7% to
// +1.6% gross (8%→45% win). So activity + liquidity are hard floors here, not soft scores.
//
// Preserves the dip scorer's hard-won guards: reject parabolic/exhausted moves (their #1 historical
// loss driver — a +318%/6h token bought as a "dip" averaged -6%), the corrupt-candle guard, and the
// buy-ratio band (their data: 55-65% = 65% WR, >65% = 26% WR). Holder-concentration + rug checks are
// enforced upstream in the scanner and are unchanged.
//
// Same return shape as scoreDipReversal { score, passed, pattern, breakdown, gateFailures,
// buyPressure5m } so it's a drop-in the scanner can select via strategy.scorer.
'use strict';

function scoreMomentum(c, cfg) {
  const s = cfg?.strategy ?? {};
  const m = cfg?.momentum ?? {};

  const pc1m  = c.priceChange1m  ?? 0;
  const pc5m  = c.priceChange5m  ?? 0;
  const pc1h  = c.priceChange1h  ?? 0;
  const pc6h  = c.priceChange6h  ?? 0;
  const pc24h = c.priceChange24h ?? 0;
  const liq   = c.liquidity      ?? 0;
  const vol1h = c.volume1h       ?? 0;

  const buys5m  = c.buys5m  ?? c.txns5m?.buys  ?? 0;
  const sells5m = c.sells5m ?? c.txns5m?.sells ?? 0;
  const totalTxns5m = buys5m + sells5m;
  const buyRatio5m  = totalTxns5m > 0 ? buys5m / totalTxns5m : 0;

  // ── tunables (config.momentum.*, with sensible defaults) ─────────────────────
  const minTrend24h   = m.minTrend24hPct    ?? 20;      // must be a real daily winner
  const minTrend6h    = m.minTrend6hPct     ?? 0;       // 6h may pause but not be down hard
  const maxTrend6h    = m.maxTrend6hPct      ?? 150;    // reject parabolic/exhausted (their #1 loss driver)
  const maxTrend24h   = m.maxTrend24hPct     ?? 600;
  const maxPullback1h = m.maxPullback1hPct   ?? -8;     // allow a shallow pullback within the uptrend
  const maxShort5m    = m.maxShort5mDropPct  ?? -3;     // but not actively rolling over right now
  const minActivity   = m.minActivityTxns5m  ?? 15;     // backtest separator (winners ~27 vs dead 13)
  const minLiq        = m.minLiquidity       ?? (s.minLiquidity ?? 150_000); // backtest separator
  const minBuyRatio   = m.minBuyRatio5m      ?? 0.52;   // buyers in control
  const hotTrend6h    = m.hotTrend6hPct      ?? 60;     // above this the 6h move is getting extended
  const maxRunUp      = m.maxRunUpFromLowPct ?? null;   // opt-in "already ran" reject

  // ── hard gates — all must pass ───────────────────────────────────────────────
  const gateFailures = [];
  const PLAUSIBLE = 500; // momentum names move more than dips, but a corrupt candle still explodes
  if (!Number.isFinite(pc5m) || !Number.isFinite(pc1h) || !Number.isFinite(pc6h) ||
      Math.abs(pc5m) > PLAUSIBLE || Math.abs(pc1h) > PLAUSIBLE) {
    gateFailures.push(`implausible price data (5m ${pc5m}% 1h ${pc1h}%) — corrupt candle`);
    return { score: 0, passed: false, pattern: null, breakdown: {}, gateFailures, buyPressure5m: 0 };
  }
  // confirmed, healthy uptrend
  if (pc24h < minTrend24h)   gateFailures.push(`24h not a strong uptrend (${pc24h.toFixed(0)}% < ${minTrend24h}%)`);
  if (pc6h  < minTrend6h)    gateFailures.push(`6h fading (${pc6h.toFixed(0)}% < ${minTrend6h}%)`);
  if (pc1h  < maxPullback1h) gateFailures.push(`dumping now (1h ${pc1h.toFixed(0)}% < ${maxPullback1h}%)`);
  // not parabolic / exhausted (preserve the dip scorer's hardest lesson)
  if (pc6h  > maxTrend6h)     gateFailures.push(`parabolic 6h (+${pc6h.toFixed(0)}% > ${maxTrend6h}%) — blow-off risk`);
  if (pc24h > maxTrend24h)    gateFailures.push(`parabolic 24h (+${pc24h.toFixed(0)}% > ${maxTrend24h}%)`);
  if (maxRunUp != null && Number.isFinite(c.runUpFromLowPct) && c.runUpFromLowPct > maxRunUp)
    gateFailures.push(`ran +${c.runUpFromLowPct.toFixed(1)}% off the 20m low (> ${maxRunUp}%) — extended`);
  // real participation (the two proven separators)
  if (totalTxns5m < minActivity) gateFailures.push(`thin activity (${totalTxns5m} txns5m < ${minActivity}) — no real move`);
  if (liq < minLiq)              gateFailures.push(`liq $${(liq/1000).toFixed(0)}k < $${(minLiq/1000).toFixed(0)}k`);
  if (totalTxns5m > 3 && buyRatio5m < minBuyRatio)
    gateFailures.push(`buyers not in control (${(buyRatio5m*100).toFixed(0)}% < ${(minBuyRatio*100).toFixed(0)}%)`);
  // continuation, not rolling over: the short-term must not be collapsing
  if (pc5m < maxShort5m) gateFailures.push(`rolling over (5m ${pc5m.toFixed(1)}% < ${maxShort5m}%)`);
  // staleness
  const maxDataAgeSec = s.maxDataAgeSec ?? 600;
  if (Number.isFinite(c.dataAgeSec) && c.dataAgeSec > maxDataAgeSec)
    gateFailures.push(`stale data (last candle ${Math.round(c.dataAgeSec/60)}m old)`);

  if (gateFailures.length > 0) {
    return { score: 0, passed: false, pattern: null, breakdown: {}, gateFailures, buyPressure5m: buyRatio5m * 100 };
  }

  // ── scoring components (0-100) ───────────────────────────────────────────────
  const breakdown = {};
  let score = 0;

  // 1. Trend strength (0-25) — reward a healthy uptrend; taper once it gets extended.
  let trendPts;
  if      (pc24h >= 60 && pc6h > 0 && pc6h <= hotTrend6h) trendPts = 25;
  else if (pc24h >= 30 && pc6h > 0)                        trendPts = 20;
  else if (pc6h > hotTrend6h)                              trendPts = 12;  // strong but extended
  else                                                     trendPts = 14;
  breakdown.trend = { pc24h: +pc24h.toFixed(0), pc6h: +pc6h.toFixed(0), points: trendPts };
  score += trendPts;

  // 2. Continuation (0-20) — short-term still advancing (breakout) beats a deeper pullback.
  let contPts;
  if      (pc5m >= 1 && pc1m >= 0) contPts = 20;   // advancing on both short TFs
  else if (pc5m >= 0)              contPts = 15;    // holding at the highs
  else if (pc5m >= -1.5)           contPts = 10;    // shallow pullback, still constructive
  else                             contPts = 5;
  breakdown.continuation = { pc5m: +pc5m.toFixed(1), pc1m: +pc1m.toFixed(1), points: contPts };
  score += contPts;

  // 3. Activity (0-20) — more real trades = a more real move.
  let actPts;
  if      (totalTxns5m >= 60) actPts = 20;
  else if (totalTxns5m >= 30) actPts = 16;
  else if (totalTxns5m >= 20) actPts = 12;
  else                        actPts = 8;
  breakdown.activity = { txns5m: totalTxns5m, vol1h: +vol1h.toFixed(0), points: actPts };
  score += actPts;

  // 4. Buy pressure (0-15) — sweet band 55-70; extreme = you're the exit liquidity (their lesson).
  const bp = buyRatio5m * 100;
  let bpPts;
  if      (bp >= 55 && bp <= 70) bpPts = 15;
  else if (bp > 70 && bp <= 80)  bpPts = 9;
  else if (bp > 80)              bpPts = 4;
  else if (bp >= 52)             bpPts = 10;
  else                          bpPts = 4;
  breakdown.buyPressure = { value: +bp.toFixed(0), points: bpPts };
  score += bpPts;

  // 5. Liquidity (0-20) — the backtest's cleanest separator ($308k winners vs $111k dead).
  let liqPts;
  if      (liq >= 500_000) liqPts = 20;
  else if (liq >= 300_000) liqPts = 17;
  else if (liq >= 200_000) liqPts = 13;
  else if (liq >= 150_000) liqPts = 9;
  else                     liqPts = 4;
  breakdown.liquidity = { value: +liq.toFixed(0), points: liqPts };
  score += liqPts;

  score = Math.max(0, Math.min(100, score));

  // Pattern (for the scanner's patternFilter)
  let pattern;
  if      (pc1h < 0)   pattern = 'MOMENTUM-PULLBACK';   // shallow pullback in a strong uptrend
  else if (pc5m >= 2)  pattern = 'MOMENTUM-BREAKOUT';   // pushing to new highs
  else                 pattern = 'MOMENTUM';            // steady trend continuation

  return { score, passed: true, pattern, breakdown, gateFailures: [], buyPressure5m: bp };
}

module.exports = { scoreMomentum };

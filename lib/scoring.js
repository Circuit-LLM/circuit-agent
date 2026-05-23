// lib/scoring.js — Dip-reversal scoring for circuit-agent
// Battle-tested 6-component scorer. Score 0-100.
// Hard gates reject bad setups before scoring begins.
// Requires DexScreener 5m/1h/6h data — scan route now returns all fields.
'use strict';

/**
 * Score a scan candidate for dip-reversal entry.
 * @param {object} c     — candidate from /api/scan
 * @param {object} cfg   — agent config (reads strategy.minLiquidity)
 * @returns {{ score, passed, pattern, breakdown, gateFailures, buyPressure5m }}
 */
function scoreDipReversal(c, cfg) {
  const pc5m  = c.priceChange5m  ?? 0;
  const pc1h  = c.priceChange1h  ?? 0;
  const pc6h  = c.priceChange6h  ?? 0;
  const pc24h = c.priceChange24h ?? 0;
  const liq   = c.liquidity      ?? 0;
  const vol1h = c.volume1h       ?? 0;  // DexScreener has no volume5m; use 1h

  const buys5m  = c.buys5m  ?? 0;
  const sells5m = c.sells5m ?? 0;
  const buys1h  = c.buys1h  ?? 0;
  const sells1h = c.sells1h ?? 0;

  const totalTxns5m = buys5m + sells5m;
  const buyRatio5m  = totalTxns5m > 0 ? buys5m / totalTxns5m : 0;

  const totalTxns1h = buys1h + sells1h;
  const buyRatio1h  = totalTxns1h > 0 ? buys1h / totalTxns1h : 0;

  const minLiq = cfg?.strategy?.minLiquidity ?? 50_000;

  // ── Hard gates — all must pass ────────────────────────────────────────────
  const gateFailures = [];
  if (pc1h >= 0)                           gateFailures.push(`1h not negative (${pc1h.toFixed(1)}%)`);
  if (pc5m < 0.5)                          gateFailures.push(`5m bounce weak (${pc5m.toFixed(1)}% < 0.5%)`);
  if (totalTxns5m > 5 && buyRatio5m <= 0.50) gateFailures.push(`buy ratio low (${(buyRatio5m*100).toFixed(0)}%)`);
  if (liq < minLiq)                        gateFailures.push(`liq $${(liq/1000).toFixed(0)}k < $${(minLiq/1000).toFixed(0)}k`);
  if (pc6h <= -20 && pc24h <= -20)         gateFailures.push(`dead cat (6h ${pc6h.toFixed(0)}% 24h ${pc24h.toFixed(0)}%)`);

  if (gateFailures.length > 0) {
    return { score: 0, passed: false, pattern: null, breakdown: {}, gateFailures, buyPressure5m: buyRatio5m * 100 };
  }

  // ── Scoring components ────────────────────────────────────────────────────
  const breakdown = {};
  let score = 0;

  // 1. Drop depth (0-25 pts) — deeper dip = more room to bounce
  let dropPts;
  if (pc1h <= -10)     dropPts = 25;
  else if (pc1h <= -5) dropPts = 20;
  else if (pc1h <= -3) dropPts = 15;
  else                 dropPts = 5;
  breakdown.dropDepth = { value: +pc1h.toFixed(1), points: dropPts };
  score += dropPts;

  // 2. Bounce confirmation (0-20 pts)
  let bouncePts;
  if (pc5m >= 5)       bouncePts = 20;
  else if (pc5m >= 3)  bouncePts = 17;
  else if (pc5m >= 2)  bouncePts = 14;
  else if (pc5m >= 1)  bouncePts = 10;
  else                 bouncePts = 5;
  breakdown.bounce = { value: +pc5m.toFixed(1), points: bouncePts };
  score += bouncePts;

  // 3. Sentiment shift (0-15 pts) — buyers returning after selloff
  const sentimentShift = buyRatio5m - buyRatio1h;
  let sentPts;
  if (sentimentShift >= 0.10)      sentPts = 15;
  else if (sentimentShift >= 0.05) sentPts = 10;
  else if (sentimentShift >= 0.02) sentPts = 7;
  else if (sentimentShift > 0)     sentPts = 3;
  else                             sentPts = 0;
  breakdown.sentimentShift = { value: +sentimentShift.toFixed(2), points: sentPts };
  score += sentPts;

  // 4. Buy pressure (0-10 pts)
  const bp = buyRatio5m * 100;
  let bpPts;
  if (bp >= 65)       bpPts = 10;
  else if (bp >= 58)  bpPts = 8;
  else if (bp >= 53)  bpPts = 5;
  else                bpPts = 2;
  breakdown.buyPressure = { value: +bp.toFixed(0), points: bpPts };
  score += bpPts;

  // 5. Volume & activity (0-15 pts) — validates bounce is real
  let actPts;
  if (vol1h >= 100_000 && totalTxns1h >= 200)     actPts = 15;
  else if (vol1h >= 50_000 && totalTxns1h >= 100)  actPts = 12;
  else if (vol1h >= 20_000 && totalTxns1h >= 40)   actPts = 8;
  else if (vol1h >= 5_000  && totalTxns1h >= 10)   actPts = 4;
  else                                              actPts = 1;
  breakdown.activity = { vol1h: +vol1h.toFixed(0), txns1h: totalTxns1h, points: actPts };
  score += actPts;

  // 6. Trend alignment (-10 to +15 pts) — dip in uptrend vs dead cat
  let trendPts;
  if (pc6h > 0 && pc24h > 0)        trendPts = 15;
  else if (pc24h > 0)                trendPts = 10;
  else if (pc6h > 0)                 trendPts = 5;
  else {
    const avgHigherTF = (pc6h + pc24h) / 2;
    if (avgHigherTF <= -15)      trendPts = -10;
    else if (avgHigherTF <= -8)  trendPts = -7;
    else if (avgHigherTF <= -4)  trendPts = -5;
    else                         trendPts = -2;
  }
  breakdown.trendAlignment = { pc6h: +pc6h.toFixed(1), pc24h: +pc24h.toFixed(1), points: trendPts };
  score += trendPts;

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Pattern classification
  let pattern;
  if (pc1h < -10)     pattern = 'DEEP-REVERSAL';
  else if (pc1h < -5) pattern = 'REVERSAL';
  else if (pc1h < -3) pattern = 'DIP-BUY';
  else                pattern = 'SHALLOW-DIP';

  return { score, passed: true, pattern, breakdown, gateFailures: [], buyPressure5m: bp };
}

module.exports = { scoreDipReversal };

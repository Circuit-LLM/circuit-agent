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

  const buys5m  = c.buys5m  ?? c.txns5m?.buys  ?? 0;
  const sells5m = c.sells5m ?? c.txns5m?.sells ?? 0;
  const buys1h  = c.buys1h  ?? c.txns1h?.buys  ?? 0;
  const sells1h = c.sells1h ?? c.txns1h?.sells ?? 0;

  const totalTxns5m = buys5m + sells5m;
  const buyRatio5m  = totalTxns5m > 0 ? buys5m / totalTxns5m : 0;

  const totalTxns1h = buys1h + sells1h;
  const buyRatio1h  = totalTxns1h > 0 ? buys1h / totalTxns1h : 0;

  const minLiq = cfg?.strategy?.minLiquidity ?? 50_000;

  // ── Hard gates — all must pass ────────────────────────────────────────────
  const gateFailures = [];
  // Corrupt-data gate (source-agnostic): the price feed occasionally writes a bad OHLCV point
  // (e.g. a candle close of 280 for a $0.014 token), which makes the derived 5m/1h change
  // explode to thousands/millions of percent. Such a value maxes the bounce gate and the entry
  // score, so the agent "buys a huge bounce" that never happened, then bleeds out. A real
  // dip-reversal candidate never moves >200% on the 5m or 1h window — reject as bad data.
  const PLAUSIBLE_PCT = 200;
  if (!Number.isFinite(pc5m) || !Number.isFinite(pc1h) ||
      Math.abs(pc5m) > PLAUSIBLE_PCT || Math.abs(pc1h) > PLAUSIBLE_PCT) {
    gateFailures.push(`implausible price data (5m ${pc5m}% 1h ${pc1h}%) — corrupt candle`);
    return { score: 0, passed: false, pattern: null, breakdown: {}, gateFailures, buyPressure5m: 0 };
  }
  if (pc1h >= 0)                           gateFailures.push(`1h not negative (${pc1h.toFixed(1)}%)`);
  // Depth-scaled bounce gate: a deeper 1h drop (REVERSAL/DEEP-REVERSAL) is a falling knife
  // until proven otherwise. A 1% 5m tick on a thin pool is noise, not a reversal — require a
  // stronger, real bounce before catching a deep dip.
  const minBounce5m = pc1h <= -5 ? 3.0 : 1.5;
  if (pc5m < minBounce5m)                  gateFailures.push(`5m bounce weak (${pc5m.toFixed(1)}% < ${minBounce5m}%)`);
  // Bounce ceiling: a real dip-reversal entry catches the *start* of a turn (a modest bounce).
  // A +6%/+8% move in 5 min means the move already happened — we'd be chasing a spike and buying
  // the top, which on a thin pool reverts immediately. Reject bounces that are too large.
  // Tunable per agent (strategy.maxBounce5m).
  const maxBounce5m = cfg?.strategy?.maxBounce5m ?? 6;
  if (pc5m > maxBounce5m)                  gateFailures.push(`5m bounce too large (${pc5m.toFixed(1)}% > ${maxBounce5m}%) — chasing a spike, not a turn`);
  // Sustained-reversal gate: require the bounce to be HOLDING across candles (higher low +
  // advancing close — computed in scanFree), not a single-candle dead-cat spike. The v0.9.5
  // speed-up (5min→1min loop + sub-second feed) removed the implicit confirmation the slow
  // 5-min-lagged source provided, and win rate fell ~30%→8% when it shipped. This restores it.
  // Tunable per agent (strategy.requireSustainedBounce, default true).
  if (cfg?.strategy?.requireSustainedBounce !== false && c.sustainedBounce === false)
                                           gateFailures.push('bounce not sustained — single-candle spike, not a holding turn');
  // S2 — fresh-bounce gate (OPT-IN, default OFF). The 5m bounce spans ~10 min and is often
  // stale by fill; bounceFresh checks the turn is still advancing in the last 1m. Default off
  // so bounceFresh is first collected alongside outcomes (S4) to confirm it predicts winners
  // before it gates trades. Only applied when 1m data exists and recent activity is meaningful.
  // Tunable: strategy.requireFreshBounce.
  if (cfg?.strategy?.requireFreshBounce === true && c.bounceFresh === false &&
      totalTxns5m >= (cfg?.strategy?.minActivityTxns5m ?? 4))
                                           gateFailures.push('bounce not fresh — not advancing in last 1m');
  // Reversals must show buyers actually stepping back in, not a single green candle.
  if (pc1h <= -5 && totalTxns5m > 3 && buyRatio5m < 0.58)
                                           gateFailures.push(`reversal lacks buy pressure (${(buyRatio5m*100).toFixed(0)}% < 58%)`);
  if (totalTxns5m === 0)                   gateFailures.push('no 5m activity (stale data)');
  // Freshness gate: the %/txn signals are read from the last stored 5m candles. For a token that
  // has gone quiet, those candles are old and the "bounce" is a ghost of a move that ended minutes
  // ago (root cause of the "0.003% / 1-3 txns" reads that don't match live DexScreener). Reject
  // when the freshest candle is older than maxDataAgeSec. Conservative default (10 min) so only
  // clearly-dead tapes are dropped — a live dip-reversal always has a fresh candle.
  const maxDataAgeSec = cfg?.strategy?.maxDataAgeSec ?? 600;
  if (Number.isFinite(c.dataAgeSec) && c.dataAgeSec > maxDataAgeSec)
    gateFailures.push(`stale data (last candle ${Math.round(c.dataAgeSec / 60)}m old > ${Math.round(maxDataAgeSec / 60)}m)`);
  // Activity floor: the bounce % and buy ratio are computed from the recent 5m candles. With
  // only 1-2 trades, a "+8% bounce / 100% buy ratio" is thin-liquidity noise that reverts, not
  // a real reversal. Require a minimum recent trade count so those signals are meaningful.
  // Tunable per agent (strategy.minActivityTxns5m) — raise for stricter quality, lower for more
  // trades in thin markets. In a dead tape this is the main reason an entry is (correctly) skipped.
  const minActivityTxns = cfg?.strategy?.minActivityTxns5m ?? 4;
  if (totalTxns5m > 0 && totalTxns5m < minActivityTxns)
                                           gateFailures.push(`insufficient activity (${totalTxns5m} txns < ${minActivityTxns}) — signal not meaningful`);
  if (totalTxns5m > 5 && buyRatio5m <= 0.50) gateFailures.push(`buy ratio low (${(buyRatio5m*100).toFixed(0)}%)`);
  if (liq < minLiq)                        gateFailures.push(`liq $${(liq/1000).toFixed(0)}k < $${(minLiq/1000).toFixed(0)}k`);
  if (pc6h <= -20 && pc24h <= -20)         gateFailures.push(`dead cat (6h ${pc6h.toFixed(0)}% 24h ${pc24h.toFixed(0)}%)`);
  // Deep dips on thin pools can blow through stops. Require a minimum liquidity for 1h drops
  // >10% (DEEP-REVERSAL territory). Configurable per group so low-liquidity experiment tiers
  // can access deep reversals — the reliable rug filter + LP-drain guard are the safety net there.
  const deepDipMinLiq = cfg?.strategy?.deepDipMinLiquidityUsd ?? 50_000;
  if (pc1h < -10 && liq < deepDipMinLiq)  gateFailures.push(`deep-dip thin pool (1h ${pc1h.toFixed(0)}% liq $${(liq/1000).toFixed(0)}k < $${(deepDipMinLiq/1000).toFixed(0)}k)`);
  // Pump gate: a token up parabolically over 6h/24h is not dipping — the small 1h "dip" is the
  // first leg of a blow-off top. These were the dominant loss driver (a +318%/6h token bought as
  // a SHALLOW-DIP averaged −6%). Reject them outright. Tunable per agent.
  const maxEntry6hGain  = cfg?.strategy?.maxEntry6hGainPct  ?? 80;
  const maxEntry24hGain = cfg?.strategy?.maxEntry24hGainPct ?? 150;
  if (pc6h > maxEntry6hGain)
    gateFailures.push(`parabolic 6h (+${pc6h.toFixed(0)}% > ${maxEntry6hGain}%) — buying a pump, not a dip`);
  if (pc24h > maxEntry24hGain)
    gateFailures.push(`parabolic 24h (+${pc24h.toFixed(0)}% > ${maxEntry24hGain}%) — buying a pump, not a dip`);

  if (gateFailures.length > 0) {
    return { score: 0, passed: false, pattern: null, breakdown: {}, gateFailures, buyPressure5m: buyRatio5m * 100 };
  }

  // ── Scoring components ────────────────────────────────────────────────────
  const breakdown = {};
  let score = 0;

  // 1. Drop depth (0-25 pts) — a moderate dip is the sweet spot. The deepest drops are
  //    falling knives that tend to keep falling, so they no longer earn the most points
  //    (this previously pushed the most dangerous setups into the highest score bucket).
  let dropPts;
  if (pc1h <= -3 && pc1h > -8) dropPts = 25;   // sweet spot: real dip with room to bounce
  else if (pc1h <= -8)         dropPts = 12;   // deep = falling-knife risk, reduced reward
  else                         dropPts = 8;    // shallow (0 to -3): little room to recover
  breakdown.dropDepth = { value: +pc1h.toFixed(1), points: dropPts };
  score += dropPts;

  // 2. Bounce confirmation (0-20 pts)
  // A real dip-reversal entry catches the *start* of a turn — a modest, fresh bounce. A large
  // 5m bounce means the move mostly already happened; on thin memecoins that's an exhausted
  // dead-cat that reverts. Trade-data analysis (40-trade window) showed higher entryScore
  // correlated with WORSE outcomes, and this component — which previously rewarded bigger
  // bounces most — was the dominant driver of that inversion. 'modest' (default) rewards the
  // sweet-spot turn and penalises chasing; 'magnitude' restores the legacy bigger-is-better
  // curve for A/B comparison. Tunable: strategy.bounceScoreMode.
  const bounceMode = cfg?.strategy?.bounceScoreMode ?? 'modest';
  let bouncePts;
  if (bounceMode === 'magnitude') {
    if (pc5m >= 5)       bouncePts = 20;
    else if (pc5m >= 3)  bouncePts = 17;
    else if (pc5m >= 2)  bouncePts = 14;
    else if (pc5m >= 1)  bouncePts = 10;
    else                 bouncePts = 5;
  } else {
    // modest: peak reward for a fresh 1.5–3% turn; larger bounces = chasing the exhaust
    if      (pc5m >= 1.5 && pc5m <= 3) bouncePts = 20;
    else if (pc5m > 3 && pc5m <= 4)    bouncePts = 14;
    else if (pc5m > 4)                 bouncePts = 8;   // move likely already spent
    else if (pc5m >= 1)                bouncePts = 12;
    else                               bouncePts = 5;
  }
  breakdown.bounce = { value: +pc5m.toFixed(1), points: bouncePts, mode: bounceMode };
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
  // Buy pressure and bounce confirmation both read from the 5m window. To prevent a single
  // strong 5m candle from awarding points twice, cap buy-pressure to its floor value when
  // the bounce is already strong (pc5m >= 3%) — the signal is already captured by component 2.
  const bp = buyRatio5m * 100;
  let bpPts;
  if (pc5m >= 3) {
    // Bounce component already rewards strong 5m moves — give only a small floor here
    bpPts = bp >= 53 ? 3 : 1;
  } else if (bp >= 65)      bpPts = 10;
  else if (bp >= 58)        bpPts = 8;
  else if (bp >= 53)        bpPts = 5;
  else                      bpPts = 2;
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

  // 6. Trend alignment (-10 to +15 pts) — a dip in a *healthy* uptrend has a thesis; a dip in a
  //    *parabolic* run is the blow-off top beginning to dump. Reward moderate uptrends, but scale
  //    the reward down once the 6h move gets extended — this previously gave the full +15 to a
  //    +318%/6h pump, steering the swarm straight into tops. Tunable: strategy.hotTrend6hPct.
  const hotTrend6h = cfg?.strategy?.hotTrend6hPct ?? 40;
  let trendPts;
  if (pc6h > 0 && pc24h > 0)        trendPts = pc6h <= hotTrend6h ? 15 : 6;   // healthy vs extended
  else if (pc24h > 0)                trendPts = 10;
  else if (pc6h > 0)                 trendPts = pc6h <= hotTrend6h ? 5 : 0;
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

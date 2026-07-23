// lib/scoring-smartmoney.js — Smart-money ACCUMULATION scoring (agent2 experiment).
//
// A different KIND of edge than the price-pattern scorers (dip/momentum): instead of scoring
// a candle shape, we score WHO is buying. Input = Circuit's x402 token-top-traders data. We
// look for tokens that track-record wallets (smart_money / dev tags) are NET-ACCUMULATING, and
// reject tokens dominated by snipers/bundlers distributing to retail (the #1 memecoin loss trap).
//
// Tags can overlap (a wallet may be smart_money AND sniper), so tags only IDENTIFY quality wallets;
// actual net buy-vs-sell VOLUME decides whether they're accumulating right now. Cumulative volumes
// are an imperfect proxy for "buying now" — the paper run validates whether the signal separates.
'use strict';

const SMART_TAGS = new Set(['smart_money', 'dev']);        // quality / informed wallets
const DUMP_TAGS  = new Set(['sniper', 'bundler']);         // distribution-prone

// Per-trader net flow. `buying` = net USD in AND not more sell-trades than buys.
// `dumping` = clearly distributing (many more sells, or sold more USD than bought).
function traderFlow(t) {
  const bV = +(t.volumeBuyUsd ?? 0), sV = +(t.volumeSellUsd ?? 0);
  const bN = +(t.tradesBuy ?? 0), sN = +(t.tradesSell ?? 0);
  const usdNet = bV - sV;
  return { usdNet, buying: usdNet > 0 && bN >= sN, dumping: sN > bN * 3 || sV > bV * 2 };
}

/**
 * @param {Array}  traders  — token-top-traders rows ({tags, tradesBuy/Sell, volumeBuy/SellUsd})
 * @param {object} cand     — trending candidate (liquidity, signalScore, priceChange24h…)
 * @param {object} cfg      — config (strategy.smartMoney.*)
 * @returns {{score, passed, pattern, accumulation, gateFailures, reason}}
 */
function scoreSmartMoney(traders, cand = {}, cfg = {}) {
  const sm = cfg.smartMoney ?? {};
  const minSmartBuyers = sm.minSmartBuyers ?? 1;
  const minNetUsd      = sm.minNetUsd      ?? 1000;
  const maxSniperRatio = sm.maxSniperRatio ?? 0.7;
  const requireNetAcc  = sm.requireNetAccumulation ?? true;

  traders = Array.isArray(traders) ? traders : [];
  if (!traders.length) return { score: 0, passed: false, pattern: 'SMART-MONEY', accumulation: null, gateFailures: ['no trader data'], reason: 'no trader data' };

  let smartBuyers = 0, smartDumpers = 0, smartNetUsd = 0, snipers = 0, anyBuyers = 0, anyDumpers = 0;
  for (const t of traders) {
    const tags = t.tags || [];
    const isSmart = tags.some(x => SMART_TAGS.has(x));
    const isDump  = tags.some(x => DUMP_TAGS.has(x));
    if (isDump) snipers++;
    const f = traderFlow(t);
    if (f.buying) anyBuyers++;
    if (f.dumping) anyDumpers++;
    if (isSmart) { smartNetUsd += f.usdNet; if (f.buying) smartBuyers++; if (f.dumping) smartDumpers++; }
  }
  const nTraders = traders.length;
  const sniperRatio = nTraders ? snipers / nTraders : 1;
  const acc = { nTraders, smartBuyers, smartDumpers, smartNetUsd: Math.round(smartNetUsd), snipers, sniperRatio: +sniperRatio.toFixed(2), anyBuyers, anyDumpers };

  // ── gates (all must pass to enter) ──
  const gateFailures = [];
  if (smartBuyers < minSmartBuyers) gateFailures.push(`smart buyers ${smartBuyers} < ${minSmartBuyers}`);
  if (requireNetAcc && smartBuyers <= smartDumpers) gateFailures.push(`not net-accumulating (buy ${smartBuyers} <= dump ${smartDumpers})`);
  if (smartNetUsd < minNetUsd) gateFailures.push(`smart net $${Math.round(smartNetUsd)} < $${minNetUsd}`);
  if (sniperRatio > maxSniperRatio) gateFailures.push(`sniper-dominated ${(sniperRatio * 100).toFixed(0)}% > ${maxSniperRatio * 100}%`);
  const passed = gateFailures.length === 0;

  // ── score 0..100 (ranking among passers) ──
  const usdPts   = Math.min(40, Math.max(0, Math.log10(Math.max(1, smartNetUsd)) * 8));   // $1k≈24 $10k≈32 $100k≈40
  const buyerPts = Math.min(24, Math.max(0, (smartBuyers - smartDumpers)) * 8);
  const cleanPts = (1 - sniperRatio) * 20;                                                 // fewer snipers = cleaner
  const trendPts = Math.min(16, Math.max(0, (+cand.signalScore || 0) / 100 * 16));
  const score = Math.round(Math.max(0, Math.min(100, usdPts + buyerPts + cleanPts + trendPts)));

  const reason = passed
    ? `${smartBuyers} smart buyer(s), $${Math.round(smartNetUsd).toLocaleString()} net in, ${(sniperRatio * 100).toFixed(0)}% snipers`
    : gateFailures[0];
  return { score, passed, pattern: 'SMART-MONEY', accumulation: acc, gateFailures, reason };
}

module.exports = { scoreSmartMoney };

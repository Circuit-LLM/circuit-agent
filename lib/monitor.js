// lib/monitor.js — Autonomous position monitor for circuit-agent
// Runs every positionCheckMs (default 10s).
// Checks open positions against stop-loss, take-profit, trailing stop, max hold time.
// Auto-sells when triggered.
//
// Price resolution order (per tick):
//   1. circuit-price-feed  — reserve-based, sub-second (Triton gRPC → Redis)
//   2. DexScreener REST    — last-trade price, free fallback
//   3. x402 /api/token-prices — paid fallback after 3 consecutive DexScreener failures
'use strict';

const positions                           = require('./positions');
const { reinvestProfit }                  = require('./circuit-reinvest');
const { loadIdentity }                    = require('./profile');
const { loadConfig }                      = require('./config');
const { acquireSellLock, releaseSellLock } = require('./trade-lock');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [MON] [${level.toUpperCase()}] ${line}\n`);
};

// ── Check one position and exit if rules trigger ──────────────────────────────

async function checkPosition(mint, pos, currentPrice, swap, wallet, cfg, notify, api, forceReason = null) {
  const s = cfg.strategy ?? {};
  const stopLossPct      = s.stopLossPct             ?? -6;
  const takeProfitPct    = s.takeProfitPct            ?? 12;
  const maxHoldMinutes   = s.maxHoldMinutes           ?? 45;
  const trailingActivate = s.trailingStopActivatePct  ?? 4;
  const trailingDistance = s.trailingStopDistancePct  ?? 3;

  // Allow forced exits (e.g. swarm rug alert) even when price data is unavailable.
  // A rug alert on a token with no live price is the most critical case — never skip it.
  if (!currentPrice && !forceReason) {
    log('warn', 'Price unavailable — skipping', { symbol: pos.symbol });
    return;
  }
  // Guard against Infinity from DexScreener returning the literal string "Infinity".
  // NaN is already caught by the !currentPrice check above (NaN is falsy); Infinity is truthy.
  if (currentPrice != null && !isFinite(currentPrice)) {
    log('warn', 'Non-finite price received — skipping', { symbol: pos.symbol, price: currentPrice });
    return;
  }

  // Re-read position from disk so P&L calculations use the current cost basis.
  // If a partial sell ran updateTokenAmount() between tick()'s getAll() snapshot
  // and this call, the passed-in `pos` has stale solSpent — using it would produce
  // wrong P&L and could trigger a false stop-loss.
  const livePos = positions.get(mint);
  if (!livePos) {
    log('warn', 'Position already closed before P&L check — skipping', { symbol: pos.symbol });
    return;
  }

  // Compute P&L in SOL terms:
  //   priceNative = SOL per 1 UI token (decimal-adjusted)
  //   tokenAmount = raw atomic units → divide by 10^decimals to get UI amount
  const decimals     = livePos.tokenDecimals ?? 6;
  const uiAmount     = Number(BigInt(livePos.tokenAmount)) / Math.pow(10, decimals);
  const currentSolValue = currentPrice * uiAmount;
  const pnlPct  = ((currentSolValue - livePos.solSpent) / livePos.solSpent) * 100;
  const pnlSol  = currentSolValue - livePos.solSpent;
  const holdMin = positions.holdMinutes(livePos);

  // Record P&L sample for dead-money detection before peak/trail calculations.
  _recordPnlSample(mint, pnlPct);

  // Update peak in-memory — avoids disk write races between concurrent ticks.
  // Flushed to positions.json only when the sell lock is held (on actual exits).
  const cachedPeak = _peakCache.get(mint) ?? livePos.peakPnlPct ?? 0;
  if (pnlPct > cachedPeak) _peakCache.set(mint, pnlPct);
  const peak = Math.max(pnlPct, cachedPeak);

  // Trailing stop threshold (only active once peak >= trailingActivate)
  const trailingThreshold = peak >= trailingActivate ? peak - trailingDistance : null;

  log('info', `${livePos.symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | peak ${peak.toFixed(1)}% | ${holdMin.toFixed(0)}min`);

  // Determine exit reason (priority: stop-loss > trailing-stop > take-profit > max-hold)
  // Trailing-stop is checked before take-profit so it locks in gains naturally.
  // Take-profit is a safety ceiling — CIRC reinvestment fires on any profitable exit.
  // minHoldBeforeTpMinutes: TP is suppressed for this many minutes after entry to prevent
  // phantom exits caused by DexScreener price / actual swap-price mismatch right after buying.
  const minHoldBeforeTp = s.minHoldBeforeTpMinutes ?? 3;
  let reason = null;
  if (pnlPct <= stopLossPct) {
    reason = 'stop-loss';
  } else if (trailingThreshold !== null && pnlPct <= trailingThreshold) {
    reason = 'trailing-stop';
  } else if (pnlPct >= takeProfitPct && holdMin >= minHoldBeforeTp) {
    reason = 'take-profit';
  } else if (_isDeadMoney(mint, holdMin, s)) {
    reason = 'dead-money';
  } else if (holdMin >= maxHoldMinutes) {
    reason = 'max-hold';
  }

  if (forceReason) reason = forceReason;
  if (!reason) {
    _tpConfirm.delete(mint); // price normalized — clear any pending confirmation
    return;
  }

  // Take-profit confirmation gate: require 2 consecutive ticks above threshold
  // before acting. Stop-loss and trailing-stop are exempt — fast exit is critical.
  if (reason === 'take-profit' && !forceReason) {
    const count = (_tpConfirm.get(mint) ?? 0) + 1;
    if (count < 2) {
      _tpConfirm.set(mint, count);
      log('info', `${livePos.symbol} take-profit at ${pnlPct.toFixed(1)}% — confirming (${count}/2)`);
      return;
    }
    _tpConfirm.delete(mint);
  } else {
    _tpConfirm.delete(mint);
  }

  // Rate-limit backoff: skip this cycle if a recent sell failed
  if (!_sellCooledDown(mint)) {
    const waitSec = Math.round((Math.min(30_000 * Math.pow(2, (_sellFailCount[mint] ?? 1) - 1), 120_000) - (Date.now() - (_sellFailAt[mint] ?? 0))) / 1000);
    log('info', `${livePos.symbol} ${reason} — waiting ${waitSec}s after sell failure`);
    return;
  }

  // Block concurrent sells on the same mint — monitor ticks overlap (setInterval
  // doesn't await async callbacks) and the LLM sell_token tool can fire at the same
  // time. Both would pass positions.get() since closePosition() hasn't run yet.
  // acquireSellLock is shared with tools/trading.js so both paths are covered.
  if (!acquireSellLock(mint)) {
    log('info', `${livePos.symbol} sell already in flight — skipping tick`);
    return;
  }

  // Flush in-memory peak to disk now that we hold the sell lock (no concurrent writer)
  const cachedPeakFlush = _peakCache.get(mint);
  if (cachedPeakFlush != null && cachedPeakFlush > (livePos.peakPnlPct ?? 0)) {
    positions.updatePeak(mint, cachedPeakFlush);
  }

  log('info', `Exiting ${livePos.symbol} — ${reason}`, { pnl: pnlPct.toFixed(1) + '%' });

  // Re-read one more time immediately before the on-chain sell — the LLM tool path
  // (sell_token) or the swarm-exit branch may have closed this position in the
  // milliseconds since livePos was loaded above.
  const preSwapPos = positions.get(mint);
  if (!preSwapPos) {
    releaseSellLock(mint);
    log('warn', `Position ${livePos.symbol} closed between P&L check and sell — skipping`, { reason });
    return;
  }

  try {
    // Use live on-chain balance so any dust accumulated from prior partial sells
    // is included. Falls back to the stored positions.json amount if the RPC call fails.
    let rawAmount;
    try {
      const liveBal = await swap.getTokenBalance(mint);
      rawAmount = liveBal.rawAmount > 0n ? Number(liveBal.rawAmount) : Number(BigInt(preSwapPos.tokenAmount));
    } catch {
      rawAmount = Number(BigInt(preSwapPos.tokenAmount));
    }

    // Pre-sell slippage gate for take-profit only.
    // Phantom TPs happen when DexScreener shows a stale post-buy price spike
    // while the pool has already reverted. The circuit-price-feed uses reserve-
    // based pricing which is more accurate, but as a final safety check we ask
    // the price feed to estimate actual SOL out from the pool before we sell.
    // If the estimated proceeds are less than cost basis, the price is a phantom
    // spike — skip this tick and let it resolve naturally.
    if (reason === 'take-profit' && !forceReason && _feedBase) {
      try {
        const slipResp = await fetch(
          `${_feedBase}/slippage/${mint}?tokenAmount=${rawAmount}&decimals=${livePos.tokenDecimals ?? 6}`,
          { signal: AbortSignal.timeout(3_000) },
        );
        if (slipResp.ok) {
          const { estimatedSolOut } = await slipResp.json();
          if (estimatedSolOut !== null && estimatedSolOut < livePos.solSpent) {
            log('info', `${livePos.symbol} TP slippage gate: est ${estimatedSolOut.toFixed(4)} SOL < cost ${livePos.solSpent.toFixed(4)} — phantom spike, deferring`, { pnlPct: pnlPct.toFixed(1) });
            _tpConfirm.delete(mint);
            return;
          }
        }
      } catch (slipErr) {
        log('warn', `${livePos.symbol} slippage check failed — proceeding with TP`, { error: slipErr.message });
      }
    }

    // Try full sell first, then fall back to partial chunks if Jupiter can't
    // route the full position in one swap (low-cap tokens with shallow pools).
    let result;
    let soldPct = 1; // track what fraction was actually sold (for correct pnlSol)
    const PARTIAL_PCTS = [1, 0.5, 0.25];
    for (const pct of PARTIAL_PCTS) {
      try {
        result = await swap.sell(mint, rawAmount, pct);
        soldPct = pct;
        if (pct < 1) log('info', `Partial sell succeeded at ${(pct*100).toFixed(0)}%`, { symbol: preSwapPos.symbol });
        break;
      } catch (e) {
        const isLiquidityErr = e.message.includes('Insufficient funds') ||
          e.message.includes('Too large') || e.message.toLowerCase().includes('liquidity');
        if (!isLiquidityErr || pct === PARTIAL_PCTS[PARTIAL_PCTS.length - 1]) throw e;
        log('warn', `Full sell failed (${e.message.slice(0,40)}), retrying at ${(PARTIAL_PCTS[PARTIAL_PCTS.indexOf(pct)+1]*100).toFixed(0)}%`, { symbol: preSwapPos.symbol });
      }
    }

    _clearSellFail(mint);

    if (soldPct < 1) {
      // Partial sell — Jupiter couldn't route the full position in one swap.
      // Keep the position open with the remaining token amount so the monitor
      // continues tracking and will retry the exit on the next tick.
      // updateTokenAmount proportionally reduces solSpent so cost basis stays correct.
      const soldRaw   = Math.floor(rawAmount * soldPct);
      const remaining = rawAmount - soldRaw;
      positions.updateTokenAmount(mint, remaining);
      const sign = result.solReceived >= 0 ? '+' : '';
      notify(
        `⚠️ *${preSwapPos.symbol}* partial exit (${(soldPct*100).toFixed(0)}% sold — liquidity limited)\n` +
        `Received: ${result.solReceived.toFixed(4)} SOL | Retrying remainder next tick`
      );
      log('info', 'Partial exit — position kept open for remainder', { symbol: preSwapPos.symbol, soldPct: (soldPct*100).toFixed(0)+'%', remaining });
      _tpConfirm.delete(mint); // reset so next partial-sell attempt requires fresh 2-tick confirmation
      releaseSellLock(mint); // partial exit keeps position open — allow next tick to retry
      return;
    }

    _tpConfirm.delete(mint);  // clear stale confirmation state so a re-entry starts fresh
    _peakCache.delete(mint);  // position closed — discard cached peak
    _pnlHistory.delete(mint); // discard trajectory — position closed
    const costBasis    = preSwapPos.solSpent;
    const realisedPnlSol = result.solReceived - costBasis;
    const realisedPnlPct = costBasis > 0 ? (realisedPnlSol / costBasis) * 100 : 0;
    const exitData = {
      exitPrice:   currentPrice,
      exitTime:    new Date().toISOString(),
      solReceived: result.solReceived,
      pnlSol:      realisedPnlSol,
      pnlPct:      realisedPnlPct,
      reason,
      txSig:       result.txSig,
    };
    // closePosition handles trade logging internally — do not call logClosedTrade separately
    positions.closePosition(mint, exitData);

    const sign = realisedPnlPct >= 0 ? '+' : '';
    const icon = realisedPnlPct >= 0 ? '🟢' : '🔴';
    notify(
      `${icon} *${preSwapPos.symbol}* exited (${reason})\n` +
      `P&L: ${sign}${realisedPnlPct.toFixed(1)}% / ${sign}${realisedPnlSol.toFixed(4)} SOL\n` +
      `Held: ${holdMin.toFixed(0)}min | Peak: +${peak.toFixed(1)}%`
    );
    log('info', 'Position closed', { symbol: preSwapPos.symbol, reason, pnl: realisedPnlPct.toFixed(1) + '%', sol: result.solReceived.toFixed(4) });

    // Report outcome + sell signal to swarm — skipped in paper mode so paper P&L
    // doesn't corrupt real agent reputation scores or trigger live agent exits.
    if (!swap?.paperMode) {
      _reportSwarmOutcome(api, mint, preSwapPos.symbol, realisedPnlPct, realisedPnlSol, holdMin, cfg)
        .catch(e => log('warn', 'Swarm outcome report failed', { error: e.message }));
      _broadcastSellSignal(api, mint, preSwapPos.symbol, realisedPnlPct, reason, cfg)
        .catch(() => {});
    }

    // Reinvest a slice of profit into CIRCUIT — skipped in paper mode (no real profits)
    if (realisedPnlSol > 0 && !swap?.paperMode) {
      reinvestProfit({ pnlSol: realisedPnlSol, symbol: preSwapPos.symbol, swap, wallet, cfg, notify })
        .catch(e => log('warn', 'Reinvest error', { error: e.message }));
    }
    releaseSellLock(mint);
  } catch (err) {
    releaseSellLock(mint);
    _recordSellFail(mint);
    const backoffSec = Math.min(30 * Math.pow(2, (_sellFailCount[mint] ?? 1) - 1), 120);
    log('error', `Sell failed — backing off ${backoffSec}s`, { symbol: preSwapPos.symbol, error: err.message });
    notify(`⚠️ *${preSwapPos.symbol}* sell failed (${reason}):\n${err.message}`);
  }
}

// ── Swarm signal detection ────────────────────────────────────────────────────
// Returns sell signals and rug alerts separately — they require different responses.
// sell_signal: exit only when already approaching our own stop-loss floor.
// rug_alert:   exit immediately regardless of P&L — a rug can happen in minutes and
//              waiting for the 60-minute heartbeat LLM escalation is not reliable.
// Uses the internal key bypass (free, no CIRCUIT cost) since we're on localhost.

async function _getSwarmSignals(mints, cfg, api) {
  if (!mints.length || !cfg.swarm?.enabled) {
    return { sellSignals: new Set(), rugAlerts: new Set() };
  }
  try {
    // Fetch all recent signals in one call — filter client-side by type
    const { signals = [] } = await api.swarmFeedFree({ limit: 100 });
    const cutoff   = Date.now() - 10 * 60_000;
    const identity = loadIdentity();
    // Minimum reputation threshold — a new zero-rep agent can otherwise trigger
    // immediate rug-alert exits or premature sell-signal exits on held positions.
    // Unknown reputation (null/undefined) is treated as 0 — filtered out.
    const minRep   = cfg.swarm?.minReputationToFollow ?? 40;
    const relevant = signals.filter(s =>
      s.mint &&
      mints.includes(s.mint) &&
      new Date(s.publishedAt).getTime() > cutoff &&
      s.agentId !== identity.agentId &&
      s.address !== identity.address &&
      (s.reputation ?? 0) >= minRep
    );
    return {
      sellSignals: new Set(relevant.filter(s => s.type === 'sell_signal').map(s => s.mint)),
      rugAlerts:   new Set(relevant.filter(s => s.type === 'rug_alert').map(s => s.mint)),
    };
  } catch { return { sellSignals: new Set(), rugAlerts: new Set() }; }
}

// ── Swarm outcome reporting ───────────────────────────────────────────────────

async function _reportSwarmOutcome(api, mint, symbol, pnlPct, pnlSol, holdMinutes, cfg) {
  const identity = loadIdentity();
  if (!identity.agentId && !identity.address) return;

  await api.swarmOutcome({
    agentId:  identity.agentId,
    address:  identity.address,
    mint, symbol, pnlPct, pnlSol, holdMinutes,
    verdict:  pnlPct > 0 ? 'win' : 'loss',
  });
  log('info', `Swarm outcome reported: ${symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
}

// ── Broadcast sell signal for coordinated exit ────────────────────────────────

async function _broadcastSellSignal(api, mint, symbol, pnlPct, reason, cfg) {
  if (!cfg.swarm?.autoPublish) return;
  const identity = loadIdentity();
  if (!identity.agentId && !identity.address) return;

  await api.swarmPublish({
    agentId:    identity.agentId,
    address:    identity.address,
    type:       'sell_signal',
    mint, symbol,
    confidence: pnlPct > 0 ? 0.9 : 0.7,
    data:       { pnlPct: +pnlPct.toFixed(2), reason },
  });
}

// ── Take-profit confirmation gate ─────────────────────────────────────────────
// Requires 2 consecutive ticks above the TP threshold before firing.
// Prevents exits on single bad DexScreener data points (which caused phantom
// 7000-8000% P&L readings that immediately triggered take-profit at a loss).
const _tpConfirm  = new Map(); // mint → consecutive TP-trigger count
const _peakCache  = new Map(); // mint → peak pnlPct (in-memory; avoids concurrent-tick disk races on updatePeak)

// ── Dead-money detection ───────────────────────────────────────────────────────
// Records per-tick P&L samples. If the position has been flat within
// ±deadMoneyRangePct for deadMoneyMinutes, exit early rather than waiting for
// max-hold. Genuine reversals move within the first 10-15 minutes; a position
// that hasn't broken out of a tight band is occupying a slot without purpose.
const _pnlHistory         = new Map(); // mint → [{ts, pnl}]
const DEAD_MONEY_HIST_CAP = 200;       // ~33 min of samples at 10s ticks

function _recordPnlSample(mint, pnl) {
  const samples = _pnlHistory.get(mint) ?? [];
  samples.push({ ts: Date.now(), pnl });
  if (samples.length > DEAD_MONEY_HIST_CAP) samples.shift();
  _pnlHistory.set(mint, samples);
}

// Returns true when all P&L samples in the last deadMoneyMinutes fall within
// the flat band. Requires a minimum number of samples to avoid false triggers
// on positions that are too new for the window to be meaningful.
function _isDeadMoney(mint, holdMin, s) {
  const deadMinutes = s.deadMoneyMinutes        ?? 15;
  const deadRange   = s.deadMoneyRangePct       ?? 1.5;
  const minHold     = s.deadMoneyMinHoldMinutes ?? 8;
  if (holdMin < minHold) return false;
  const cutoff    = Date.now() - deadMinutes * 60_000;
  const window    = (_pnlHistory.get(mint) ?? []).filter(e => e.ts >= cutoff);
  // Expect at least one sample every ~20s; require half the expected count
  // so a temporarily stale data source doesn't prevent the exit.
  const minNeeded = Math.floor((deadMinutes * 60) / 20);
  if (window.length < minNeeded) return false;
  return window.every(e => e.pnl >= -deadRange && e.pnl <= deadRange);
}

// ── Sell-fail backoff ─────────────────────────────────────────────────────────
// Tracks per-mint sell failure timestamps. After a failed sell we wait an
// increasing cooldown before retrying — prevents hammering Jupiter with 429s
// every 10s cycle when rate-limited.
const _sellFailAt    = {};  // mint → last failure timestamp (ms)
const _sellFailCount = {};  // mint → consecutive failure count

function _sellCooledDown(mint) {
  const count = _sellFailCount[mint] ?? 0;
  if (!count) return true;
  // Exponential backoff: 30s, 60s, 120s, 120s max
  const waitMs = Math.min(30_000 * Math.pow(2, count - 1), 120_000);
  return Date.now() - (_sellFailAt[mint] ?? 0) >= waitMs;
}

function _recordSellFail(mint) {
  _sellFailAt[mint]    = Date.now();
  _sellFailCount[mint] = (_sellFailCount[mint] ?? 0) + 1;
}

function _clearSellFail(mint) {
  delete _sellFailAt[mint];
  delete _sellFailCount[mint];
}

// ── LP-drain reserve tracking ─────────────────────────────────────────────────
// Maps mint → [{ts, solReserve, priceSol}, ...] capped at _MAX_RESERVE_HIST entries.
// Only populated from circuit-price-feed (DexScreener has no reserve data).
//
// Detection logic:
//   In a constant-product AMM, removing liquidity drains BOTH sides proportionally
//   leaving price unchanged. Selling tokens moves reserves in opposite directions
//   and causes a large price drop. So: large solReserve drop + flat price = LP drain.
//
// Pump.fun bonding curves have no removable LP — reserve drops there are organic sells.
// CLMM / Orca pools use sqrtPrice not raw reserves — excluded (solReserve stays null).

const _reserveHist    = new Map(); // mint → [{ts, solReserve, priceSol}]
const _MAX_RESERVE_HIST = 10;      // ~100s of history at default 10s tick

const LP_DRAIN_RESERVE_DROP = 0.15; // 15% SOL reserve drop triggers check
const LP_DRAIN_PRICE_CAP    = 0.08; // if price also dropped >8% it's a sell, not drain
const LP_DRAIN_WINDOW_MS    = 90_000;

function _updateReserveHist(mint, solReserve, priceSol) {
  if (solReserve == null) return;
  const hist = _reserveHist.get(mint) ?? [];
  hist.push({ ts: Date.now(), solReserve, priceSol });
  if (hist.length > _MAX_RESERVE_HIST) hist.shift();
  _reserveHist.set(mint, hist);
}

// Returns true when the pool's SOL side has drained >15% while price stayed flat.
// Uses the oldest sample still within LP_DRAIN_WINDOW_MS as reference point.
function _isLpDrain(mint, source) {
  // Pump.fun: virtual reserves drop on sells — not LP drain. CLMM/Orca: no raw reserves.
  if (!source || source.includes('pump') || source.includes('clmm') || source.includes('whirlpool')) return false;
  const hist = _reserveHist.get(mint);
  if (!hist || hist.length < 3) return false;

  const newest  = hist[hist.length - 1];
  const cutoff  = newest.ts - LP_DRAIN_WINDOW_MS;
  // Find the earliest sample still within the window that had more SOL than now
  const ref = hist.find(h => h.ts >= cutoff && h.solReserve > newest.solReserve);
  if (!ref) return false;

  const reserveDrop = (ref.solReserve - newest.solReserve) / ref.solReserve;
  if (reserveDrop < LP_DRAIN_RESERVE_DROP) return false;

  // A large sell also reduces pcReserve — but constant-product means it also tanks price.
  // If price dropped >= LP_DRAIN_PRICE_CAP it's selling pressure; stop-loss handles it.
  if (ref.priceSol > 0 && newest.priceSol > 0) {
    const priceDrop = (ref.priceSol - newest.priceSol) / ref.priceSol;
    if (priceDrop > LP_DRAIN_PRICE_CAP) return false;
  }

  return true;
}

// ── circuit-price-feed (primary) ──────────────────────────────────────────────
// Reserve-based SOL prices from Triton gRPC → Redis. Set by start() from config.
// URL scheme: /prices?mints=... and /slippage/:mint?tokenAmount=N&decimals=D
// Same paths whether pointing to localhost:18941 or api.circuitllm.xyz/api/price-feed.

let _feedBase = null; // set in start()

function _deriveFeedBase(cfg) {
  if (process.env.PRICE_FEED_URL) return process.env.PRICE_FEED_URL;
  if (cfg.priceFeedUrl)           return cfg.priceFeedUrl;
  const base = cfg.api?.baseUrl ?? 'https://api.circuitllm.xyz';
  // Same-VPS agents point at localhost:18960 — use circuit-price-feed directly
  if (base.includes('localhost') || base.includes('127.0.0.1')) {
    return 'http://127.0.0.1:18941';
  }
  return `${base}/api/price-feed`;
}

async function _fetchPriceFeedPrices(mints) {
  if (!mints.length || !_feedBase) return { priceMap: {}, feedData: {} };
  const url  = `${_feedBase}/prices?mints=${mints.join(',')}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  if (!resp.ok) throw new Error(`price-feed ${resp.status}`);
  const data = await resp.json();
  const raw  = data.results ?? {};
  const priceMap = {};
  const feedData = {}; // reserve + source per mint — for LP drain tracking
  for (const mint of mints) {
    const r = raw[mint];
    if (r?.priceSol > 0) {
      priceMap[mint] = { priceNative: r.priceSol, usdPrice: null };
      feedData[mint] = { priceSol: r.priceSol, solReserve: r.solReserve ?? null, source: r.source ?? null };
    }
  }
  return { priceMap, feedData };
}

// ── DexScreener price fetch (fallback) ───────────────────────────────────────
// Last-trade price. Used when price-feed misses a mint (unindexed pool, Pump.fun).
// Also provides USD price for display.

const DEXSCREENER_BASE = 'https://api.dexscreener.com/tokens/v1/solana';
const WSOL_MINT        = 'So11111111111111111111111111111111111111112';

// Extract SOL/USD price from the WSOL pairs returned in the same DexScreener batch.
function _extractSolPriceUsd(pairs) {
  const wsolPairs = pairs.filter(p =>
    p.baseToken?.address === WSOL_MINT &&
    (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT')
  );
  if (!wsolPairs.length) return null;
  const best = wsolPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return parseFloat(best.priceNative) || null;
}

async function _fetchDexscreenerPrices(mints) {
  if (!mints.length) return {};
  // Always include WSOL so we can derive the SOL/USD price from the same response
  // and use it to convert non-SOL pair prices to SOL-denominated values.
  const mintsWithWsol = [...new Set([...mints, WSOL_MINT])];
  const url  = `${DEXSCREENER_BASE}/${mintsWithWsol.join(',')}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) throw new Error(`DexScreener ${resp.status}`);
  const pairs = await resp.json(); // flat array of all pairs for all requested mints
  if (!Array.isArray(pairs)) throw new Error('Unexpected DexScreener response shape');

  // SOL/USD price extracted from the same batch — used to convert USDC pair prices.
  const solPriceUsd = _extractSolPriceUsd(pairs);

  const priceMap = {};
  for (const mint of mints) {
    const tokenPairs = pairs.filter(p => p.baseToken?.address === mint);
    if (!tokenPairs.length) continue;

    const solPairs = tokenPairs.filter(p => p.quoteToken?.address === WSOL_MINT);
    if (solPairs.length) {
      // SOL-quoted pair: priceNative is already SOL/token — use directly.
      const best = solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      priceMap[mint] = {
        priceNative: parseFloat(best.priceNative) || null,
        usdPrice:    parseFloat(best.priceUsd)    || null,
      };
    } else {
      // Non-SOL pair (USDC/USDT): priceNative is USD, not SOL. Convert using the
      // live SOL price fetched in the same batch request. If SOL price is unavailable
      // for any reason, return null so the monitor skips this tick safely rather than
      // using a USD value as SOL and producing phantom 7000%+ P&L readings.
      const best     = tokenPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const usdPrice = parseFloat(best.priceUsd) || null;
      priceMap[mint] = {
        priceNative: (usdPrice && solPriceUsd) ? usdPrice / solPriceUsd : null,
        usdPrice,
      };
    }
  }
  return priceMap;
}

// ── Start monitor loop ────────────────────────────────────────────────────────

// DexScreener consecutive failure counter — x402 fallback only after 3+ failures
// to avoid spending CIRCUIT on every transient DexScreener rate-limit (429/503).
let _dexFailCount = 0;
const DEX_FAIL_THRESHOLD = 3;

// Per-mint consecutive price-skip counter.
// When a token's price is unavailable for PRICE_STALE_THRESHOLD consecutive ticks
// (~5 min at 10s interval), force an emergency exit. This catches rugged/delisted tokens
// that stop appearing in DexScreener — without this, positions sit indefinitely at -57%+.
const _priceSkipCount = new Map();
const PRICE_STALE_THRESHOLD = 30;

function start(cfg, agentCtx, telegramBot = null) {
  const { api, swap, wallet } = agentCtx;
  const intervalMs = cfg.strategy?.positionCheckMs ?? 10_000; // default 10s (was 30s)
  const chatId = cfg.telegram?.heartbeatChatId ?? null;

  const notify = (msg) => {
    log('info', `[notify] ${msg.replace(/\*/g, '').replace(/\n/g, ' | ').slice(0, 120)}`);
    if (telegramBot && chatId) {
      telegramBot.api?.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
        .catch(() => telegramBot.api?.sendMessage(chatId, msg).catch(() => {}));
    }
  };

  _feedBase = _deriveFeedBase(cfg);
  log('info', `Position monitor started — checking every ${intervalMs / 1000}s | price feed: ${_feedBase}`);

  const tick = async () => {
    // Re-read config each tick so dashboard changes (stop-loss %, take-profit %,
    // trailing stop, max-hold, etc.) take effect without an agent restart.
    const cfg = loadConfig();
    const held  = positions.getAll();
    const mints = Object.keys(held);
    if (!mints.length) return;

    // ── 1. Try circuit-price-feed (reserve-based, Triton gRPC → Redis) ──────
    let priceMap = {};
    let feedData = {}; // solReserve + source per mint — only from price-feed
    let feedSource = 'price-feed';
    let feedMisses = [];
    if (_feedBase) {
      try {
        const feedResult = await _fetchPriceFeedPrices(mints);
        priceMap    = feedResult.priceMap;
        feedData    = feedResult.feedData;
        feedMisses  = mints.filter(m => !priceMap[m]);
        log('info', `Prices fetched (price-feed) for ${Object.keys(priceMap).length}/${mints.length} position(s)${feedMisses.length ? ` — ${feedMisses.length} miss(es) → DexScreener` : ''}`);
      } catch (feedErr) {
        feedMisses = mints;
        log('warn', `Price feed error — falling back to DexScreener`, { error: feedErr.message });
      }
    } else {
      feedMisses = mints;
    }

    // Update per-mint reserve history from price-feed data (DexScreener has no reserves).
    for (const [mint, fd] of Object.entries(feedData)) {
      _updateReserveHist(mint, fd.solReserve, fd.priceSol);
    }

    // ── 2. DexScreener for any misses (unindexed pools, Pump.fun, feed down) ─
    if (feedMisses.length) {
      try {
        const dexMap = await _fetchDexscreenerPrices(feedMisses);
        Object.assign(priceMap, dexMap);
        _dexFailCount = 0;
        feedSource = Object.keys(priceMap).length > feedMisses.length ? 'mixed' : 'dexscreener';
        log('info', `Prices fetched (DexScreener) for ${Object.keys(dexMap).length}/${feedMisses.length} miss(es)`);
      } catch (dexErr) {
        _dexFailCount++;
        if (_dexFailCount >= DEX_FAIL_THRESHOLD) {
          // ── 3. x402 fallback after repeated DexScreener failures ──────────
          log('warn', `DexScreener failed ${_dexFailCount}x — trying x402 fallback`, { error: dexErr.message });
          try {
            const result = await api.tokenPrices(feedMisses);
            const raw = result.prices ?? {};
            const x402Map = Object.fromEntries(
              Object.entries(raw).map(([mint, p]) => [
                mint,
                { priceNative: p.price ?? p.nativePrice ?? null, usdPrice: p.priceUsd ?? p.usdPrice ?? null },
              ])
            );
            Object.assign(priceMap, x402Map);
            log('info', `Prices fetched (x402 fallback) for ${Object.keys(x402Map).length}/${feedMisses.length} position(s)`);
          } catch (err) {
            if (!Object.keys(priceMap).length) {
              log('warn', 'All price sources failed — skipping monitor cycle', { error: err.message });
              return;
            }
            log('warn', 'x402 fallback failed — continuing with partial prices from feed', { error: err.message });
          }
        } else {
          if (!Object.keys(priceMap).length) {
            log('warn', `DexScreener failed (${_dexFailCount}/${DEX_FAIL_THRESHOLD}) and no feed prices — skipping cycle`, { error: dexErr.message });
            return;
          }
          log('warn', `DexScreener failed (${_dexFailCount}/${DEX_FAIL_THRESHOLD}) — continuing with price-feed prices`, { error: dexErr.message });
        }
      }
    }

    // Coordinated exit: check swarm for sell signals and rug alerts on our held mints
    const { sellSignals: swarmSellMints, rugAlerts: swarmRugAlerts } = await _getSwarmSignals(mints, cfg, api);

    for (const mint of mints) {
      const pos = positions.get(mint);
      if (!pos) continue;
      // entryPrice is SOL per 1 UI token — same unit as priceNative / priceSol from price-feed.
      // Never fall back to usdPrice: mixing USD price into a SOL formula produces
      // ~64x inflated P&L readings that trigger phantom take-profit exits.
      const priceData    = priceMap[mint];
      const currentPrice = priceData?.priceNative ?? null;

      // Rug alert — exit immediately regardless of P&L, but first re-verify with RugCheck.
      // Coordinated low-reputation agents could otherwise force exits on good positions.
      // Uses the free RugCheck endpoint (no CIRCUIT cost) since this is a one-off check.
      // Conservative: if RugCheck is unavailable, trust the swarm alert and exit anyway.
      if (swarmRugAlerts.has(mint)) {
        log('warn', `Swarm rug alert: ${pos.symbol} — verifying with RugCheck`, { mint: mint.slice(0, 8) });
        let exitConfirmed = true; // default: exit if RugCheck is unreachable
        try {
          const rugInfo    = await api.tokenInfoFree(mint);
          const rugVerdict = (rugInfo.risk?.verdict ?? rugInfo.verdict ?? rugInfo.rugRisk ?? 'unknown').toUpperCase();
          if (rugVerdict !== 'DANGER') {
            log('warn', `Swarm rug_alert discrepancy: ${pos.symbol} swarm says rug but RugCheck=${rugVerdict} — skipping exit`, { mint: mint.slice(0, 8) });
            notify(`⚠️ *${pos.symbol}* swarm rug alert not confirmed by RugCheck (${rugVerdict}) — holding`);
            exitConfirmed = false;
          } else {
            log('warn', `Swarm rug_alert confirmed by RugCheck: ${pos.symbol} — exiting`, { mint: mint.slice(0, 8) });
          }
        } catch {
          log('warn', `Swarm rug_alert on ${pos.symbol} — RugCheck unavailable, proceeding with exit`, { mint: mint.slice(0, 8) });
        }
        if (!exitConfirmed) continue;
        notify(`🚨 *${pos.symbol}* swarm rug alert confirmed — exiting immediately`);
        try {
          await checkPosition(mint, pos, currentPrice, swap, wallet, cfg, notify, api, 'swarm-rug');
        } catch (err) {
          log('error', 'Swarm-rug exit error', { mint: mint.slice(0, 8), error: err.message });
        }
        continue;
      }

      // LP drain: pool's SOL liquidity has drained >15% while price stayed flat.
      // This is the rug signature for AMM pools — devs remove LP silently before dumping.
      // Acts immediately like a rug alert (no confirmation required).
      const feedInfo = feedData[mint];
      if (feedInfo?.solReserve != null && _isLpDrain(mint, feedInfo.source)) {
        const hist = _reserveHist.get(mint) ?? [];
        const oldest = hist.find(h => h.ts >= Date.now() - LP_DRAIN_WINDOW_MS);
        const dropPct = oldest ? (((oldest.solReserve - feedInfo.solReserve) / oldest.solReserve) * 100).toFixed(1) : '?';
        log('warn', `${pos.symbol} LP drain detected (${dropPct}% SOL reserve drop, price flat) — exiting`, {
          source: feedInfo.source, solReserve: feedInfo.solReserve.toFixed(2),
        });
        notify(`🚨 *${pos.symbol}* LP drain detected (${dropPct}% SOL reserve drop) — emergency exit`);
        try {
          await checkPosition(mint, pos, currentPrice, swap, wallet, cfg, notify, api, 'lp-drain');
        } catch (err) {
          log('error', 'LP-drain exit failed', { mint: mint.slice(0, 8), error: err.message });
        }
        continue;
      }

      // If peer agents are selling this mint, consider an early exit — but only when
      // we are already approaching our own stop-loss (>= 50% of the way there).
      // Exiting on any negative P&L would let a single hallucinated sell signal
      // prematurely close positions that would have recovered.
      if (swarmSellMints.has(mint)) {
        const stopLossPct     = cfg.strategy?.stopLossPct ?? -6;
        const swarmExitFloor  = stopLossPct * 0.5;  // e.g. -3% when stop-loss is -6%
        const decimals        = pos.tokenDecimals ?? 6;
        const uiAmt           = Number(BigInt(pos.tokenAmount)) / Math.pow(10, decimals);
        const currentSolValue = (currentPrice ?? 0) * uiAmt;
        const pnlPct          = pos.solSpent ? ((currentSolValue - pos.solSpent) / pos.solSpent) * 100 : 0;
        if (pnlPct <= swarmExitFloor) {
          log('info', `Swarm sell signal: ${pos.symbol} at ${pnlPct.toFixed(1)}% (floor ${swarmExitFloor.toFixed(1)}%) — exiting early`, { pnlPct: pnlPct.toFixed(1) });
          try {
            await checkPosition(mint, pos, currentPrice, swap, wallet, cfg, notify, api, 'swarm-exit');
          } catch (err) {
            log('error', 'Swarm-exit error', { mint: mint.slice(0, 8), error: err.message });
          }
          continue;
        }
      }

      // Track consecutive ticks with no price data for this mint.
      // Tokens that rug or get delisted disappear from DexScreener — the monitor
      // would skip them indefinitely, allowing positions to sit for 13+ hours at -57%.
      // After PRICE_STALE_THRESHOLD consecutive skips, force an emergency exit.
      if (currentPrice === null) {
        const skipCount = (_priceSkipCount.get(mint) ?? 0) + 1;
        _priceSkipCount.set(mint, skipCount);
        if (skipCount >= PRICE_STALE_THRESHOLD) {
          log('warn', `${pos.symbol} price stale ${skipCount} ticks — emergency exit`, { mint: mint.slice(0, 8) });
          notify(`⚠️ *${pos.symbol}* no price data ${skipCount} ticks (~${Math.round(skipCount * intervalMs / 60000)}min) — emergency exit`);
          try {
            await checkPosition(mint, pos, null, swap, wallet, cfg, notify, api, 'price-stale');
          } catch (err) {
            log('error', 'Emergency price-stale exit failed', { symbol: pos.symbol, error: err.message });
          }
        }
        continue;
      } else {
        _priceSkipCount.delete(mint);
      }

      try {
        await checkPosition(mint, pos, currentPrice, swap, wallet, cfg, notify, api);
      } catch (err) {
        log('error', 'Monitor error', { mint: mint.slice(0, 8), error: err.message });
      }
    }

    // Sweep caches for mints no longer in open positions — happens when the LLM
    // sell_token tool closes a position outside the monitor's checkPosition path.
    for (const m of _peakCache.keys()) {
      if (!held[m]) { _peakCache.delete(m); _tpConfirm.delete(m); _pnlHistory.delete(m); }
    }
  };

  // First check after 15s, then on interval
  setTimeout(tick, 15_000);
  setInterval(tick, intervalMs);
}

module.exports = { start };

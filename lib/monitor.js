// lib/monitor.js — Autonomous position monitor for circuit-agent
// Runs every positionCheckMs (default 10s).
// Checks open positions against stop-loss, take-profit, trailing stop, max hold time.
// Auto-sells when triggered. Prices fetched via DexScreener REST (free, no CIRCUIT cost).
'use strict';

const positions          = require('./positions');
const { reinvestProfit } = require('./circuit-reinvest');
const { loadIdentity }   = require('./profile');

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

  if (!currentPrice) {
    log('warn', 'Price unavailable — skipping', { symbol: pos.symbol });
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

  // Update peak for trailing stop calculation
  if (pnlPct > livePos.peakPnlPct) positions.updatePeak(mint, pnlPct);
  const peak = Math.max(pnlPct, livePos.peakPnlPct);

  // Trailing stop threshold (only active once peak >= trailingActivate)
  const trailingThreshold = peak >= trailingActivate ? peak - trailingDistance : null;

  log('info', `${livePos.symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | peak ${peak.toFixed(1)}% | ${holdMin.toFixed(0)}min`);

  // Determine exit reason (priority order: stop-loss > take-profit > trailing > max-hold)
  let reason = null;
  if (pnlPct <= stopLossPct) {
    reason = 'stop-loss';
  } else if (pnlPct >= takeProfitPct) {
    reason = 'take-profit';
  } else if (trailingThreshold !== null && pnlPct <= trailingThreshold) {
    reason = 'trailing-stop';
  } else if (holdMin >= maxHoldMinutes) {
    reason = 'max-hold';
  }

  if (forceReason) reason = forceReason;
  if (!reason) return;

  // Rate-limit backoff: skip this cycle if a recent sell failed
  if (!_sellCooledDown(mint)) {
    const waitSec = Math.round((Math.min(30_000 * Math.pow(2, (_sellFailCount[mint] ?? 1) - 1), 120_000) - (Date.now() - (_sellFailAt[mint] ?? 0))) / 1000);
    log('info', `${livePos.symbol} ${reason} — waiting ${waitSec}s after sell failure`);
    return;
  }

  log('info', `Exiting ${livePos.symbol} — ${reason}`, { pnl: pnlPct.toFixed(1) + '%' });

  // Re-read one more time immediately before the on-chain sell — the LLM tool path
  // (sell_token) or the swarm-exit branch may have closed this position in the
  // milliseconds since livePos was loaded above.
  const preSwapPos = positions.get(mint);
  if (!preSwapPos) {
    log('warn', `Position ${livePos.symbol} closed between P&L check and sell — skipping`, { reason });
    return;
  }

  try {
    const rawAmount = Number(BigInt(preSwapPos.tokenAmount));

    // Try full sell first, then fall back to partial chunks if Jupiter can't
    // route the full position in one swap (low-cap tokens with shallow pools).
    let result;
    const PARTIAL_PCTS = [1, 0.5, 0.25];
    let lastErr;
    for (const pct of PARTIAL_PCTS) {
      try {
        result = await swap.sell(mint, rawAmount, pct);
        if (pct < 1) log('info', `Partial sell succeeded at ${(pct*100).toFixed(0)}%`, { symbol: preSwapPos.symbol });
        break;
      } catch (e) {
        lastErr = e;
        const isLiquidityErr = e.message.includes('Insufficient funds') || e.message.includes('unexpected');
        if (!isLiquidityErr || pct === PARTIAL_PCTS[PARTIAL_PCTS.length - 1]) throw e;
        log('warn', `Full sell failed (${e.message.slice(0,40)}), retrying at ${(PARTIAL_PCTS[PARTIAL_PCTS.indexOf(pct)+1]*100).toFixed(0)}%`, { symbol: preSwapPos.symbol });
      }
    }

    _clearSellFail(mint);
    const realisedPnlSol = result.solReceived - preSwapPos.solSpent;
    // Use actual SOL-based P&L percentage, not the pre-swap price estimate.
    // pnlPct (price-based) can show e.g. +7800% for a pumped token even when
    // the swap actually received less SOL than was spent (due to slippage/routing).
    const realisedPnlPct = preSwapPos.solSpent > 0
      ? (realisedPnlSol / preSwapPos.solSpent) * 100
      : 0;
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
  } catch (err) {
    _recordSellFail(mint);
    const backoffSec = Math.min(30 * Math.pow(2, (_sellFailCount[mint] ?? 1) - 1), 120);
    log('error', `Sell failed — backing off ${backoffSec}s`, { symbol: preSwapPos.symbol, error: err.message });
    notify(`⚠️ *${preSwapPos.symbol}* sell failed (${reason}):\n${err.message}`);
  }
}

// ── Swarm sell signal detection ───────────────────────────────────────────────
// Returns Set of mints where peer agents have recently published sell signals.
// Uses the internal key bypass (free, no CIRCUIT cost) since we're on localhost.

async function _getSwarmSellSignals(mints, cfg, api) {
  if (!mints.length || !cfg.swarm?.enabled) return new Set();
  try {
    const { signals = [] } = await api.swarmFeedFree({ type: 'sell_signal', limit: 50 });
    const cutoff   = Date.now() - 10 * 60_000;
    // Filter out this agent's own signals — after closing a position we broadcast a sell
    // signal that would otherwise be picked up on the very next tick for any re-entered mint.
    const identity = loadIdentity();
    return new Set(
      signals
        .filter(s =>
          s.mint &&
          mints.includes(s.mint) &&
          new Date(s.publishedAt).getTime() > cutoff &&
          s.agentId  !== identity.agentId &&
          s.address  !== identity.address
        )
        .map(s => s.mint)
    );
  } catch { return new Set(); }
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

// ── DexScreener price fetch (free, no CIRCUIT) ──────────────────────────────────
// Fetches priceNative (SOL per token) for a batch of mints.
// Falls back to x402 /api/token-prices on error.

const DEXSCREENER_BASE = 'https://api.dexscreener.com/tokens/v1/solana';

async function _fetchDexscreenerPrices(mints) {
  if (!mints.length) return {};
  const url  = `${DEXSCREENER_BASE}/${mints.join(',')}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) throw new Error(`DexScreener ${resp.status}`);
  const pairs = await resp.json(); // flat array of all pairs for all requested mints
  if (!Array.isArray(pairs)) throw new Error('Unexpected DexScreener response shape');

  const priceMap = {};
  for (const mint of mints) {
    const tokenPairs = pairs.filter(p => p.baseToken?.address === mint);
    if (!tokenPairs.length) continue;
    // Use highest-liquidity pair for the most reliable price
    const best = tokenPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    priceMap[mint] = {
      priceNative: parseFloat(best.priceNative) || null,
      usdPrice:    parseFloat(best.priceUsd)    || null,
    };
  }
  return priceMap;
}

// ── Start monitor loop ────────────────────────────────────────────────────────

// DexScreener consecutive failure counter — x402 fallback only after 3+ failures
// to avoid spending CIRCUIT on every transient DexScreener rate-limit (429/503).
let _dexFailCount = 0;
const DEX_FAIL_THRESHOLD = 3;

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

  log('info', `Position monitor started — checking every ${intervalMs / 1000}s (prices via DexScreener, x402 fallback)`);

  const tick = async () => {
    const held  = positions.getAll();
    const mints = Object.keys(held);
    if (!mints.length) return;

    // Fetch prices via DexScreener (free). Only escalate to x402 after DEX_FAIL_THRESHOLD
    // consecutive DexScreener failures — avoids burning CIRCUIT on every transient 429/503.
    let priceMap = {};
    try {
      priceMap = await _fetchDexscreenerPrices(mints);
      _dexFailCount = 0; // reset on success
      log('info', `Prices fetched (DexScreener) for ${mints.length} position(s)`);
    } catch (dexErr) {
      _dexFailCount++;
      if (_dexFailCount >= DEX_FAIL_THRESHOLD) {
        log('warn', `DexScreener failed ${_dexFailCount}x — trying x402 fallback`, { error: dexErr.message });
        try {
          const result = await api.tokenPrices(mints);
          // Normalise x402 response: API returns nativePrice, but the rest of
          // this function reads priceNative (matching DexScreener's field name).
          const raw = result.prices ?? {};
          priceMap = Object.fromEntries(
            Object.entries(raw).map(([mint, p]) => [
              mint,
              { priceNative: p.nativePrice ?? null, usdPrice: p.usdPrice ?? null },
            ])
          );
          log('info', `Prices fetched (x402 fallback) for ${mints.length} position(s)`);
        } catch (err) {
          log('warn', 'All price sources failed — skipping monitor cycle', { error: err.message });
          return;
        }
      } else {
        log('warn', `DexScreener failed (${_dexFailCount}/${DEX_FAIL_THRESHOLD} before x402 fallback) — skipping cycle`, { error: dexErr.message });
        return;
      }
    }

    // Coordinated exit: check swarm for sell signals on our held mints
    // If a peer agent exited a token we hold, treat it as an early warning
    const swarmSellMints = await _getSwarmSellSignals(mints, cfg, api);

    for (const mint of mints) {
      const pos = positions.get(mint);
      if (!pos) continue;
      // entryPrice is SOL/token — use priceNative (SOL/token from DexScreener) for P&L.
      // Fall back to usdPrice only if priceNative is unavailable.
      const priceData    = priceMap[mint];
      const currentPrice = priceData?.priceNative ?? priceData?.usdPrice ?? null;

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

      try {
        await checkPosition(mint, pos, currentPrice, swap, wallet, cfg, notify, api);
      } catch (err) {
        log('error', 'Monitor error', { mint: mint.slice(0, 8), error: err.message });
      }
    }
  };

  // First check after 15s, then on interval
  setTimeout(tick, 15_000);
  setInterval(tick, intervalMs);
}

module.exports = { start };

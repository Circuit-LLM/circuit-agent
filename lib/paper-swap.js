// lib/paper-swap.js — Paper trading swap executor.
//
// Simulates buy/sell using real prices with 1% slippage.
// No on-chain execution. Virtual SOL balance tracked in memory.
// Drop-in replacement for SwapExecutor — same interface, zero real money.
//
// Positions opened in paper mode carry txSig: 'PAPER_<id>' so they are
// identifiable in trade history and the reflect cycle can tag them.
'use strict';

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [PAPER] [${level.toUpperCase()}] ${line}\n`);
};

class PaperSwapExecutor {
  /**
   * @param {object} opts
   *   initialSolBalance {number} — starting virtual SOL (default from config)
   */
  constructor(opts = {}) {
    this.paperMode          = true;
    this.virtualSolBalance  = opts.initialSolBalance ?? 1.0;
    this._priceCache        = new Map(); // mint → { price, ts }
    log('info', `Paper trading initialized`, { virtualSol: this.virtualSolBalance.toFixed(4) });
  }

  // ── Buy ───────────────────────────────────────────────────────────────────

  async buy(mint, solAmount) {
    const price = await this._getPrice(mint);
    if (!price || price <= 0) throw new Error(`Paper: no price data for ${mint.slice(0, 8)}`);

    const slippage     = 0.01;                        // 1% simulated slippage
    const effectiveSol = solAmount * (1 - slippage);
    const uiTokens     = effectiveSol / price;
    // Store as raw atomic units (6 decimals assumed for paper mode) matching real SwapExecutor.
    // The real executor returns a string of raw atomic units; paper must match exactly or
    // monitor.js will divide by 10^decimals and produce a uiAmount that is 1e6x wrong.
    const rawTokens    = String(Math.floor(uiTokens * 1e6));

    this.virtualSolBalance = Math.max(0, this.virtualSolBalance - solAmount);

    const txSig = 'PAPER_' + Date.now().toString(36).toUpperCase();
    log('info', 'Paper buy', { mint: mint.slice(0, 8), sol: solAmount.toFixed(4), tokens: uiTokens.toFixed(2), txSig });
    return { txSig, inAmount: solAmount, outAmount: rawTokens, priceImpactPct: slippage * 100 };
  }

  // ── Sell ──────────────────────────────────────────────────────────────────

  async sell(mint, tokenAmount, pct = 1) {
    const price = await this._getPrice(mint);
    if (!price || price <= 0) throw new Error(`Paper: no price data for ${mint.slice(0, 8)}`);

    // tokenAmount is raw atomic units (string or number) — convert to UI amount for pricing.
    const rawAmount    = Number(BigInt(String(tokenAmount)));
    const uiAmount     = rawAmount / 1e6;
    const actualTokens = uiAmount * pct;
    const slippage     = 0.01;
    const solReceived  = actualTokens * price * (1 - slippage);

    this.virtualSolBalance += solReceived;

    const txSig = 'PAPER_' + Date.now().toString(36).toUpperCase();
    log('info', 'Paper sell', { mint: mint.slice(0, 8), tokens: actualTokens.toFixed(2), sol: solReceived.toFixed(4), txSig });
    // solReceived mirrors the field name monitor.js expects (same as real SwapExecutor)
    return { txSig, inAmount: actualTokens, outAmount: solReceived, solReceived };
  }

  // ── Token balance (reads from positions.js — no on-chain call needed) ─────

  async getTokenBalance(mint) {
    const positions = require('./positions');
    const pos = positions.get(mint);
    if (!pos) return { rawAmount: BigInt(0), amount: '0', uiAmount: 0, decimals: 6 };
    const dec = pos.tokenDecimals ?? 6;
    return {
      rawAmount: BigInt(pos.tokenAmount ?? 0),
      amount:    pos.tokenAmount,
      uiAmount:  Number(pos.tokenAmount) / Math.pow(10, dec),
      decimals:  dec,
    };
  }

  // ── Price fetch (circuit-price-feed, 30s cache) ──────────────────────────

  async _getPrice(mint) {
    const cached = this._priceCache.get(mint);
    if (cached && Date.now() - cached.ts < 30_000) return cached.price;

    try {
      const r = await fetch(
        `http://127.0.0.1:18941/price/${mint}`,
        { signal: AbortSignal.timeout(5_000) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      const price = d?.priceSol ?? null;
      if (price && price > 0) this._priceCache.set(mint, { price, ts: Date.now() });
      return price ?? null;
    } catch { return null; }
  }
}

module.exports = { PaperSwapExecutor };

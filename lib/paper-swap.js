// lib/paper-swap.js — Paper trading swap executor.
//
// Simulates buy/sell using real DexScreener prices with 1% slippage.
// No on-chain execution. Virtual SOL balance tracked in memory.
// Drop-in replacement for SwapExecutor — same interface, zero real money.
//
// Positions opened in paper mode carry txSig: 'PAPER_<id>' so they are
// identifiable in trade history and the reflect cycle can tag them.
'use strict';

const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

    const slippage    = 0.01;                         // 1% simulated slippage
    const effectiveSol = solAmount * (1 - slippage);
    const tokenAmount  = effectiveSol / price;

    this.virtualSolBalance = Math.max(0, this.virtualSolBalance - solAmount);

    const txSig = 'PAPER_' + Date.now().toString(36).toUpperCase();
    log('info', 'Paper buy', { mint: mint.slice(0, 8), sol: solAmount.toFixed(4), tokens: tokenAmount.toFixed(2), txSig });
    return { txSig, inAmount: solAmount, outAmount: tokenAmount, priceImpactPct: slippage * 100 };
  }

  // ── Sell ──────────────────────────────────────────────────────────────────

  async sell(mint, tokenAmount, pct = 1) {
    const price = await this._getPrice(mint);
    if (!price || price <= 0) throw new Error(`Paper: no price data for ${mint.slice(0, 8)}`);

    const rawAmount    = typeof tokenAmount === 'string' ? Number(tokenAmount) : tokenAmount;
    const actualTokens = rawAmount * pct;
    const slippage     = 0.01;
    const solReceived  = actualTokens * price * (1 - slippage);

    this.virtualSolBalance += solReceived;

    const txSig = 'PAPER_' + Date.now().toString(36).toUpperCase();
    log('info', 'Paper sell', { mint: mint.slice(0, 8), tokens: actualTokens.toFixed(2), sol: solReceived.toFixed(4), txSig });
    return { txSig, inAmount: actualTokens, outAmount: solReceived };
  }

  // ── Token balance (reads from positions.js — no on-chain call needed) ─────

  async getTokenBalance(mint) {
    const positions = require('./positions');
    const pos = positions.get(mint);
    if (!pos) return { amount: '0', uiAmount: 0, decimals: 6 };
    const dec = pos.tokenDecimals ?? 6;
    return {
      amount:   pos.tokenAmount,
      uiAmount: Number(pos.tokenAmount) / Math.pow(10, dec),
      decimals: dec,
    };
  }

  // ── Price fetch (DexScreener, 30s cache) ──────────────────────────────────

  async _getPrice(mint) {
    const cached = this._priceCache.get(mint);
    if (cached && Date.now() - cached.ts < 30_000) return cached.price;

    try {
      const r = await fetch(`${DEX_API}/${mint}`, { signal: AbortSignal.timeout(6_000) });
      if (!r.ok) return null;
      const d = await r.json();
      // Prefer SOL-quoted pairs on Solana for accurate SOL price
      const pair = (d.pairs ?? []).find(p =>
        p.chainId === 'solana' &&
        p.quoteToken?.address === SOL_MINT
      ) ?? (d.pairs ?? []).find(p => p.chainId === 'solana');

      const price = pair ? parseFloat(pair.priceNative ?? '0') : null;
      if (price && price > 0) this._priceCache.set(mint, { price, ts: Date.now() });
      return price ?? null;
    } catch { return null; }
  }
}

module.exports = { PaperSwapExecutor };

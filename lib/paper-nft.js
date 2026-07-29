// lib/paper-nft.js — Paper NFT buy executor.
//
// Simulates buying a listed NFT at its real listing price (+ a simulated Tensor taker fee + network
// fee) against a virtual SOL balance. No on-chain execution. Drop-in shape for the live NftBuyExecutor
// (P2.1): same `buy(listing, maxSol)` signature, so the tool/accumulator don't change when we go live.
//
// `listing` = { mint, collection, collectionName, priceSol, listState } — as returned by the read side
// (nft_collection.cheapest[] / nft_asset). Positions opened here carry txSig 'PAPER_<id>'.
'use strict';

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [PAPER-NFT] [${level.toUpperCase()}] ${line}\n`);
};

class PaperNftExecutor {
  constructor(opts = {}) {
    this.paperMode         = true;
    this.virtualSolBalance = opts.initialSolBalance ?? 1.0;
    this.takerFeePct       = opts.takerFeePct   ?? 0.015;  // ~1.5% Tensor taker fee (buyer side)
    this.networkFeeSol     = opts.networkFeeSol ?? 0.001;  // priority + rent headroom
    log('info', 'Paper NFT executor initialized', { virtualSol: this.virtualSolBalance.toFixed(4) });
  }

  // Buy a specific listing. maxSol is the price ceiling (the paper analog of buyLegacy.maxAmount).
  async buy(listing, maxSol) {
    const price = Number(listing?.priceSol);
    if (!(price > 0)) throw new Error(`Paper NFT: no listing price for ${(listing?.mint || '?').slice(0, 8)}`);
    if (maxSol != null && price > maxSol) throw new Error(`Paper NFT: listing price ${price} > maxSol ${maxSol} (would overpay)`);

    const feeSol    = +(price * this.takerFeePct + this.networkFeeSol).toFixed(6);
    const totalCost = +(price + feeSol).toFixed(6);
    if (this.virtualSolBalance < totalCost) {
      throw new Error(`Paper NFT: insufficient virtual SOL (${this.virtualSolBalance.toFixed(4)} < ${totalCost.toFixed(4)})`);
    }
    this.virtualSolBalance = +(this.virtualSolBalance - totalCost).toFixed(6);

    const txSig = 'PAPER_' + Date.now().toString(36).toUpperCase();
    log('info', 'Paper NFT buy', {
      mint: (listing.mint || '?').slice(0, 8),
      coll: listing.collectionName || (listing.collection || '?').slice(0, 8),
      price, fee: feeSol, txSig,
    });
    return {
      txSig,
      mint:       listing.mint,
      collection: listing.collection,
      priceSol:   price,
      solSpent:   totalCost,
      execCosts:  { feeSol, via: 'paper-nft-est' },
    };
  }
}

module.exports = { PaperNftExecutor };

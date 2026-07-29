// lib/tools/nft-trade.js — NFT trade tools (Phase 2, self-custody).
//
// nft_buy   — buy a collection's cheapest listing (or a specific mint) on Tensor. Shares the safety
//             gate with the accumulator (lib/nft-guards); paper mode simulates against a virtual balance.
// nft_list  — list an owned NFT for sale at a price (reversible).
// nft_delist— cancel a listing, reclaim the NFT.
// nft_sell  — sell an owned NFT into a standing collection bid (instant exit; the arb exit leg).
//
// The sell verbs go through the live NftSellExecutor (ctx.nftSell), which is SIMULATE-FIRST and only
// present when NFT trading is live (nft.paperTrading:false). They are exits, so they are NOT blocked by
// the global trading pause — you can always get out.
'use strict';

const { acquireBuyLock, releaseBuyLock } = require('../trade-lock');
const { checkNftBuy } = require('../nft-guards');
const nftPositions = require('../nft-positions');

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'nft_buy',
      description: "Buy an NFT on Tensor (self-custody). Give a collection address to buy its CHEAPEST current listing, or a specific mint. Respects the NFT spend caps (maxBuySol, maxOpenNfts, dailyBuyLimitSol, maxHeldSol) and the wallet survival floor. In paper mode (config nft.paperTrading) it simulates against a virtual balance. maxSol is a price ceiling — the buy is refused/failed if the listing price is above it (overpay guard). Selling/listing is not available yet.",
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'collection address — buys its cheapest listing' },
          mint:       { type: 'string', description: 'a specific NFT mint to buy (optional; overrides collection)' },
          maxSol:     { type: 'number', description: 'max SOL to pay (price ceiling; defaults to the current listing price)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_list',
      description: 'List an NFT this wallet OWNS for sale on Tensor at a set price (the patient exit). Reversible with nft_delist. The NFT stays in the wallet (frozen) while listed. Self-custody, live only (simulate-first).',
      parameters: {
        type: 'object',
        properties: {
          mint:     { type: 'string', description: 'the mint of an NFT this wallet holds' },
          priceSol: { type: 'number', description: 'list price in SOL' },
        },
        required: ['mint', 'priceSol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_delist',
      description: 'Cancel a Tensor listing for an NFT this wallet owns, reclaiming it (and the listing rent). Self-custody, live only.',
      parameters: {
        type: 'object',
        properties: { mint: { type: 'string', description: 'the mint of a currently-listed NFT this wallet holds' } },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_portfolio',
      description: "The agent's OWN NFT positions: each held NFT with its cost basis (what the agent paid), the collection's current floor, mark-to-market and unrealized P&L, plus realized P&L from past sells. Use to review NFT holdings and performance (distinct from wallet_nfts, which values any wallet at on-chain floor without cost basis).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_sell',
      description: "Sell an NFT this wallet OWNS instantly into the collection's best standing bid on Tensor (the arb exit). Only fills a bid that needs no Tensor cosigner — much of Tensor's bid liquidity is cosigned and cannot be filled by a self-custody seller, in which case this reports the bid as unfillable. minSol is a floor on the proceeds (slippage guard). Self-custody, live only (simulate-first).",
      parameters: {
        type: 'object',
        properties: {
          mint:   { type: 'string', description: 'the mint of an NFT this wallet holds' },
          minSol: { type: 'number', description: 'minimum SOL proceeds to accept (optional; defaults to bid minus fee+royalty, 2% slippage)' },
        },
        required: ['mint'],
      },
    },
  },
];

const HANDLERS = {
  async nft_buy(args, ctx, logf = () => {}) {
    const { api } = ctx;
    const nftSwap = ctx.nftSwap;
    if (!nftSwap) return JSON.stringify({ error: 'NFT executor not initialized' });

    // 1) Resolve the target listing from the read side.
    let listing;
    try {
      if (args.mint) {
        const a = await api.nftAsset(String(args.mint));
        if (!a || !a.listed) return JSON.stringify({ error: `NFT ${String(args.mint).slice(0, 8)}… is not currently listed` });
        listing = { mint: a.mint, collection: a.collection, collectionName: a.collectionName, priceSol: a.listPriceSol, listState: a.listState ?? null, floorSol: a.collectionFloorSol };
      } else if (args.collection) {
        const c = await api.nftCollection(String(args.collection), { listings: 1 });
        const cheap = c && Array.isArray(c.cheapest) ? c.cheapest[0] : null;
        if (!cheap) return JSON.stringify({ error: 'no open listings for this collection' });
        listing = { mint: cheap.assetId, collection: c.collection, collectionName: c.collectionName, priceSol: cheap.priceSol, listState: null, floorSol: c.floorSol };
      } else {
        return JSON.stringify({ error: 'collection or mint required' });
      }
    } catch (e) { return JSON.stringify({ error: `could not resolve listing: ${e.message}` }); }

    if (nftPositions.get(listing.mint)) return JSON.stringify({ error: 'already holding this NFT' });

    const maxSol = Number(args.maxSol) || listing.priceSol;

    // 2) Safety gate (shared with the accumulator).
    const g = await checkNftBuy({ collection: listing.collection, priceSol: listing.priceSol, ctx });
    if (!g.ok) {
      logf('warn', `nft_buy blocked — ${g.reason}`);
      return JSON.stringify({ error: `Buy blocked: ${g.reason}`, listing: { mint: listing.mint, collection: listing.collectionName, priceSol: listing.priceSol } });
    }

    // 3) Lock + buy + record.
    if (!acquireBuyLock(listing.mint)) return JSON.stringify({ error: 'a buy is already in progress for this NFT' });
    let result;
    try {
      result = await nftSwap.buy(listing, maxSol);
    } catch (e) {
      releaseBuyLock(listing.mint);
      return JSON.stringify({ error: `buy failed: ${e.message}` });
    }
    releaseBuyLock(listing.mint);

    nftPositions.openNft(listing.mint, {
      collection: listing.collection, collectionName: listing.collectionName,
      solSpent: result.solSpent, listState: listing.listState, floorAtBuySol: listing.floorSol,
      txSig: result.txSig, paper: !!nftSwap.paperMode,
    });
    logf('info', `nft_buy ${nftSwap.paperMode ? '(paper) ' : ''}${listing.collectionName || ''} ${listing.mint.slice(0, 8)}… @ ${listing.priceSol} SOL → ${result.txSig}`);
    return JSON.stringify({
      success: true, paper: !!nftSwap.paperMode, txSig: result.txSig,
      mint: listing.mint, collection: listing.collectionName, priceSol: listing.priceSol, solSpent: result.solSpent,
    });
  },

  async nft_portfolio(_args, ctx, _logf = () => {}) {
    const open = nftPositions.getAll();                  // { mint → position }
    const entries = Object.entries(open);
    // Refresh the current floor per held collection (deduped) for a real mark-to-market.
    const floors = {};
    for (const c of [...new Set(entries.map(([, p]) => p.collection).filter(Boolean))]) {
      try { const d = await ctx.api.nftCollection(c, { listings: 1 }); floors[c] = d ? d.floorSol : null; } catch { floors[c] = null; }
    }
    const positions = entries.map(([mint, p]) => {
      const floor = floors[p.collection] ?? p.floorAtBuySol ?? null;
      return {
        mint, collection: p.collectionName || p.collection,
        costSol: p.solSpent, floorSol: floor,
        unrealizedPnlSol: floor != null ? +(floor - p.solSpent).toFixed(4) : null,
        paper: !!p.paper,
      };
    });
    const history = nftPositions.getHistory(10);
    const realizedPnlSol = history.reduce((s, h) => s + (Number(h.pnlSol) || 0), 0);
    return JSON.stringify({
      open: positions.length,
      heldCostSol:     +nftPositions.heldSol().toFixed(4),
      markToMarketSol: +positions.reduce((s, p) => s + (p.floorSol ?? p.costSol ?? 0), 0).toFixed(4),
      unrealizedPnlSol:+positions.reduce((s, p) => s + (p.unrealizedPnlSol || 0), 0).toFixed(4),
      dailySpentSol:   +nftPositions.dailySpentSol().toFixed(4),
      realizedPnlSol:  +realizedPnlSol.toFixed(4),
      positions,
      recentSells: history.slice(0, 5).map(h => ({ collection: h.collectionName || h.collection, costSol: h.solSpent, soldForSol: h.solReceived, pnlSol: h.pnlSol })),
    });
  },

  async nft_list(args, ctx, logf = () => {}) {
    const sell = ctx.nftSell;
    if (!sell) return JSON.stringify({ error: 'selling is available only in live mode (nft.paperTrading:false)' });
    if (!args.mint || !(Number(args.priceSol) > 0)) return JSON.stringify({ error: 'mint and priceSol (> 0) are required' });
    if (!acquireBuyLock(args.mint)) return JSON.stringify({ error: 'an action is already in progress for this NFT' });
    try {
      const r = await sell.list(String(args.mint), Number(args.priceSol));
      logf('info', `nft_list ${args.mint.slice(0, 8)}… @ ${args.priceSol} SOL → ${r.txSig}`);
      return JSON.stringify({ success: true, action: 'list', mint: r.mint, priceSol: r.priceSol, txSig: r.txSig });
    } catch (e) { return JSON.stringify({ error: `list failed: ${e.message}` }); }
    finally { releaseBuyLock(args.mint); }
  },

  async nft_delist(args, ctx, logf = () => {}) {
    const sell = ctx.nftSell;
    if (!sell) return JSON.stringify({ error: 'selling is available only in live mode (nft.paperTrading:false)' });
    if (!args.mint) return JSON.stringify({ error: 'mint required' });
    if (!acquireBuyLock(args.mint)) return JSON.stringify({ error: 'an action is already in progress for this NFT' });
    try {
      const r = await sell.delist(String(args.mint));
      logf('info', `nft_delist ${args.mint.slice(0, 8)}… → ${r.txSig}`);
      return JSON.stringify({ success: true, action: 'delist', mint: r.mint, txSig: r.txSig });
    } catch (e) { return JSON.stringify({ error: `delist failed: ${e.message}` }); }
    finally { releaseBuyLock(args.mint); }
  },

  async nft_sell(args, ctx, logf = () => {}) {
    const sell = ctx.nftSell;
    if (!sell) return JSON.stringify({ error: 'selling is available only in live mode (nft.paperTrading:false)' });
    if (!args.mint) return JSON.stringify({ error: 'mint required' });

    // Resolve the collection's standing bids (walk the book — the top bid is often cosigned/unfillable).
    let candidates;
    try {
      const a = await ctx.api.nftAsset(String(args.mint));
      if (!a || !a.collection) return JSON.stringify({ error: 'NFT not indexed — cannot find its collection/bids' });
      if (a.listed) return JSON.stringify({ error: 'this NFT is currently listed (frozen) — nft_delist it before selling into a bid' });
      const b = await ctx.api.nftBids(a.collection, { limit: 10 });
      candidates = b && Array.isArray(b.bids) ? b.bids.filter(x => x && x.bidState) : [];
      if (!candidates.length) return JSON.stringify({ error: 'no standing collection bid to sell into' });
    } catch (e) { return JSON.stringify({ error: `could not resolve a bid: ${e.message}` }); }

    if (!acquireBuyLock(args.mint)) return JSON.stringify({ error: 'an action is already in progress for this NFT' });
    let r;
    try { r = await sell.sellIntoBestBid(String(args.mint), candidates, { minSol: args.minSol != null ? Number(args.minSol) : undefined }); }
    catch (e) { releaseBuyLock(args.mint); return JSON.stringify({ error: `sell failed: ${e.message}` }); }
    releaseBuyLock(args.mint);

    // No fillable bid found — report which ones were skipped and why (usually all cosigned).
    if (!r || !r.txSig) return JSON.stringify({ error: r?.reason || 'no fillable bid', skipped: r?.skipped });

    // Record the realized exit if we were tracking this NFT as a position.
    if (nftPositions.get(args.mint)) nftPositions.closeNft(args.mint, { solReceived: r.proceedsSol, txSig: r.txSig, reason: 'sold-into-bid' });
    logf('info', `nft_sell ${args.mint.slice(0, 8)}… into bid → ${r.proceedsSol} SOL (${r.txSig})`);
    return JSON.stringify({ success: true, action: 'sell', mint: r.mint, proceedsSol: r.proceedsSol, bidSol: r.bidSol, txSig: r.txSig });
  },
};

module.exports = { DEFINITIONS, HANDLERS };

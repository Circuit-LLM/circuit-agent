// lib/tools/nft-trade.js — NFT trade tool (Phase 2, self-custody).
//
// nft_buy: buy a collection's cheapest listing (or a specific NFT by mint) on Tensor. Goes through
// the SAME safety gate as the accumulator (lib/nft-guards). In paper mode it simulates. Selling/
// listing is not offered yet (needs new marketplace verbs).
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
};

module.exports = { DEFINITIONS, HANDLERS };

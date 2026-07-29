// lib/tools/nft.js — Solana NFT market tools (Tensor floors / listings / bids / arb).
//
// All data is computed on-chain by circuit-node (via /api/nft/*) — no third-party marketplace API.
// These are READ tools: they surface opportunities. Acting on them (buying/selling an NFT) is a
// separate, custodial capability the agent does not have here.
'use strict';

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'nft_arb',
      description: 'Scan for NFT mark-to-market arbitrage: Tensor collections whose FLOOR sits at/below the best standing collection-wide BID (buy the floor, sell into the bid). Returns opportunities ranked by netSpreadSol (already net of the collection royalty + Tensor fees on both legs); netInTheMoney flags real ones. Judge on netSpreadSol, not spreadSol. Bids can still be stale/thin — verify before treating it as profit.',
      parameters: {
        type: 'object',
        properties: {
          minSpreadSol: { type: 'number', description: 'Only return opportunities with at least this gross floor→bid spread in SOL (default 0)' },
          limit:        { type: 'number', description: 'Max opportunities (default 50, max 200)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_collection',
      description: 'Get one Tensor NFT collection: name, floor price (SOL), open listings, cheapest listings, best standing bid (topBidSol), royaltyBps, gross spreadSol, and netSpreadSol (after royalty + fees; netInTheMoney flags a real instant-flip). Keyed by the collection\'s on-chain verified-collection address.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'The verified-collection address (base58)' },
          listings:   { type: 'number', description: 'How many cheapest listings to include (default 20, max 100)' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_floors',
      description: 'List indexed Tensor NFT collection floors — floor price (SOL) and open-listing count per collection. Use to survey the market or find the most-liquid collections. Sort by listed (most listings = most liquid, default), floor (cheapest first), or -floor (priciest first).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max collections (default 50, max 500)' },
          sort:  { type: 'string', description: 'listed | floor | -floor (default listed)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_search',
      description: 'Resolve an NFT collection by NAME (e.g. "Mad Lads", "Monke") to its on-chain address, with floor + listing count. Use this FIRST when the user names a collection — the other NFT tools need the address.',
      parameters: {
        type: 'object',
        properties: {
          q:     { type: 'string', description: 'Collection name or partial name (min 2 chars)' },
          limit: { type: 'number', description: 'Max matches (default 20)' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_asset',
      description: 'Inspect ONE NFT by its mint address: is it listed and at what price, which collection (name) it belongs to, the collection floor, the best standing bid, and whether it can be sold into that bid (sellableIntoBid). Use for "what is this NFT / is it listed / what is it worth".',
      parameters: {
        type: 'object',
        properties: { mint: { type: 'string', description: 'The NFT mint address' } },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_bids',
      description: 'Full standing collection-wide bid depth for a collection (highest first) — the offers you could sell into. Use to gauge how deep/real the bid side is before trusting an arb signal.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'The verified-collection address' },
          limit:      { type: 'number', description: 'Max bids (default 50, max 200)' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wallet_nfts',
      description: "A wallet's NFT portfolio with floor mark-to-market: the NFTs it holds, their collections, and the total value (Σ collection floors). Floor is a lower bound (trait-rare items are worth more). Use for 'what NFTs does this wallet hold / what is the portfolio worth'.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The wallet address' },
          limit: { type: 'number', description: 'Max NFTs to detail (default 200)' },
        },
        required: ['owner'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_market',
      description: 'Global Solana NFT market snapshot: number of indexed collections, total open listings, how many collections have standing bids, live arb-opportunity count, and median/cheapest floor. Use to read the NFT market macro before drilling into collections.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nft_sales',
      description: "Recent listing ACTIVITY for a collection: listings that left the book (FILLED or DELISTED) at their last list price, plus avg/median. IMPORTANT: this is a broad velocity/activity signal, NOT a confirmed-sale feed — it does not distinguish a sale from a delisting and is snapshot-granular. Use it to gauge how active/liquid a collection is, not for exact sale prices.",
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'The verified-collection address' },
          limit:      { type: 'number', description: 'Max recent events (default 50, max 100)' },
        },
        required: ['collection'],
      },
    },
  },
];

const HANDLERS = {
  async nft_arb(args, ctx, _log) {
    const data = await ctx.api.nftArb({
      minSpreadSol: Number(args.minSpreadSol) || 0,
      limit: Math.min(Math.max(1, Number(args.limit) || 50), 200),
    });
    return JSON.stringify(data ?? { error: 'NFT arb data unavailable' });
  },

  async nft_collection(args, ctx, _log) {
    if (!args.collection) return JSON.stringify({ error: 'collection address required' });
    const data = await ctx.api.nftCollection(String(args.collection), {
      listings: Math.min(Math.max(1, Number(args.listings) || 20), 100),
    });
    return JSON.stringify(data ?? { error: 'Collection not found or not yet indexed' });
  },

  async nft_floors(args, ctx, _log) {
    const data = await ctx.api.nftFloors({
      limit: Math.min(Math.max(1, Number(args.limit) || 50), 500),
      sort: ['listed', 'floor', '-floor'].includes(args.sort) ? args.sort : 'listed',
    });
    return JSON.stringify(data ?? { error: 'NFT floor data unavailable' });
  },

  async nft_search(args, ctx, _log) {
    if (!args.q || String(args.q).trim().length < 2) return JSON.stringify({ error: 'q (collection name, min 2 chars) required' });
    const data = await ctx.api.nftSearch(String(args.q).trim(), { limit: Math.min(Math.max(1, Number(args.limit) || 20), 100) });
    return JSON.stringify(data ?? { error: 'NFT search unavailable' });
  },

  async nft_asset(args, ctx, _log) {
    if (!args.mint) return JSON.stringify({ error: 'mint required' });
    const data = await ctx.api.nftAsset(String(args.mint));
    return JSON.stringify(data ?? { error: 'NFT not indexed (not listed and collection unseen)' });
  },

  async nft_bids(args, ctx, _log) {
    if (!args.collection) return JSON.stringify({ error: 'collection address required' });
    const data = await ctx.api.nftBids(String(args.collection), { limit: Math.min(Math.max(1, Number(args.limit) || 50), 200) });
    return JSON.stringify(data ?? { error: 'No bids indexed for this collection' });
  },

  async wallet_nfts(args, ctx, _log) {
    if (!args.owner) return JSON.stringify({ error: 'owner address required' });
    const data = await ctx.api.walletNfts(String(args.owner), { limit: Math.min(Math.max(1, Number(args.limit) || 200), 500) });
    return JSON.stringify(data ?? { error: 'Wallet NFT data unavailable' });
  },

  async nft_market(args, ctx, _log) {
    const data = await ctx.api.nftMarket();
    return JSON.stringify(data ?? { error: 'NFT market data unavailable' });
  },

  async nft_sales(args, ctx, _log) {
    if (!args.collection) return JSON.stringify({ error: 'collection address required' });
    const data = await ctx.api.nftSales(String(args.collection), { limit: Math.min(Math.max(1, Number(args.limit) || 50), 100) });
    return JSON.stringify(data ?? { error: 'NFT sales activity unavailable' });
  },
};

module.exports = { DEFINITIONS, HANDLERS };

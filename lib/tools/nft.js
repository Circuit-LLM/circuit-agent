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
      description: 'Scan for NFT mark-to-market arbitrage: Tensor collections whose FLOOR sits at/below the best standing collection-wide BID (buy the floor, sell into the bid). Returns opportunities ranked by gross spread. IMPORTANT: the spread is GROSS of creator royalties + marketplace fees (often 5-10% combined) and some bids may be stale/thin — always verify before treating it as profit.',
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
      description: 'Get one Tensor NFT collection: floor price (SOL), number of open listings, the cheapest open listings, the best standing collection bid (topBidSol), and the arb spread (spreadSol = topBid − floor; floorBelowBid = true means the floor is at/below the bid = an instant-flip candidate). Keyed by the collection\'s on-chain verified-collection address.',
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
};

module.exports = { DEFINITIONS, HANDLERS };

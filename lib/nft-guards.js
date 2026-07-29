// lib/nft-guards.js — the single safety gate every NFT buy goes through.
//
// Shared by the nft_buy tool and the accumulator so the caps are enforced identically no matter
// who initiates the buy. Fail-closed: an un-indexed/blacklisted collection or a missing price blocks.
'use strict';

const { isPaused } = require('./pause');
const nftPositions = require('./nft-positions');

// { ok:true } or { ok:false, reason }
async function checkNftBuy({ collection, priceSol, ctx }) {
  const n = ctx.cfg?.nft ?? {};
  const survivalFloor = ctx.cfg?.survival?.minSolPause ?? n.minSolPause ?? 0.01;

  if (isPaused()) return { ok: false, reason: 'trading paused' };
  if (!collection) return { ok: false, reason: 'collection un-indexed — refusing (fail-closed)' };
  if (Array.isArray(n.blacklist) && n.blacklist.includes(collection)) return { ok: false, reason: 'collection blacklisted' };
  if (!(priceSol > 0)) return { ok: false, reason: 'no listing price' };

  const maxBuySol = n.maxBuySol ?? 0.5;
  if (priceSol > maxBuySol) return { ok: false, reason: `price ${priceSol} SOL > maxBuySol ${maxBuySol}` };

  const maxOpen = n.maxOpenNfts ?? 5;
  if (nftPositions.count() >= maxOpen) return { ok: false, reason: `maxOpenNfts ${maxOpen} reached` };

  const dailyCap = n.dailyBuyLimitSol ?? 1.0;
  if (nftPositions.dailySpentSol() + priceSol > dailyCap) return { ok: false, reason: `dailyBuyLimitSol ${dailyCap} SOL would be exceeded` };

  const maxHeld = n.maxHeldSol ?? 2.0;
  if (nftPositions.heldSol() + priceSol > maxHeld) return { ok: false, reason: `maxHeldSol ${maxHeld} SOL (standing NFT exposure) would be exceeded` };

  // Wallet survival floor — only checked for LIVE buys (paper uses the virtual balance in the executor).
  if (n.paperTrading === false) {
    try {
      const bal = await ctx.wallet.getSolBalance();
      if (bal - priceSol < survivalFloor) return { ok: false, reason: `survival floor: ${bal.toFixed(4)} − ${priceSol} < ${survivalFloor} SOL reserve` };
    } catch (e) { return { ok: false, reason: `cannot verify SOL balance: ${e.message}` }; }
  }

  return { ok: true };
}

module.exports = { checkNftBuy };

// lib/nft-sell.js — self-custody NFT SELL executor (Tensor list / delist / sell-into-bid).
//
// The exit side of the NFT trading loop, mirroring lib/nft-buy.js: builds Tensor v2 instructions and
// adapts them to v1, reads all needed state on-chain from just the mint, and is SIMULATE-FIRST — every
// action is simulated before signing and refused if the simulation fails or the SOL flow is wrong.
//
// Three verbs:
//   • list(mint, priceSol)   — listLegacy: escrow the owned NFT for sale at a price. Reversible via delist.
//   • delist(mint)           — delistLegacy: cancel the listing, get the NFT (and rent) back.
//   • sellIntoBid(mint, opts)— takeBidLegacy: hit a standing collection bid for an instant exit.
//
// ⚠️ A self-custody seller can only fill a bid that needs no cosigner. Much of Tensor's bid liquidity is
// COSIGNED margin/AMM liquidity (only Tensor's cosigner service can co-sign it) — sellIntoBid detects
// that and refuses honestly rather than building a transaction that can never land. list/delist have no
// such constraint and are the dependable self-custody exits.
'use strict';

const {
  Connection, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const {
  mkt, TENSOR_TAKER_FEE_BPS, TokenStandard, isRegular, isPnft, readMetadata, v2ToV1Instruction, optVal,
} = require('./nft-tensor-common');

const LIST_COST_CEILING_LAMPORTS = 20_000_000;   // listing only pays escrow rent (~0.003) — cap well above that
const INCIDENTAL_LAMPORTS        = 5_000_000;     // tx + priority slack

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [NFT-SELL] [${level.toUpperCase()}] ${line}\n`);
};

class NftSellExecutor {
  // opts: { connection, keypair, dryRun, priorityMicroLamports }
  constructor(opts = {}) {
    this.paperMode  = false;
    this.connection = opts.connection;
    this.keypair    = opts.keypair;
    this.pubkey     = this.keypair.publicKey;
    this.dryRun     = opts.dryRun ?? false;
    this.priorityMicroLamports = opts.priorityMicroLamports ?? 50_000;
    if (!this.connection || !this.keypair) throw new Error('NftSellExecutor needs { connection, keypair }');
    log('info', 'NFT sell executor initialized', { wallet: this.pubkey.toBase58().slice(0, 8) + '…', dryRun: this.dryRun });
  }

  // ── list an owned NFT for sale at priceSol ─────────────────────────────────────
  async list(mint, priceSol) {
    if (!(priceSol > 0)) throw new Error('NFT list: priceSol must be > 0');
    await this._assertOwned(mint);
    const meta = await readMetadata(this.connection, mint);
    const std = meta.tokenStandard ?? TokenStandard.NonFungible;
    if (!isRegular(std) && !isPnft(std)) throw new Error(`NFT list: token standard ${std} not supported by listLegacy`);

    const amount = BigInt(Math.round(priceSol * 1e9));
    const input = { owner: this._signer(), mint, amount, tokenStandard: std };
    if (isPnft(std) && meta.ruleSet) input.authorizationRules = meta.ruleSet;
    const ix = v2ToV1Instruction(await mkt.getListLegacyInstructionAsync(input));

    // Listing only spends escrow rent — cap the outflow so a malformed ix that drains SOL is refused.
    const sim = await this._buildSimGuard([ix], { maxOutLamports: LIST_COST_CEILING_LAMPORTS, label: `list ${mint.slice(0, 8)}…` });
    if (this.dryRun) { log('info', 'DRY-RUN list simulated clean', { mint: mint.slice(0, 8), priceSol }); return { txSig: 'DRYRUN_' + mint.slice(0, 8), mint, action: 'list', priceSol }; }
    const txSig = await this._signSubmitConfirm(sim.tx, sim.blockhash, sim.lastValidBlockHeight, `list ${mint.slice(0, 8)}…`);
    log('info', 'listed', { mint: mint.slice(0, 8), priceSol, txSig });
    return { txSig, mint, action: 'list', priceSol };
  }

  // ── cancel a listing, reclaim the NFT + rent ───────────────────────────────────
  async delist(mint) {
    const meta = await readMetadata(this.connection, mint);
    const std = meta.tokenStandard ?? TokenStandard.NonFungible;
    const input = { owner: this._signer(), mint, tokenStandard: std };
    if (isPnft(std) && meta.ruleSet) input.authorizationRules = meta.ruleSet;
    const ix = v2ToV1Instruction(await mkt.getDelistLegacyInstructionAsync(input));

    // Delisting refunds rent → the wallet should not lose SOL beyond the tx fee.
    const sim = await this._buildSimGuard([ix], { maxOutLamports: INCIDENTAL_LAMPORTS, label: `delist ${mint.slice(0, 8)}…` });
    if (this.dryRun) { log('info', 'DRY-RUN delist simulated clean', { mint: mint.slice(0, 8) }); return { txSig: 'DRYRUN_' + mint.slice(0, 8), mint, action: 'delist' }; }
    const txSig = await this._signSubmitConfirm(sim.tx, sim.blockhash, sim.lastValidBlockHeight, `delist ${mint.slice(0, 8)}…`);
    log('info', 'delisted', { mint: mint.slice(0, 8), txSig });
    return { txSig, mint, action: 'delist' };
  }

  // Read + decode a bid and decide whether a self-custody seller can fill it.
  // Returns { ok, reason, bid } — ok:false with a reason for the unfillable cases.
  async _loadFillableBid(bidState) {
    const bidAcct = await this.connection.getAccountInfo(new PublicKey(bidState), 'confirmed');
    if (!bidAcct) return { ok: false, reason: 'bid no longer exists' };
    const bid = mkt.getBidStateDecoder().decode(bidAcct.data);
    const currency = optVal(bid.currency), cosigner = optVal(bid.cosigner), privateTk = optVal(bid.privateTaker);
    if (currency)  return { ok: false, reason: `pays an SPL currency (${currency.slice(0, 8)}…), not native SOL`, bid };
    if (cosigner)  return { ok: false, reason: 'requires a Tensor cosigner (a self-custody seller cannot fill it)', bid };
    if (privateTk && privateTk !== this.pubkey.toBase58()) return { ok: false, reason: 'private to another seller', bid };
    if (BigInt(bid.filledQuantity ?? 0) >= BigInt(bid.quantity ?? 1)) return { ok: false, reason: 'already fully filled', bid };
    return { ok: true, bid };
  }

  // Sell into the FIRST fillable bid among candidates [{ bidState, priceSol }] (highest first). Skips the
  // ones a self-custody seller can't fill (cosigned/SPL/private/filled) instead of failing on the top bid.
  // Returns the sell result, or { skipped:[{priceSol,reason}], reason } when none is fillable.
  async sellIntoBestBid(mint, candidates = [], { minSol } = {}) {
    const skipped = [];
    for (const c of candidates) {
      const bidState = c.bidState || c;
      const chk = await this._loadFillableBid(bidState);
      if (!chk.ok) { skipped.push({ priceSol: c.priceSol, reason: chk.reason }); continue; }
      return this.sellIntoBid(mint, { bidState, minSol });
    }
    return { skipped, reason: candidates.length ? 'no fillable bid (all cosigned/SPL/private/filled)' : 'no standing bid' };
  }

  // ── sell an owned NFT into a standing collection bid ───────────────────────────
  // opts: { bidState (required — the bid PDA to hit), minSol (floor on proceeds) }
  async sellIntoBid(mint, { bidState, minSol } = {}) {
    if (!bidState) throw new Error('NFT sell: bidState (the bid to hit) is required');
    await this._assertOwned(mint);

    const chk = await this._loadFillableBid(bidState);
    if (!chk.ok) throw new Error(`NFT sell: bid ${chk.reason}`);
    const bid = chk.bid;

    const margin     = optVal(bid.margin);
    const makerBroker = optVal(bid.makerBroker);
    const bidder     = String(bid.owner);
    const whitelist  = optVal(bid.targetId);              // collection bid: target=Whitelist, targetId=whitelist
    const bidAmount  = BigInt(bid.amount);
    const bidSol     = Number(bidAmount) / 1e9;

    // Proceeds floor: the caller's minSol, defaulting to the bid amount net of fee + royalty (charged to seller).
    const meta = await readMetadata(this.connection, mint);
    const std = meta.tokenStandard ?? TokenStandard.NonFungible;
    if (!isRegular(std) && !isPnft(std)) throw new Error(`NFT sell: token standard ${std} not supported by takeBidLegacy`);
    const feeRoyaltyBps = BigInt(TENSOR_TAKER_FEE_BPS + (meta.sellerFeeBps || 0));
    const estProceeds = bidAmount - (bidAmount * feeRoyaltyBps + 9999n) / 10000n;
    const minAmount = minSol != null ? BigInt(Math.round(Number(minSol) * 1e9)) : (estProceeds * 98n) / 100n; // 2% slippage on the estimate

    const input = {
      seller: this._signer(), mint, bidState, owner: bidder, whitelist,
      minAmount, tokenStandard: std, creators: meta.creators,
      makerBroker, takerBroker: null, cosigner: null, optionalRoyaltyPct: 100,
    };
    if (margin) input.sharedEscrow = margin;              // margin bid funds from the bidder's shared escrow
    if (isPnft(std) && meta.ruleSet) input.authorizationRules = meta.ruleSet;
    const ix = v2ToV1Instruction(await mkt.getTakeBidLegacyInstructionAsync(input));

    // Selling should INCREASE the wallet balance — require a positive net inflow (never give the NFT away).
    const sim = await this._buildSimGuard([ix], { minInflowLamports: 1, label: `sell ${mint.slice(0, 8)}… into bid` });
    const inflowSol = sim.netLamports != null ? (-sim.netLamports) / 1e9 : null;
    if (this.dryRun) { log('info', 'DRY-RUN sell simulated clean', { mint: mint.slice(0, 8), bidSol, inflowSol }); return { txSig: 'DRYRUN_' + mint.slice(0, 8), mint, action: 'sell', bidSol, proceedsSol: inflowSol }; }
    const txSig = await this._signSubmitConfirm(sim.tx, sim.blockhash, sim.lastValidBlockHeight, `sell ${mint.slice(0, 8)}…`);
    log('info', 'sold into bid', { mint: mint.slice(0, 8), bidSol, proceedsSol: inflowSol, txSig });
    return { txSig, mint, action: 'sell', bidSol, proceedsSol: inflowSol };
  }

  // ── internals ──────────────────────────────────────────────────────────────────

  _signer() { return { address: this.pubkey.toBase58(), signTransactions: async (t) => t }; }

  // Confirm this wallet actually holds the mint (fail fast before building a doomed instruction).
  async _assertOwned(mint) {
    const res = await this.connection.getParsedTokenAccountsByOwner(this.pubkey, { mint: new PublicKey(mint) });
    const owns = res.value.some(a => Number(a.account.data.parsed.info.tokenAmount.amount) > 0);
    if (!owns) throw new Error(`NFT: this wallet does not hold ${mint.slice(0, 8)}…`);
  }

  // Compile a v0 tx, fee-payer check, simulate-first, and enforce a SOL-flow bound.
  //   maxOutLamports    — refuse if the wallet loses more than this (list/delist)
  //   minInflowLamports — refuse if the wallet does not gain at least this (sell)
  // Returns { tx, blockhash, lastValidBlockHeight, netLamports }  (netLamports = pre - post; <0 = inflow)
  async _buildSimGuard(ixs, { maxOutLamports, minInflowLamports, label }) {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: this.pubkey, recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityMicroLamports }),
        ...ixs,
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    const payer = tx.message.staticAccountKeys[0];
    if (!payer?.equals(this.pubkey)) throw new Error(`refusing to sign ${label}: fee payer is not this wallet`);

    let pre, sim;
    try {
      [pre, sim] = await Promise.all([
        this.connection.getBalance(this.pubkey, 'confirmed'),
        this.connection.simulateTransaction(tx, {
          sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: [this.pubkey.toBase58()] },
        }),
      ]);
    } catch (e) { throw new Error(`refusing to sign ${label}: simulation unavailable (${e.message})`); }
    if (sim?.value?.err) {
      const logs = (sim.value.logs || []).filter(l => /Error|failed|insufficient|custom/i.test(l)).slice(-3).join(' | ');
      throw new Error(`refusing to sign ${label}: simulation failed (${JSON.stringify(sim.value.err)})${logs ? ' — ' + logs : ''}`);
    }
    const post = sim?.value?.accounts?.[0]?.lamports;
    let netLamports = null;
    if (post != null && pre != null) {
      netLamports = pre - post;                            // >0 outflow, <0 inflow
      if (maxOutLamports != null && netLamports > maxOutLamports) {
        throw new Error(`refusing to sign ${label}: removes ${(netLamports / 1e9).toFixed(4)} SOL, over the ${(maxOutLamports / 1e9).toFixed(4)} ceiling`);
      }
      if (minInflowLamports != null && -netLamports < minInflowLamports) {
        throw new Error(`refusing to sign ${label}: net inflow ${(-netLamports / 1e9).toFixed(4)} SOL — would not be paid`);
      }
      log('info', 'pre-sign check passed', { label, netSol: (netLamports / 1e9).toFixed(6) });
    }
    return { tx, blockhash, lastValidBlockHeight, netLamports };
  }

  async _signSubmitConfirm(tx, blockhash, lastValidBlockHeight, label) {
    tx.sign([this.keypair]);
    const txSig = await this.connection.sendRawTransaction(Buffer.from(tx.serialize()), { skipPreflight: false, maxRetries: 3 });
    const res = await this.connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res?.value?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(res.value.err)}`);
    return txSig;
  }
}

module.exports = { NftSellExecutor };

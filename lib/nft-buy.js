// lib/nft-buy.js — Live self-custody NFT buy executor (Tensor buyLegacy).
//
// Drop-in for PaperNftExecutor: same `buy(listing, maxSol)` signature and return shape, so the
// nft_buy tool and the accumulator don't change when the wallet goes live. This one actually moves
// SOL — so it is SIMULATE-FIRST and hard-gated:
//
//   • every buy is simulated before signing; a non-clean simulation THROWS and submits nothing
//   • the fee payer must be this wallet, and the simulated SOL outflow must not exceed the true
//     total (price + Tensor fee + royalty) + a small incidental buffer — else it refuses to sign
//   • `dryRun` stops after a clean simulation (used to validate the live path without spending)
//
// The instruction is built with Tensor's maintained v2 builder (@tensor-foundation/marketplace,
// getBuyLegacyInstructionAsync) and adapted to a v1 TransactionInstruction. Everything the buy needs
// is read on-chain from just the mint: the ListState PDA (owner/price/makerBroker) and the mint's
// Metaplex metadata (token standard, creators, rule set, royalty). No marketplace API, no extra
// data-layer calls — this is the agent's own execution RPC, the same one token swaps already use.
'use strict';

const {
  Connection, PublicKey, TransactionInstruction, ComputeBudgetProgram,
  TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const mkt = require('@tensor-foundation/marketplace');
const bs58 = (() => { const b = require('bs58'); return b.decode ? b : b.default; })();

// Metaplex TokenStandard enum (numeric values the builder compares against). buyLegacy covers
// NonFungible + ProgrammableNonFungible (+ their Edition variants); compressed/fungible are refused.
const TokenStandard = {
  NonFungible: 0, FungibleAsset: 1, Fungible: 2,
  NonFungibleEdition: 3, ProgrammableNonFungible: 4, ProgrammableNonFungibleEdition: 5,
};

const MPL_TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TENSOR_TAKER_FEE_BPS = 150;                // ~1.5% buyer-side Tensor fee, charged on top of price
const INCIDENTAL_LAMPORTS  = 15_000_000;         // rent for the new token account + priority + slack

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [NFT-BUY] [${level.toUpperCase()}] ${line}\n`);
};

// ── Metaplex Metadata borsh walk → { tokenStandard, creators[], ruleSet, sellerFeeBps } ──────────
function parseMetadata(buf) {
  let p = 0;
  p += 1 + 32 + 32;                                       // key + updateAuthority + mint
  const skipStr = () => { const n = buf.readUInt32LE(p); p += 4 + n; };
  skipStr(); skipStr(); skipStr();                        // name, symbol, uri
  const sellerFeeBps = buf.readUInt16LE(p); p += 2;
  const creators = [];
  if (buf[p++]) { const n = buf.readUInt32LE(p); p += 4; for (let i = 0; i < n; i++) { creators.push(bs58.encode(buf.subarray(p, p + 32))); p += 34; } }
  p += 1 + 1;                                             // primarySaleHappened + isMutable
  if (buf[p++]) p += 1;                                   // editionNonce: Option<u8>
  let tokenStandard = null;
  if (buf[p++]) { tokenStandard = buf[p]; p += 1; }       // tokenStandard: Option<u8>
  if (buf[p++]) p += 33;                                  // collection: Option<{verified,key}>
  if (buf[p++]) p += 17;                                  // uses: Option<{method,remaining,total}>
  if (buf[p++]) p += 9;                                   // collectionDetails: Option<V1{size}>
  let ruleSet = null;
  if (buf[p++]) { p += 1; if (buf[p++]) { ruleSet = bs58.encode(buf.subarray(p, p + 32)); p += 32; } } // programmableConfig V1{ruleSet:Option}
  return { tokenStandard, creators, ruleSet, sellerFeeBps };
}

// v2 AccountRole bitmask → v1 flags. kit: bit0 = writable, bit1 = signer.
function roleToFlags(role) { return { isWritable: !!(role & 1), isSigner: !!(role & 2) }; }

function v2ToV1Instruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(String(ix.programAddress)),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(String(a.address)), ...roleToFlags(a.role) })),
    data: Buffer.from(ix.data),
  });
}

const optVal = (v) => (v && v.__option === 'Some' ? String(v.value) : (v && v.__option === 'None' ? null : (v == null ? null : String(v))));

class NftBuyExecutor {
  // opts: { connection, keypair, cfg, dryRun, priorityMicroLamports }
  constructor(opts = {}) {
    this.paperMode   = false;
    this.connection  = opts.connection;
    this.keypair     = opts.keypair;
    this.pubkey      = this.keypair.publicKey;
    this.dryRun      = opts.dryRun ?? false;               // true = simulate only, never submit
    this.priorityMicroLamports = opts.priorityMicroLamports ?? 50_000;
    if (!this.connection || !this.keypair) throw new Error('NftBuyExecutor needs { connection, keypair }');
    log('info', 'Live NFT executor initialized', { wallet: this.pubkey.toBase58().slice(0, 8) + '…', dryRun: this.dryRun });
  }

  // Buy a listing. `listing` = { mint, collection, collectionName, priceSol, listState? }. maxSol is a
  // SOL price ceiling (the overpay guard) applied to the on-chain listed price. Returns the same shape
  // as PaperNftExecutor.buy: { txSig, mint, collection, priceSol, solSpent, execCosts }.
  async buy(listing, maxSol) {
    const mint = listing?.mint;
    if (!mint) throw new Error('NFT buy: no mint');

    // 1) ListState — derive from mint if not supplied, then read on-chain (authoritative).
    let listStateAddr = listing.listState;
    if (!listStateAddr) { const r = await mkt.findListStatePda({ mint }); listStateAddr = Array.isArray(r) ? String(r[0]) : String(r); }
    const lsAcct = await this.connection.getAccountInfo(new PublicKey(listStateAddr), 'confirmed');
    if (!lsAcct) throw new Error(`NFT buy: ${mint.slice(0, 8)}… is not listed (no ListState)`);
    const ls = mkt.getListStateDecoder().decode(lsAcct.data);

    const currency    = optVal(ls.currency);
    const makerBroker = optVal(ls.makerBroker);
    const privateTaker = optVal(ls.privateTaker);
    const cosigner    = optVal(ls.cosigner);
    const priceLamports = BigInt(ls.amount);
    const owner       = String(ls.owner);
    const priceSol    = Number(priceLamports) / 1e9;

    // 2) Refuse cases we don't support / that would surprise the user.
    if (currency)   throw new Error(`NFT buy: listing settles in an SPL currency (${currency.slice(0, 8)}…), not native SOL — unsupported`);
    if (cosigner)   throw new Error('NFT buy: listing requires a cosigner — unsupported');
    if (privateTaker && privateTaker !== this.pubkey.toBase58()) throw new Error('NFT buy: listing is a private sale to another wallet');
    if (maxSol != null && priceSol > Number(maxSol) + 1e-9) throw new Error(`NFT buy: listed price ${priceSol} SOL > maxSol ${maxSol} (would overpay)`);

    // 3) Metadata — token standard (regular vs pNFT), creators (royalty recipients), rule set, royalty bps.
    const [metaPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), MPL_TOKEN_METADATA.toBuffer(), new PublicKey(mint).toBuffer()], MPL_TOKEN_METADATA);
    const metaAcct = await this.connection.getAccountInfo(metaPda, 'confirmed');
    if (!metaAcct) throw new Error('NFT buy: mint has no Metaplex metadata (unsupported asset)');
    const meta = parseMetadata(metaAcct.data);
    const std  = meta.tokenStandard ?? TokenStandard.NonFungible;
    const isRegular = std === TokenStandard.NonFungible || std === TokenStandard.NonFungibleEdition;
    const isPnft    = std === TokenStandard.ProgrammableNonFungible || std === TokenStandard.ProgrammableNonFungibleEdition;
    if (!isRegular && !isPnft) throw new Error(`NFT buy: token standard ${std} not supported by buyLegacy (compressed/fungible)`);

    // 4) On-chain overpay guard = price + Tensor taker fee + creator royalty, all charged on top.
    const feeRoyaltyBps = BigInt(TENSOR_TAKER_FEE_BPS + (meta.sellerFeeBps || 0));
    const maxAmount = priceLamports + (priceLamports * feeRoyaltyBps + 9999n) / 10000n + 1000n;

    // 5) Build the buyLegacy instruction (v2 builder resolves every PDA from addresses), adapt to v1.
    const input = {
      payer:   { address: this.pubkey.toBase58(), signTransactions: async (t) => t }, // only .address is read here
      owner, mint, listState: listStateAddr,
      maxAmount, tokenStandard: std, creators: meta.creators,
      makerBroker, takerBroker: null, cosigner: null,
      optionalRoyaltyPct: 100,                             // pay full royalty (required for enforced-royalty pNFTs)
    };
    if (isPnft && meta.ruleSet) input.authorizationRules = meta.ruleSet;
    const ix = v2ToV1Instruction(await mkt.getBuyLegacyInstructionAsync(input));

    // 6) Assemble the transaction: priority fee + a generous CU limit + the buy.
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: this.pubkey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityMicroLamports }),
        ix,
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    // 7) SIMULATE-FIRST + refuse-to-sign guard. The maximum this buy may remove from the wallet is the
    //    on-chain overpay ceiling plus incidental rent/priority; anything more and we don't sign.
    const maxOutLamports = Number(maxAmount) + INCIDENTAL_LAMPORTS;
    await this._assertSafeToSign(tx, { maxOutLamports, label: `buy ${mint.slice(0, 8)}…` });

    const feeRoyaltySol = Number((priceLamports * feeRoyaltyBps + 9999n) / 10000n) / 1e9;

    // 8) Dry run: a clean simulation is the whole result — never submit.
    if (this.dryRun) {
      log('info', 'DRY-RUN buy simulated clean (no submit)', { mint: mint.slice(0, 8), priceSol, standard: std });
      return { txSig: 'DRYRUN_' + mint.slice(0, 8), mint, collection: listing.collection, priceSol,
               solSpent: +(priceSol + feeRoyaltySol).toFixed(6), execCosts: { feeRoyaltySol, via: 'nft-buy-dryrun' } };
    }

    // 9) Sign + submit + confirm.
    const preLamports = await this.connection.getBalance(this.pubkey, 'confirmed');
    tx.sign([this.keypair]);
    const raw = Buffer.from(tx.serialize());
    const txSig = await this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    log('info', 'buy submitted', { mint: mint.slice(0, 8), txSig });
    await this._confirm(txSig, blockhash, lastValidBlockHeight);

    // Actual cost = wallet balance delta (falls back to the estimate if the RPC read fails).
    let solSpent = +(priceSol + feeRoyaltySol).toFixed(6);
    try { const post = await this.connection.getBalance(this.pubkey, 'confirmed'); if (post != null) solSpent = +((preLamports - post) / 1e9).toFixed(6); } catch {}

    log('info', 'buy confirmed', { mint: mint.slice(0, 8), priceSol, solSpent, txSig });
    return { txSig, mint, collection: listing.collection, priceSol, solSpent, execCosts: { feeRoyaltySol, via: 'tensor-buyLegacy' } };
  }

  // Fee-payer + simulate-first guard (mirrors swap.js._assertSafeToSign). Throws on a failed
  // simulation (no funds move) or an outflow above the allowed ceiling. Simulate-first is the point:
  // a buy that would revert on-chain never gets signed, and a buy that would overspend is refused.
  async _assertSafeToSign(tx, { maxOutLamports, label }) {
    const payer = tx.message?.staticAccountKeys?.[0];       // v0 message: fee payer is the first static key
    if (!payer?.equals?.(this.pubkey)) throw new Error(`refusing to sign ${label}: fee payer is not this wallet`);
    let pre, sim;
    try {
      [pre, sim] = await Promise.all([
        this.connection.getBalance(this.pubkey, 'confirmed'),
        this.connection.simulateTransaction(tx, {
          sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: [this.pubkey.toBase58()] },
        }),
      ]);
    } catch (e) {
      throw new Error(`refusing to sign ${label}: simulation unavailable (${e.message})`);
    }
    if (sim?.value?.err) {
      const logs = (sim.value.logs || []).filter(l => /Error|failed|insufficient/i.test(l)).slice(-3).join(' | ');
      throw new Error(`refusing to sign ${label}: simulation failed (${JSON.stringify(sim.value.err)})${logs ? ' — ' + logs : ''}`);
    }
    const post = sim?.value?.accounts?.[0]?.lamports;
    if (post != null && pre != null) {
      const outflow = pre - post;
      if (outflow > maxOutLamports) {
        throw new Error(`refusing to sign ${label}: removes ${(outflow / 1e9).toFixed(4)} SOL, more than the ${(maxOutLamports / 1e9).toFixed(4)} SOL ceiling`);
      }
      log('info', 'pre-sign check passed', { label, outflowSol: (outflow / 1e9).toFixed(6) });
    }
  }

  async _confirm(signature, blockhash, lastValidBlockHeight) {
    const res = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res?.value?.err) throw new Error(`buy tx failed on-chain: ${JSON.stringify(res.value.err)}`);
    return true;
  }
}

module.exports = { NftBuyExecutor };

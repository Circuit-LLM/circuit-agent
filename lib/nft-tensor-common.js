// lib/nft-tensor-common.js — shared Tensor helpers for the NFT buy/sell executors.
//
// Both nft-buy.js and nft-sell.js build a Tensor v2 instruction (@tensor-foundation/marketplace)
// and adapt it to a v1 web3.js TransactionInstruction, and both need to read a mint's Metaplex
// metadata (token standard / creators / rule set / royalty). That common surface lives here so the
// two executors stay in lockstep. ⚠️ the v2 builder pulls its own web3.js v2 (nested under the
// marketplace package); the agent stays on v1 — the two coexist, don't cross-import them.
'use strict';

const { PublicKey } = require('@solana/web3.js');
const mkt = require('@tensor-foundation/marketplace');
const bs58 = (() => { const b = require('bs58'); return b.decode ? b : b.default; })();

const MPL_TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TENSOR_TAKER_FEE_BPS = 150;                // ~1.5% Tensor fee, charged on top of price / taken from proceeds

// Metaplex TokenStandard enum (numeric values the builder compares against). buyLegacy/listLegacy/
// takeBidLegacy cover NonFungible + ProgrammableNonFungible (+ Edition variants); the rest are refused.
const TokenStandard = {
  NonFungible: 0, FungibleAsset: 1, Fungible: 2,
  NonFungibleEdition: 3, ProgrammableNonFungible: 4, ProgrammableNonFungibleEdition: 5,
};
const isRegular = (std) => std === TokenStandard.NonFungible || std === TokenStandard.NonFungibleEdition;
const isPnft    = (std) => std === TokenStandard.ProgrammableNonFungible || std === TokenStandard.ProgrammableNonFungibleEdition;

// Metaplex Metadata borsh walk → { tokenStandard, creators[], ruleSet, sellerFeeBps }.
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

// Read + parse a mint's metadata (throws if the mint has none — an unsupported asset).
async function readMetadata(connection, mint) {
  const [metaPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA.toBuffer(), new PublicKey(mint).toBuffer()], MPL_TOKEN_METADATA);
  const acct = await connection.getAccountInfo(metaPda, 'confirmed');
  if (!acct) throw new Error('mint has no Metaplex metadata (unsupported asset)');
  return parseMetadata(acct.data);
}

// v2 AccountRole bitmask → v1 flags. kit: bit0 = writable, bit1 = signer.
const roleToFlags = (role) => ({ isWritable: !!(role & 1), isSigner: !!(role & 2) });

function v2ToV1Instruction(ix) {
  const { TransactionInstruction } = require('@solana/web3.js');
  return new TransactionInstruction({
    programId: new PublicKey(String(ix.programAddress)),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(String(a.address)), ...roleToFlags(a.role) })),
    data: Buffer.from(ix.data),
  });
}

// Unwrap an @tensor-foundation Option value (Some/None) or a plain value → string|null.
const optVal = (v) => (v && v.__option === 'Some' ? String(v.value) : (v && v.__option === 'None' ? null : (v == null ? null : String(v))));

module.exports = {
  mkt, bs58, MPL_TOKEN_METADATA, TENSOR_TAKER_FEE_BPS, TokenStandard,
  isRegular, isPnft, parseMetadata, readMetadata, roleToFlags, v2ToV1Instruction, optVal,
};

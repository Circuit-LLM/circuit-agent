#!/usr/bin/env node
// scripts/close-empty-accounts.js — Reclaim rent SOL from empty token accounts
//
// Finds all SPL and Token-2022 token accounts with zero balance and closes
// them, returning ~0.002 SOL per account back to your wallet.
//
// Usage:
//   node scripts/close-empty-accounts.js             # Close all empty accounts
//   node scripts/close-empty-accounts.js --dry-run   # Preview without closing
//   node scripts/close-empty-accounts.js --keep MINT # Keep a specific mint (repeatable)
'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const fs   = require('fs');
const path = require('path');

// ── Load .env ────────────────────────────────────────────────────────────────

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const keepMints = new Set();
process.argv.forEach((a, i) => { if (a === '--keep' && process.argv[i + 1]) keepMints.add(process.argv[i + 1]); });

const {
  Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  createCloseAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58').default ?? require('bs58');

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const key = process.env.AGENT_KEYPAIR;
  if (!key) { console.error('AGENT_KEYPAIR not set in .env'); process.exit(1); }

  const rpc    = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const kp     = Keypair.fromSecretKey(bs58.decode(key));
  const conn   = new Connection(rpc, { commitment: 'confirmed' });
  const owner  = kp.publicKey;

  console.log(`\nClose empty token accounts${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`Wallet: ${owner.toBase58()}\n`);

  // Collect all zero-balance accounts across both token programs
  const toClose = [];
  for (const [programId, label] of [[TOKEN_PROGRAM_ID, 'SPL'], [TOKEN_2022_PROGRAM_ID, 'Token-2022']]) {
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { pubkey, account } of resp.value) {
      const info = account.data.parsed?.info;
      if (!info) continue;
      const amount = BigInt(info.tokenAmount?.amount ?? '0');
      const mint   = info.mint;
      if (amount === BigInt(0) && !keepMints.has(mint)) {
        toClose.push({ pubkey, mint, programId, label });
      }
    }
  }

  if (!toClose.length) {
    console.log('No empty accounts found — nothing to close.\n');
    return;
  }

  const rentPerAccount = 0.00203928; // SOL
  const totalRecoverable = (toClose.length * rentPerAccount).toFixed(6);

  console.log(`Found ${toClose.length} empty account(s) — ~${totalRecoverable} SOL recoverable:\n`);
  toClose.forEach(a => console.log(`  ${a.pubkey.toBase58().slice(0, 12)}…  mint: ${a.mint.slice(0, 12)}…  (${a.label})`));

  if (DRY_RUN) {
    console.log('\nDry run — no accounts closed. Run without --dry-run to apply.\n');
    return;
  }

  console.log('\nClosing accounts...\n');

  // Close in batches of 10 (tx size limit)
  const BATCH = 10;
  let closed = 0;
  for (let i = 0; i < toClose.length; i += BATCH) {
    const batch = toClose.slice(i, i + BATCH);
    const tx    = new Transaction();
    for (const { pubkey, programId } of batch) {
      tx.add(createCloseAccountInstruction(pubkey, owner, owner, [], programId));
    }
    try {
      const sig = await conn.sendTransaction(tx, [kp]);
      await conn.confirmTransaction(sig, 'confirmed');
      closed += batch.length;
      console.log(`  Closed ${batch.length} account(s) — tx: ${sig.slice(0, 20)}…`);
    } catch (e) {
      console.error(`  Batch failed: ${e.message}`);
    }
  }

  const balAfter = await conn.getBalance(owner);
  console.log(`\n✓ Closed ${closed}/${toClose.length} accounts`);
  console.log(`  Wallet balance: ${(balAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

// lib/wallet.js — Solana wallet management for circuit-agent
// Loads keypair from AGENT_KEYPAIR env var (base58 private key).
// Tracks SOL + CIRCUIT (Token-2022) balances.
// Falls back to public RPCs when the primary (Helius) hits its daily credit cap.
'use strict';

const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');
const fs   = require('fs');

const { CIRCUIT_MINT, TOKEN2022_PID } = require('./circuit');
const TOKEN2022 = new PublicKey(TOKEN2022_PID);

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [WALLET] [${level.toUpperCase()}] ${line}\n`);
};

// Public RPC fallbacks used when the primary (Helius) hits its daily credit cap.
// Tried in order until one succeeds.
const FALLBACK_RPCS = [
  process.env.CIRCUIT_GATEKEEPER_RPC_URL,  // Circuit's own RPC aggregator, when configured
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
].filter(Boolean);

const isRateLimited = (err) =>
  err.message.includes('429') ||
  err.message.includes('Too Many Requests') ||
  err.message.includes('max usage');

class WalletManager {
  constructor(rpcUrl, privateKeyBase58) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    this.fallbacks  = FALLBACK_RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, wsEndpoint: 'wss://0.0.0.0:1' }));
    this.keypair    = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.publicKey  = this.keypair.publicKey;
    this.address    = this.publicKey.toBase58();
    log('info', 'Wallet loaded', { address: this.address.slice(0, 8) + '…' });
  }

  // Tries the primary RPC first; on 429/max-usage falls through each fallback in order.
  async _withFallback(fn) {
    const conns = [this.connection, ...this.fallbacks];
    let lastErr;
    for (const conn of conns) {
      try {
        return await fn(conn);
      } catch (err) {
        lastErr = err;
        if (!isRateLimited(err)) throw err; // non-429 — don't try another RPC
        log('warn', 'RPC rate limited — trying fallback', { rpc: conn.rpcEndpoint.split('?')[0] });
      }
    }
    throw lastErr;
  }

  // ── SOL balance ─────────────────────────────────────────────────────────────

  async getSolBalance() {
    try {
      return await this._withFallback(async (conn) => {
        const lamports = await conn.getBalance(this.publicKey, 'confirmed');
        return lamports / LAMPORTS_PER_SOL;
      });
    } catch (err) {
      log('warn', 'getSolBalance failed', { error: err.message });
      throw err;
    }
  }

  // ── CIRCUIT balance (Token-2022) ──────────────────────────────────────────────

  async getCircuitBalance() {
    try {
      return await this._withFallback(async (conn) => {
        const mint     = new PublicKey(CIRCUIT_MINT);
        const accounts = await conn.getTokenAccountsByOwner(
          this.publicKey,
          { mint },
          { programId: TOKEN2022 },
        );
        if (!accounts.value.length) return 0;
        const info = await conn.getTokenAccountBalance(
          accounts.value[0].pubkey, 'confirmed',
        );
        return parseFloat(info.value.uiAmount ?? 0);
      });
    } catch (err) {
      log('warn', 'CIRCUIT balance check failed', { error: err.message });
      return 0;
    }
  }

  // ── All balances snapshot ───────────────────────────────────────────────────

  async getBalances() {
    const [sol, circuit] = await Promise.all([
      this.getSolBalance(),
      this.getCircuitBalance(),
    ]);
    return { sol, circuit, address: this.address };
  }

  // ── Summary log ────────────────────────────────────────────────────────────

  async logBalances() {
    const b = await this.getBalances();
    log('info', 'Balances', {
      sol:   b.sol.toFixed(4) + ' SOL',
      circuit: b.circuit.toLocaleString() + ' CIRCUIT',
    });
    return b;
  }

  // ── Check minimum balances ─────────────────────────────────────────────────

  async checkMinimums(cfg) {
    const b = await this.getBalances();
    const warnings = [];

    if (b.sol < (cfg.survival?.minSolWarning ?? 0.03)) {
      warnings.push(`LOW SOL: ${b.sol.toFixed(4)} SOL — agent needs SOL for tx fees and trades`);
    }
    if (b.circuit < (cfg.circuit?.minCircuitBalance ?? 5000)) {
      warnings.push(`LOW CIRCUIT: ${b.circuit.toLocaleString()} — top up to pay for API calls`);
    }
    return { balances: b, warnings };
  }
}

// ── Load from env / file ─────────────────────────────────────────────────────

function loadWallet(rpcUrl) {
  const key = process.env.AGENT_KEYPAIR;
  if (!key) {
    throw new Error(
      'AGENT_KEYPAIR env var not set.\n' +
      'Set it to your base58-encoded private key:\n' +
      '  export AGENT_KEYPAIR="your-base58-private-key"\n' +
      'Or add it to your .env file.',
    );
  }
  const w = new WalletManager(rpcUrl, key);
  // Key is now decoded into w.keypair — scrub the raw string from process.env
  // so it can't be leaked via tools, scripts, or prompt injection.
  delete process.env.AGENT_KEYPAIR;
  return w;
}

module.exports = { WalletManager, loadWallet };

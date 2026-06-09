// lib/swap.js — Jupiter Ultra swap execution for circuit-agent
// Buy: SOL → token via Jupiter Ultra /order + /execute
// Sell: token → SOL via Jupiter Ultra
// Speed: Jito fast-path (tip + direct submission) with Jupiter /execute fallback
'use strict';

const { PublicKey, VersionedTransaction, Transaction, Connection,
        SystemProgram, TransactionMessage } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');

const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const ULTRA_BASE = 'https://api.jup.ag/ultra/v1';

// ── Jito constants ────────────────────────────────────────────────────────────
const JITO_ENDPOINT     = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';
const JITO_TIP_LAMPORTS = 1_000_000; // 0.001 SOL — competitive but not excessive
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1uw6nqZLDNE',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [SWAP] [${level.toUpperCase()}] ${line}\n`);
};

class SwapExecutor {
  /**
   * @param {object} opts
   *   keypair        — Solana keypair
   *   connection     — Connection (Helius RPC)
   *   jupApiKey      — optional Jupiter API key (higher rate limits)
   *   slippageBps    — default slippage (100 = 1%)
   *   priorityLevel  — Jupiter priority fee level: "none"|"low"|"medium"|"high"|"veryHigh" (default "high")
   *   jitoEnabled    — use Jito fast-path for submission (default true)
   *   jitoTipLamports— Jito tip amount in lamports (default 1_000_000 = 0.001 SOL)
   */
  constructor(opts) {
    this.keypair          = opts.keypair;
    this.connection       = opts.connection;
    this.jupApiKey        = opts.jupApiKey ?? '';
    this.slippageBps      = opts.slippageBps ?? 100;
    this.pubkey           = this.keypair.publicKey.toBase58();
    this.priorityLevel    = opts.priorityLevel    ?? 'high';
    this.jitoEnabled      = opts.jitoEnabled      ?? true;
    this.jitoTipLamports  = opts.jitoTipLamports  ?? JITO_TIP_LAMPORTS;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.jupApiKey) h['x-api-key'] = this.jupApiKey;
    return h;
  }

  // ── Get order quote ─────────────────────────────────────────────────────────

  async _getOrder(inputMint, outputMint, amount, slippageBps, priorityOverride = null) {
    const levels = priorityOverride
      ? [priorityOverride]
      : [this.priorityLevel, 'medium', 'low'];

    for (const level of levels) {
      const url = `${ULTRA_BASE}/order?` + new URLSearchParams({
        inputMint,
        outputMint,
        amount:        amount.toString(),
        slippageBps:   slippageBps.toString(),
        taker:         this.pubkey,
        priorityLevel: level,
      });
      const resp = await fetch(url, { headers: this._headers(), signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Jupiter order ${resp.status}: ${body.slice(0, 200)}`);
      }
      const order = await resp.json();
      // Retry with lower priority if fees exceed wallet balance
      if (order.error === 'Insufficient funds' && levels.indexOf(level) < levels.length - 1) {
        log('warn', `Order insufficient funds at priority=${level}, retrying with lower priority`);
        continue;
      }
      if (!order.transaction) throw new Error(`Jupiter order error: ${order.error ?? order.errorMessage ?? 'no transaction'}`);
      return order;
    }
    throw new Error('Jupiter order failed at all priority levels');
  }

  // ── Execute order via Jupiter (standard path) ──────────────────────────────

  async _executeOrder(order) {
    // Deserialize + sign — Jupiter Ultra usually returns VersionedTransaction,
    // but occasionally returns a legacy Transaction for simple routes.
    const txBytes = Buffer.from(order.transaction, 'base64');
    let tx;
    try {
      tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([this.keypair]);
    } catch {
      tx = Transaction.from(txBytes);
      tx.partialSign(this.keypair);
    }

    const resp = await fetch(`${ULTRA_BASE}/execute`, {
      method:  'POST',
      headers: this._headers(),
      body:    JSON.stringify({
        signedTransaction: Buffer.from(tx.serialize()).toString('base64'),
        requestId:         order.requestId,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Jupiter execute ${resp.status}: ${body.slice(0, 200)}`);
    }
    const result = await resp.json();
    if (result.status !== 'Success') {
      throw new Error(`Swap failed: ${result.error ?? result.status}`);
    }
    return result;
  }

  // ── Jito fast path ─────────────────────────────────────────────────────────

  // Append a SOL tip transfer to the Jupiter-built transaction, recompile, return signed tx bytes.
  // Throws for legacy transactions — caller catches and falls back to _executeOrder().
  async _buildJitoTx(orderTransaction) {
    const txBytes = Buffer.from(orderTransaction, 'base64');
    // Legacy transactions can't be decompiled for Jito tip injection — let caller fall back
    const tx = VersionedTransaction.deserialize(txBytes);

    // Resolve address lookup tables (V0 messages may use them)
    let lookupTableAccounts = [];
    if (tx.message.addressTableLookups?.length > 0) {
      const resolved = await Promise.all(
        tx.message.addressTableLookups.map(l =>
          this.connection.getAddressLookupTable(l.accountKey)
        )
      );
      lookupTableAccounts = resolved.map(r => r.value).filter(Boolean);
    }

    // Decompile → add tip → recompile
    const decompiled = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookupTableAccounts });
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    decompiled.instructions.push(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey:   new PublicKey(tipAccount),
        lamports:   this.jitoTipLamports,
      })
    );

    const newMessage = decompiled.compileToV0Message(lookupTableAccounts);
    const newTx      = new VersionedTransaction(newMessage);
    newTx.sign([this.keypair]);
    return newTx.serialize();
  }

  // Submit a signed transaction to Jito's block-engine. Returns signature immediately.
  async _submitViaJito(signedTxBytes) {
    const txBase58 = bs58.encode(signedTxBytes);
    const resp = await fetch(JITO_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'sendTransaction',
        params:  [txBase58, { encoding: 'base58', skipPreFlight: true }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`Jito HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(`Jito RPC: ${data.error.message ?? JSON.stringify(data.error)}`);
    return data.result; // base58 signature
  }

  // Fetch actual SOL delta for our wallet from a confirmed transaction.
  // Used to correct Jito sell P&L — Jito confirmation returns quote amounts, not executed amounts.
  // Returns lamports (positive = received, negative = spent) or null on any RPC failure.
  async _fetchActualSolDelta(signature) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment:                     'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) return null;
      const accounts     = tx.transaction?.message?.accountKeys ?? [];
      const preBalances  = tx.meta.preBalances  ?? [];
      const postBalances = tx.meta.postBalances ?? [];
      const walletAddr   = this.keypair.publicKey.toBase58();
      const idx = accounts.findIndex(a => (a.pubkey?.toBase58?.() ?? String(a)) === walletAddr);
      if (idx === -1) return null;
      const rawDelta = postBalances[idx] - preBalances[idx];
      // rawDelta = solFromSwap - jitoTip - txFee (both are costs paid by our wallet).
      // Add them back to recover the actual SOL proceeds from the swap itself.
      // jitoTipLamports is known; txFee is in tx.meta.fee (~5000 lamports).
      const txFee = tx.meta.fee ?? 0;
      return rawDelta + this.jitoTipLamports + txFee;
    } catch {
      return null;
    }
  }

  // Fetch token decimals directly from the mint account — works even before the agent's
  // token account is created/indexed. More reliable than getTokenBalance for a freshly bought mint.
  async getMintDecimals(mint) {
    try {
      const { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
      const mintPk = new PublicKey(mint);
      for (const prog of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
        try {
          const info = await getMint(this.connection, mintPk, 'confirmed', prog);
          if (info.decimals > 0) return info.decimals;
        } catch { /* try next program */ }
      }
    } catch { /* spl-token unavailable or other error */ }
    return null;
  }

  // Poll Helius RPC for transaction confirmation. Throws if tx fails or times out.
  async _awaitConfirm(signature, maxWaitMs = 30_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const resp   = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: false });
        const status = resp?.value;
        if (!status) continue;
        if (status.err) throw new Error(`Tx failed on-chain: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return signature;
        }
      } catch (e) {
        if (e.message.startsWith('Tx failed')) throw e;
        // transient RPC error — keep polling
      }
    }
    throw new Error('Jito confirmation timeout (30s)');
  }

  /**
   * Execute a swap with the Jito fast-path, falling back to Jupiter /execute.
   *
   * For sells (allowParallel=true):
   *   Submits via Jito AND Jupiter /execute simultaneously.
   *   Both target the same token balance — only one can land on-chain.
   *   First confirmed result wins; the other fails gracefully.
   *
   * For buys (allowParallel=false, default):
   *   Tries Jito first; falls back to Jupiter /execute on failure.
   *   Parallel not used for buys to prevent double-buy.
   */
  async _executeOrderFast(order, { allowParallel = false } = {}) {
    if (!this.jitoEnabled) return this._executeOrder(order);

    let jitoTxBytes;
    try {
      jitoTxBytes = await this._buildJitoTx(order.transaction);
    } catch (err) {
      log('warn', 'Jito tx build failed, falling back to Jupiter', { error: err.message });
      return this._executeOrder(order);
    }

    const jitoPath = () =>
      this._submitViaJito(jitoTxBytes)
        .then(sig => {
          log('info', 'Jito submitted', { sig: sig.slice(0, 16) + '…' });
          return this._awaitConfirm(sig);
        })
        .then(sig => ({
          signature:    sig,
          status:       'Success',
          // NOTE: Jito confirmation does not return the actual executed amounts — these are
          // the order quote values. Actual amounts may differ by up to slippageBps/100 (default 1%).
          // For the Jupiter path, /execute returns confirmed amounts. The discrepancy affects
          // solReceived precision for reinvest sizing (max ~0.0001 SOL on a 0.01 SOL position).
          inputAmount:  order.inAmount,
          outputAmount: order.outAmount,
          _via:         'jito',
        }));

    const jupiterPath = () =>
      this._executeOrder(order)
        .then(r => ({ ...r, _via: 'jupiter' }));

    if (allowParallel) {
      // Race both paths — first confirmed wins
      const result = await Promise.any([jitoPath(), jupiterPath()]).catch(agg => {
        const msgs = agg.errors?.map(e => e.message).join('; ') ?? agg.message;
        throw new Error(`All execution paths failed: ${msgs}`);
      });
      log('info', `Swap landed via ${result._via}`);
      return result;
    } else {
      // Sequential: Jito first, Jupiter fallback
      try {
        const result = await jitoPath();
        log('info', 'Swap landed via jito');
        return result;
      } catch (err) {
        log('warn', 'Jito path failed, falling back to Jupiter', { error: err.message });
        return this._executeOrder(order);
      }
    }
  }

  // ── Buy: SOL → token ────────────────────────────────────────────────────────

  /**
   * Buy a token using SOL.
   * @param {string} mint       — token mint address
   * @param {number} solAmount  — amount of SOL to spend
   * @returns {{ txSig, inAmount, outAmount, pricePerToken, mint }}
   */
  async buy(mint, solAmount) {
    const lamports = Math.floor(solAmount * 1e9);
    log('info', 'Buy order', { mint: mint.slice(0, 8) + '…', sol: solAmount });

    const order  = await this._getOrder(SOL_MINT, mint, lamports, this.slippageBps);
    const result = await this._executeOrderFast(order, { allowParallel: false });

    const inLamports  = Number(result.inputAmount  ?? order.inAmount  ?? 0);
    const outTokens   = Number(result.outputAmount ?? order.outAmount ?? 0);
    const solSpent    = inLamports / 1e9;

    log('info', 'Buy executed', {
      txSig:     result.signature?.slice(0, 16) + '…',
      solSpent:  solSpent.toFixed(6),
      tokensOut: outTokens,
    });

    return {
      txSig:         result.signature,
      inAmount:      solSpent,
      outAmount:     outTokens,
      pricePerToken: outTokens > 0 ? solSpent / outTokens : null,
      mint,
    };
  }

  // ── Sell: token → SOL ───────────────────────────────────────────────────────

  /**
   * Sell a percentage of a held token position.
   * @param {string} mint        — token mint address
   * @param {number} tokenAmount — raw token amount (atomic units)
   * @param {number} pct         — fraction to sell (0–1, default 1 = 100%)
   * @returns {{ txSig, inAmount, outAmount, solReceived }}
   */
  async sell(mint, tokenAmount, pct = 1) {
    const sellAmount = Math.floor(tokenAmount * pct);
    if (sellAmount === 0) throw new Error('Sell amount is 0');

    log('info', 'Sell order', { mint: mint.slice(0, 8) + '…', pct: (pct * 100).toFixed(0) + '%' });

    const order  = await this._getOrder(mint, SOL_MINT, sellAmount, this.slippageBps);
    const result = await this._executeOrderFast(order, { allowParallel: true }); // parallel: fastest exit

    let outLamports = Number(result.outputAmount ?? order.outAmount ?? 0);

    // Jito path returns quote amounts — fetch actual SOL delta from the confirmed tx.
    // Jito and Jupiter /execute differ by up to slippageBps/100% (default 1%) per trade.
    // Fixing this makes per-trade P&L, reinvestment sizing, and swarm reputation accurate.
    if (result._via === 'jito' && result.signature) {
      const delta = await this._fetchActualSolDelta(result.signature);
      if (delta != null && delta > 0) {
        log('info', `Jito sell: actual ${(delta/1e9).toFixed(6)} SOL (quote ${(outLamports/1e9).toFixed(6)} SOL)`, { diff: ((delta - outLamports) / 1e9).toFixed(6) });
        outLamports = delta;
      } else {
        log('warn', 'Jito sell: could not fetch actual SOL delta — using quote amount', { sig: result.signature?.slice(0, 16) });
      }
    }

    const solReceived = outLamports / 1e9;

    log('info', 'Sell executed', {
      txSig:       result.signature?.slice(0, 16) + '…',
      solReceived: solReceived.toFixed(6),
      via:         result._via ?? 'jupiter',
    });

    return {
      txSig:       result.signature,
      inAmount:    sellAmount,
      outAmount:   outLamports,
      solReceived,
    };
  }

  // ── Get token balance ──────────────────────────────────────────────────────

  async getTokenBalance(mint) {
    try {
      const mintPk = new PublicKey(mint);
      // Try standard Token program first, then Token-2022
      for (const programId of [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      ]) {
        const accounts = await this.connection.getTokenAccountsByOwner(
          this.keypair.publicKey,
          { mint: mintPk },
          { programId: new PublicKey(programId) },
        );
        if (accounts.value.length) {
          const info = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
          return {
            rawAmount: BigInt(info.value.amount),
            uiAmount:  parseFloat(info.value.uiAmount ?? 0),
            decimals:  info.value.decimals,
            ataAddress: accounts.value[0].pubkey.toBase58(),
          };
        }
      }
      return { rawAmount: BigInt(0), uiAmount: 0, decimals: 0, ataAddress: null };
    } catch (err) {
      log('warn', 'Token balance check failed', { mint: mint.slice(0, 8), error: err.message });
      return { rawAmount: BigInt(0), uiAmount: 0, decimals: 0, ataAddress: null };
    }
  }
}

module.exports = { SwapExecutor, SOL_MINT };

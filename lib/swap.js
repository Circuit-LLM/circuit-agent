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

// Headroom for what a legitimate swap can cost BEYOND the SOL being swapped: network +
// priority fee, ATA rent (~0.00204), wSOL wrap/unwrap. Deliberately generous — this bound
// exists to catch a drained wallet, not to police fees.
const MAX_INCIDENTAL_LAMPORTS = 30_000_000; // 0.03 SOL
const MAX_SLIPPAGE_BPS        = 5_000;      // 50% — past this a "swap" is a donation

// slippageBps arrives from a DB setting written out of client-supplied callback data, so an
// out-of-range value must be clamped here rather than forwarded to Jupiter verbatim.
const clampBps = (v, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.max(Math.round(n), 1), MAX_SLIPPAGE_BPS);
};
// Jupiter requires 50–255. Refuse an out-of-range fee instead of skimming the trade with it.
const validFeeBps = (v) => {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 50 && n <= 255) return n;
  log('warn', `referralFeeBps ${v} outside Jupiter's 50-255 range — integrator fee DISABLED`);
  return null;
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
    this.slippageBps      = clampBps(opts.slippageBps, 100);
    this.pubkey           = this.keypair.publicKey.toBase58();
    this.priorityLevel    = opts.priorityLevel    ?? 'high';
    this.jitoEnabled      = opts.jitoEnabled      ?? true;
    this.jitoTipLamports  = opts.jitoTipLamports  ?? JITO_TIP_LAMPORTS;
    // Dynamic tip: size the tip to the trade instead of a flat 0.001 SOL. At 0.005 SOL
    // entries the flat tip alone was ~20% of the position — across the swarm's recent
    // window, fees ran 2.4x the gross P&L. clamp(solSide * tipPct, tipMin, tipMax).
    this.dynamicTip       = opts.dynamicTip       ?? true;
    this.tipPct           = opts.tipPct           ?? 0.02;      // 2% of the SOL side
    this.tipMinLamports   = opts.tipMinLamports   ?? 200_000;   // 0.0002 SOL inclusion floor
    this.tipMaxLamports   = opts.tipMaxLamports   ?? this.jitoTipLamports;
    // Optional Jupiter Ultra integrator fee. OFF unless BOTH are set — the swarm agents
    // don't pass these, so their trades stay fee-free. referralFeeBps must be 50–255.
    this.referralAccount  = opts.referralAccount  ?? null;
    this.referralFeeBps   = validFeeBps(opts.referralFeeBps);
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
      const params = {
        inputMint,
        outputMint,
        amount:        amount.toString(),
        slippageBps:   slippageBps.toString(),
        taker:         this.pubkey,
        priorityLevel: level,
      };
      // Integrator fee — only when configured (Telegram terminal), never for the swarm.
      if (this.referralAccount && this.referralFeeBps) {
        params.referralAccount = this.referralAccount;
        params.referralFee     = String(this.referralFeeBps);
      }
      const url = `${ULTRA_BASE}/order?` + new URLSearchParams(params);
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

  // ── Pre-sign guard ─────────────────────────────────────────────────────────

  // Jupiter hands us a fully-built transaction and we sign it with the owner's key. Without a
  // check here, a compromised or MITM'd /order response IS a signed drain — and this executor
  // backs a custodial bot, so one bad response window would hit every user who traded during
  // it. Verify the fee payer is us, then simulate and refuse if our SOL outflow exceeds what
  // this trade could legitimately cost.
  //
  // Enforcement is deliberately conditioned on a CLEAN simulation. A transaction that fails
  // simulation moves no funds, so letting it through costs nothing — while a drain has to
  // simulate successfully to be worth anything to an attacker. That asymmetry is what lets
  // this guard be strict without ever rejecting a trade that would otherwise have succeeded.
  async _assertSafeToSign(order, { maxSolOutLamports, label }) {
    let tx;
    try { tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64')); }
    catch { return; } // legacy tx — no v0 message to inspect; _executeOrder's legacy branch handles it

    const keys  = tx.message.staticAccountKeys ?? tx.message.accountKeys ?? [];
    const payer = keys[0];
    if (!payer?.equals?.(this.keypair.publicKey)) {
      throw new Error(`refusing to sign ${label}: fee payer ${payer?.toBase58?.().slice(0, 8)}… is not this wallet`);
    }

    let pre, sim;
    try {
      [pre, sim] = await Promise.all([
        this.connection.getBalance(this.keypair.publicKey, 'confirmed'),
        this.connection.simulateTransaction(tx, {
          sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: [this.pubkey] },
        }),
      ]);
    } catch (e) {
      log('warn', 'pre-sign simulation unavailable — proceeding on fee-payer check alone', { error: e.message });
      return;
    }
    if (sim?.value?.err) return;                        // would fail on-chain anyway; no funds can move
    const post = sim?.value?.accounts?.[0]?.lamports;
    if (post == null || pre == null) return;            // RPC gave us nothing to compare — don't block the trade

    const outflow = pre - post;
    if (outflow > maxSolOutLamports) {
      throw new Error(`refusing to sign ${label}: transaction removes ${(outflow / 1e9).toFixed(4)} SOL from this wallet, ` +
                      `more than the ${(maxSolOutLamports / 1e9).toFixed(4)} SOL this trade should cost`);
    }
    log('info', 'pre-sign check passed', { label, outflowSol: (outflow / 1e9).toFixed(6) });
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
  _computeTipLamports(solLamports) {
    if (!this.dynamicTip || !Number.isFinite(solLamports) || solLamports <= 0) return this.jitoTipLamports;
    const raw = Math.round(solLamports * this.tipPct);
    return Math.max(this.tipMinLamports, Math.min(this.tipMaxLamports, raw));
  }

  async _buildJitoTx(orderTransaction, tipLamports = this.jitoTipLamports) {
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
        lamports:   tipLamports,
      })
    );

    const newMessage = decompiled.compileToV0Message(lookupTableAccounts);
    const newTx      = new VersionedTransaction(newMessage);
    newTx.sign([this.keypair]);
    // Hand back the blockhash too: once this tx is broadcast it stays landable until that
    // blockhash dies, and the caller must not sign a second one over the same intent before then.
    return { bytes: newTx.serialize(), blockhash: newMessage.recentBlockhash };
  }

  // A broadcast transaction is only provably dead once its blockhash can no longer be used.
  // Resolves to the signature if it lands, or null once it provably cannot — so the caller is
  // never free to re-sign while the first tx is still live.
  async _settleSubmitted(signature, blockhash, maxWaitMs = 90_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1_000));
      const v = (await this.connection.getSignatureStatus(signature, { searchTransactionHistory: false }).catch(() => null))?.value;
      if (v?.err) return null;   // landed but failed — no swap happened, and it can't land again
      if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') return signature;
      if (blockhash) {
        const valid = await this.connection.isBlockhashValid(blockhash, { commitment: 'confirmed' }).catch(() => null);
        if (valid?.value === false) return null;  // blockhash dead — this tx can never land
      }
    }
    return null; // outlasted the blockhash lifetime; nothing can land after this
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

  // Fetch the total network fee (base + priority) paid by a confirmed transaction, in
  // lamports. Best-effort: null on any RPC failure — this only feeds cost telemetry
  // (execCosts), never blocks or fails a swap.
  async _fetchTxFeeLamports(signature) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment:                     'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      return tx?.meta?.fee ?? null;
    } catch { return null; }
  }

  // Assemble the execution-cost record for a completed swap leg. The Jito tip and network
  // fee (incl. priority) are real wallet costs deliberately EXCLUDED from solSpent /
  // solReceived (those stay swap-level gross for record continuity) — at 0.005 SOL test
  // size these costs are ~13-40% of the position, and without booking them every feedback
  // loop (reflect, plan grading, swarm reputation) optimizes a figure that hides the
  // largest cost. costSol is null-safe: the tip is always known locally, the fee may be
  // null on an RPC miss.
  _buildExecCosts(result, feeLamports) {
    const via         = result?._via ?? 'jupiter';
    const tipLamports = via === 'jito' ? (result?._tipLamports ?? this.jitoTipLamports) : 0;
    return {
      via,
      tipLamports,
      feeLamports: feeLamports ?? null,
      costSol:     (tipLamports + (feeLamports ?? 0)) / 1e9,
    };
  }

  // Fetch actual SOL delta for our wallet from a confirmed transaction.
  // Used to correct Jito sell P&L — Jito confirmation returns quote amounts, not executed amounts.
  // Returns { deltaLamports, feeLamports } or null on any RPC failure. deltaLamports has the
  // Jito tip + network fee added back (swap-level proceeds); feeLamports is surfaced so the
  // caller can book the true cost without a second RPC fetch.
  async _fetchActualSolDelta(signature, tipLamports = this.jitoTipLamports) {
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
      // Add them back to recover the actual SOL proceeds from the swap itself. The tip must be
      // the one ACTUALLY paid (dynamicTip sizes it to the trade) — adding back the flat default
      // over-reports proceeds on every small sell, and that number drives the user's P&L card.
      const txFee = tx.meta.fee ?? 0;
      return { deltaLamports: rawDelta + tipLamports + txFee, feeLamports: txFee };
    } catch {
      return null;
    }
  }

  // Actual token amount credited to our wallet by a confirmed swap, read from the tx's
  // token-balance deltas. buy() otherwise stores order.outAmount — the QUOTE — because
  // result.outputAmount is returned by neither the Jito path nor Ultra /execute. That
  // value always overshoots the real balance (measured +5,279 raw units on a Jito entry,
  // +1 on a Jupiter entry), and an overshoot makes a 100% sell fail with "Insufficient
  // funds". Returns null if the delta can't be determined — caller keeps the quote.
  async _fetchActualTokenDelta(signature, mint) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment:                     'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) return null;
      const walletAddr = this.keypair.publicKey.toBase58();
      const pick = (arr) => (arr ?? []).filter(b => b.owner === walletAddr && b.mint === mint);
      const sum  = (arr) => pick(arr).reduce((t, b) => t + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);
      const delta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
      return delta > 0n ? delta : null;
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
          if (info.decimals != null && info.decimals >= 0) return info.decimals;
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
   * Both paths sign INDEPENDENTLY VALID transactions over the same intent. They carry
   * different signatures (the Jito one has a tip appended), so Solana's dedup cannot catch a
   * duplicate — if two are ever on the wire at once, BOTH can land. Everything below exists to
   * make sure that cannot happen:
   *
   *   allowParallel=true  — only legal when the order consumes the ENTIRE balance being sold.
   *                         The loser then provably fails for insufficient funds. Racing a
   *                         PARTIAL sell would sell twice what was asked. Caller enforces this.
   *   allowParallel=false — Jito first, Jupiter only if the Jito tx never reached the wire.
   *                         Once Jito has accepted it, we wait out the blockhash instead of
   *                         signing a second transaction.
   */
  async _executeOrderFast(order, { allowParallel = false, solLamports = null } = {}) {
    if (!this.jitoEnabled) return this._executeOrder(order);

    const tipLamports = this._computeTipLamports(solLamports);
    let jitoTxBytes, jitoBlockhash;
    try {
      ({ bytes: jitoTxBytes, blockhash: jitoBlockhash } = await this._buildJitoTx(order.transaction, tipLamports));
    } catch (err) {
      log('warn', 'Jito tx build failed, falling back to Jupiter', { error: err.message });
      return this._executeOrder(order);
    }

    let submittedSig = null; // set the instant Jito accepts the tx — from then on it can land
    const jitoResult = (sig) => ({
      signature:    sig,
      status:       'Success',
      // NOTE: Jito confirmation does not return the actual executed amounts — these are
      // the order quote values. Actual amounts may differ by up to slippageBps/100 (default 1%).
      // For the Jupiter path, /execute returns confirmed amounts. The discrepancy affects
      // solReceived precision for reinvest sizing (max ~0.0001 SOL on a 0.01 SOL position).
      inputAmount:  order.inAmount,
      outputAmount: order.outAmount,
      _via:         'jito',
      _tipLamports: tipLamports,
    });

    const jitoPath = () =>
      this._submitViaJito(jitoTxBytes)
        .then(sig => {
          submittedSig = sig;
          log('info', 'Jito submitted', { sig: sig.slice(0, 16) + '…' });
          return this._awaitConfirm(sig);
        })
        .then(jitoResult);

    const jupiterPath = () =>
      this._executeOrder(order)
        .then(r => ({ ...r, _via: 'jupiter' }));

    if (allowParallel) {
      // Safe ONLY because the caller guarantees this order spends the whole balance.
      const result = await Promise.any([jitoPath(), jupiterPath()]).catch(agg => {
        const msgs = agg.errors?.map(e => e.message).join('; ') ?? agg.message;
        throw new Error(`All execution paths failed: ${msgs}`);
      });
      log('info', `Swap landed via ${result._via}`);
      return result;
    }

    try {
      const result = await jitoPath();
      log('info', 'Swap landed via jito');
      return result;
    } catch (err) {
      // A Jupiter fallback here signs a SECOND transaction. That is only safe if the first
      // never reached the wire — otherwise both stay landable until the blockhash dies and the
      // trade executes twice. A confirmation timeout is NOT evidence the tx failed.
      if (submittedSig) {
        log('warn', 'Jito submitted — settling it before any retry', { sig: submittedSig.slice(0, 16) + '…', error: err.message });
        const landed = await this._settleSubmitted(submittedSig, jitoBlockhash);
        if (landed) { log('info', 'Jito tx landed while settling'); return jitoResult(landed); }
        // _settleSubmitted only returns null once the tx PROVABLY cannot succeed — it landed and
        // failed (moving nothing), or its blockhash died. Either way a second transaction can no
        // longer double-execute, so the fallback is safe again AND still useful: the common case
        // is the Jito leg losing on slippage, where a retry through Jupiter legitimately works.
        log('info', 'Jito tx settled as dead — Jupiter fallback is safe now');
        return this._executeOrder(order);
      }
      log('warn', 'Jito path failed before submission, falling back to Jupiter', { error: err.message });
      return this._executeOrder(order);
    }
  }

  // ── Buy: SOL → token ────────────────────────────────────────────────────────

  /**
   * Buy a token using SOL.
   * @param {string} mint       — token mint address
   * @param {number} solAmount  — amount of SOL to spend
   * @returns {{ txSig, inAmount, outAmount, mint }}
   */
  async buy(mint, solAmount) {
    const lamports = Math.floor(solAmount * 1e9);
    log('info', 'Buy order', { mint: mint.slice(0, 8) + '…', sol: solAmount });

    const order  = await this._getOrder(SOL_MINT, mint, lamports, this.slippageBps);
    await this._assertSafeToSign(order, { maxSolOutLamports: lamports + MAX_INCIDENTAL_LAMPORTS, label: `buy ${mint.slice(0, 8)}…` });
    const result = await this._executeOrderFast(order, { allowParallel: false, solLamports: lamports });

    const inLamports = Number(result.inputAmount ?? order.inAmount ?? 0);
    // Keep outAmount as a string to preserve full integer precision for high-supply tokens.
    // Converting raw atomic units (can exceed 2^53) through Number() silently truncates
    // the low-order bits, producing phantom P&L errors in the monitor.
    let outTokensStr = String(result.outputAmount ?? order.outAmount ?? '0');
    // Prefer the REALISED fill over the quote. result.outputAmount is absent on both the
    // Jito path (quote values by design) and Ultra /execute (different field names), so the
    // line above lands on order.outAmount and the stored position amount ends up larger than
    // the wallet actually holds — which makes a later 100% sell fail with "Insufficient
    // funds" and drives the partial-sell ladder into a halving loop. Read the true delta
    // from the confirmed tx; keep the quote only if it cannot be determined.
    if (result.signature) {
      const actual = await this._fetchActualTokenDelta(result.signature, mint);
      if (actual != null && actual.toString() !== outTokensStr) {
        log('info', 'Buy fill corrected from quote', { quote: outTokensStr, actual: actual.toString() });
        outTokensStr = actual.toString();
      }
    }
    const solSpent     = inLamports / 1e9;

    log('info', 'Buy executed', {
      txSig:     result.signature?.slice(0, 16) + '…',
      solSpent:  solSpent.toFixed(6),
      tokensOut: outTokensStr,
    });

    const buyFee = result.signature ? await this._fetchTxFeeLamports(result.signature) : null;

    return {
      txSig:     result.signature,
      inAmount:  solSpent,
      outAmount: outTokensStr,  // raw atomic units as string — caller must divide by 10^decimals
      mint,
      execCosts: this._buildExecCosts(result, buyFee), // tip + network fee (NOT in inAmount)
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
    // Compute the exact raw sell amount in BigInt — Number(rawAmount)*pct truncates the low bits of a
    // position above ~2^53 raw units (high-supply tokens), leaving dust unsold. pct → basis points.
    const rawIn = typeof tokenAmount === 'bigint' ? tokenAmount
                : typeof tokenAmount === 'string' ? BigInt(tokenAmount.split('.')[0] || '0')
                : BigInt(Math.trunc(tokenAmount));
    const sellAmount = (rawIn * BigInt(Math.round(pct * 10000))) / 10000n;
    if (sellAmount === 0n) throw new Error('Sell amount is 0');

    log('info', 'Sell order', { mint: mint.slice(0, 8) + '…', pct: (pct * 100).toFixed(0) + '%' });

    const order  = await this._getOrder(mint, SOL_MINT, sellAmount, this.slippageBps);
    // A sell should ADD SOL; the only outflow is fees/tip/rent. Anything more is not this trade.
    await this._assertSafeToSign(order, { maxSolOutLamports: MAX_INCIDENTAL_LAMPORTS, label: `sell ${mint.slice(0, 8)}…` });
    // Race the two paths only on a full exit, where sellAmount is the entire balance and the
    // losing tx provably cannot also land. On a partial sell both would land and sell double.
    const fullExit = sellAmount === rawIn;
    const result = await this._executeOrderFast(order, { allowParallel: fullExit, solLamports: Number(order.outAmount ?? 0) });

    let outLamports = Number(result.outputAmount ?? order.outAmount ?? 0);

    // Jito path returns quote amounts — fetch actual SOL delta from the confirmed tx.
    // Jito and Jupiter /execute differ by up to slippageBps/100% (default 1%) per trade.
    // Fixing this makes per-trade P&L, reinvestment sizing, and swarm reputation accurate.
    let sellFee = null;
    if (result._via === 'jito' && result.signature) {
      const meta = await this._fetchActualSolDelta(result.signature, result._tipLamports);
      if (meta != null && meta.deltaLamports > 0) {
        log('info', `Jito sell: actual ${(meta.deltaLamports/1e9).toFixed(6)} SOL (quote ${(outLamports/1e9).toFixed(6)} SOL)`, { diff: ((meta.deltaLamports - outLamports) / 1e9).toFixed(6) });
        outLamports = meta.deltaLamports;
        sellFee     = meta.feeLamports;
      } else {
        log('warn', 'Jito sell: could not fetch actual SOL delta — using quote amount', { sig: result.signature?.slice(0, 16) });
      }
    }
    if (sellFee == null && result.signature) {
      sellFee = await this._fetchTxFeeLamports(result.signature);
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
      execCosts:   this._buildExecCosts(result, sellFee), // tip + network fee (NOT in solReceived)
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
            ok: true,
          };
        }
      }
      // No token account under either program — the wallet genuinely holds none.
      return { rawAmount: BigInt(0), uiAmount: 0, decimals: 0, ataAddress: null, ok: true };
    } catch (err) {
      // RPC failed: the balance is UNKNOWN, not zero. ok:false lets a caller that
      // must not act on a guess (monitor.js exit path) defer instead. rawAmount stays
      // 0n so existing callers that only read .decimals/.rawAmount are unaffected.
      log('warn', 'Token balance check failed', { mint: mint.slice(0, 8), error: err.message });
      return { rawAmount: BigInt(0), uiAmount: 0, decimals: 0, ataAddress: null, ok: false };
    }
  }
}

module.exports = { SwapExecutor, SOL_MINT };

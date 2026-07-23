// lib/circuit.js — CIRCUIT Data API client
// Handles x402 CIRCUIT payment automatically:
//   1. Checks /api/quote for current endpoint cost
//   2. Sends CIRCUIT to treasury via Token-2022 transfer
//   3. Calls endpoint with X-Payment-Signature header
// If API_BASE is localhost + INTERNAL_KEY set → bypasses payment (dev/same-server mode).
'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');
const crypto = require('crypto');
const { deriveFeedBase } = require('./feedBase');

// ── Swarm action signing ──────────────────────────────────────────────────────
// Every state-changing swarm/agent write is signed by the agent's wallet key so the
// server proves the caller holds the key behind the address it claims (closes the
// swarm IDOR/sybil). The signed message binds the action + address + ts + a SHA-256
// digest of the WHOLE body — MUST stay byte-identical to the server verifier
// (circuit-data-api/lib/swarmAuth.js): same canonical message + same stableStringify.
const _PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function _stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(_stableStringify).join(',') + ']';
  return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + _stableStringify(o[k])).join(',') + '}';
}
// Sign a request body for `action` with the wallet key → returns { ...body, address, ts, sig }.
// `address` must be the wallet's own public key (the identity the server resolves).
function _signSwarmBody(keypair, action, body) {
  const address = body.address;
  const ts = Date.now();
  const full = { ...body, address, ts };                       // body minus sig, with ts
  const digest = crypto.createHash('sha256').update(_stableStringify(full)).digest('hex');
  const msg = ['circuit-swarm-auth-v1', action, address || '', String(ts), digest].join('\n');
  const seed = Buffer.from(keypair.secretKey).subarray(0, 32); // Solana secretKey = seed(32)||pubkey(32)
  const key = crypto.createPrivateKey({ key: Buffer.concat([_PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { ...full, sig: crypto.sign(null, Buffer.from(msg, 'utf8'), key).toString('base64') };
}
const _SWARM_TASK_ACTIONS = new Set(['propose', 'claim', 'submit', 'verify', 'cancel', 'abandon', 'subtask']);

const CIRCUIT_MINT    = '8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump';
const TOKEN2022_PID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CIRCUIT_DECIMALS = 6;

// ── Cache ─────────────────────────────────────────────────────────────────────
let _quoteCache = null;
let _quoteTsMs  = 0;
const QUOTE_TTL = 60_000; // 1 minute

// ── Logger ────────────────────────────────────────────────────────────────────
const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [CIRCUIT] [${level.toUpperCase()}] ${line}\n`);
};

class CircuitClient {
  /**
   * @param {object} opts
   *   baseUrl     {string}  — API base URL (default: https://api.circuitllm.xyz)
   *   internalKey {string}  — X-Internal-Key for localhost bypass (self-hosted only)
   *   wallet      {object}  — { keypair, connection } — needed if actually paying
   */
  constructor(opts = {}) {
    this.baseUrl     = (opts.baseUrl ?? 'https://api.circuitllm.xyz').replace(/\/$/, '');
    this.internalKey = opts.internalKey ?? '';
    this.wallet      = opts.wallet ?? null; // { keypair, connection }
    this._isLocal    = this.baseUrl.includes('localhost') || this.baseUrl.includes('127.0.0.1');
    // circuit-price-feed base — resolved once here (same logic as lib/monitor.js) so the scanner
    // and the entry-price gate reach the SAME feed the monitor uses: localhost:18941 for co-located
    // agents, ${baseUrl}/api/price-feed (via the data-api proxy) for agents running off-box.
    this.feedBase = deriveFeedBase({ priceFeedUrl: opts.priceFeedUrl, baseUrl: this.baseUrl });
  }

  // ── Fetch helpers ───────────────────────────────────────────────────────────

  async _fetch(path, extraHeaders = {}) {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      signal:  AbortSignal.timeout(15_000),
    });
    return resp;
  }

  // ── Quote ───────────────────────────────────────────────────────────────────

  async getQuote() {
    if (_quoteCache && Date.now() - _quoteTsMs < QUOTE_TTL) return _quoteCache;
    const resp = await this._fetch('/api/quote');
    if (!resp.ok) throw new Error(`Quote ${resp.status}`);
    _quoteCache = await resp.json();
    _quoteTsMs  = Date.now();
    return _quoteCache;
  }

  // ── Call endpoint ───────────────────────────────────────────────────────────

  /**
   * Call a gated endpoint, handling payment automatically.
   * @param {string} endpointKey  — matches keys in /api/quote (e.g. 'scan', 'token-price')
   * @param {string} queryString  — e.g. '?mint=So111...&limit=20'
   * @returns {object} parsed JSON response
   */
  async call(endpointKey, queryString = '') {
    const path = `/api/${endpointKey}${queryString}`;

    // ── Localhost bypass ──────────────────────────────────────────────────────
    if (this._isLocal && this.internalKey) {
      const resp = await this._fetch(path, { 'X-Internal-Key': this.internalKey });
      if (resp.ok) return resp.json();
      if (resp.status !== 402) throw new Error(`API ${resp.status} on ${path}`);
    }

    // ── First attempt without payment (might be cached server-side) ───────────
    const first = await this._fetch(path);
    if (first.ok) return first.json();
    if (first.status !== 402) throw new Error(`API ${first.status} on ${path}`);

    // ── Need to pay ───────────────────────────────────────────────────────────
    if (!this.wallet) throw new Error('Payment required but no wallet configured');

    const quote      = await this.getQuote();
    const epInfo     = quote.endpoints?.[endpointKey];
    if (!epInfo) throw new Error(`Unknown endpoint: ${endpointKey}`);

    const circRaw  = BigInt(epInfo.circRaw);
    const treasury  = quote.payment.treasury;

    log('info', `Paying ${epInfo.circRequired} for ${endpointKey}`, {
      usd: epInfo.usdPrice,
    });

    const txSig = await this._sendCircuitPayment(treasury, circRaw);
    log('info', 'Payment sent', { txSig: txSig.slice(0, 16) + '…' });

    // ── Retry with signature ──────────────────────────────────────────────────
    const paid = await this._fetch(path, { 'X-Payment-Signature': txSig });
    if (paid.ok) return paid.json();

    // Retry once on transient server errors (5xx, 429) — CIRCUIT was already spent,
    // so a single retry is free. On permanent 4xx, fail immediately.
    // Always log the txSig so the user can investigate lost payments.
    if ([429, 500, 502, 503, 504].includes(paid.status)) {
      log('warn', `Paid call returned ${paid.status} — retrying once`, { txSig: txSig.slice(0, 16), path });
      await new Promise(r => setTimeout(r, 2000));
      const retry = await this._fetch(path, { 'X-Payment-Signature': txSig });
      if (retry.ok) return retry.json();
      const retryErr = await retry.json().catch(() => ({}));
      throw new Error(`Paid API call failed after retry ${retry.status}: ${retryErr.error ?? ''} (payment txSig: ${txSig.slice(0, 24)})`);
    }

    const errBody = await paid.json().catch(() => ({}));
    throw new Error(`Paid API call failed ${paid.status}: ${errBody.error ?? ''} (payment txSig: ${txSig.slice(0, 24)})`);
  }

  // ── x402-paid chat completion (Circuit inference gateway) ────────────────────

  /**
   * Run a chat completion through the Circuit inference gateway, paying CIRC via
   * x402 — REAL payment, no bypass: POST → 402 with payment requirements → send
   * CIRC to the treasury → retry with X-Payment-Signature. Reuses the same
   * Token-2022 payment path as data calls. The engine is plain chat (no
   * function-calling), so do NOT pass `tools`.
   *
   * @param {Array}  messages — OpenAI-style [{ role, content }]
   * @param {object} opts     — { baseUrl, model, maxTokens, temperature, timeoutMs }
   * @returns {object} { content, usage, paymentTx }
   */
  async chatCompletion(messages, opts = {}) {
    const base = (opts.baseUrl ?? 'https://inference.circuitllm.xyz/v1').replace(/\/$/, '');
    const url  = `${base}/chat/completions`;
    const body = JSON.stringify({
      model:       opts.model ?? 'circuit',
      messages,
      max_tokens:  opts.maxTokens  ?? 512,
      temperature: opts.temperature ?? 0.7,
      stream:      false,
    });
    const timeoutMs = opts.timeoutMs ?? 120_000;

    const post = (extraHeaders = {}) => fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body,
      signal:  AbortSignal.timeout(timeoutMs),
    });
    const extract = data => ({
      content: data.choices?.[0]?.message?.content?.trim() ?? '',
      usage:   data.usage ?? null,
    });

    // 1. First attempt — the gateway answers 402 with payment requirements.
    let resp = await post();
    if (resp.ok) return { ...extract(await resp.json()), paymentTx: null, cost: null };
    if (resp.status !== 402) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(`Inference ${resp.status}: ${e.error ?? ''}`);
    }

    // 2. Pay CIRC to the treasury named in the 402 body.
    if (!this.wallet) throw new Error('x402 inference requires a funded wallet (no bypass)');
    const info = await resp.json().catch(() => ({}));
    const pay  = info.payment;
    if (!pay?.recipient || !pay?.amountRaw) throw new Error('402 response missing payment requirements');
    log('info', `Paying ${pay.amountDisplay ?? pay.amountRaw} CIRC for inference`, { usd: pay.usdEquivalent });
    // Numeric only (strip any "CIRC" suffix from amountDisplay) — the UI appends the unit itself.
    const cost = { circ: String(pay.amountDisplay ?? pay.amountRaw).replace(/\s*CIRC\s*$/i, ''), usd: pay.usdEquivalent ?? null };
    const txSig = await this._sendCircuitPayment(pay.recipient, BigInt(pay.amountRaw));
    log('info', 'Inference payment sent', { txSig: txSig.slice(0, 16) + '…' });

    // 3. Retry with the signature. One free retry on transient 5xx/429 (CIRC already spent).
    resp = await post({ 'X-Payment-Signature': txSig });
    if (resp.ok) return { ...extract(await resp.json()), paymentTx: txSig, cost };
    if ([429, 500, 502, 503, 504].includes(resp.status)) {
      log('warn', `Paid inference returned ${resp.status} — retrying once`, { txSig: txSig.slice(0, 16) });
      await new Promise(r => setTimeout(r, 2000));
      resp = await post({ 'X-Payment-Signature': txSig });
      if (resp.ok) return { ...extract(await resp.json()), paymentTx: txSig, cost };
    }
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(`Paid inference failed ${resp.status}: ${errBody.error ?? errBody.reason ?? ''} (payment txSig: ${txSig.slice(0, 24)})`);
  }

  // ── CIRCUIT balance check ───────────────────────────────────────────────────
  // Used before any escrow deposit to fail fast with a clear error rather than
  // letting the on-chain transfer fail with a cryptic SPL error.

  async _getCircuitBalance() {
    if (!this.wallet) return 0;
    const { keypair, connection } = this.wallet;
    const mint     = new PublicKey(CIRCUIT_MINT);
    const prog     = new PublicKey(TOKEN2022_PID);
    const { getAssociatedTokenAddressSync } = await _loadSplToken();
    const ata = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, prog);
    try {
      const info = await connection.getTokenAccountBalance(ata, 'confirmed');
      return parseFloat(info.value.uiAmount ?? 0);
    } catch {
      return 0; // account doesn't exist — no CIRCUIT held
    }
  }

  // ── Token-2022 CIRCUIT transfer ─────────────────────────────────────────────

  async _sendCircuitPayment(treasuryAddress, amountRaw) {
    const { keypair, connection } = this.wallet;

    // Lazily load spl-token functions (not bundled — use raw instructions)
    const sender   = keypair.publicKey;
    const treasury = new PublicKey(treasuryAddress);
    const mint     = new PublicKey(CIRCUIT_MINT);
    const prog     = new PublicKey(TOKEN2022_PID);

    // Derive ATAs (Associated Token Account)
    const {
      getAssociatedTokenAddressSync,
      createTransferCheckedInstruction,
      createAssociatedTokenAccountIdempotentInstruction,
    } = await _loadSplToken();

    const fromAta = getAssociatedTokenAddressSync(mint, sender,   false, prog);
    const toAta   = getAssociatedTokenAddressSync(mint, treasury, false, prog);

    // Idempotent ATA creation for destination — no-op if it already exists,
    // creates it (one-time ~0.002 SOL) if not. Prevents IncorrectProgramId
    // when the treasury has never received CIRC before.
    const createToAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      sender, toAta, treasury, mint, prog,
    );

    const transferIx = createTransferCheckedInstruction(
      fromAta, mint, toAta, sender,
      amountRaw, CIRCUIT_DECIMALS,
      [], prog,
    );

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: sender });
    tx.add(createToAtaIx);
    tx.add(transferIx);
    tx.sign(keypair);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, 'confirmed');
    // Brief wait for RPC propagation before server-side verification
    await new Promise(r => setTimeout(r, 2000));
    return sig;
  }

  // ── Convenience methods ───────────────────────────────────────────────────

  async scan(opts = {}) {
    const { limit = 20, minLiquidity = 10000, safeOnly = false } = opts;
    return this.call('scan', `?limit=${limit}&minLiquidity=${minLiquidity}&safeOnly=${safeOnly}`);
  }

  /**
   * Free-tier scan — uses circuit-price-feed candle data (no x402, no DexScreener).
   * Gets top tokens by on-chain Geyser volume, then derives price changes from OHLCV
   * candles. Returns candidates in the same shape as scan() so scoring.js is unchanged.
   * Used in paper trading mode to avoid spending CIRC on scans.
   */
  async scanFree(opts = {}) {
    const { limit = 20, minLiquidity = 5000, seedMints = [] } = opts;
    // The whole universe → price → OHLCV enrichment now runs server-side on circuit-price-feed
    // (GET /scan), co-located with Redis, and returns candidates in the exact shape scoring.js
    // consumes. This replaces the old client-side fan-out (~200 requests/scan to /active +
    // /prices + per-mint /candles) which was hardcoded to 127.0.0.1:18941 — fine for VPS-co-located
    // agents but a dead endpoint for anyone running the bot off-box, so their live feed always came
    // back empty and every cycle fell through to the paid DexScreener scan. this.feedBase resolves
    // to localhost:18941 co-located, or ${baseUrl}/api/price-feed via the data-api proxy off-box.
    try {
      const seed = (seedMints ?? []).filter(Boolean).slice(0, 80).join(',');
      const qs = `?limit=${limit}&minLiquidity=${minLiquidity}` + (seed ? `&seed=${seed}` : '');
      const r = await fetch(`${this.feedBase}/scan${qs}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return { candidates: [], error: `price-feed /scan ${r.status}`, source: 'price-feed-free' };
      const j = await r.json();
      return { candidates: j.candidates ?? [], source: j.source ?? 'price-feed-scan' };
    } catch (err) {
      return { candidates: [], error: err.message, source: 'price-feed-free' };
    }
  }

  /**
   * Free-tier token info — uses RugCheck summary API (no x402, no key needed).
   * Returns risk verdict + basic token data. Used in paper trading mode.
   */
  async tokenInfoFree(mint) {
    try {
      const r = await fetch(
        `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      // Count-based verdict from RugCheck's actual risk flags. Do NOT threshold on d.score:
      // RugCheck's score is LOW = safe (USDC ≈ 1, BONK ≈ 101) — the old `score <= 300 → DANGER`
      // was inverted, flagging safe tokens as DANGER and real rugs (high score) as OK.
      const risks       = d.risks ?? [];
      const dangerCount = risks.filter(x => x.level === 'danger').length;
      const warnCount   = risks.filter(x => x.level === 'warn').length;
      const verdict =
        dangerCount > 0 ? 'DANGER' :
        warnCount  > 1 ? 'CAUTION' :
        warnCount  > 0 ? 'LOW_RISK' : 'SAFE';
      return {
        mint,
        symbol:  d.tokenMeta?.symbol  ?? null,
        name:    d.tokenMeta?.name    ?? null,
        verdict,
        rugRisk: verdict,
        rugScore: d.score ?? null,
        risks:   risks.map(x => x.name),
        source:  'rugcheck-free',
      };
    } catch { return null; }
  }

  // Full RugCheck report (free, external). Unlike the /report/summary used by
  // tokenInfoFree, this includes topHolders (+ knownAccounts labels), markets &
  // liquidity, totalHolders, creator balance, lockers, transferFee, launchpad.
  async tokenReportFull(mint) {
    try {
      const r = await fetch(
        `https://api.rugcheck.xyz/v1/tokens/${mint}/report`,
        { signal: AbortSignal.timeout(9_000) }
      );
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // DexScreener token data (free, external): deepest pair's price changes,
  // volume, buy/sell txns, social links, websites, logo, FDV/marketCap.
  async dexScreener(mint) {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!r.ok) return null;
      const pairs = (await r.json())?.pairs ?? [];
      if (!pairs.length) return null;
      const p = pairs.sort((a, b) => ((b.liquidity?.usd) || 0) - ((a.liquidity?.usd) || 0))[0];
      const info = p.info ?? {};
      return {
        priceUsd:      p.priceUsd != null ? Number(p.priceUsd) : null,
        fdv:           p.fdv ?? null,
        marketCap:     p.marketCap ?? null,
        priceChange:   p.priceChange ?? {},   // { m5, h1, h6, h24 }
        volume:        p.volume ?? {},        // { m5, h1, h6, h24 }
        txns:          p.txns ?? {},          // { h24: { buys, sells }, ... }
        pairCreatedAt: p.pairCreatedAt ?? null,
        dexId:         p.dexId ?? null,
        url:           p.url ?? null,
        websites:      (info.websites ?? []).map(w => ({ label: w.label ?? 'Website', url: w.url })),
        socials:       (info.socials ?? []).map(s => ({ type: s.type, url: s.url })),
        imageUrl:      info.imageUrl ?? null,
      };
    } catch { return null; }
  }

  async tokenPrice(mint) {
    return this.call('token-price', `?mint=${mint}`);
  }

  /**
   * Batch price lookup for multiple mints in a single payment.
   * Returns { prices: { mint: { usdPrice, nativePrice, priceChange1h, symbol } } }
   */
  async tokenPrices(mints) {
    if (!Array.isArray(mints) || !mints.length) throw new Error('mints array required');
    return this.call('token-prices', `?mints=${mints.join(',')}`);
  }

  async tokenInfo(mint) {
    return this.call('token-info', `?mint=${mint}`);
  }

  /**
   * Pre-populate the price-feed Redis cache for a freshly bought mint.
   * Call immediately after a buy so the first monitor tick is a Redis hit
   * rather than a live DexScreener call. Fire-and-forget safe — errors are
   * non-fatal; the monitor has its own fallback if warm fails.
   */
  async warmMint(mint) {
    try {
      const resp = await fetch(`${this.baseUrl}/api/price-feed/warm`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mint }),
        signal:  AbortSignal.timeout(5_000),
      });
      return resp.ok ? await resp.json() : null;
    } catch { return null; }
  }

  /**
   * Live price-feed price (SOL per token) for a single mint, read straight from the
   * sub-second Geyser feed. Used by the S1 entry-confirmation gate to verify the bounce
   * that qualified a candidate hasn't already faded in the seconds-to-minutes between
   * scoring and fill. Returns null if unavailable (caller decides fail-open vs fail-closed).
   */
  /**
   * Full per-mint price object from the free reserve-based feed. Unlike pricesLive
   * (Redis hot cache — MISSES tokens that haven't traded recently), /price/:mint
   * computes from live pool reserves and works for quiet tokens too.
   * Returns { mint, priceSol, source, ageMs, ... } or null.
   */
  async feedPrice(mint) {
    try {
      const r = await fetch(`${this.feedBase}/price/${mint}`, { signal: AbortSignal.timeout(4_000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  /**
   * COMPLETE batch prices via the price-feed's full resolution chain (Redis →
   * pool reserves → bonding curve → RPC vaults → Jupiter). Always answers for
   * priceable mints, unlike pricesLive() which is the Redis hot cache and misses
   * tokens that haven't traded recently. Feed caps 20 mints/call → chunked here.
   * Returns a map: mint → { priceSol, priceUsd?, source, ... } (missing = unpriceable).
   */
  async feedPrices(mints) {
    const list = (Array.isArray(mints) ? mints : String(mints).split(',')).filter(Boolean);
    const out = {};
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      try {
        const r = await fetch(`${this.feedBase}/prices?mints=${chunk.join(',')}`, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) continue;
        const j = await r.json();
        Object.assign(out, j?.results ?? {});
      } catch { /* chunk failed — others may still resolve */ }
    }
    return out;
  }

  /** SOL/USD from the free feed. Returns a number or null. */
  async feedSolUsd() {
    try {
      const r = await fetch(`${this.feedBase}/sol-price`, { signal: AbortSignal.timeout(4_000) });
      if (!r.ok) return null;
      const j = await r.json();
      return j?.price ?? null;
    } catch { return null; }
  }

  async feedPriceSol(mint) {
    const feedBase = this.feedBase; // localhost:18941 co-located, ${baseUrl}/api/price-feed off-box
    try {
      const r = await fetch(`${feedBase}/prices?mints=${mint}`, { signal: AbortSignal.timeout(3_000) });
      if (!r.ok) return null;
      const j = await r.json();
      return j.results?.[mint]?.priceSol ?? null;
    } catch { return null; }
  }

  async marketOverview() {
    return this.call('market-overview');
  }

  async marketSentiment() {
    return this.call('market-sentiment');
  }

  async defiOverview() {
    return this.call('defi-overview');
  }

  async networkStats() {
    return this.call('network-stats');
  }

  async oraclePrices() {
    return this.call('oracle-prices');
  }

  async news(opts = {}) {
    const { limit = 10, filter = 'rising' } = opts;
    return this.call('news', `?limit=${limit}&filter=${filter}`);
  }

  async stakingYields() {
    return this.call('staking-yields');
  }

  async tokenOhlcv(mint, timeframe = '1H', limit = 24) {
    return this.call('token-ohlcv', `?mint=${mint}&timeframe=${timeframe}&limit=${limit}`);
  }

  async tokenHolders(mint) {
    return this.call('token-holders', `?mint=${mint}`);
  }

  // ── momentum-agent signal enrichment (agent2) — smart money, rug risk, trending ──
  async tokenTopTraders(mint) {
    return this.call('token-top-traders', `?mint=${mint}`);
  }

  async tokenSecurity(mint) {
    return this.call('token-security', `?mint=${mint}`);
  }

  async tokenTrending() {
    return this.call('token-trending', '');
  }

  async topPools(limit = 20) {
    return this.call('top-pools', `?limit=${limit}`);
  }

  async status() {
    const resp = await this._fetch('/api/status');
    if (!resp.ok) throw new Error(`Status ${resp.status}`);
    return resp.json();
  }

  // ── Swarm methods ─────────────────────────────────────────────────────────
  // Publishing is always free. Reading costs CIRCUIT (x402, handled via call()).

  /**
   * Publish a signal to the swarm.
   * @param {object} opts
   *   agentId    {string} — this agent's registry ID
   *   type       {string} — buy_signal|sell_signal|rug_alert|momentum|insight|strategy_stats|market_regime|watching|scan_quality|agent_profile
   *   mint       {string} — token mint (optional for insights)
   *   symbol     {string} — token symbol (optional)
   *   confidence {number} — 0.0–1.0
   *   data       {object} — type-specific payload
   *   ttlSeconds {number} — signal lifetime (default 6h)
   */
  async swarmPublish(opts = {}) {
    const body = (this.wallet?.keypair && opts.address)
      ? _signSwarmBody(this.wallet.keypair, 'signal', opts) : opts;
    const resp = await fetch(`${this.baseUrl}/api/swarm/signal`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`swarm/signal ${resp.status}: ${err.error ?? ''}`);
    }
    return resp.json();
  }

  /**
   * Report the outcome of a previous signal (builds reputation).
   */
  async swarmOutcome(opts = {}) {
    const resp = await fetch(`${this.baseUrl}/api/swarm/outcome`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(opts),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`swarm/outcome ${resp.status}: ${err.error ?? ''}`);
    }
    return resp.json();
  }

  /**
   * Read the live swarm feed (x402).
   * @param {object} opts — limit, type, mint, minReputation
   */
  async swarmFeed(opts = {}) {
    const { limit = 50, type, mint, minReputation = 0 } = opts;
    let qs = `?limit=${limit}&minReputation=${minReputation}`;
    if (type) qs += `&type=${type}`;
    if (mint) qs += `&mint=${encodeURIComponent(mint)}`;
    return this._callSwarm('/api/swarm/feed' + qs, 'swarm-feed');
  }

  /**
   * Get swarm consensus on a specific mint (x402).
   */
  async swarmConsensus(mint) {
    if (!mint) throw new Error('mint required');
    return this._callSwarm(`/api/swarm/consensus/${mint}`, 'swarm-consensus');
  }

  /**
   * Client-side consensus computed from the FREE public feed (+ free leaderboard for
   * reputation filtering) instead of the paid x402 /swarm/consensus call. Returns the
   * shape the scanner consumes: { consensus: 'bullish'|'bearish'|'rug_alert'|'neutral',
   * agents }. Null on failure so callers treat it like an unavailable service.
   */
  async swarmConsensusFree(mint, { lookbackMs = 6 * 3600_000, minReputation = 0 } = {}) {
    if (!mint) throw new Error('mint required');
    try {
      // NOTE: must NOT exclude buy_signal here — the default exclude list drops it.
      const feed = await this.swarmFeedPublic({ limit: 200, exclude: 'scan_quality,agent_profile,task_submitted' });
      const fresh = (feed?.signals ?? []).filter(s =>
        s.mint === mint &&
        Date.now() - new Date(s.publishedAt ?? s.timestamp ?? 0).getTime() < lookbackMs);
      if (!fresh.length) return { consensus: 'neutral', agents: 0, source: 'free' };
      let repOf = null;
      if (minReputation > 0) {
        try {
          const lb = await this.swarmLeaderboard(50);
          repOf = new Map((lb?.leaderboard ?? lb ?? []).map(a => [a.agentId, a.reputation ?? 0]));
        } catch { repOf = null; /* leaderboard down — count unfiltered rather than fail */ }
      }
      const qualified = repOf ? fresh.filter(s => (repOf.get(s.agentId) ?? 0) >= minReputation) : fresh;
      const agentsOf = t => new Set(qualified.filter(s => s.type === t).map(s => s.agentId ?? s.address ?? 'anon'));
      const rugs = agentsOf('rug_alert').size;
      if (rugs > 0) return { consensus: 'rug_alert', agents: rugs, source: 'free' };
      const buyers = agentsOf('buy_signal').size, sellers = agentsOf('sell_signal').size;
      if (buyers > sellers && buyers >= 1) return { consensus: 'bullish', agents: buyers, source: 'free' };
      if (sellers > buyers)                return { consensus: 'bearish', agents: sellers, source: 'free' };
      return { consensus: 'neutral', agents: 0, source: 'free' };
    } catch { return null; }
  }

  /**
   * Consensus with cost preference: free client-side first. The paid x402 endpoint is
   * only used when the free path failed AND swarm.paidConsensusFallback === true
   * (opt-in — if the free feed is down, the paid API is usually down too).
   */
  async swarmConsensusCheap(mint, cfg = {}) {
    const free = await this.swarmConsensusFree(mint, {
      minReputation: cfg.swarm?.minReputationToFollow ?? 0,
    });
    if (free) return free;
    if (cfg.swarm?.paidConsensusFallback === true) return this.swarmConsensus(mint);
    return null;
  }

  // Internal helper: call a swarm read endpoint with x402 fallback
  async _callSwarm(path, endpointKey) {
    if (this._isLocal && this.internalKey) {
      const resp = await this._fetch(path, { 'X-Internal-Key': this.internalKey });
      if (resp.ok) return resp.json();
    }
    const resp = await this._fetch(path);
    if (resp.ok) return resp.json();
    if (resp.status !== 402) throw new Error(`API ${resp.status} on ${path}`);

    // Need to pay — get the payment info from quote
    if (!this.wallet) throw new Error('Payment required but no wallet configured');
    const quote  = await this.getQuote();
    const epInfo = quote.endpoints?.[endpointKey];
    if (!epInfo) throw new Error(`Unknown endpoint: ${endpointKey}`);
    const txSig = await this._sendCircuitPayment(quote.payment.treasury, BigInt(epInfo.circRaw));
    const paid  = await this._fetch(path, { 'X-Payment-Signature': txSig });
    if (paid.ok) return paid.json();
    if ([429, 500, 502, 503, 504].includes(paid.status)) {
      log('warn', `Paid swarm call returned ${paid.status} — retrying once`, { txSig: txSig.slice(0, 16) });
      await new Promise(r => setTimeout(r, 2000));
      const retry = await this._fetch(path, { 'X-Payment-Signature': txSig });
      if (retry.ok) return retry.json();
      const retryErr = await retry.json().catch(() => ({}));
      throw new Error(`Paid swarm call failed after retry ${retry.status}: ${retryErr.error ?? ''} (payment txSig: ${txSig.slice(0, 24)})`);
    }
    const errBody = await paid.json().catch(() => ({}));
    throw new Error(`Paid swarm call failed ${paid.status}: ${errBody.error ?? ''} (payment txSig: ${txSig.slice(0, 24)})`);
  }

  /**
   * Free-tier swarm feed read — uses internal key if set, returns empty on 402.
   * Never attempts x402 payment. Used by monitor.js for sell-signal detection
   * without spending CIRCUIT on every position check cycle.
   */
  async swarmFeedFree(opts = {}) {
    const { type, limit = 50, mint } = opts;
    let qs = `?limit=${limit}`;
    if (type) qs += `&type=${encodeURIComponent(type)}`;
    if (mint) qs += `&mint=${encodeURIComponent(mint)}`;
    const headers = this.internalKey ? { 'X-Internal-Key': this.internalKey } : {};
    try {
      const resp = await this._fetch(`/api/swarm/feed${qs}`, headers);
      if (!resp.ok) return { signals: [] };
      return resp.json();
    } catch {
      return { signals: [] };
    }
  }

  /**
   * Read the FREE public swarm feed — no internal key, no x402. This is the free tier any
   * external agent uses for coordination; the swarm reads it the same way (no privilege).
   * feed-public filters by `exclude` (not `type`), so exclude the high-volume noise types to
   * keep sell_signal / rug_alert from being crowded out of the window.
   * @param {object} opts — limit (default 100), exclude (comma-separated types to drop)
   */
  async swarmFeedPublic(opts = {}) {
    const { limit = 100, exclude = 'scan_quality,agent_profile,buy_signal,task_submitted' } = opts;
    let qs = `?limit=${limit}`;
    if (exclude) qs += `&exclude=${encodeURIComponent(exclude)}`;
    try {
      const resp = await this._fetch(`/api/swarm/feed-public${qs}`);
      if (!resp.ok) return { signals: [] };
      return resp.json();
    } catch {
      return { signals: [] };
    }
  }

  /**
   * Get swarm stats (free).
   */
  async swarmStats() {
    const resp = await this._fetch('/api/swarm/stats');
    if (!resp.ok) throw new Error(`swarm/stats ${resp.status}`);
    return resp.json();
  }

  /**
   * Get swarm leaderboard (free).
   */
  async swarmLeaderboard(limit = 20) {
    const resp = await this._fetch(`/api/swarm/leaderboard?limit=${limit}`);
    if (!resp.ok) throw new Error(`swarm/leaderboard ${resp.status}`);
    return resp.json();
  }

  /**
   * Get swarm insights (x402).
   */
  async swarmInsights(limit = 20) {
    return this._callSwarm(`/api/swarm/insights?limit=${limit}`, 'swarm-insights');
  }

  // ── Swarm task board ─────────────────────────────────────────────────────────

  /**
   * List tasks from the swarm task board (free).
   */
  async taskList(opts = {}) {
    const { status = 'open', type, limit = 20 } = opts;
    const params = new URLSearchParams({ status, limit: String(limit) });
    if (type) params.set('type', type);
    const resp = await this._fetch(`/api/swarm/tasks?${params}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  /**
   * POST to a task board endpoint (free, no x402).
   */
  // Sign a state-changing swarm task action with the wallet key. The whole body is bound
  // by the signature (see _signSwarmBody), so it can't be replayed across actions/tasks
  // or tampered (e.g. flipping the approve bit) in flight.
  _signTaskBody(endpoint, body) {
    const action = endpoint.split('/').pop();
    if (!_SWARM_TASK_ACTIONS.has(action) || !this.wallet?.keypair || !body?.address) return body;
    return _signSwarmBody(this.wallet.keypair, action, body);
  }

  async _taskPost(endpoint, body) {
    const resp = await fetch(`${this.baseUrl}${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(this._signTaskBody(endpoint, body)),
    });
    const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    // Attach status so callers can distinguish transient vs permanent errors
    if (!resp.ok) data._status = resp.status;
    return data;
  }

  async taskPropose(agentId, address, opts = {}) {
    const { reward, ...rest } = opts;
    const rewardCircuit = parseInt(reward) || 0;

    // Tasks with reward > 0 must be backed by an on-chain escrow deposit.
    // Honor-system rewards are no longer accepted — the server enforces this too.
    let escrowTxSig = null;
    if (rewardCircuit > 0) {
      if (!this.wallet) {
        throw new Error(
          'Cannot propose a rewarded task without a wallet configured. ' +
          'Use reward: 0 for no-reward proposals.'
        );
      }

      // ── Balance check (fast-fail before touching the chain) ────────────────
      const balance = await this._getCircuitBalance();
      if (balance < rewardCircuit) {
        throw new Error(
          `Insufficient CIRCUIT for task reward: ` +
          `have ${balance.toLocaleString()}, need ${rewardCircuit.toLocaleString()}. ` +
          `Top up your wallet or lower the reward.`
        );
      }

      // ── Fetch escrow wallet address from server ────────────────────────────
      const quote = await this.getQuote();
      const escrowWallet = quote.escrowWallet;
      if (!escrowWallet) {
        throw new Error(
          'This server does not have an escrow wallet configured. ' +
          'Rewarded tasks are unavailable — use reward: 0.'
        );
      }

      // ── Deposit ───────────────────────────────────────────────────────────
      try {
        const amountRaw = BigInt(rewardCircuit) * BigInt(1_000_000); // CIRCUIT has 6 decimals
        log('info', `Depositing ${rewardCircuit.toLocaleString()} CIRCUIT to escrow for task reward`);
        escrowTxSig = await this._sendCircuitPayment(escrowWallet, amountRaw);
        log('info', `Escrow deposit confirmed`, { sig: escrowTxSig.slice(0, 16) + '…' });
      } catch (err) {
        throw new Error(`Escrow deposit failed: ${err.message}`);
      }
    }

    return this._taskPost('/api/swarm/tasks/propose', {
      agentId,
      address,
      reward: rewardCircuit || undefined,
      escrowTxSig,
      ...rest,
    });
  }

  async taskClaim(agentId, address, taskId) {
    return this._taskPost('/api/swarm/tasks/claim', { agentId, address, taskId });
  }

  async taskSubmit(agentId, address, taskId, work, summary) {
    return this._taskPost('/api/swarm/tasks/submit', { agentId, address, taskId, work, summary });
  }

  async taskAbandon(agentId, address, taskId, reason) {
    return this._taskPost('/api/swarm/tasks/abandon', { agentId, address, taskId, reason });
  }

  // ── Agent stats ──────────────────────────────────────────────────────────────

  async pushAgentStats(agentId, address, statsPayload) {
    try {
      let body = { agentId, address, ...statsPayload };
      if (this.wallet?.keypair && address) body = _signSwarmBody(this.wallet.keypair, 'stats', body);
      const resp = await fetch(`${this.baseUrl}/api/agents/stats`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(this.internalKey ? { 'X-Internal-Key': this.internalKey } : {}) },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(10_000),
      });
      return resp.ok ? resp.json() : { error: `HTTP ${resp.status}` };
    } catch (err) {
      return { error: err.message };
    }
  }

  async getSwarmAgentStats() {
    const resp = await this._fetch('/api/agents/stats');
    if (!resp.ok) return null;
    return resp.json();
  }

  async taskCreateSubtask(params) {
    return this._taskPost('/api/swarm/tasks/subtask', params);
  }

  async getTaskSubtasks(taskId) {
    const resp = await this._fetch('/api/swarm/tasks/' + taskId + '/subtasks');
    if (!resp.ok) return null;
    return resp.json();
  }

  async getSwarmAggregateStats() {
    const resp = await this._fetch('/api/swarm/aggregate-stats');
    if (!resp.ok) return null;
    return resp.json();
  }

  async getSwarmHoldings() {
    const resp = await this._fetch('/api/swarm/holdings');
    if (!resp.ok) return null;
    return resp.json();
  }

  async getMarketRegime() {
    const resp = await this._fetch('/api/market-regime');
    if (!resp.ok) return null;
    return resp.json();
  }

  async taskVerify(agentId, address, taskId, approved, submissionId = null, comment = '') {
    return this._taskPost('/api/swarm/tasks/verify', {
      agentId,
      address,
      taskId,
      submissionId,
      approved: Boolean(approved),
      comment,
    });
  }

  // ── Geyser-powered endpoints (free — no x402, rate-limited 120 req/min) ──────
  // These proxy directly to circuit-node's Redis/gRPC store.
  // Data is sub-second from the Yellowstone gRPC stream.

  async dexGainers(window = '5m', limit = 20) {
    const resp = await this._fetch(`/api/dex/gainers?window=${window}&limit=${limit}`);
    if (!resp.ok) throw new Error(`dex-gainers ${resp.status}`);
    return resp.json();
  }

  async dexLosers(window = '5m', limit = 20) {
    const resp = await this._fetch(`/api/dex/losers?window=${window}&limit=${limit}`);
    if (!resp.ok) throw new Error(`dex-losers ${resp.status}`);
    return resp.json();
  }

  async dexActivity() {
    const resp = await this._fetch('/api/dex/activity');
    if (!resp.ok) throw new Error(`dex-activity ${resp.status}`);
    return resp.json();
  }

  // Returns { count, hits, misses, prices: { MINT: { priceUsd, source, ageMs } } }
  // Note: prices are USD-denominated — for SOL-native P&L use the price-feed service.
  async pricesLive(mints) {
    const ids  = Array.isArray(mints) ? mints.join(',') : mints;
    const resp = await this._fetch(`/api/prices/live?mints=${ids}`);
    if (!resp.ok) throw new Error(`prices-live ${resp.status}`);
    return resp.json();
  }

  // Returns { value, label, yesterday, signals, source, timestamp }
  // On-chain F&G: SOL momentum (40%) + CPMM swap activity (30%) + DEX TVL (30%)
  async fearGreed() {
    const resp = await this._fetch('/api/market/fear-greed');
    if (!resp.ok) throw new Error(`market/fear-greed ${resp.status}`);
    return resp.json();
  }

  // Returns { mint, symbol, decimals, priceUsd, security: { rugRisk, ... }, pools, meta }
  async tokenOverview(mint) {
    const resp = await this._fetch(`/api/token-overview?mint=${mint}`);
    if (!resp.ok) throw new Error(`token-overview ${resp.status}`);
    return resp.json();
  }

  // ── Swarm blacklist ──────────────────────────────────────────────────────────

  async blacklistGet(opts = {}) {
    const params = new URLSearchParams();
    if (opts.search) params.set('search', opts.search);
    if (opts.limit)  params.set('limit', String(opts.limit));
    const resp = await this._fetch(`/api/swarm/blacklist?${params}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  async blacklistCheck(mint) {
    const resp = await this._fetch(`/api/swarm/blacklist/check/${mint}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  async blacklistAdd(agentId, address, mint, symbol, reason) {
    let body = { agentId, address, mint, symbol, reason };
    if (this.wallet?.keypair && address) body = _signSwarmBody(this.wallet.keypair, 'blacklist', body);
    const resp = await fetch(`${this.baseUrl}/api/swarm/blacklist`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    return resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
  }
}

// ── Lazy-load @solana/spl-token (avoid bundling it if not needed) ─────────────
let _splCache = null;
async function _loadSplToken() {
  if (_splCache) return _splCache;
  try {
    _splCache = require('@solana/spl-token');
    return _splCache;
  } catch {
    throw new Error(
      'spl-token not installed. Run: npm install @solana/spl-token\n' +
      'Or use INTERNAL_KEY bypass if running on the same server as the API.',
    );
  }
}

module.exports = { CircuitClient, CIRCUIT_MINT, CIRCUIT_DECIMALS, TOKEN2022_PID, _signSwarmBody };

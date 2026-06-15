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
    const feedBase = 'http://127.0.0.1:18941'; // circuit-price-feed, same VPS
    try {
      // Step 1: universe = RECENTLY-ACTIVE tokens (txns in the last ~15 min) from /active.
      // We score tokens that are actually trading now — the cumulative-volume /trending list
      // is mostly tokens that were busy hours ago and are dead now, so their 5m bounce / buy
      // ratio is stale and meaningless. /trending is kept only as a fallback if /active is
      // unavailable or empty, so the swarm never goes blind.
      let solUsd = 150;
      let universeMints = [];
      try {
        const actResp = await fetch(`${feedBase}/active?limit=120&minTxns=2`, { signal: AbortSignal.timeout(5_000) });
        if (actResp.ok) {
          const actData = await actResp.json();
          solUsd = actData.solUsd ?? solUsd;
          universeMints = (actData.tokens ?? []).map(t => t.mint).filter(Boolean);
        }
      } catch { /* fall through to /trending */ }
      if (!universeMints.length) {
        const trendResp = await fetch(`${feedBase}/trending?limit=50`, { signal: AbortSignal.timeout(5_000) });
        if (!trendResp.ok) throw new Error(`price-feed /active+/trending unavailable (${trendResp.status})`);
        const trendData = await trendResp.json();
        solUsd = trendData.solUsd ?? solUsd;
        universeMints = (trendData.tokens ?? []).map(t => t.mint).filter(Boolean);
      }
      const WSOL = 'So11111111111111111111111111111111111111112';
      // Skip wrapped SOL — it is the quote asset, so its self-priced "candles" are a
      // degenerate case (price ≈ 1 in SOL terms; USD candles carry volume artifacts).
      // seedMints (currently-dipping tokens from the Geyser dexLosers feed) are placed FIRST
      // so they are always evaluated even if they fall outside the active top-N. De-dupe while
      // preserving the seed-first ordering.
      const topMints = [...new Set([...seedMints.filter(m => m && m !== WSOL), ...universeMints.filter(m => m && m !== WSOL)])];
      if (!topMints.length) return { candidates: [], source: 'price-feed-free' };

      // Step 2: batch price lookup for solReserve → compute liquidityUsd
      const priceMap = {};
      for (let i = 0; i < Math.min(topMints.length, 40); i += 20) {
        try {
          const batch = topMints.slice(i, i + 20);
          const r = await fetch(`${feedBase}/prices?mints=${batch.join(',')}`, { signal: AbortSignal.timeout(4_000) });
          if (r.ok) Object.assign(priceMap, (await r.json()).results ?? {});
        } catch { /* skip batch */ }
      }

      // Step 3: per-mint OHLCV candles for price change, volume, and txn data.
      // Windows fetched: 5m (recent bounce), 1h limit=7 (1h change + 6h aggregate +
      // 1h volume/txns), 1d limit=2 (24h change/volume). The price-feed stores windows
      // as 1m|5m|1h|1d — there is no '6h' window, so 6h is aggregated from 1h candles.
      // Candle volume (v) is denominated in SOL; convert to USD for scoring thresholds.
      const candidates = (await Promise.all(topMints.slice(0, limit * 2).map(async (mint) => {
        try {
          const [r5m, r1h, r1d] = await Promise.all([
            fetch(`${feedBase}/candles/${mint}?window=5m&limit=13`, { signal: AbortSignal.timeout(3_000) }),
            fetch(`${feedBase}/candles/${mint}?window=1h&limit=7`,  { signal: AbortSignal.timeout(3_000) }),
            fetch(`${feedBase}/candles/${mint}?window=1d&limit=2`,  { signal: AbortSignal.timeout(3_000) }),
          ]);
          const c5 = r5m.ok ? (await r5m.json()).candles ?? [] : [];
          const c1 = r1h.ok ? (await r1h.json()).candles ?? [] : [];
          const cd = r1d.ok ? (await r1d.json()).candles ?? [] : [];
          if (!c5.length) return null; // token not yet indexed

          // % change across the last `n` candles of a series (oldest-of-n open → latest close).
          const pctChange = (arr, n) => {
            if (!arr.length) return 0;
            const open  = arr[Math.max(0, arr.length - n)]?.o;
            const close = arr[arr.length - 1]?.c;
            return open > 0 ? ((close - open) / open) * 100 : 0;
          };
          const sumV = (arr) => arr.reduce((s, c) => s + (c.v ?? 0), 0);
          const sumB = (arr) => arr.reduce((s, c) => s + (c.b ?? 0), 0);
          const sumS = (arr) => arr.reduce((s, c) => s + (c.s ?? 0), 0);

          // Recent metrics over the last ~2 5m candles (~10 min) — a true recent bounce/
          // buy-pressure read, not a 65-min span as the prior all-candles sum produced.
          const recent5       = c5.slice(-2);
          const priceChange5m = pctChange(recent5, recent5.length);
          const buys5m        = sumB(recent5);
          const sells5m       = sumS(recent5);
          const vol5m         = sumV(recent5) * solUsd;

          const priceChange1h  = pctChange(c1, 2);                       // most recent ~1h
          const priceChange6h  = pctChange(c1, 6);                       // aggregate of 1h candles
          const priceChange24h = cd.length ? pctChange(cd, 2) : pctChange(c1, 24);

          // Corrupt-candle skip: the feed occasionally stores a bad OHLCV point (e.g. a close of
          // 280 for a $0.014 token), producing a 5m/1h change of thousands of percent. That would
          // sail through the bounce gate and trigger a buy on a non-existent move. No real
          // dip-reversal candidate moves >200% on these windows — drop it as bad data.
          if (Math.abs(priceChange5m) > 200 || Math.abs(priceChange1h) > 200) return null;

          const volume1h       = sumV(c1) * solUsd;
          const volume24h      = (cd.length ? sumV(cd) : sumV(c1)) * solUsd;
          const buys1h         = sumB(c1);
          const sells1h        = sumS(c1);

          const solReserve    = priceMap[mint]?.solReserve ?? 0;
          const liquidityUsd  = solReserve > 0 ? solReserve * 2 * solUsd : 0;
          if (liquidityUsd > 0 && liquidityUsd < minLiquidity) return null;

          return {
            mint,
            symbol:         '?',
            name:           '?',
            priceChange5m:  parseFloat(priceChange5m.toFixed(4)),
            priceChange1h:  parseFloat(priceChange1h.toFixed(4)),
            priceChange6h:  parseFloat(priceChange6h.toFixed(4)),
            priceChange24h: parseFloat(priceChange24h.toFixed(4)),
            liquidity:      liquidityUsd,
            volume5m:       vol5m,
            volume1h:       volume1h,
            volume24h:      volume24h,
            txns5m:  { buys: buys5m, sells: sells5m },
            txns1h:  { buys: buys1h, sells: sells1h },
            fdv:     0,
            pairAddress:    null,
            verdict:        null,
            rugRisk:        null,
          };
        } catch { return null; }
      }))).filter(Boolean);

      return { candidates: candidates.slice(0, limit), source: 'price-feed-free' };
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
    const resp = await fetch(`${this.baseUrl}/api/swarm/signal`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(opts),
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
  async _taskPost(endpoint, body) {
    const resp = await fetch(`${this.baseUrl}${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
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
      const resp = await fetch(`${this.baseUrl}/api/agents/stats`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(this.internalKey ? { 'X-Internal-Key': this.internalKey } : {}) },
        body:    JSON.stringify({ agentId, address, ...statsPayload }),
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
    const resp = await fetch(`${this.baseUrl}/api/swarm/blacklist`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ agentId, address, mint, symbol, reason }),
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

module.exports = { CircuitClient, CIRCUIT_MINT, CIRCUIT_DECIMALS, TOKEN2022_PID };

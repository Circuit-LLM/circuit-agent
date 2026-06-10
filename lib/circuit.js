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
   * Free-tier scan — uses DexScreener trending pairs directly (no x402).
   * Returns candidates in the same shape as scan() so scoring.js works unchanged.
   * Used in paper trading mode to avoid spending CIRC on scans.
   */
  async scanFree(opts = {}) {
    const { limit = 20, minLiquidity = 5000 } = opts;
    try {
      const r = await fetch(
        'https://api.dexscreener.com/latest/dex/search?q=solana&rankBy=trendingScoreH6&order=desc',
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!r.ok) throw new Error(`DexScreener ${r.status}`);
      const d = await r.json();

      const SOL = 'So11111111111111111111111111111111111111112';
      const seen = new Set();
      const candidates = (d.pairs ?? [])
        .filter(p =>
          p.chainId === 'solana' &&
          p.quoteToken?.address === SOL &&
          (p.liquidity?.usd ?? 0) >= minLiquidity &&
          !seen.has(p.baseToken?.address) && seen.add(p.baseToken?.address)
        )
        .slice(0, limit)
        .map(p => ({
          mint:           p.baseToken?.address,
          symbol:         p.baseToken?.symbol ?? '?',
          name:           p.baseToken?.name   ?? '?',
          priceChange5m:  p.priceChange?.m5  ?? 0,
          priceChange1h:  p.priceChange?.h1  ?? 0,
          priceChange6h:  p.priceChange?.h6  ?? 0,
          priceChange24h: p.priceChange?.h24 ?? 0,
          liquidity:      p.liquidity?.usd   ?? 0,
          volume5m:       (p.volume?.m5  ?? 0),
          volume1h:       (p.volume?.h1  ?? 0),
          volume24h:      (p.volume?.h24 ?? 0),
          txns5m: { buys: p.txns?.m5?.buys ?? 0, sells: p.txns?.m5?.sells ?? 0 },
          txns1h: { buys: p.txns?.h1?.buys ?? 0, sells: p.txns?.h1?.sells ?? 0 },
          fdv:            p.fdv ?? 0,
          pairAddress:    p.pairAddress,
          verdict:        null,  // rug check happens separately in tokenInfoFree
          rugRisk:        null,
        }));

      return { candidates, source: 'dexscreener-free' };
    } catch (err) {
      return { candidates: [], error: err.message, source: 'dexscreener-free' };
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
      return {
        mint,
        symbol:  d.tokenMeta?.symbol  ?? null,
        name:    d.tokenMeta?.name    ?? null,
        verdict: d.score <= 300 ? 'DANGER' : d.score <= 700 ? 'CAUTION' : 'OK',
        rugRisk: d.score <= 300 ? 'DANGER' : d.score <= 700 ? 'CAUTION' : 'OK',
        rugScore: d.score ?? null,
        risks:   (d.risks ?? []).map(r => r.name),
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

// lib/tools/copilot.js — "Solana copilot" tools: on-demand token dossiers, wallet
// inspection, and user-defined watches (price + wallet alerts).
//
// Design: everything here rides FREE endpoints (gRPC price feed, token-overview,
// RugCheck direct, public swarm feed) or plain RPC — a research request costs the
// user nothing in CIRC. Watches are checked by the deterministic loop in
// lib/watches.js; these tools only create/list/remove them.
'use strict';

const watches = require('../watches');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'research_token',
      description: 'Build a complete research dossier for any Solana token in one call: live price, metadata, rug/security verdict, swarm blacklist status, swarm consensus, and recent peer signals. Use this whenever the user asks about, or to research, a specific token. Free — no CIRC cost.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address (base58). If the user gave only a symbol, ask for the mint or find it via scan results first.' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_wallet',
      description: 'Inspect any Solana wallet: SOL balance and top token holdings with USD estimates. Works for wallets the agent does not own. Free (RPC + free price feed).',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Wallet address (base58)' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_price_watch',
      description: 'Create a one-shot price alert on any token. Fires a Telegram notification when the USD price reaches the target, then removes itself. Set aboveUsd OR belowUsd (or both).',
      parameters: {
        type: 'object',
        properties: {
          mint:     { type: 'string', description: 'Token mint address' },
          symbol:   { type: 'string', description: 'Token symbol for the alert message (optional)' },
          aboveUsd: { type: 'number', description: 'Alert when price rises to or above this USD value' },
          belowUsd: { type: 'number', description: 'Alert when price falls to or below this USD value' },
          note:     { type: 'string', description: 'Optional note echoed in the alert (e.g. why the user cares)' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_wallet_watch',
      description: 'Watch any wallet for activity: notifies on SOL balance moves or token-account changes. Persistent until removed. Max 5 wallet watches.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Wallet address to watch' },
          note:    { type: 'string', description: 'Optional label (e.g. "whale from $WIF top holders")' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'follow_wallet',
      description: 'Follow a wallet for copy-signals: alerts you when it enters a NEW token position (with a quick rug check). Optionally shadow-buy those entries with a fixed budget — but shadow-buying also requires copilot.followShadowBuy=true in config, and always passes the same rug/blacklist/survival gates as normal trades. Max 5 follows.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string',  description: 'Wallet address to follow' },
          autoBuy: { type: 'boolean', description: 'Attempt to shadow-buy its new entries (default false; also needs config opt-in)' },
          note:    { type: 'string',  description: 'Optional label' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_watches',
      description: 'List all active price and wallet watches with their ids.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_watch',
      description: 'Remove a watch by its id (get ids from list_watches).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Watch id, e.g. w_abc123' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wallet_profile',
      description: 'Build a comprehensive profile of any Solana wallet: creation age, transaction history, current holdings, concentration risk, and estimated tier (whale/trader/retail). Use this before copy-following a wallet to assess its track record and risk profile. Free (RPC queries).',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Wallet address (base58)' },
        },
        required: ['address'],
      },
    },
  },
];

// ── dossier builder ───────────────────────────────────────────────────────────

// Well-known Solana programs that can be the on-chain OWNER of a token-holding
// account (i.e. the holder is a PDA/vault controlled by that program, not a
// person's wallet). Used to name holders RugCheck's knownAccounts doesn't label.
const KNOWN_OWNER_PROGRAMS = {
  'Stake11111111111111111111111111111111111111':  'Native Staking',
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD':   'Marinade',
  '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC':  'Jito Stake Pool',
  'CamJcYt5oDkNv6C2E4JhF3SqVpwAQ2iRnJT8p2Lda7Xn':  'Kamino',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':   'Meteora DLMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C':  'Raydium CPMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':  'Raydium AMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':   'Orca Whirlpool',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':   'Jupiter',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j':  'Raydium',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':  'Pump.fun',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':   'PumpSwap AMM',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':   'Token Program',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb':   'Token-2022',
};
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Best-effort: for holders not already labeled by RugCheck, check on-chain whether
// the owner is a PDA (program-owned) vs a user wallet (System-owned). Mutates the
// `top` array in place. No-op without a connection or on any RPC error.
async function _labelProgramHolders(connection, top) {
  if (!connection || !Array.isArray(top)) return;
  const targets = top.filter(h => !h.infra && h.owner);
  if (!targets.length) return;
  try {
    const { PublicKey } = require('@solana/web3.js');
    const infos = await connection.getMultipleAccountsInfo(targets.map(h => new PublicKey(h.owner)));
    targets.forEach((h, i) => {
      const info = infos[i];
      if (!info) return;                       // uninitialized → treat as wallet
      const ownerProg = info.owner.toBase58();
      if (ownerProg !== SYSTEM_PROGRAM) {      // program-owned → it's a PDA/vault
        h.infra = KNOWN_OWNER_PROGRAMS[ownerProg] ?? 'Program';
        h.infraType = h.infra === 'Program' ? 'PROGRAM' : 'PROTOCOL';
      }
    });
  } catch { /* best-effort — leave holders as-is */ }
}

async function buildDossier(api, mint, connection = null) {
  const out = { mint };

  // All free calls, run in parallel; each section degrades independently.
  // tokenReportFull (RugCheck) is the richest source: holders, liquidity, markets,
  // creator, lockers, launchpad. tokenOverview (circuit) adds authorities, risk
  // flags with plain-English messages, and social/meta links.
  const [price, solUsd, overview, report, consensus, blacklist] = await Promise.allSettled([
    api.feedPrice(mint),          // reserve-based — works even for quiet tokens
    api.feedSolUsd(),
    api.tokenOverview(mint),
    api.tokenReportFull(mint),
    api.swarmConsensusFree(mint, {}),
    api.blacklistGet({ search: mint, limit: 5 }),
  ]);

  const ov  = overview.status === 'fulfilled' ? overview.value : null;
  const rp  = report.status   === 'fulfilled' ? report.value   : null;
  const sol = solUsd.status    === 'fulfilled' ? solUsd.value   : null;

  // ── Price + market cap ─────────────────────────────────────────────────────
  const feedPrice = price.status === 'fulfilled' ? price.value : null;
  let priceUsd = null;
  if (feedPrice?.priceSol != null && sol != null) priceUsd = +(feedPrice.priceSol * sol).toPrecision(6);
  if (priceUsd == null && rp?.price != null)      priceUsd = rp.price;
  if (priceUsd == null && ov?.priceUsd != null)   priceUsd = ov.priceUsd;

  const humanSupply = ov?.humanSupply
    ?? (rp?.token?.supply != null && rp?.token?.decimals != null
        ? Number(rp.token.supply) / 10 ** rp.token.decimals : null);
  const marketCap = (priceUsd != null && humanSupply != null)
    ? priceUsd * humanSupply : (ov?.marketCap ?? null);

  if (feedPrice?.priceSol != null || priceUsd != null) {
    out.price = {
      priceUsd,
      priceSol: feedPrice?.priceSol ?? null,
      marketCap,
      source:   feedPrice?.source ?? (rp ? 'rugcheck' : 'overview'),
      ageMs:    feedPrice?.ageMs ?? null,
    };
  }

  // ── Identity ───────────────────────────────────────────────────────────────
  out.token = {
    symbol:      ov?.symbol ?? rp?.tokenMeta?.symbol ?? null,
    name:        ov?.name   ?? rp?.tokenMeta?.name   ?? null,
    decimals:    ov?.decimals ?? rp?.token?.decimals ?? null,
    supply:      humanSupply,
    isToken2022: ov?.security?.isToken2022 ?? (typeof rp?.tokenProgram === 'string' && rp.tokenProgram.startsWith('Tokenz')) ?? null,
    launchpad:   rp?.launchpad?.name ?? null,
    logo:        ov?.meta?.logoURI ?? null,
    ageHours:    null,
  };
  const detected = rp?.detectedAt ?? ov?.indexedAt ?? null;
  if (detected) {
    const ms = Date.now() - new Date(detected).getTime();
    if (Number.isFinite(ms) && ms >= 0) out.token.ageHours = +(ms / 3_600_000).toFixed(1);
  }

  // ── Liquidity (per-market breakdown) ───────────────────────────────────────
  if (rp && Array.isArray(rp.markets)) {
    const markets = rp.markets.map(m => ({
      dex:          m.marketType ?? 'unknown',
      liquidityUsd: (m.lp?.quoteUSD ?? 0) + (m.lp?.baseUSD ?? 0),
      lpLockedPct:  m.lpLockedPct ?? null,
    })).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    out.liquidity = {
      totalUsd:    rp.totalMarketLiquidity ?? markets.reduce((s, m) => s + m.liquidityUsd, 0),
      stableUsd:   rp.totalStableLiquidity ?? null,
      lpProviders: rp.totalLPProviders ?? null,
      markets:     markets.slice(0, 4),
    };
  } else if (ov?.liquidity != null) {
    out.liquidity = { totalUsd: ov.liquidity, markets: [], lpProviders: null };
  }

  // ── Holders (LP/infra-labeled so concentration is honest) ──────────────────
  if (rp && Array.isArray(rp.topHolders) && rp.topHolders.length) {
    const known = rp.knownAccounts ?? {};
    const labeled = rp.topHolders.map((h, i) => {
      const k = known[h.owner];
      return {
        rank:      i + 1,
        owner:     h.owner,
        pct:       h.pct ?? 0,
        amount:    h.uiAmount ?? h.amount ?? null,
        insider:   !!h.insider,
        infra:     k?.name ?? null,
        infraType: k?.type ?? null,   // AMM | LOCKER | CREATOR | (later PROGRAM/PROTOCOL)
      };
    });
    const top = labeled.slice(0, 10);
    // Enrich unlabeled holders with on-chain program/PDA detection (best-effort).
    await _labelProgramHolders(connection, top);

    const real = top.filter(h => !h.infra);   // exclude pools, lockers, programs
    out.holders = {
      total:        rp.totalHolders ?? null,
      totalSource:  'RugCheck',                // providers count differently — be explicit
      topHolderPct: real[0]?.pct ?? null,
      top5Pct:      +(real.slice(0, 5).reduce((s, h) => s + h.pct, 0)).toFixed(1) || null,
      insiders:     labeled.filter(h => h.insider).length,
      creatorPct:   (rp.creatorBalance != null && rp.token?.supply)
        ? +((rp.creatorBalance / Number(rp.token.supply)) * 100).toFixed(2) : null,
      top,
    };
  }

  // ── Security (combined verdict + authorities + specific reasons) ───────────
  let verdict = 'unknown';
  if (rp) {
    const risks  = rp.risks ?? [];
    const danger = risks.filter(r => r.level === 'danger').length;
    const warn   = risks.filter(r => r.level === 'warn').length;
    verdict = rp.rugged ? 'RUGGED' : danger > 0 ? 'DANGER' : warn > 1 ? 'CAUTION' : warn > 0 ? 'LOW_RISK' : 'SAFE';
  } else if (ov?.security?.rugRisk) {
    verdict = ov.security.rugRisk;
  }
  // Circuit's overview can be a stale launch-day snapshot; when we have live
  // RugCheck data, drop its time/holder-sensitive flags (they double-count the LP
  // pool and re-report "new token" long after launch), so they don't contradict
  // the live holders section. Keep structural flags like TOKEN_2022.
  const STALE_WHEN_LIVE = new Set(['WHALE_SINGLE', 'CONCENTRATED_TOP5', 'NEW_TOKEN']);
  const rawFlags = ov?.security?.riskFlags ?? [];
  const flags = (rp ? rawFlags.filter(f => !STALE_WHEN_LIVE.has(f.flag)) : rawFlags)
    .slice(0, 6).map(f => ({ flag: f.flag, severity: f.severity, msg: f.msg }));
  out.security = {
    verdict,
    riskScore:       ov?.security?.riskScore ?? rp?.score_normalised ?? null,
    mintRenounced:   ov?.security ? ov.security.mintAuthority == null : null,
    freezeRenounced: ov?.security ? ov.security.freezeAuthority == null : null,
    immutable:       ov?.security?.immutable ?? null,
    transferFeePct:  rp?.transferFee?.pct ?? null,
    flags,
  };

  // ── Socials / metadata ─────────────────────────────────────────────────────
  if (ov?.meta && (ov.meta.website || ov.meta.twitter || ov.meta.description)) {
    out.socials = {
      website:     ov.meta.website ?? null,
      twitter:     ov.meta.twitter ?? null,
      description: ov.meta.description ?? null,
    };
  }

  // ── Swarm + blacklist ──────────────────────────────────────────────────────
  if (consensus.status === 'fulfilled' && consensus.value) out.swarm = consensus.value;
  if (blacklist.status === 'fulfilled' && blacklist.value) {
    const entries = blacklist.value.entries ?? blacklist.value.blacklist ?? [];
    const hit = entries.find(e => (e.mint ?? e) === mint);
    out.blacklisted = hit ? { reason: hit.reason ?? 'flagged' } : false;
  }

  out._sections = Object.keys(out).filter(k => !k.startsWith('_') && k !== 'mint');
  out._cost = 'free (no CIRC spent)';
  return out;
}

// ── handlers ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  research_token: async (args, ctx) => {
    const mint = String(args.mint ?? '').trim();
    if (!BASE58_RE.test(mint)) return JSON.stringify({ error: 'invalid mint address — need base58 (ask the user for the CA if they gave a symbol)' });
    const dossier = await buildDossier(ctx.api, mint, ctx.wallet?.connection ?? null);
    return JSON.stringify(dossier);
  },

  inspect_wallet: async (args, ctx) => {
    const address = String(args.address ?? '').trim();
    if (!BASE58_RE.test(address)) return JSON.stringify({ error: 'invalid wallet address' });
    const connection = ctx.wallet?.connection;
    if (!connection) return JSON.stringify({ error: 'no RPC connection available' });

    const { PublicKey } = require('@solana/web3.js');
    const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
    const owner = new PublicKey(address);

    const sol = (await connection.getBalance(owner)) / 1e9;
    let tokens = [];
    try {
      const [a, b] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      tokens = [...a.value, ...b.value]
        .map(x => x.account.data.parsed?.info)
        .filter(i => (i?.tokenAmount?.uiAmount ?? 0) > 0)
        .map(i => ({ mint: i.mint, amount: i.tokenAmount.uiAmount }))
        .slice(0, 20);
    } catch { /* token list best-effort */ }

    // Enrich with free live prices (best-effort)
    if (tokens.length) {
      try {
        const map = await ctx.api.feedPrices(tokens.map(t => t.mint).slice(0, 20));
        const sol = await ctx.api.feedSolUsd().catch(() => null);
        for (const t of tokens) {
          const p = map[t.mint];
          const usd = p?.priceUsd ?? (p?.priceSol != null && sol != null ? p.priceSol * sol : null);
          if (usd != null) t.estUsd = +(t.amount * usd).toFixed(2);
        }
      } catch { /* prices optional */ }
      tokens.sort((x, y) => (y.estUsd ?? 0) - (x.estUsd ?? 0));
      tokens = tokens.slice(0, 12);
    }

    return JSON.stringify({ address, sol: +sol.toFixed(4), tokenCount: tokens.length, topTokens: tokens, _cost: 'free' });
  },

  add_price_watch: async (args, ctx) => {
    const cfg = ctx.cfg ?? {};
    const w = watches.addPriceWatch(args, cfg.copilot?.maxWatches ?? 25);
    // Reject alerts that would fire instantly — likely a user mistake.
    try {
      const [p, sol] = await Promise.all([ctx.api.feedPrice(args.mint), ctx.api.feedSolUsd()]);
      const cur = (p?.priceSol != null && sol != null) ? p.priceSol * sol : null;
      if (cur != null && ((w.aboveUsd != null && cur >= w.aboveUsd) || (w.belowUsd != null && cur <= w.belowUsd))) {
        watches.removeWatch(w.id);
        return JSON.stringify({ error: `price is already $${cur} — that alert would fire immediately. Pick a level on the other side of the current price.`, currentPriceUsd: cur });
      }
    } catch { /* price check best-effort — keep the watch */ }
    return JSON.stringify({ ok: true, watch: w, note: 'one-shot: fires once then removes itself' });
  },

  add_wallet_watch: async (args, ctx) => {
    const cfg = ctx.cfg ?? {};
    const w = watches.addWalletWatch(args, cfg.copilot?.maxWatches ?? 25);
    return JSON.stringify({ ok: true, watch: { id: w.id, address: w.address, note: w.note } });
  },

  follow_wallet: async (args, ctx) => {
    const cfg = ctx.cfg ?? {};
    const w = watches.addFollowWatch(args, cfg.copilot?.maxWatches ?? 25);
    const shadowOn = cfg.copilot?.followShadowBuy === true;
    return JSON.stringify({ ok: true, watch: { id: w.id, address: w.address, autoBuy: w.autoBuy, note: w.note },
      note: w.autoBuy && !shadowOn ? 'autoBuy requested but copilot.followShadowBuy is off in config — will alert only until enabled' : (w.autoBuy ? 'will shadow-buy new entries (gated)' : 'alert-only') });
  },

  list_watches: async () => {
    const all = watches.list().map(w =>
      w.type === 'price'  ? { id: w.id, type: 'price', mint: w.mint, symbol: w.symbol, aboveUsd: w.aboveUsd, belowUsd: w.belowUsd, note: w.note }
    : w.type === 'follow' ? { id: w.id, type: 'follow', address: w.address, autoBuy: w.autoBuy, note: w.note }
    :                       { id: w.id, type: 'wallet', address: w.address, note: w.note, lastSol: w.lastSol });
    return JSON.stringify({ count: all.length, watches: all });
  },

  remove_watch: async (args) => {
    const removed = watches.removeWatch(String(args.id ?? ''));
    return JSON.stringify({ ok: true, removed: { id: removed.id, type: removed.type } });
  },

  wallet_profile: async (args, ctx) => {
    const address = String(args.address ?? '').trim();
    if (!BASE58_RE.test(address)) return JSON.stringify({ error: 'invalid wallet address' });
    const connection = ctx.wallet?.connection;
    if (!connection) return JSON.stringify({ error: 'no RPC connection available' });

    const { PublicKey } = require('@solana/web3.js');
    const owner = new PublicKey(address);

    try {
      // Get current holdings and SOL balance
      const sol = (await connection.getBalance(owner)) / 1e9;
      let tokens = [];
      try {
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
        const [a, b] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);
        tokens = [...a.value, ...b.value]
          .map(x => x.account.data.parsed?.info)
          .filter(i => (i?.tokenAmount?.uiAmount ?? 0) > 0)
          .map(i => ({ mint: i.mint, amount: i.tokenAmount.uiAmount }))
          .slice(0, 30);
      } catch { /* token list best-effort */ }

      // Estimate tier based on SOL holdings
      let tier = 'retail';
      if (sol >= 100) tier = 'whale';
      else if (sol >= 10) tier = 'trader';

      // Get signatures to find age + activity
      const sigs = await connection.getSignaturesForAddress(owner, { limit: 1000 });
      const txCount = sigs.length;
      let age = null, lastActivity = null;

      if (sigs.length > 0) {
        // Oldest transaction (wallet creation/first activity)
        const oldest = sigs[sigs.length - 1];
        if (oldest.blockTime) {
          const ageMs = Date.now() - (oldest.blockTime * 1000);
          const ageDays = Math.floor(ageMs / 86_400_000);
          age = ageDays === 0 ? '< 1 day' : `${ageDays} days`;
        }
        // Most recent transaction
        const newest = sigs[0];
        if (newest.blockTime) {
          const recentMs = Date.now() - (newest.blockTime * 1000);
          const recentMins = Math.floor(recentMs / 60_000);
          const recentHours = Math.floor(recentMs / 3_600_000);
          if (recentMins < 60) lastActivity = `${recentMins} min ago`;
          else if (recentHours < 24) lastActivity = `${recentHours}h ago`;
          else lastActivity = `${Math.floor(recentMs / 86_400_000)} days ago`;
        }
      }

      // Concentration risk
      let topHolding = null;
      if (tokens.length > 0) {
        try {
          const prices = await ctx.api.feedPrices(tokens.map(t => t.mint).slice(0, 10));
          const priced = tokens.map(t => {
            const p = prices[t.mint];
            const usd = p?.priceUsd ?? null;
            return { mint: t.mint.slice(0, 8), amount: t.amount, usd: usd ? +(t.amount * usd).toFixed(2) : null };
          }).filter(t => t.usd != null).sort((a, b) => b.usd - a.usd);
          if (priced.length > 0) topHolding = { symbol: priced[0].mint + '…', usd: priced[0].usd };
        } catch { /* pricing best-effort */ }
      }

      // Known address labels (hardcoded list for common addresses)
      const knownAddresses = {
        'Eo3jB1nHUfjqJafPMVrE3odd8z9sQcP3ih271SB97Ux': 'Raydium (Router)',
        '5Q544fKrFoe6tsEbD7K5QKc5kq91msU3cqtPmcSKwKY': 'Magic Eden',
        '98vTiZeqjn6vMEDVmesfvHZBuwKMqwyaqpNCvqbeat47': 'OKX (Exchange)',
      };
      const label = knownAddresses[address] ?? null;

      return JSON.stringify({
        address: address.slice(0, 8) + '…',
        sol: parseFloat(sol.toFixed(4)),
        txCount,
        age,
        lastActivity,
        tier,
        topHolding,
        tokenCount: tokens.length,
        label,
        _cost: 'free (RPC queries only)',
      });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

module.exports = { DEFINITIONS, HANDLERS, buildDossier };

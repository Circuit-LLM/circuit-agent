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

async function buildDossier(api, mint) {
  const out = { mint };

  // All free calls, run in parallel; each section degrades independently.
  const [price, solUsd, overview, rug, consensus, blacklist] = await Promise.allSettled([
    api.feedPrice(mint),          // reserve-based — works even for quiet tokens
    api.feedSolUsd(),
    api.tokenOverview(mint),
    api.tokenInfoFree(mint),
    api.swarmConsensusFree(mint, {}),
    api.blacklistGet({ search: mint, limit: 5 }),
  ]);

  if (price.status === 'fulfilled' && price.value?.priceSol != null) {
    const sol = solUsd.status === 'fulfilled' ? solUsd.value : null;
    out.price = {
      priceSol: price.value.priceSol,
      priceUsd: sol != null ? +(price.value.priceSol * sol).toPrecision(6) : null,
      solUsd:   sol,
      source:   price.value.source ?? 'price-feed',
      ageMs:    price.value.ageMs ?? null,
    };
  }

  if (overview.status === 'fulfilled' && overview.value) {
    const o = overview.value;
    out.token = {
      symbol:   o.symbol ?? o.token?.symbol ?? null,
      name:     o.name ?? o.token?.name ?? null,
      decimals: o.decimals ?? o.token?.decimals ?? null,
      supply:   o.supplyUi ?? o.supply ?? null,
      liquidity: o.liquidity ?? o.liquidityUsd ?? null,
      priceChange24h: o.priceChange24h ?? o.change24h ?? null,
      rugRisk:  o.security?.rugRisk ?? null,
    };
  }

  if (rug.status === 'fulfilled' && rug.value) {
    const r = rug.value;
    out.security = {
      verdict:   r.risk?.verdict ?? r.verdict ?? r.rugRisk ?? 'unknown',
      risks:     (r.risk?.risks ?? r.risks ?? []).slice(0, 5).map(x => x.name ?? x.description ?? x).filter(Boolean),
      topHolderPct: r.risk?.topHolderPct ?? r.topHolderPct ?? null,
    };
  }

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
    const dossier = await buildDossier(ctx.api, mint);
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

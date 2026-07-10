// lib/watches.js — user-defined watches: price alerts on any token, activity alerts
// on any wallet. Part of the "Solana copilot" capability — the agent keeps an eye on
// things for the user, independent of its own trading.
//
// Fully deterministic (no LLM in the loop). Price checks ride the FREE gRPC-backed
// /api/prices/live batch endpoint; wallet checks are plain RPC reads. Watches are
// created/removed via LLM tools (lib/tools/copilot.js) or listed with /watches.
//
// Semantics:
//   price watch  — one-shot: fires when priceUsd crosses the target, then auto-removes.
//   wallet watch — persistent: fires on SOL balance moves ≥ copilot.walletDeltaSol or a
//                  change in token-account count; per-watch cooldown stops alert spam.
'use strict';

const fs   = require('fs');
const path = require('path');

const WATCHES_FILE = path.join(__dirname, '../data/watches.json');
const BASE58_RE    = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [WATCH] [${level.toUpperCase()}] ${line}\n`);
};

// ── store ─────────────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(WATCHES_FILE)) return JSON.parse(fs.readFileSync(WATCHES_FILE, 'utf8'));
  } catch { /* corrupted → start clean, keep the bad file for forensics */ }
  return [];
}

function save(watches) {
  const tmp = WATCHES_FILE + '.tmp';
  log('debug', 'Saving watches', { count: watches.length, file: WATCHES_FILE });
  try {
    fs.writeFileSync(tmp, JSON.stringify(watches, null, 2));
    log('debug', 'Temp file written', { tmp });
    fs.renameSync(tmp, WATCHES_FILE);
    log('info', 'Watches saved', { count: watches.length });
  } catch (err) {
    log('error', 'Failed to save watches', { error: err.message, stack: err.stack });
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw err;
  }
}

function list() { return load(); }

function addPriceWatch({ mint, symbol, aboveUsd, belowUsd, note }, maxWatches = 25) {
  if (!BASE58_RE.test(mint ?? '')) throw new Error('valid mint address required');
  if (aboveUsd == null && belowUsd == null) throw new Error('set aboveUsd or belowUsd');
  const watches = load();
  if (watches.length >= maxWatches) throw new Error(`watch limit reached (${maxWatches}) — remove one first`);
  const w = {
    id:        'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type:      'price',
    mint,
    symbol:    symbol ?? null,
    aboveUsd:  aboveUsd != null ? Number(aboveUsd) : null,
    belowUsd:  belowUsd != null ? Number(belowUsd) : null,
    note:      note ?? null,
    createdAt: new Date().toISOString(),
  };
  watches.push(w);
  save(watches);
  return w;
}

function addWalletWatch({ address, note }, maxWatches = 25) {
  if (!BASE58_RE.test(address ?? '')) throw new Error('valid wallet address required');
  const watches = load();
  if (watches.length >= maxWatches) throw new Error(`watch limit reached (${maxWatches}) — remove one first`);
  if (watches.filter(w => w.type === 'wallet').length >= 5) throw new Error('wallet watch limit reached (5) — each one costs RPC reads every cycle');
  if (watches.some(w => w.type === 'wallet' && w.address === address)) throw new Error('already watching that wallet');
  const w = {
    id:        'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type:      'wallet',
    address,
    note:      note ?? null,
    createdAt: new Date().toISOString(),
    lastSol:        null,
    lastTokenCount: null,
    lastFiredAt:    null,
  };
  watches.push(w);
  save(watches);
  return w;
}

function addFollowWatch({ address, note, autoBuy }, maxWatches = 25) {
  if (!BASE58_RE.test(address ?? '')) throw new Error('valid wallet address required');
  const watches = load();
  if (watches.length >= maxWatches) throw new Error(`watch limit reached (${maxWatches})`);
  if (watches.filter(w => w.type === 'follow').length >= 5) throw new Error('follow watch limit reached (5)');
  if (watches.some(w => w.type === 'follow' && w.address === address)) throw new Error('already following that wallet');
  const w = {
    id:        'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type:      'follow',
    address,
    note:      note ?? null,
    autoBuy:   autoBuy === true,   // still requires copilot.followShadowBuy=true in config
    createdAt: new Date().toISOString(),
    lastMints: null,               // null = baseline not yet taken (no alerts on first tick)
  };
  watches.push(w);
  save(watches);
  return w;
}

function removeWatch(id) {
  const watches = load();
  const idx = watches.findIndex(w => w.id === id);
  if (idx === -1) throw new Error(`no watch with id ${id}`);
  const [removed] = watches.splice(idx, 1);
  save(watches);
  return removed;
}

// ── notification ──────────────────────────────────────────────────────────────

function makeNotify(cfg, telegramBot) {
  const chatId = cfg.telegram?.heartbeatChatId ?? require('./telegram').getOwnerChatId() ?? null;
  return async (text) => {
    if (!telegramBot || !chatId) { log('info', `(no telegram) ${text}`); return; }
    try { await telegramBot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' }); }
    catch { try { await telegramBot.api.sendMessage(chatId, text); } catch { /* dropped */ } }
  };
}

// ── price tick ────────────────────────────────────────────────────────────────

async function checkPriceWatches(api, notify) {
  const watches = load();
  const priceWatches = watches.filter(w => w.type === 'price');
  if (!priceWatches.length) return;

  // Use the price-feed's COMPLETE batch (full resolution chain — answers even for
  // quiet tokens), NOT the Redis hot cache (pricesLive), which by contract only
  // knows tokens that traded recently — exactly the ones people set alerts on.
  let priceMap = {};
  try {
    priceMap = await api.feedPrices(priceWatches.map(w => w.mint));
  } catch { /* feed down — per-mint fallback below still works */ }
  let solUsd = null;
  try { solUsd = await api.feedSolUsd(); } catch { /* usd conversion unavailable */ }

  let changed = false;
  for (const w of priceWatches) {
    const entry = priceMap[w.mint];
    let priceUsd = entry?.priceUsd ?? entry?.price ?? null;
    if ((priceUsd == null || !(priceUsd > 0)) && solUsd != null) {
      try {
        const p = await api.feedPrice(w.mint);
        if (p?.priceSol != null) priceUsd = p.priceSol * solUsd;
      } catch { /* skip this tick */ }
    }
    if (priceUsd == null || !(priceUsd > 0)) continue;

    const hitAbove = w.aboveUsd != null && priceUsd >= w.aboveUsd;
    const hitBelow = w.belowUsd != null && priceUsd <= w.belowUsd;
    if (!hitAbove && !hitBelow) continue;

    const name   = w.symbol ?? w.mint.slice(0, 6) + '…';
    const target = hitAbove ? `≥ $${w.aboveUsd}` : `≤ $${w.belowUsd}`;
    await notify(
      `🔔 *Price alert: ${name}*\n` +
      `Now $${priceUsd < 0.01 ? priceUsd.toExponential(3) : priceUsd.toFixed(4)} (${target})` +
      (w.note ? `\n_${w.note}_` : '') +
      `\nWatch removed (one-shot). \`${w.mint}\``
    );
    log('info', `price watch fired: ${name} ${target}`, { id: w.id });
    const all = load();
    const idx = all.findIndex(x => x.id === w.id);
    if (idx !== -1) { all.splice(idx, 1); save(all); }
    changed = true;
  }
  if (changed) log('info', 'price watches updated');
}

// ── wallet tick ───────────────────────────────────────────────────────────────

async function checkWalletWatches(connection, cfg, notify) {
  const watches = load();
  const walletWatches = watches.filter(w => w.type === 'wallet');
  if (!walletWatches.length || !connection) return;

  const { PublicKey } = require('@solana/web3.js');
  const deltaSolMin = cfg.copilot?.walletDeltaSol ?? 0.01;
  const cooldownMs  = cfg.copilot?.walletAlertCooldownMs ?? 10 * 60_000;

  let dirty = false;
  for (const w of walletWatches) {
    try {
      const owner = new PublicKey(w.address);
      const sol   = (await connection.getBalance(owner)) / 1e9;

      let tokenCount = w.lastTokenCount;
      try {
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
        const [a, b] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);
        tokenCount = [...a.value, ...b.value]
          .filter(x => (x.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0) > 0).length;
      } catch { /* token scan best-effort — SOL delta still works */ }

      const first     = w.lastSol == null;
      const solMoved  = !first && Math.abs(sol - w.lastSol) >= deltaSolMin;
      const tokMoved  = !first && w.lastTokenCount != null && tokenCount !== w.lastTokenCount;
      const coolOk    = !w.lastFiredAt || Date.now() - new Date(w.lastFiredAt).getTime() > cooldownMs;

      if ((solMoved || tokMoved) && coolOk) {
        const short = w.address.slice(0, 4) + '…' + w.address.slice(-4);
        const parts = [];
        if (solMoved) parts.push(`SOL ${w.lastSol.toFixed(4)} → ${sol.toFixed(4)} (${sol > w.lastSol ? '+' : ''}${(sol - w.lastSol).toFixed(4)})`);
        if (tokMoved) parts.push(`token accounts ${w.lastTokenCount} → ${tokenCount}`);
        await notify(`👁 *Wallet activity: ${short}*\n${parts.join('\n')}` + (w.note ? `\n_${w.note}_` : ''));
        w.lastFiredAt = new Date().toISOString();
        log('info', `wallet watch fired: ${short}`, { id: w.id });
      }
      w.lastSol        = sol;
      w.lastTokenCount = tokenCount;
      dirty = true;
    } catch (e) { log('warn', `wallet watch ${w.id}: ${e.message}`); }
  }
  if (dirty) {
    // merge state back without clobbering watches added mid-tick
    const all = load();
    for (const w of walletWatches) {
      const cur = all.find(x => x.id === w.id);
      if (cur) Object.assign(cur, { lastSol: w.lastSol, lastTokenCount: w.lastTokenCount, lastFiredAt: w.lastFiredAt });
    }
    save(all);
  }
}

// ── loop ──────────────────────────────────────────────────────────────────────

function start(cfg, ctx, telegramBot) {
  const priceMs  = cfg.copilot?.watchIntervalMs       ?? 60_000;
  const walletMs = cfg.copilot?.walletWatchIntervalMs ?? 300_000;
  const notify   = makeNotify(cfg, telegramBot);

  const followMs = cfg.copilot?.followIntervalMs ?? 120_000;
  const holderMs = cfg.strategy?.holderCheckIntervalMs ?? 300_000;
  setInterval(() => { checkPriceWatches(ctx.api, notify).catch(e => log('warn', e.message)); }, priceMs);
  setInterval(() => { checkWalletWatches(ctx.wallet?.connection, cfg, notify).catch(e => log('warn', e.message)); }, walletMs);
  setInterval(() => { checkFollowWatches(ctx, cfg, notify).catch(e => log('warn', e.message)); }, followMs);
  setInterval(() => { checkHolderExodus(ctx, cfg, notify).catch(e => log('warn', e.message)); }, holderMs);
  log('info', `Watches loop started (price ${priceMs / 1000}s, wallet ${walletMs / 1000}s, ${load().length} active)`);
}

// ── follow tick: copy-signal on watched wallets ───────────────────────────────

// Detects NEW token positions appearing in a followed wallet. First tick only
// baselines (no alerts). Optional shadow-buy is double-gated: the watch's own
// autoBuy flag AND copilot.followShadowBuy=true in config.
async function checkFollowWatches(ctx, cfg, notify) {
  const connection = ctx.wallet?.connection;
  const all = load();
  const follows = all.filter(w => w.type === 'follow');
  if (!follows.length || !connection) return;

  const { PublicKey } = require('@solana/web3.js');
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

  for (const w of follows) {
    try {
      const owner = new PublicKey(w.address);
      const [a, b] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      const mints = [...new Set([...a.value, ...b.value]
        .map(x => x.account.data.parsed?.info)
        .filter(i => (i?.tokenAmount?.uiAmount ?? 0) > 0)
        .map(i => i.mint))];

      if (w.lastMints == null) {              // baseline tick
        w.lastMints = mints;
        continue;
      }
      const prev = new Set(w.lastMints);
      const fresh = mints.filter(m => !prev.has(m)).slice(0, 3);   // cap alert burst
      w.lastMints = mints;

      for (const mint of fresh) {
        const short = w.address.slice(0, 4) + '…' + w.address.slice(-4);
        let extra = '';
        try {
          const info = await ctx.api.tokenInfoFree(mint);
          const verdict = (info.risk?.verdict ?? info.verdict ?? 'unknown').toUpperCase();
          extra = `\nRugCheck: ${verdict}`;
          if (info.symbol) extra += ` · ${info.symbol}`;
        } catch { /* dossier-lite best-effort */ }
        await notify(`👣 *Followed wallet ${short} entered a new token*\n${mint}${extra}` + (w.note ? `\n_${w.note}_` : ''));
        log('info', `follow signal: ${short} → ${mint.slice(0, 8)}`, { id: w.id });

        if (w.autoBuy && cfg.copilot?.followShadowBuy === true) {
          await shadowBuy(ctx, cfg, notify, mint, w).catch(e => log('warn', `shadow-buy: ${e.message}`));
        }
      }
    } catch (e) { log('warn', `follow watch ${w.id}: ${e.message}`); }
  }
  // persist lastMints baselines
  const cur = load();
  for (const w of follows) {
    const c = cur.find(x => x.id === w.id);
    if (c) c.lastMints = w.lastMints;
  }
  save(cur);
}

// Deterministic, fail-closed shadow buy for follow watches. Respects: pause,
// position cap, blacklist, RugCheck verdict (GOOD/WARN only), survival floor.
async function shadowBuy(ctx, cfg, notify, mint, watch) {
  const positions = require('./positions');
  const { isPaused } = require('./pause');
  if (isPaused()) return log('info', 'shadow-buy skipped: trading paused');
  const maxOpen = cfg.strategy?.maxOpenPositions ?? 3;
  if (positions.count() >= maxOpen) return log('info', 'shadow-buy skipped: position cap');
  if (positions.get(mint)) return log('info', 'shadow-buy skipped: already holding');

  try {
    const bl = await ctx.api.blacklistGet({ search: mint, limit: 3 });
    const entries = bl?.entries ?? bl?.blacklist ?? [];
    if (entries.some(e => (e.mint ?? e) === mint)) return log('warn', 'shadow-buy skipped: blacklisted');
  } catch { /* blacklist unavailable — rug gate below still applies */ }

  let info = null;
  try { info = await ctx.api.tokenInfoFree(mint); } catch { /* fail-closed below */ }
  const verdict = (info?.risk?.verdict ?? info?.verdict ?? 'unknown').toUpperCase();
  if (verdict !== 'GOOD' && verdict !== 'WARN') return log('warn', `shadow-buy skipped: rug verdict ${verdict} (fail-closed)`);

  const budget = cfg.copilot?.followBudgetSol ?? cfg.strategy?.entryBudgetSol ?? 0.005;
  const bal = await ctx.wallet.getBalances().then(b => b.sol).catch(() => 0);
  const floor = cfg.survival?.minSolPause ?? 0.01;
  if (bal - budget < floor) return log('warn', 'shadow-buy skipped: would breach survival floor');

  const result = await ctx.swap.buy(mint, budget);
  let tokenDecimals = 6;
  try { const tb = await ctx.swap.getTokenBalance(mint); if (tb.decimals > 0) tokenDecimals = tb.decimals; } catch { /* fallback 6 */ }
  const { rawToUiAmount } = positions;
  const uiOut = rawToUiAmount(String(result.outAmount), tokenDecimals);
  positions.openPosition(mint, {
    symbol:        info?.symbol ?? mint.slice(0, 6),
    entryPrice:    uiOut > 0 ? (result.inAmount ?? budget) / uiOut : 0,
    solSpent:      result.inAmount ?? budget,
    tokenAmount:   result.outAmount,
    tokenDecimals,
    txSig:         result.txSig,
    execCosts:     result.execCosts ?? null,
    entryPattern:  'FOLLOW',
    entryScore:    null,
    entryConditions: { followedWallet: watch.address, followWatchId: watch.id },
  });
  await notify(`🤝 *Shadow buy* ${info?.symbol ?? mint.slice(0, 6)} — ${budget} SOL (following ${watch.address.slice(0, 4)}…)`);
  log('info', `shadow buy executed: ${mint.slice(0, 8)}`, { budget });
}

// ── holder-exodus guard ───────────────────────────────────────────────────────

const HOLDER_FLAG_FILE = path.join(__dirname, '../data/holder_exodus.json');

// Re-checks the entry-time top-5 holder token accounts of every open position.
// A holder balance dropping >= strategy.holderExitDropPct triggers an alert
// (default) or a flag the monitor turns into a forced 'whale-exit'
// (strategy.holderExodusExit = 'exit'). 'off' disables the guard.
async function checkHolderExodus(ctx, cfg, notify) {
  const mode = cfg.strategy?.holderExodusExit ?? 'alert';
  if (mode === 'off') return;
  const connection = ctx.wallet?.connection;
  if (!connection) return;
  const positions = require('./positions');
  const open = positions.getAll();
  const dropPctMin = cfg.strategy?.holderExitDropPct ?? 50;

  let flags = {};
  try { flags = JSON.parse(fs.readFileSync(HOLDER_FLAG_FILE, 'utf8')); } catch { flags = {}; }
  // prune flags for positions no longer open
  for (const m of Object.keys(flags)) if (!open[m]) delete flags[m];

  const { PublicKey } = require('@solana/web3.js');
  for (const [mint, pos] of Object.entries(open)) {
    if (flags[mint]) continue;                       // already flagged/alerted once
    const holders = pos.topHolders ?? [];
    if (!holders.length) continue;
    for (const h of holders) {
      try {
        let cur = 0;
        try {
          const bal = await connection.getTokenAccountBalance(new PublicKey(h.address));
          cur = bal?.value?.uiAmount ?? 0;
        } catch { cur = 0; /* account closed/emptied → full exit */ }
        const dropPct = h.uiAmount > 0 ? ((h.uiAmount - cur) / h.uiAmount) * 100 : 0;
        if (dropPct >= dropPctMin) {
          flags[mint] = { address: h.address, dropPct: +dropPct.toFixed(1), at: new Date().toISOString(), action: mode, handled: false };
          const msg = `🐋 *${pos.symbol ?? mint.slice(0, 6)}*: an entry-time top holder ` +
            `${cur === 0 ? 'fully exited' : `dumped ${dropPct.toFixed(0)}%`} of their stack` +
            (mode === 'exit' ? ' — forcing exit (whale-exit)' : ' — heads up (holderExodusExit=alert)');
          await notify(msg);
          log('warn', `holder exodus on ${mint.slice(0, 8)}: ${dropPct.toFixed(1)}% drop`, { mode });
          break;
        }
      } catch (e) { log('warn', `holder check ${mint.slice(0, 8)}: ${e.message}`); }
    }
  }
  const tmp = HOLDER_FLAG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(flags, null, 2));
  fs.renameSync(tmp, HOLDER_FLAG_FILE);
}

module.exports = { start, list, addPriceWatch, addWalletWatch, addFollowWatch, removeWatch,
                   checkPriceWatches, checkWalletWatches, checkFollowWatches, checkHolderExodus, shadowBuy };

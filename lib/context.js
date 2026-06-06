// lib/context.js — startup intelligence context for circuit-agent
// Fetches a market snapshot at agent start and saves to data/session-context.json.
// The processor injects this into the system prompt so the LLM starts informed.
//
// Refreshed once on startup (not per-message) to avoid hitting APIs every call.
// Stale after 10 minutes — processor re-reads the file each session.
'use strict';

const fs   = require('fs');
const path = require('path');

const CONTEXT_FILE = path.join(__dirname, '../data/session-context.json');
const HISTORY_FILE = path.join(__dirname, '../data/trade_history.json');
const MAX_AGE_MS   = 35 * 60_000; // 35 min — slightly longer than the default 30-min refresh interval

const log = (level, msg) => {
  process.stdout.write(`[${new Date().toISOString()}] [CTX] [${level.toUpperCase()}] ${msg}\n`);
};

// ── Load recent trade history summary ─────────────────────────────────────────

function _tradeSummary() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return null;
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const week    = Date.now() - 7 * 86_400_000;
    const recent  = history.filter(t => new Date(t.exitTime).getTime() >= week);
    if (!recent.length) return null;

    const wins    = recent.filter(t => (t.pnlPct ?? 0) > 0).length;
    const totalPnl = recent.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    const avgPnl   = recent.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / recent.length;
    const best     = recent.reduce((b, t) => (t.pnlPct ?? -Infinity) > (b.pnlPct ?? -Infinity) ? t : b, recent[0]);
    const worst    = recent.reduce((w, t) => (t.pnlPct ?? Infinity) < (w.pnlPct ?? Infinity) ? t : w, recent[0]);

    return {
      trades:   recent.length,
      wins,
      losses:   recent.length - wins,
      winRate:  +(wins / recent.length * 100).toFixed(1),
      totalPnlSol: +totalPnl.toFixed(5),
      avgPnlPct:   +avgPnl.toFixed(2),
      best:  best  ? { symbol: best.symbol,  pnlPct: +best.pnlPct.toFixed(1)  } : null,
      worst: worst ? { symbol: worst.symbol, pnlPct: +worst.pnlPct.toFixed(1) } : null,
    };
  } catch { return null; }
}

// ── Fetch market snapshot from API ────────────────────────────────────────────

async function refresh(api) {
  log('info', 'Refreshing startup context…');

  // Paid calls must run sequentially — parallel x402 payments from the same wallet
  // grab the same blockhash and produce identical transactions when amounts match,
  // causing duplicate txSigs and Payment Verification Failed errors.
  // swarmStats is free so order doesn't matter, but sequential is fine here.
  let pricesVal = null, sentimentVal = null, newsVal = null, swarmVal = null;
  try { pricesVal    = await api.oraclePrices(); }                       catch {}
  try { sentimentVal = await api.marketSentiment(); }                    catch {}
  try { newsVal      = await api.news({ limit: 5, filter: 'rising' }); } catch {}
  try { swarmVal     = await api.swarmStats(); }                         catch {}

  // SOL price from oracle
  let solPrice = null;
  let solChange24h = null;
  if (pricesVal) {
    const p = pricesVal;
    // API returns prices as an array [{symbol, price}] — find SOL entry
    const sol = Array.isArray(p.prices)
      ? p.prices.find(x => x.symbol === 'SOL')
      : (p.prices?.SOL ?? p.SOL ?? null);
    if (sol) {
      solPrice     = sol.price    ?? sol.usd ?? null;
      solChange24h = sol.change24h ?? null;
    }
  }

  // Fear & Greed
  let fearGreed = null;
  if (sentimentVal) {
    fearGreed = sentimentVal.fearGreed ?? sentimentVal.fearAndGreed ?? null;
  }

  // Top news headlines
  let headlines = [];
  if (newsVal) {
    const items = newsVal.news ?? newsVal.items ?? [];
    headlines = items.slice(0, 5).map(n => n.title ?? n.headline ?? '').filter(Boolean);
  }

  // Swarm stats
  let swarmStats = null;
  if (swarmVal) {
    swarmStats = {
      agents:  swarmVal.agents?.total ?? 0,
      signals: swarmVal.signals?.total ?? 0,
    };
  }

  const tradeSummary = _tradeSummary();

  const context = {
    refreshedAt: new Date().toISOString(),
    sol: solPrice != null ? {
      price:    +solPrice.toFixed(2),
      change24h: solChange24h != null ? +solChange24h.toFixed(1) : null,
    } : null,
    fearGreed,
    news: headlines,
    swarm: swarmStats,
    trades: tradeSummary,
  };

  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
  log('info', `Context saved — SOL $${context.sol?.price ?? '?'}, F&G ${context.fearGreed?.value ?? '?'}`);
  return context;
}

// ── Build context string for system prompt injection ──────────────────────────

function buildContextBlock() {
  try {
    if (!fs.existsSync(CONTEXT_FILE)) return '';
    const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));

    // Don't inject if stale
    if (Date.now() - new Date(ctx.refreshedAt).getTime() > MAX_AGE_MS) return '';

    const lines = ['## Market Context (at startup)'];

    if (ctx.sol) {
      const chg = ctx.sol.change24h != null ? ` (${ctx.sol.change24h > 0 ? '+' : ''}${ctx.sol.change24h}% 24h)` : '';
      lines.push(`- SOL: $${ctx.sol.price}${chg}`);
    }

    if (ctx.fearGreed) {
      lines.push(`- Fear & Greed: ${ctx.fearGreed.value} — ${ctx.fearGreed.label ?? ctx.fearGreed.classification ?? ''}`);
    }

    if (ctx.swarm) {
      lines.push(`- Swarm: ${ctx.swarm.agents} active agent(s), ${ctx.swarm.signals} recent signal(s)`);
    }

    if (ctx.trades) {
      const t = ctx.trades;
      lines.push(`- Your trades (7d): ${t.trades} total, ${t.winRate}% win rate, ${t.totalPnlSol > 0 ? '+' : ''}${t.totalPnlSol} SOL P&L`);
      if (t.best)  lines.push(`  Best: ${t.best.symbol} +${t.best.pnlPct}%`);
      if (t.worst) lines.push(`  Worst: ${t.worst.symbol} ${t.worst.pnlPct}%`);
    }

    if (ctx.news?.length) {
      lines.push('- Top news:');
      ctx.news.forEach(h => lines.push(`  · ${h}`));
    }

    return '\n\n---\n\n' + lines.join('\n');
  } catch { return ''; }
}

module.exports = { refresh, buildContextBlock };

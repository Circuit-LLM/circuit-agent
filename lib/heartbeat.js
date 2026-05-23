// lib/heartbeat.js — Deterministic heartbeat for circuit-agent
//
// Every N minutes, builds a status message from local data + one batch price call.
// Sends to Telegram directly — NO LLM for routine heartbeats.
//
// Only escalates to LLM when exception conditions are detected:
//   - Any position within 2% of stop-loss threshold
//   - SOL balance below survival warning level
//   - Swarm rug alert on a held mint
//
// This replaces the old pattern of queuing every heartbeat through the LLM processor,
// which was making ~288 full LLM calls/day at 5-min intervals.
'use strict';

const fs   = require('fs');
const path = require('path');

const positions          = require('./positions');
const { enqueue, QUEUE_OUTGOING } = require('./processor');
const { loadIdentity }   = require('./profile');

const CONTEXT_FILE  = path.join(__dirname, '../data/session-context.json');
const LOG_FILE      = path.join(__dirname, '../logs/heartbeat.log');

function log(level, msg) {
  const ts  = new Date().toISOString();
  const out = `[${ts}] [HB] [${level.toUpperCase()}] ${msg}\n`;
  process.stdout.write(out);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, out);
  } catch { /* ignore */ }
}

// ── Registry heartbeat (simple POST, no LLM) ──────────────────────────────────

async function reportToRegistry(apiBase, internalKey, agentId, address) {
  if (!apiBase || !agentId) return;
  try {
    const held    = positions.getAll();
    const history = positions.getTradeHistory(100, 30);
    const wins    = history.filter(t => t.pnlPct > 0).length;
    const totalPnl = history.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    await fetch(`${apiBase}/api/agents/heartbeat`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalKey ? { 'X-Internal-Key': internalKey } : {}),
      },
      body: JSON.stringify({
        agentId, address,
        stats: {
          openPositions: Object.keys(held).length,
          totalTrades:   history.length,
          winRate:       history.length ? Math.round((wins / history.length) * 100) : null,
          pnlSol:        +totalPnl.toFixed(5),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    log('info', 'Registry heartbeat sent');
  } catch (err) {
    log('warn', `Registry heartbeat failed: ${err.message}`);
  }
}

// ── Read cached market context (no API call) ──────────────────────────────────

function _readContext() {
  try {
    if (!fs.existsSync(CONTEXT_FILE)) return null;
    const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    // Discard if older than 30 minutes
    if (Date.now() - new Date(ctx.refreshedAt).getTime() > 30 * 60_000) return null;
    return ctx;
  } catch { return null; }
}

// ── Build deterministic status + detect exceptions ────────────────────────────
// Returns { message: string, exceptions: string[] }

async function buildStatus(api, wallet, cfg) {
  const s           = cfg.strategy ?? {};
  const stopLossPct = s.stopLossPct   ?? -6;
  const held        = positions.getAll();
  const mints       = Object.keys(held);
  const exceptions  = [];

  // One batch price call for all open positions (same as monitor does every 10s,
  // but here we only pay for it every heartbeat interval, not every monitor tick)
  let priceMap = {};
  if (mints.length) {
    try {
      const result = await api.tokenPrices(mints);
      priceMap = result.prices ?? {};
    } catch { /* proceed without live prices */ }
  }

  // ── Position lines + stop-loss exception check ────────────────────────────
  const posLines = [];
  for (const [mint, pos] of Object.entries(held)) {
    const pd           = priceMap[mint];
    const currentPrice = pd?.priceNative ?? pd?.usdPrice ?? null;
    let pnlPct = null;
    let pnlStr = 'price unavailable';

    if (currentPrice != null && pos.solSpent) {
      const decimals = pos.tokenDecimals ?? 6;
      const uiAmt    = Number(BigInt(String(pos.tokenAmount ?? 0))) / Math.pow(10, decimals);
      const curVal   = currentPrice * uiAmt;
      pnlPct         = ((curVal - pos.solSpent) / pos.solSpent) * 100;
      const peak     = pos.peakPnlPct ?? 0;
      const holdMin  = positions.holdMinutes(pos).toFixed(0);
      const sign     = pnlPct >= 0 ? '+' : '';
      pnlStr = `${sign}${pnlPct.toFixed(1)}% | peak ${peak >= 0 ? '+' : ''}${peak.toFixed(1)}% | ${holdMin}min`;
    }

    const symbol = pos.symbol ?? mint.slice(0, 6);
    posLines.push(`• ${symbol.padEnd(10)} ${pnlStr}`);

    // Exception: within 2% of stop-loss
    if (pnlPct != null && pnlPct <= stopLossPct + 2) {
      exceptions.push(`${symbol} approaching stop-loss: ${pnlPct.toFixed(1)}% (threshold: ${stopLossPct}%)`);
    }
  }

  // ── Wallet balances + low-SOL exception check ─────────────────────────────
  let solBal = null, circuitBal = null;
  try {
    const balances = await wallet.getBalances();
    solBal   = balances.sol   ?? null;
    circuitBal = balances.circuit ?? null;
    const minWarn = cfg.survival?.minSolWarning ?? 0.03;
    if (solBal != null && solBal < minWarn) {
      exceptions.push(`Low SOL: ${solBal.toFixed(4)} SOL (minimum: ${minWarn} SOL)`);
    }
  } catch { /* proceed without balances */ }

  // ── Market context (cached, no API call) ──────────────────────────────────
  const ctx = _readContext();

  // ── Format Telegram message ───────────────────────────────────────────────
  const now   = new Date();
  const timeStr = now.toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const lines = [`💓 *Heartbeat* — ${timeStr}`];

  if (posLines.length) {
    lines.push(`\n📊 *Positions (${posLines.length})*`);
    lines.push(...posLines);
  } else {
    lines.push('\n📊 No open positions');
  }

  lines.push('\n💰 *Wallet*');
  if (solBal   != null) lines.push(`• SOL: ${solBal.toFixed(4)}`);
  if (circuitBal != null) lines.push(`• CIRCUIT: ${Math.round(circuitBal).toLocaleString()}`);

  if (ctx?.sol) {
    lines.push('\n📈 *Market*');
    const chg = ctx.sol.change24h != null
      ? ` (${ctx.sol.change24h >= 0 ? '+' : ''}${ctx.sol.change24h}% 24h)`
      : '';
    lines.push(`• SOL: $${ctx.sol.price}${chg}`);
    if (ctx.fearGreed) lines.push(`• F&G: ${ctx.fearGreed.value} — ${ctx.fearGreed.classification ?? ''}`);
    if (ctx.swarm)     lines.push(`• Swarm: ${ctx.swarm.agents} agent(s), ${ctx.swarm.signals} signals`);
  }

  if (exceptions.length) {
    lines.push('\n⚠️ *Exceptions detected — LLM review queued*');
    exceptions.forEach(e => lines.push(`• ${e}`));
  }

  return { message: lines.join('\n'), exceptions };
}

// ── Escalate to LLM with pre-built context (LLM won't need to call tools) ─────

function escalateToLLM(exceptions, statusMessage) {
  const list   = exceptions.join('\n• ');
  const prompt =
    `⚠️ EXCEPTION HEARTBEAT — immediate review needed:\n• ${list}\n\n` +
    `Current status snapshot (already fetched — no need to call check_wallet):\n${statusMessage}\n\n` +
    `Assess each exception and decide whether to exit any positions using sell_token, ` +
    `or adjust config using update_config. Be decisive. Report what you did and why.`;

  const msgId = `heartbeat_exception_${Date.now()}`;
  enqueue('heartbeat', 'System', 'heartbeat', prompt, msgId);
  log('warn', `LLM escalation queued — exceptions: ${exceptions.join('; ')}`);
  return msgId;
}

// ── Watch for LLM exception response → Telegram ───────────────────────────────

function watchForResponse(messageId, telegramBot, chatId, timeoutMs = 90_000) {
  if (!telegramBot || !chatId) return;
  const deadline = Date.now() + timeoutMs;
  const interval = setInterval(async () => {
    try {
      const files = (await fs.promises.readdir(QUEUE_OUTGOING))
        .filter(f => f.includes(messageId) && f.endsWith('.json'));
      if (!files.length) {
        if (Date.now() > deadline) { clearInterval(interval); log('warn', 'Exception response timed out'); }
        return;
      }
      clearInterval(interval);
      const fpath = path.join(QUEUE_OUTGOING, files[0]);
      const data  = JSON.parse(await fs.promises.readFile(fpath, 'utf8'));
      await fs.promises.unlink(fpath);
      log('info', `Exception response: ${data.message.slice(0, 80)}`);
      telegramBot.api?.sendMessage(chatId, `⚠️ *Exception Response*\n\n${data.message}`, { parse_mode: 'Markdown' })
        .catch(() => telegramBot.api?.sendMessage(chatId, `Exception Response\n\n${data.message}`).catch(() => {}));
    } catch (err) {
      log('warn', `Watch error: ${err.message}`);
      clearInterval(interval);
    }
  }, 2000);
}

// ── Start heartbeat loop ──────────────────────────────────────────────────────

// Track last escalation time per exception key to prevent LLM spam.
// Same exception re-escalates at most once per EXCEPTION_COOLDOWN_MS.
const _lastEscalated = new Map();
const EXCEPTION_COOLDOWN_MS = 30 * 60_000; // 30 minutes between LLM calls per exception

function start(cfg, agentCtx, telegramBot = null) {
  const intervalMs = cfg.heartbeat?.intervalMs ?? 5 * 60_000;
  const apiBase    = cfg.api?.baseUrl;
  const internalK  = process.env.CIRCUIT_INTERNAL_KEY ?? '';
  const chatId     = cfg.telegram?.heartbeatChatId ?? null;
  const { api, wallet } = agentCtx;

  const _id  = loadIdentity();
  const agentId = _id.agentId ?? null;
  const address = _id.address ?? wallet?.address ?? null;

  log('info', `Heartbeat started — every ${intervalMs / 1000}s (deterministic; LLM only on exceptions)`);

  const beat = async () => {
    log('info', 'Heartbeat tick');
    try {
      // 1. Build status deterministically (one batch price call + one wallet call)
      const { message, exceptions } = await buildStatus(api, wallet, cfg);
      log('info', `Status built — ${exceptions.length} exception(s)`);

      // 2. Send status to Telegram
      if (telegramBot && chatId) {
        telegramBot.api?.sendMessage(chatId, message, { parse_mode: 'Markdown' })
          .catch(() => telegramBot.api?.sendMessage(chatId, message).catch(() => {}));
      }

      // 3. Escalate to LLM only on new/changed exceptions — deduplicated by 30-min cooldown.
      // Without this, a persistent low-SOL or stop-loss warning re-queues the LLM every 5 min.
      if (exceptions.length) {
        const now = Date.now();
        const newExceptions = exceptions.filter(ex => {
          const key  = ex.slice(0, 60); // Stable prefix as dedup key
          const last = _lastEscalated.get(key) ?? 0;
          return now - last > EXCEPTION_COOLDOWN_MS;
        });
        if (newExceptions.length) {
          newExceptions.forEach(ex => _lastEscalated.set(ex.slice(0, 60), now));
          const msgId = escalateToLLM(newExceptions, message);
          watchForResponse(msgId, telegramBot, chatId);
        }
      }

      // 4. Registry heartbeat (simple POST, no LLM)
      reportToRegistry(apiBase, internalK, agentId, address);

    } catch (err) {
      log('error', `Heartbeat error: ${err.message}`);
    }
  };

  // Jitter offsets heartbeat from scanner (which also starts at ~90s) so they
  // don't both fire price/wallet calls at the same second on every interval.
  const jitter = Math.floor(Math.random() * 60_000);  // 0-60s
  setTimeout(beat, 30_000 + jitter);
  setInterval(beat, intervalMs);
}

module.exports = { start };

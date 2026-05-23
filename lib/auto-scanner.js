// lib/auto-scanner.js — Autonomous market scanner + auto-buyer for circuit-agent
// Runs every scanIntervalMs (default 5min).
// Scans for dip-reversal candidates, runs rug check, auto-buys best candidate.
// Respects the session strategy set by agent-loop.js (mode, patternFilter, score override).
// In "selective" mode, top candidate passes through the pre-buy LLM gate before buying.
'use strict';

const positions            = require('./positions');
const { scoreDipReversal } = require('./scoring');
const { isPaused, pauseStatus } = require('./pause');
const { loadStrategy, incrementSessionBuy } = require('./agent-loop');
const preBuyGate           = require('./pre-buy-gate');
const { loadIdentity }     = require('./profile');

// Publish scan_quality signal to swarm (fire-and-forget)
async function _broadcastScanQuality(api, { candidates, passed, rejected, topScore, topPattern }) {
  const { agentId, address } = loadIdentity();
  if (!agentId && !address) return;
  await api.swarmPublish({
    agentId, address,
    type:       'scan_quality',
    confidence: 0.9,
    ttlSeconds: 10800,   // 3h
    data:       { candidates, passed, rejected, topScore: topScore ?? null, topPattern: topPattern ?? null },
  }).catch(() => {});
}

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [SCAN] [${level.toUpperCase()}] ${line}\n`);
};

// ── One scan + optional buy cycle ─────────────────────────────────────────────

async function runCycle(api, wallet, swap, cfg, notify) {
  const s    = cfg.strategy ?? {};
  const risk = cfg.risk ?? {};

  // Load session strategy — set by agent-loop.js every ~90 min.
  // If the strategy has expired (agent-loop missed its cycle), fall back to
  // "active" mode with config defaults so trading continues safely.
  const rawSession = loadStrategy();
  const strategyExpired = rawSession.expiresAt && Date.now() > new Date(rawSession.expiresAt).getTime();
  const session = strategyExpired
    ? { ...rawSession, mode: 'active', patternFilter: null, minScoreOverride: null }
    : rawSession;
  if (strategyExpired) {
    log('warn', 'Session strategy expired — using active/default until agent-loop refreshes');
  }

  const minScanScore     = session.minScoreOverride ?? s.minScanScore ?? 55;
  const minLiquidity     = s.minLiquidity       ?? 50_000;
  const maxOpenPositions = s.maxOpenPositions   ?? 3;
  const entryBudgetSol   = s.entryBudgetSol     ?? 0.005;
  const maxEntry1hDrop   = risk.maxEntry1hDropPct ?? -15;
  const blacklist        = Array.isArray(risk.blacklist) ? risk.blacklist : [];
  const safeOnly         = risk.safeOnly ?? false;
  const minSolPause      = cfg.survival?.minSolPause ?? 0.01;

  // Check pause state — monitor still runs, only new buys are gated
  if (isPaused()) {
    const state = pauseStatus();
    const until = state.until ? ` until ${new Date(state.until).toUTCString()}` : '';
    log('info', `Trading paused${until} (${state.reason || 'manual'}) — skipping scan`);
    return;
  }

  // watchOnly mode — scan for signal quality but don't buy
  if (session.mode === 'watchOnly') {
    log('info', `Mode: watchOnly — scanning for signal data only (goal: ${session.sessionGoal})`);
    // Fall through to scan + score + broadcast but return before buy
  }

  // Check session buy cap
  const sessionMaxBuys = session.maxBuysThisSession;
  const sessionBuys    = session.buysThisSession ?? 0;
  if (sessionMaxBuys != null && sessionBuys >= sessionMaxBuys) {
    log('info', `Session buy cap reached (${sessionBuys}/${sessionMaxBuys}) — skipping buy`);
    return;
  }

  // Check if at position cap
  const openCount = positions.count();
  if (openCount >= maxOpenPositions) {
    log('info', `At position cap (${openCount}/${maxOpenPositions}) — skipping scan`);
    return;
  }

  // Scan market
  log('info', 'Scanning market…');
  let candidates = [];
  try {
    const result = await api.scan({ limit: 30, minLiquidity, safeOnly });
    candidates = result.candidates ?? [];
    log('info', `Scan returned ${candidates.length} candidates`);
  } catch (err) {
    log('warn', 'Scan failed', { error: err.message });
    return;
  }

  if (!candidates.length) {
    log('info', 'No candidates from scan');
    return;
  }

  // Filter: liquidity, 1h drop limit, blacklist, already held, rug danger, cooldown
  const heldMints    = new Set(Object.keys(positions.getAll()));
  const cooldownMs   = (s.buyCooldownMinutes ?? 60) * 60_000;
  const recentTrades = positions.getTradeHistory(200, 7);
  const recentlyTraded = new Set(
    recentTrades
      .filter(t => Date.now() - new Date(t.exitTime).getTime() < cooldownMs)
      .map(t => t.mint)
  );

  const filtered = candidates.filter(c => {
    if (!c.mint) return false;
    if (heldMints.has(c.mint)) return false;
    if (blacklist.includes(c.mint)) return false;
    if (recentlyTraded.has(c.mint)) return false;
    if ((c.liquidity ?? 0) < minLiquidity) return false;
    if ((c.priceChange1h ?? 0) < maxEntry1hDrop) return false;
    // Hard rug blocks — both fields use UPPER_CASE from scan route
    if (c.verdict  === 'DANGER') return false;
    if (c.rugRisk  === 'DANGER') return false;
    return true;
  });

  // Also filter against swarm blacklist (fire-and-forget fetch — skip on timeout)
  let swarmBlacklisted = new Set();
  try {
    const resp = await api.blacklistGet({ limit: 500 });
    if (resp?.blacklist) swarmBlacklisted = new Set(resp.blacklist.map(e => e.mint));
  } catch { /* blacklist unavailable — continue */ }

  const preBlacklistCount = filtered.length;
  const filteredFinal = filtered.filter(c => !swarmBlacklisted.has(c.mint));
  if (filteredFinal.length < preBlacklistCount) {
    log('info', `Swarm blacklist removed ${preBlacklistCount - filteredFinal.length} candidate(s)`);
  }

  log('info', `${filteredFinal.length} candidates after filters (minLiq=${minLiquidity}, maxDrop1h=${maxEntry1hDrop}%)`);

  // Score with full 6-component dip-reversal scorer
  let scored = filteredFinal.map(c => {
    const result = scoreDipReversal(c, cfg);
    return { ...c, _score: result.score, _passed: result.passed, _pattern: result.pattern, _breakdown: result.breakdown, _gates: result.gateFailures };
  }).filter(c => c._passed).sort((a, b) => b._score - a._score);

  // Apply session pattern filter if set
  if (session.patternFilter?.length) {
    const before = scored.length;
    scored = scored.filter(c => session.patternFilter.includes(c._pattern));
    if (scored.length < before) {
      log('info', `Pattern filter [${session.patternFilter.join(',')}] removed ${before - scored.length} candidate(s)`);
    }
  }

  // Broadcast scan quality to swarm (non-blocking)
  const rejected = filteredFinal.length - scored.length + (preBlacklistCount - filteredFinal.length) + (candidates.length - filtered.length);
  _broadcastScanQuality(api, {
    candidates: candidates.length,
    passed:     scored.length,
    rejected,
    topScore:   scored[0]?._score ?? null,
    topPattern: scored[0]?._pattern ?? null,
  }).catch(() => {});

  if (!scored.length) {
    log('info', 'No candidates passed dip-reversal gates');
    return;
  }

  const best = scored[0];
  log('info', `Scored: ${scored.slice(0, 5).map(c => `${c.symbol}(${c._score})`).join(', ')}`);
  log('info', `Top candidate: ${best.symbol ?? best.mint.slice(0, 8)}`, {
    score:   best._score,
    pattern: best._pattern,
    liq:     `$${((best.liquidity ?? 0) / 1000).toFixed(0)}k`,
    '1h':    `${(best.priceChange1h ?? 0).toFixed(1)}%`,
    verdict: best.verdict ?? best.rugRisk ?? 'unknown',
  });

  // watchOnly mode — we've done the scan and broadcast; stop before buying
  if (session.mode === 'watchOnly') {
    log('info', `watchOnly — top candidate noted but not bought: ${best.symbol ?? best.mint.slice(0, 8)} (${best._score})`);
    return;
  }

  // Token info / rug check (non-blocking — proceed on error)
  let rugVerdict = best.verdict ?? best.rugRisk ?? 'unknown';
  try {
    const info = await api.tokenInfo(best.mint);
    rugVerdict = info.verdict ?? info.rugRisk ?? rugVerdict;
    if (rugVerdict?.toUpperCase() === 'DANGER') {
      log('warn', `Rug DANGER — aborting ${best.symbol}`);
      notify(`⚠️ *${best.symbol ?? best.mint.slice(0, 8)}* flagged DANGER — skipped`);
      return;
    }
    log('info', `Rug check: ${rugVerdict}`, { symbol: best.symbol });
  } catch (err) {
    log('warn', 'Token info unavailable — proceeding on scan rug score', { error: err.message });
  }

  // Re-check position count (may have changed)
  if (positions.count() >= maxOpenPositions) {
    log('info', 'Position cap reached during check — skipping buy');
    return;
  }

  // Check SOL balance
  let solBalance = 0;
  try {
    solBalance = await wallet.getSolBalance();
  } catch (err) {
    log('warn', 'SOL balance check failed', { error: err.message });
    return;
  }

  if (solBalance - entryBudgetSol < minSolPause) {
    log('warn', 'Insufficient SOL', { balance: solBalance.toFixed(4), needed: entryBudgetSol });
    notify(`⚠️ Low SOL (${solBalance.toFixed(4)}) — can't buy *${best.symbol}*`);
    return;
  }

  // Consensus sizing: if 2+ peer agents are bullish on this mint, scale up entry
  let finalBudget = entryBudgetSol;
  let swarmNote   = '';
  try {
    const consensusBoost = cfg.swarm?.consensusBoostFactor ?? 1.0;
    const consensus = await api.swarmConsensus(best.mint);
    if (consensus?.consensus === 'bullish' && consensus.agents >= 2) {
      finalBudget = Math.min(entryBudgetSol * consensusBoost, solBalance * 0.15);
      swarmNote   = ` [swarm ${consensus.agents} bullish × ${consensusBoost}x]`;
      log('info', `Swarm consensus boost: ${best.symbol} — ${consensus.agents} agents bullish, scaling to ${finalBudget.toFixed(4)} SOL`);
    } else if (consensus?.consensus === 'rug_alert') {
      log('warn', `Swarm rug_alert on ${best.symbol} — aborting`);
      notify(`⚠️ Swarm rug alert on *${best.symbol}* — skipped`);
      return;
    }
  } catch { /* swarm unavailable — proceed with base budget */ }

  // Pre-buy gate — only in "selective" mode; "active" mode trusts the scorer
  if (session.mode === 'selective') {
    log('info', `Selective mode — calling pre-buy gate for ${best.symbol ?? best.mint.slice(0, 8)}`);
    const gate = await preBuyGate.check(best, session, positions.count());
    if (!gate.approved) {
      log('info', `Gate rejected ${best.symbol ?? best.mint.slice(0, 8)}: ${gate.reasoning}`);
      notify(`🚫 *${best.symbol ?? best.mint.slice(0, 8)}* rejected by agent (score ${best._score}): ${gate.reasoning}`);
      return;
    }
    log('info', `Gate approved ${best.symbol ?? best.mint.slice(0, 8)}: ${gate.reasoning}`);
  }

  // Buy
  const symbol = best.symbol ?? best.mint.slice(0, 8);
  log('info', `Buying ${symbol}`, { sol: finalBudget, score: best._score, pattern: best._pattern });
  notify(
    `🔍 *${symbol}* — ${best._pattern} score ${best._score}/100, liq $${((best.liquidity ?? 0) / 1000).toFixed(0)}k, ` +
    `1h ${(best.priceChange1h ?? 0).toFixed(1)}% 5m ${(best.priceChange5m ?? 0).toFixed(1)}% | Buying ${finalBudget.toFixed(4)} SOL${swarmNote}…`
  );

  try {
    const result = await swap.buy(best.mint, finalBudget);

    // Fetch actual decimals from RPC — don't hardcode 6 (many tokens use 9)
    let tokenDecimals = 6;
    try {
      const bal = await swap.getTokenBalance(best.mint);
      if (bal.decimals > 0) tokenDecimals = bal.decimals;
    } catch (_) {}

    // Use actual inAmount (post-slippage) for accurate entry price tracking
    const actualSolSpent = result.inAmount ?? finalBudget;
    const pricePerToken  = result.outAmount > 0 ? actualSolSpent / result.outAmount : 0;

    const opened = positions.openPosition(best.mint, {
      symbol:        symbol,
      entryPrice:    pricePerToken,
      solSpent:      actualSolSpent,
      tokenAmount:   result.outAmount,
      tokenDecimals,
      txSig:         result.txSig,
    });
    if (!opened) {
      log('warn', 'Position already existed — skipping duplicate open', { symbol });
    }

    // Track session buy count — use incrementSessionBuy() not saveStrategy() so
    // the 90-min expiresAt is NOT reset on every buy (saveStrategy always refreshes TTL).
    incrementSessionBuy();

    notify(
      `✅ *${symbol}* bought\n` +
      `${(result.inAmount ?? finalBudget).toFixed(4)} SOL → ${Number(result.outAmount).toLocaleString()} tokens\n` +
      `Score: ${best._score}/100 (${best._pattern}) | ${rugVerdict} | SL: ${s.stopLossPct ?? -6}% TP: ${s.takeProfitPct ?? 12}%${swarmNote}`
    );
    log('info', 'Buy complete', { symbol, txSig: result.txSig?.slice(0, 16) });
  } catch (err) {
    log('error', 'Buy failed', { symbol, error: err.message });
    notify(`❌ Buy failed for *${symbol}*: ${err.message}`);
  }
}

// ── Start scanner loop ────────────────────────────────────────────────────────

function start(cfg, agentCtx, telegramBot = null) {
  const { api, wallet, swap } = agentCtx;
  const intervalMs = cfg.strategy?.scanIntervalMs ?? 300_000;
  const chatId = cfg.telegram?.heartbeatChatId ?? null;

  const notify = (msg) => {
    log('info', `[notify] ${msg.replace(/\*/g, '').slice(0, 100)}`);
    if (telegramBot && chatId) {
      telegramBot.api?.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
        .catch(() => telegramBot.api?.sendMessage(chatId, msg).catch(() => {}));
    }
  };

  // Jitter spreads concurrent agents across the scan window so they don't
  // all hit RugCheck / DexScreener at the same second after a restart.
  const jitterMs = Math.floor(Math.random() * 120_000);
  const firstScanMs = 90_000 + jitterMs;

  log('info', `Auto-scanner started — scanning every ${intervalMs / 60_000}min (first scan in ${Math.round(firstScanMs / 1000)}s)`);

  const tick = () => runCycle(api, wallet, swap, cfg, notify).catch(err =>
    log('error', 'Scan cycle error', { error: err.message })
  );

  setTimeout(() => { tick(); setInterval(tick, intervalMs); }, firstScanMs);
}

module.exports = { start };

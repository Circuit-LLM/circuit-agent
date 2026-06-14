// lib/auto-scanner.js — Autonomous market scanner + auto-buyer for circuit-agent
// Runs every scanIntervalMs (default 5min).
// Scans for dip-reversal candidates, runs rug check, auto-buys best candidate.
// Respects the session strategy set by agent-loop.js (mode, patternFilter, score override).
// In "selective" mode, top candidate passes through the pre-buy LLM gate before buying.
'use strict';

const fs                   = require('fs');
const path                 = require('path');
const positions            = require('./positions');
const { scoreDipReversal } = require('./scoring');
const { isPaused, pauseStatus } = require('./pause');
const { loadStrategy, incrementSessionBuy } = require('./agent-loop');
const preBuyGate           = require('./pre-buy-gate');
const { loadIdentity }     = require('./profile');
const { loadConfig }       = require('./config');
const { acquireBuyLock, releaseBuyLock } = require('./trade-lock');

const LAST_SCAN_FILE = path.join(__dirname, '../data/last_scan.json');

function _writeLastScan(data) {
  try { fs.writeFileSync(LAST_SCAN_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// Publish scan_quality signal to swarm (fire-and-forget)
async function _broadcastScanQuality(api, { candidates, passed, rejected, topScore, topPattern, paper = false }) {
  const { agentId, address } = loadIdentity();
  if (!agentId && !address) return;
  await api.swarmPublish({
    agentId, address,
    type:       'scan_quality',
    confidence: 0.9,
    ttlSeconds: 10800,   // 3h
    data:       { candidates, passed, rejected, topScore: topScore ?? null, topPattern: topPattern ?? null,
                  ...(paper ? { paper: true } : {}) },
  }).catch(() => {});
}

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [SCAN] [${level.toUpperCase()}] ${line}\n`);
};

// ── One scan + optional buy cycle ─────────────────────────────────────────────

async function runCycle(api, wallet, swap, cfg, notify) {
  const s       = cfg.strategy ?? {};
  const risk    = cfg.risk ?? {};
  const isPaper = swap?.paperMode === true;

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

  // watchOnly mode — scan for signal quality but don't buy.
  // Must be checked BEFORE the session buy cap so watchOnly still runs scans and
  // broadcasts scan_quality signals even when maxBuysThisSession is 0 or exhausted.
  const isWatchOnly = session.mode === 'watchOnly';
  if (isWatchOnly) {
    log('info', `Mode: watchOnly — scanning for signal data only (goal: ${session.sessionGoal})`);
    // Fall through to scan + score + broadcast but return before buy
  }

  // Circuit breaker — pause new buys after 3 consecutive losses within 60 min.
  // Prevents repeated entries during a losing streak or bad market window.
  // watchOnly scans continue unaffected (signal collection is not gated).
  if (!isWatchOnly) {
    const cbHistory = positions.getTradeHistory(5, 7).slice(-3);
    if (cbHistory.length >= 3 && cbHistory.every(t => (t.pnlPct ?? 0) < 0)) {
      const lastExit = new Date(cbHistory[cbHistory.length - 1].exitTime).getTime();
      if (Date.now() - lastExit < 60 * 60_000) {
        const pcts = cbHistory.map(t => `${(t.pnlPct ?? 0).toFixed(1)}%`).join(', ');
        log('warn', `Circuit breaker: 3 consecutive losses [${pcts}] — pausing buys for 60min`);
        return;
      }
    }
  }

  // Market regime gate — skip buys when Fear & Greed is below the agent's threshold.
  // Value from data/session-context.json (refreshed by agent-loop every ~90min).
  // Set fearGateMinFng per tier: Conservative=20, Balanced=25, Opportunistic=30, Contrarian=15.
  const fearGateMin = s.fearGateMinFng ?? 0;
  if (fearGateMin > 0 && !isWatchOnly) {
    try {
      const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/session-context.json'), 'utf8'));
      const fng = ctx?.fearGreed?.value;
      if (typeof fng === 'number' && fng < fearGateMin) {
        log('info', `Market regime gate: F&G ${fng} < threshold ${fearGateMin} — skipping scan`);
        return;
      }
    } catch { /* session-context unavailable — proceed */ }
  }

  // Check session buy cap — skip for watchOnly since no buys will occur
  if (!isWatchOnly) {
    const sessionMaxBuys = session.maxBuysThisSession;
    const sessionBuys    = session.buysThisSession ?? 0;
    if (sessionMaxBuys != null && sessionBuys >= sessionMaxBuys) {
      log('info', `Session buy cap reached (${sessionBuys}/${sessionMaxBuys}) — skipping buy`);
      return;
    }
  }

  // Check if at position cap — skip for watchOnly since we're observing, not buying
  const openCount = positions.count();
  if (!isWatchOnly && openCount >= maxOpenPositions) {
    log('info', `At position cap (${openCount}/${maxOpenPositions}) — skipping scan`);
    return;
  }

  // Scan market — use price-feed candle path in paper mode (no CIRC spent)
  log('info', 'Scanning market…');
  let candidates = [];
  try {
    const result  = isPaper
      ? await api.scanFree({ limit: 30, minLiquidity })
      : await api.scan({ limit: 30, minLiquidity, safeOnly });
    candidates = result.candidates ?? [];
    log('info', `Scan returned ${candidates.length} candidates${isPaper ? ' [paper/free]' : ''}`);
  } catch (err) {
    log('warn', 'Scan failed', { error: err.message });
    return;
  }

  if (!candidates.length) {
    log('info', 'No candidates from scan');
    return;
  }

  // Geyser confirmation — dexLosers returns mints currently dipping per the sub-second
  // gRPC price stream. Candidates that appear in both scan AND dexLosers are confirmed
  // dippers from two independent on-chain data sources.
  // A confirmed dipper gets a +5 score boost at scoring time.
  const _geyserDipMints = new Set();
  if (!isPaper) {
    try {
      const losersData = await api.dexLosers('5m', 50);
      if (losersData?.movers?.length) {
        for (const m of losersData.movers) {
          if (m.mint && m.changePct < -0.5) _geyserDipMints.add(m.mint);
        }
        log('info', `Geyser: ${_geyserDipMints.size} dipping mints (5m) from circuit-node`);
      }
    } catch (err) {
      log('warn', 'Geyser dexLosers unavailable — continuing without gRPC confirmation', { error: err.message });
    }
  }

  // Filter: liquidity, 1h drop limit, blacklist, already held, rug danger, cooldown
  const heldMints    = new Set(Object.keys(positions.getAll()));
  const baseCooldownMs = (s.buyCooldownMinutes ?? 60) * 60_000;
  const recentTrades   = positions.getTradeHistory(200, 7);
  const now            = Date.now();
  const recentlyTraded = new Set(
    recentTrades
      .filter(t => {
        const age = now - new Date(t.exitTime).getTime();
        const pnl = t.pnlPct ?? 0;
        // Loss-weighted cooldown: bigger losses = longer ban on re-entry.
        // Stops the agent re-entering the same bad token repeatedly (e.g. SPCX x34).
        let cooldown = baseCooldownMs;
        if      (pnl < -10) cooldown = 72 * 60 * 60_000; // >10% loss  → 72h
        else if (pnl <  -5) cooldown = 24 * 60 * 60_000; // 5–10% loss → 24h
        else if (pnl <  -2) cooldown =  6 * 60 * 60_000; // 2–5% loss  →  6h
        return age < cooldown;
      })
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

  log('info', `${filtered.length} candidates after local filters (minLiq=${minLiquidity}, maxDrop1h=${maxEntry1hDrop}%)`);

  // Score first — so swarm blacklist re-verification is only done for high-value candidates
  const GEYSER_BOOST = 5; // bonus for gRPC-confirmed dippers
  const allScored = filtered.map(c => {
    const result  = scoreDipReversal(c, cfg);
    const geyserConfirmed = _geyserDipMints.has(c.mint);
    const score   = result.passed && geyserConfirmed ? Math.min(result.score + GEYSER_BOOST, 100) : result.score;
    return { ...c, _score: score, _passed: result.passed, _pattern: result.pattern, _breakdown: result.breakdown, _gates: result.gateFailures, _geyser: geyserConfirmed };
  });
  let scored = allScored.filter(c => c._passed).sort((a, b) => b._score - a._score);

  // Apply pattern filter — session overrides config; config is the default baseline.
  // agentLoop.patternFilter in config sets the persistent strategy; the LLM session
  // can temporarily narrow or widen it for the current 90-min window.
  const effectivePatternFilter = session.patternFilter?.length
    ? session.patternFilter
    : (cfg.agentLoop?.patternFilter?.length ? cfg.agentLoop.patternFilter : null);
  if (effectivePatternFilter?.length) {
    const before = scored.length;
    scored = scored.filter(c => effectivePatternFilter.includes(c._pattern));
    if (scored.length < before) {
      log('info', `Pattern filter [${effectivePatternFilter.join(',')}] removed ${before - scored.length} candidate(s)`);
    }
  }

  // Swarm peer-holding filter — skip tokens already held by too many peers.
  // Prevents the whole swarm piling into the same token simultaneously.
  // maxSwarmHolders: 0 = disabled, default = 3 (max 3 of N agents in same token).
  const maxSwarmHolders = cfg.swarm?.maxSwarmHolders ?? 3;
  if (maxSwarmHolders > 0 && !isPaper) {
    try {
      const holdingsResp = await api.getSwarmHoldings?.();
      if (holdingsResp?.holdings?.length) {
        const peerHoldCounts = new Map(
          holdingsResp.holdings.map(h => [h.mint, h.agentCount ?? 0])
        );
        const before = scored.length;
        scored = scored.filter(c => (peerHoldCounts.get(c.mint) ?? 0) < maxSwarmHolders);
        const removed = before - scored.length;
        if (removed > 0) {
          log('info', `Peer-holding filter removed ${removed} candidate(s) already held by ≥${maxSwarmHolders} swarm agents`);
        }
      }
    } catch { /* swarm holdings unavailable — continue */ }
  }

  // Swarm recent-buy filter — skip mints bought by any swarm agent in the last N min.
  // Peer-holding check catches existing positions, but agents can race into the same
  // token in the same scan cycle before holdings propagate to the swarm store.
  const recentBuyWindowMs = (cfg.swarm?.recentBuyWindowMinutes ?? 30) * 60_000;
  if (recentBuyWindowMs > 0 && !isPaper) {
    try {
      const feedResp = await api.swarmFeedFree({ type: 'buy_signal', limit: 100 });
      // Apply minReputationToFollow here — same threshold as monitor.js _getSwarmSignals.
      // Without this a zero-rep agent could suppress buys of any token simply by
      // publishing a buy_signal for it, causing this agent to skip it via the recent-buy filter.
      const minRep = cfg.swarm?.minReputationToFollow ?? 40;
      // Exclude failed/retracted signals — a pending:true signal whose swap failed
      // should not block other agents from buying the same token.
      const recentlyBought = new Set(
        (feedResp?.signals ?? [])
          .filter(s => Date.now() - new Date(s.publishedAt).getTime() < recentBuyWindowMs &&
                       (s.reputation ?? 0) >= minRep &&
                       s.data?.failed !== true)
          .map(s => s.mint)
          .filter(Boolean)
      );
      if (recentlyBought.size > 0) {
        const before = scored.length;
        scored = scored.filter(c => !recentlyBought.has(c.mint));
        const removed = before - scored.length;
        if (removed > 0) {
          log('info', `Recent-buy filter removed ${removed} candidate(s) bought by swarm in last ${cfg.swarm?.recentBuyWindowMinutes ?? 30}min`);
        }
      }
    } catch { /* swarm feed unavailable — continue */ }
  }

  // Swarm blacklist — fetch then re-verify any flagged high-scorers against RugCheck.
  // Propagated blacklist entries are proposals, not commands: a hallucinated entry
  // from one agent must be confirmed by on-chain data before silently dropping a
  // candidate that our own scorer rates highly.
  let swarmBlacklisted = new Set();
  let swarmBlacklistRemovedCount = 0;
  const blacklistVerifyTopN = cfg.swarm?.blacklistVerifyTopN ?? 5;
  try {
    const resp = await api.blacklistGet({ limit: 500 });
    if (resp?.blacklist) {
      // Client-side TTL: ignore blacklist entries older than 72 hours if the server
      // provides a timestamp. Prevents stale votes from permanently suppressing tokens.
      const blacklistTtlMs = (cfg.swarm?.blacklistTtlHours ?? 72) * 60 * 60_000;
      const now = Date.now();
      swarmBlacklisted = new Set(
        resp.blacklist
          .filter(e => !e.addedAt || (now - new Date(e.addedAt).getTime()) < blacklistTtlMs)
          .map(e => e.mint)
      );
    }
  } catch { /* blacklist unavailable — continue without it */ }

  if (swarmBlacklisted.size > 0) {
    const verified = [];
    for (const c of scored) {
      if (!swarmBlacklisted.has(c.mint)) {
        verified.push(c);
        continue;
      }
      // Candidate is in swarm blacklist — re-verify with RugCheck before filtering.
      // Only spend the API call on top-N candidates; lower-ranked ones are filtered
      // directly (the cost of missing a borderline trade is acceptable).
      if (verified.length + swarmBlacklistRemovedCount >= blacklistVerifyTopN) {
        log('info', `Swarm blacklist filtered (unverified): ${c.symbol ?? c.mint.slice(0, 8)}`);
        swarmBlacklistRemovedCount++;
        continue;
      }
      try {
        const info = await (isPaper ? api.tokenInfoFree(c.mint) : api.tokenInfo(c.mint));
        // token-info response nests verdict under info.risk.verdict — not top-level.
        // Fall back to legacy top-level fields for compatibility with alternate API shapes.
        const verdict = (info.risk?.verdict ?? info.verdict ?? info.rugRisk ?? 'unknown').toUpperCase();
        const explicitlySafe = verdict === 'GOOD' || verdict === 'WARN';
        if (!explicitlySafe) {
          // Fail-closed: DANGER, UNKNOWN, or any unrecognised verdict — trust the blacklist.
          // Only an explicit 'GOOD' or 'WARN' from RugCheck is strong enough to override a swarm vote.
          log('info', `Swarm blacklist filtering ${c.symbol ?? c.mint.slice(0, 8)} — RugCheck=${verdict} (not explicitly safe)`);
          swarmBlacklistRemovedCount++;
        } else {
          log('warn', `Swarm blacklist discrepancy: ${c.symbol ?? c.mint.slice(0, 8)} blacklisted but RugCheck=${verdict} — allowing through`);
          verified.push(c);
        }
      } catch {
        // RugCheck unavailable — conservative: trust the blacklist
        log('info', `Swarm blacklist filtering ${c.symbol ?? c.mint.slice(0, 8)} — RugCheck unavailable`);
        swarmBlacklistRemovedCount++;
      }
    }
    scored = verified;
    if (swarmBlacklistRemovedCount > 0) {
      log('info', `Swarm blacklist removed ${swarmBlacklistRemovedCount} candidate(s) (RugCheck-verified)`);
    }
  }

  // Broadcast scan quality to swarm (non-blocking).
  // rejectedByFilter: failed liquidity/blacklist/held/1h-drop/rug pre-checks
  // rejectedByScorer: passed pre-checks but failed dip-reversal gates or swarm blacklist
  const rejectedByFilter = candidates.length - filtered.length;
  const rejectedByScorer = filtered.length - scored.length;
  _broadcastScanQuality(api, {
    candidates:        candidates.length,
    passed:            scored.length,
    rejected:          rejectedByFilter + rejectedByScorer,
    rejectedByFilter,
    rejectedByScorer,
    topScore:          scored[0]?._score ?? null,
    topPattern:        scored[0]?._pattern ?? null,
    paper:             isPaper,
  }).catch(() => {});

  // Write last scan snapshot for the local dashboard
  // Show the best passing candidate first (bought); only show top rejected if nothing passed
  const topRejected = allScored.filter(c => !c._passed).sort((a, b) => b._score - a._score)[0] ?? null;
  const topPasser   = scored[0] ?? null;
  _writeLastScan({
    ts:             new Date().toISOString(),
    totalFromScan:  candidates.length,
    passedFilter:   filtered.length,
    passedScoring:  scored.length,
    isPaper,
    topCandidate: topPasser ? {
      symbol:  topPasser.symbol ?? topPasser.mint?.slice(0, 8) ?? '?',
      mint:    topPasser.mint,
      score:   topPasser._score,
      pattern: topPasser._pattern,
      gates:   [],
      // Truthful intent flag: a candidate is only bought if it clears the score threshold.
      // (Final execution is still subject to rug/position-cap/balance checks downstream,
      //  but the dominant false "bought" came from sub-threshold candidates — fix that here.)
      bought:  topPasser._score >= minScanScore,
    } : topRejected ? {
      symbol:        topRejected.symbol ?? topRejected.mint?.slice(0, 8) ?? '?',
      mint:          topRejected.mint,
      score:         topRejected._score,
      pattern:       topRejected._pattern ?? null,
      gates:         topRejected._gates ?? [],
      liquidity:     topRejected.liquidity ?? null,
      priceChange1h: topRejected.priceChange1h ?? null,
      priceChange5m: topRejected.priceChange5m ?? null,
    } : null,
  });

  if (!scored.length) {
    if (topRejected) log('info', `No buy — top rejected: ${topRejected.symbol ?? topRejected.mint?.slice(0,8)} 5m:${(topRejected.priceChange5m??0).toFixed(1)}% 1h:${(topRejected.priceChange1h??0).toFixed(1)}% gates:[${(topRejected._gates??[]).join('; ')}]`);
    else log('info', 'No candidates passed dip-reversal gates');
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
    geyser:  best._geyser ? 'confirmed' : 'unconfirmed',
  });

  // Minimum score gate — config/session threshold was only used for consensus boost;
  // enforce it as a hard buy gate here.
  if (best._score < minScanScore) {
    log('info', `Top candidate ${best.symbol} score ${best._score} < minScanScore ${minScanScore} — skipping`);
    return;
  }

  // watchOnly mode — we've done the scan and broadcast; stop before buying
  if (isWatchOnly) {
    log('info', `watchOnly — top candidate noted but not bought: ${best.symbol ?? best.mint.slice(0, 8)} (${best._score})`);
    return;
  }

  // Token info / rug check — FAIL CLOSED. A reliable rug verdict is required before buying,
  // especially in low-liquidity territory where rugs concentrate. Paper mode uses the free
  // RugCheck API; live mode uses paid token-info (now backed by RugCheck, not circuit-node).
  let rugVerdict = best.verdict ?? best.rugRisk ?? 'unknown';
  let _tokenInfo  = null; // cached so the swarm rug_alert block reuses it — avoids double CIRC spend
  try {
    _tokenInfo = await (isPaper ? api.tokenInfoFree(best.mint) : api.tokenInfo(best.mint));
    // token-info nests verdict under info.risk.verdict — fall back to top-level for compatibility
    rugVerdict = _tokenInfo?.risk?.verdict ?? _tokenInfo?.verdict ?? _tokenInfo?.rugRisk ?? 'unknown';
    const v = rugVerdict?.toUpperCase();
    if (v === 'DANGER') {
      log('warn', `Rug DANGER — aborting ${best.symbol}`);
      notify(`⚠️ *${best.symbol ?? best.mint.slice(0, 8)}* flagged DANGER — skipped`);
      return;
    }
    // Fail closed: never buy on a missing/unknown verdict — RugCheck was unreachable or the
    // token has no report yet. Skip this cycle; the next scan (≤5 min) retries with fresh data.
    if (v === 'UNKNOWN' || v === undefined || !_tokenInfo) {
      log('warn', `Rug verdict unavailable for ${best.symbol} — skipping buy (fail-closed)`);
      return;
    }
    log('info', `Rug check: ${rugVerdict}`, { symbol: best.symbol });

    // Top-5 holder concentration gate: tokens where the top 5 wallets control >30% of
    // total supply have an 80% historical stop-loss rate in the swarm's trade data.
    // Backtested at +17pp win rate improvement when combined with minLiquidity>=80k.
    // Computed directly from holder amounts and total supply — skipped if data missing.
    const maxTop5Pct = cfg.risk?.maxTop5HolderPct ?? 0.30;
    if (_tokenInfo?.holders?.top && (_tokenInfo.supplyUi ?? 0) > 0) {
      const dec      = _tokenInfo.decimals ?? 6;
      const top5Ui   = (_tokenInfo.holders.top ?? []).slice(0, 5)
        .reduce((s, h) => s + Number(h.amount ?? '0') / Math.pow(10, dec), 0);
      const top5Pct  = top5Ui / _tokenInfo.supplyUi;
      if (top5Pct > maxTop5Pct) {
        log('info', `Top-5 concentration ${(top5Pct * 100).toFixed(1)}% > ${(maxTop5Pct * 100).toFixed(0)}% — skipping ${symbol}`);
        notify(`⏭ *${symbol}* skipped — top-5 holders ${(top5Pct * 100).toFixed(0)}% (threshold ${(maxTop5Pct * 100).toFixed(0)}%)`);
        return;
      }
    }
  } catch (err) {
    // Fail closed — a rug-check failure must not result in an unchecked buy.
    log('warn', `Rug check failed for ${best.symbol} — skipping buy (fail-closed)`, { error: err.message });
    return;
  }

  // Re-check position count (may have changed)
  if (positions.count() >= maxOpenPositions) {
    log('info', 'Position cap reached during check — skipping buy');
    return;
  }

  // Check SOL balance — paper mode uses virtual balance from the swap executor
  let solBalance = 0;
  try {
    solBalance = isPaper ? (swap.virtualSolBalance ?? 0) : await wallet.getSolBalance();
  } catch (err) {
    log('warn', 'SOL balance check failed', { error: err.message });
    return;
  }

  if (solBalance - entryBudgetSol < minSolPause) {
    log('warn', isPaper ? 'Insufficient virtual SOL' : 'Insufficient SOL',
      { balance: solBalance.toFixed(4), needed: entryBudgetSol });
    notify(`⚠️ ${isPaper ? '[PAPER] ' : ''}Low SOL (${solBalance.toFixed(4)}) — can't buy *${best.symbol}*`);
    return;
  }

  // Consensus sizing — skipped in paper mode (swarmConsensus is x402 paid).
  // Paper trades use fixed entry budget; no boost or rug_alert suppression from consensus.
  let finalBudget = entryBudgetSol;
  let swarmNote   = '';
  if (!isPaper) try {
    const consensusBoostFactor   = cfg.swarm?.consensusBoostFactor ?? 1.0;
    // consensusBoostMinScore: independent score must reach this before the boost applies.
    // Defaults to minScanScore + 10 so a hallucinated bullish consensus can't push a
    // barely-passing candidate into an oversized entry.
    const consensusBoostMinScore = cfg.swarm?.consensusBoostMinScore ?? (minScanScore + 10);
    const consensus = await api.swarmConsensus(best.mint);
    if (consensus?.consensus === 'bullish' && consensus.agents >= 2) {
      if (best._score >= consensusBoostMinScore) {
        // High consensus → REDUCE entry size rather than boost it.
        // If 3+ peers are already bullish on the same token we're about to buy,
        // that's a herding signal not a confirmation signal — smaller entry limits
        // correlated losses across the swarm.
        const herdPenalty = consensus.agents >= 4 ? 0.5 : consensus.agents >= 3 ? 0.75 : 1.0;
        if (herdPenalty < 1.0) {
          finalBudget = entryBudgetSol * herdPenalty;
          swarmNote   = ` [swarm ${consensus.agents} bullish — herd penalty ×${herdPenalty}]`;
          log('info', `Swarm herd penalty: ${best.symbol} — ${consensus.agents} peers bullish, reducing entry to ${finalBudget.toFixed(4)} SOL`);
        } else if (consensusBoostFactor > 1.0) {
          finalBudget = Math.min(entryBudgetSol * consensusBoostFactor, solBalance * 0.15);
          swarmNote   = ` [swarm ${consensus.agents} bullish × ${consensusBoostFactor}x]`;
          log('info', `Swarm consensus boost: ${best.symbol} — ${consensus.agents} agents bullish, score ${best._score}>=${consensusBoostMinScore}, scaling to ${finalBudget.toFixed(4)} SOL`);
        }
      } else {
        log('info', `Swarm consensus: ${best.symbol} — score ${best._score} below threshold ${consensusBoostMinScore}, no size change`);
        swarmNote = ` [swarm ${consensus.agents} bullish — score too low]`;
      }
    } else if (consensus?.consensus === 'rug_alert') {
      // Re-verify with RugCheck before aborting — same principle as blacklist verification.
      // A hallucinated rug_alert from coordinated low-reputation agents should not suppress
      // a legitimate buy without on-chain confirmation.
      try {
        const rugInfo = _tokenInfo ?? await (isPaper ? api.tokenInfoFree(best.mint) : api.tokenInfo(best.mint));
        // token-info nests verdict under rugInfo.risk.verdict — fall back to top-level for compatibility
        const rugVerdict = (rugInfo.risk?.verdict ?? rugInfo.verdict ?? rugInfo.rugRisk ?? 'unknown').toUpperCase();
        const rugExplicitlySafe = rugVerdict === 'GOOD' || rugVerdict === 'WARN';
        if (!rugExplicitlySafe) {
          // Fail-closed: DANGER, UNKNOWN, or unrecognised verdict — trust the rug_alert.
          log('warn', `Swarm rug_alert: ${best.symbol} RugCheck=${rugVerdict} (not explicitly safe) — aborting`);
          notify(`⚠️ Swarm rug alert on *${best.symbol}* (RugCheck=${rugVerdict}) — skipped`);
          return;
        } else {
          log('warn', `Swarm rug_alert discrepancy: ${best.symbol} swarm says rug but RugCheck=${rugVerdict} — proceeding`);
        }
      } catch {
        // RugCheck unavailable — conservative: trust the swarm rug_alert
        log('warn', `Swarm rug_alert on ${best.symbol} — RugCheck unavailable, aborting`);
        notify(`⚠️ Swarm rug alert on *${best.symbol}* — skipped (RugCheck unavailable)`);
        return;
      }
    }
  } catch { /* swarm unavailable — proceed with base budget */ } // end if (!isPaper)

  // Pre-buy gate — only in "selective" mode; "active" mode trusts the scorer
  if (session.mode === 'selective') {
    log('info', `Selective mode — calling pre-buy gate for ${best.symbol ?? best.mint.slice(0, 8)}`);
    const gate = await preBuyGate.check(best, session, positions.count());
    if (!gate.approved) {
      if (gate.timedOut) {
        // Gate API was unavailable — fail-closed, retry next cycle
        log('warn', `Gate unavailable for ${best.symbol ?? best.mint.slice(0, 8)} — skipping (fail-closed)`);
        notify(`⚠️ Pre-buy gate unavailable for *${best.symbol ?? best.mint.slice(0, 8)}* — skipped this cycle (retrying next scan)`);
      } else {
        log('info', `Gate rejected ${best.symbol ?? best.mint.slice(0, 8)}: ${gate.reasoning}`);
        notify(`🚫 *${best.symbol ?? best.mint.slice(0, 8)}* rejected by agent (score ${best._score}): ${gate.reasoning}`);
      }
      return;
    }
    log('info', `Gate approved ${best.symbol ?? best.mint.slice(0, 8)}: ${gate.reasoning}`);
  }

  // Buy
  const symbol = best.symbol ?? best.mint.slice(0, 8);
  log('info', `Buying ${symbol}`, { sol: finalBudget, score: best._score, pattern: best._pattern });
  notify(
    `${isPaper ? '📝 PAPER | ' : ''}🔍 *${symbol}* — ${best._pattern} score ${best._score}/100, liq $${((best.liquidity ?? 0) / 1000).toFixed(0)}k, ` +
    `1h ${(best.priceChange1h ?? 0).toFixed(1)}% 5m ${(best.priceChange5m ?? 0).toFixed(1)}% | Buying ${finalBudget.toFixed(4)} SOL${swarmNote}…`
  );

  // Block concurrent buy if the LLM tool (buy_token) is already buying this mint
  if (!acquireBuyLock(best.mint)) {
    log('warn', `Buy already in flight for ${symbol} — skipping this cycle`);
    return;
  }

  // Publish optimistic buy signal BEFORE the swap so peer agents see it in their
  // recentBuyWindow filter during the same scan cycle. Without this, all agents that
  // scan simultaneously pick the same top candidate and pile in before any signal
  // propagates — the post-buy publish was too late to prevent same-cycle pile-ons.
  if (!isPaper && cfg.swarm?.autoPublish) {
    const { agentId, address } = loadIdentity();
    if (agentId || address) {
      api.swarmPublish({
        agentId, address,
        type:       'buy_signal',
        mint:       best.mint,
        symbol,
        confidence: Math.min(0.95, (best._score ?? 50) / 100),
        data: { entryBudgetSol: finalBudget, score: best._score, pattern: best._pattern, pending: true },
      }).catch(() => {});
      log('info', `Optimistic buy signal published for ${symbol} before swap`);
    }
  }

  try {
    // Re-check position cap under the buy lock — async rug-check/gate/balance calls above
    // can take several seconds during which the LLM tool may have opened another position.
    if (positions.count() >= maxOpenPositions) {
      releaseBuyLock(best.mint);
      log('info', 'Position cap reached (re-check after lock) — skipping buy');
      return;
    }

    const result = await swap.buy(best.mint, finalBudget);

    // Fetch actual decimals — don't hardcode 6 (many Solana tokens use 9 decimals).
    // Stage 1: token account balance (fastest, also confirms we received tokens).
    // Stage 2: mint account via getMintDecimals (works before the token account is indexed).
    // Wrong decimals cause phantom P&L readings that trigger false exits — see monitor.js tpConfirm.
    let tokenDecimals = 6;
    try {
      const bal = await swap.getTokenBalance(best.mint);
      if (bal.decimals > 0) {
        tokenDecimals = bal.decimals;
      } else {
        // Token account not indexed yet — read directly from the mint account
        const mintDec = await swap.getMintDecimals(best.mint);
        if (mintDec != null) tokenDecimals = mintDec;
      }
    } catch (_) {
      // Last-resort: mint account direct read
      try {
        const mintDec = await swap.getMintDecimals(best.mint);
        if (mintDec != null) tokenDecimals = mintDec;
      } catch (_2) {}
    }
    if (tokenDecimals === 6) log('warn', `Using decimal fallback (6) for ${best.symbol} — verify if phantom P&L occurs`, { mint: best.mint.slice(0, 8) });

    // Use actual inAmount (post-slippage) for accurate entry price tracking.
    // outAmount is raw atomic units as a string — use rawToUiAmount (BigInt-safe) so
    // entryPrice is SOL per 1 UI token, matching the price-feed and monitor convention.
    const { rawToUiAmount } = require('./positions');
    const actualSolSpent = result.inAmount ?? finalBudget;
    const uiOut          = rawToUiAmount(String(result.outAmount), tokenDecimals);
    const pricePerToken  = uiOut > 0 ? actualSolSpent / uiOut : 0;

    const opened = positions.openPosition(best.mint, {
      symbol:        symbol,
      entryPrice:    pricePerToken,
      solSpent:      actualSolSpent,
      tokenAmount:   result.outAmount,
      tokenDecimals,
      txSig:         result.txSig,
      entryPattern:  best._pattern ?? null,
      entryScore:    best._score   ?? null,
    });
    if (!opened) {
      log('warn', 'Position already existed — skipping duplicate open', { symbol });
    }

    // Track session buy count — use incrementSessionBuy() not saveStrategy() so
    // the 90-min expiresAt is NOT reset on every buy (saveStrategy always refreshes TTL).
    incrementSessionBuy();

    notify(
      `${isPaper ? '📝 PAPER ' : ''}✅ *${symbol}* bought\n` +
      `${(result.inAmount ?? finalBudget).toFixed(4)} SOL → ${Number(result.outAmount).toLocaleString()} tokens\n` +
      `Score: ${best._score}/100 (${best._pattern}) | ${rugVerdict} | SL: ${s.stopLossPct ?? -6}% TP: ${s.takeProfitPct ?? 12}%${swarmNote}`
    );
    releaseBuyLock(best.mint);
    log('info', 'Buy complete', { symbol, txSig: result.txSig?.slice(0, 16) });

    // Pre-populate price-feed Redis cache so the first monitor tick (10s later)
    // is a Redis hit rather than a live Jupiter call. Fire-and-forget.
    if (!isPaper) api.warmMint(best.mint).catch(() => {});

    if (!isPaper && cfg.swarm?.autoPublish) {
      const { agentId, address } = loadIdentity();
      if (agentId || address) {
        api.swarmPublish({
          agentId, address,
          type:       'buy_signal',
          mint:       best.mint,
          symbol,
          confidence: Math.min(0.95, (best._score ?? 50) / 100),
          data: {
            entryBudgetSol: result.inAmount ?? finalBudget,
            txSig:          result.txSig,
            score:          best._score,
            pattern:        best._pattern,
          },
        }).catch(() => {});
      }
    }
  } catch (err) {
    releaseBuyLock(best.mint);
    log('error', 'Buy failed', { symbol, error: err.message });
    notify(`❌ Buy failed for *${symbol}*: ${err.message}`);
    // Retract the optimistic pre-swap buy_signal so peer agents' recentBuyWindow
    // filter does not suppress this mint for the next 30-60 minutes due to our failed swap.
    if (!isPaper && cfg.swarm?.autoPublish) {
      const { agentId, address } = loadIdentity();
      if (agentId || address) {
        api.swarmPublish({
          agentId, address,
          type: 'buy_signal', mint: best.mint, symbol,
          confidence: 0,
          data: { pending: false, failed: true, error: err.message.slice(0, 80) },
        }).catch(() => {});
      }
    }
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
  // all hit RugCheck / the scan API at the same second after a restart.
  const jitterMs = Math.floor(Math.random() * 120_000);
  const firstScanMs = 90_000 + jitterMs;

  log('info', `Auto-scanner started — scanning every ${intervalMs / 60_000}min (first scan in ${Math.round(firstScanMs / 1000)}s)`);

  // Guard against overlapping cycles — if a scan takes longer than the interval
  // (rug checks, pre-buy gate, slow network) the next tick would run concurrently,
  // both pass the maxOpenPositions check, and both buy the same token.
  let _isRunning = false;
  const tick = () => {
    if (_isRunning) { log('info', 'Scan cycle still running — skipping tick'); return; }
    _isRunning = true;
    // Re-read config each scan cycle so dashboard changes (entry budget, min score,
    // max positions, pattern filter, etc.) take effect without an agent restart.
    const cfg = loadConfig();
    runCycle(api, wallet, swap, cfg, notify)
      .catch(err => log('error', 'Scan cycle error', { error: err.message }))
      .finally(() => { _isRunning = false; });
  };

  // Use per-cycle jitter instead of a fixed setInterval so agents that start
  // simultaneously don't permanently sync their scan windows after the first run.
  // Each cycle schedules the next one with a fresh ±60s random offset.
  // Also re-read scanIntervalMs so dashboard changes to the interval take effect.
  const scheduleNext = () => {
    const cycleJitter = Math.floor(Math.random() * 120_000) - 60_000; // ±60s
    let nextIntervalMs = intervalMs;
    try { nextIntervalMs = loadConfig().strategy?.scanIntervalMs ?? intervalMs; }
    catch { /* malformed config — use previous interval, scheduler survives */ }
    setTimeout(() => { tick(); scheduleNext(); }, nextIntervalMs + cycleJitter);
  };
  setTimeout(() => { tick(); scheduleNext(); }, firstScanMs);
}

module.exports = { start };

// lib/smart-money-scanner.js — "Follow the money" scanner (agent2 experiment).
//
// A different discovery model than auto-scanner: instead of scoring price-feed candles, it starts
// from Circuit's x402 trending feed, then pays for token-top-traders on a SHORTLIST and enters the
// token that track-record wallets are most net-ACCUMULATING (see scoring-smartmoney.js), gated by a
// fail-closed token-security check. Reuses positions/swap/monitor for entry + exits (the monitor
// manages any open position regardless of who opened it). Fixed size, NO regime multiplier.
//
// COST-AWARE: 1 trending call/cycle, top-traders only on the pre-filtered shortlist, security only
// on the single winner, and the whole cycle is skipped when paused / at position cap / low SOL.
'use strict';

const positions = require('./positions');
const { scoreSmartMoney } = require('./scoring-smartmoney');
const { isPaused } = require('./pause');
const { loadConfig } = require('./config');

const log = (level, msg, data = {}) => {
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${new Date().toISOString()}] [SMART] [${level.toUpperCase()}] ${line}\n`);
};

const _cooldown = new Map();   // mint → last-buy ts (in-memory; also cross-checked vs open positions)

function _candidatesFrom(trending) {
  const list = Array.isArray(trending) ? trending : (trending?.trending || trending?.tokens || trending?.results || []);
  return list.map(x => ({
    mint: x.mint || x.address || x.tokenMint,
    symbol: x.symbol || x.name || '?',
    liquidity: +(x.liquidity ?? 0),
    signalScore: +(x.signalScore ?? x.rank ?? 0),
    priceChange24h: +(x.priceChange24h ?? 0),
  })).filter(c => c.mint);
}

// Fail-closed rug gate. Reject if a mint/freeze authority is still live (rug/honeypot vectors) or
// security is unreadable. Concentration is NOT a reject on its own (smart-money accumulation is
// concentrated by nature) unless extreme.
function _securityOk(sec, sm) {
  if (!sec || sec.error) return { ok: false, why: 'security unreadable (fail-closed)' };
  const a = sec.authorities || {};
  if (a.mintAuthorityRevoked === false)   return { ok: false, why: 'mint authority live' };
  if (a.freezeAuthorityRevoked === false) return { ok: false, why: 'freeze authority live' };
  const top1 = sec.concentration?.top1Pct ?? 0;
  const maxTop1 = sm.maxTop1HolderPct ?? 95;
  if (top1 > maxTop1) return { ok: false, why: `top holder ${top1}% > ${maxTop1}%` };
  return { ok: true };
}

async function runCycle(ctx, telegramBot) {
  const cfg = loadConfig();
  const sm  = cfg.smartMoney ?? {};
  const s   = cfg.strategy ?? {};
  const notify = (msg) => { try { if (telegramBot && cfg.telegram?.heartbeatChatId) telegramBot.telegram.sendMessage(cfg.telegram.heartbeatChatId, msg, { parse_mode: 'Markdown' }).catch(() => {}); } catch {} };
  const { api, swap, wallet } = ctx;
  const isPaper = swap?.paperMode === true;

  if (isPaused()) { log('info', 'paused — skipping'); return; }

  const maxOpen = s.maxOpenPositions ?? 3;
  if (positions.count() >= maxOpen) { log('info', `at position cap (${positions.count()}/${maxOpen}) — skipping (saves CIRC)`); return; }

  const budget = s.entryBudgetSol ?? 0.005;
  const minSolPause = cfg.survival?.minSolPause ?? 0.01;
  let solBalance = 0;
  try { solBalance = isPaper ? (swap.virtualSolBalance ?? 0) : await wallet.getSolBalance(); } catch (e) { log('warn', 'balance check failed', { error: e.message }); return; }
  if (solBalance - budget < minSolPause) { log('info', `low SOL (${solBalance.toFixed(4)}) — skipping`); return; }

  // 1. discovery (1 paid call)
  let trending;
  try { trending = await api.tokenTrending(); } catch (e) { log('warn', 'trending failed (x402/RPC) — skip cycle', { error: e.message }); return; }
  let cands = _candidatesFrom(trending);

  // 2. cheap pre-filter (no spend): liquidity floor, not held, not on cooldown
  const minLiq = sm.minLiquidity ?? s.minLiquidity ?? 40000;
  const coolMs = (sm.buyCooldownMinutes ?? 60) * 60_000;
  const now = Date.now();
  cands = cands.filter(c => c.liquidity >= minLiq && !positions.get(c.mint) && !((_cooldown.get(c.mint) ?? 0) + coolMs > now));
  cands.sort((a, b) => b.signalScore - a.signalScore);
  const shortlist = cands.slice(0, sm.shortlistSize ?? 6);
  log('info', `scan: ${cands.length} candidates after pre-filter → checking top ${shortlist.length}`, { minLiq });
  if (!shortlist.length) return;

  // 3. score shortlist by smart-money accumulation (paid top-traders per token)
  const scored = [];
  for (const c of shortlist) {
    let tt;
    try { tt = await api.tokenTopTraders(c.mint); } catch (e) { log('warn', `top-traders failed ${c.symbol} — skip`, { error: e.message?.slice(0, 60) }); continue; }
    const traders = tt?.traders || tt?.topTraders || (Array.isArray(tt) ? tt : []);
    const r = scoreSmartMoney(traders, c, cfg);
    log('info', `  ${c.symbol}: ${r.passed ? 'PASS' : 'skip'} score ${r.score} — ${r.reason}`);
    if (r.passed) scored.push({ c, r });
  }
  if (!scored.length) { log('info', 'no accumulation candidates this cycle'); return; }

  // 4. pick the strongest accumulation
  scored.sort((a, b) => b.r.score - a.r.score);
  const { c: best, r: acc } = scored[0];

  // 5. fail-closed security gate (1 paid call on the winner only)
  let sec;
  try { sec = await api.tokenSecurity(best.mint); } catch (e) { log('warn', `security failed ${best.symbol} — skip (fail-closed)`, { error: e.message?.slice(0, 60) }); return; }
  const secCheck = _securityOk(sec, sm);
  if (!secCheck.ok) { log('info', `${best.symbol} rejected by security: ${secCheck.why}`); notify(`⏭ ${isPaper ? '[PAPER] ' : ''}*${best.symbol}* skipped — ${secCheck.why}`); return; }

  // 6. entry-price confirm + buy
  let entryPx = null;
  try { entryPx = await api.feedPriceSol(best.mint); } catch {}
  if (!(entryPx > 0)) { log('warn', `no price for ${best.symbol} — skip`); return; }

  let result;
  try { result = await swap.buy(best.mint, budget); }
  catch (e) { log('warn', `buy failed ${best.symbol}`, { error: e.message?.slice(0, 80) }); return; }

  // decimals + entry price (mirror auto-scanner)
  let tokenDecimals = 6;
  try { const bal = await swap.getTokenBalance(best.mint); if (bal.decimals > 0) tokenDecimals = bal.decimals; else { const d = await swap.getMintDecimals?.(best.mint); if (d != null) tokenDecimals = d; } } catch {}
  const { rawToUiAmount } = positions;
  const actualSolSpent = result.inAmount ?? budget;
  const uiOut = rawToUiAmount(String(result.outAmount), tokenDecimals);
  const pricePerToken = uiOut > 0 ? actualSolSpent / uiOut : (entryPx || 0);

  positions.openPosition(best.mint, {
    symbol: best.symbol,
    entryPrice: pricePerToken,
    solSpent: actualSolSpent,
    tokenAmount: result.outAmount,
    tokenDecimals,
    txSig: result.txSig,
    execCosts: result.execCosts ?? null,
    entryPattern: 'SMART-MONEY',
    entryScore: acc.score,
    entryConditions: {
      strategy: 'smart-money',
      liquidity: best.liquidity,
      signalScore: best.signalScore,
      priceChange24h: best.priceChange24h,
      accumulation: acc.accumulation,           // smartBuyers / netUsd / snipers / ratio
      security: { riskLevel: sec.risk?.level ?? null, top1Pct: sec.concentration?.top1Pct ?? null, ageDays: sec.ageDays ?? null },
      scanPrice: entryPx,
      fillPrice: pricePerToken,
    },
  });
  _cooldown.set(best.mint, now);
  log('info', `BOUGHT ${best.symbol}`, { sol: actualSolSpent, score: acc.score, smartBuyers: acc.accumulation.smartBuyers, netUsd: acc.accumulation.smartNetUsd });
  notify(`${isPaper ? '📝 PAPER ' : ''}✅ *${best.symbol}* — SMART-MONEY\n${acc.reason}\nliq $${Math.round(best.liquidity / 1000)}k · score ${acc.score}/100`);
}

function start(cfg, ctx, telegramBot = null) {
  const sm = cfg.smartMoney ?? {};
  const intervalMs = sm.scanIntervalMs ?? 600_000;   // 10 min default (CIRC cost control)
  const firstDelay = sm.firstScanDelayMs ?? 20_000;
  log('info', `Smart-money scanner started — cycle every ${Math.round(intervalMs / 60000)}min (first in ${Math.round(firstDelay / 1000)}s)`, { paper: ctx.swap?.paperMode === true });
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await runCycle(ctx, telegramBot); } catch (e) { log('error', 'cycle error', { error: e.message }); }
    running = false;
  };
  setTimeout(() => { tick(); setInterval(tick, intervalMs); }, firstDelay);
}

module.exports = { start, runCycle, scoreSmartMoney, _securityOk };

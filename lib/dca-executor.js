// lib/dca-executor.js — DCA Auto-Executor for circuit-agent Phase 2
// Runs scheduled dollar-cost-averaging buys every N minutes.
// Respects trading pause, blacklist, survival checks, and rug guards.
'use strict';

const fs   = require('fs');
const path = require('path');
const positions = require('./positions');
const { isPaused } = require('./pause');
const { loadIdentity } = require('./profile');

const DCA_STATE_FILE = path.join(__dirname, '../data/dca_state.json');
const DCA_LOG_FILE   = path.join(__dirname, '../logs/dca-executor.log');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [DCA] [${level.toUpperCase()}] ${line}\n`);
  try {
    fs.mkdirSync(path.dirname(DCA_LOG_FILE), { recursive: true });
    fs.appendFileSync(DCA_LOG_FILE, `[${ts}] [${level.toUpperCase()}] ${line}\n`);
  } catch { /* ignore */ }
};

// ── Load + save DCA state ─────────────────────────────────────────────────

function _loadState() {
  try {
    if (!fs.existsSync(DCA_STATE_FILE)) return { schedules: {} };
    return JSON.parse(fs.readFileSync(DCA_STATE_FILE, 'utf8'));
  } catch (err) {
    log('warn', 'Failed to load DCA state', { error: err.message });
    return { schedules: {} };
  }
}

function _saveState(state) {
  try {
    fs.mkdirSync(path.dirname(DCA_STATE_FILE), { recursive: true });
    const tmp = DCA_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DCA_STATE_FILE);
  } catch (err) {
    log('error', 'Failed to save DCA state', { error: err.message });
  }
}

// ── Load DCA execution log (append-only) ──────────────────────────────────

function _logExecution(execution) {
  const logDir = path.join(__dirname, '../data');
  const execLogFile = path.join(logDir, 'dca_executions.json');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    let executions = [];
    if (fs.existsSync(execLogFile)) {
      try { executions = JSON.parse(fs.readFileSync(execLogFile, 'utf8')); } catch {}
    }
    executions.push(execution);
    const tmp = execLogFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(executions, null, 2));
    fs.renameSync(tmp, execLogFile);
  } catch (err) {
    log('warn', 'Failed to log execution', { error: err.message });
  }
}

// ── Check if a schedule is due ────────────────────────────────────────────

function _isScheduleDue(schedule, state, now = Date.now()) {
  const schedId = schedule.id || `${schedule.mint}_${schedule.intervalMs}`;
  const lastRun = state.schedules[schedId]?.lastRun || 0;
  return now - lastRun >= schedule.intervalMs;
}

// ── Execute a single buy for a schedule ───────────────────────────────────

async function _executeBuy(schedule, api, wallet, swap, cfg, notify) {
  const { mint, amountSol, name } = schedule;
  const schedId = schedule.id || `${mint}_${schedule.intervalMs}`;
  const s = cfg.strategy ?? {};
  const risk = cfg.risk ?? {};
  const blacklist = Array.isArray(risk.blacklist) ? risk.blacklist : [];
  const minLiquidity = s.minLiquidity ?? 50_000;

  const ts = new Date().toISOString();

  // Check if mint is in blacklist
  if (blacklist.includes(mint)) {
    const msg = `DCA blocked by blacklist: ${name || mint.slice(0, 8)}`;
    log('warn', msg);
    _logExecution({ ts, schedId, name, mint, status: 'blocked', reason: 'blacklist' });
    return { ok: false, reason: 'blacklist' };
  }

  // Check SOL balance
  let solBal = null;
  try {
    const bal = await wallet.getBalances();
    solBal = bal.sol ?? null;
  } catch (err) {
    log('warn', 'Failed to fetch balance', { error: err.message });
  }
  if (solBal != null && solBal < amountSol + 0.002) {
    const msg = `DCA insufficient SOL: have ${solBal.toFixed(4)}, need ${(amountSol + 0.002).toFixed(4)}`;
    log('warn', msg);
    _logExecution({ ts, schedId, name, mint, status: 'blocked', reason: 'insufficient_sol', solAvailable: solBal });
    return { ok: false, reason: 'insufficient_sol' };
  }

  // Check trading pause
  if (isPaused()) {
    log('info', `DCA paused: ${name || mint.slice(0, 8)}`);
    _logExecution({ ts, schedId, name, mint, status: 'skipped', reason: 'trading_paused' });
    return { ok: false, reason: 'trading_paused' };
  }

  // Fetch current price to check liquidity + rug status
  let priceData = null;
  try {
    const priceFeedBase = `${cfg.api.baseUrl}/api/price-feed`;
    const resp = await fetch(`${priceFeedBase}/prices?mints=${mint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const r = data.results?.[mint];
      if (r?.priceSol > 0) priceData = r;
    }
  } catch (err) {
    log('warn', 'Price feed failed', { error: err.message });
  }

  // Fallback to x402
  if (!priceData) {
    try {
      const result = await api.tokenPrices([mint]);
      priceData = result.prices?.[mint];
    } catch (err) {
      log('warn', 'x402 price failed', { error: err.message });
    }
  }

  if (!priceData) {
    log('warn', `DCA price unavailable: ${name || mint.slice(0, 8)}`);
    _logExecution({ ts, schedId, name, mint, status: 'blocked', reason: 'price_unavailable' });
    return { ok: false, reason: 'price_unavailable' };
  }

  // Check rug status via scan API (if available)
  let rugStatus = null;
  try {
    const scanResult = await api.scan({ limit: 1, targetMint: mint });
    const target = scanResult.candidates?.find(c => c.mint === mint);
    if (target) rugStatus = target.rugRisk ?? target.verdict;
  } catch (err) {
    log('warn', 'Rug check failed', { error: err.message });
  }

  if (rugStatus === 'DANGER' || rugStatus?.includes('DANGER')) {
    const msg = `DCA blocked by rug status: ${name || mint.slice(0, 8)}`;
    log('warn', msg);
    _logExecution({ ts, schedId, name, mint, status: 'blocked', reason: 'rug_danger', rugStatus });
    return { ok: false, reason: 'rug_danger' };
  }

  // Check survival gate: max open positions, max entry size, trading pause
  const held = positions.getAll();
  const maxOpen = s.maxOpenPositions ?? 3;
  if (Object.keys(held).length >= maxOpen) {
    const msg = `DCA max positions reached: ${Object.keys(held).length}/${maxOpen}`;
    log('warn', msg);
    _logExecution({ ts, schedId, name, mint, status: 'blocked', reason: 'max_positions' });
    return { ok: false, reason: 'max_positions' };
  }

  // All checks passed — execute buy
  log('info', `DCA executing buy: ${name || mint.slice(0, 8)}`, { amountSol });

  let buyResult = null;
  try {
    buyResult = await swap.buy({
      tokenMint: mint,
      solAmount: amountSol,
      slippageBps: cfg.strategy?.slippageBps ?? 100,
    });
  } catch (err) {
    log('error', 'DCA buy execution failed', { error: err.message });
    _logExecution({
      ts, schedId, name, mint, status: 'failed',
      reason: 'execution_error', error: err.message,
    });
    if (notify) {
      notify(`⚠️ DCA buy failed: ${name || mint.slice(0, 8)} — ${err.message}`);
    }
    return { ok: false, reason: 'execution_error' };
  }

  // Log successful execution
  _logExecution({
    ts, schedId, name, mint, status: 'success',
    amountSol, txSignature: buyResult.txSignature ?? null,
    tokenAmount: buyResult.tokenAmount ?? null,
  });

  if (notify) {
    notify(`✅ DCA buy executed: ${name || mint.slice(0, 8)} for ${amountSol} SOL`);
  }

  return { ok: true, txSignature: buyResult.txSignature };
}

// ── Main check-and-execute function ───────────────────────────────────────

async function checkAndExecute(cfg, ctx, telegramBot = null) {
  const s = cfg.strategy ?? {};
  if (!s.dcaEnabled) return;

  const schedules = Array.isArray(s.dcaSchedules) ? s.dcaSchedules : [];
  if (!schedules.length) return;

  // Tier 3: Check ecosystem conditions (gating)
  const dcaEcoGating = require('./dca-ecosystem-gating');
  if (dcaEcoGating.shouldSkipDcaCycle(cfg)) {
    log('info', 'DCA cycle skipped due to ecosystem conditions');
    return;
  }

  const state = _loadState();
  const now = Date.now();
  const notify = telegramBot?.api?.sendMessage
    ? (msg) => telegramBot.api.sendMessage(cfg.telegram?.chatId, msg, { parse_mode: 'Markdown' }).catch(() => {})
    : null;

  const updated = { schedules: { ...state.schedules } };
  let anyExecuted = false;

  // Tier 3: Get DCA size multiplier based on ecosystem (lower fee → bigger position)
  const sizeMultiplier = dcaEcoGating.dcaSizeMultiplier(cfg);

  for (const schedule of schedules) {
    if (!_isScheduleDue(schedule, state, now)) continue;

    const schedId = schedule.id || `${schedule.mint}_${schedule.intervalMs}`;
    try {
      // Adjust schedule amount by ecosystem conditions (Tier 3)
      const adjustedSchedule = {
        ...schedule,
        amountSol: (schedule.amountSol ?? 0.01) * sizeMultiplier,
      };
      const result = await _executeBuy(adjustedSchedule, ctx.api, ctx.wallet, ctx.swap, cfg, notify);
      if (result.ok) anyExecuted = true;
    } catch (err) {
      log('error', 'DCA buy error', { scheduleId: schedId, error: err.message });
    }

    // Update lastRun regardless of success/failure to avoid rapid retries
    updated.schedules[schedId] = { lastRun: now };
  }

  if (anyExecuted || Object.keys(updated.schedules).length > 0) {
    _saveState(updated);
  }
}

// ── Initialize (ensure state file exists) ─────────────────────────────────

function initialize() {
  const state = _loadState();
  _saveState(state);
  log('info', 'DCA executor initialized');
}

module.exports = { checkAndExecute, initialize };

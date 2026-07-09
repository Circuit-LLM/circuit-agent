// lib/positions.js — position tracking + P&L for circuit-agent
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE    = path.join(__dirname, '../data/positions.json');
const HISTORY_FILE = path.join(__dirname, '../data/trade_history.json');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [POS] [${level.toUpperCase()}] ${line}\n`);
};

// ── File I/O — atomic writes via .tmp + rename ────────────────────────────────
// POSIX rename() is atomic on the same filesystem. A crash mid-write leaves
// the old file intact rather than producing a corrupt half-written file.

function _load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return {}; }
}

function _save(positions) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(positions, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function _saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  const tmp = HISTORY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, HISTORY_FILE);
}

// ── Position model ────────────────────────────────────────────────────────────
// {
//   mint:          string
//   symbol:        string
//   entryPrice:    number   (SOL per 1 UI token — decimal-adjusted, same unit as price-feed priceSol)
//   entryTime:     ISO string
//   solSpent:      number
//   tokenAmount:   string   (raw atomic units as string — use BigInt() to read)
//   tokenDecimals: number
//   peakPnlPct:    number   (for trailing stop)
//   txSig:         string
// }

function openPosition(mint, data) {
  const positions = _load();
  if (positions[mint]) {
    log('warn', 'Position already open — skipping duplicate', { mint: mint.slice(0, 8) });
    return false;
  }
  positions[mint] = {
    mint,
    symbol:        data.symbol ?? '?',
    entryPrice:    data.entryPrice,
    entryTime:     new Date().toISOString(),
    solSpent:      data.solSpent,
    tokenAmount:   String(data.tokenAmount),  // always store as string for BigInt safety
    tokenDecimals: data.tokenDecimals ?? 6,
    peakPnlPct:    0,
    txSig:         data.txSig ?? null,
    entryPattern:  data.entryPattern ?? null,
    entryScore:    data.entryScore   ?? null,
    // Execution costs of the buy leg (Jito tip + network fee incl. priority), in SOL.
    // NOT included in solSpent (which stays swap-level gross) — carried to the closed-trade
    // record so netPnlSol reflects the wallet's true economics. null for legacy/paper opens.
    entryCostsSol: data.execCosts?.costSol ?? null,
    entryVia:      data.execCosts?.via     ?? null,
    build:         buildTag(),
    // S4 — entry-condition capture: the scoring inputs + scan/fill prices that justified this
    // entry, carried through to the closed-trade record so entry edge becomes measurable
    // (correlate conditions → outcome) instead of inferred. null for positions opened elsewhere.
    entryConditions: data.entryConditions ?? null,
    topHolders:      data.topHolders ?? null,
  };
  _save(positions);
  log('info', 'Position opened', {
    mint:     mint.slice(0, 8) + '…',
    symbol:   data.symbol,
    solSpent: (data.solSpent ?? 0).toFixed(4),
  });
  return true;
}

function closePosition(mint, exitData = {}) {
  const positions = _load();
  const pos = positions[mint];
  if (!pos) return null;
  delete positions[mint];
  _save(positions);
  log('info', 'Position closed', { mint: mint.slice(0, 8) + '…', symbol: pos.symbol });

  if (exitData && Object.keys(exitData).length) {
    logClosedTrade(mint, pos, exitData);
  }

  return pos;
}

// ── Trade history ─────────────────────────────────────────────────────────────

function logClosedTrade(mint, pos, exitData) {
  let history = [];
  try {
    if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { /* start fresh */ }

  // Net-of-costs P&L: pnlSol stays swap-level gross (record continuity — every analysis
  // to date is on that basis). netPnlSol additionally books the Jito tips + network fees
  // of both legs, which at 0.005 SOL test size run ~13-40% of the position and were
  // previously invisible to reflect/plan-grading/reputation. null when neither leg
  // reported costs (legacy records, paper mode).
  const entryCosts = pos.entryCostsSol ?? null;
  const exitCosts  = exitData.execCosts?.costSol ?? null;
  const feesSol    = (entryCosts != null || exitCosts != null)
    ? (entryCosts ?? 0) + (exitCosts ?? 0) : null;
  const grossPnl   = (exitData.solReceived ?? 0) - pos.solSpent;

  history.push({
    mint,
    symbol:       pos.symbol,
    entryTime:    pos.entryTime,
    exitTime:     exitData.exitTime ?? new Date().toISOString(),
    solSpent:     pos.solSpent,
    solReceived:  exitData.solReceived ?? 0,
    pnlSol:       grossPnl,
    pnlPct:       pos.solSpent > 0 ? grossPnl / pos.solSpent * 100 : 0,
    feesSol,                                                          // tips + network fees, both legs
    netPnlSol:    feesSol != null ? grossPnl - feesSol : null,        // wallet-true P&L
    netPnlPct:    feesSol != null && pos.solSpent > 0 ? (grossPnl - feesSol) / pos.solSpent * 100 : null,
    entryVia:     pos.entryVia ?? null,
    exitVia:      exitData.execCosts?.via ?? null,
    build:        pos.build ?? buildTag(),
    peakPnlPct:   pos.peakPnlPct,
    holdMinutes:  Math.round((new Date(exitData.exitTime ?? Date.now()) - new Date(pos.entryTime)) / 60_000),
    reason:       exitData.reason ?? 'manual',
    txSig:        exitData.txSig ?? null,
    pattern:      pos.entryPattern ?? null,
    entryScore:   pos.entryScore   ?? null,
    // S4 — entry-condition capture (see openPosition). Enables post-hoc analysis of which
    // entry conditions predict winners vs the 73%-never-green entries.
    entryConditions: pos.entryConditions ?? null,
  });

  if (history.length > 200) history = history.slice(-200);
  _saveHistory(history);
}

function getTradeHistory(limit = 50, days = 30) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const cutoff  = Date.now() - days * 86_400_000;
    return history
      .filter(t => new Date(t.exitTime).getTime() >= cutoff)
      .slice(-limit);
  } catch { return []; }
}

function updatePeak(mint, pnlPct) {
  const positions = _load();
  const pos = positions[mint];
  if (!pos || pnlPct <= pos.peakPnlPct) return;
  pos.peakPnlPct = pnlPct;
  _save(positions);
}

// Update stored token amount after a partial sell so the monitor uses the
// correct remaining balance for P&L and stop/TP calculations.
// Proportionally reduces solSpent so the remaining position's cost basis is correct.
// Without this, P&L after a partial sell is permanently skewed (full cost vs partial tokens).
function updateTokenAmount(mint, newRawAmount) {
  const positions = _load();
  const pos = positions[mint];
  if (!pos) return;
  const oldRaw = BigInt(pos.tokenAmount);
  if (oldRaw > 0n) {
    const fraction = Number(BigInt(newRawAmount)) / Number(oldRaw);
    // Round to 8 decimal places (sub-lamport precision) to prevent float drift
    // accumulating across repeated partial sells on the same position.
    pos.solSpent = Math.round(pos.solSpent * fraction * 1e8) / 1e8;
  }
  pos.tokenAmount = String(newRawAmount);
  _save(positions);
}

function updateCurrentPrice(mint, price, pnlPct) {
  const positions = _load();
  const pos = positions[mint];
  if (!pos) return;
  pos.currentPrice = price;
  pos.livePnlPct   = Math.round(pnlPct * 100) / 100;
  _save(positions);
}

function getAll() { return _load(); }

function get(mint) { return _load()[mint] ?? null; }

function count() { return Object.keys(_load()).length; }

// ── P&L calculation ───────────────────────────────────────────────────────────

// Convert a stored raw token amount string to a UI (human-readable) float.
// Uses BigInt arithmetic to avoid the Number(BigInt(...)) precision loss for high-supply
// tokens whose raw atomic balance exceeds 2^53 (~9 quadrillion for 6-decimal tokens).
// Scales by 1e6 before integer division to preserve 6 decimal places of precision.
function rawToUiAmount(tokenAmountStr, decimals) {
  const SCALE = 1_000_000n;
  const raw   = BigInt(tokenAmountStr);
  const dec   = BigInt(decimals);
  return Number(raw * SCALE / 10n ** dec) / Number(SCALE);
}

// Compute P&L from a per-token price expressed in SOL (SOL per 1 UI token).
// Uses the same solSpent-based formula as monitor.js so heartbeat/dashboard P&L matches
// what the exit logic actually sees. The entryPrice formula diverges after partial sells.
function calcPnlFromTokenPriceSol(pos, currentTokenPriceSol) {
  if (!pos || !currentTokenPriceSol) return null;
  const uiAmount        = rawToUiAmount(String(pos.tokenAmount), pos.tokenDecimals ?? 6);
  const currentSolValue = currentTokenPriceSol * uiAmount;
  const pnlPct          = ((currentSolValue - pos.solSpent) / pos.solSpent) * 100;
  const pnlSol          = currentSolValue - pos.solSpent;
  return { pnlPct: +pnlPct.toFixed(2), pnlSol: +pnlSol.toFixed(6), peakPnlPct: pos.peakPnlPct };
}

// ── Hold time ─────────────────────────────────────────────────────────────────

function holdMinutes(pos) {
  return (Date.now() - new Date(pos.entryTime).getTime()) / 60_000;
}

// ── Decision-basis P&L helpers ────────────────────────────────────────────────
// netPnlSol (wallet-true, fees booked) when available; gross otherwise (legacy/paper
// records where costs were never captured). Every feedback loop — circuit breaker,
// re-entry cooldowns, reputation verdicts, win-rate stats — should measure on this
// basis: fees ran 2.4x the gross P&L across the swarm's recent trade window.
function effPnlSol(t) { return t?.netPnlSol ?? t?.pnlSol ?? 0; }
function effPnlPct(t) {
  if (t?.netPnlSol != null && (t?.solSpent ?? 0) > 0) return (t.netPnlSol / t.solSpent) * 100;
  return t?.pnlPct ?? 0;
}

// Git build tag stamped into trade records so performance can be evaluated per deploy
// ("since the last update") instead of over all-time history. Cached; null outside git.
let _buildTagCached;
function buildTag() {
  if (_buildTagCached !== undefined) return _buildTagCached;
  try {
    _buildTagCached = require('child_process')
      .execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.join(__dirname, '..'), timeout: 3000 })
      .toString().trim() || null;
  } catch { _buildTagCached = null; }
  return _buildTagCached;
}

module.exports = {
  effPnlSol, effPnlPct, buildTag,
  openPosition, closePosition, logClosedTrade,
  getTradeHistory, updatePeak, updateTokenAmount,
  getAll, get, count, calcPnlFromTokenPriceSol, rawToUiAmount, holdMinutes,
  updateCurrentPrice,
};

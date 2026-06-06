// lib/circuit-reinvest.js — Buy CIRCUIT with a slice of each profitable trade exit.
// The agent lives on CIRCUIT. Profit feeds survival.
// Called by monitor.js after every winning close.
'use strict';

const fs   = require('fs');
const path = require('path');

const { CIRCUIT_MINT } = require('./circuit');
const STATS_FILE   = path.join(__dirname, '../data/reinvest_stats.json');
const MIN_SOL_BUY  = 0.001; // don't bother under this

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [REINVEST] [${level.toUpperCase()}] ${line}\n`);
};

// ── Load / save stats ─────────────────────────────────────────────────────────

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch { /* ignore */ }
  return { totalCircuitBought: 0, totalSolReinvested: 0, reinvestCount: 0, history: [] };
}

function saveStats(stats) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  const tmp = STATS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
  fs.renameSync(tmp, STATS_FILE);
}

// ── Buy CIRCUIT from a profitable close ─────────────────────────────────────────

/**
 * Reinvest a portion of trade profit into CIRCUIT.
 * @param {object} opts
 *   pnlSol    {number}  — profit in SOL from the closed trade
 *   symbol    {string}  — token that was sold (for logging)
 *   swap      {object}  — SwapExecutor instance
 *   wallet    {object}  — WalletManager (for balance check)
 *   cfg       {object}  — agent config
 *   notify    {function}— Telegram notify callback
 */
async function reinvestProfit({ pnlSol, symbol, swap, wallet, cfg, notify }) {
  const reinvestPct = cfg.survival?.circuitReinvestPct ?? 0.25;
  const minSolPause = cfg.survival?.minSolPause ?? 0.01;

  if (pnlSol <= 0) return; // only on profit
  const solToBuy = pnlSol * reinvestPct;
  if (solToBuy < MIN_SOL_BUY) {
    log('info', `Profit too small to reinvest (${solToBuy.toFixed(5)} SOL < ${MIN_SOL_BUY})`);
    return;
  }

  // Safety: check we won't drain below survival floor
  let solBalance = 0;
  try { solBalance = (await wallet.getBalances()).sol ?? 0; } catch { return; }
  if (solBalance - solToBuy < minSolPause) {
    log('warn', 'Skipping CIRCUIT reinvest — would breach minSolPause', { balance: solBalance, solToBuy });
    return;
  }

  log('info', `Reinvesting ${(reinvestPct * 100).toFixed(0)}% of profit into CIRCUIT`, {
    pnlSol: pnlSol.toFixed(5), solToBuy: solToBuy.toFixed(5),
  });

  try {
    const result = await swap.buy(CIRCUIT_MINT, solToBuy);
    const circuitRaw      = Number(result.outAmount);
    const circuitReceived = +(circuitRaw / 1_000_000).toFixed(4); // convert raw to human units (6 decimals)

    const stats = loadStats();
    stats.totalSolReinvested    += solToBuy;
    stats.totalCircuitBought    += circuitReceived; // stored in human units
    stats.totalCircuitBought_ui  = +stats.totalCircuitBought.toFixed(4);
    stats.reinvestCount          += 1;
    stats.history.push({
      at:             new Date().toISOString(),
      fromTrade:      symbol,
      pnlSol:         +pnlSol.toFixed(6),
      solReinvested:  +solToBuy.toFixed(6),
      circuitReceived, // human units — LLM reads this correctly
      txSig:          result.txSig,
    });
    if (stats.history.length > 100) stats.history = stats.history.slice(-100);
    saveStats(stats);

    const circuit = circuitReceived.toLocaleString();
    log('info', 'CIRCUIT reinvest complete', { circuit, txSig: result.txSig?.slice(0, 16) });
    notify(
      `CIRCUIT +${circuit} — reinvested ${(reinvestPct*100).toFixed(0)}% of ${symbol} profit ` +
      `(${pnlSol.toFixed(4)} SOL → ${solToBuy.toFixed(4)} SOL → CIRCUIT)`
    );
  } catch (err) {
    log('error', 'CIRCUIT reinvest failed', { error: err.message });
  }
}

// ── Read stats for reflect prompt ─────────────────────────────────────────────

function getStats() {
  return loadStats();
}

module.exports = { reinvestProfit, getStats, CIRCUIT_MINT };

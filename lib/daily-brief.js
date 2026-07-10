'use strict';
// Daily trading brief — sends Telegram digest once per UTC day at a configured hour

const fs = require('fs');
const path = require('path');
const webhooks = require('./webhooks');

const DATA_DIR = path.join(__dirname, '../data');
const TRADE_FILE = path.join(DATA_DIR, 'trade_history.json');

function _formatBrief(trades) {
  if (!trades || trades.length === 0) return 'No trades today.';

  const wins   = trades.filter(t => (t.netPnlSol ?? 0) > 0);
  const losses = trades.filter(t => (t.netPnlSol ?? 0) <= 0);
  const totalPnl = trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
  const avgHold = trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length;

  const lines = [
    `📊 *Daily Brief* — ${trades.length} trades`,
    `Win rate: ${(wins.length / trades.length * 100).toFixed(0)}% (${wins.length}W / ${losses.length}L)`,
    `Net P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`,
    `Avg hold: ${avgHold.toFixed(0)}min`,
  ];

  if (trades.length > 0) {
    const best = [...trades].sort((a, b) => (b.netPnlSol ?? 0) - (a.netPnlSol ?? 0))[0];
    const worst = [...trades].sort((a, b) => (a.netPnlSol ?? 0) - (b.netPnlSol ?? 0))[0];
    if (best) lines.push(`Best: ${best.symbol} +${(best.netPnlSol ?? 0).toFixed(4)}S`);
    if (worst) lines.push(`Worst: ${worst.symbol} ${(worst.netPnlSol ?? 0).toFixed(4)}S`);
  }

  return lines.join('\n');
}

function _getTodaysTrades() {
  try {
    const trades = JSON.parse(fs.readFileSync(TRADE_FILE, 'utf8'));
    const now = Date.now();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    return trades.filter(t => {
      const exitTime = new Date(t.exitTime ?? t.entryTime ?? 0).getTime();
      return exitTime >= todayMs;
    });
  } catch {
    return [];
  }
}

let _lastSentDate = null;

function shouldSendBrief() {
  const now = new Date();
  const todayUTC = new Date(now.toUTCString().slice(0, -4)).toDateString();
  const lastSent = _lastSentDate ? new Date(_lastSentDate).toDateString() : null;
  return todayUTC !== lastSent;
}

async function sendBrief(telegramBot, cfg) {
  if (!shouldSendBrief()) return;
  if (!telegramBot || !cfg.telegram?.chatId) return;

  const trades = _getTodaysTrades();
  const message = _formatBrief(trades);

  try {
    await telegramBot.telegram.sendMessage(cfg.telegram.chatId, message, { parse_mode: 'Markdown' });
    _lastSentDate = new Date().toISOString();

    // Dispatch webhook on daily_brief (fire-and-forget)
    const wins = trades.filter(t => (t.netPnlSol ?? 0) > 0).length;
    const losses = trades.filter(t => (t.netPnlSol ?? 0) <= 0).length;
    const totalPnl = trades.reduce((s, t) => s + (t.netPnlSol ?? 0), 0);
    webhooks.dispatchWebhook('daily_brief', {
      tradeCount: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0,
      totalPnlSol: totalPnl,
      avgHoldMinutes: trades.length > 0 ? (trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length).toFixed(0) : 0,
      brief: message,
    }, cfg).catch(() => {});
  } catch (err) {
    console.error('[DAILY-BRIEF] Send failed:', err.message);
  }
}

module.exports = { sendBrief, shouldSendBrief, _formatBrief };

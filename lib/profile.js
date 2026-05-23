// lib/profile.js — agent profile management for circuit-agent
//
// Reads/writes data/agent-profile.json — the shared identity file
// visible to the entire swarm. Computes trust level from activity gates,
// rolls up performance stats from trade history, and publishes to swarm.
//
// Trust levels (earned by activity, not just time):
//   signal  — 0–2 days OR <10 sessions  — read-only swarm access
//   relay   — 2–5 days AND ≥10 sessions — can publish signals
//   node    — 5–14 days AND ≥1 trade    — full coordination
//   beacon  — 14+ days AND ≥35% win rate — elevated weight, coordinator-eligible
'use strict';

const fs   = require('fs');
const path = require('path');

const PROFILE_PATH  = path.join(__dirname, '../data/agent-profile.json');
const IDENTITY_FILE = path.join(__dirname, '../data/agent-identity.json');
const HISTORY_FILE  = path.join(__dirname, '../data/trade_history.json');
const STATE_FILE    = path.join(__dirname, '../data/profile_state.json');

const log = (level, msg) =>
  process.stdout.write(`[${new Date().toISOString()}] [PROFILE] [${level.toUpperCase()}] ${msg}\n`);

// ── Sessions counter ──────────────────────────────────────────────────────────

function _loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* ignore */ }
  return { sessionsCompleted: 0 };
}

function _saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function incrementSessions() {
  const state = _loadState();
  state.sessionsCompleted = (state.sessionsCompleted ?? 0) + 1;
  _saveState(state);
  return state.sessionsCompleted;
}

// ── Trust level computation ───────────────────────────────────────────────────

function _computeTrustLevel(daysOp, sessions, closedTrades, winRate) {
  if (daysOp >= 14 && closedTrades >= 1 && winRate >= 35) return 'beacon';
  if (daysOp >= 5  && closedTrades >= 1)                  return 'node';
  if (daysOp >= 2  && sessions >= 10)                     return 'relay';
  return 'signal';
}

// ── Trade performance stats ───────────────────────────────────────────────────

function _computeTradeStats() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return null;
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!history.length) return null;

    const wins   = history.filter(t => (t.pnlPct ?? 0) > 0);
    const losses = history.filter(t => (t.pnlPct ?? 0) <= 0);
    const winRate  = +(wins.length / history.length * 100).toFixed(1);
    const avgPnl   = +(history.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / history.length).toFixed(2);
    const avgWin   = wins.length   ? +(wins.reduce((s, t)   => s + (t.pnlPct ?? 0), 0) / wins.length).toFixed(2)   : 0;
    const avgLoss  = losses.length ? +(losses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / losses.length).toFixed(2) : 0;
    const totalPnl = +(history.reduce((s, t) => s + (t.pnlPct ?? 0), 0)).toFixed(2);

    return {
      closedPositions: history.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate,
      avgPnlPct:       avgPnl,
      avgWinPct:       avgWin,
      avgLossPct:      avgLoss,
      totalPnlPct:     totalPnl,
      firstTradeAt:    history[0]?.exitTime ?? null,
      lastTradeAt:     history[history.length - 1]?.exitTime ?? null,
    };
  } catch { return null; }
}

// ── Identity I/O ─────────────────────────────────────────────────────────────
// Shared helper — use this instead of reading agent-identity.json directly.

function loadIdentity() {
  try {
    if (fs.existsSync(IDENTITY_FILE)) return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

// ── Profile I/O ───────────────────────────────────────────────────────────────

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_PATH)) return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

function _saveProfile(profile) {
  fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
  const tmp = PROFILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
  fs.renameSync(tmp, PROFILE_PATH);
}

// ── Refresh — update maturity + performance, recompute trust level ────────────

function refresh() {
  const profile = loadProfile();
  if (!profile) {
    log('warn', `No profile found at ${PROFILE_PATH} — run: node agent.js init`);
    return null;
  }

  const state   = _loadState();
  const stats   = _computeTradeStats();
  const sessions = state.sessionsCompleted ?? 0;

  const createdAt = profile.identity?.createdAt;
  const daysOp    = createdAt
    ? (Date.now() - new Date(createdAt).getTime()) / 86_400_000
    : 0;

  const winRate      = stats?.winRate      ?? 0;
  const closedTrades = stats?.closedPositions ?? 0;
  const trustLevel   = _computeTrustLevel(+daysOp.toFixed(1), sessions, closedTrades, winRate);

  profile.maturity = {
    ...profile.maturity,
    trustLevel,
    daysOperational:   +daysOp.toFixed(1),
    sessionsCompleted: sessions,
  };

  if (stats) {
    profile.performance = {
      ...profile.performance,
      trading:     stats,
      lastUpdated: new Date().toISOString(),
    };
  }

  _saveProfile(profile);
  log('info', `Refreshed — trust: ${trustLevel} | sessions: ${sessions} | winRate: ${winRate}%`);
  return profile;
}

// ── Publish profile to swarm ──────────────────────────────────────────────────

async function publish(api) {
  const profile = loadProfile();
  if (!profile) return;

  let identity = {};
  try { identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); }
  catch { log('warn', 'No agent identity — skipping profile publish'); return; }

  if (!identity.agentId && !identity.address) return;

  try {
    await api.swarmPublish({
      agentId:    identity.agentId,
      address:    identity.address,
      type:       'agent_profile',
      confidence: 1.0,
      data:       profile,
      ttlSeconds: 3_600,  // 1h — refreshed each reflect cycle (4h) or heartbeat
    });
    log('info', 'Profile published to swarm');
  } catch (err) {
    log('warn', `Swarm publish failed: ${err.message}`);
  }
}

// ── Refresh + publish (called on startup and each reflect cycle) ──────────────

async function refreshAndPublish(api) {
  const profile = refresh();
  if (profile) await publish(api);
}

// ── System prompt block — injected into every LLM message ────────────────────

function buildProfileBlock() {
  try {
    const profile = loadProfile();
    if (!profile) return '';

    const m  = profile.maturity    ?? {};
    const tr = (profile.performance ?? {}).trading ?? {};
    const lines = ['## Your Swarm Identity'];

    lines.push(
      `Trust: **${m.trustLevel ?? 'signal'}** | ` +
      `${m.daysOperational ?? 0} days operational | ` +
      `${m.sessionsCompleted ?? 0} sessions completed`
    );

    if (tr.closedPositions > 0) {
      lines.push(
        `Trading: ${tr.winRate}% win rate (${tr.wins}W/${tr.losses}L) | ` +
        `avg P&L: ${tr.avgPnlPct}% | total: ${tr.totalPnlPct}%`
      );
    }

    // Behavior hints based on trust level
    if (m.trustLevel === 'signal') {
      lines.push('Mode: **shadow** — read swarm signals, do not publish yet. Confirm system is stable.');
    } else if (m.trustLevel === 'relay') {
      lines.push('Mode: **relay** — publish signals and claim tasks. Config hints unlock at node.');
    }

    return '\n\n---\n\n' + lines.join('\n');
  } catch { return ''; }
}

module.exports = { refresh, publish, refreshAndPublish, incrementSessions, buildProfileBlock, loadProfile, loadIdentity };

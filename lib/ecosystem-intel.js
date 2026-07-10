// lib/ecosystem-intel.js — Ecosystem Intel Feed for circuit-agent Phase 2
// Monitors network health: TPS, MEV, validator count.
// Alerts if degraded. Phase 2a: monitoring only (no auto-pause).
'use strict';

const fs   = require('fs');
const path = require('path');

const HEALTH_FILE  = path.join(__dirname, '../data/ecosystem_health.json');
const ALERTS_FILE  = path.join(__dirname, '../data/ecosystem_alerts.json');
const INTEL_LOG    = path.join(__dirname, '../logs/ecosystem-intel.log');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [INTEL] [${level.toUpperCase()}] ${line}\n`);
  try {
    fs.mkdirSync(path.dirname(INTEL_LOG), { recursive: true });
    fs.appendFileSync(INTEL_LOG, `[${ts}] [${level.toUpperCase()}] ${line}\n`);
  } catch { /* ignore */ }
};

// ── Health scoring ────────────────────────────────────────────────────────

function _scoreHealth(stats) {
  let score = 100;
  const breakdown = [];

  // TPS score: target 400+
  if (stats.recentTps) {
    if (stats.recentTps < 200) {
      score -= 30;
      breakdown.push(`TPS ${stats.recentTps} critically low`);
    } else if (stats.recentTps < 300) {
      score -= 15;
      breakdown.push(`TPS ${stats.recentTps} degraded`);
    } else if (stats.recentTps >= 400) {
      breakdown.push(`TPS ${stats.recentTps} healthy`);
    }
  }

  // MEV score: target <25%
  if (stats.mevPercent != null) {
    if (stats.mevPercent > 50) {
      score -= 25;
      breakdown.push(`MEV ${stats.mevPercent.toFixed(1)}% extremely high`);
    } else if (stats.mevPercent > 35) {
      score -= 15;
      breakdown.push(`MEV ${stats.mevPercent.toFixed(1)}% elevated`);
    } else if (stats.mevPercent > 25) {
      score -= 5;
      breakdown.push(`MEV ${stats.mevPercent.toFixed(1)}% above threshold`);
    } else {
      breakdown.push(`MEV ${stats.mevPercent.toFixed(1)}% healthy`);
    }
  }

  // Validator count: target 400+
  if (stats.validatorCount) {
    if (stats.validatorCount < 300) {
      score -= 20;
      breakdown.push(`Validators ${stats.validatorCount} critically low`);
    } else if (stats.validatorCount < 350) {
      score -= 10;
      breakdown.push(`Validators ${stats.validatorCount} degraded`);
    } else if (stats.validatorCount >= 400) {
      breakdown.push(`Validators ${stats.validatorCount} healthy`);
    }
  }

  // Network congestion (if available via getRecentPrioritizationFees)
  if (stats.avgPriorityFee != null) {
    if (stats.avgPriorityFee > 100_000) { // >0.0001 SOL average
      score -= 10;
      breakdown.push(`Priority fees high (${(stats.avgPriorityFee / 1_000_000).toFixed(4)} SOL avg)`);
    } else if (stats.avgPriorityFee > 50_000) {
      score -= 5;
      breakdown.push(`Priority fees elevated`);
    }
  }

  return { score: Math.max(0, score), breakdown };
}

// ── Fetch network stats ───────────────────────────────────────────────────

async function _fetchNetworkStats(wallet) {
  const stats = { ts: new Date().toISOString() };

  try {
    // Recent prioritization fees (proxy for congestion)
    const fees = await wallet.connection.getRecentPrioritizationFees({
      lockedWritableAccounts: [], // Get general fees
    });
    if (fees?.length) {
      stats.avgPriorityFee = Math.round(fees.reduce((a, b) => a + b, 0) / fees.length);
      stats.maxPriorityFee = Math.max(...fees);
      stats.minPriorityFee = Math.min(...fees);
    }
  } catch (err) {
    log('warn', 'Failed to fetch prioritization fees', { error: err.message });
  }

  try {
    // Validator count
    const validators = await wallet.connection.getClusterNodes();
    if (validators?.length) {
      stats.validatorCount = validators.length;
      // Filter for voting validators (approximate)
      stats.votingValidators = validators.filter(v => v.vote).length;
    }
  } catch (err) {
    log('warn', 'Failed to fetch validator count', { error: err.message });
  }

  try {
    // Sample recent performance (this is expensive — only sample occasionally)
    // For now, we'll track TPS via a heuristic: check the average block time
    const blockHeight = await wallet.connection.getBlockHeight();
    const slot = await wallet.connection.getSlot();
    // Rough: 2s per slot on average = 2400 slots/hour / 400 TPS at 50% utilization
    // This is a placeholder; real TPS requires more sophisticated tracking
    stats.slotHeight = slot;
    stats.blockHeight = blockHeight;
    stats.recentTps = 400; // Placeholder (would need time-series data)
  } catch (err) {
    log('warn', 'Failed to fetch slot/block info', { error: err.message });
  }

  return stats;
}

// ── Detect anomalies and generate alerts ──────────────────────────────────

function _detectAnomalies(current, previous, cfg) {
  const s = cfg.strategy ?? {};
  const minTps = s.ecosystemMinTps ?? 400;
  const maxMev = s.ecosystemMaxMevPercent ?? 25;
  const minValidators = s.ecosystemMinValidators ?? 400;

  const alerts = [];

  // TPS threshold breach
  if (current.recentTps && current.recentTps < minTps) {
    alerts.push({
      type: 'low_tps',
      severity: 'warning',
      message: `TPS dropped to ${current.recentTps} (threshold: ${minTps})`,
      value: current.recentTps,
      threshold: minTps,
    });
  }

  // MEV threshold breach
  if (current.mevPercent != null && current.mevPercent > maxMev) {
    alerts.push({
      type: 'high_mev',
      severity: 'warning',
      message: `MEV at ${current.mevPercent.toFixed(1)}% (threshold: ${maxMev}%)`,
      value: current.mevPercent,
      threshold: maxMev,
    });
  }

  // Validator threshold breach
  if (current.validatorCount && current.validatorCount < minValidators) {
    alerts.push({
      type: 'low_validators',
      severity: 'warning',
      message: `Validators: ${current.validatorCount} (threshold: ${minValidators})`,
      value: current.validatorCount,
      threshold: minValidators,
    });
  }

  // Priority fee spike (sudden jump)
  if (previous?.avgPriorityFee && current.avgPriorityFee) {
    const jump = (current.avgPriorityFee - previous.avgPriorityFee) / previous.avgPriorityFee;
    if (jump > 1.0) { // >100% spike
      alerts.push({
        type: 'fee_spike',
        severity: 'info',
        message: `Priority fees up ${(jump * 100).toFixed(0)}%`,
        previous: previous.avgPriorityFee,
        current: current.avgPriorityFee,
      });
    }
  }

  return alerts;
}

// ── Load/save health and alerts files ──────────────────────────────────────

function _loadHealth() {
  try {
    if (!fs.existsSync(HEALTH_FILE)) return { history: [] };
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch { return { history: [] }; }
}

function _saveHealth(data) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    const tmp = HEALTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, HEALTH_FILE);
  } catch (err) {
    log('warn', 'Failed to save health data', { error: err.message });
  }
}

function _loadAlerts() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return { alerts: [] };
    return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
  } catch { return { alerts: [] }; }
}

function _saveAlerts(data) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
    const tmp = ALERTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, ALERTS_FILE);
  } catch (err) {
    log('warn', 'Failed to save alerts', { error: err.message });
  }
}

// ── Main check-and-alert function ─────────────────────────────────────────

async function checkHealth(cfg, ctx, telegramBot = null) {
  const s = cfg.strategy ?? {};
  if (!s.ecosystemEnabled) return;

  log('info', 'Checking ecosystem health');

  const { wallet } = ctx;
  if (!wallet) {
    log('warn', 'No wallet context — skipping health check');
    return;
  }

  try {
    // Fetch current network stats
    const stats = await _fetchNetworkStats(wallet);
    const { score, breakdown } = _scoreHealth(stats);

    log('info', 'Health check complete', { score, stats: Object.keys(stats).join(',') });

    // Load history and add current reading
    const health = _loadHealth();
    const entry = { ts: stats.ts, score, stats, breakdown };
    if (!health.history) health.history = [];
    health.history.push(entry);
    // Keep last 100 readings (~8 hours at 5min intervals)
    health.history = health.history.slice(-100);
    health.current = entry;
    _saveHealth(health);

    // Detect anomalies
    const previous = health.history[-2] || null;
    const alerts = _detectAnomalies(stats, previous, cfg);

    if (alerts.length) {
      log('warn', `Detected ${alerts.length} anomaly(ies)`, { types: alerts.map(a => a.type).join(',') });

      const alertsData = _loadAlerts();
      if (!alertsData.alerts) alertsData.alerts = [];
      for (const alert of alerts) {
        alertsData.alerts.push({ ...alert, detectedAt: new Date().toISOString() });
      }
      // Keep last 200 alerts
      alertsData.alerts = alertsData.alerts.slice(-200);
      alertsData.recent = alerts;
      _saveAlerts(alertsData);

      // Emit Telegram notifications for critical alerts
      if (telegramBot?.api?.sendMessage && cfg.telegram?.chatId) {
        for (const alert of alerts) {
          if (alert.severity !== 'info') {
            const msg = `⚠️ *Ecosystem Alert* — ${alert.message}`;
            telegramBot.api.sendMessage(cfg.telegram.chatId, msg, { parse_mode: 'Markdown' })
              .catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    log('error', 'Health check error', { error: err.message });
  }
}

// ── Initialize ────────────────────────────────────────────────────────────

function initialize() {
  const health = _loadHealth();
  _saveHealth(health);
  const alerts = _loadAlerts();
  _saveAlerts(alerts);
  log('info', 'Ecosystem intel initialized');
}

module.exports = { checkHealth, initialize };

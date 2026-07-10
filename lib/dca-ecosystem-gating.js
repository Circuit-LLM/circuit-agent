// lib/dca-ecosystem-gating.js — Gate DCA and entries based on ecosystem conditions
// Tier 3: Conditional trading based on network health + fee environment
'use strict';

const ecosystemIntel = require('./ecosystem-intel');

/**
 * Check if trading should be gated based on ecosystem conditions.
 * @param {object} cfg — config (gating thresholds)
 * @returns {object} { shouldGate, reason, ecosystemHealth }
 */
function shouldGateTradingOnEcosystem(cfg = {}) {
  const gating = cfg.ecosystemGating ?? {};
  const enabled = gating.enabled !== false;  // default to true (conservative)
  const minHealth = gating.minHealthScore ?? 60;  // 0-100
  const maxPriorityFee = gating.maxPriorityFeePerSol ?? 0.001;  // SOL

  if (!enabled) return { shouldGate: false, reason: 'disabled', ecosystemHealth: null };

  // Try to get health data; if ecosystem-intel unavailable, fail-open (don't gate)
  let health;
  try {
    health = ecosystemIntel.getLatestHealth();
  } catch {
    return { shouldGate: false, reason: 'ecosystem data unavailable', ecosystemHealth: null };
  }

  if (!health) return { shouldGate: false, reason: 'no health data yet', ecosystemHealth: null };

  const reasons = [];
  let shouldGate = false;

  // Gate 1: Health score too low
  if (health.score < minHealth) {
    reasons.push(`health ${health.score}/100 < ${minHealth}`);
    shouldGate = true;
  }

  // Gate 2: Priority fees too high
  if (health.avgPriorityFee > maxPriorityFee) {
    reasons.push(`priority fees ${health.avgPriorityFee.toFixed(6)} > ${maxPriorityFee.toFixed(6)} SOL`);
    shouldGate = true;
  }

  // Gate 3: Anomalies detected
  if (health.anomalies?.length) {
    reasons.push(`${health.anomalies.length} anomalies: ${health.anomalies.join(', ')}`);
    // Only gate on severe anomalies (not just low validator count)
    if (health.anomalies.some(a => ['high_mev', 'low_tps', 'validator_exit'].includes(a))) {
      shouldGate = true;
    }
  }

  return {
    shouldGate,
    reason: reasons.length ? reasons.join(' | ') : 'ecosystem healthy',
    ecosystemHealth: {
      score: health.score,
      tps: health.tps,
      validators: health.validatorCount,
      avgPriorityFee: health.avgPriorityFee,
      anomalies: health.anomalies ?? [],
    },
  };
}

/**
 * Adjust DCA entry size based on ecosystem conditions.
 * Returns multiplier (0.0 = pause, 1.0 = normal, >1.0 = boost).
 */
function dcaSizeMultiplier(cfg = {}) {
  const gating = cfg.ecosystemGating ?? {};
  if (!gating.enabled) return 1.0;

  const { shouldGate, ecosystemHealth } = shouldGateTradingOnEcosystem(cfg);
  if (shouldGate || !ecosystemHealth) return 0.0;

  // Scale size inversely with priority fee (lower fee = bigger position)
  const feeMultiplier = Math.max(0.5, 1.0 - (ecosystemHealth.avgPriorityFee / 0.002));

  // Scale inversely with health score (lower health = smaller position)
  const healthMultiplier = ecosystemHealth.score / 100;

  return parseFloat((feeMultiplier * healthMultiplier).toFixed(2));
}

/**
 * Check if DCA should skip this interval due to ecosystem conditions.
 */
function shouldSkipDcaCycle(cfg = {}) {
  const { shouldGate, reason } = shouldGateTradingOnEcosystem(cfg);
  if (!shouldGate) return false;
  console.log(`[DCA-ECO] Skipping DCA cycle: ${reason}`);
  return true;
}

module.exports = {
  shouldGateTradingOnEcosystem,
  dcaSizeMultiplier,
  shouldSkipDcaCycle,
};

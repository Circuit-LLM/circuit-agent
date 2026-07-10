// lib/analysis/learned-gates.js — Load and apply learned gate thresholds from analysis
// Produced by gate-learner.js, consumed by auto-scanner.js to optimize buyRatio gates per cluster
'use strict';

const fs   = require('fs');
const path = require('path');

const LEARNED_GATES_FILE = path.join(__dirname, '../../data/learned-gates.json');

/**
 * Load learned gate thresholds from file.
 * Format: { clusterKey: { current: 65, recommended: 75, confidence: 0.87 }, ... }
 * @returns {object} Learned gates, or {} if file doesn't exist or parsing fails
 */
function loadLearnedGates() {
  try {
    if (fs.existsSync(LEARNED_GATES_FILE)) {
      return JSON.parse(fs.readFileSync(LEARNED_GATES_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`[GATES] Failed to load learned gates: ${err.message}`);
  }
  return {};
}

/**
 * Save learned gate thresholds to file (called by gate-learner after backtest).
 * @param {object} gates — { clusterKey: { current, recommended, confidence }, ... }
 */
function saveLearnedGates(gates) {
  try {
    const dir = path.dirname(LEARNED_GATES_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = LEARNED_GATES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(gates, null, 2));
    fs.renameSync(tmp, LEARNED_GATES_FILE);
  } catch (err) {
    console.warn(`[GATES] Failed to save learned gates: ${err.message}`);
  }
}

/**
 * Get the recommended buyRatio threshold for a cluster.
 * If learned gates exist and confidence >= minConfidence, use recommended; else use default.
 * @param {string} clusterKey — cluster identifier (e.g. "momentum|evening|medium")
 * @param {number} defaultThreshold — fallback if no learned gate (default 65)
 * @param {number} minConfidence — only apply if confidence >= this (0-1, default 0.85)
 * @returns {object} { threshold, source, confidence }
 */
function getGateThreshold(clusterKey, defaultThreshold = 65, minConfidence = 0.85) {
  const gates = loadLearnedGates();
  const learned = gates[clusterKey];

  if (learned && learned.confidence >= minConfidence) {
    return {
      threshold:  learned.recommended,
      source:     'learned',
      confidence: learned.confidence,
      reasoning:  learned.reasoning || '',
    };
  }

  return {
    threshold:  defaultThreshold,
    source:     'default',
    confidence: null,
  };
}

/**
 * Apply learned gates to a candidate (used in auto-scanner).
 * @param {object} candidate — { symbol, mint, pattern, score, buyRatio5m, ... }
 * @param {object} cfg — config (for minConfidence setting)
 * @returns {object} { passed: bool, reason: string, threshold: number }
 */
function applyLearnedGate(candidate, cfg) {
  const { pattern, timeOfDay = 'unknown', liquidityClass = 'medium', buyRatio5m = 0 } = candidate;
  const clusterKey = `${pattern}|${timeOfDay}|${liquidityClass}`;
  const minConfidence = cfg.analysis?.gateConfidenceThreshold ?? 0.85;

  const gate = getGateThreshold(clusterKey, 65, minConfidence);
  const threshold = gate.threshold;
  const buyRatioPct = buyRatio5m * 100;

  // If buyRatio exceeds the learned (or default) threshold, block
  if (buyRatioPct > threshold) {
    return {
      passed:    false,
      reason:    `${clusterKey}: buyRatio ${buyRatioPct.toFixed(1)}% > gate ${threshold}% (${gate.source})`,
      threshold: threshold,
    };
  }

  return {
    passed:    true,
    reason:    `${clusterKey}: buyRatio ${buyRatioPct.toFixed(1)}% ≤ gate ${threshold}% (${gate.source})`,
    threshold: threshold,
  };
}

module.exports = {
  loadLearnedGates,
  saveLearnedGates,
  getGateThreshold,
  applyLearnedGate,
};

// lib/memory/reflection-learner.js — Track what config changes actually worked
// Used by reflect.js to grade its own recommendations across cycles
'use strict';

const fs   = require('fs');
const path = require('path');

const REFLECTION_LOG = path.join(__dirname, '../../data/reflection_log.jsonl');

/**
 * Log a config change that was applied (called by reflect.js after saveConfig).
 * @param {object} change — { field, oldValue, newValue, reasoning }
 * @param {string} context — 'regime' or 'market_condition'
 * @param {number} confidence — 0–1 confidence in the recommendation
 */
function logConfigChange(change, context = '', confidence = 0.5) {
  try {
    const entry = {
      timestamp:     new Date().toISOString(),
      field:         change.field,
      oldValue:      change.oldValue,
      newValue:      change.newValue,
      reasoning:     change.reasoning || '',
      context,
      confidence,
      gradeAt:       new Date(Date.now() + 4 * 3600_000).toISOString(),  // grade in 4h (next reflect cycle)
      grade:         null,  // filled by gradeExpiredChanges()
    };
    fs.appendFileSync(REFLECTION_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.warn(`[MEMORY] Failed to log config change: ${err.message}`);
  }
}

/**
 * Grade an expired config change by comparing win rates before/after.
 * Called by reflect.js at the start of each reflection cycle.
 * Returns lessons for future reflections to learn from.
 */
function gradeExpiredChanges(trades = [], cfg = {}) {
  if (!fs.existsSync(REFLECTION_LOG)) return [];

  try {
    const lines = fs.readFileSync(REFLECTION_LOG, 'utf8').trim().split('\n');
    const changes = lines.map(l => JSON.parse(l));
    const week = Date.now() - 7 * 86_400_000;

    const graded = changes
      .filter(c => !c.grade && new Date(c.gradeAt).getTime() <= Date.now())
      .map(c => {
        // Analyze trades AFTER this config change was applied
        const after = trades.filter(t => new Date(t.entryTime ?? t.openTime).getTime() >= new Date(c.timestamp).getTime());
        const afterWinRate = after.length ? after.filter(t => (t.pnlPct ?? 0) > 0).length / after.length : 0;
        const afterAvgPnl = after.length ? after.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / after.length : 0;

        const lesson = {
          ...c,
          grade: afterWinRate > 0.35 ? 'POSITIVE' : afterWinRate < 0.20 ? 'NEGATIVE' : 'NEUTRAL',
          afterWinRate,
          afterAvgPnl,
          tradeSample: after.length,
        };

        // Persist the grade
        _updateLogEntry(c.timestamp, { grade: lesson.grade, afterWinRate, afterAvgPnl, tradeSample: after.length });
        return lesson;
      });

    return graded;
  } catch (err) {
    console.warn(`[MEMORY] Failed to grade changes: ${err.message}`);
    return [];
  }
}

/**
 * Get lessons from past config changes (what worked, what didn't).
 * Used by reflect.js to avoid repeating failed experiments.
 */
function getRecentLessons(limit = 10) {
  if (!fs.existsSync(REFLECTION_LOG)) return [];

  try {
    const lines = fs.readFileSync(REFLECTION_LOG, 'utf8').trim().split('\n');
    const changes = lines.map(l => JSON.parse(l));
    const positive = changes.filter(c => c.grade === 'POSITIVE').slice(-limit);
    const negative = changes.filter(c => c.grade === 'NEGATIVE').slice(-limit);

    const lessons = [];
    if (positive.length) {
      lessons.push({
        type: 'POSITIVE',
        count: positive.length,
        summary: `${positive.length} config changes improved performance (avg ${(positive[positive.length - 1].afterWinRate * 100).toFixed(0)}% WR)`,
        examples: positive.map(p => `${p.field}: ${p.oldValue}→${p.newValue} (${p.context})`).slice(-3),
      });
    }
    if (negative.length) {
      lessons.push({
        type: 'NEGATIVE',
        count: negative.length,
        summary: `${negative.length} config changes HURT performance (avg ${(negative[negative.length - 1].afterWinRate * 100).toFixed(0)}% WR)`,
        examples: negative.map(n => `${n.field}: ${n.oldValue}→${n.newValue} (${n.context})`).slice(-3),
      });
    }

    return lessons;
  } catch (err) {
    console.warn(`[MEMORY] Failed to get lessons: ${err.message}`);
    return [];
  }
}

/**
 * Clear old entries from the log (keep only last 30 days).
 */
function prune() {
  if (!fs.existsSync(REFLECTION_LOG)) return;

  try {
    const lines = fs.readFileSync(REFLECTION_LOG, 'utf8').trim().split('\n');
    const month = Date.now() - 30 * 86_400_000;
    const fresh = lines
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(c => c && new Date(c.timestamp).getTime() >= month);

    fs.writeFileSync(REFLECTION_LOG, fresh.map(c => JSON.stringify(c)).join('\n') + (fresh.length ? '\n' : ''));
  } catch (err) {
    console.warn(`[MEMORY] Failed to prune log: ${err.message}`);
  }
}

function _updateLogEntry(timestamp, grade) {
  try {
    const lines = fs.readFileSync(REFLECTION_LOG, 'utf8').trim().split('\n');
    const updated = lines.map(l => {
      const entry = JSON.parse(l);
      if (entry.timestamp === timestamp) {
        return JSON.stringify({ ...entry, ...grade });
      }
      return l;
    });
    fs.writeFileSync(REFLECTION_LOG, updated.join('\n') + (updated.length ? '\n' : ''));
  } catch (err) {
    console.warn(`[MEMORY] Failed to update log entry: ${err.message}`);
  }
}

module.exports = {
  logConfigChange,
  gradeExpiredChanges,
  getRecentLessons,
  prune,
};

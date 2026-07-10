// lib/analysis/approval-queue.js — Track recommendations awaiting operator approval
// Surfaced in dashboard for operator review + feedback
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPROVAL_FILE = path.join(__dirname, '../../data/approvals.jsonl');

/**
 * Submit a recommendation for operator approval.
 * @param {object} rec — { title, action, priority, expectedLift, type, data }
 * @returns {string} recommendation ID for operator to reference
 */
function submitForApproval(rec) {
  try {
    const id = crypto.randomBytes(8).toString('hex');
    const entry = {
      id,
      timestamp:     new Date().toISOString(),
      title:         rec.title,
      action:        rec.action,
      priority:      rec.priority,
      expectedLift:  rec.expectedLift,
      type:          rec.type,  // 'gate', 'minScore', 'entrySize', 'time-filter', etc.
      data:          rec.data,
      status:        'pending',  // pending | approved | rejected
      operatorNote:  '',
      approvedAt:    null,
      appliedAt:     null,
    };
    fs.appendFileSync(APPROVAL_FILE, JSON.stringify(entry) + '\n');
    return id;
  } catch (err) {
    console.warn(`[APPROVALS] Failed to submit for approval: ${err.message}`);
    return null;
  }
}

/**
 * List pending recommendations.
 * @returns {array} pending recommendations
 */
function getPending() {
  if (!fs.existsSync(APPROVAL_FILE)) return [];

  try {
    const lines = fs.readFileSync(APPROVAL_FILE, 'utf8').trim().split('\n');
    return lines
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(e => e && e.status === 'pending')
      .sort((a, b) => {
        const priorityMap = { HIGH: 3, MEDIUM: 2, LOW: 1 };
        return (priorityMap[b.priority] || 0) - (priorityMap[a.priority] || 0);
      });
  } catch (err) {
    console.warn(`[APPROVALS] Failed to get pending: ${err.message}`);
    return [];
  }
}

/**
 * Get all recommendations (including past).
 */
function getAll() {
  if (!fs.existsSync(APPROVAL_FILE)) return [];

  try {
    const lines = fs.readFileSync(APPROVAL_FILE, 'utf8').trim().split('\n');
    return lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.warn(`[APPROVALS] Failed to get all: ${err.message}`);
    return [];
  }
}

/**
 * Approve or reject a recommendation.
 * @param {string} id — recommendation ID
 * @param {boolean} approved — true to approve, false to reject
 * @param {string} note — operator notes
 */
function updateStatus(id, approved, note = '') {
  try {
    const lines = fs.readFileSync(APPROVAL_FILE, 'utf8').trim().split('\n');
    const updated = lines.map(l => {
      const entry = JSON.parse(l);
      if (entry.id === id) {
        return JSON.stringify({
          ...entry,
          status: approved ? 'approved' : 'rejected',
          operatorNote: note,
          decidedAt: new Date().toISOString(),
        });
      }
      return l;
    });
    fs.writeFileSync(APPROVAL_FILE, updated.join('\n') + (updated.length ? '\n' : ''));
  } catch (err) {
    console.warn(`[APPROVALS] Failed to update status: ${err.message}`);
  }
}

/**
 * Mark a recommendation as applied (after being deployed).
 * @param {string} id — recommendation ID
 * @param {object} result — { success, configField, oldValue, newValue }
 */
function markApplied(id, result) {
  try {
    const lines = fs.readFileSync(APPROVAL_FILE, 'utf8').trim().split('\n');
    const updated = lines.map(l => {
      const entry = JSON.parse(l);
      if (entry.id === id) {
        return JSON.stringify({
          ...entry,
          status: result.success ? 'applied' : 'failed',
          appliedAt: new Date().toISOString(),
          applyResult: result,
        });
      }
      return l;
    });
    fs.writeFileSync(APPROVAL_FILE, updated.join('\n') + (updated.length ? '\n' : ''));
  } catch (err) {
    console.warn(`[APPROVALS] Failed to mark applied: ${err.message}`);
  }
}

/**
 * Get summary for dashboard.
 */
function getSummary() {
  const all = getAll();
  return {
    pending:  all.filter(r => r.status === 'pending').length,
    approved: all.filter(r => r.status === 'approved').length,
    rejected: all.filter(r => r.status === 'rejected').length,
    applied:  all.filter(r => r.status === 'applied').length,
    recentApproved: all.filter(r => r.status === 'approved').slice(-3),
  };
}

module.exports = {
  submitForApproval,
  getPending,
  getAll,
  updateStatus,
  markApplied,
  getSummary,
};

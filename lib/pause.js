// lib/pause.js — pause/resume gate for the auto-scanner
// Pausing stops the auto-scanner from making NEW buys.
// The position monitor keeps running — existing positions are always managed.
'use strict';

const fs   = require('fs');
const path = require('path');

const PAUSE_FILE = path.join(__dirname, '../data/trading_paused.json');

function isPaused() {
  try {
    if (!fs.existsSync(PAUSE_FILE)) return false;
    const d = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    if (!d.paused) return false;
    // Auto-expire timed pauses
    if (d.until && new Date(d.until) <= new Date()) {
      fs.unlinkSync(PAUSE_FILE);
      return false;
    }
    return true;
  } catch { return false; }
}

function pauseTrading(reason = '', minutes = null) {
  const d = {
    paused:   true,
    reason:   reason || 'manual',
    pausedAt: new Date().toISOString(),
  };
  if (minutes && minutes > 0) {
    d.until = new Date(Date.now() + minutes * 60_000).toISOString();
  }
  fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true });
  const tmp = PAUSE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, PAUSE_FILE);
  return d;
}

function resumeTrading() {
  try { if (fs.existsSync(PAUSE_FILE)) fs.unlinkSync(PAUSE_FILE); } catch { /* ignore */ }
  return { paused: false };
}

function pauseStatus() {
  try {
    if (!fs.existsSync(PAUSE_FILE)) return { paused: false };
    const d = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    if (!d.paused) return { paused: false };
    if (d.until && new Date(d.until) <= new Date()) {
      try { fs.unlinkSync(PAUSE_FILE); } catch { /* ignore */ }
      return { paused: false };
    }
    return d;
  } catch { return { paused: false }; }
}

module.exports = { isPaused, pauseTrading, resumeTrading, pauseStatus };

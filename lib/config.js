// lib/config.js — shared configuration loader for circuit-agent
//
// Merges config/agent.json (repo defaults) with config/agent.local.json
// (user overrides, gitignored). Call loadConfig() anywhere — it reads fresh
// from disk each time so hot-reloading (model switch, update_config) works.
//
// Usage:
//   const { loadConfig } = require('./config');
//   const cfg = loadConfig();
'use strict';

const fs   = require('fs');
const path = require('path');

const BASE_FILE  = path.join(__dirname, '../config/agent.json');
const LOCAL_FILE = path.join(__dirname, '../config/agent.local.json');

function _deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = _deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  let cfg = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'));
  if (fs.existsSync(LOCAL_FILE)) {
    try {
      const local = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
      cfg = _deepMerge(cfg, local);
    } catch (e) {
      process.stderr.write(`[config] Warning: agent.local.json parse error — ${e.message}\n`);
    }
  }
  return cfg;
}

module.exports = { loadConfig };

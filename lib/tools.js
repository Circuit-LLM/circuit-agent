// lib/tools.js — tool definitions + dispatcher for circuit-agent LLM
//
// Tools are split by category into lib/tools/:
//   market.js  — Solana data + research (scan, prices, overview, charts, news)
//   trading.js — Trade execution (buy, sell, wallet, pause/resume)
//   swarm.js   — Swarm intelligence + task board (feed, consensus, signals, tasks)
//   memory.js  — Per-user and agent self-memory (save/recall)
//   self.js    — Self-improvement (trade history, config tuning, session strategy)
//   web.js     — Web search, URL fetch, skill load
//   builder.js — File system + script execution (read/write files, run scripts)
//   copilot.js — Solana copilot (token dossiers, wallet inspection, price/wallet watches)
//
// To add a new tool: add a definition to DEFINITIONS and a handler to HANDLERS
// in the appropriate category file. No changes needed here.
'use strict';

const market  = require('./tools/market');
const trading = require('./tools/trading');
const swarm   = require('./tools/swarm');
const mem     = require('./tools/memory');
const self_   = require('./tools/self');
const web     = require('./tools/web');
const builder = require('./tools/builder');
const copilot = require('./tools/copilot');

// ── Tool result cache ─────────────────────────────────────────────────────────
// Prevents duplicate API calls when the LLM calls the same read-only tool
// multiple times within one session. Write/action tools are never cached.

const _toolCache = new Map();  // key → { result: string, expiresAt: number }

const TOOL_CACHE_TTL = {
  scan_tokens:          5 * 60_000,
  market_overview:      5 * 60_000,
  market_sentiment:    10 * 60_000,
  oracle_prices:        2 * 60_000,
  token_price:             30_000,
  network_stats:           60_000,
  staking_yields:      30 * 60_000,
  defi_overview:       15 * 60_000,
  token_info:          10 * 60_000,
  token_holders:        5 * 60_000,
  research_token:          60_000,
  inspect_wallet:          60_000,
  token_chart:          5 * 60_000,
  get_news:            15 * 60_000,
  top_pools:            5 * 60_000,
  read_swarm_feed:      2 * 60_000,
  get_swarm_consensus:     60_000,
  get_swarm_strategies: 3 * 60_000,
  swarm_leaderboard:    5 * 60_000,
  get_my_reputation:    5 * 60_000,
  get_swarm_blacklist:  2 * 60_000,
  check_blacklist:      2 * 60_000,
};

function _cacheKey(name, args) {
  return `${name}:${JSON.stringify(args ?? {})}`;
}

function _cacheGet(name, args) {
  const entry = _toolCache.get(_cacheKey(name, args));
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.result;
}

function _cacheSet(name, args, result) {
  const ttl = TOOL_CACHE_TTL[name];
  if (!ttl) return;
  _toolCache.set(_cacheKey(name, args), { result, expiresAt: Date.now() + ttl });
  // Evict expired entries periodically (keep map from growing unbounded)
  if (_toolCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _toolCache) { if (now > v.expiresAt) _toolCache.delete(k); }
  }
}

// ── Combined tool definitions (OpenAI function-calling format) ────────────────

const TOOL_DEFINITIONS = [
  ...market.DEFINITIONS,
  ...trading.DEFINITIONS,
  ...swarm.DEFINITIONS,
  ...mem.DEFINITIONS,
  ...self_.DEFINITIONS,
  ...web.DEFINITIONS,
  ...builder.DEFINITIONS,
  ...copilot.DEFINITIONS,
];

// ── Combined handlers ─────────────────────────────────────────────────────────

const ALL_HANDLERS = {
  ...market.HANDLERS,
  ...trading.HANDLERS,
  ...swarm.HANDLERS,
  ...mem.HANDLERS,
  ...self_.HANDLERS,
  ...web.HANDLERS,
  ...builder.HANDLERS,
  ...copilot.HANDLERS,
};

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, ctx, log) {
  // Check cache for read-only tools before making any API call
  const cached = _cacheGet(name, args);
  if (cached) {
    log('info', `Cache hit: ${name} (TTL ${((TOOL_CACHE_TTL[name] ?? 0) / 60_000).toFixed(0)}min)`);
    return cached;
  }

  const handler = ALL_HANDLERS[name];
  if (!handler) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  try {
    const result = await handler(args, ctx, log);
    _cacheSet(name, args, result);
    return result;
  } catch (err) {
    log('warn', `Tool ${name} failed`, { error: err.message });
    return JSON.stringify({ error: err.message });
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };

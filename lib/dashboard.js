process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });

// lib/dashboard.js — Local web dashboard for circuit-agent
// Serves a single-page dashboard at http://localhost:<port>
// Provides real-time positions, trades, swarm data, tasks, and direct agent chat.
'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const crypto  = require('crypto');

let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* optional — dashboard still works without it */ }

const positions = require('./positions');

const LOG_FILE          = path.join(__dirname, '../logs/processor.log');
const LOCAL_CONFIG_FILE = path.join(__dirname, '../config/agent.local.json');
const IDENTITY_FILE     = path.join(__dirname, '../data/agent-identity.json');
const CONTEXT_FILE    = path.join(__dirname, '../data/session-context.json');
const STRATEGY_FILE   = path.join(__dirname, '../data/session_strategy.json');
const LAST_SCAN_FILE  = path.join(__dirname, '../data/last_scan.json');
const QUEUE_INCOMING  = path.join(__dirname, '../data/queue/incoming');
const QUEUE_OUTGOING  = path.join(__dirname, '../data/queue/outgoing');
const HTML_FILE       = path.join(__dirname, 'dashboard.html');

// Price data comes from circuit-price-feed via the API — no direct DexScreener calls.

let _api = null;
let _wallet = null;
let _cfg = null;
let _startTime = Date.now();

// ── QR code cache (address never changes, generate once) ──────────────────────
let _qrSvgCache = null;
async function _walletQrSvg() {
  if (_qrSvgCache) return _qrSvgCache;
  const address = _wallet?.address;
  if (!address || !QRCode) return null;
  try {
    _qrSvgCache = await QRCode.toString(address, {
      type:   'svg',
      color:  { dark: '#ffe000', light: '#09080a' },
      width:  260,
      margin: 2,
    });
  } catch { _qrSvgCache = null; }
  return _qrSvgCache;
}

// ── Price cache (shared between SSE push and positions API) ───────────────────
let _priceCache = {};
let _priceCacheAt = 0;
const PRICE_CACHE_TTL = 12_000; // 12s — positions refresh every 15s via SSE

// ── SSE clients ───────────────────────────────────────────────────────────────

const _sseClients = new Set();

function _sseEmit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(payload); } catch { _sseClients.delete(res); }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function _loadIdentity() {
  return _readJson(IDENTITY_FILE, {});
}

async function _fetchDexPrices(mints) {
  if (!mints.length) return {};
  // Serve from cache if fresh enough — avoids double-fetch when SSE tick and
  // HTTP /api/positions hit the price-feed within the same 12s window.
  if (Date.now() - _priceCacheAt < PRICE_CACHE_TTL &&
      mints.every(m => _priceCache[m] !== undefined)) {
    return _priceCache;
  }
  try {
    const base = _api?.baseUrl ?? 'https://api.circuitllm.xyz';
    const url  = `${base}/api/price-feed/prices?mints=${mints.join(',')}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return _priceCache;
    const data = await resp.json();
    const out  = {};
    for (const [mint, r] of Object.entries(data.results ?? {})) {
      if (!r) continue;
      out[mint] = {
        priceNative: r.priceSol  ?? 0,
        priceUsd:    r.priceUsd  ?? 0,
        symbol:      _priceCache[mint]?.symbol ?? '?',
        change1h:    null,
        change24h:   null,
        liquidity:   0,
        volume24h:   0,
      };
    }
    _priceCache   = { ..._priceCache, ...out };
    _priceCacheAt = Date.now();
    return _priceCache;
  } catch { return _priceCache; }
}

function _readLogActivity(n = 40) {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const stat = fs.statSync(LOG_FILE);
    const readSize = Math.min(stat.size, 300 * 1024);
    const buf = Buffer.alloc(readSize);
    const fd  = fs.openSync(LOG_FILE, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);

    const RULES = [
      { re: /\[SCAN\].*Buying\s+(\S+).*?([\d.]+)\s+SOL/,        fmt: m => `🟢 BUY ${m[1]}  ${m[2]} SOL` },
      { re: /\[SCAN\].*Bought\s+(\S+)/,                          fmt: m => `🟢 BUY ${m[1]}` },
      { re: /\[MON\].*Position closed.*symbol.*"([^"]+)".*reason.*"([^"]+)".*pnl.*"([^"]+)"/,
            fmt: m => `${m[3].startsWith('+') ? '🟢' : '🔴'} SELL ${m[1]}  ${m[3]}  (${m[2]})` },
      { re: /\[MON\].*Position closed.*"symbol":"([^"]+)".*"reason":"([^"]+)".*"pnl":"([^"]+)"/,
            fmt: m => `${m[3].startsWith('+') ? '🟢' : '🔴'} SELL ${m[1]}  ${m[3]}  (${m[2]})` },
      { re: /\[MON\].*Partial sell succeeded.*symbol.*"([^"]+)"/,fmt: m => `🟡 PARTIAL SELL ${m[1]}` },
      { re: /\[SCAN\].*(\d+) candidates after local/,            fmt: m => `🔍 SCAN  ${m[1]} candidates` },
      { re: /\[SCAN\].*Peer-holding filter removed (\d+)/,       fmt: m => `🚫 HERD  blocked ${m[1]} token(s)` },
      { re: /\[SCAN\].*No candidates passed/,                    fmt: () => `🔍 SCAN  no setups found` },
      { re: /\[REFLECT\].*Reflect cycle complete/,               fmt: () => '🧠 REFLECT cycle done' },
      { re: /\[REFLECT\].*Reflect cycle starting/,               fmt: () => '🧠 REFLECT starting' },
      { re: /\[HB\].*Registry heartbeat sent/,                   fmt: () => '💓 HEARTBEAT sent' },
      { re: /\[PROC\].*Processing \[([^\]]+)\]/,                 fmt: m => `💬 LLM processing [${m[1]}]` },
      { re: /\[PROC\].*Done \[([^\]]+)\].*(\d+) chars/,          fmt: m => `✅ LLM done [${m[1]}]  ${m[2]} chars` },
      { re: /\[MON\].*Sell failed.*backing off (\d+)s/,          fmt: m => `⚠️  SELL failed — retry in ${m[1]}s` },
      { re: /\[MON\].*stop-loss — waiting/,                      fmt: () => `⚠️  STOP-LOSS pending (sell retrying)` },
      { re: /\[CIRCUIT\].*Paying ([\d.]+) CIRC for/,             fmt: m => `💳 PAID ${m[1]} CIRC` },
      { re: /\[CTX\].*Context saved/,                            fmt: () => '📡 Context refreshed' },
      { re: /\[PROFILE\].*Profile published/,                    fmt: () => '📢 Profile published to swarm' },
      { re: /\[SCAN\].*Swarm herd penalty/,                      fmt: () => '🛡️  Herd penalty applied' },
    ];

    const events = [];
    for (let i = lines.length - 1; i >= 0 && events.length < n; i--) {
      const line = lines[i];
      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/);
      if (!tsMatch) continue;
      for (const rule of RULES) {
        const m = line.match(rule.re);
        if (m) {
          events.push({ ts: tsMatch[1], label: rule.fmt(m) });
          break;
        }
      }
    }
    return events;
  } catch { return []; }
}

// ── Chat handling ─────────────────────────────────────────────────────────────

const _chatHistory = [];
const _pendingResponses = new Map(); // msgId → resolve

function _pollOutgoing() {
  if (!fs.existsSync(QUEUE_OUTGOING)) return;
  try {
    const files = fs.readdirSync(QUEUE_OUTGOING).filter(f => f.startsWith('web_'));
    for (const f of files) {
      const fpath = path.join(QUEUE_OUTGOING, f);
      try {
        const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
        fs.unlinkSync(fpath);
        _chatHistory.push({ role: 'agent', text: data.message, ts: new Date().toISOString() });
        if (_chatHistory.length > 100) _chatHistory.shift();
        // Resolve pending promise if waiting
        const resolve = _pendingResponses.get(data.messageId);
        if (resolve) { resolve(data.message); _pendingResponses.delete(data.messageId); }
        // Push to SSE clients
        _sseEmit('chat', { role: 'agent', text: data.message, ts: new Date().toISOString() });
      } catch {}
    }
  } catch {}
}

async function _sendChat(text) {
  if (!text?.trim()) return { error: 'empty message' };
  try {
    const { enqueue } = require('./processor');
    const identity = _loadIdentity();
    const msgId = enqueue('web', 'Dashboard User', identity.agentId ?? 'web', text.trim(), null);
    _chatHistory.push({ role: 'user', text: text.trim(), ts: new Date().toISOString() });
    if (_chatHistory.length > 100) _chatHistory.shift();
    _sseEmit('chat', { role: 'user', text: text.trim(), ts: new Date().toISOString() });
    return { ok: true, msgId };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Config write: field spec + validation ─────────────────────────────────────
// Allowlist of editable fields. Only fields declared here can be written via
// POST /api/config. Anything not listed (api.baseUrl, wallet paths, secrets)
// is silently read-only — not reachable by the dashboard.

const FIELD_SPEC = {
  strategy: {
    stopLossPct:             { type: 'number',  min: -50,        max: -0.5         },
    takeProfitPct:           { type: 'number',  min: 1,          max: 500          },
    maxHoldMinutes:          { type: 'integer', min: 1,          max: 480          },
    entryBudgetSol:          { type: 'number',  min: 0.001,      max: 5            },
    minScanScore:            { type: 'integer', min: 0,          max: 100          },
    maxOpenPositions:        { type: 'integer', min: 1,          max: 20           },
    trailingStopActivatePct: { type: 'number',  min: 0,          max: 100          },
    trailingStopDistancePct: { type: 'number',  min: 0.5,        max: 20           },
    buyCooldownMinutes:      { type: 'integer', min: 0,          max: 1440         },
    paperTrading:            { type: 'boolean'                                     },
    scanIntervalMs:          { type: 'number',  min: 60_000,     max: 3_600_000    },
  },
  risk: {
    maxEntry1hDropPct:       { type: 'number',  min: -90,        max: -1           },
    safeOnly:                { type: 'boolean'                                     },
  },
  agentLoop: {
    intervalMs:              { type: 'number',  min: 900_000,    max: 86_400_000   },
    patternFilter:           { type: 'array',   allowed: ['SHALLOW-DIP','DIP-BUY','REVERSAL','DEEP-REVERSAL'] },
  },
  survival: {
    minSolWarning:           { type: 'number',  min: 0.001,      max: 10           },
    minSolPause:             { type: 'number',  min: 0.001,      max: 5            },
    circuitReinvestPct:      { type: 'number',  min: 0,          max: 1            },
  },
  reflect: {
    intervalMs:              { type: 'number',  min: 3_600_000,  max: 604_800_000  },
    autoApply:               { type: 'boolean'                                     },
  },
  heartbeat: {
    intervalMs:              { type: 'number',  min: 60_000,     max: 86_400_000   },
    contextRefreshMs:        { type: 'number',  min: 60_000,     max: 86_400_000   },
  },
  llm: {
    model:                   { type: 'string',  maxLen: 100                        },
  },
  swarm: {
    autoPublish:             { type: 'boolean'                                     },
    minReputationToFollow:   { type: 'integer', min: 0,          max: 100          },
    consensusBoostFactor:    { type: 'number',  min: 1,          max: 5            },
  },
};

// Fields that take effect only after an agent restart:
// - llm.model/provider: LLM client initialized once at startup
// - heartbeat/reflect intervalMs: setInterval called once in agent.js/heartbeat.js/reflect.js
// - heartbeat.contextRefreshMs: setInterval in agent.js line ~393
// Strategy, risk, swarm, agentLoop, survival fields are all hot-reloaded per cycle.
const RESTART_REQUIRED = new Set([
  'llm.model', 'llm.provider',
  'heartbeat.intervalMs', 'heartbeat.contextRefreshMs',
  'reflect.intervalMs',
]);

function _validateConfigField(section, key, value) {
  const sectionSpec = FIELD_SPEC[section];
  if (!sectionSpec) return `Section "${section}" is not editable via dashboard`;
  const spec = sectionSpec[key];
  if (!spec) return `Field "${section}.${key}" is not editable via dashboard`;

  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return `"${key}" must be true or false`;
    return null;
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value !== 'number' || !isFinite(value)) return `"${key}" must be a finite number`;
    if (spec.type === 'integer' && !Number.isInteger(value)) return `"${key}" must be an integer`;
    if (spec.min != null && value < spec.min) return `"${key}" must be ≥ ${spec.min}`;
    if (spec.max != null && value > spec.max) return `"${key}" must be ≤ ${spec.max}`;
    return null;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return `"${key}" must be a string`;
    if (value.includes('\n') || value.includes('\r')) return `"${key}" must be a single line`;
    if (spec.maxLen && value.length > spec.maxLen) return `"${key}" must be ≤ ${spec.maxLen} characters`;
    return null;
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) return `"${key}" must be an array`;
    if (spec.allowed) {
      for (const v of value) {
        if (!spec.allowed.includes(v)) return `Invalid value "${v}" — allowed: ${spec.allowed.join(', ')}`;
      }
    }
    return null;
  }
  return 'Unknown field type';
}

// ── /api/chat rate limiter ────────────────────────────────────────────────────
// Prevents QUEUE_INCOMING from being flooded with rapid-fire chat commands,
// each of which can contain trade instructions processed by the LLM.
// Tracks per-IP request count in a rolling 60-second window.
const _chatRateWindows = new Map(); // ip → { count, windowStart }
const CHAT_RATE_LIMIT  = 10;        // max requests per 60s per IP
const CHAT_RATE_WINDOW = 60_000;

function _checkChatRateLimit(ip) {
  const now   = Date.now();
  const state = _chatRateWindows.get(ip) ?? { count: 0, windowStart: now };
  if (now - state.windowStart > CHAT_RATE_WINDOW) {
    // Window expired — reset
    state.count       = 1;
    state.windowStart = now;
    _chatRateWindows.set(ip, state);
    return true;
  }
  state.count++;
  _chatRateWindows.set(ip, state);
  return state.count <= CHAT_RATE_LIMIT;
}

// ── Request router ────────────────────────────────────────────────────────────

async function _handleRequest(req, res) {
  const url   = new URL(req.url, `http://localhost`);
  const route = url.pathname;

  // Auth — header-only check (never query param: leaks in browser history + referer)
  const apiKey = _cfg?.dashboard?.apiKey ?? '';
  const isHtmlRoute = route === '/' || route === '/dashboard';
  if (apiKey && !isHtmlRoute) {
    const provided = req.headers['x-api-key'] ?? '';
    if (provided !== apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — set x-api-key header' }));
      return;
    }
  }

  // No wildcard CORS — dashboard is same-origin with itself and does not need it.
  // Only allow explicit origin if configured (opt-in, defaults off).
  const allowedOrigin = _cfg?.dashboard?.allowCors;
  if (allowedOrigin) {
    const origin = req.headers.origin ?? '';
    if (origin === allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }

  // Static
  if (route === '/' || route === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try { res.end(fs.readFileSync(HTML_FILE, 'utf8')); }
    catch { res.end('<html><body style="background:#09080a;color:#ffe000;font-family:monospace;padding:40px">dashboard.html not found</body></html>'); }
    return;
  }

  // SSE events
  if (route === '/api/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(':\n\n'); // comment ping
    _sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(':\n\n'); } catch { clearInterval(heartbeat); _sseClients.delete(res); }
    }, 20000);
    req.on('close', () => { _sseClients.delete(res); clearInterval(heartbeat); });
    return;
  }

  // JSON APIs
  res.setHeader('Content-Type', 'application/json');

  // POST body helper — 64 KB cap prevents memory exhaustion from large payloads
  const body = await new Promise(resolve => {
    if (req.method !== 'POST') return resolve({});
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 65_536) { req.destroy(); resolve({}); }
    });
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
  });

  try {
    if (route === '/api/status') {
      const identity = _loadIdentity();
      const ctx      = _readJson(CONTEXT_FILE, {});
      let balances   = { sol: null, circ: null };
      try { balances = await _wallet?.getBalances?.() ?? balances; } catch {}
      const strat = _readJson(STRATEGY_FILE, {});
      const stratExpiry = strat.expiresAt ? new Date(strat.expiresAt).getTime() : null;
      const stratExpired = stratExpiry ? Date.now() > stratExpiry : true;
      res.end(JSON.stringify({
        address:   identity.address ?? _wallet?.address,
        agentId:   identity.agentId,
        createdAt: identity.createdAt,
        uptime:    Math.floor((Date.now() - _startTime) / 1000),
        sol:       balances.sol ?? null,
        circ:      balances.circuit ?? balances.circ ?? null,
        solUsd:    ctx.sol?.price ?? null,
        fearGreed: ctx.fearGreed ?? null,
        model:     _cfg?.llm?.model ?? null,
        swarm:     ctx.swarm ?? null,
        trades:    ctx.trades ?? null,
        paperMode: _cfg?.strategy?.paperTrading ?? false,
        strategy: {
          mode:           strat.mode          ?? null,
          patternFilter:  strat.patternFilter  ?? null,
          minScoreOverride: strat.minScoreOverride ?? null,
          maxBuysThisSession: strat.maxBuysThisSession ?? null,
          buysThisSession: strat.buysThisSession ?? 0,
          sessionGoal:    strat.sessionGoal    ?? null,
          expiresAt:      strat.expiresAt      ?? null,
          expired:        stratExpired,
          expiresInMs:    stratExpiry ? Math.max(0, stratExpiry - Date.now()) : null,
        },
      }));
      return;
    }

    if (route === '/api/positions') {
      const held  = positions.getAll();
      const mints = Object.keys(held);
      const prices = await _fetchDexPrices(mints);
      const now = Date.now();
      const list = mints.map(mint => {
        const pos  = held[mint];
        const p    = prices[mint];
        const dec  = pos.tokenDecimals ?? 6;
        const ui   = parseFloat(pos.tokenAmount) / Math.pow(10, dec);
        const curP = p?.priceNative ?? 0;
        const curV = curP * ui;
        const pnlSol  = curP ? curV - pos.solSpent : null;
        const pnlPct  = curP ? ((curV - pos.solSpent) / pos.solSpent) * 100 : null;
        const holdMin = Math.floor((now - new Date(pos.entryTime).getTime()) / 60000);
        return {
          mint,
          symbol:      pos.symbol,
          entryPrice:  pos.entryPrice,
          currentPrice: curP || null,
          priceUsd:    p?.priceUsd ?? null,
          change1h:    p?.change1h ?? null,
          solSpent:    pos.solSpent,
          currentValue: curP ? curV : null,
          pnlSol,
          pnlPct,
          peakPnlPct:  pos.peakPnlPct,
          holdMin,
          entryTime:   pos.entryTime,
          tokenAmount: pos.tokenAmount,
          liquidity:   p?.liquidity ?? null,
          stopLoss:    _cfg?.strategy?.stopLossPct ?? -6,
          takeProfit:  _cfg?.strategy?.takeProfitPct ?? 12,
          trailingActivate: _cfg?.strategy?.trailingStopActivatePct ?? 4,
        };
      });
      res.end(JSON.stringify({ positions: list, count: list.length, pricesAt: new Date().toISOString() }));
      return;
    }

    if (route === '/api/trades') {
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const filter = url.searchParams.get('filter') || 'all'; // all|wins|losses
      let history = positions.getTradeHistory(limit, 365);
      if (filter === 'wins')   history = history.filter(t => (t.pnlSol ?? 0) > 0);
      if (filter === 'losses') history = history.filter(t => (t.pnlSol ?? 0) <= 0);
      const wins      = history.filter(t => (t.pnlSol ?? 0) > 0).length;
      const totalPnl  = history.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
      const avgPnlPct = history.length ? history.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / history.length : 0;
      const best  = history.reduce((b, t) => (t.pnlSol ?? 0) > (b?.pnlSol ?? -Infinity) ? t : b, null);
      const worst = history.reduce((w, t) => (t.pnlSol ?? 0) < (w?.pnlSol ?? Infinity)  ? t : w, null);
      res.end(JSON.stringify({
        trades: [...history].reverse(),
        stats: {
          total: history.length, wins, losses: history.length - wins,
          winRate: history.length ? Math.round((wins / history.length) * 100) : 0,
          totalPnlSol: +totalPnl.toFixed(5),
          avgPnlPct:   +avgPnlPct.toFixed(2),
          best:  best  ? { symbol: best.symbol,  pnlSol: best.pnlSol,  pnlPct: best.pnlPct  } : null,
          worst: worst ? { symbol: worst.symbol, pnlSol: worst.pnlSol, pnlPct: worst.pnlPct } : null,
        },
      }));
      return;
    }

    if (route === '/api/activity') {
      const n = parseInt(url.searchParams.get('n') || '30');
      res.end(JSON.stringify({ events: _readLogActivity(n) }));
      return;
    }

    if (route === '/api/swarm') {
      let stats = null, leaderboard = null, feed = null, agentStats = null;
      try {
        [stats, leaderboard, feed, agentStats] = await Promise.allSettled([
          _api?.swarmStats(),
          _api?.swarmLeaderboard(20),
          _api?.swarmFeedFree({ limit: 20 }),
          _api?.getSwarmAgentStats(),
        ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));
      } catch {}
      const identity = _loadIdentity();
      // Find this agent in leaderboard
      const myEntry = leaderboard?.leaderboard?.find?.(a =>
        a.agentId === identity.agentId || a.address === identity.address
      );
      res.end(JSON.stringify({
        stats,
        leaderboard: leaderboard?.leaderboard ?? [],
        feed: feed?.signals ?? [],
        myStats: agentStats?.[identity.agentId] ?? null,
        myRank:  myEntry ? (leaderboard?.leaderboard?.indexOf(myEntry) + 1) : null,
      }));
      return;
    }

    if (route === '/api/tasks') {
      let tasks = null;
      try {
        const identity = _loadIdentity();
        tasks = await _api?.taskList({ limit: 50, proposer: identity.address });
      } catch {}
      // Also get tasks claimed by this agent
      let claimed = null;
      try {
        claimed = await _api?.taskList({ limit: 50, status: 'claimed' });
      } catch {}
      res.end(JSON.stringify({
        myTasks: tasks?.tasks ?? [],
        claimed: claimed?.tasks ?? [],
        summary: tasks?.summary ?? claimed?.summary ?? null,
      }));
      return;
    }

    if (route === '/api/last-scan') {
      res.end(JSON.stringify(_readJson(LAST_SCAN_FILE, null)));
      return;
    }

    if (route === '/api/wallet') {
      const identity = _loadIdentity();
      let balances   = { sol: null, circuit: null };
      try { balances = await _wallet?.getBalances?.() ?? balances; } catch {}
      const ctx      = _readJson(CONTEXT_FILE, {});
      const solPrice = ctx.sol?.price ?? null;
      const solUsd   = (balances.sol != null && solPrice)
        ? +(balances.sol * solPrice).toFixed(2) : null;

      // Portfolio total: SOL value + open position values (priced in SOL → USD)
      let posValueSol = 0;
      let posValueUsd = null;
      try {
        const held = positions.getAll();
        const mints = Object.keys(held);
        if (mints.length && Object.keys(_priceCache).length) {
          posValueSol = mints.reduce((sum, mint) => {
            const p   = _priceCache[mint];
            const pos = held[mint];
            if (!p?.priceNative || !pos?.tokenAmount) return sum;
            const dec = pos.tokenDecimals ?? 6;
            const ui  = parseFloat(pos.tokenAmount) / Math.pow(10, dec);
            return sum + p.priceNative * ui;
          }, 0);
        }
        if (balances.sol != null && solPrice) {
          posValueUsd = +((balances.sol + posValueSol) * solPrice).toFixed(2);
        }
      } catch {}

      res.end(JSON.stringify({
        address:      identity.address ?? _wallet?.address ?? null,
        sol:          balances.sol,
        circ:         balances.circuit ?? null,
        solPrice,
        solUsd,
        posValueSol:  posValueSol > 0 ? +posValueSol.toFixed(5) : 0,
        portfolioUsd: posValueUsd,
        hasQr:        !!(QRCode && _wallet?.address),
      }));
      return;
    }

    if (route === '/api/wallet/qr') {
      const svg = await _walletQrSvg();
      if (!svg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Wallet not available or qrcode package missing' }));
      }
      // Override the application/json header set above — this is SVG
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      return res.end(svg);
    }

    if (route === '/api/config') {
      const { loadConfig } = require('./config');

      // GET — return only FIELD_SPEC sections (strategy, risk, llm, swarm, etc.)
      // Never return the full merged config — telegram tokens, RPC URLs, and other
      // non-editable sections should not be readable through the dashboard API.
      if (req.method === 'GET') {
        const full = loadConfig();
        const safe = {};
        for (const section of Object.keys(FIELD_SPEC)) {
          if (full[section] !== undefined) safe[section] = full[section];
        }
        res.end(JSON.stringify({ config: safe, fieldSpec: FIELD_SPEC, restartRequired: [...RESTART_REQUIRED] }));
        return;
      }

      // POST — write one field to agent.local.json (partial update)
      // Body: { section: string, key: string, value: any }
      if (req.method === 'POST') {
        const { section, key, value } = body;
        if (typeof section !== 'string' || typeof key !== 'string') {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'section and key must be strings' }));
        }
        const valErr = _validateConfigField(section, key, value);
        if (valErr) { res.writeHead(400); return res.end(JSON.stringify({ error: valErr })); }

        let local = {};
        try { local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8')); } catch {}
        if (!local[section]) local[section] = {};
        local[section][key] = value;

        // Atomic write — tmp + rename so a crash mid-write never corrupts the file
        const tmp = LOCAL_CONFIG_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(local, null, 2));
        fs.renameSync(tmp, LOCAL_CONFIG_FILE);

        const needsRestart = RESTART_REQUIRED.has(`${section}.${key}`);
        res.end(JSON.stringify({ ok: true, needsRestart, config: loadConfig() }));
        return;
      }

      // DELETE — remove one override key from agent.local.json (revert to base default)
      // Query params: ?section=<section>&key=<key>
      if (req.method === 'DELETE') {
        const section = url.searchParams.get('section');
        const key     = url.searchParams.get('key');
        if (!section || !key) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'section and key query params required' }));
        }
        if (!FIELD_SPEC[section]?.[key]) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: `"${section}.${key}" is not editable` }));
        }

        let local = {};
        try { local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8')); } catch {}
        if (local[section]) {
          delete local[section][key];
          if (!Object.keys(local[section]).length) delete local[section];
        }

        const tmp = LOCAL_CONFIG_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(local, null, 2));
        fs.renameSync(tmp, LOCAL_CONFIG_FILE);

        res.end(JSON.stringify({ ok: true, config: loadConfig() }));
        return;
      }

      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (route === '/api/chat' && req.method === 'POST') {
      const clientIp = req.socket?.remoteAddress ?? 'unknown';
      if (!_checkChatRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Rate limit exceeded — max ${CHAT_RATE_LIMIT} requests per minute` }));
        return;
      }
      const result = await _sendChat(body.message);
      res.end(JSON.stringify(result));
      return;
    }

    if (route === '/api/chat/history') {
      res.end(JSON.stringify({ history: _chatHistory }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

function start(cfg, agentCtx) {
  if (cfg.dashboard?.enabled === false) return;

  _cfg    = cfg;
  _api    = agentCtx?.api ?? null;
  _wallet = agentCtx?.wallet ?? null;

  const port = cfg.dashboard?.port ?? 18800;

  fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
  fs.mkdirSync(QUEUE_OUTGOING, { recursive: true });

  const server = http.createServer((req, res) => {
    _handleRequest(req, res).catch(err => {
      try { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); } catch {}
    });
  });

  // Bind to loopback only — never expose on 0.0.0.0.
  // Remote access requires an explicit SSH tunnel: ssh -L 18800:localhost:18800 user@host
  server.on('error', err => {
    const { log } = require('./processor');
    if (err.code === 'EADDRINUSE') {
      try { log?.('warn', `Dashboard port ${port} already in use — skipping (is another agent running?)`); } catch {}
      console.warn(`[DASHBOARD] port ${port} in use — dashboard disabled`);
    } else {
      try { log?.('warn', `Dashboard error: ${err.message}`); } catch {}
    }
    // Don't crash the agent — dashboard is non-critical
  });

  server.listen(port, '127.0.0.1', () => {
    const { log } = require('./processor');
    if (!cfg.dashboard?.apiKey) {
      try { log?.('warn', 'Dashboard has no apiKey set — anyone on this machine can access it'); } catch {}
    }
    try { log?.('info', `Dashboard running at http://localhost:${port}`); } catch {}
    console.log(`[DASHBOARD] http://localhost:${port}`);
  });

  // Poll outgoing queue for web channel responses every 500ms
  setInterval(_pollOutgoing, 500);

  // Emit position ticks to SSE every 15s
  setInterval(async () => {
    try {
      const held  = positions.getAll();
      const mints = Object.keys(held);
      if (!mints.length) return;
      const prices = await _fetchDexPrices(mints);
      _sseEmit('prices', prices);
    } catch {}
  }, 15000);

  return server;
}

module.exports = { start };

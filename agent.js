// agent.js — circuit-agent: LLM-powered Solana trading agent
// Powered by CIRCUIT Data API + OpenRouter + Telegram
//
// Architecture:
//   Telegram / Heartbeat → queue/incoming → LLM processor (tool-use) → queue/outgoing → Telegram
//
// Usage:
//   node agent.js init      — generate wallet, run setup wizard, register with swarm
//   node agent.js start     — start full agent (processor + Telegram + heartbeat)
//   node agent.js setup     — re-run setup wizard to update settings
//   node agent.js wallet    — show wallet balances
//   node agent.js status    — show open positions + P&L
//   node agent.js scan      — run one market scan and print candidates
//   node agent.js send "x"  — queue a manual message through the LLM
'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const fs   = require('fs');
const path = require('path');

// ── Load .env ─────────────────────────────────────────────────────────────────

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    // Strip inline comments before quote removal — otherwise `KEY=value # comment`
    // stores "value # comment" as the key, causing silent auth failures.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
// config/agent.json       — repo defaults (updated by git pull)
// config/agent.local.json — your overrides (gitignored, never touched by updates)
// Values in agent.local.json deep-merge over agent.json, so you only need to
// include the keys you want to change — not the entire config.

const { loadConfig } = require('./lib/config');
let cfg = loadConfig();

const RPC_URL      = process.env.CIRCUIT_RPC_URL     || 'https://api.mainnet-beta.solana.com';
const INTERNAL_KEY = process.env.CIRCUIT_INTERNAL_KEY || '';
const JUP_API_KEY  = process.env.JUPITER_API_KEY    || '';
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram?.token || '';
// CIRCUIT_API_URL env var overrides config (useful for self-hosted / localhost deployments).
// Validate before applying — an http:// non-localhost URL would redirect all CIRCUIT
// payments to an attacker's server, exposing tx signatures for replay.
if (process.env.CIRCUIT_API_URL) {
  const _override = process.env.CIRCUIT_API_URL;
  const _isHttps     = _override.startsWith('https://');
  const _isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(_override);
  if (_isHttps || _isLocalhost) {
    cfg.api.baseUrl = _override;
  } else {
    console.warn(`WARNING: CIRCUIT_API_URL="${_override}" rejected — must be https:// or http://localhost. Using config default.`);
  }
}

// ── Modules ───────────────────────────────────────────────────────────────────

const { CircuitClient }    = require('./lib/circuit');
const { loadWallet }       = require('./lib/wallet');
const { SwapExecutor }     = require('./lib/swap');
const { PaperSwapExecutor } = require('./lib/paper-swap');
const { PaperNftExecutor }  = require('./lib/paper-nft');
const { NftBuyExecutor }    = require('./lib/nft-buy');
const positions             = require('./lib/positions');
const nftPositions          = require('./lib/nft-positions');
const profile          = require('./lib/profile');
const lpOptimizer      = require('./lib/lp-optimizer');

// ── Version ───────────────────────────────────────────────────────────────────

const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
})();

// ── Logger ────────────────────────────────────────────────────────────────────

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [AGENT] [${level.toUpperCase()}] ${line}\n`);
};

// ── Shared runtime state ──────────────────────────────────────────────────────

let wallet = null;
let api    = null;
let swap   = null;
let nftSwap = null;

function initModules() {
  wallet = loadWallet(RPC_URL);
  api    = new CircuitClient({
    baseUrl:      cfg.api.baseUrl,
    priceFeedUrl: cfg.priceFeedUrl,          // optional override; else derived from baseUrl
    internalKey:  INTERNAL_KEY,
    wallet:       { keypair: wallet.keypair, connection: wallet.connection },
  });

  const paperMode = cfg.strategy?.paperTrading === true;
  if (paperMode) {
    swap = new PaperSwapExecutor({ initialSolBalance: cfg.strategy?.paperSolBalance ?? 1.0, baseUrl: cfg.api.baseUrl, feeSolPerSide: cfg.strategy?.paperFeeSolPerSide });
    log('info', '📝 PAPER TRADING MODE — no real trades will execute',
      { virtualSol: swap.virtualSolBalance, apiBase: cfg.api.baseUrl });
  } else {
    swap = new SwapExecutor({
      keypair:         wallet.keypair,
      connection:      wallet.connection,
      jupApiKey:       JUP_API_KEY,
      slippageBps:     cfg.strategy?.slippageBps ?? 100,
      priorityLevel:   cfg.swap?.priorityLevel   ?? 'high',
      jitoEnabled:     cfg.swap?.jitoEnabled     ?? true,
      jitoTipLamports: cfg.swap?.jitoTipLamports ?? 1_000_000,
      dynamicTip:      cfg.swap?.dynamicTip      ?? true,
      tipPct:          cfg.swap?.tipPct          ?? 0.02,
      tipMinLamports:  cfg.swap?.tipMinLamports  ?? 200_000,
      tipMaxLamports:  cfg.swap?.tipMaxLamports  ?? (cfg.swap?.jitoTipLamports ?? 1_000_000),
    });
    log('info', 'Agent initialized', { address: wallet.address.slice(0, 8) + '…', apiBase: cfg.api.baseUrl });
  }

  // NFT executor (Phase 2, self-custody). Paper by default. Setting nft.paperTrading:false switches to
  // the live Tensor buyLegacy executor (validated simulate-first: every buy is simulated before signing
  // and refused if the simulated SOL outflow exceeds the true cost). nft.liveDryRun:true is an extra
  // notch — the live executor then simulates every buy but never submits, so you can watch it run first.
  if (cfg.nft?.paperTrading === false) {
    nftSwap = new NftBuyExecutor({
      connection:            wallet.connection,
      keypair:               wallet.keypair,
      cfg,
      dryRun:                cfg.nft?.liveDryRun === true,
      priorityMicroLamports: cfg.nft?.priorityMicroLamports ?? 50_000,
    });
    log(cfg.nft?.liveDryRun ? 'warn' : 'warn',
      `🔴 NFT LIVE BUYING ENABLED${cfg.nft?.liveDryRun ? ' (dry-run: simulates, never submits)' : ' — real SOL will be spent'}`,
      { wallet: wallet.address.slice(0, 8) + '…' });
  } else {
    nftSwap = new PaperNftExecutor({ initialSolBalance: cfg.nft?.paperSolBalance ?? 1.0 });
  }
}

function makeCtx() {
  return { api, wallet, swap, positions, cfg, nftSwap, nftPositions };
}

// ── CLI: init — generate wallet + setup + register ────────────────────────────

async function cmdInit() {
  const { Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58').default ?? require('bs58');

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (content.includes('AGENT_KEYPAIR=') && !/AGENT_KEYPAIR=\s*$/.test(content)) {
      console.error('\nERROR: .env already contains AGENT_KEYPAIR.');
      console.error('Delete or back up .env before running init again.\n');
      process.exit(1);
    }
  }

  const kp      = Keypair.generate();
  const address = kp.publicKey.toBase58();
  const privB58 = bs58.encode(kp.secretKey);

  console.log('\n=== circuit-agent init ===\n');
  console.log(`New wallet: ${address}`);
  console.log('(setup wizard starting — your address will be shown again)\n');

  // Write a minimal .env immediately so the keypair is never lost
  // The setup wizard will overwrite this with the full config.
  const minimalEnv = [
    '# circuit-agent — generated by: node agent.js init',
    `AGENT_KEYPAIR=${privB58}`,
    `CIRCUIT_RPC_URL=`,
    `JUPITER_API_KEY=`,
    `CIRCUIT_INTERNAL_KEY=`,
    `TELEGRAM_BOT_TOKEN=`,
    `OPENROUTER_API_KEY=`,
  ].join('\n') + '\n';
  fs.writeFileSync(envPath, minimalEnv);

  // Run setup wizard (overwrites .env with full config)
  runWizard(privB58, address);

  // Save identity
  const identityFile = path.join(__dirname, 'data/agent-identity.json');
  fs.mkdirSync(path.dirname(identityFile), { recursive: true });

  // Register with swarm
  let agentId = null;
  try {
    const resp = await fetch(`${cfg.api.baseUrl}/api/agents/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address, version: PKG_VERSION, createdAt: new Date().toISOString() }),
      signal:  AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const d = await resp.json();
      agentId  = d.agentId;
      console.log(`\n✓ Registered with CIRCUIT swarm — agent ID: ${agentId}`);
    }
  } catch { console.log('  (registry unavailable — will register on first start)'); }

  const createdAt = new Date().toISOString();
  fs.writeFileSync(identityFile, JSON.stringify({ address, agentId, createdAt }, null, 2));

  // Bootstrap agent profile (data/agent-profile.json)
  const profileFile = path.join(__dirname, 'data/agent-profile.json');
  if (!fs.existsSync(profileFile)) {
    const initProfile = {
      version: 1,
      schema:  'circuit-agent-profile/v1',
      identity: {
        name:        'circuit-agent',
        handle:      '',
        role:        'autonomous-trader',
        description: 'LLM-powered Solana trading agent on the CIRCUIT network.',
        createdAt,
        deviceId:    agentId ?? address,
      },
      specialization: {
        domains:    ['solana-trading', 'market-analysis'],
        tools:      ['jupiter-ultra', 'jupiter-price-v3', 'rugcheck', 'helius-das'],
        skills:     ['dip-reversal', 'swarm-analyst'],
        strategies: ['dip-reversal', 'trailing-stop'],
      },
      maturity: {
        trustLevel:        'signal',
        autonomyLevel:     'moderate',
        sessionsCompleted: 0,
        daysOperational:   0,
        generationNotes:   '',
      },
      authority: {
        canTrade:              true,
        maxTradeSolPerEntry:   cfg.strategy?.entryBudgetSol ?? 0.005,
        maxConcurrentPositions: cfg.strategy?.maxOpenPositions ?? 3,
        canSendMessages:       true,
        canModifyOwnConfig:    true,
        canDelegate:           false,
        canCoordinate:         false,
      },
      swarm: {
        role:                 'primary',
        coordinatedBy:        null,
        peersKnown:           [],
        minReputationToFollow: cfg.swarm?.minReputationToFollow ?? 40,
        publishesSignals:     cfg.swarm?.autoPublish ?? true,
        readsSignals:         cfg.swarm?.enabled ?? true,
      },
      model: {
        primary:       cfg.llm?.model    ?? 'google/gemini-2.5-flash-lite',
        fallback:      null,
        contextWindow: null,
        thinkingMode:  'off',
      },
      performance: {
        trading: {
          closedPositions: 0, wins: 0, losses: 0,
          winRate: 0, avgPnlPct: 0, avgWinPct: 0, avgLossPct: 0, totalPnlPct: 0,
          firstTradeAt: null, lastTradeAt: null,
        },
        lastUpdated: null,
      },
      status: {
        current:      'active',
        healthFlags:  [],
        lastActiveAt: null,
        wallet:       address,
      },
    };
    fs.writeFileSync(profileFile, JSON.stringify(initProfile, null, 2));
    console.log('✓ Agent profile created (data/agent-profile.json)');
  }

  console.log('\n✓ Init complete.');
  console.log(`\nWallet: ${address}`);
  console.log('Back up your private key:   grep AGENT_KEYPAIR .env');
  console.log('\nFund with at least 0.05 SOL, then run:   node agent.js start\n');
}

// ── Setup wizard launcher (cross-platform) ────────────────────────────────────

function runWizard(keypair, address) {
  const { spawnSync } = require('child_process');
  const jsWizard = path.join(__dirname, 'setup-wizard.js');
  const shWizard = path.join(__dirname, 'setup-wizard.sh');

  // Prefer Node.js wizard (works on Windows/macOS/Linux)
  if (fs.existsSync(jsWizard)) {
    const args = [jsWizard];
    if (address) args.push('--address', address);
    // Pass keypair via env var rather than --keypair CLI arg.
    // CLI args are visible in /proc/<pid>/cmdline for the process lifetime,
    // exposing the base58 private key to any local user who reads /proc.
    // Environment variables are stored in /proc/<pid>/environ (mode 0400,
    // readable only by the process owner) — significantly narrower exposure.
    const wizardEnv = keypair
      ? { ...process.env, CIRCUIT_SETUP_KEYPAIR: keypair }
      : process.env;
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: wizardEnv });
    if (r.error || r.status !== 0) {
      console.error('\nSetup wizard did not complete cleanly.');
      if (keypair) {
        console.error('Your wallet keypair has been saved to .env — do not delete it.');
        console.error(`Wallet address: ${address}`);
      }
      console.error('\nRe-run "node agent.js setup" to finish configuration.\n');
    }
    return;
  }

  // Fallback: bash wizard (Linux/macOS only)
  if (process.platform !== 'win32' && fs.existsSync(shWizard)) {
    const args = [shWizard];
    if (keypair) args.push('--keypair', keypair, '--address', address);
    const r = spawnSync('bash', args, { stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      console.error('\nSetup wizard did not complete cleanly.');
      if (keypair) {
        console.error('Your wallet keypair has been saved to .env — do not delete it.');
        console.error(`Wallet address: ${address}`);
      }
      console.error('\nRe-run "node agent.js setup" to finish configuration.\n');
    }
    return;
  }

  console.error('\nNo setup wizard found. Edit .env manually to add your API keys.\n');
}

// ── CLI: setup — re-run wizard ────────────────────────────────────────────────

async function cmdSetup() {
  runWizard(null, null);
}

// ── CLI: wallet ───────────────────────────────────────────────────────────────

async function cmdWallet() {
  initModules();
  await wallet.logBalances();
  const { warnings } = await wallet.checkMinimums(cfg);
  if (warnings.length) { console.log('\nWarnings:'); warnings.forEach(w => console.log(' ⚠', w)); }
}

// ── CLI: status ───────────────────────────────────────────────────────────────

async function cmdStatus() {
  initModules();
  const held = positions.getAll();
  const keys = Object.keys(held);
  if (!keys.length) { console.log('No open positions.'); return; }
  console.log(`\nOpen positions (${keys.length}):\n`);
  for (const [mint, pos] of Object.entries(held)) {
    const mins = positions.holdMinutes(pos).toFixed(0);
    console.log(`  ${pos.symbol.padEnd(10)} ${mint.slice(0,8)}…  held ${mins}min  entry ${pos.solSpent.toFixed(4)} SOL  peak +${pos.peakPnlPct.toFixed(1)}%`);
  }
}

// ── CLI: scan ─────────────────────────────────────────────────────────────────

async function cmdScan() {
  initModules();
  log('info', 'Scanning…');
  const result = await api.scan({ limit: 20, minLiquidity: cfg.strategy?.minLiquidity ?? 10000 });
  const cands  = (result.candidates ?? []).slice(0, 5);
  if (!cands.length) { console.log('No candidates.'); return; }
  console.log(`\nTop ${cands.length} candidates:\n`);
  for (const c of cands) {
    console.log(`  ${(c.symbol ?? '?').padEnd(10)} ${c.mint.slice(0,8)}… | 1h: ${(c.priceChange1h ?? 0).toFixed(1)}% | liq: $${((c.liquidity ?? 0)/1000).toFixed(0)}k | ${c.verdict ?? c.rugRisk}`);
  }
}

// ── CLI: send — queue a manual message ───────────────────────────────────────

function cmdSend(message) {
  if (!message) { console.error('Usage: node agent.js send "your message"'); process.exit(1); }
  const { enqueue } = require('./lib/processor');
  enqueue('cli', 'User', 'cli', message);
  console.log(`Queued: "${message}"\nCheck logs/processor.log for response.`);
}

// ── Main: start — full agent launch ──────────────────────────────────────────

async function cmdStart() {
  // ── Single-instance guard ──────────────────────────────────────────────────
  const PID_FILE = path.join(__dirname, 'data/agent.pid');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      // Under PM2, the manager kills the old process and spawns the new one nearly
      // simultaneously. The old process may still be running its SIGTERM handler
      // when we check, causing spurious "already running" errors and PM2 restart loops.
      // Wait up to 3s for the old process to exit before giving up.
      let alive = true;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          process.kill(existingPid, 0); // throws ESRCH if process is gone
          await new Promise(r => setTimeout(r, 500));
        } catch {
          alive = false;
          break;
        }
      }
      if (alive) {
        console.error(`ERROR: Agent is already running (PID ${existingPid}). Stop it first or delete data/agent.pid.`);
        process.exit(1);
      }
      // Process is gone — stale PID file, proceed
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const removePid = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
  process.on('exit', removePid);
  // ─────────────────────────────────────────────────────────────────────────

  initModules();

  // Sync wallet address with agent identity (in case private key was changed)
  const identityFile = path.join(__dirname, 'data/agent-identity.json');
  try {
    const walletAddr = wallet.address;
    const identityData = fs.existsSync(identityFile) ? JSON.parse(fs.readFileSync(identityFile, 'utf8')) : null;
    if (identityData && identityData.address && identityData.address !== walletAddr) {
      log('warn', `Wallet address mismatch — private key was changed. Updating identity from ${identityData.address.slice(0,8)}… to ${walletAddr.slice(0,8)}…`);
      identityData.address = walletAddr;
      fs.writeFileSync(identityFile, JSON.stringify(identityData, null, 2));
    }
  } catch (e) {
    log('warn', `Identity sync failed: ${e.message}`);
  }

  log('info', `=== circuit-agent v${PKG_VERSION} starting ===`);
  try {
    await wallet.logBalances();
    const { warnings } = await wallet.checkMinimums(cfg);
    warnings.forEach(w => log('warn', w));
  } catch (e) {
    log('warn', `Startup balance check failed (will retry later): ${e.message}`);
  }

  // 1. Fetch startup context (market snapshot, trade summary, swarm stats)
  const agentCtxModule = require('./lib/context');
  try {
    await agentCtxModule.refresh(api);
  } catch (e) {
    log('warn', `Startup context failed: ${e.message}`);
  }
  // Refresh market context every 30 min in background (keeps heartbeat status current)
  const CTX_REFRESH_MS = (cfg.heartbeat?.contextRefreshMs ?? 30 * 60_000);
  setInterval(() => {
    agentCtxModule.refresh(api).catch(e => log('warn', `Context refresh failed: ${e.message}`));
  }, CTX_REFRESH_MS);

  // 2. Publish profile to swarm (non-blocking)
  profile.refreshAndPublish(api, { paperMode: swap?.paperMode ?? false })
    .catch(e => log('warn', `Profile publish: ${e.message}`));

  // 3. Queue processor (AI brain — must start first)
  const processor = require('./lib/processor');
  processor.start(makeCtx());

  // 4. Telegram channel
  let telegramBot = null;
  if (TG_TOKEN) {
    const telegram = require('./lib/telegram');
    telegramBot    = telegram.start(TG_TOKEN, makeCtx());
    log('info', 'Telegram channel enabled');
  } else {
    log('info', 'Telegram disabled — add TELEGRAM_BOT_TOKEN to .env or run: node agent.js setup');
  }

  // 5. Local dashboard
  const dashboard = require('./lib/dashboard');
  const dashServer = dashboard.start(cfg, makeCtx());
  if (dashServer) {
    const dashPort = cfg.dashboard?.port ?? 18800;
    log('info', `Dashboard at http://localhost:${dashPort}`);
  }

  // 6. Heartbeat
  const heartbeat = require('./lib/heartbeat');
  heartbeat.start(cfg, makeCtx(), telegramBot);

  // 6. Reflect loop (self-improvement + survival monitoring)
  const reflect = require('./lib/reflect');
  reflect.start(cfg, makeCtx(), telegramBot);

  // 7. Autonomous position monitor (deterministic — no LLM)
  const monitor = require('./lib/monitor');
  monitor.start(cfg, makeCtx(), telegramBot);

  // 8. Market scanner. Smart-money mode (agent2 experiment) runs the follow-the-money scanner
  //    instead of the price-pattern auto-scanner; both reuse positions/swap/monitor for exits.
  if (cfg.strategy?.scorer === 'smartmoney') {
    require('./lib/smart-money-scanner').start(cfg, makeCtx(), telegramBot);
  } else {
    const autoScanner = require('./lib/auto-scanner');
    autoScanner.start(cfg, makeCtx(), telegramBot);
  }

  // Copilot watches — user-defined price/wallet alerts (deterministic, free endpoints)
  require('./lib/watches').start(cfg, makeCtx(), telegramBot);

  // NFT floor accumulator (Phase 2, self-custody; paper by default). No-ops until nft.watch is set.
  require('./lib/nft-accumulator').start(cfg, makeCtx(), telegramBot);

  // Daily brief — once-per-day Telegram digest
  if (telegramBot) {
    const dailyBrief = require('./lib/daily-brief');
    setInterval(() => dailyBrief.sendBrief(telegramBot, cfg), 60_000);  // check every minute
  }

  // 9. Agent loop — periodic LLM strategy reasoning (sets session_strategy.json)
  const agentLoop = require('./lib/agent-loop');
  agentLoop.start(cfg, makeCtx());

  // 10. LP Optimizer — independent 1h loop managing Solana LP positions
  if (cfg.strategy?.lpOptimizeEnabled) {
    lpOptimizer.start(cfg, makeCtx(), telegramBot);
  }

  log('info', 'Agent running', {
    address:    wallet.address.slice(0, 8) + '…',
    telegram:   TG_TOKEN ? 'on' : 'off',
    dashboard:  `http://localhost:${cfg.dashboard?.port ?? 18800}`,
    heartbeat:  `${(cfg.heartbeat?.intervalMs ?? 300_000) / 60_000}min`,
    monitor:    `${(cfg.strategy?.positionCheckMs ?? 10_000) / 1000}s`,
    scanner:    `${(cfg.strategy?.scanIntervalMs ?? 300_000) / 60_000}min`,
    agentLoop:  `${(cfg.agentLoop?.intervalMs ?? 90 * 60_000) / 60_000}min`,
    model:      cfg.llm?.model ?? '(not set)',
  });

  process.on('SIGINT',  () => { log('info', 'Shutdown'); removePid(); process.exit(0); });
  process.on('SIGTERM', () => { log('info', 'Shutdown'); removePid(); process.exit(0); });
}

// ── CLI: logs — recent agent activity in human-readable form ──────────────────

function cmdLogs() {
  const LOG_FILE = path.join(__dirname, 'logs/processor.log');
  const N        = parseInt(process.argv[3]) || 40;

  if (!fs.existsSync(LOG_FILE)) {
    console.log('No log file yet. Start the agent first: node agent.js start');
    return;
  }

  // Read tail of log file (last ~200KB is plenty)
  const stat = fs.statSync(LOG_FILE);
  const readSize = Math.min(stat.size, 200 * 1024);
  const buf  = Buffer.alloc(readSize);
  const fd   = fs.openSync(LOG_FILE, 'r');
  fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);

  // Rules: match log line → human-readable label
  // Handler-generated lines are more specific (e.g. "buy_token ABC 0.005 SOL")
  // Processor generic lines have raw JSON — we skip those to avoid duplicates
  const RULES = [
    // Trade executions (handler-level lines, not the generic processor tool log)
    { re: /Tool: buy_token\s+(\S+)\s+([\d.]+) SOL/,   fmt: (m) => `BUY    ${m[1]}  ${m[2]} SOL` },
    { re: /Tool: sell_token\s+(\S+)\s+(\d+)%/,         fmt: (m) => `SELL   ${m[1]}  ${m[2]}% of position` },
    { re: /Tool: send_token\s+([\d.,]+)\s+→\s+(\S+)/,  fmt: (m) => `SEND   ${m[1]} tokens → ${m[2]}` },
    // Scanner
    { re: /Scan returned (\d+) candidate/,              fmt: (m) => `SCAN   ${m[1]} candidates found` },
    { re: /(\d+) candidates after filters/,             fmt: (m) => `SCAN   ${m[1]} passed filters` },
    { re: /No candidates passed/,                       fmt: ()  => `SCAN   no candidates passed gates` },
    // Reflect
    { re: /Done \[reflect\]/,                           fmt: ()  => `REFLECT  cycle complete` },
    // Heartbeat exceptions
    { re: /Status built — (\d+) exception/,             fmt: (m) => `HEARTBEAT  ${m[1]} exception(s)` },
    // Startup / shutdown
    { re: /=== circuit-agent v([\d.]+) starting ===/,     fmt: (m) => `STARTED  v${m[1]}` },
    { re: /\[AGENT\].*Shutdown/,                        fmt: ()  => `STOPPED` },
    // Telegram messages received
    { re: /\[TG\].*Message from (.+?):/,                fmt: (m) => `MSG    from ${m[1]}` },
    // Trading paused/resumed
    { re: /Trading paused/,                             fmt: ()  => `PAUSED   new buys paused` },
    { re: /Trading resumed/,                            fmt: ()  => `RESUMED  auto-scanner re-enabled` },
  ];

  const events = [];
  for (const line of lines) {
    const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (!tsMatch) continue;
    const ts      = new Date(tsMatch[1]);
    const timeStr = ts.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) { events.push(`${timeStr}  ${rule.fmt(m)}`); break; }
    }
  }

  const recent = events.slice(-N);
  if (!recent.length) { console.log('No activity recorded yet.'); return; }

  console.log(`\nAgent activity — last ${recent.length} events:\n`);
  recent.forEach(e => console.log(' ', e));
  console.log();
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const cmd     = process.argv[2];
const sendMsg = process.argv.slice(3).join(' ');

const handlers = {
  init:   cmdInit,
  setup:  cmdSetup,
  start:  cmdStart,
  wallet: cmdWallet,
  status: cmdStatus,
  scan:   cmdScan,
  send:   async () => cmdSend(sendMsg),
  logs:   async () => cmdLogs(),
  memory: async () => cmdMemory(),
};

// memory verify [--json] [--repair] — integrity + cross-store consistency check on the memory
// stores (docs/MEMORY.md). Read-only by default; --repair applies only the safe, deterministic
// fixes. Flag-independent — works even with memory.enabled:false, so stores can be vetted first.
// Exits non-zero when unresolved drift remains, so a cron/supervisor can act on it.
async function cmdMemory() {
  const sub   = process.argv[3];
  const flags = process.argv.slice(4);
  if (sub !== 'verify') {
    console.log('Usage: node agent.js memory verify [--json] [--repair]');
    process.exit(sub ? 1 : 0);
  }
  const v = require('./lib/memory/verify');
  const before = v.verify();

  if (flags.includes('--repair')) {
    const result = v.repair(before);
    const after  = v.verify();
    if (flags.includes('--json')) console.log(JSON.stringify({ before, repair: result, after }, null, 2));
    else { console.log(v.formatReport(before)); console.log(v.formatRepair(result)); console.log('\nAfter repair:'); console.log(v.formatReport(after)); }
    process.exit(after.ok ? 0 : 1);
  }

  if (flags.includes('--json')) console.log(JSON.stringify(before, null, 2));
  else console.log(v.formatReport(before));
  process.exit(before.ok ? 0 : 1);
}

(handlers[cmd] ?? cmdStart)().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

// lib/tools/swarm.js — swarm intelligence and task board tool definitions and handlers
'use strict';

const { loadIdentity } = require('../profile');

const DEFINITIONS = [
  // ── Swarm intelligence tools ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_swarm_feed',
      description: 'Read recent buy/sell/rug signals from the circuit-agent swarm. See what other agents are trading right now. Filter by type or token.',
      parameters: {
        type: 'object',
        properties: {
          limit:         { type: 'number',  description: 'Max signals to return (default 20)' },
          type:          { type: 'string',  description: 'Filter by signal type: buy_signal, sell_signal, rug_alert, momentum, insight' },
          mint:          { type: 'string',  description: 'Filter by specific token mint address' },
          minReputation: { type: 'number',  description: 'Only show signals from agents with reputation >= this (0–100, default 0)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_swarm_consensus',
      description: "Get the swarm's aggregated view on a specific token. Returns bullish/bearish/rug_alert consensus with confidence and signal breakdown. Use before buying to check if other agents agree.",
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to check consensus for' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'publish_signal',
      description: 'Publish a signal to the swarm network — share your market observation with all other agents. Use after spotting something significant: strong momentum, rug risk, or a trading insight.',
      parameters: {
        type: 'object',
        properties: {
          type:       { type: 'string', enum: ['buy_signal', 'sell_signal', 'rug_alert', 'momentum', 'insight', 'strategy_stats', 'market_regime', 'watching', 'scan_quality'], description: 'Signal type. strategy_stats: broadcast your pattern win rates (use data.patterns + data.configHints). market_regime: your read on current market (use data.regime + data.solChange24h). watching: token you are monitoring but have not bought. scan_quality: scanner opportunity assessment.' },
          mint:       { type: 'string', description: 'Token mint (required for buy_signal, sell_signal, rug_alert)' },
          symbol:     { type: 'string', description: 'Token symbol' },
          confidence: { type: 'number', description: 'Signal confidence 0.0–1.0 (default 0.7)' },
          note:       { type: 'string', description: 'Short explanation of the signal' },
          data:       { type: 'object', description: 'Additional structured data (e.g. { pnlPct: 12.5, patterns: {...} })' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_insight',
      description: 'Share a market insight or trading lesson with the swarm. Use after reflect cycles to contribute to collective intelligence. Be specific (e.g. "tokens with 1h drop > 12% and < 2 swarm buy signals tend to keep falling for 20+ min").',
      parameters: {
        type: 'object',
        properties: {
          insight:    { type: 'string', description: 'The insight or lesson to share (be specific and actionable)' },
          confidence: { type: 'number', description: 'Your confidence in this insight 0.0–1.0 (default 0.6)' },
        },
        required: ['insight'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_swarm_strategies',
      description: 'Get aggregated strategy stats from the swarm — which patterns are winning across all agents. Use to calibrate your own approach against the collective.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_swarm_insights',
      description: 'Read shared trading insights contributed by agents during their reflect cycles — collective lessons about patterns, market regimes, and what is working across the swarm. Use during reflect to avoid repeating lessons the swarm has already learned.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max insights to return (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swarm_leaderboard',
      description: 'Get the top agents in the swarm ranked by reputation/signal accuracy.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of agents to return (default 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_reputation',
      description: 'Check your own swarm reputation score, signal history, and trust level. Use to understand your standing in the swarm.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Swarm blacklist + watching tools ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_swarm_blacklist',
      description: 'Get the permanent swarm blacklist of confirmed rugged/scam mints. These are mints that multiple agents have independently flagged. Check this before buying any token. Filter by symbol name with search param.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional: filter by symbol or mint prefix' },
          limit:  { type: 'number', description: 'Max entries to return (default 200)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_blacklist',
      description: 'Fast single-mint blacklist check. Returns whether a specific mint is in the swarm blacklist and vote count. Use before every buy.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to check' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'blacklist_token',
      description: 'Add a token mint to the permanent swarm blacklist. Use when you have confirmed a rug — LP pulled, mint authority used to print tokens, known scammer wallet, etc. Other agents will see this and avoid the mint forever.',
      parameters: {
        type: 'object',
        properties: {
          mint:   { type: 'string', description: 'Token mint address to blacklist' },
          symbol: { type: 'string', description: 'Token symbol (optional but helpful)' },
          reason: { type: 'string', description: 'Why this mint is blacklisted (min 10 chars — be specific: "LP pulled at 2pm UTC", "mint authority printed 10x supply")' },
        },
        required: ['mint', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watch_token',
      description: 'Publish a watching signal to the swarm — signal pre-buy interest in a token without committing. Other agents seeing multiple watches on the same token will treat it as early social consensus. Signal expires in 30min.',
      parameters: {
        type: 'object',
        properties: {
          mint:   { type: 'string', description: 'Token mint address you are watching' },
          symbol: { type: 'string', description: 'Token symbol' },
          score:  { type: 'number', description: 'Your current score for this token (0-100)' },
          note:   { type: 'string', description: 'Why you are watching it' },
        },
        required: ['mint'],
      },
    },
  },
  // ── Swarm task tools ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Browse the swarm task board — see what work other agents have proposed. Filter by status (open/claimed/submitted/verified) or type (build/research/analyze/skill/trade). Use to find tasks worth claiming.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'claimed', 'submitted', 'verified', 'all'], description: 'Task status filter (default: open)' },
          type:   { type: 'string', enum: ['build', 'research', 'analyze', 'skill', 'trade', 'other'], description: 'Task type filter (optional)' },
          limit:  { type: 'number', description: 'Max results (default 20, max 100)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_task',
      description: 'Propose a new task on the swarm task board. If reward > 0, automatically deposits the CIRCUIT to escrow — the winner receives it automatically on verification. Use when you identify something valuable worth building.',
      parameters: {
        type: 'object',
        properties: {
          type:        { type: 'string', enum: ['build', 'research', 'analyze', 'skill', 'trade', 'other'], description: 'Task type' },
          title:       { type: 'string', description: 'Short task title (5–120 chars)' },
          description: { type: 'string', description: 'Full task description with success criteria (20–2000 chars)' },
          reward:      { type: 'number', description: 'CIRCUIT reward amount (integer, e.g. 50000)' },
          deadline:    { type: 'string', description: 'Optional deadline as ISO timestamp' },
        },
        required: ['type', 'title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_task',
      description: 'Claim an open task from the task board. Default deadline is 7 days (or whatever the proposer set). Claims expire if you do not submit — task reverts to open. Only one agent can hold a claim at a time.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The taskId from list_tasks' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_task',
      description: 'Submit your completed work for a task you claimed. Include the actual deliverable (code, analysis, findings) in work — max 50KB inline, link externally for larger artifacts. The proposer calling verify_task(approved=true) automatically releases escrowed CIRCUIT to your wallet.',
      parameters: {
        type: 'object',
        properties: {
          taskId:  { type: 'string', description: 'The taskId you claimed' },
          work:    { type: 'string', description: 'The actual deliverable: code, analysis, data, or findings' },
          summary: { type: 'string', description: 'Brief summary of what you did and what was found (min 10 chars)' },
        },
        required: ['taskId', 'work', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_task',
      description: 'Verify (approve or reject) a submitted task. Proposer approval alone releases escrow. Two independent approvals also release. Called after reviewing submitted work quality.',
      parameters: {
        type: 'object',
        properties: {
          taskId:       { type: 'string',  description: 'The taskId to verify' },
          approved:     { type: 'boolean', description: 'true = approve and release reward, false = reject' },
          submissionId: { type: 'string',  description: 'Specific submission ID (defaults to latest)' },
          comment:      { type: 'string',  description: 'Reason for approval or rejection (optional)' },
        },
        required: ['taskId', 'approved'],
      },
    },
  },
];

const HANDLERS = {
  async read_swarm_feed(args, ctx, _log) {
    const feed = await ctx.api.swarmFeed({
      limit:         args.limit         ?? 20,
      type:          args.type          ?? undefined,
      mint:          args.mint          ?? undefined,
      minReputation: args.minReputation ?? 0,
    });
    return JSON.stringify(feed ?? { error: 'Swarm feed unavailable' });
  },

  async get_swarm_consensus(args, ctx, _log) {
    if (!args.mint) return JSON.stringify({ error: 'mint required' });
    const consensus = await ctx.api.swarmConsensus(args.mint);
    return JSON.stringify(consensus ?? { error: 'Consensus unavailable' });
  },

  async publish_signal(args, ctx, log) {
    const { type: sigType, mint: sigMint, symbol: sigSymbol, confidence: sigConf = 0.7, note, data: sigData } = args;
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'Agent not initialized — run: node agent.js init' });

    const result = await ctx.api.swarmPublish({
      agentId,
      address,
      type:       sigType,
      mint:       sigMint    ?? undefined,
      symbol:     sigSymbol  ?? undefined,
      confidence: sigConf,
      data:       { note: note ?? '', ...(sigData ?? {}) },
    });
    log('info', `Swarm signal published: ${sigType}`, { mint: sigMint?.slice(0, 8) });
    return JSON.stringify(result);
  },

  async share_insight(args, ctx, log) {
    const { insight, confidence: insConf = 0.6 } = args;
    if (!insight) return JSON.stringify({ error: 'insight text required' });
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'Agent not initialized — run: node agent.js init' });

    const result = await ctx.api.swarmPublish({
      agentId,
      address,
      type:       'insight',
      confidence: insConf,
      data:       { insight },
    });
    log('info', 'Swarm insight shared');
    return JSON.stringify(result);
  },

  async get_swarm_strategies(args, ctx, _log) {
    const resp = await ctx.api._fetch('/api/swarm/strategies');
    if (!resp.ok) return JSON.stringify({ error: `strategies ${resp.status}` });
    return JSON.stringify(await resp.json());
  },

  async get_swarm_insights(args, ctx, _log) {
    const data = await ctx.api.swarmInsights(args.limit ?? 20);
    return JSON.stringify(data ?? { error: 'Swarm insights unavailable' });
  },

  async swarm_leaderboard(args, ctx, _log) {
    const board = await ctx.api.swarmLeaderboard(args.limit ?? 10);
    return JSON.stringify(board ?? { error: 'Leaderboard unavailable' });
  },

  async get_my_reputation(_args, ctx, _log) {
    const identity = loadIdentity();
    if (!identity.agentId && !identity.address) return JSON.stringify({ error: 'Agent not initialized — run: node agent.js init' });

    try {
      const resp = await ctx.api._fetch(`/api/agents/${identity.address}`);
      if (resp.ok) {
        const agent = await resp.json();
        return JSON.stringify({
          agentId:      identity.agentId,
          address:      identity.address,
          reputation:   agent.reputation ?? { score: 50, signals: 0, wins: 0 },
          signalCount:  agent.signalCount ?? 0,
          registeredAt: agent.registeredAt,
          lastSeenAt:   agent.lastSeenAt,
        });
      }
    } catch { /* fall through */ }

    return JSON.stringify({ agentId: identity.agentId, address: identity.address, reputation: { score: 50, signals: 0 }, note: 'Registry unreachable' });
  },

  async get_swarm_blacklist(args, ctx, _log) {
    const res = await ctx.api.blacklistGet({ search: args.search, limit: args.limit ?? 200 });
    return JSON.stringify(res ?? { error: 'Blacklist unavailable' });
  },

  async check_blacklist(args, ctx, _log) {
    if (!args.mint) return JSON.stringify({ error: 'mint required' });
    const res = await ctx.api.blacklistCheck(args.mint);
    return JSON.stringify(res ?? { error: 'Check unavailable' });
  },

  async blacklist_token(args, ctx, log) {
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'No agent identity — register first' });
    const res = await ctx.api.blacklistAdd(agentId, address, args.mint, args.symbol, args.reason);
    log('info', `Blacklisted ${args.symbol ?? args.mint?.slice(0, 8)}: ${args.reason?.slice(0, 60)}`);
    return JSON.stringify(res ?? { error: 'Failed to add to blacklist' });
  },

  async watch_token(args, ctx, log) {
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'No agent identity' });
    const res = await ctx.api.swarmPublish({
      agentId,
      address,
      type:       'watching',
      mint:       args.mint,
      symbol:     args.symbol,
      confidence: 0.6,
      ttlSeconds: 1800,
      data:       { note: args.note ?? '', score: args.score ?? 0 },
    });
    log('info', `Watching signal: ${args.symbol ?? args.mint?.slice(0, 8)}`);
    return JSON.stringify(res ?? { error: 'Failed to publish watching signal' });
  },

  async list_tasks(args, ctx, _log) {
    const res = await ctx.api.taskList({ status: args.status, type: args.type, limit: args.limit });
    return JSON.stringify(res ?? { error: 'Task board unavailable' });
  },

  async propose_task(args, ctx, _log) {
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'No agent identity found. Register with /api/agents/register first.' });
    const res = await ctx.api.taskPropose(agentId, address, {
      type: args.type, title: args.title, description: args.description,
      reward: args.reward, deadline: args.deadline,
    });
    return JSON.stringify(res ?? { error: 'Failed: propose_task' });
  },

  async claim_task(args, ctx, _log) {
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'No agent identity found.' });
    const res = await ctx.api.taskClaim(agentId, address, args.taskId);
    return JSON.stringify(res ?? { error: 'Failed: claim_task' });
  },

  async submit_task(args, ctx, _log) {
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'No agent identity found.' });
    const res = await ctx.api.taskSubmit(agentId, address, args.taskId, args.work, args.summary);
    return JSON.stringify(res ?? { error: 'Failed: submit_task' });
  },

  async verify_task(args, ctx, _log) {
    const { agentId, address } = loadIdentity();
    if (!agentId && !address) return JSON.stringify({ error: 'No agent identity found.' });
    const res = await ctx.api.taskVerify(agentId, address, args.taskId, args.approved, args.submissionId ?? null, args.comment ?? '');
    return JSON.stringify(res ?? { error: 'Failed: verify_task' });
  },
};

module.exports = { DEFINITIONS, HANDLERS };

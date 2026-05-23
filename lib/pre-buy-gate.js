// lib/pre-buy-gate.js — lightweight LLM approve/reject gate for buy candidates
//
// Only called when session mode is "selective". Sends candidate data + session
// context to the LLM and parses approve/reject from a plain text response.
//
// Design goals:
//   - No tool loop — plain text response only (cheap, fast, ~1-2s)
//   - Hard timeout: 20s. On timeout, approve to avoid missed opportunities.
//   - Falls back to approved=true if LLM is unavailable or errors out.
//   - Decision is logged so the agent can learn from patterns over time.
'use strict';

const fs   = require('fs');
const path = require('path');

const CONTEXT_FILE   = path.join(__dirname, '../data/session-context.json');
const { loadConfig } = require('./config');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [GATE] [${level.toUpperCase()}] ${line}\n`);
};

const loadSettings = loadConfig;

function loadContext() {
  try {
    if (fs.existsSync(CONTEXT_FILE)) return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

// ── Build a compact candidate brief ──────────────────────────────────────────

function buildCandidateBrief(candidate, strategy, openPositions) {
  const { symbol, mint, _score, _pattern, _breakdown, priceChange1h, priceChange5m, liquidity, verdict, rugRisk } = candidate;
  const name    = symbol ?? mint?.slice(0, 8) ?? 'unknown';
  const rug     = verdict ?? rugRisk ?? 'unknown';
  const liqK    = ((liquidity ?? 0) / 1000).toFixed(0);
  const change1h = (priceChange1h ?? 0).toFixed(1);
  const change5m = (priceChange5m ?? 0).toFixed(1);

  const ctx = loadContext();
  const fg  = ctx?.fearGreed ? `F&G ${ctx.fearGreed.value} (${ctx.fearGreed.label ?? ''})` : 'F&G unknown';
  const solPrice = ctx?.sol ? `SOL $${ctx.sol.price}` : '';

  const lines = [
    `Candidate: ${name}`,
    `Score: ${_score}/100 | Pattern: ${_pattern}`,
    `1h: ${change1h}% | 5m: ${change5m}% | Liquidity: $${liqK}k | Rug: ${rug}`,
    `Market: ${fg}${solPrice ? ' | ' + solPrice : ''}`,
    `Open positions: ${openPositions}/3`,
    `Session mode: ${strategy.mode} | Goal: ${strategy.sessionGoal}`,
  ];

  if (_breakdown) {
    const bd = Object.entries(_breakdown)
      .map(([k, v]) => `${k}:${typeof v === 'number' ? v.toFixed(1) : v}`)
      .join(' ');
    lines.push(`Breakdown: ${bd}`);
  }

  return lines.join('\n');
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function check(candidate, strategy, openPositions) {
  const settings = loadSettings();
  const { model, provider, openrouterKey, baseUrl } = settings.llm ?? {};
  const apiKey   = openrouterKey || process.env.OPENROUTER_API_KEY || '';
  const isOllama = provider === 'ollama' || (baseUrl && (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')));

  if (!apiKey && !isOllama) {
    log('info', 'No LLM key — gate bypassed (approved)');
    return { approved: true, reasoning: 'LLM unavailable — auto-approved' };
  }

  const brief = buildCandidateBrief(candidate, strategy, openPositions);

  const systemPrompt =
    'You are the trade approval gate for an autonomous Solana trading agent. ' +
    'You receive a single candidate token and must decide: approve or reject. ' +
    'Reply with APPROVE or REJECT on the first line, then one sentence of reasoning. ' +
    'Be decisive. Do not hedge.';

  const userPrompt =
    `${brief}\n\nApprove or reject this buy?`;

  const resolvedUrl = baseUrl || (isOllama ? 'http://localhost:11434/v1' : 'https://openrouter.ai/api/v1');
  const OpenAI = require('openai');
  const client = new OpenAI.default({ baseURL: resolvedUrl, apiKey: apiKey || 'ollama' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const completion = await client.chat.completions.create({
      model:      model ?? 'x-ai/grok-4.1-fast',
      messages:   [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 80,
    }, { signal: controller.signal });

    const text = completion.choices?.[0]?.message?.content?.trim() ?? '';
    const approved = /^approve/i.test(text);
    const reasoning = text.split('\n').slice(1).join(' ').trim() || text;

    log('info', `Gate decision: ${approved ? 'APPROVED' : 'REJECTED'}`, {
      symbol:    candidate.symbol ?? candidate.mint?.slice(0, 8),
      score:     candidate._score,
      pattern:   candidate._pattern,
      reasoning: reasoning.slice(0, 120),
    });

    return { approved, reasoning };
  } catch (err) {
    // On timeout or error, approve to avoid missing opportunities
    log('warn', `Gate error — auto-approving`, {
      symbol: candidate.symbol ?? candidate.mint?.slice(0, 8),
      score:  candidate._score,
      error:  err.message,
    });
    return { approved: true, reasoning: `Gate error: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { check };

// lib/task-worker.js — fully deterministic task claim → work → submit loop
//
// Called from the agent loop every 90 min. One task per cycle — no LLM needed
// for claiming or prioritization, only for generating the deliverable.
//
// Full loop each cycle:
//   1. Fetch this agent's claimed tasks
//   2. Auto-claim: if nothing claimed, browse open tasks and claim the best one
//      Priority: highest reward first (self-funding), then nearest deadline, then oldest
//      Skips tasks this agent previously abandoned (recorded in claimHistory)
//   3. Work on the claimed task — gather context, call LLM once, parse response
//   4. Skip → call abandon API (releases claim for another agent), clear local state
//   5. Submit deliverable — remove from state on success
//
// Design:
//   - Max 3 LLM attempts per task, tracked in data/task-worker-state.json
//   - Context pre-fetched based on task type before the LLM call
//   - No tool use — single prompt → structured SUMMARY:/WORK: output
//   - Never throws — all errors are caught and logged
'use strict';

const fs   = require('fs');
const path = require('path');

const { loadIdentity }  = require('./profile');
const subtaskManager    = require('./subtask-manager');

const DATA_DIR        = path.join(__dirname, '../data');
const STATE_FILE      = path.join(DATA_DIR, 'task-worker-state.json');
const TRADE_HIST_FILE = path.join(DATA_DIR, 'trade_history.json');

const MAX_ATTEMPTS  = 3;
const MAX_WORK_BYTES = 45_000; // under the 50KB API limit

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [TASK-WORKER] [${level.toUpperCase()}] ${line}\n`);
};

// ── State management ──────────────────────────────────────────────────────────

function _loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { attempts: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return { attempts: {} }; }
}

function _saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function _recordAttempt(state, taskId, { skipped = false, skipReason = null } = {}) {
  const prev = state.attempts[taskId] ?? { count: 0 };
  state.attempts[taskId] = {
    count:         prev.count + 1,
    lastAttemptAt: new Date().toISOString(),
    skipped,
    skipReason,
  };
  _saveState(state);
}

// Prune state entries for tasks that no longer appear claimed (completed or expired)
function _pruneState(state, claimedTaskIds) {
  const set = new Set(claimedTaskIds);
  let changed = false;
  for (const id of Object.keys(state.attempts)) {
    if (!set.has(id)) { delete state.attempts[id]; changed = true; }
  }
  if (changed) _saveState(state);
}

// ── LLM call — no tool use, structured output ─────────────────────────────────

async function _llmCall(cfg, prompt) {
  const llm      = cfg.llm ?? {};
  const provider = llm.provider ?? 'openrouter';
  const model    = llm.model    ?? 'google/gemini-2.5-flash-lite';
  const key      = llm.openrouterKey || process.env.OPENROUTER_API_KEY || '';
  const baseUrl  = llm.baseUrl
    || (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://openrouter.ai/api/v1');

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      model,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  4096,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ── Parse the structured LLM response ────────────────────────────────────────
// Expected format:
//   SUMMARY: <one sentence>
//   WORK:
//   <multi-line deliverable>
//
// Or, if the agent cannot complete it:
//   SKIP: <one sentence reason>

function _parseResponse(text) {
  const skipMatch = text.match(/^SKIP:\s*(.+)/im);
  if (skipMatch) {
    return { skip: true, skipReason: skipMatch[1].trim().slice(0, 300) };
  }

  const delegateMatch = text.match(/^DELEGATE:\s*(.+)/im);
  if (delegateMatch) {
    const subtasksMatch = text.match(/^SUBTASKS:\s*\n([\s\S]+)/im);
    let subtasks = [];
    if (subtasksMatch) {
      try {
        // Extract JSON array — handle markdown code fences if present
        const raw = subtasksMatch[1].replace(/```(?:json)?\n?/g, '').trim();
        subtasks = JSON.parse(raw);
      } catch {
        subtasks = [];
      }
    }
    return {
      skip:       false,
      delegate:   true,
      delegateReason: delegateMatch[1].trim().slice(0, 300),
      subtasks,
    };
  }

  const summaryMatch = text.match(/^SUMMARY:\s*(.+)/im);
  const workMatch    = text.match(/^WORK:\s*\n([\s\S]+)/im);

  if (!summaryMatch && !workMatch) {
    return {
      skip:    false,
      summary: 'Task completed — see work for details.',
      work:    text.trim(),
    };
  }

  return {
    skip:    false,
    summary: summaryMatch ? summaryMatch[1].trim().slice(0, 300) : 'Task completed.',
    work:    workMatch    ? workMatch[1].trim() : text.trim(),
  };
}

// ── Context gathering by task type ────────────────────────────────────────────

async function _gatherContext(task, api) {
  const sections = [];

  try {
    switch (task.type) {
      case 'analyze': {
        // Provide the agent's own trade history — the richest local dataset
        if (fs.existsSync(TRADE_HIST_FILE)) {
          const trades = JSON.parse(fs.readFileSync(TRADE_HIST_FILE, 'utf8'));
          // Summarise rather than dump the full file to stay within context
          const wins   = trades.filter(t => t.pnlPct > 0);
          const losses = trades.filter(t => t.pnlPct <= 0);
          const summary = {
            totalTrades: trades.length,
            winRate:     trades.length ? ((wins.length / trades.length) * 100).toFixed(1) + '%' : 'n/a',
            avgPnlPct:   trades.length
              ? (trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length).toFixed(2) + '%'
              : 'n/a',
            avgHoldMins: trades.length
              ? (trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length).toFixed(1)
              : 'n/a',
            exitReasons: _countBy(trades, 'reason'),
          };
          sections.push('TRADE HISTORY SUMMARY:\n' + JSON.stringify(summary, null, 2));
          // Include full trade list (capped at last 100 trades to keep prompt manageable)
          const recent = trades.slice(-100).map(t => ({
            symbol:      t.symbol,
            entryTime:   t.entryTime,
            holdMinutes: t.holdMinutes,
            pnlPct:      t.pnlPct?.toFixed(2),
            peakPnlPct:  t.peakPnlPct?.toFixed(2),
            reason:      t.reason,
          }));
          sections.push('INDIVIDUAL TRADES (most recent 100):\n' + JSON.stringify(recent, null, 2));
        }
        break;
      }

      case 'research': {
        // Always fetch: regime + swarm aggregate stats + market overview + top pools
        const [regimeRes, aggregateRes, overview, pools] = await Promise.allSettled([
          api._fetch('/api/market-regime').then(r => r.ok ? r.json() : null),
          api._fetch('/api/swarm/aggregate-stats').then(r => r.ok ? r.json() : null),
          api.marketOverview(),
          api.topPools(10),
        ]);
        if (regimeRes.status === 'fulfilled' && regimeRes.value) {
          sections.push('MARKET REGIME:\n' + JSON.stringify(regimeRes.value, null, 2));
        }
        if (aggregateRes.status === 'fulfilled' && aggregateRes.value) {
          sections.push('SWARM AGGREGATE STATS (strategy_stats):\n' + JSON.stringify(aggregateRes.value, null, 2).slice(0, 5000));
        }
        if (overview.status === 'fulfilled' && overview.value) {
          sections.push('MARKET OVERVIEW:\n' + JSON.stringify(overview.value, null, 2).slice(0, 3000));
        }
        if (pools.status === 'fulfilled' && pools.value) {
          sections.push('TOP POOLS (24h volume):\n' + JSON.stringify(pools.value, null, 2).slice(0, 3000));
        }

        // If the task involves trade outcomes / backtesting, include this agent's own trade history.
        // Tasks that say "my losses" should be interpreted as THIS agent's losses — a valid proxy dataset.
        const tradeKeywords = ['trade', 'loss', 'win', 'backtest', 'history', 'outcome', 'pnl', 'sl', 'stop', 'sample'];
        const isTradeResearch = tradeKeywords.some(kw => new RegExp(kw, 'i').test(task.description + ' ' + task.title));
        let tradeMints = [];
        if (isTradeResearch && fs.existsSync(TRADE_HIST_FILE)) {
          try {
            const trades = JSON.parse(fs.readFileSync(TRADE_HIST_FILE, 'utf8'));
            const week   = Date.now() - 7 * 86_400_000;
            const recent = trades.filter(t => new Date(t.exitTime ?? t.entryTime).getTime() >= week);
            const wins   = recent.filter(t => (t.pnlPct ?? 0) > 0);
            const losses = recent.filter(t => (t.pnlPct ?? 0) <= 0);
            const tradeRows = recent.slice(-100).map(t => ({
              mint:        t.mint,
              symbol:      t.symbol,
              pnlPct:      t.pnlPct?.toFixed(2),
              peakPnlPct:  t.peakPnlPct?.toFixed(2),
              holdMinutes: t.holdMinutes,
              reason:      t.reason,
              pattern:     t.pattern,
              entryTime:   t.entryTime,
            }));
            sections.push(
              `THIS AGENT'S OWN TRADE HISTORY (7d: ${recent.length} trades, ` +
              `${wins.length} wins / ${losses.length} losses):\n` +
              JSON.stringify(tradeRows, null, 2).slice(0, 5000)
            );
            tradeMints = recent.map(t => t.mint).filter(Boolean);
          } catch (e) {
            log('warn', 'Could not read trade history for research context', { error: e.message });
          }
        }

        // If the task involves holder concentration, fetch batch data.
        // Prefer trade history mints (agent's own loss/win mints) over generic pool mints —
        // that's exactly the data needed for holder-concentration backtest tasks.
        const holderKeywords = ['holder', 'concentration', 'whale', 'distribution', 'top.*wallet', 'top5', 'top 5'];
        const isHolderTask = holderKeywords.some(kw => new RegExp(kw, 'i').test(task.description + ' ' + task.title));
        if (isHolderTask) {
          const poolMints = pools.status === 'fulfilled'
            ? (pools.value?.pools ?? []).slice(0, 10).map(p => p.baseToken?.mint ?? p.mint).filter(Boolean)
            : [];
          // Use trade mints when available (more relevant for backtests), fall back to pool mints
          const mintsToCheck = tradeMints.length
            ? [...new Set(tradeMints)].slice(0, 10)
            : poolMints.slice(0, 10);
          if (mintsToCheck.length) {
            try {
              const holderData = await api._fetch(`/api/token-holders-batch?mints=${mintsToCheck.join(',')}`);
              if (holderData.ok) {
                const json = await holderData.json();
                sections.push('HOLDER CONCENTRATION (top 5/10/20% of supply per mint):\n' + JSON.stringify(json.results, null, 2).slice(0, 5000));
              }
            } catch (e) {
              log('warn', 'Holder batch fetch failed (non-critical)', { error: e.message });
            }
          }
        }
        break;
      }
      case 'trade': {
        const [pools, sentiment, tradeRegime] = await Promise.allSettled([
          api.topPools(10),
          api.marketSentiment(),
          api._fetch('/api/market-regime').then(r => r.ok ? r.json() : null),
        ]);
        if (tradeRegime.status === 'fulfilled' && tradeRegime.value) {
          sections.push('MARKET REGIME:\n' + JSON.stringify(tradeRegime.value, null, 2));
        }
        if (pools.status === 'fulfilled' && pools.value) {
          sections.push('TOP POOLS:\n' + JSON.stringify(pools.value, null, 2).slice(0, 2000));
        }
        if (sentiment.status === 'fulfilled' && sentiment.value) {
          sections.push('MARKET SENTIMENT:\n' + JSON.stringify(sentiment.value, null, 2));
        }
        break;
      }

      // build / skill / other — no pre-fetch; task description is sufficient
      default:
        break;
    }
  } catch (err) {
    log('warn', 'Context gather error (continuing anyway)', { error: err.message });
  }

  return sections.join('\n\n');
}

function _countBy(arr, key) {
  return arr.reduce((acc, item) => {
    const val = item[key] ?? 'unknown';
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {});
}

// ── Build the task prompt ─────────────────────────────────────────────────────

function _buildPrompt(task, context) {
  const typeGuide = {
    research: 'Gather and synthesize the requested data. Present findings clearly with numbers.',
    analyze:  'Analyse the provided trade history data. Show your working — include counts, percentages, and a concrete recommendation.',
    build:    'Write the requested code or script. Include comments. You cannot execute it here, so make sure the code is self-explanatory and correct.',
    skill:    'Write the skill document or strategy as requested. Be specific and actionable.',
    trade:    'Provide a concrete trading recommendation based on the data. Include specific token/pair names and reasoning.',
    other:    'Complete the task as described. Be thorough and specific.',
  };

  const guide = typeGuide[task.type] ?? typeGuide.other;

  const contextBlock = context
    ? `\nCONTEXT DATA:\n${context}\n`
    : '';

  const deadline = task.deadline
    ? `\nDEADLINE: ${task.deadline}`
    : '';

  return `You are a Solana trading agent completing an assigned swarm task. Do the work — do not ask clarifying questions.

TASK TYPE: ${task.type}
TASK TITLE: ${task.title}${deadline}
TASK DESCRIPTION:
${task.description}
${contextBlock}
GUIDANCE: ${guide}

IMPORTANT — PARTIAL DATA IS FINE:
Work with whatever context data is provided above, even if some fields are missing or incomplete.
Only use SKIP if the task is fundamentally impossible (e.g. no data whatsoever, or requires a live
external API key you have no access to). Incomplete data or missing a few fields is NOT a reason to skip.

DELEGATION (only for large multi-part tasks):
If this task is clearly too large to complete alone in one pass — e.g. it requires independently
researching 5+ tokens, or writing several distinct code modules — you MAY delegate it by breaking it
into subtasks. Use DELEGATE only when delegation genuinely helps; don't split simple tasks.

Your response MUST use exactly ONE of these formats — no preamble, no extra text:

Option A — Complete the task yourself:
SUMMARY: <one sentence describing what you did and the key finding>
WORK:
<the full deliverable — analysis, code, findings, or document>

Option B — Delegate to subtasks:
DELEGATE: <one sentence explaining why you are delegating and how many subtasks>
SUBTASKS:
[
  { "title": "...", "description": "...", "type": "research|build|analyze|skill|other", "rewardCircuit": <integer>, "deadlineHoursFromNow": <integer> },
  ...
]

Option C — Only if truly impossible (not just hard):
SKIP: <one concise sentence explaining what is blocking completion>`;
}


// ── Auto-claim the best available open task ───────────────────────────────────
// Called when this agent has no currently claimed tasks.
// Sorts open tasks by: reward DESC → deadline ASC → oldest creation.
// Skips tasks this agent has previously abandoned (recorded in claimHistory).
// Returns the newly claimed task object, or null if nothing is claimable.

async function _autoClaim(myId, myAddr, api) {
  let openTasks = [];
  try {
    const res = await api.taskList({ status: 'open', limit: 50 });
    openTasks = res?.tasks ?? [];
  } catch (err) {
    log('warn', 'Could not fetch open tasks for auto-claim', { error: err.message });
    return null;
  }

  if (!openTasks.length) {
    log('info', 'No open tasks available to claim');
    return null;
  }

  // Filter out tasks this agent has previously abandoned
  const eligible = openTasks.filter(t => {
    const history = t.claimHistory ?? [];
    return !history.some(h => h.abandonedBy === myId);
  });

  if (!eligible.length) {
    log('info', 'All open tasks were previously abandoned by this agent — nothing to claim');
    return null;
  }

  // Sort: highest reward first (unfunded agents self-fund), then nearest deadline, then oldest
  eligible.sort((a, b) => {
    const rA = a.rewardCircuit ?? 0;
    const rB = b.rewardCircuit ?? 0;
    if (rB !== rA) return rB - rA;
    const dA = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const dB = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (dA !== dB) return dA - dB;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  const pick = eligible[0];
  log('info', 'Auto-claiming task', {
    taskId: pick.taskId,
    type:   pick.type,
    reward: pick.rewardCircuit ?? 0,
    title:  pick.title,
  });

  try {
    const res = await api.taskClaim(myId, myAddr, pick.taskId);
    if (res?.error) {
      log('warn', 'Auto-claim rejected by API', { taskId: pick.taskId, error: res.error });
      return null;
    }
    return { ...pick, status: 'claimed', claimedBy: myId, claimedAt: new Date().toISOString() };
  } catch (err) {
    log('warn', 'Auto-claim HTTP error', { taskId: pick.taskId, error: err.message });
    return null;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runTaskWorker(cfg, api) {
  const identity = loadIdentity();
  const myId     = identity.agentId;
  const myAddr   = identity.address;
  if (!myId) { log('warn', 'No agentId — skipping task worker'); return; }

  // 0. Run subtask manager — handles monitoring/compiling for delegated tasks
  const smResult = await subtaskManager.runCycle(api, myId, myAddr);
  if (smResult.managed > 0) {
    log('info', 'Subtask manager cycle', {
      managed:        smResult.managed,
      readyToCompile: smResult.readyToCompile.length,
      compiled:       smResult.compiled.length,
      errors:         smResult.errors.length,
    });
    smResult.errors.forEach(e => log('warn', 'Subtask manager error', e));
  }

  // 1. Fetch this agent's claimed tasks
  let claimedTasks = [];
  try {
    const res = await api.taskList({ status: 'claimed', limit: 50 });
    claimedTasks = (res?.tasks ?? []).filter(t => t.claimedBy === myId);
  } catch (err) {
    log('warn', 'Could not fetch claimed tasks', { error: err.message });
    return;
  }

  // 2. Auto-claim: if nothing claimed, find and claim the best open task
  if (!claimedTasks.length) {
    const newClaim = await _autoClaim(myId, myAddr, api);
    if (newClaim) {
      claimedTasks = [newClaim];
    } else {
      log('info', 'No claimed tasks and nothing available to claim — done for this cycle');
      return;
    }
  }

  // 3. Load attempt state; prune stale entries
  const state = _loadState();
  _pruneState(state, claimedTasks.map(t => t.taskId));

  // 4. Filter out tasks being managed by subtask-manager, skipped, or at max attempts
  const workable = claimedTasks.filter(t => {
    if (subtaskManager.isManaged(t.taskId)) return false;  // subtask-manager owns this
    const a = state.attempts[t.taskId];
    if (!a) return true;
    if (a.skipped)               return false;
    if (a.count >= MAX_ATTEMPTS) return false;
    return true;
  });

  if (!workable.length) {
    const managed = claimedTasks.filter(t => subtaskManager.isManaged(t.taskId)).length;
    if (managed > 0) {
      log('info', 'All claimed tasks are delegated to subtask manager', {
        managed, status: subtaskManager.getStatusReport(),
      });
    } else {
      log('info', `${claimedTasks.length} claimed task(s) — all at max attempts or skipped`);
    }
    return;
  }

  // 5. Pick one task: nearest deadline first, then oldest claim
  const pick = workable.sort((a, b) => {
    const dA = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const dB = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (dA !== dB) return dA - dB;
    return new Date(a.claimedAt) - new Date(b.claimedAt);
  })[0];

  const { taskId, title, type } = pick;
  const attemptNum = (state.attempts[taskId]?.count ?? 0) + 1;

  log('info', `Working on task (attempt ${attemptNum}/${MAX_ATTEMPTS})`, { taskId, type, title });

  // 6. Gather context, build prompt, call LLM
  let parsed;
  try {
    const context = await _gatherContext(pick, api);
    const prompt  = _buildPrompt(pick, context);
    const raw     = await _llmCall(cfg, prompt);
    parsed        = _parseResponse(raw);
  } catch (err) {
    log('warn', 'LLM call failed', { taskId, error: err.message });
    _recordAttempt(state, taskId);
    return;
  }

  // 7. Handle skip — abandon the claim so another agent can try
  if (parsed.skip) {
    log('info', 'Agent skipped task — releasing claim', { taskId, reason: parsed.skipReason });
    try {
      await api.taskAbandon(myId, myAddr, taskId, parsed.skipReason);
      // Remove from local state — another agent gets a clean slate on this task
      delete state.attempts[taskId];
      _saveState(state);
    } catch (err) {
      // Abandon is best-effort; record locally so we don't keep retrying a task we can't do
      log('warn', 'Abandon API call failed — recording locally', { taskId, error: err.message });
      _recordAttempt(state, taskId, { skipped: true, skipReason: parsed.skipReason });
    }
    return;
  }

  // 7b. Handle delegate — create subtasks, register with subtask-manager
  if (parsed.delegate) {
    const subtasks = parsed.subtasks ?? [];
    if (!subtasks.length) {
      log('warn', 'DELEGATE response had no subtasks — recording attempt', { taskId });
      _recordAttempt(state, taskId);
      return;
    }
    log('info', `Delegating task to ${subtasks.length} subtask(s)`, { taskId, reason: parsed.delegateReason });
    const createdIds = [];
    for (const st of subtasks) {
      try {
        const deadlineMs  = Date.now() + (st.deadlineHoursFromNow ?? 12) * 3_600_000;
        const res = await api.taskCreateSubtask({
          agentId:      myId,
          address:      myAddr,
          parentTaskId: taskId,
          type:         st.type        ?? 'research',
          title:        st.title       ?? 'Subtask',
          description:  st.description ?? pick.description,
          reward:       st.rewardCircuit ?? 0,
          deadline:     new Date(deadlineMs).toISOString(),
        });
        if (res?.taskId) {
          createdIds.push(res.taskId);
          log('info', 'Subtask created', { subtaskId: res.taskId, title: st.title });
        } else {
          log('warn', 'Subtask creation rejected', { title: st.title, error: res?.error });
        }
      } catch (err) {
        log('warn', 'Subtask creation error', { title: st.title, error: err.message });
      }
    }
    if (!createdIds.length) {
      log('warn', 'All subtask creations failed — recording attempt', { taskId });
      _recordAttempt(state, taskId);
      return;
    }
    subtaskManager.registerDelegation(taskId, title, createdIds);
    log('info', 'Delegation complete — subtask-manager will monitor until all done', {
      taskId, created: createdIds.length, failed: subtasks.length - createdIds.length,
    });
    _saveState(state);
    return;
  }

  // 8. Guard work size
  if (Buffer.byteLength(parsed.work, 'utf8') > MAX_WORK_BYTES) {
    parsed.work    = parsed.work.slice(0, MAX_WORK_BYTES);
    parsed.summary = parsed.summary + ' [truncated to fit 50KB limit]';
    log('warn', 'Work truncated to fit API limit', { taskId });
  }

  // 9. Submit
  try {
    const res = await api.taskSubmit(myId, myAddr, taskId, parsed.work, parsed.summary);
    if (res?.error) {
      log('warn', 'Submit rejected by API', { taskId, error: res.error });
      _recordAttempt(state, taskId);
    } else {
      log('info', 'Task submitted', { taskId, submissionId: res?.submissionId });
      // Remove from state — it's submitted, future retries make no sense
      delete state.attempts[taskId];
      _saveState(state);
    }
  } catch (err) {
    log('warn', 'Submit HTTP error', { taskId, error: err.message });
    _recordAttempt(state, taskId);
  }
}

module.exports = { runTaskWorker };

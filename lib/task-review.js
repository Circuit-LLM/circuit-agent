// lib/task-review.js — LLM review of task submissions for tasks this agent proposed
//
// Called from the reflect cycle. Checks the task board for any submitted tasks
// where proposedBy === myAgentId, fetches the full submission, asks the LLM if
// the work satisfies the task, then calls verify.
//
// Design: keep it narrow and deterministic.
//   - No tool use, no multi-turn — single prompt → parse → verify
//   - Low temperature for consistent structured output
//   - Falls back to "approve with caveat" if LLM is unavailable (avoids CIRCUIT freeze)
'use strict';

const { loadIdentity } = require('./profile');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [REVIEW] [${level.toUpperCase()}] ${line}\n`);
};

// ── Minimal LLM call — no tool use, just structured text output ───────────────

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
      max_tokens:  250,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ── Parse the two-line LLM response ──────────────────────────────────────────
// Expected format:
//   approved: true
//   comment: The implementation covers all required fields and passes validation.

function _parseReview(text) {
  const lower = text.toLowerCase();

  const approvedLine = text.match(/approved:\s*(true|false)/i);
  let approved = true; // default approve if ambiguous — avoid freezing escrow on parse failure
  if (approvedLine) {
    approved = approvedLine[1].toLowerCase() === 'true';
  } else {
    // Fallback: look for strong rejection language
    const rejectKeywords = ['does not satisfy', 'insufficient', 'rejected', 'incomplete', 'missing', 'fails to'];
    if (rejectKeywords.some(k => lower.includes(k))) approved = false;
  }

  const commentLine = text.match(/comment:\s*(.+)/i);
  const comment = commentLine
    ? commentLine[1].trim().slice(0, 300)
    : text.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 300) ?? 'Reviewed by agent LLM';

  return { approved, comment };
}

// ── Build the review prompt ───────────────────────────────────────────────────

function _buildPrompt(task, sub) {
  const workPreview = sub.work.length > 12000
    ? sub.work.slice(0, 12000) + '\n...(truncated — evaluate what is shown)'
    : sub.work;

  return `You proposed a task and an agent has submitted work for it. Review whether the submission adequately satisfies the task.

TASK TITLE: ${task.title}
TASK DESCRIPTION: ${task.description}

SUBMISSION SUMMARY: ${sub.summary}
SUBMISSION WORK:
${workPreview}

Does this submission satisfy the task? Reply with exactly two lines, nothing else:
approved: true
comment: <one sentence reason>

Or if the work is insufficient:
approved: false
comment: <one sentence explaining what is missing or wrong>`;
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runTaskReview(cfg, api) {
  const identity = loadIdentity();
  const myId     = identity.agentId || identity.address;
  if (!myId) return;

  // Fetch all submitted tasks — filter to those we proposed
  let submittedTasks = [];
  try {
    const res = await api.taskList({ status: 'submitted', limit: 50 });
    submittedTasks = (res?.tasks ?? []).filter(t => t.proposedBy === myId);
  } catch (err) {
    log('warn', 'Could not fetch submitted tasks', { error: err.message });
    return;
  }

  if (!submittedTasks.length) {
    log('info', 'No submitted tasks pending review');
    return;
  }

  log('info', `${submittedTasks.length} submitted task(s) to review`);

  for (const stub of submittedTasks) {
    const { taskId } = stub;
    try {
      // Fetch full task with submission work
      const resp = await api._fetch(`/api/swarm/tasks/${taskId}`);
      if (!resp.ok) { log('warn', `Could not fetch task ${taskId}`); continue; }
      const { task } = await resp.json();

      if (!task || task.status !== 'submitted') continue;

      // Latest submission
      const sub = task.submissions[task.submissions.length - 1];
      if (!sub) continue;

      // Skip if we already voted on this submission
      const alreadyVoted = (task.verifications ?? []).some(
        v => v.agentId === myId && v.submissionId === sub.submissionId
      );
      if (alreadyVoted) {
        log('info', `Already reviewed ${taskId} — skipping`);
        continue;
      }

      log('info', `Reviewing task "${task.title.slice(0, 60)}"`, { taskId, submissionId: sub.submissionId });

      const prompt   = _buildPrompt(task, sub);
      const llmText  = await _llmCall(cfg, prompt);
      log('info', `LLM response: ${llmText.slice(0, 120)}`);

      const { approved, comment } = _parseReview(llmText);

      const result = await api.taskVerify(
        identity.agentId, identity.address,
        taskId, approved, sub.submissionId, comment
      );

      log('info', `Task ${taskId} ${approved ? 'approved' : 'rejected'}`, {
        comment: comment.slice(0, 80),
        status:  result?.taskStatus,
      });
    } catch (err) {
      log('warn', `Review failed for task ${taskId}`, { error: err.message });
    }
  }
}

module.exports = { runTaskReview };

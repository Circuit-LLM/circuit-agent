'use strict';

// lib/subtask-manager.js
//
// Manages the lifecycle of subtasks for complex CIRCUIT swarm tasks.
// Runs each task-worker cycle — persists state across cron runs so work
// survives the 20-minute cron timeout.
//
// Phases for each managed parent task:
//   monitoring  → poll subtask statuses, collect verified submissions
//   compiling   → all subtasks terminal; compile + submit parent task
//   done        → parent submitted; removed on next cycle
//   error       → unrecoverable failure (empty subtasks, permanent submit error)
//
// State file: data/subtask_manager_state.json

const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/subtask_manager_state.json');

// Entries older than this are garbage-collected regardless of phase
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Max compiled work size — API hard limit is 50KB, leave headroom for summary
const MAX_COMPILED_BYTES = 44_000;

// Max submit attempts in compiling phase before marking as error
const MAX_COMPILE_ATTEMPTS = 3;

function _loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { activeTasks: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) { console.error('[subtask-manager] Failed to parse state file:', err.message); return { activeTasks: {} }; }
}

function _saveState(state) {
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Register a newly delegated task for monitoring.
 * Called by task-worker immediately after subtasks are created.
 */
function registerDelegation(parentTaskId, parentTitle, subtaskIds) {
  const state = _loadState();

  if (!subtaskIds || subtaskIds.length === 0) {
    // No subtasks created — mark immediately as error so we don't loop forever
    state.activeTasks[parentTaskId] = {
      parentTaskId,
      parentTitle,
      phase:         'error',
      errorReason:   'No subtasks were successfully created',
      subtaskIds:    [],
      collectedWork: {},
      startedAt:     new Date().toISOString(),
      lastCheckedAt: null,
      compiledWork:  null,
      compileAttempts: 0,
    };
  } else {
    state.activeTasks[parentTaskId] = {
      parentTaskId,
      parentTitle,
      phase:           'monitoring',
      subtaskIds,
      collectedWork:   {},
      startedAt:       new Date().toISOString(),
      lastCheckedAt:   null,
      compiledWork:    null,
      compileAttempts: 0,
    };
  }
  _saveState(state);
}

/**
 * Check if a task is currently being managed (skip normal task-worker LLM for it).
 */
function isManaged(parentTaskId) {
  const state = _loadState();
  const entry = state.activeTasks[parentTaskId];
  // error and done phases are cleaned up on next cycle — don't block work loop
  return entry && entry.phase !== 'error' && entry.phase !== 'done';
}

/**
 * Main cycle function — call once per task-worker run.
 * Returns a summary of what happened so the agent can report it.
 */
async function runCycle(api, myId, myAddr) {
  const state  = _loadState();
  const tasks  = state.activeTasks;
  const result = { managed: 0, readyToCompile: [], compiled: [], errors: [], cleaned: [] };

  const now     = Date.now();
  const taskIds = Object.keys(tasks);
  if (taskIds.length === 0) return result;

  // Garbage-collect stale entries before doing any work
  for (const id of taskIds) {
    const entry = tasks[id];
    const age   = now - new Date(entry.startedAt).getTime();
    if (age > MAX_ENTRY_AGE_MS || entry.phase === 'done') {
      delete tasks[id];
      result.cleaned.push(id);
    }
  }

  const activeIds = Object.keys(tasks).filter(id => tasks[id].phase !== 'error');
  result.managed  = activeIds.length;

  for (const parentTaskId of activeIds) {
    const entry = tasks[parentTaskId];

    try {
      if (entry.phase === 'monitoring') {
        await _monitorPhase(entry, api, result);
      } else if (entry.phase === 'compiling') {
        await _compilePhase(entry, api, myId, myAddr, result);
      }
    } catch (err) {
      result.errors.push({ parentTaskId, error: err.message });
    }

    entry.lastCheckedAt = new Date().toISOString();
  }

  _saveState(state);
  return result;
}

async function _monitorPhase(entry, api, result) {
  const subtaskData = await api.getTaskSubtasks(entry.parentTaskId);

  // Parent was cancelled or deleted — clean up
  if (!subtaskData) {
    entry.phase = 'error';
    entry.errorReason = 'Parent task not found or API unreachable';
    result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
    return;
  }

  // Check if parent task itself was cancelled
  if (subtaskData.subtasks && subtaskData.subtasks.length === 0 && entry.subtaskIds.length > 0) {
    // Subtasks may have been cascade-cancelled — treat as terminal
    entry.phase = 'error';
    entry.errorReason = 'All subtasks disappeared (cascade-cancelled?)';
    result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
    return;
  }

  // Handle zero-subtask registration (creation failed before registerDelegation guard)
  if (entry.subtaskIds.length === 0) {
    entry.phase = 'error';
    entry.errorReason = 'Registered with zero subtasks — delegation failed';
    result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
    return;
  }

  const subtasks = subtaskData.subtasks ?? [];

  // Collect verified subtask work
  for (const st of subtasks) {
    if (st.status === 'verified' && !entry.collectedWork[st.taskId]) {
      // Use the accepted submission — fall back to last only if acceptedSubmission not set
      const accepted = st.acceptedSubmission
        ? st.submissions.find(s => s.submissionId === st.acceptedSubmission)
        : st.submissions[st.submissions.length - 1];

      if (accepted) {
        entry.collectedWork[st.taskId] = {
          title:   st.title,
          summary: accepted.summary ?? '',
          work:    accepted.work    ?? '',
        };
      }
    }
  }

  // allDone = all subtasks in terminal state (verified OR cancelled)
  // Matches the API's allDone definition exactly
  if (subtaskData.allDone) {
    if (Object.keys(entry.collectedWork).length === 0) {
      // All subtasks cancelled, no work collected — unrecoverable
      entry.phase = 'error';
      entry.errorReason = 'All subtasks cancelled before any work was collected';
      result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
      return;
    }
    entry.phase = 'compiling';
    result.readyToCompile.push(entry.parentTaskId);
  }
}

async function _compilePhase(entry, api, myId, myAddr, result) {
  // Guard: max compile attempts to prevent infinite retry on permanent errors
  entry.compileAttempts = (entry.compileAttempts || 0) + 1;
  if (entry.compileAttempts > MAX_COMPILE_ATTEMPTS) {
    entry.phase = 'error';
    entry.errorReason = `Failed to submit after ${MAX_COMPILE_ATTEMPTS} attempts`;
    result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
    return;
  }

  // Build compiled work if not already done
  if (!entry.compiledWork) {
    const sections = Object.values(entry.collectedWork);
    if (sections.length === 0) {
      entry.phase = 'error';
      entry.errorReason = 'No collected subtask work to compile';
      result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
      return;
    }

    const compiledSummary =
      `Compiled from ${sections.length} subtask(s): ` +
      sections.map(s => s.title).join(', ');

    let compiledWork = sections.map(s =>
      `## ${s.title}\n\n` +
      (s.summary ? `Summary: ${s.summary}\n\n` : '') +
      s.work
    ).join('\n\n---\n\n');

    // Enforce size limit — truncate with a clear marker
    if (Buffer.byteLength(compiledWork, 'utf8') > MAX_COMPILED_BYTES) {
      const encoder = new TextEncoder();
      let encoded = encoder.encode(compiledWork);
      const truncated = Buffer.from(encoded.slice(0, MAX_COMPILED_BYTES)).toString('utf8');
      compiledWork = truncated + '\n\n[... compiled work truncated to 44KB API limit ...]';
    }

    entry.compiledWork = { summary: compiledSummary, work: compiledWork };
  }

  // Submit to parent task
  const submitRes = await api.taskSubmit(
    myId, myAddr,
    entry.parentTaskId,
    entry.compiledWork.work,
    entry.compiledWork.summary
  );

  if (submitRes && !submitRes.error) {
    entry.phase = 'done';
    result.compiled.push(entry.parentTaskId);
  } else {
    const errMsg = submitRes?.error || 'Submit returned no response';
    const httpStatus = submitRes?._status;
    // Permanent errors (task gone, wrong state, unauthorized) — don't burn retries
    const isPermanent = httpStatus === 404 || httpStatus === 403 || httpStatus === 401 ||
      (httpStatus === 409 && !errMsg.includes('subtask'));
    if (isPermanent) {
      entry.phase = 'error';
      entry.errorReason = `Permanent submit error (HTTP ${httpStatus}): ${errMsg}`;
      result.errors.push({ parentTaskId: entry.parentTaskId, error: entry.errorReason });
    } else {
      result.errors.push({ parentTaskId: entry.parentTaskId, error: `Submit attempt ${entry.compileAttempts}: ${errMsg}` });
      // Stay in compiling — will retry next cycle up to MAX_COMPILE_ATTEMPTS
    }
  }
}

/**
 * Build a human-readable status report for active managed tasks.
 */
function getStatusReport() {
  const state = _loadState();
  const tasks = Object.values(state.activeTasks).filter(e => e.phase !== 'error' && e.phase !== 'done');
  if (tasks.length === 0) return null;
  return tasks.map(e => {
    const done  = Object.keys(e.collectedWork).length;
    const total = e.subtaskIds.length;
    return `${e.parentTaskId.slice(0, 12)} [${e.phase}] ${done}/${total} subtasks collected`;
  }).join(', ');
}

module.exports = { registerDelegation, isManaged, runCycle, getStatusReport };

// lib/processor.js — AI queue processor for circuit-agent
// Picks up messages from data/queue/incoming/ one at a time,
// runs them through the LLM (OpenRouter, tool-use loop up to 12 rounds),
// writes responses to data/queue/outgoing/.
//
// Architecture (from circuitbot):
//   [Channel clients] → queue/incoming/ → [processor] → queue/outgoing/ → [channel clients]
'use strict';

const fs   = require('fs');
const path = require('path');

const memory  = require('./memory');
const profile = require('./profile');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');

// ── Queue paths ───────────────────────────────────────────────────────────────

const DATA_DIR         = path.join(__dirname, '../data');
const QUEUE_INCOMING   = path.join(DATA_DIR, 'queue/incoming');
const QUEUE_PROCESSING = path.join(DATA_DIR, 'queue/processing');
const QUEUE_OUTGOING   = path.join(DATA_DIR, 'queue/outgoing');
const LOG_FILE         = path.join(__dirname, '../logs/processor.log');
const SOUL_FILE        = path.join(__dirname, '../soul.md');
const SOUL_LOCAL_FILE    = path.join(__dirname, '../soul.local.md');   // user override (gitignored)
const SYSTEM_PROMPT_FILE = path.join(__dirname, '../config/system-prompt.md');
const CONVERSATION_FILE  = path.join(DATA_DIR, 'conversation.json');
const SUMMARY_FILE       = path.join(DATA_DIR, 'conversation_summary.md');
const ARCHIVE_FILE       = path.join(DATA_DIR, 'conversation_archive.jsonl');
const RESET_FLAG         = path.join(DATA_DIR, 'reset_flag');

const MAX_TOOL_ROUNDS    = 12;
const MAX_HISTORY        = 30;  // raw messages kept before compaction
const COMPACT_KEEP       = 15;  // messages to keep after compaction
const MAX_RESPONSE_LEN   = 4000;

// Default system prompt (overridden by soul.md + config/system-prompt.md)
const DEFAULT_SYSTEM = 'You are a helpful Solana trading assistant. Be concise and direct.';

// ── Logger ────────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  const out  = `[${ts}] [PROC] [${level.toUpperCase()}] ${line}\n`;
  process.stdout.write(out);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, out);
  } catch { /* ignore log write failures */ }
}

// ── Ensure queue directories exist ───────────────────────────────────────────

for (const dir of [QUEUE_INCOMING, QUEUE_PROCESSING, QUEUE_OUTGOING]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Settings ──────────────────────────────────────────────────────────────────

const { loadConfig } = require('./config');
const loadSettings = loadConfig;  // alias — processor calls loadSettings() per message for hot-reload

// ── Soul / system prompt ──────────────────────────────────────────────────────
// soul.local.md takes priority over soul.md if present.
// This lets users fully own their agent personality without touching soul.md,
// so git pull never overwrites their customizations.

function buildSystemPrompt() {
  let soul = '';
  let base = DEFAULT_SYSTEM;

  // soul.local.md (gitignored) overrides soul.md when present
  const soulFile = fs.existsSync(SOUL_LOCAL_FILE) ? SOUL_LOCAL_FILE : SOUL_FILE;
  try { soul = fs.readFileSync(soulFile, 'utf8').trim(); } catch { /* no soul file */ }
  try {
    const custom = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').trim();
    if (custom) base = custom;
  } catch { /* no system-prompt.md */ }

  return soul ? `${soul}\n\n---\n\n${base}` : base;
}

// ── Conversation history ──────────────────────────────────────────────────────

function loadConversation() {
  try {
    if (fs.existsSync(CONVERSATION_FILE)) {
      return JSON.parse(fs.readFileSync(CONVERSATION_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return [];
}

// Compact when history exceeds MAX_HISTORY:
//   - Archive the older half to conversation_archive.jsonl
//   - Keep the COMPACT_KEEP most recent messages
//   - Record a note so the LLM knows history was trimmed
function saveConversation(msgs) {
  if (msgs.length > MAX_HISTORY) {
    const keep    = msgs.slice(-COMPACT_KEEP);
    const archive = msgs.slice(0, msgs.length - COMPACT_KEEP);

    // Append archived messages to jsonl (one per line)
    try {
      fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
      const lines = archive.map(m => JSON.stringify(m)).join('\n') + '\n';
      fs.appendFileSync(ARCHIVE_FILE, lines);
    } catch { /* non-fatal */ }

    // Prepend a compaction marker so the LLM knows context was trimmed
    const marker = {
      role:    'system',
      content: `[Conversation compacted — ${archive.length} older messages archived. Recent ${keep.length} messages follow.]`,
    };
    fs.writeFileSync(CONVERSATION_FILE, JSON.stringify([marker, ...keep], null, 2));
    log('info', `Conversation compacted — archived ${archive.length} msgs, kept ${keep.length}`);
  } else {
    fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(msgs, null, 2));
  }
}

// Load the persistent conversation summary (written by reflect/LLM via save_memory or direct write)
function loadSummary() {
  try {
    if (fs.existsSync(SUMMARY_FILE)) return fs.readFileSync(SUMMARY_FILE, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

function resetConversation() {
  try { fs.unlinkSync(CONVERSATION_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(SUMMARY_FILE);      } catch { /* ignore */ }
}

// ── Process one message ───────────────────────────────────────────────────────

async function processMessage(msgPath, agentCtx) {
  const { api, wallet, swap, positions, cfg } = agentCtx;
  const procPath = path.join(QUEUE_PROCESSING, path.basename(msgPath));

  try {
    // Atomic move to processing (prevents double-processing)
    fs.renameSync(msgPath, procPath);

    const msgData = JSON.parse(fs.readFileSync(procPath, 'utf8'));
    const { channel, sender, senderId, message, messageId } = msgData;

    log('info', `Processing [${channel}] ${sender}: ${message.slice(0, 60)}`);

    // Check reset flag
    if (fs.existsSync(RESET_FLAG)) {
      fs.unlinkSync(RESET_FLAG);
      resetConversation();
      log('info', 'Conversation reset');
    }

    // Load settings fresh (model hot-switching)
    const settings  = loadSettings();
    const model     = settings.llm?.model    ?? 'x-ai/grok-4.1-fast';
    const provider  = settings.llm?.provider ?? 'openrouter';
    const apiKey    = settings.llm?.openrouterKey || process.env.OPENROUTER_API_KEY || '';
    const customUrl = settings.llm?.baseUrl ?? '';

    // Resolve LLM base URL
    let baseURL;
    if (customUrl) {
      baseURL = customUrl;
    } else if (provider === 'ollama') {
      baseURL = 'http://localhost:11434/v1';
    } else {
      baseURL = 'https://openrouter.ai/api/v1';
    }

    const isLocal = provider === 'ollama' || baseURL.includes('localhost') || baseURL.includes('127.0.0.1');

    if (!apiKey && !isLocal) {
      log('error', 'No LLM API key configured');
      writeResponse(msgData, 'LLM not configured — set openrouterKey in config/agent.json or OPENROUTER_API_KEY env var. For local models, set provider to "ollama".');
      fs.unlinkSync(procPath);
      return;
    }

    // Touch profile / memory
    const userProfile = memory.touchProfile(senderId ?? sender, sender, channel);

    // Build system prompt with memory context + startup market context
    let systemPrompt = buildSystemPrompt();
    systemPrompt += memory.buildMemoryContext(senderId ?? sender);
    try {
      const ctxModule = require('./context');
      systemPrompt += ctxModule.buildContextBlock();
    } catch { /* context module unavailable */ }

    // Inject swarm identity (trust level, session count, performance summary)
    systemPrompt += profile.buildProfileBlock();

    // Inject agent self-memory (insights learned during past reflect cycles)
    systemPrompt += memory.buildNotesContext();

    // Inject conversation summary (written by reflect loop — cheaper than raw history)
    const summary = loadSummary();
    if (summary) systemPrompt += `\n\n---\n\n## Conversation Summary\n${summary}`;

    // Onboarding for new users
    if (!userProfile.onboarded) {
      systemPrompt += `\n\n---\n\n## Onboarding (new user)\nThis is the first time talking to ${sender}. Introduce yourself as their Solana agent, ask what they'd like to do, and save key preferences using save_memory. After first exchange, they are onboarded.`;
    }

    // Load history
    const history = loadConversation();

    // Build messages for API
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user',   content: `[${channel}/${sender}] ${message}` },
    ];

    // Tool execution context — _buyExecutedThisRound prevents multiple buys in one loop
    const toolCtx = { senderId: senderId ?? sender, api, wallet, swap, positions, _buyExecutedThisRound: false };

    // ── LLM tool-use loop ──────────────────────────────────────────────────
    const OpenAI = require('openai');
    const client = new OpenAI.default({
      baseURL,
      apiKey: apiKey || 'ollama',  // SDK requires non-empty string
    });

    const LLM_TIMEOUT_MS = 120_000;  // 2 minutes per round

    // Helper: run LLM call with abort timeout
    async function llmCall(params) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      try {
        return await client.chat.completions.create(params, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    let response = '';
    let round    = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      let completion;
      try {
        completion = await llmCall({ model, messages: apiMessages, tools: TOOL_DEFINITIONS });
      } catch (toolErr) {
        if (toolErr.name === 'AbortError') {
          log('warn', `LLM timed out after ${LLM_TIMEOUT_MS / 1000}s (round ${round})`);
          response = 'Request timed out — the model took too long to respond. Please try again.';
          break;
        }
        // Model may not support tools — fall back to plain completion
        if (toolErr.status === 400 || toolErr.status === 422 || String(toolErr.message).includes('tool')) {
          log('warn', 'Model does not support tools, falling back to plain completion');
          completion = await llmCall({ model, messages: apiMessages });
        } else {
          throw toolErr;
        }
      }

      const choice    = completion.choices?.[0];
      const assistant = choice?.message;
      if (!assistant) { response = 'No response generated.'; break; }

      // Tool calls?
      if (assistant.tool_calls?.length) {
        log('info', `Round ${round}: ${assistant.tool_calls.length} tool call(s)`);
        apiMessages.push({
          role:       'assistant',
          content:    assistant.content ?? null,
          tool_calls: assistant.tool_calls,
        });

        for (const tc of assistant.tool_calls) {
          let tcArgs = {};
          try {
            tcArgs = JSON.parse(tc.function.arguments ?? '{}');
          } catch (parseErr) {
            log('warn', `Malformed tool args for ${tc.function.name}`, { raw: String(tc.function.arguments).slice(0, 120) });
            apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `Invalid arguments: ${parseErr.message} — retry with valid JSON` }) });
            continue;
          }
          log('info', `Tool: ${tc.function.name}`, tcArgs);
          const result = await executeTool(tc.function.name, tcArgs, toolCtx, log);
          apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue; // next round
      }

      // Final text response
      response = (assistant.content ?? '').trim();

      // Mark onboarded after first successful exchange
      if (!userProfile.onboarded) {
        userProfile.onboarded = true;
        memory.saveProfile(userProfile);
      }

      break;
    }

    if (!response) response = 'I got stuck in my thinking — please try again.';
    if (response.length > MAX_RESPONSE_LEN) {
      response = response.slice(0, MAX_RESPONSE_LEN - 50) + '\n\n[Response truncated]';
    }

    // Save to conversation history (user + final response only, not tool calls)
    if (!response.startsWith('LLM not configured')) {
      history.push({ role: 'user',      content: `[${channel}/${sender}] ${message}` });
      history.push({ role: 'assistant', content: response });
      saveConversation(history);
    }

    // Increment session counter for trust level progression
    profile.incrementSessions();

    writeResponse(msgData, response);
    log('info', `Done [${channel}] ${sender} → ${response.length} chars via ${model}`);
    fs.unlinkSync(procPath);

  } catch (err) {
    log('error', `Processor error: ${err.message}`);
    // Move back to incoming for retry
    try { if (fs.existsSync(procPath)) fs.renameSync(procPath, msgPath); } catch { /* ignore */ }
  }
}

// ── Write response to outgoing queue ─────────────────────────────────────────

function writeResponse(msgData, responseText) {
  const { channel, sender, senderId, message, messageId } = msgData;
  const fname = `${channel}_${messageId}_${Date.now()}.json`;
  const out   = {
    channel,
    sender,
    senderId,
    message:         responseText,
    originalMessage: message,
    timestamp:       Date.now(),
    messageId,
  };
  fs.writeFileSync(path.join(QUEUE_OUTGOING, fname), JSON.stringify(out, null, 2));
}

// ── Main processing loop ──────────────────────────────────────────────────────

let _isProcessing = false;

async function tick(agentCtx) {
  if (_isProcessing) return;
  _isProcessing = true;

  try {
    const files = fs.readdirSync(QUEUE_INCOMING)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        f,
        p:    path.join(QUEUE_INCOMING, f),
        time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs,
      }))
      .sort((a, b) => a.time - b.time);

    for (const { p } of files) {
      await processMessage(p, agentCtx);
    }
  } catch (err) {
    log('error', `Queue tick error: ${err.message}`);
  } finally {
    _isProcessing = false;
  }
}

// ── Queue writer (for other modules to enqueue messages) ──────────────────────

function enqueue(channel, sender, senderId, message, messageId) {
  fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
  const id   = messageId ?? `${channel}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(QUEUE_INCOMING, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    channel, sender, senderId: String(senderId ?? sender), message, messageId: id, timestamp: Date.now(),
  }, null, 2));
  return id;
}

function start(agentCtx) {
  log('info', 'Queue processor started');
  const cfg     = agentCtx.cfg;
  const model   = cfg.llm?.model ?? '(no model set)';
  const provider = cfg.llm?.provider ?? 'openrouter';
  const baseURL  = cfg.llm?.baseUrl || (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://openrouter.ai/api/v1');
  log('info', `Model: ${model} via ${baseURL}`);
  log('info', `Queue: ${QUEUE_INCOMING}`);
  setInterval(() => tick(agentCtx), 1000);
}

module.exports = { start, enqueue, QUEUE_INCOMING, QUEUE_OUTGOING, writeResponse };

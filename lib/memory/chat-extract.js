// lib/memory/chat-extract.js — reads whatever landed in conversation_archive.jsonl since the
// last reflect cycle and, in ONE batched LLM call, produces (a) durable facts routed into the
// existing notes pipeline and (b) one episode gist per batch into a capped store. Runs only from
// reflect.js — the chat write path is untouched. DEFAULT OFF: today's archive is ~95% the agent's
// own heartbeat/reflect chatter, so there's little operator knowledge to mine yet.
'use strict';

const fs     = require('fs');
const path   = require('path');
const memory = require('../memory');
const { buildClient } = require('../llm-client');

const ARCHIVE_FILE  = path.join(__dirname, '../../data/conversation_archive.jsonl');
const CURSOR_FILE   = path.join(__dirname, '../../data/chat_extract_state.json');
const EPISODES_FILE = path.join(__dirname, '../../data/chat_episodes.json');
const EPISODES_MAX  = 300;   // same order as trade_history.json's 200 cap — flat regardless of lifetime volume

function _loadCursor() { try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); } catch { return { lastLine: 0 }; } }
function _atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function runChatExtraction(settings) {
  const built = buildClient(settings);
  if (!built) return;                                   // LLM unconfigured — nothing to do

  let lines = [];
  try { lines = fs.readFileSync(ARCHIVE_FILE, 'utf8').split('\n').filter(Boolean); } catch { return; }
  const cursor = _loadCursor();
  const fresh  = lines.slice(cursor.lastLine);
  if (!fresh.length) return;                            // nothing new since last cycle — cheap no-op

  const messages = fresh.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // ONE call over everything since the last cycle — not one per compaction event.
  const out = await built.client.chat.completions.create({
    model: built.model, max_tokens: 400,
    messages: [
      { role: 'system', content: 'Extract only genuinely durable facts (operator preferences, decisions, recurring topics) from this chat excerpt, plus a one-sentence gist of what the exchange was about. Reply as JSON: {"facts":[{"key":"","value":"","category":""}],"gist":""}. Ignore heartbeat/reflect/system messages, status reports, and small talk entirely — most excerpts will yield no facts.' },
      { role: 'user', content: JSON.stringify(messages).slice(0, 12_000) },
    ],
  }).catch(() => null);
  if (!out) return;                                     // best-effort — cursor NOT advanced, retry next cycle

  let parsed;
  try { parsed = JSON.parse(out.choices?.[0]?.message?.content ?? ''); } catch { parsed = { facts: [], gist: null }; }

  // (a) durable facts → the SAME save path notes already use (real 3-arg signature).
  for (const f of parsed.facts ?? []) {
    if (f && f.key && f.value) memory.saveNote(String(f.key), String(f.value), f.category ?? 'chat');
  }

  // (b) one capped episode gist per batch → new rolling store.
  if (parsed.gist && String(parsed.gist).trim()) {
    let episodes = [];
    try { episodes = JSON.parse(fs.readFileSync(EPISODES_FILE, 'utf8')); } catch { /* new store */ }
    episodes.push({ gist: String(parsed.gist).slice(0, 300), savedAt: new Date().toISOString() });
    _atomicWrite(EPISODES_FILE, episodes.slice(-EPISODES_MAX));
  }

  _atomicWrite(CURSOR_FILE, { lastLine: lines.length });
}

module.exports = { runChatExtraction };

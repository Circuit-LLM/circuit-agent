// lib/memory.js — per-user profile and memory persistence for circuit-agent
// Each user gets their own directory under data/users/<senderId>/
// profile.json      — name, channel, onboarded, firstSeen, lastSeen
// memory.json       — array of { key, value, category, savedAt }
//
// Agent self-memory (data/agent-notes.json):
// The agent records its own learned patterns and insights here during reflect
// cycles. These notes are injected into every LLM system prompt so the agent
// carries forward what it has learned across sessions.
// notes.json        — array of { key, value, category, savedAt } (max 30)
'use strict';

const fs   = require('fs');
const path = require('path');

const USERS_DIR  = path.join(__dirname, '../data/users');
const NOTES_FILE = path.join(__dirname, '../data/agent-notes.json');

function _userDir(senderId) {
  const d = path.join(USERS_DIR, String(senderId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── Profile ───────────────────────────────────────────────────────────────────

function loadProfile(senderId) {
  try {
    const p = path.join(_userDir(senderId), 'profile.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

function saveProfile(profile) {
  const p   = path.join(_userDir(profile.senderId), 'profile.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
  fs.renameSync(tmp, p);
}

function createProfile(senderId, senderName, channel) {
  const now = new Date().toISOString();
  const profile = {
    senderId: String(senderId),
    name:     senderName || String(senderId),
    channel,
    onboarded: false,
    firstSeen: now,
    lastSeen:  now,
  };
  saveProfile(profile);
  return profile;
}

function touchProfile(senderId, senderName, channel) {
  let profile = loadProfile(senderId);
  if (!profile) {
    profile = createProfile(senderId, senderName, channel);
  } else {
    profile.lastSeen = new Date().toISOString();
    if (senderName && senderName !== profile.name) profile.name = senderName;
    saveProfile(profile);
  }
  return profile;
}

// ── Memory ────────────────────────────────────────────────────────────────────

function loadMemories(senderId) {
  try {
    const p = path.join(_userDir(senderId), 'memory.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function saveMemories(senderId, memories) {
  const p   = path.join(_userDir(senderId), 'memory.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(memories, null, 2));
  fs.renameSync(tmp, p);
}

const MAX_USER_MEMORIES = 50;

function addMemory(senderId, key, value, category = 'general') {
  // User memories are also injected into the system prompt (buildMemoryContext) —
  // apply the same truncation caps as agent notes to limit injection surface.
  const safeKey   = _clip(key,      NOTE_KEY_MAX);
  const safeValue = _clip(value,    NOTE_VALUE_MAX);
  const safeCat   = _clip(category, NOTE_CAT_MAX);
  let memories = loadMemories(senderId);
  const idx   = memories.findIndex(m => m.key === safeKey);
  const entry = { key: safeKey, value: safeValue, category: safeCat, savedAt: new Date().toISOString() };
  if (idx >= 0) {
    memories[idx] = entry;
  } else {
    memories.push(entry);
    if (memories.length > MAX_USER_MEMORIES) memories = memories.slice(-MAX_USER_MEMORIES);
  }
  saveMemories(senderId, memories);
  return entry;
}

function recallMemories(senderId, query = '') {
  const memories = loadMemories(senderId);
  if (!query.trim()) return memories;
  const q = query.toLowerCase();
  return memories.filter(m =>
    m.key.toLowerCase().includes(q) ||
    m.value.toLowerCase().includes(q) ||
    m.category.toLowerCase().includes(q)
  );
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildMemoryContext(senderId) {
  const memories = loadMemories(senderId);
  if (!memories.length) return '';
  const lines = memories.map(m => `- [${m.category}] ${m.key}: ${m.value}`).join('\n');
  return `\n\n---\n\n## What you know about this user\n${lines}`;
}

// ── Agent self-memory ─────────────────────────────────────────────────────────
// Notes the agent saves for itself during reflect cycles.
// Stored in data/agent-notes.json — max 30 entries (rolling, oldest dropped).
// Injected into every system prompt so learnings persist across sessions.

const NOTES_MAX      = 30;
const NOTE_KEY_MAX   = 80;   // keys are identifiers — 80 chars is generous
const NOTE_VALUE_MAX = 500;  // limits blast radius of an injected note in the system prompt
const NOTE_CAT_MAX   = 30;   // category is a short tag

// Coerce to string and truncate. Guards against non-string LLM args and
// limits how much text a compromised note can inject into the system prompt.
function _clip(v, max) {
  return String(v ?? '').slice(0, max);
}

function loadNotes() {
  try {
    if (fs.existsSync(NOTES_FILE)) return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function _saveNotes(notes) {
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  const tmp = NOTES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
  fs.renameSync(tmp, NOTES_FILE);
}

function saveNote(key, value, category = 'general') {
  // Truncate all fields — notes are injected verbatim into the system prompt on every
  // LLM call, so unbounded content is a prompt-injection amplifier.
  const safeKey   = _clip(key,      NOTE_KEY_MAX);
  const safeValue = _clip(value,    NOTE_VALUE_MAX);
  const safeCat   = _clip(category, NOTE_CAT_MAX);
  let notes = loadNotes();
  const idx   = notes.findIndex(n => n.key === safeKey);
  const entry = { key: safeKey, value: safeValue, category: safeCat, savedAt: new Date().toISOString() };
  if (idx >= 0) {
    notes[idx] = entry;
  } else {
    notes.push(entry);
    if (notes.length > NOTES_MAX) notes = notes.slice(-NOTES_MAX);
  }
  _saveNotes(notes);
  return entry;
}

function recallNotes(query = '') {
  const notes = loadNotes();
  if (!query.trim()) return notes;
  const q = query.toLowerCase();
  return notes.filter(n =>
    n.key.toLowerCase().includes(q) ||
    n.value.toLowerCase().includes(q) ||
    n.category.toLowerCase().includes(q)
  );
}

function buildNotesContext() {
  const notes = loadNotes();
  if (!notes.length) return '';
  const lines = notes.map(n => `- [${n.category}] ${n.key}: ${n.value}`).join('\n');
  return `\n\n---\n\n## Your learned notes (from past reflect cycles)\n${lines}`;
}

module.exports = {
  loadProfile, saveProfile, createProfile, touchProfile,
  loadMemories, addMemory, recallMemories, buildMemoryContext,
  loadNotes, saveNote, recallNotes, buildNotesContext,
};

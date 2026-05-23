// lib/tools/memory.js — per-user and agent self-memory tool definitions and handlers
'use strict';

const memory = require('../memory');

const DEFINITIONS = [
  // ── Per-user memory tools ──────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a key-value memory for the current user. Use to remember preferences, context, or facts about this specific person. Recalled automatically in future conversations.',
      parameters: {
        type: 'object',
        properties: {
          key:      { type: 'string', description: 'Memory key (e.g. "preferred_risk", "home_timezone")' },
          value:    { type: 'string', description: 'Value to store' },
          category: { type: 'string', description: 'Optional category for organization (default: general)' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memories',
      description: 'Recall memories for the current user. Optionally filter by query. Returns all stored key-value pairs for this person.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional search filter (searches key and value)' },
        },
        required: [],
      },
    },
  },
  // ── Agent self-memory tools ────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a trading insight or pattern to your own persistent memory. These notes are injected into your system prompt on every future session (max 30, oldest evicted). Use during reflect cycles to preserve lessons learned.',
      parameters: {
        type: 'object',
        properties: {
          key:      { type: 'string', description: 'Unique note key (e.g. "pattern_bear_reversal", "lesson_2024-01")' },
          value:    { type: 'string', description: 'The insight or pattern (be specific and actionable)' },
          category: { type: 'string', description: 'Category: pattern, lesson, regime, swarm, config (default: general)' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_notes',
      description: 'Recall your own saved trading notes and patterns. Optionally filter by query. Use during reflect to review what you have already learned before drawing conclusions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional search filter' },
        },
        required: [],
      },
    },
  },
];

const HANDLERS = {
  async save_memory(args, ctx, _log) {
    const { key, value, category } = args;
    if (!key || !value) return JSON.stringify({ error: 'key and value required' });
    memory.addMemory(ctx.senderId, key, value, category ?? 'general');
    return JSON.stringify({ saved: true, key, value, category });
  },

  async recall_memories(args, ctx, _log) {
    const memories = memory.recallMemories(ctx.senderId, args.query ?? '');
    return JSON.stringify({ memories, count: memories.length });
  },

  async save_note(args, _ctx, _log) {
    const { key, value, category } = args;
    if (!key || !value) return JSON.stringify({ error: 'key and value required' });
    memory.saveNote(key, value, category ?? 'general');
    return JSON.stringify({ saved: true, key, value, category });
  },

  async recall_notes(args, _ctx, _log) {
    const notes = memory.recallNotes(args.query ?? '');
    return JSON.stringify({ notes, count: notes.length });
  },
};

module.exports = { DEFINITIONS, HANDLERS };

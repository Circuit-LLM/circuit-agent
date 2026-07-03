// lib/memory/episode-recall.js — READ side of the episode store: retrieve the few past
// conversation episodes most relevant to the current message (lexical, via recall.js) and render
// them as a context block. Returns '' when there are no episodes or none are relevant — so an
// empty store (before chat-extraction has run) adds nothing to the prompt.
'use strict';

const fs   = require('fs');
const path = require('path');
const { rank } = require('./recall');

const EPISODES_FILE = path.join(__dirname, '../../data/chat_episodes.json');

function relevantBlock(query, k = 3) {
  let episodes = [];
  try { episodes = JSON.parse(fs.readFileSync(EPISODES_FILE, 'utf8')); } catch { return ''; }
  if (!episodes.length) return '';
  const top = rank(episodes, query, e => e.gist, { k, halfLifeMs: 30 * 86_400_000 });
  if (!top.length) return '';
  const lines = top.map(e => `- ${e.gist}`).join('\n');
  return `\n\n---\n\n## Relevant past conversations\n${lines}`;
}

module.exports = { relevantBlock };

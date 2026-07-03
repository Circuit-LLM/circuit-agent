// lib/memory/procedural.js — keep the full trail of config-parameter proposals instead of
// overwriting by param (today's behavior keeps only the latest, losing the reasoning history),
// and expose a param's prior proposals so the LLM sees them before proposing another (read-back).
// Backed by the existing data/suggested_config.json — no new store.
'use strict';

const PER_PARAM_MAX = 8;   // bound the trail per param so the file stays flat

// WRITE: append the new entry, then trim the oldest for this param beyond the cap.
// The just-pushed entry is never the oldest, so it always survives as the last element —
// which keeps the caller's `upsertIdx = suggestions.length - 1` correct.
function appendWithHistory(suggestions, entry) {
  suggestions.push(entry);
  let idxs = suggestions.reduce((a, s, i) => (s.param === entry.param ? (a.push(i), a) : a), []);
  while (idxs.length > PER_PARAM_MAX) {
    suggestions.splice(idxs[0], 1);
    idxs = suggestions.reduce((a, s, i) => (s.param === entry.param ? (a.push(i), a) : a), []);
  }
  return suggestions;
}

// READ-BACK: one line of prior proposals for `param` (value + applied/proposed), or '' when
// there's nothing worth surfacing yet. Injected into the update_config tool result so the LLM
// sees "you already tried this" in the same turn.
function priorChanges(suggestions, param, n = 4) {
  const hist = (suggestions || []).filter(s => s.param === param).slice(-n);
  if (hist.length < 2) return '';
  return `Prior ${param} proposals: ` + hist.map(s => `${s.suggestedValue} (${s.applied ? 'applied' : 'proposed'})`).join(' -> ');
}

module.exports = { appendWithHistory, priorChanges };

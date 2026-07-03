// lib/memory/recall.js — lexical relevance ranking. No embeddings, no infra: term-overlap
// weighted by inverse document-frequency (common words count for less) × recency. Pure — the
// caller owns the config gate. Used only where a store is too big to inject whole (episodes).
'use strict';

const STOP = new Set('the a an of to and or for in on at is it be with you your this that we our'.split(' '));
const toks = s => (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2 && !STOP.has(t));

function recency(t, halfLifeMs) {
  const age = Date.now() - new Date(t || 0).getTime();
  return Number.isFinite(age) ? Math.pow(0.5, age / halfLifeMs) : 0.5;
}

// entries: any[]; textOf: (entry) => string; returns the top-k most relevant.
function rank(entries, query, textOf, { halfLifeMs = 14 * 86_400_000, k = 5 } = {}) {
  const q = new Set(toks(query));
  if (!q.size) return entries.slice(-k);                       // no query → most-recent k
  const df = new Map();
  const docs = entries.map(e => {
    const terms = new Set(toks(textOf(e)));
    terms.forEach(t => df.set(t, (df.get(t) || 0) + 1));
    return { e, terms };
  });
  const N = docs.length || 1;
  return docs
    .map(({ e, terms }) => {
      let s = 0;
      q.forEach(t => { if (terms.has(t)) s += Math.log(1 + N / (df.get(t) || 1)); });
      return { e, score: s * recency(e.savedAt ?? e.exitTime, halfLifeMs) };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(r => r.e);
}

module.exports = { rank, toks };

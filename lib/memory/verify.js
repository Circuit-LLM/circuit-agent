// lib/memory/verify.js — integrity + cross-store consistency for the memory stores.
//
// The read-back memory system (docs/MEMORY.md) has no integrity layer: the stores are plain JSON,
// and a corrupt or hand-edited file silently steers a live trading agent's next strategy with nothing
// watching. This is the cheap analog of Covenant's memory↔audit verify: `trade_history.json` is the
// ground truth of what actually happened, so the DERIVED stores (strategy grades) must reconcile
// against it. Everything else gets structural + bounds + cursor sanity.
//
// Two layers, mirroring the shape that's easy to consume from a script:
//   checks[] — human pass/warn/fail rows
//   drift[]  — machine-readable { kind, store, id, evidence, repair }, repair ∈
//              recompute | trim | drop | clamp | manual
//
// verify() is READ-ONLY. repair(report) applies ONLY the safe, deterministic fixes and leaves
// `manual` items alone — dry-run-by-default, exactly like the lifecycle ops it's modeled on. Both
// share one per-grade canonicaliser (canonGrade) so repair() always converges: re-verify is clean by
// construction. Flag-independent — runs even with memory.enabled:false, so stores can be vetted
// before the feature is switched on.
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '../../data');
const D    = f => path.join(DATA, f);
const CAPS = { grades: 50, episodes: 300, perParam: 8 };

const ts   = t => new Date(t || 0).getTime();
const sane = p => (Number.isFinite(p) && Math.abs(p) < 1000) ? p : 0; // same outlier guard as plan-grade.js

function readStore(file) {
  if (!fs.existsSync(file)) return { exists: false, val: null };
  try { return { exists: true, val: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { exists: true, val: null, error: e.message }; }
}
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function archiveLineCount() {
  try { return fs.readFileSync(D('conversation_archive.jsonl'), 'utf8').split('\n').filter(Boolean).length; }
  catch { return null; }
}

// ── shared grade planner (verify diffs against it; repair writes it) ─────────────
function windowStats(trades, from, to) {
  const win    = trades.filter(t => { const x = ts(t.exitTime); return x >= from && x < to; });
  const pnlPct = +win.reduce((a, t) => a + sane(t.pnlPct), 0).toFixed(2);
  const wins   = win.filter(t => sane(t.pnlPct) > 0).length;
  return { trades: win.length, wins, pnlPct };
}
const verdictOf = g => (g.trades === 0 ? 'no-fills' : g.pnlPct > 1 ? 'worked' : g.pnlPct < -1 ? 'hurt' : 'flat');

// The one corrected form of a grade. A window still covered by retained (capped) trade_history is
// re-derived from the trades in it (this is exactly what plan-grade.js would have written); a window
// that rolled off history is "unverifiable" — keep its numbers, only its verdict is self-derivable.
function canonGrade(g, from, to, oldestExit, trades) {
  if (from >= oldestExit) {
    const w = windowStats(trades, from, to);
    return { ...g, trades: w.trades, wins: w.wins, pnlPct: w.pnlPct, verdict: verdictOf(w) };
  }
  return { ...g, verdict: verdictOf(g) };
}

// Ordered, de-duped-by-setAt, unparseable-setAt dropped, canonicalised, trimmed to cap. The exact
// array repair writes; verify walks the same derivation to emit per-field drift.
function planGrades() {
  const trades     = readStore(D('trade_history.json')).val;
  const raw        = readStore(D('strategy_grades.json')).val;
  if (!Array.isArray(raw) || !Array.isArray(trades)) return null;
  const oldestExit = trades.length ? Math.min(...trades.map(t => ts(t.exitTime))) : Infinity;
  const seen       = new Set();
  const sorted     = raw
    .filter(g => Number.isFinite(ts(g.setAt)))
    .sort((a, b) => ts(a.setAt) - ts(b.setAt))
    .filter(g => (seen.has(g.setAt) ? false : (seen.add(g.setAt), true)));
  const now = Date.now();
  return sorted
    .map((g, i) => canonGrade(g, ts(g.setAt), i + 1 < sorted.length ? ts(sorted[i + 1].setAt) : now, oldestExit, trades))
    .slice(-CAPS.grades);
}

// ── checks ───────────────────────────────────────────────────────────────────
function checkGrades(rep, trades) {
  const st = readStore(D('strategy_grades.json'));
  if (!st.exists) { rep.checks.push({ name: 'strategy_grades', status: 'pass', detail: 'absent (no grades yet)' }); return; }
  if (!Array.isArray(st.val)) {
    rep.drift.push({ kind: 'schema_invalid', store: 'strategy_grades.json', id: null, evidence: st.error || 'not an array', repair: 'manual' });
    return;
  }
  const grades = st.val;
  if (grades.length > CAPS.grades)
    rep.drift.push({ kind: 'over_cap', store: 'strategy_grades.json', id: null, evidence: `${grades.length} > ${CAPS.grades}`, repair: 'trim' });

  const bad = grades.filter(g => !Number.isFinite(ts(g.setAt)));
  bad.forEach(g => rep.drift.push({ kind: 'grade_bad_setat', store: 'strategy_grades.json', id: g.setAt ?? null, evidence: 'unparseable setAt', repair: 'drop' }));

  const oldestExit = trades.length ? Math.min(...trades.map(t => ts(t.exitTime))) : Infinity;
  const now        = Date.now();
  const sorted     = grades.filter(g => Number.isFinite(ts(g.setAt))).sort((a, b) => ts(a.setAt) - ts(b.setAt));

  // de-dup by setAt, flagging the duplicates (same 90-min window graded twice = the setAt-merge fingerprint)
  const seen = new Set(), dedup = [];
  for (const g of sorted) {
    if (seen.has(g.setAt)) { rep.drift.push({ kind: 'grade_duplicate_window', store: 'strategy_grades.json', id: g.setAt, evidence: 'two grades share setAt', repair: 'drop' }); continue; }
    seen.add(g.setAt); dedup.push(g);
  }

  for (let i = 0; i < dedup.length; i++) {
    const g = dedup[i], from = ts(g.setAt), to = i + 1 < dedup.length ? ts(dedup[i + 1].setAt) : now;
    const c = canonGrade(g, from, to, oldestExit, trades);
    if (from >= oldestExit) {                                   // window still verifiable against history
      if (g.trades !== c.trades)
        rep.drift.push({ kind: 'grade_trade_count_mismatch', store: 'strategy_grades.json', id: g.setAt, evidence: `stored ${g.trades} vs actual ${c.trades} closed in window`, repair: 'recompute' });
      else if (Math.abs((+g.pnlPct || 0) - c.pnlPct) > 0.01)
        rep.drift.push({ kind: 'grade_pnl_mismatch', store: 'strategy_grades.json', id: g.setAt, evidence: `stored ${g.pnlPct}% vs actual ${c.pnlPct}%`, repair: 'recompute' });
      if (g.wins !== c.wins)
        rep.drift.push({ kind: 'grade_wins_mismatch', store: 'strategy_grades.json', id: g.setAt, evidence: `stored ${g.wins} vs actual ${c.wins} wins`, repair: 'recompute' });
    }
    if (g.verdict !== c.verdict)
      rep.drift.push({ kind: 'grade_verdict_inconsistent', store: 'strategy_grades.json', id: g.setAt, evidence: `verdict=${g.verdict}, numbers ⇒ ${c.verdict}`, repair: 'recompute' });
  }
}

function checkEpisodes(rep) {
  const st = readStore(D('chat_episodes.json'));
  if (!st.exists) { rep.checks.push({ name: 'chat_episodes', status: 'pass', detail: 'absent' }); return; }
  if (!Array.isArray(st.val)) { rep.drift.push({ kind: 'schema_invalid', store: 'chat_episodes.json', id: null, evidence: st.error || 'not an array', repair: 'manual' }); return; }
  if (st.val.length > CAPS.episodes)
    rep.drift.push({ kind: 'over_cap', store: 'chat_episodes.json', id: null, evidence: `${st.val.length} > ${CAPS.episodes}`, repair: 'trim' });
  st.val.forEach((e, i) => { if (!e || typeof e.gist !== 'string' || !e.gist.trim())
    rep.drift.push({ kind: 'episode_empty_gist', store: 'chat_episodes.json', id: i, evidence: 'episode has no gist', repair: 'drop' }); });
}

function checkProposals(rep) {
  const st = readStore(D('suggested_config.json'));
  if (!st.exists) { rep.checks.push({ name: 'suggested_config', status: 'pass', detail: 'absent' }); return; }
  if (!Array.isArray(st.val)) { rep.drift.push({ kind: 'schema_invalid', store: 'suggested_config.json', id: null, evidence: st.error || 'not an array', repair: 'manual' }); return; }

  const byParam = {};
  for (const s of st.val) (byParam[s.param] ??= []).push(s);
  for (const [param, list] of Object.entries(byParam))
    if (list.length > CAPS.perParam)
      rep.drift.push({ kind: 'over_cap', store: 'suggested_config.json', id: param, evidence: `${list.length} proposals for ${param} > ${CAPS.perParam}`, repair: 'trim' });

  // applied ⇒ the EFFECTIVE (merged agent.json + agent.local.json) value should match the most recent
  // applied proposal. Use loadConfig() so a value applied to the base config — not just the local
  // override — counts as live (comparing only agent.local.json gives false positives). Fall back to
  // the local file if config can't be loaded (e.g. verifying stores outside a configured agent dir).
  let liveStrategy = {};
  try { liveStrategy = require('../config').loadConfig().strategy || {}; }
  catch { try { liveStrategy = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/agent.local.json'), 'utf8')).strategy || {}; } catch { /* none */ } }
  for (const [param, list] of Object.entries(byParam)) {
    const lastApplied = [...list].reverse().find(s => s.applied);
    if (lastApplied && liveStrategy[param] !== lastApplied.suggestedValue)
      rep.drift.push({ kind: 'applied_config_drift', store: 'suggested_config.json', id: param, evidence: `applied ${lastApplied.suggestedValue}, live agent.local=${liveStrategy[param] ?? '(unset)'}`, repair: 'manual' });
  }
}

function checkCursor(rep) {
  const st = readStore(D('chat_extract_state.json'));
  if (!st.exists) { rep.checks.push({ name: 'chat_extract_state', status: 'pass', detail: 'absent' }); return; }
  if (!st.val || typeof st.val.lastLine !== 'number') { rep.drift.push({ kind: 'schema_invalid', store: 'chat_extract_state.json', id: null, evidence: 'missing numeric lastLine', repair: 'manual' }); return; }
  const lines = archiveLineCount();
  if (lines != null && st.val.lastLine > lines)
    rep.drift.push({ kind: 'cursor_past_end', store: 'chat_extract_state.json', id: null, evidence: `lastLine ${st.val.lastLine} > archive ${lines} lines (rotated/truncated → extraction stalls)`, repair: 'clamp' });
  else if (lines == null && st.val.lastLine > 0)
    rep.drift.push({ kind: 'cursor_past_end', store: 'chat_extract_state.json', id: null, evidence: `lastLine ${st.val.lastLine} but archive is absent`, repair: 'clamp' });
}

// ── public API ───────────────────────────────────────────────────────────────
function verify() {
  const rep    = { ok: true, checks: [], drift: [] };
  const trades = readStore(D('trade_history.json'));
  if (trades.exists && !Array.isArray(trades.val))
    rep.drift.push({ kind: 'schema_invalid', store: 'trade_history.json', id: null, evidence: trades.error || 'not an array (grades cannot be verified)', repair: 'manual' });
  const th = Array.isArray(trades.val) ? trades.val : [];

  checkGrades(rep, th);
  checkEpisodes(rep);
  checkProposals(rep);
  checkCursor(rep);

  // one pass/fail check row per store touched by drift, for the human view
  const stores = ['strategy_grades.json', 'chat_episodes.json', 'suggested_config.json', 'chat_extract_state.json', 'trade_history.json'];
  for (const s of stores) {
    const n = rep.drift.filter(d => d.store === s).length;
    if (n) rep.checks.push({ name: s, status: 'fail', detail: `${n} drift` });
  }
  rep.ok = rep.drift.length === 0;
  return rep;
}

// Apply only the safe repairs implied by `report.drift`. Returns { applied[], skipped[] }.
function repair(report = verify()) {
  const applied = [], skipped = [];
  const byStore = s => report.drift.filter(d => d.store === s);

  // Grades — one canonical rebuild resolves every recompute/drop/trim drift at once.
  const gd = byStore('strategy_grades.json').filter(d => d.repair !== 'manual');
  if (gd.length) {
    const plan = planGrades();
    if (plan) { atomicWrite(D('strategy_grades.json'), plan); gd.forEach(d => applied.push({ ...d, action: 'grades recomputed from trade_history' })); }
    else skipped.push({ kind: 'grade_repair_unavailable', store: 'strategy_grades.json', reason: 'grades or trade_history not an array' });
  }

  // Episodes — trim to cap, drop empty gists.
  const ed = byStore('chat_episodes.json').filter(d => d.repair !== 'manual');
  if (ed.length) {
    const st = readStore(D('chat_episodes.json'));
    if (Array.isArray(st.val)) {
      const cleaned = st.val.filter(e => e && typeof e.gist === 'string' && e.gist.trim()).slice(-CAPS.episodes);
      atomicWrite(D('chat_episodes.json'), cleaned);
      ed.forEach(d => applied.push({ ...d, action: 'episodes trimmed/cleaned' }));
    }
  }

  // Proposals — trim to perParam cap (keep most recent per param). applied_config_drift stays manual.
  const pd = byStore('suggested_config.json').filter(d => d.kind === 'over_cap');
  if (pd.length) {
    const st = readStore(D('suggested_config.json'));
    if (Array.isArray(st.val)) {
      const keep = new Set();
      const byParam = {};
      for (let i = st.val.length - 1; i >= 0; i--) {                 // walk newest→oldest, keep last N per param
        const p = st.val[i].param;
        (byParam[p] ??= 0);
        if (byParam[p] < CAPS.perParam) { keep.add(i); byParam[p]++; }
      }
      atomicWrite(D('suggested_config.json'), st.val.filter((_, i) => keep.has(i)));
      pd.forEach(d => applied.push({ ...d, action: 'proposals trimmed per param' }));
    }
  }

  // Cursor — clamp to the archive length.
  const cd = byStore('chat_extract_state.json').filter(d => d.kind === 'cursor_past_end');
  if (cd.length) {
    atomicWrite(D('chat_extract_state.json'), { lastLine: archiveLineCount() ?? 0 });
    cd.forEach(d => applied.push({ ...d, action: 'cursor clamped to archive length' }));
  }

  // Everything left (manual): report, don't touch.
  report.drift.filter(d => d.repair === 'manual').forEach(d => skipped.push({ ...d, reason: 'manual review — not auto-repaired' }));
  return { applied, skipped };
}

function formatReport(rep) {
  const lines = [`Memory verify — ${rep.ok ? 'OK, all stores consistent' : rep.drift.length + ' drift item(s)'}`];
  for (const c of rep.checks) lines.push(`  ${c.status === 'pass' ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  if (rep.drift.length) {
    lines.push('Drift:');
    for (const d of rep.drift) lines.push(`  [${d.repair}] ${d.store}${d.id != null ? ` #${d.id}` : ''}: ${d.kind} — ${d.evidence}`);
  }
  return lines.join('\n');
}
function formatRepair(result) {
  const lines = [`Repair — ${result.applied.length} applied, ${result.skipped.length} skipped`];
  for (const a of result.applied) lines.push(`  ✓ ${a.store}${a.id != null ? ` #${a.id}` : ''}: ${a.action}`);
  for (const s of result.skipped) lines.push(`  · ${s.store}${s.id != null ? ` #${s.id}` : ''}: ${s.kind} — ${s.reason}`);
  return lines.join('\n');
}

module.exports = { verify, repair, planGrades, formatReport, formatRepair };

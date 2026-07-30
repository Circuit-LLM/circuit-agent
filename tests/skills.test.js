// tests/skills.test.js — skill library, load_skill hardening, and skill grading.
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const skills = require('../lib/skills');
const web    = require('../lib/tools/web');
const sync   = require('../scripts/sync-skill-docs');

const noopLog = () => {};

// ── Phase 1: the skill library is the single source of truth ──────────────────

test('skill library', async (t) => {
  await t.test('enumerates every directory that has a SKILL.md', () => {
    const onDisk = fs.readdirSync(skills.SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(skills.SKILLS_DIR, e.name, 'SKILL.md')))
      .map(e => e.name)
      .sort();
    assert.deepStrictEqual(skills.skillNames(), onDisk);
    assert.ok(onDisk.length > 0, 'expected at least one skill on disk');
  });

  await t.test('every skill has a non-empty description', () => {
    for (const s of skills.listSkills()) {
      assert.ok(s.description.length > 0, `${s.name} has no description`);
    }
  });

  await t.test('descriptions are stripped of Markdown syntax', () => {
    for (const s of skills.listSkills()) {
      assert.ok(!s.description.startsWith('#'), `${s.name} description is a heading`);
      assert.ok(!s.description.startsWith('>'), `${s.name} description keeps a blockquote marker`);
      assert.ok(!s.description.includes('**'), `${s.name} description keeps bold markers`);
    }
  });

  await t.test('describe() unwraps a blockquote callout', () => {
    const md = '# Skill: Thing\n\n> **Optional upgrade.** Use `foo` for [bar](http://x).\n';
    assert.strictEqual(skills.describe(md), 'Optional upgrade. Use foo for bar.');
  });

  await t.test('describe() skips YAML frontmatter', () => {
    assert.strictEqual(skills.describe('---\nname: x\n---\n\nReal description here.\n'), 'Real description here.');
  });

  await t.test('describe() truncates long lines', () => {
    const d = skills.describe('# H\n\n' + 'x'.repeat(500));
    assert.ok(d.length <= 140, `got ${d.length}`);
    assert.ok(d.endsWith('…'));
  });
});

// ── Phase 1: generated prompt text cannot drift ───────────────────────────────

test('generated skill lists stay in sync with disk', async (t) => {
  await t.test('load_skill tool description names every skill', () => {
    const def = web.DEFINITIONS.find(d => d.function.name === 'load_skill');
    for (const name of skills.skillNames()) {
      assert.ok(def.function.description.includes(name), `tool description omits '${name}'`);
      assert.ok(def.function.parameters.properties.skill.description.includes(name),
        `skill param hint omits '${name}'`);
    }
  });

  await t.test('risk-management and research are visible to the model', () => {
    // The regression that started this: both existed on disk but appeared in no
    // prompt text, so the model could not know to load them.
    const def = web.DEFINITIONS.find(d => d.function.name === 'load_skill');
    assert.ok(def.function.description.includes('risk-management'));
    assert.ok(def.function.description.includes('research'));
  });

  await t.test('soul.md and the doc tables list every skill', () => {
    const names = skills.skillNames();

    const soul = fs.readFileSync(path.join(__dirname, '../soul.md'), 'utf8');
    const block = sync.currentBlock(soul, 'skills-list');
    assert.ok(block, 'soul.md is missing its skills-list markers');
    for (const n of names) assert.ok(block.includes(n), `soul.md omits '${n}'`);

    for (const { file } of sync.CHECKED) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const seen = sync.mentionedSkills(text, names);
      const missing = names.filter(n => !seen.has(n));
      assert.deepStrictEqual(missing, [], `${file} omits ${missing.join(', ')}`);
    }
  });
});

// ── Phase 2: load_skill hardening ─────────────────────────────────────────────

test('load_skill input handling', async (t) => {
  // These exercise the real handler, which appends to the production usage log.
  // Snapshot and restore it so tests never leave entries in data/.
  const realLog = require('../lib/memory/skill-tracker').SKILL_LOG;
  const before = fs.existsSync(realLog) ? fs.readFileSync(realLog) : null;
  t.after(() => {
    if (before === null) fs.rmSync(realLog, { force: true });
    else fs.writeFileSync(realLog, before);
  });

  await t.test('rejects path traversal', async () => {
    for (const bad of ['../README', '../../etc/passwd', 'skills/../../README', '../ARCHITECTURE']) {
      const res = JSON.parse(await web.HANDLERS.load_skill({ skill: bad }, {}, noopLog));
      assert.ok(res.error, `'${bad}' was not rejected`);
      assert.strictEqual(res.content, undefined, `'${bad}' returned file content`);
    }
  });

  await t.test('rejects malformed names without touching the filesystem', () => {
    for (const bad of ['', '.', '..', 'UPPER', 'has space', 'semi;colon', null, undefined, 42, '-leading']) {
      assert.strictEqual(skills.isValidName(bad), false, `'${bad}' passed validation`);
      assert.strictEqual(skills.resolveSkillFile(bad), null, `'${bad}' resolved to a file`);
    }
  });

  await t.test('loads a real skill', async () => {
    const res = JSON.parse(await web.HANDLERS.load_skill({ skill: 'dip-reversal' }, {}, noopLog));
    assert.strictEqual(res.skill, 'dip-reversal');
    assert.ok(res.content.length > 100);
    assert.strictEqual(res.error, undefined);
  });

  await t.test('unknown skill lists the valid names', async () => {
    const res = JSON.parse(await web.HANDLERS.load_skill({ skill: 'nope' }, {}, noopLog));
    assert.ok(res.error.includes('not found'));
    assert.ok(res.error.includes('dip-reversal'));
  });

  await t.test('caps how much content one call can inject', () => {
    for (const name of skills.skillNames()) {
      const s = skills.readSkill(name);
      assert.ok(Buffer.byteLength(s.content, 'utf8') <= skills.MAX_SKILL_BYTES + 100,
        `${name} exceeds the injection cap`);
    }
  });

  await t.test('list_skills returns names and descriptions', async () => {
    const res = JSON.parse(await web.HANDLERS.list_skills({}, {}, noopLog));
    assert.strictEqual(res.count, skills.skillNames().length);
    assert.ok(res.skills.every(s => s.name && typeof s.description === 'string'));
  });
});

// ── Phases 3 & 4: usage logging and grading ───────────────────────────────────
//
// The tracker reads a fixed path under data/, so these tests point it at a temp
// dir via a fresh module instance rather than writing to the real log.

function withTempTracker(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltrack-'));
  const modPath = require.resolve('../lib/memory/skill-tracker');
  const original = fs.readFileSync(modPath, 'utf8');
  const patched = original.replace(
    "const DATA_DIR = path.join(__dirname, '../../data');",
    `const DATA_DIR = ${JSON.stringify(dir)};`
  );
  assert.notStrictEqual(patched, original, 'failed to redirect DATA_DIR — module layout changed');
  const tmpModule = path.join(dir, 'tracker.js');
  // Keep relative requires (../positions) resolving against the real lib dir.
  fs.writeFileSync(tmpModule, patched.replace(/require\('\.\.\/positions'\)/g,
    `require(${JSON.stringify(path.join(__dirname, '../lib/positions'))})`));
  try {
    return fn(require(tmpModule), dir);
  } finally {
    delete require.cache[tmpModule];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HOUR = 3_600_000;

/** Build a closed-trade record. */
function trade({ decisionId = null, pnlPct = 0, hoursAgo = 1, net = null }) {
  const entry = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  return {
    mint: 'M' + Math.abs(pnlPct) + hoursAgo + (decisionId ?? 'x'),
    entryTime: entry,
    exitTime: new Date(Date.now() - (hoursAgo - 0.5) * HOUR).toISOString(),
    pnlPct,
    netPnlPct: net,
    decisionId,
  };
}

test('skill usage logging', async (t) => {
  await t.test('writes an event per load and creates the log', () => {
    withTempTracker((tracker, dir) => {
      assert.strictEqual(tracker.logSkillUsage('dip-reversal', 'loaded', { decisionId: 'd1' }), true);
      tracker.logSkillUsage('scalping', 'loaded', { decisionId: 'd1' });
      const log = path.join(dir, 'skill_performance.jsonl');
      assert.ok(fs.existsSync(log), 'usage log was not created');
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 2);
      const first = JSON.parse(lines[0]);
      assert.strictEqual(first.skillName, 'dip-reversal');
      assert.strictEqual(first.decisionId, 'd1');
      assert.ok(first.timestamp);
    });
  });

  await t.test('load_skill actually logs a usage event', async () => {
    // Guards the original defect: logSkillUsage existed but nothing called it.
    const src = fs.readFileSync(path.join(__dirname, '../lib/tools/web.js'), 'utf8');
    assert.ok(/logSkillUsage\(/.test(src), 'load_skill no longer logs skill usage');
    assert.ok(/decisionId/.test(src), 'load_skill no longer records a decisionId');
  });

  await t.test('load_skill is not result-cached', () => {
    // executeTool short-circuits on cached results. Giving load_skill a TTL would
    // skip the handler on repeat loads and silently stop logging usage.
    const toolsSrc = fs.readFileSync(path.join(__dirname, '../lib/tools.js'), 'utf8');
    const ttlBlock = toolsSrc.slice(toolsSrc.indexOf('const TOOL_CACHE_TTL'), toolsSrc.indexOf('function _cacheKey'));
    assert.ok(!ttlBlock.includes('load_skill'), 'load_skill gained a cache TTL — usage logging would be skipped');
  });

  await t.test('prune drops events past retention and keeps fresh ones', () => {
    withTempTracker((tracker, dir) => {
      const log = path.join(dir, 'skill_performance.jsonl');
      const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
      fs.writeFileSync(log,
        JSON.stringify({ timestamp: old, skillName: 'stale', context: 'loaded' }) + '\n' +
        JSON.stringify({ timestamp: new Date().toISOString(), skillName: 'fresh', context: 'loaded' }) + '\n');

      assert.strictEqual(tracker.prune(), 1);
      const left = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.strictEqual(left.length, 1);
      assert.strictEqual(left[0].skillName, 'fresh');
      assert.strictEqual(tracker.prune(), 0, 'second prune should be a no-op');
    });
  });

  await t.test('prune on a missing log is a no-op', () => {
    withTempTracker(tracker => assert.strictEqual(tracker.prune(), 0));
  });
});

test('skill grading', async (t) => {
  await t.test('attributes a trade to skills from its own decision only', () => {
    withTempTracker(tracker => {
      tracker.logSkillUsage('good', 'loaded', { decisionId: 'd1' });
      tracker.logSkillUsage('other', 'loaded', { decisionId: 'd2' });

      const trades = [trade({ decisionId: 'd1', pnlPct: 10 }), trade({ decisionId: 'd2', pnlPct: -10 })];
      const grades = tracker.gradeSkills(trades, { minSkillTrades: 1, minBaselineTrades: 1 });

      const good = grades.find(g => g.skillName === 'good');
      assert.strictEqual(good.attributedTrades, 1);
      assert.strictEqual(good.baselineTrades, 1);
      assert.strictEqual(good.winRate, 1);
      assert.strictEqual(good.baselineWinRate, 0);
    });
  });

  await t.test('skills loaded in different rounds get independent grades', () => {
    // The old grader bucketed by calendar day, so two skills used the same day
    // scored identically even when their trades went opposite ways.
    // (Skills *always* loaded together remain indistinguishable — see the
    // co-linearity note in lib/memory/skill-tracker.js.)
    withTempTracker(tracker => {
      tracker.logSkillUsage('winner', 'loaded', { decisionId: 'w1' });
      tracker.logSkillUsage('winner', 'loaded', { decisionId: 'w2' });
      tracker.logSkillUsage('loser',  'loaded', { decisionId: 'l1' });
      tracker.logSkillUsage('loser',  'loaded', { decisionId: 'l2' });

      const trades = [
        trade({ decisionId: 'w1', pnlPct: 20, hoursAgo: 5 }),
        trade({ decisionId: 'w2', pnlPct: 15, hoursAgo: 4 }),
        trade({ decisionId: 'l1', pnlPct: -20, hoursAgo: 3 }),
        trade({ decisionId: 'l2', pnlPct: -15, hoursAgo: 2 }),
      ];
      const grades = tracker.gradeSkills(trades, { minSkillTrades: 2, minBaselineTrades: 2 });
      const w = grades.find(g => g.skillName === 'winner');
      const l = grades.find(g => g.skillName === 'loser');

      assert.notStrictEqual(w.pnlLift, l.pnlLift, 'co-loaded skills got identical grades');
      assert.ok(w.pnlLift > 0 && l.pnlLift < 0);
      assert.strictEqual(w.recommendation, 'KEEP');
      assert.strictEqual(l.recommendation, 'REVIEW');
    });
  });

  await t.test('withholds a verdict below the sample minimum', () => {
    withTempTracker(tracker => {
      tracker.logSkillUsage('thin', 'loaded', { decisionId: 'd1' });
      const trades = [trade({ decisionId: 'd1', pnlPct: 50 }), trade({ decisionId: 'd2', pnlPct: -5 })];
      const [g] = tracker.gradeSkills(trades);
      assert.strictEqual(g.recommendation, 'INSUFFICIENT_DATA');
      assert.strictEqual(g.advisory, true);
    });
  });

  await t.test('excludes autonomous trades that had no skill in context', () => {
    withTempTracker(tracker => {
      tracker.logSkillUsage('s', 'loaded', { decisionId: 'd1' });
      const trades = [
        trade({ decisionId: 'd1', pnlPct: 10 }),
        trade({ decisionId: null, pnlPct: -99, hoursAgo: 2 }),  // auto-scanner buy
        trade({ decisionId: null, pnlPct: -99, hoursAgo: 3 }),
      ];
      const [g] = tracker.gradeSkills(trades, { minSkillTrades: 1, minBaselineTrades: 0 });
      assert.strictEqual(g.attributedTrades, 1);
      assert.strictEqual(g.baselineTrades, 0, 'scanner trades leaked into the baseline');
    });
  });

  await t.test('counts real loads, independent of days active', () => {
    // The old grader incremented usageCount once per day, so it could only ever
    // equal daysActive.
    withTempTracker(tracker => {
      for (let i = 0; i < 5; i++) tracker.logSkillUsage('busy', 'loaded', { decisionId: 'd' + i });
      const [g] = tracker.gradeSkills([trade({ decisionId: 'd0', pnlPct: 1 })], { minSkillTrades: 1, minBaselineTrades: 0 });
      assert.strictEqual(g.usageCount, 5);
    });
  });

  await t.test('grades on net P&L when the trade recorded fees', () => {
    withTempTracker(tracker => {
      tracker.logSkillUsage('s', 'loaded', { decisionId: 'd1' });
      // Gross positive, net negative — must be scored as a loss.
      const [g] = tracker.gradeSkills(
        [trade({ decisionId: 'd1', pnlPct: 5, net: -12 })],
        { minSkillTrades: 1, minBaselineTrades: 0 });
      assert.strictEqual(g.winRate, 0, 'graded on gross P&L instead of net');
      assert.strictEqual(g.avgPnlPct, -12);
    });
  });

  await t.test('does not attribute trades from outside the window', () => {
    withTempTracker(tracker => {
      tracker.logSkillUsage('s', 'loaded', { decisionId: 'd1' });
      // Recent load, but the only matching trade is 40 days old. The skill is
      // still listed (it was used) with nothing attributed to it.
      const [g] = tracker.gradeSkills([trade({ decisionId: 'd1', pnlPct: 10, hoursAgo: 24 * 40 })], { windowDays: 14 });
      assert.strictEqual(g.skillName, 's');
      assert.strictEqual(g.attributedTrades, 0, 'stale trade was attributed');
      assert.strictEqual(g.recommendation, 'INSUFFICIENT_DATA');
    });
  });

  await t.test('drops skills whose last use predates the window', () => {
    withTempTracker(tracker => {
      const log = path.join(require('path').dirname(tracker.SKILL_LOG), 'skill_performance.jsonl');
      fs.writeFileSync(log, JSON.stringify({
        timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        skillName: 'ancient', context: 'loaded', decisionId: 'd1',
      }) + '\n');
      const grades = tracker.gradeSkills([trade({ decisionId: 'd1', pnlPct: 10 })], { windowDays: 14 });
      assert.deepStrictEqual(grades, [], 'skill unused within the window was still graded');
    });
  });

  await t.test('empty inputs return no grades rather than throwing', () => {
    withTempTracker(tracker => {
      assert.deepStrictEqual(tracker.gradeSkills([]), []);
      assert.deepStrictEqual(tracker.gradeSkills(), []);
    });
  });

  await t.test('summary reports advisory-only and never auto-disables', () => {
    withTempTracker(tracker => {
      tracker.logSkillUsage('s', 'loaded', { decisionId: 'd1' });
      const s = tracker.getSummary();
      assert.strictEqual(s.advisoryOnly, true);
      assert.ok(Array.isArray(s.allGrades));
      assert.ok(!s.allGrades.some(g => g.recommendation === 'DISABLE'),
        'grader still emits DISABLE, which no code is allowed to act on');
    });
  });
});

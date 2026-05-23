#!/usr/bin/env node
// scripts/update.js — safe upstream updater for circuit-agent
//
// Pulls the latest code from GitHub without overwriting your customizations.
// Your data, secrets, and personal config are always protected.
//
// Usage:
//   node scripts/update.js          — show what would change (dry run)
//   node scripts/update.js --apply  — apply safe upstream updates
//   node scripts/update.js --help   — show this help
//
// What is SAFE to update (overwritten from upstream):
//   lib/*.js, agent.js, soul.md, ARCHITECTURE.md, CONTRIBUTING.md,
//   SECURITY.md, config/reflect.md, config/heartbeat.md, config/agent.json,
//   skills/, scripts/, docs/, package.json
//
// What is YOURS (never touched):
//   data/          — positions, trade history, memories, profile, queue
//   .env           — secrets and API keys
//   soul.local.md  — your agent personality (overrides soul.md)
//   config/agent.local.json — your config overrides (overrides agent.json)
//   config/agent.json — always overwritten; put your tweaks in agent.local.json
//
// The recommended workflow:
//   1. Put your config tweaks in config/agent.local.json (not agent.json)
//   2. Put your soul edits in soul.local.md (not soul.md)
//   3. Run `node scripts/update.js --apply` to pull upstream improvements
//   4. Restart your agent

'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const { spawnSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const HELP  = process.argv.includes('--help') || process.argv.includes('-h');

// ── Files that belong to the repo and can be safely updated ───────────────────

const SAFE_PATTERNS = [
  'agent.js',
  'soul.md',
  'README.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'lib/',
  'skills/',
  'scripts/',
  'config/reflect.md',
  'config/heartbeat.md',
  'config/agent.json',
  'config/presets/',
  'docs/',
  'package.json',
];

// ── Files that are ALWAYS user-owned — never overwrite ────────────────────────

const PROTECTED = [
  'data/',
  '.env',
  '.env.local',
  'soul.local.md',
  'config/agent.local.json',
  'node_modules/',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, args, { cwd = ROOT, silent = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (!silent && r.stderr?.trim()) process.stderr.write(r.stderr + '\n');
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function print(msg)  { process.stdout.write(msg + '\n'); }
function ok(msg)     { print(`  ✓ ${msg}`); }
function warn(msg)   { print(`  ⚠ ${msg}`); }
function info(msg)   { print(`  → ${msg}`); }
function header(msg) { print(`\n${msg}\n${'─'.repeat(msg.length)}`); }

// ── Detect git remote ─────────────────────────────────────────────────────────

function detectRemote() {
  const r = run('git', ['remote', 'get-url', 'origin'], { silent: true });
  if (!r.ok) return null;
  return r.stdout.trim();
}

function isGitRepo() {
  return run('git', ['rev-parse', '--is-inside-work-tree'], { silent: true }).ok;
}

// ── Check for locally modified files ─────────────────────────────────────────

function locallyModified() {
  const r = run('git', ['status', '--porcelain'], { silent: true });
  return r.stdout.split('\n')
    .filter(Boolean)
    .map(l => l.slice(3).trim());
}

function hasLocalChanges(file) {
  const r = run('git', ['diff', '--name-only', 'HEAD', '--', file], { silent: true });
  return r.stdout.trim().length > 0;
}

// ── Get incoming changes from upstream ───────────────────────────────────────

function getUpstreamDiff(branch) {
  const r = run('git', ['diff', '--name-only', `origin/${branch}...HEAD`, '--'], { silent: true });
  // This shows files that differ between local HEAD and upstream
  // We actually want what's NEW in upstream vs us:
  const r2 = run('git', ['diff', '--name-only', `HEAD...origin/${branch}`, '--'], { silent: true });
  return r2.stdout.split('\n').filter(Boolean);
}

function getCurrentBranch() {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { silent: true });
  return r.stdout.trim() || 'main';
}

function isSafeFile(f) {
  return SAFE_PATTERNS.some(p => f === p || f.startsWith(p));
}

function isProtectedFile(f) {
  return PROTECTED.some(p => f === p || f.startsWith(p));
}

// ── Apply: checkout specific files from upstream ──────────────────────────────

function applyFile(file, branch) {
  const r = run('git', ['checkout', `origin/${branch}`, '--', file]);
  return r.ok;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (HELP) {
    print(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n'));
    process.exit(0);
  }

  print('\ncircuit-agent updater');
  print('═══════════════════');

  // 1. Verify we're in a git repo
  if (!isGitRepo()) {
    print('\n✗ Not a git repository.');
    print('  You downloaded circuit-agent as a zip rather than cloning it from GitHub.');
    print('  To enable updates, re-install by cloning:');
    print('    git clone https://github.com/Circuit-LLM/circuit-agent');
    print('  Then copy your .env and data/ directory into the new clone.\n');
    process.exit(1);
  }

  // 2. Check remote
  const remote = detectRemote();
  if (!remote) {
    print('\n✗ No git remote "origin" configured.');
    print('  Run: git remote add origin <your-fork-or-upstream-url>');
    process.exit(1);
  }
  ok(`Remote: ${remote}`);

  // 3. Fetch upstream
  info('Fetching upstream...');
  const fetch = run('git', ['fetch', 'origin', '--quiet']);
  if (!fetch.ok) {
    print('\n✗ git fetch failed — check your network connection.');
    process.exit(1);
  }
  ok('Fetched upstream');

  const branch = getCurrentBranch();
  ok(`Branch: ${branch}`);

  // 4. Check if upstream is ahead at all
  const behind = run('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { silent: true });
  const aheadN = parseInt(behind.stdout.trim() || '0', 10);

  if (aheadN === 0) {
    print('\n✓ Already up to date. Nothing to update.\n');
    process.exit(0);
  }
  info(`Upstream is ${aheadN} commit(s) ahead of your local version`);

  // 5. Get changed files
  const changedFiles = getUpstreamDiff(branch);
  if (!changedFiles.length) {
    print('\n✓ No file changes to apply.\n');
    process.exit(0);
  }

  // 6. Categorize changes
  const safeUpdates   = [];  // safe to pull from upstream
  const userOwned     = [];  // user's files — skip
  const needsReview   = [];  // user has modified locally AND upstream changed them
  const newFiles      = [];  // new files being added by upstream

  for (const f of changedFiles) {
    if (isProtectedFile(f)) {
      userOwned.push(f);
      continue;
    }
    if (isSafeFile(f)) {
      // Repo-owned files always apply — PROTECTED covers user-owned files
      safeUpdates.push(f);
    } else {
      // Unknown file — skip unless user explicitly checks it out
      needsReview.push(f);
    }
  }

  // 7. Report
  header('Safe to update (will apply)');
  if (safeUpdates.length) {
    safeUpdates.forEach(f => ok(f));
  } else {
    info('(none)');
  }

  if (needsReview.length) {
    header('Needs review (unknown files — skipped)');
    needsReview.forEach(f => warn(f));
    print('');
    print('  To see what changed upstream:');
    needsReview.forEach(f => print(`    git diff HEAD origin/${branch} -- ${f}`));
    print('');
    print('  To apply upstream version (overwrites your changes!):');
    needsReview.forEach(f => print(`    git checkout origin/${branch} -- ${f}`));
  }

  if (userOwned.length) {
    header('Protected (never touched)');
    userOwned.forEach(f => info(`${f}  ← yours`));
  }

  // 8. Apply if requested
  if (!APPLY) {
    print('\n────────────────────────────────────────');
    if (safeUpdates.length) {
      print(`Dry run — ${safeUpdates.length} file(s) ready to update.`);
      print('Run with --apply to apply them:\n');
      print('  node scripts/update.js --apply\n');
    } else {
      print('Nothing to apply automatically. Review the files above.\n');
    }
    process.exit(0);
  }

  // Apply mode
  if (!safeUpdates.length) {
    print('\nNothing safe to apply automatically.\n');
    process.exit(0);
  }

  header('Applying updates');
  let applied = 0;
  let failed  = 0;

  for (const f of safeUpdates) {
    const success = applyFile(f, branch);
    if (success) {
      ok(f);
      applied++;
    } else {
      warn(`Failed to apply: ${f}`);
      failed++;
    }
  }

  // npm install if package.json changed
  if (safeUpdates.includes('package.json')) {
    info('package.json changed — running npm install...');
    const install = run('npm', ['install', '--quiet'], { cwd: ROOT });
    if (install.ok) {
      ok('npm install complete');
    } else {
      warn('npm install failed — run manually: npm install');
    }
  }

  print('\n────────────────────────────────────────');
  print(`Update complete: ${applied} file(s) applied${failed ? `, ${failed} failed` : ''}.`);

  if (needsReview.length) {
    print(`\n${needsReview.length} file(s) skipped (local changes) — review manually above.`);
  }

  print('\nRestart your agent to pick up the changes:\n');
  print('  node agent.js start\n');
}

main().catch(err => {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
});

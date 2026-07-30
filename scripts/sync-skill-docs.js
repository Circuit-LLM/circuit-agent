#!/usr/bin/env node
// scripts/sync-skill-docs.js — keep every hand-written skill list in step with skills/.
//
// The skill library was declared in five places (soul.md, the load_skill tool
// description, the README table, the BUILDING table, ARCHITECTURE prose) and all
// five had drifted apart: soul.md listed 12 of 16, the README table 14, BUILDING
// 15. Skills missing from soul.md and the tool description are effectively
// invisible to the model, which is how a trading agent ended up unable to find
// its own risk-management skill.
//
// Two mechanisms, by intent:
//   * Generated blocks (soul.md) — plain lists with nothing worth curating are
//     rewritten from disk between BEGIN/END markers.
//   * Checked tables (README.md, BUILDING.md) — the prose columns are genuinely
//     useful, so these are only verified for completeness. A missing skill is
//     reported and fixed by hand.
// The load_skill tool description needs neither: it is built from disk at runtime.
//
// Usage:
//   node scripts/sync-skill-docs.js            # check only, exit 1 on drift
//   node scripts/sync-skill-docs.js --write    # rewrite generated blocks
'use strict';

const fs   = require('fs');
const path = require('path');

const skills = require('../lib/skills');

const ROOT = path.join(__dirname, '..');

const BEGIN = name => `<!-- BEGIN:${name} -->`;
const END   = name => `<!-- END:${name} -->`;

/** Files with a marker block that is regenerated verbatim from disk. */
const GENERATED = [
  {
    file:   'soul.md',
    marker: 'skills-list',
    render: names =>
      `- **load_skill** — load a skill: ${names.join(', ')}`,
  },
];

/** Files with curated tables that must merely mention every skill. */
const CHECKED = [
  { file: 'README.md',   label: 'skill table' },
  { file: 'BUILDING.md', label: 'skill library table' },
];

function replaceBlock(text, marker, body) {
  const begin = BEGIN(marker);
  const end   = END(marker);
  const start = text.indexOf(begin);
  const stop  = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    throw new Error(`markers ${begin} / ${end} not found or out of order`);
  }
  return text.slice(0, start + begin.length) + '\n' + body + '\n' + text.slice(stop);
}

function currentBlock(text, marker) {
  const begin = BEGIN(marker);
  const end   = END(marker);
  const start = text.indexOf(begin);
  const stop  = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return text.slice(start + begin.length, stop).trim();
}

/** Skill names mentioned as `name` in a Markdown table row. */
function mentionedSkills(text, names) {
  return new Set(names.filter(n => new RegExp('\\|\\s*`' + n + '`\\s*\\|').test(text)));
}

function main() {
  const write = process.argv.includes('--write');
  const names = skills.skillNames();

  if (!names.length) {
    console.error('✗ no skills found on disk — refusing to rewrite docs');
    process.exit(1);
  }

  const problems = [];

  for (const { file, marker, render } of GENERATED) {
    const full = path.join(ROOT, file);
    const text = fs.readFileSync(full, 'utf8');
    const want = render(names);
    const have = currentBlock(text, marker);

    if (have === null) {
      problems.push(`${file}: missing ${BEGIN(marker)} / ${END(marker)} markers`);
      continue;
    }
    if (have === want) continue;

    if (write) {
      fs.writeFileSync(full, replaceBlock(text, marker, want));
      console.log(`✓ ${file}: regenerated ${marker}`);
    } else {
      problems.push(`${file}: ${marker} is stale (run: node scripts/sync-skill-docs.js --write)`);
    }
  }

  for (const { file, label } of CHECKED) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const seen = mentionedSkills(text, names);
    const missing = names.filter(n => !seen.has(n));
    if (missing.length) {
      problems.push(`${file}: ${label} is missing ${missing.join(', ')} — add a row by hand`);
    }
  }

  if (problems.length) {
    console.error('✗ skill docs out of sync:');
    problems.forEach(p => console.error(`  - ${p}`));
    process.exit(1);
  }

  console.log(`✓ skill docs in sync (${names.length} skills)`);
}

if (require.main === module) main();

module.exports = { mentionedSkills, currentBlock, replaceBlock, GENERATED, CHECKED };

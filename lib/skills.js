// lib/skills.js — single source of truth for the skill library.
//
// Every consumer (the load_skill/list_skills tools, the doc sync script, the
// skill tracker) enumerates skills through here so the on-disk `skills/`
// directory is the only place a skill is declared. Hand-maintained skill lists
// in prompts and docs drifted repeatedly — see scripts/sync-skill-docs.js.
'use strict';

const fs   = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '../skills');

// swarm-analyst, the largest real skill, is ~15KB. 32KB leaves generous room to
// grow while still capping how much a single load_skill call can inject into the
// model's context.
const MAX_SKILL_BYTES = 32_000;

// Skill names map to directory names. Anything outside this shape is rejected
// before it reaches the filesystem, which is what stops `../README` from being
// read as a "skill".
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function isValidName(name) {
  return typeof name === 'string' && name.length <= 64 && NAME_RE.test(name);
}

/** True when `target` sits inside `dir` (both already real paths). */
function _within(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve a skill name to its Markdown file, or null.
 *
 * Defence in depth: NAME_RE alone already blocks traversal, but the realpath
 * containment check also catches a symlink planted inside skills/ that points
 * out of the tree.
 */
function resolveSkillFile(name) {
  if (!isValidName(name)) return null;

  let root;
  try { root = fs.realpathSync(SKILLS_DIR); } catch { return null; }

  const candidates = [
    path.join(SKILLS_DIR, name, 'SKILL.md'),
    path.join(SKILLS_DIR, `${name}.md`),
  ];

  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);   // throws when missing
      if (fs.statSync(real).isFile() && _within(root, real)) return real;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * First line of prose in a SKILL.md, cleaned up for display.
 *
 * Skips headings and frontmatter fences. Blockquotes are kept but unwrapped —
 * the `infisical` and `playwright` skills open with a `> **Optional upgrade.**`
 * callout that is genuinely their description, and used to reach the model with
 * the raw Markdown still attached.
 */
function describe(markdown, maxLen = 140) {
  const lines = markdown.split('\n');
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    if (i === 0 && line === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (line === '---') inFrontmatter = false; continue; }

    if (!line) continue;
    if (line.startsWith('#')) continue;          // heading
    if (line.startsWith('```')) continue;        // code fence

    line = line.replace(/^>\s*/, '')             // blockquote marker
               .replace(/^[-*+]\s+/, '')         // list bullet
               .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
               .replace(/`([^`]+)`/g, '$1')      // inline code
               .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links → text
               .trim();

    if (!line) continue;
    return line.length > maxLen ? line.slice(0, maxLen - 1).trimEnd() + '…' : line;
  }
  return '';
}

/** Every skill on disk, alphabetically: [{ name, description }]. */
function listSkills() {
  let entries;
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); }
  catch { return []; }

  return entries
    .filter(e => e.isDirectory() && isValidName(e.name))
    .map(e => {
      const file = resolveSkillFile(e.name);
      if (!file) return null;                     // directory without a SKILL.md
      try {
        return { name: e.name, description: describe(fs.readFileSync(file, 'utf8')) };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Just the names — used to build prompt text and validate input. */
function skillNames() {
  return listSkills().map(s => s.name);
}

/**
 * Read a skill's content.
 * @returns {{name, content, bytes, truncated}|null} null when the name is
 *   invalid or no such skill exists.
 */
function readSkill(name) {
  const file = resolveSkillFile(name);
  if (!file) return null;

  let content = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const truncated = bytes > MAX_SKILL_BYTES;
  if (truncated) {
    content = content.slice(0, MAX_SKILL_BYTES) + '\n\n[skill truncated — file exceeds size limit]';
  }
  return { name, content, bytes, truncated };
}

module.exports = {
  SKILLS_DIR,
  MAX_SKILL_BYTES,
  isValidName,
  resolveSkillFile,
  describe,
  listSkills,
  skillNames,
  readSkill,
};

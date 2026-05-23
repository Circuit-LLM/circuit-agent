// lib/tools/web.js — web search, URL fetch, and skill tool definitions and handlers
'use strict';

const fs   = require('fs');
const path = require('path');

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo. Use for current events, token news, protocol updates, or anything beyond training data. Do not say "I cannot access the internet" — use this tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of a specific URL. Use to read articles, docs, or any web page the user shares.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  // ── Skill tools ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List all available skills you can load. Use this to discover what knowledge is available before calling load_skill.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Load a specialized skill/strategy context to guide your current task. Call list_skills first to see available skill names. Skills cover: dip-reversal, momentum-trading, scalping, exit-strategy, yield-farming, market-analysis, position-management, rug-detection, swarm-analyst, survival, builder, playwright, infisical.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill name (e.g. dip-reversal, rug-detection, swarm-analyst, builder, momentum-trading, playwright, infisical)' },
        },
        required: ['skill'],
      },
    },
  },
];

const HANDLERS = {
  async web_search(args, _ctx, _log) {
    const url  = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query ?? '')}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return JSON.stringify({ error: `Search ${resp.status}` });

    const html    = await resp.text();
    const results = [];
    const linkRx  = /class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)</g;
    const snippRx = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links   = [];
    let m;

    while ((m = linkRx.exec(html)) !== null) {
      let href = m[1];
      if (href.includes('uddg=')) {
        try { href = decodeURIComponent(new URLSearchParams(href.split('?')[1]).get('uddg') ?? href); } catch { /* keep */ }
      }
      links.push({ url: href, title: stripHtml(m[2]).trim() });
    }
    const snippets = [];
    while ((m = snippRx.exec(html)) !== null) snippets.push(stripHtml(m[1]).trim());

    for (let i = 0; i < Math.min(links.length, 5); i++) {
      results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? '' });
    }
    return JSON.stringify(results.length ? { results, query: args.query } : { message: 'No results', query: args.query });
  },

  async fetch_url(args, _ctx, _log) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp  = await fetch(args.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return JSON.stringify({ error: `Fetch ${resp.status}` });
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('text/') && !ct.includes('application/json')) {
      return JSON.stringify({ error: `Unsupported content type: ${ct}` });
    }
    let text = stripHtml(await resp.text());
    if (text.length > 3000) text = text.slice(0, 3000) + '\n[truncated]';
    return JSON.stringify({ url: args.url, content: text });
  },

  async list_skills(_args, _ctx, _log) {
    const skillsDir = path.join(__dirname, '../../skills');
    const entries   = fs.readdirSync(skillsDir, { withFileTypes: true });
    const skills    = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) return null;
        const lines   = fs.readFileSync(skillMd, 'utf8').split('\n');
        const descLine = lines.find(l => l.trim() && !l.startsWith('#')) || '';
        return { name: e.name, description: descLine.trim().slice(0, 100) };
      })
      .filter(Boolean);
    return JSON.stringify({ skills, count: skills.length });
  },

  async load_skill(args, _ctx, log) {
    const { skill } = args;
    const skillsDir = path.join(__dirname, '../../skills');
    const subdirFile = path.join(skillsDir, skill, 'SKILL.md');
    const flatFile   = path.join(skillsDir, `${skill}.md`);
    let skillFile = null;
    if (fs.existsSync(subdirFile)) skillFile = subdirFile;
    else if (fs.existsSync(flatFile)) skillFile = flatFile;
    if (!skillFile) {
      const available = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      return JSON.stringify({ error: `Skill '${skill}' not found. Available: ${available.join(', ')}` });
    }
    const content = fs.readFileSync(skillFile, 'utf8');
    log('info', `Skill loaded: ${skill}`);

    // Track skill usage in profile
    try {
      const { loadProfile } = require('../profile');
      const profilePath = path.join(__dirname, '../../data/agent-profile.json');
      const profile = loadProfile();
      if (profile && !profile.specialization?.skills?.includes(skill)) {
        profile.specialization = profile.specialization ?? {};
        profile.specialization.skills = profile.specialization.skills ?? [];
        profile.specialization.skills.push(skill);
        const tmp = profilePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
        fs.renameSync(tmp, profilePath);
        log('info', `Profile updated: added skill '${skill}'`);
      }
    } catch { /* non-fatal */ }

    return JSON.stringify({ skill, content });
  },
};

module.exports = { DEFINITIONS, HANDLERS };

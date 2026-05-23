# Contributing

circuit-agent is open source under the MIT license. Contributions are welcome — bug fixes, new skills, new tools, performance improvements, and documentation.

---

## Development Setup

```bash
git clone https://github.com/Circuit-LLM/circuit-agent
cd circuit-agent
npm install
cp .env.example .env          # Fill in your keys
node agent.js init            # Generate wallet + register with swarm
```

For development, you can run without Telegram by using the CLI:

```bash
node agent.js send "scan the market"   # Test LLM + tools
node agent.js scan                     # Test the scanner
node agent.js wallet                   # Test wallet connection
```

---

## Adding a Skill

Skills are Markdown knowledge files — no code required.

1. Create a directory: `skills/<your-skill-name>/`
2. Create `skills/<your-skill-name>/SKILL.md`

The SKILL.md is read by the LLM when the agent calls `load_skill("<your-skill-name>")`. Write it in first-person, as if the agent is reading a reference guide it wrote for itself.

**Good skill content:**
- Specific numeric thresholds (not vague rules)
- Decision trees with clear if/then logic
- Examples of good vs. bad signals
- Failure modes to watch for

**Example structure:**
```markdown
# <Skill Name>

<1-2 sentence summary of what this skill covers>

## When to use this skill
...

## Core rules
...

## Decision guide
...

## Failure modes
...
```

The new skill will appear in `list_skills` output immediately — no code changes needed.

---

## Adding a Tool

Tools are LLM-callable functions defined in `lib/tools/`.

1. Find the right category file, or create a new one:
   - `lib/tools/market.js` — read-only Solana/crypto data
   - `lib/tools/trading.js` — trade execution (buy, sell, wallet)
   - `lib/tools/swarm.js` — swarm signals, tasks, consensus
   - `lib/tools/memory.js` — per-user and agent-self memory
   - `lib/tools/self.js` — agent self-improvement (history, config, strategy, skills)
   - `lib/tools/web.js` — web search, URL fetch
   - `lib/tools/builder.js` — read/write files, run scripts

2. Add a definition to the file's `DEFINITIONS` array (OpenAI function-calling format):
```js
{
  type: 'function',
  function: {
    name: 'my_tool',
    description: 'Clear one-sentence description of what this does.',
    parameters: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'What this param is' },
      },
      required: ['param1'],
    },
  },
},
```

3. Add a handler to the file's `HANDLERS` object:
```js
HANDLERS = {
  // ...existing tools...
  async my_tool(args, ctx, log) {
    const { api } = ctx;
    const result = await api.someCall(args.param1);
    return JSON.stringify(result ?? { error: 'Unavailable' });
  },
};
```

4. If your tool result should be cached (read-only tools), add it to `TOOL_CACHE_TTL` in `lib/tools.js`:
```js
const TOOL_CACHE_TTL = {
  // ...
  my_tool: 5 * 60_000,  // cache for 5 minutes
};
```

That's it — `lib/tools.js` picks up new tools automatically via spread merge.

**Tool handler rules:**
- Always return `JSON.stringify({...})` — never throw
- Use `log('info', ...)` for significant actions, `log('warn', ...)` for soft failures
- Action tools (buy, sell, publish) must never be cached
- Read-only tools should have a TTL in `TOOL_CACHE_TTL`
- Guard required params: `if (!args.mint) return JSON.stringify({ error: 'mint required' })`

---

## Extending the Agent Loop

`lib/agent-loop.js` runs every ~90 minutes and sets the session strategy. It's the natural home for any periodic scheduled work — the equivalent of adding a cron job, but inside the long-running process.

Add your logic inside `runLoop()`:

```js
async function runLoop(positions) {
  // existing strategy logic...
  if (!isStrategyFresh()) { /* ... */ }

  // add your periodic task here
  await myPeriodicTask(positions);
}
```

**Pattern:** write state to `data/` so other loops can consume it.

```js
async function classifyRegime(api) {
  const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  const regime = ctx.sol?.change24h > 2 ? 'bull' : ctx.sol?.change24h < -5 ? 'bear' : 'ranging';
  fs.writeFileSync(path.join(DATA_DIR, 'regime.json'), JSON.stringify({ regime, updatedAt: new Date() }));
}
```

Then any other module (heartbeat, scanner, reflect) reads `data/regime.json` without any coupling to the loop.

**Good uses for the agent loop:**
- Market regime classification (bull/bear/ranging)
- Daily session goal-setting (morning aggressive, evening watchOnly)
- Swarm health digest (summarize peer signals into a note)
- Research tasks (fetch news, summarize into `data/`)

---

## Adding a Strategy

Custom strategy scripts live in `lib/strategies/`. See `lib/strategies/README.md` for the template and conventions.

---

## Code Style

- `'use strict'` at the top of every file
- Module-level constants in `SCREAMING_SNAKE_CASE`
- Private functions prefixed with `_`
- Logging: `log('info' | 'warn' | 'error', message, optionalDataObject)`
- Atomic file writes: write to `.tmp`, then `fs.renameSync(tmp, final)`
- Error handling: catch at the boundary, log, return a graceful fallback — don't let one failure crash the loop
- No external runtime dependencies beyond what's in `package.json` — keep the dep tree small

---

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include a description of what changed and why
- Test manually: `node agent.js wallet`, `node agent.js scan`, `node agent.js send "test message"`
- Do not commit `.env`, `data/`, `config/agent.local.json`, or `soul.local.md`
- Do not introduce new npm dependencies without discussion

---

## What to Work On

Good first contributions:
- New skills in `skills/` (no code, just domain knowledge)
- Bug reports with reproduction steps
- Documentation improvements

Bigger contributions worth discussing first:
- New tools in `lib/tools/`
- New data sources in the CIRCUIT API integration
- Strategy modules in `lib/strategies/`
- Test coverage

Open an issue before starting large changes so we can align on approach.

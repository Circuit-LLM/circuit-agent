# Memory — the read-back system

circuit-agent's memory is built on one principle: **a memory is only worth keeping if
something reads it back into a decision.** Every level below both *writes* a memory and
*reads it back* into the exact place the agent could use it — the 90-minute strategy brief,
the 4-hour reflect, the config-tuning tool, or the chat prompt. A store that's written and
never read is just disk usage; this system doesn't add any.

It's **five toggleable levels, off by default.** With `memory.enabled: false` (the default)
every path falls back to the agent's original behavior — the feature is completely inert
until you opt in, per deployment.

No embeddings, no vector database, no new infrastructure. Relevance is **lexical**
(term-overlap weighted by inverse document frequency × recency), which is free, deterministic,
and more than enough at the store sizes involved (tens to a few hundred entries).

---

## The five levels

| Level | Writes | Reads back into | Fires |
|---|---|---|---|
| **planGrading** | grades each expiring strategy vs the trades that closed in its window → `data/strategy_grades.json` | the **strategy brief** — the LLM sees "active/REVERSAL: hurt (−3% / 4 trades)" before choosing the next strategy | agent-loop, at each strategy re-set (~90 min / on expiry) |
| **tradeRecall** | — (reads `data/trade_history.json`) | the **strategy brief** — an exit-reason breakdown ("dead-money ×4, stop-loss ×2 …") so the LLM steers toward what profits | agent-loop, each brief |
| **proceduralHistory** | keeps the full trail of config-parameter proposals instead of overwriting by param → `data/suggested_config.json` | the `update_config` result — the LLM sees a param's prior proposals so it stops re-proposing what already failed | on demand, every `update_config` call |
| **chatExtraction** | mines new `conversation_archive.jsonl` lines → durable facts (into notes/user-memory) + one episode gist per batch → `data/chat_episodes.json` | (feeds the notes + episode stores that get injected) | reflect (~4 h), off the chat hot path |
| **episodeRecall** | — (reads `data/chat_episodes.json`) | the **chat system prompt** — the past conversation episodes most relevant to the current message | per chat message |

Plus one shared enabling module, `lib/llm-client.js`, which centralizes the OpenAI-compatible
client resolution (model / provider / baseURL) so reflect-time code builds the identical client
the message processor uses.

## Why it's split this way

Memory feeds the agent's two **LLM decision surfaces** — the strategy brief (`agent-loop.js`)
and reflect (`reflect.js`) — plus the chat prompt. It deliberately does *not* touch the
deterministic buy path (`scoreDipReversal` → executor): there's no prompt there to enrich.
Each level is one small file under `lib/memory/`, matching the `lib/tools/` convention — add or
remove a file to add or remove a capability.

---

## Configuration

Add a `memory` block to `config/agent.json` (defaults) or `config/agent.local.json` (per-agent
override). Master `enabled: false` keeps everything inert.

```json
"memory": {
  "enabled":           false,
  "planGrading":       true,
  "proceduralHistory": true,
  "tradeRecall":       true,
  "episodeRecall":     false,
  "chatExtraction":    false,
  "consolidation":     false
}
```

| Flag | Default | What it does |
|---|---|---|
| `enabled` | `false` | Master switch. Off ⇒ every level falls back to the original behavior. |
| `planGrading` | `true` | Grade strategies and inject recent outcomes into the brief. |
| `proceduralHistory` | `true` | Keep the config-change trail and surface it before the next tune. |
| `tradeRecall` | `true` | Inject the exit-reason breakdown into the brief. |
| `episodeRecall` | `false` | Inject relevant past conversation episodes into chat. Needs a populated episode store. |
| `chatExtraction` | `false` | Mine the chat archive into durable facts + episode gists. |
| `consolidation` | `false` | *Reserved* — lexical dedup/decay of the episode store. Not yet wired; currently a no-op. |

The three trading levels (`planGrading`, `proceduralHistory`, `tradeRecall`) default on because
they're cheap and act on decisions the agent makes autonomously all day. The two chat levels
default off — they only pay off with real operator conversation to mine (see Deployment
profiles).

---

## Data stores

All bounded — the footprint is flat regardless of lifetime volume.

| File | Written by | Cap |
|---|---|---|
| `data/strategy_grades.json` | planGrading | 50 grades (rolling) |
| `data/chat_episodes.json` | chatExtraction | 300 episodes (rolling) |
| `data/chat_extract_state.json` | chatExtraction | cursor (last archive line read) |
| `data/suggested_config.json` | proceduralHistory | 8 proposals per param |
| `data/trade_history.json` | (existing) | 200 trades — read by planGrading/tradeRecall |
| `data/agent-notes.json`, `data/users/<id>/memory.json` | (existing) | 30 / 50 — fed by chatExtraction |

Note: enabling `planGrading` adds a `setAt` timestamp to `data/session_strategy.json` at each
strategy set (used to bound the grading window). It's preserved across counter/extend writes and
is inert when the level is off.

---

## Deployment profiles

circuit-agent runs in two very different shapes, and memory is tuned for both:

- **Trading swarm agent** — the *trading* memory (planGrading, tradeRecall, proceduralHistory)
  is where the value is: the agent learns from its own strategy and config decisions. The *chat*
  memory (chatExtraction, episodeRecall) has little to work with — a swarm agent's archive is
  mostly its own heartbeat/reflect chatter — so those default off.
- **General-purpose / assistant agent** — turn the chat levels on. The same extraction/recall
  machinery fills with *your* conversations and becomes a genuine remembering assistant (facts +
  gists, not a verbatim transcript). Bounded, so lifetime chat volume stays flat on disk.

## Enabling it

1. Set `memory.enabled: true` (plus the levels you want) in one agent's `config/agent.local.json`.
2. Restart that agent. Every level checks its flag and falls through to the original code path
   when off, so this is reversible with no data migration.
3. Prefer a **canary** — enable on one agent, watch its next strategy brief (for the grade + exit
   breakdown) and a reflect cycle, before enabling fleet-wide. Two agents with identical strategy
   config differing only in `memory.enabled` give a clean read on its effect.

## What it is not

- **Not a transcript store.** It remembers *facts* and *gists*, not verbatim messages.
- **Not on any hot path.** Writes stay synchronous and instant; all LLM/embedding-free relevance
  work rides the existing 90-minute and 4-hour loops or the on-demand tool call.
- **Not unbounded.** Every store is capped; "summarize, don't hoard" keeps footprint flat.

## Tests

`npm test` covers the pure functions here — `recall.rank`, `procedural.appendWithHistory` /
`priorChanges` — alongside `scoreDipReversal`. See `tests/memory.test.js`.

# Skill: Research

How to answer an open-ended question by gathering, weighing, and citing
sources — instead of answering from memory. This is the same skill mechanism the
trading skills use, pointed at a non-trading domain: proof that Layer 3 generalizes.

## The one rule

**Never present a claim you sourced from the web without saying where it came
from.** If you can't find a source, say so — a confident guess dressed up as fact
is worse than "I don't know."

---

## When to load this skill

- The user asks about something time-sensitive (prices, news, current events,
  "latest").
- The user asks you to compare options (tools, services, approaches) where being
  wrong is costly.
- You notice you're about to answer from training data on a topic that changes
  month to month.

## Research loop

1. **Decompose** the question into 2–4 concrete sub-questions.
2. **Search** each sub-question separately with `web_search` — a single broad
   query returns shallow results.
3. **Read**, don't skim — `fetch_url` the 2–3 most relevant results per
   sub-question rather than trusting search snippets.
4. **Cross-check** — if two independent sources disagree, say so instead of
   silently picking one.
5. **Cite** — every factual claim in the final answer gets a source next to it,
   not bundled into a links list at the end.

## Source quality

| Signal | Weight it up | Weight it down |
|---|---|---|
| Primary source (docs, filings, the actual repo) | Yes | — |
| Recent (matches the question's time sensitivity) | Yes | — |
| Aggregator / listicle restating others | — | Yes |
| No byline, no date | — | Yes |

## Saying "I don't know"

If searches come back thin or contradictory, tell the user exactly that — which
sub-question you couldn't resolve and what you tried — rather than filling the gap
with a plausible-sounding guess. `save_memory` the gap if it's something the user
will likely ask again.

## Tools to use

- `web_search` — broad discovery, one sub-question at a time
- `fetch_url` — full-text read of a specific result before citing it
- `save_memory` — record durable facts the user will reference again

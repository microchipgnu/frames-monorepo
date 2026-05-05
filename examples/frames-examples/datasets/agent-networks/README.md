# agent-networks

Open questions about the emerging agent / machine-network economy. One
entity per question — the question text is stable, but the surrounding
evidence and current synthesis update over time.

The dataset answers: *what's the live state of debate on each question,
who's taking which position, and what just shipped that moves the
needle?*

## In scope

- Discovery, identity, payments, reputation, network effects, ownership,
  and governance questions for agent-to-agent commerce and machine
  networks.
- Named actors with public positions or shipped products (Stripe, Exa,
  Parallel, MoltBook, agentwallet, x402, Polygon, etc.).
- Concrete recent signals: launches, partnerships, regulatory moves,
  funding events, technical milestones.

## Out of scope

- Generic AI commentary not tied to a network/economy claim.
- Speculation without a named actor or shipped artifact.
- Reworking the 10 canonical questions. They are immutable — locked at
  commit `be7e142`. They can transition status (including to `moot`),
  but their text and entity_id never change without a PR.
- Question additions outside the discovery bar. The tick may admit at
  most 1 new question per run, and only when ≥ 2 distinct named
  operators / analysts have raised it publicly within the last 90 days.

## Refresh policy

Daily tick. Each run refreshes the **2–3 stalest questions** (those with
the oldest `last_reviewed_at`). Full coverage rotates over ~4 days.

Status transitions:

- `open` → `narrowing` once a small set of credible answers is in play
- `narrowing` → `resolved` once a default answer has emerged across the
  major actors
- any → `moot` if the question stops being load-bearing

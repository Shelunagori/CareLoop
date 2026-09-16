# 16. Demo-history fixture strategy

## 16.1 The rule

The fixture is **a list of timestamped utterances and nothing else**. It
contains no entities, no relationships, no episodes, no events and no baselines.
Those are *produced* by running the real ingestion pipeline over the utterances
with the `Clock` port set to each historical timestamp.

```ts
// fixtures/demo-george/timeline.ts
export const timeline: SeedTurn[] = [
  { at: '2026-06-07T10:12:00Z', role: 'user',
    text: "John came round yesterday with Simba. That dog gets muddier every week." },
  { at: '2026-06-07T10:12:30Z', role: 'assistant', text: '…' },
  { at: '2026-06-15T09:40:00Z', role: 'user',
    text: "Quiet weekend. John's away with work." },
  // ~40 turns over ~14 weeks
]
```

**Why this and not a SQL seed:** a SQL seed would let the demo pass while the
production pipeline is broken, which makes the demo worthless as evidence and
the fixture worthless as a test. Replaying through the real pipeline means the
demo *is* an end-to-end assertion that extraction, resolution, event derivation
and baseline computation all work — and it structurally satisfies your
"no special production logic for demo users" requirement, because there is no
demo-specific code path to write. A new user and George differ only in how many
rows they have.

## 16.2 Two replay modes

| Mode | Extraction source | Use |
|---|---|---|
| `--live` | real OpenAI calls | authoring the fixture; validating the pipeline; slow, costs money, non-deterministic |
| `--recorded` (default) | `recorded-extractions.json`, keyed by hash of (prompt version, utterance) | demo, CI, local dev; instant, free, deterministic |

`--live` writes the recordings as a side effect, so the recorded file is
generated, committed, and regenerated when a prompt version changes. On a
recording miss in `--recorded` mode the seeder fails loudly rather than skipping
— a silent miss would produce a subtly wrong demo.

**Why record at the extraction boundary specifically:** it's the only
non-deterministic input to everything downstream. Recording there makes the
entire deterministic half — resolution, events, baselines, detection,
suppression, consent — reproducible byte-for-byte, which is what lets the demo
be trustworthy and the tests be fast.

## 16.3 What the fixture is designed to produce

A ~14-week history that yields: John as a confirmed son, Simba as a confirmed
dog linked to John, a visit cadence of roughly 7 days with low dispersion
(`ACTIVE` baseline, ~9 contributing events, median 7 / MAD 1 → a **threshold of
11 days**), a set of warm episodes with real salience spread, and a deliberate
13-day gap ending at "today" so the cadence detector fires on first load
(13 > 11). The fixture is tuned against the corrected arithmetic (R5) — the
margin is deliberately only two days, so a threshold regression breaks the demo
loudly instead of silently widening it. Plus one deliberately ambiguous mention, so the
entity-resolution clarifying question can be demonstrated rather than described.

Seeding is behind `POST /api/dev/seed`, gated on `NODE_ENV !== 'production'`
**and** a shared secret, creating a fresh user each time. "New User" is simply
not calling it.

# 17. Testing strategy

Five layers, deliberately weighted toward the cheap ones.

**1. Pure unit tests on `core/` — the bulk of the suite.** Baseline computation,
thresholds, detectors, suppression, consent machine, entity-resolution rules,
salience, output guard, payload minimization. Includes a table-driven case for
the threshold formula itself (`median 7, MAD 1 → 11`, and the cases where each
of the four terms is the binding one) — the arithmetic was wrong in the first
draft, which is exactly the kind of error a worked example in a doc hides and a
test does not. No database, no network, no mocks
— these are functions over literals. This is the return on the pure-core
decision: the rules that matter most are the cheapest to test.

**2. Property tests on the pattern engine.** Generate random event series and
assert invariants that must hold for *all* inputs:
- never `ACTIVE` below the evidence gates;
- an `IRREGULAR` series never produces a `cadence_gap` signal;
- baseline output depends only on the event set (same `inputs_hash` → same
  result), so it is order-independent and re-runnable;
- **baseline status is invariant to `now`** — appending days of silence to a
  series never changes `ACTIVE` to `NO_BASELINE` (the R4 regression, pinned);
- **cadence threshold is monotonic** in `median` and `MAD`, and never below the
  absolute floor;
- suppression never permits two open opportunities for one entity.

**3. Golden tests on ingestion.** Fixed utterance + recorded extraction JSON →
assert the resulting database state (entities, relationships, episodes, events).
Tests the deterministic half of ingestion at full fidelity with zero LLM cost.
Adding a case is: paste an utterance, record once, commit. Two cases are
mandatory because they pin R6 in opposite directions:

- **replay idempotency** — running the same observation through ingestion twice
  yields exactly one `interaction_event`;
- **same-day distinctness** — "John called this morning" and "John called again
  this evening" yield **two** events, and `computeBaseline` then counts them as
  one day.

**4. LLM contract tests — on demand, not in CI.** A small suite hitting the real
API: does extraction return schema-valid output across 20 varied utterances?
Does the family renderer stay inside the deny-list on 20 proposals, including
adversarial ones? Run before a prompt or model change, not on every push.

*Why not in CI:* non-deterministic, slow and costly tests in CI get muted, and a
muted test is worse than no test. Gating them behind an explicit command keeps
them trusted.

**5. Two E2E paths (Playwright).** (a) Seeded George → signal → offer → consent
→ family link → response → closure. (b) New user → empty memory → three
utterances → `NO_BASELINE` asserted → absence assertion → offer. Path (b) is the
one that proves there's no George-specific logic, so it is not optional.

**Safety and privacy assertions, called out because they are the point:**
- a corpus of ~30 affect/diagnosis phrasings must all be rejected by the output
  guard;
- a snapshot test on the family-render prompt asserting that no transcript
  content and no field outside `SharePayload` appears in it;
- a test that a `consent_grant` whose `renderedTextSnapshot` no longer matches
  its hash, or no longer matches the opportunity's stored draft, refuses to
  send;
- a test that an expired, used or revoked grant refuses to send;
- **a spy on the `llm.ts` chokepoint asserting zero model calls occur between
  `approved` and the outbound send** — this is the executable form of the whole
  consent guarantee (R3);
- a test that the family route rejects a token belonging to a different
  request, and that `family_contacts` carries no token column at all (R7);
- a test that a `jobs` row exists in `pending` state before ingestion is
  attempted, and that a simulated runtime kill leaves it drainable by the next
  request without duplicating any event (R8).

**Freeze-pass assertions (F1–F5), each pinning one of the final corrections:**

- **F1a** — the assembled conversational context for a turn with a drafted
  opportunity contains the entity name and status but **not** `rendered_text`
  (substring assertion over the serialized prompt);
- **F1b** — the offer message persisted to the transcript contains
  `rendered_text` byte-for-byte; a mutation test that perturbs one character of
  the stored draft must fail this;
- **F2a** — an opportunity past `expires_at` cannot transition to `approved`;
- **F2b** — a grant past 72h refuses the send and marks the opportunity
  `expired`; the same grant *after* `used_at` is set is unaffected by the window
  passing;
- **F2c** — an expired `family_request` token yields a 404-equivalent, cannot be
  delivered or answered, and leaves the opportunity `consumed`, not reopened;
- **E3a** — a notifier failure leaves exactly one `family_request` in `pending`
  with `delivery_attempts = 1`, the grant already `used_at`, and the opportunity
  already `consumed`; the older adult is never re-prompted;
- **E3b** — retrying that delivery sends byte-identical `rendered_body` under
  the same `access_token_hash`, and a second creation attempt for the same
  opportunity violates `UNIQUE(opportunity_id)`;
- **E3c** — the creation transaction contains no network call (the notifier is
  stubbed to fail loudly if invoked before commit);
- **E1** — the assembled context for a turn with a `drafted` opportunity
  contains `entityName` but none of `rendered_text`, `rendered_text_hash` or any
  `SharePayload` field (extends F1a to the whole payload surface).
- **F3** — two concurrent materialization attempts for one signal produce
  exactly one opportunity (the second insert violates `UNIQUE(signal_id)`), and
  a suppressed signal carries a `suppression_reason`;
- **F4** — deleting an entity cascades its `episode_entities` rows and leaves no
  dangling membership; "episodes involving Simba" returns via the join;
- **F5** — an exhaustive `switch` over the seven opportunity statuses compiles
  (no `default` branch), and the `open`/`terminal` partition covers all seven
  exactly once.

# 18. Security / privacy considerations

**Database.** RLS on every user-scoped table, keyed to `auth.uid()`. The
service-role key is server-only and never reaches a client bundle; route
handlers are the only place it exists. Family access never uses the service role
to read user data — the family view reads exactly one `family_request` row by
token.

**Tokens.** Family invite tokens: 32 random bytes, stored sha256-hashed,
scoped to one request, expiring in 7 days, and rotated per request rather than
per contact. A leaked link exposes one approved sentence.

**Minimization.** The only user-derived content that ever leaves is a
`SharePayload` the user approved verbatim. The family surface has no endpoint
that can return conversation content — not gated, *absent*.

**Prompt injection.** Both the user's speech and the family member's free text
are untrusted input flowing into model context. Mitigations: extraction runs
with strict schema output (an injected instruction cannot change the shape of
the response); nothing extracted is ever executed; tool calls are requests
re-validated server-side; and the family reply is parsed in an isolated call
whose output can only populate `{answer, when, note}`.

**Retention and control.** Users can delete an entity, a memory, or everything
(cascade). Observations are retained as an audit trail but are deleted with the
user. No third-party analytics on conversation content.

**Not a medical device.** Stated explicitly in the product copy and in the
system prompt: no diagnosis, no monitoring claims, no emergency handling, and a
visible "this is not for emergencies" line. The output guard is the technical
enforcement of what the copy promises.

**Secrets.** OpenAI key server-only. No client-side model calls, ever — a
browser-exposed key would also mean an unguarded model path.

# 19. What NOT to build for this POC

Explicitly out of scope, and each for a reason:

- **ElevenLabs / any voice.** v1 is text-complete. The seam is declared (§15).
- **Real-time infra** — websockets, presence, push. HTTP + polling is adequate.
- **Queues, workers, cron, Redis.** Post-turn in-process work plus one `jobs`
  retry table covers it.
- **Caregiver dashboards, wellbeing scores, trend charts, alerting,
  escalation.** These convert the product into monitoring software and break
  the trust model.
- **Multi-tenant orgs, RBAC, admin panels, billing.**
- **Family accounts, invite acceptance flows, family-side history.**
- **Custom models, fine-tuning, embeddings training, a graph database, a
  temporal knowledge graph.** A relational schema with one vector column is
  sufficient and far more inspectable.
- **i18n, accessibility beyond sane defaults** (large type and contrast are in
  scope — the user base makes that a baseline, not a stretch).
- **Moderation pipelines, abuse detection, rate limiting beyond a basic cap.**
- **Mobile apps, offline, PWA.**
- **Microservices, Kubernetes, IaC, multi-region, load testing.**
- **A `DORMANT` baseline status / baseline expiry.** Noted as the right shape
  if it is ever needed; not V1.
- **Event types beyond `visit` and `call`.** The enum is declared wider; only
  those two are extracted and detected in V1.
- **Embedding- or ML-based entity resolution.** Exact → alias → role → ask,
  with optional trigram fuzzy matching only if it proves necessary.
- **Any ontology beyond `entity.type` + freeform `subtype`.** No taxonomy, no
  inheritance, no per-species behaviour.

The general principle: build the memory→pattern→consent→loop spine to real
quality, and stub or omit everything that merely looks like production.

# 20. Implementation plan

Small milestones, each independently demoable and each a clean commit point.
Estimates assume one engineer.

| M | Deliverable | Done when | Est. |
|---|---|---|---|
| **M0** | Scaffold + schema | Next.js + TS + Tailwind up; Supabase project; all migrations applied; generated DB types; ESLint boundary rule failing on a `core→server` import | 0.5d |
| **M1** | Conversation loop | Chat UI; messages persisted; streamed reply; context assembly with a *hardcoded empty* memory; `llm.ts` chokepoint with logging | 1d |
| **M2** | Ingestion → memory | Extraction call + zod schemas; `observations`; deterministic entity resolution (exact → alias → role → ask); relationships, facts, episodes with embeddings and `episode_entities` membership; `jobs` row committed *before* the in-process attempt, plus opportunistic drain; memory feeds context (companion recalls Simba) | 1.5d |
| **M3** | Event + baseline layer | `interaction_events` with observation-fingerprint idempotency and the occurred/reported split; `computeBaseline` + thresholds, one-per-day collapse inside the function, fully unit-tested; `/debug` inspector showing the derivation | 1.5d |
| **M4** | Detection + draft | Both detectors; suppression writing `materialized`/`suppressed` + reason; **atomic materialization behind `UNIQUE(signal_id)`**; `ReconnectProposal` → `SharePayload` → LLM render → output guard + deny-list corpus test → **persist draft + hash** | 1d |
| **M5** | Consent + family loop | Seven-status opportunity machine; **deterministic verbatim draft component** (model supplies only timing + lead-in); grant copies the stored text/hash; five send-time preconditions; single creation transaction behind `UNIQUE(opportunity_id)` with delivery outside it; three expiry clocks; per-request magic-link token; family page; response parse; closure | 1.5d |
| **M6** | Demo fixture | `timeline.ts`; seeder with `--live`/`--recorded`; recordings committed; seeded George produces an `ACTIVE` baseline and fires on load | 1d |
| **M7** | Tests + hardening | Property tests; golden ingestion tests; privacy snapshot tests; both E2E paths; RLS verified; copy and disclaimers | 1.5d |
| **M8** | Polish | Warm visual pass on both surfaces; latency check on the hot path; README with the architecture argument | 0.5d |

**≈ 10 working days.** M0–M5 is the defensible spine (~7d); M6–M8 is what makes
it presentable.

**Scope discipline — the first complete vertical slice.** M0–M5 should build
exactly one path end to end and nothing adjacent to it:

```
conversation → John/Simba memory → visit + absence events → baseline
  → cadence gap OR explicit absence signal → reconnect proposal
  → exact-text consent → magic-link family request → family response
  → closure back to the senior
```

Everything outside that line is a seam, not a task: two event types not five,
no fuzzy resolution until exact matching visibly fails, one debug page rather
than a dashboard, one notifier rather than a channel abstraction, no
`DORMANT`, no hardening beyond RLS and the privacy tests. The measure of this
POC is that one loop working convincingly and being explainable end to end —
breadth anywhere else actively costs depth there.

**Sequencing rationale:** the pattern engine (M3) is built and tested *before*
anything consumes it, because it is the part most likely to be wrong and the
part hardest to debug through a UI. Consent (M5) comes after detection so the
consent flow is exercised by real signals rather than a button. The demo fixture
(M6) comes late deliberately — it is a *consumer* of the pipeline, and building
it early would tempt shortcuts that bypass the code it is meant to prove.

**Suggested commit discipline:** one commit per milestone, each a clean rollback
point, message naming the milestone and what is now demoable. Nothing committed
or pushed without you asking.

# CareLoop — Technical Design Proposal

Status: proposal (no code written yet)
Author: design pass, 2026-09-16
Scope: POC v1, text-only, single Next.js app on Vercel + Supabase

## Documents

| Doc | Covers (spec section numbers in brackets) |
|---|---|
| `01-architecture.md` | System architecture, flows, folder structure [1, 2, 3] |
| `02-data-model.md` | Schema, structured memory, episodic memory, event model [4, 5, 6, 7] |
| `03-pattern-engine.md` | Baselines, cold start, change detection [8, 9, 10] |
| `04-consent-and-family.md` | Consent model, family action model, dashboard [11, 12] |
| `05-llm-and-voice.md` | LLM vs deterministic split, OpenAI strategy, ElevenLabs seam [13, 14, 15] |
| `06-delivery.md` | Fixtures, testing, security, non-goals, milestones [16–20] |

## The one-sentence architecture

**The LLM is a sensor and a renderer; it is never the decision-maker.**

It converts speech into schema-validated observations on the way in, and
converts a decision object into a sentence on the way out. Everything between
those two points — entity resolution, memory writes, baselines, thresholds,
signal firing, consent state, redaction — is deterministic TypeScript that runs
identically with the model stubbed out.

Why this matters more than any other decision here: the product's risk surface
is *wrongly telling an older adult something about their family*, or *leaking a
private conversation*. Both are unacceptable-in-kind, not just low-quality. A
non-deterministic component cannot be the thing that decides either one. This
split is also what makes the system testable, debuggable and demonstrable —
you can show the exact evidence behind every sentence CareLoop says.

## Product invariants (enforced structurally, not by prompt)

1. **No inference about internal state.** The system emits observable facts
   ("you haven't mentioned seeing John this week") and never affect, mood,
   health or diagnosis. Enforced by a deterministic proposal object + an
   output guard, not by asking the model nicely.
2. **No baseline without evidence.** Below the evidence threshold the pattern
   engine returns `NO_BASELINE` with machine-readable reasons. It never
   improvises a routine.
3. **Nothing leaves the private conversation without explicit, evidenced,
   scoped consent** — and the user approves *the exact text that will be sent*.
   The outbound message is rendered, guarded, persisted and hashed **before**
   it is shown for approval; the stored string is what goes out. There is no
   model call between approval and send.
4. **The family member receives a payload, not a transcript.** The outbound
   message is rendered from a whitelisted field set in an LLM call that has no
   conversation history in its context. Structural guarantee, not a prompt.
5. **No user-specific logic.** George/John/Simba appear only in a fixture file
   that is replayed through the production ingestion pipeline. A new user with
   an empty memory exercises the same code paths.

## Decisions I took (all vetoable)

| # | Decision | Status | Veto cost |
|---|---|---|---|
| D1 | Single Next.js app; no separate backend service | Approved | Low — services layer is already isolated |
| D2 | One `entities` table (`person \| pet \| place \| org`, optional freeform `subtype`), with a strict split: `entity.type` is what a thing **is**, `relationship.kind` is how two things are **related** | Approved, refined in review (R1) | Low |
| D3 | Median inter-event gap + MAD as the baseline statistic (not mean/stddev) | Approved | Low — one pure function |
| D4 | Two-model split: fast model in-turn, stronger model post-turn | Approved | Low |
| D5 | pgvector on `episodes.embedding` **only** — no entity embeddings in V1; structured questions use relational indexes | Approved, tightened in review (R2) | Medium — adding vectors later is easy, removing them is churn |
| D6 | Absence assertions ("I haven't seen John") are first-class events | Approved | Low |
| D7 | Consent is single-use, scoped, 72h-expiring, and approves a **pre-rendered, pre-guarded, hash-pinned** string | Approved, ordering corrected in review (R3) | Low |
| D8 | Demo fixture replays through production pipeline with a `Clock` port | Approved | Low, and it's load-bearing for your "no special demo logic" requirement |

## Review corrections applied (R1–R8)

| R | Correction | Where |
|---|---|---|
| R1 | `entity.type` (what it is) separated from `relationship.kind` (how two entities relate). Simba is `type=pet, subtype=dog`; the edges are `John —pet→ Simba` and `user —family_pet→ Simba`. `dog` is never a relationship kind | `02` §4.1, §5 |
| R2 | `entities.name_embedding` deleted; entity resolution is exact → alias → relationship-role → optional lightweight fuzzy → ask. pgvector exists on exactly one column | `02` §4.1, §4.2, §5.1 |
| R3 | Render → guard → persist + hash → **then** offer → approve → send stored bytes. No LLM call after approval; payload/text/hash mismatch refuses the send | `01` §1.4, §2.2; `04` §11; `05` §14.1 |
| R4 | `daysSinceLastEvent <= 3 × median` removed as an evidence gate — it destroyed the very baseline the cadence detector needs. `daysSinceLastEvent` is detector input only. Expiry, if ever needed, becomes an explicit `DORMANT` status, out of scope for V1 | `03` §8, §9 |
| R5 | Cadence threshold example arithmetic corrected: median 7, MAD 1 → `max(9, 10.5, 11, 7) = 11`, not 9. The demo's 13-day gap still fires (13 > 11) | `03` §10.1; `06` §16.3, §17 |
| R6 | Ingestion idempotency (one row per extracted observation, via an observation-derived fingerprint) separated from statistical normalization (one-event-per-day collapse inside `computeBaseline`). Two genuine calls on the same day are now two events | `02` §4.1, §7; `03` §8.1 |
| R7 | The capability token moved from `family_contacts` (identity) to `family_requests` (one token per request, hashed, expiring, non-enumerable) | `02` §4.1; `04` §12 |
| R8 | Post-turn durability made explicit: a `jobs` row keyed by message id is committed **before** the in-process attempt, so a reclaimed runtime leaves a pending row a later request drains. Still no queue, no Redis, no cron | `01` §2.1; `06` §20 |

## Freeze-pass corrections (F1–F6)

Final consistency pass before M0. No architectural direction changed.

| F | Correction | Where |
|---|---|---|
| F1 | The stored draft is **displayed deterministically**, never paraphrased. The conversational model supplies timing and an optional lead-in; `rendered_text` is inserted verbatim by application code and is **withheld from the model's context entirely** | `01` §1.4, §2.2; `04` §11.2a; `05` §13.1, §14.3, §14.4 |
| F2 | Three expiry clocks given one responsibility each: opportunity expiry governs offerability (pre-approval), consent expiry governs execution authority (72h from approval, irrelevant once consumed), token expiry governs one family member's read/respond window (7d, never revives consent) | `04` §11.5, §12.1, §12.2 |
| F3 | Signal lifecycle `detected → materialized \| suppressed` with `suppression_reason`; one signal yields at most one opportunity, enforced by `UNIQUE(signal_id)` and an atomic materialization, **not** by cooldown logic | `02` §4.1; `03` §10.3; `01` §1.4 |
| F4 | `episodes.entity_ids uuid[]` replaced by an `episode_entities` join table with real FKs and cascade; retrieval examples updated | `02` §4.1, §6 |
| F5 | `reconnect_opportunities.status` enumerated to seven canonical values, with `open`/`terminal` partitions defined once and used everywhere | `02` §4.1; `04` §11.2; `03` §10.3 |
| F6 | Pipeline diagram split into A (ingestion, every turn), B (draft path, conditional on a materialized signal), C (reconnect/consent, a separate later flow) | `01` §1.4 |

## Freeze errata (E1–E3)

| E | Correction | Where |
|---|---|---|
| E1 | `01` §2.1 no longer injects the "rendered proposal" into conversational context — only the marker `{ entityId, entityName, status }`. Never `rendered_text`, `rendered_text_hash`, `SharePayload` or the message body | `01` §2.1 |
| E2 | The model's latitude is "the moment, and the wording of ordinary conversation or an optional lead-in" — never the outbound draft bytes | `05` §13.3 |
| E3 | Family-request creation is one transaction (request `pending` + token + `grant.used_at` + `opportunity → consumed`), with delivery outside it. `UNIQUE(family_requests.opportunity_id)`; retry reuses the same request, bytes and token; single terminal `expired` | `02` §4.1; `04` §12.2a, §12.2b, §11.5; `06` §17, §20 |

**Architecture is frozen at this point.** D1–D8, R1–R8, F1–F6 and E1–E3 are the
complete decision record for M0. No further architecture review before
implementation.

Confirmed with you before writing: docs land in-repo; extraction/baseline
recompute runs post-turn in-process (no queue, no cron — now backed by a
durable job row, R8); family access is a signed single-purpose magic link with
no account (now owned by the request rather than the contact, R7).

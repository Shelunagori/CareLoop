# 4. Database schema / entities

Postgres via Supabase. Every user-scoped table carries `user_id` and is covered
by RLS. Timestamps are `timestamptz`. Ids are `uuid`.

## 4.1 The tables

```
users                 the older adult (Supabase auth user)
conversations         id, user_id, started_at, channel('text'|'voice')
messages              id, conversation_id, role, content, modality,
                      audio_url?, transcript_confidence?, created_at

observations          id, user_id, source_message_id, kind, payload jsonb,
                      confidence numeric, source_span text, model, prompt_id,
                      created_at, processed_at, resolution jsonb
                      ↑ immutable raw LLM output. The audit log + replay source.

entities              id, user_id, type('person'|'pet'|'place'|'org'),
                      subtype text?,        -- freeform, descriptive only: 'dog'
                      display_name, aliases text[],
                      first_seen_at, last_mentioned_at, mention_count,
                      status('active'|'needs_confirmation'|'merged_into')
                      ← NO embedding column (D5/R2)
relationships         id, user_id, from_ref('user'|entity_id), to_entity_id,
                      kind('son'|'daughter'|'pet'|'family_pet'|'neighbour'|...),
                      label_raw, confidence, evidence_count,
                      status('candidate'|'confirmed'),
                      first_observed_at, last_confirmed_at
facts                 id, user_id, subject('user'|entity_id), key, value jsonb,
                      confidence, evidence_count, status, source_observation_ids[]

episodes              id, user_id, summary, occurred_at, occurred_at_precision
                      ('exact'|'day'|'week'|'unknown'),
                      salience numeric, embedding vector(1536),
                      source_message_ids uuid[], created_at
episode_entities      episode_id → episodes(id) ON DELETE CASCADE,
                      entity_id  → entities(id) ON DELETE CASCADE,
                      PRIMARY KEY (episode_id, entity_id),
                      INDEX (entity_id)
                      ← the only representation of episode membership (F4)

interaction_events    id, user_id, entity_id, event_type, occurred_at,
                      occurred_at_precision, reported_at, certainty numeric,
                      polarity('positive'|'absence'), window_start?, window_end?,
                      source_episode_id, source_observation_id,
                      ingest_fingerprint
                      ← UNIQUE(user_id, ingest_fingerprint)   (R6)

baselines             id, user_id, entity_id, event_type, status,
                      cadence_days_median, cadence_days_mad, observation_count,
                      window_start, window_end, reasons jsonb,
                      method_version, inputs_hash, computed_at
                      UNIQUE(user_id, entity_id, event_type)

signals               id, user_id, entity_id, baseline_id?, signal_type,
                      score, explanation jsonb, detected_at,
                      status('detected'|'materialized'|'suppressed'),
                      suppression_reason text?, materialized_at
reconnect_opportunities id, user_id, signal_id, entity_id, proposal jsonb,
                      share_payload jsonb, rendered_text, rendered_text_hash,
                      status('proposed'|'drafted'|'offered'|'approved'
                             |'consumed'|'declined'|'expired'),
                      offered_at, resolved_at, expires_at
                      UNIQUE(signal_id)  ← one signal → at most one
                                           opportunity, enforced by the DB (F3)
                      ← the draft is rendered, guarded and stored
                        BEFORE it is offered (R3)
consent_grants        id, user_id, opportunity_id, scope jsonb,
                      payload_snapshot jsonb,
                      rendered_text_snapshot, rendered_text_hash,
                      granting_message_id,
                      granted_at, expires_at, used_at, revoked_at
                      ← NO status column: state is DERIVED from these four
                        timestamps by one pure function (04 §11.5), so it
                        cannot drift out of sync with them

family_contacts       id, user_id, entity_id, channel, address, display_name
                      ← identity only; holds NO capability token (R7)
family_requests       id, opportunity_id, contact_id,
                      rendered_body, rendered_body_hash, payload jsonb,
                      access_token_hash, token_expires_at,
                      status('pending'|'delivered'|'answered'|'expired'),
                      delivery_attempts int default 0, last_delivery_error text?,
                      created_at, delivered_at, opened_at
                      UNIQUE(opportunity_id)  ← one approved opportunity →
                                                at most one request (E3)
                      ← one capability token per request (R7);
                        its own lifecycle, independent of the
                        opportunity's once consumed (F2)
family_responses      id, request_id, raw_body, parsed jsonb, received_at
closures              id, opportunity_id, response_id, surfaced_message_id?,
                      surfaced_at

jobs                  id, kind('ingest'), key (= message id, UNIQUE),
                      payload jsonb, attempts, last_error, run_after,
                      completed_at
                      ← committed BEFORE the in-process attempt (R8)
```

**Why `entities` and not `people`:** Simba is load-bearing in the product and is
a dog. A `people` table storing a dog is a lie in the schema, and a second
`pets` table duplicates every join, index and resolution rule for no gain. One
`entities` table with a `type` discriminator keeps relationship, event and
episode joins uniform. (D2 — approved.)

**`entity.type` and `relationship.kind` are different axes, and must not leak
into each other.** `type` answers *what is this thing*; `kind` answers *how are
these two things connected*. Simba is `type='pet', subtype='dog'`; the edges are
`John —pet→ Simba` and `user —family_pet→ Simba`. `dog` is a subtype, never a
relationship kind. Collapsing the two is the ontology bug that looks harmless at
three entities and becomes unfixable at three hundred: you end up unable to
express "John's dog" without inventing a relationship kind per species, and
unable to query "all of this user's pets" without knowing every kind string.
Keeping them orthogonal costs one column and no extra machinery — and
deliberately stops short of a real ontology: `subtype` is freeform descriptive
text with no behaviour attached to it.

**Why `observations` is separate and immutable:** it is the boundary between
"the model said" and "the system believes". Keeping raw extraction forever gives
us (a) an audit trail when a memory turns out wrong, (b) the ability to replay
the deterministic half against recorded LLM output in tests, (c) a debug view
that shows exactly which sentence created which belief. It is the single
highest-value table for demonstrating engineering judgement.

**Why `ingest_fingerprint` rather than a day-bucket dedupe key (R6):** there are
two different problems here and one key cannot serve both.

*Ingestion idempotency* — the same extracted observation must not create two
event rows when a job is retried or a fixture is replayed. Solved by a stable
fingerprint derived from the observation that produced the event:

```
ingest_fingerprint = sha256(source_observation_id, entity_id, event_type,
                            polarity, resolved_window_start, resolved_window_end)
```

with a unique constraint, so it is enforced by the database rather than by
application logic that can be bypassed.

*Statistical normalization* — "John came round" said on Sunday, Monday and
Wednesday is one visit, and counting it three times would make cadence a measure
of how chatty George is. But that is a **different** correction, and it is
handled inside `computeBaseline()` by collapsing to one event per day (see `03`
§8.1), not at write time.

A day-bucketed unique key would conflate them and silently destroy real data:
"John called this morning" and "John called again this evening" are two genuine
interactions, and the database would swallow the second. Ingestion must record
what happened; the statistics layer decides what counts. Those are separate
responsibilities and now live in separate places.

**Why `UNIQUE(signal_id)` on opportunities (F3):** suppression decides *whether*
a signal deserves an opportunity, and it is a time-dependent policy function —
cooldowns, caps, quiet periods — so it can be re-entered and can legitimately
answer `yes` twice. A retried post-turn job, a concurrent turn, or a recomputed
baseline could each ask the question again. Cooldown logic is the wrong place to
prevent the duplicate: cooldowns are about *pacing across signals*, not about
*identity of one signal*, and overloading them means a pacing tweak can silently
reintroduce duplicate offers. A unique constraint is the right tool because the
invariant is structural — one signal, at most one opportunity — and the database
can simply refuse the second insert. The insert and the
`signals.status → materialized` transition happen in **one transaction**, so a
signal is never marked materialized without its opportunity existing, and never
has an opportunity without being marked.

**Why `episode_entities` rather than `entity_ids uuid[]` (F4):** every other
entity reference in the schema is a real foreign key — `relationships`,
`interaction_events`, `family_contacts`. An array column would make episodic
membership the one place where an entity id can point at a row that no longer
exists, which matters precisely because entity deletion and entity merge-flagging
are both things this product does. Cascade behaviour becomes explicit rather than
something application code has to remember. "Episodes involving Simba" stays a
one-line join with an index on `entity_id`, so nothing is lost in ergonomics.
Cheap now, genuinely annoying once migrations and data exist — which is the whole
argument for doing it before M0. Deliberately not generalized: a plain two-column
join table, no attributes, no role column, no ordering.

## 4.2 pgvector, deliberately narrow

Only `episodes.embedding`. Index: `ivfflat` (or HNSW) on cosine. That is the
complete list — one column, one index. In particular there are **no entity
embeddings**: entity resolution is deterministic (§5.1), and "which entity is
this" is a lookup, not a similarity problem.

**Why not more:** "Who is John?" and "when did John last visit?" are *structured*
questions with exact answers that a vector search can only approximate, more
slowly and more expensively. Relationships, facts and events are queried by id,
type and time — B-tree territory. Semantic retrieval earns its place in exactly
one query: open-ended recall over things the user said ("what has George said
about Simba?"), where there is no key to look up. Using a vector DB as the whole
memory system is the mistake this design is explicitly avoiding: you get fuzzy
answers to questions that had crisp ones, and you can't compute a baseline from
a similarity score.

# 5. Structured-memory model

Three kinds, all with the same lifecycle: `candidate → confirmed`, an evidence
counter, and a link back to the observations that produced them.

- **Entities** — the actors in the user's world. `entity.type` says what each
  one **is**: `John → person`, `Simba → pet (subtype: dog)`.
- **Relationships** — typed edges. `relationship.kind` says how two entities are
  **related**: `user —son→ John`, `John —pet→ Simba`, `user —family_pet→ Simba`
  (both of the last two can be true; the dog is John's and the family's).
- **Facts** — stable key/value about the user or an entity: preferences,
  routines stated directly, constants ("John lives in Bristol").

The separation is load-bearing: species lives on the entity, ownership lives on
the edge. No relationship kind is ever a species, and no entity type is ever a
role. Beyond that there is no ontology — `subtype` is descriptive text nothing
branches on.

Promotion rule (deterministic, in `core/memory`): a candidate becomes confirmed
at `evidence_count >= 2` from distinct conversations, **or** immediately on
direct user confirmation ("yes, John's my son"). A single passing mention stays
a candidate and is usable in context but never asserted back to the user as
fact. This is what stops one misheard sentence from becoming a permanent belief.

## 5.1 Entity resolution — the part that is easy to get wrong

Given a mention "John" / "my son" / "Johnny":

1. **Normalized exact match** on `display_name` for this user (case-folded,
   trimmed, punctuation-stripped). Hit → resolved. This alone handles most
   mentions, at zero cost and zero ambiguity.
2. **Alias match** against `aliases[]`. Hit → resolved.
3. **Relationship-role match.** "my son" resolves via the relationships table
   when exactly one `son` edge exists. Two sons → ambiguous, go to 5.
4. **Optional lightweight fuzzy match** — `pg_trgm` similarity over
   `display_name` + `aliases`, above a high threshold, as a *candidate
   suggester* only. It proposes; it never commits. Skip it entirely if steps
   1–3 prove sufficient in practice.
5. **Ambiguity → ask.** The companion asks a natural clarifying question
   ("your son John, or John next door?"). A resolution the user confirms writes
   an alias, so it is asked once, ever.

**Why no embeddings here (D5/R2):** "is this mention John?" has an exact answer
that a string comparison gets right and a cosine score only approximates — more
slowly, less legibly, and with a threshold nobody can defend. Worse, a
similarity score is unexplainable at exactly the moment you need to explain it
(why did it merge two people?). Trigram similarity, if used at all, at least
produces a reason a human can read. Vectors are reserved for the one question
that genuinely has no key: open-ended recall over episode text.

**Never auto-merge two existing entities.** Merging is destructive and
irreversible in effect; a wrong merge silently fuses two people's histories and
corrupts both baselines. Instead flag `status='needs_confirmation'` and surface
it in the debug view / a gentle question. Splitting a bad merge is far harder
than confirming a suspected one.

# 6. Episodic-memory model

An episode is one durable, dated, retrievable thing that happened or was said.

```ts
type Episode = {
  summary: string            // one sentence, third person, from the LLM
  occurredAt: Date
  occurredAtPrecision: 'exact' | 'day' | 'week' | 'unknown'
  entityIds: string[]         // hydrated from episode_entities, never a column
  salience: number           // 0..1, deterministic score
  embedding: number[]
  sourceMessageIds: string[]
}
```

Two properties worth defending:

**Resolved time, not relative time.** The extractor emits `"last Sunday"`; a
deterministic resolver converts it against the message timestamp into an
absolute date plus a precision flag. Storing relative language is how a memory
system quietly rots — "last Sunday" means something different every time you
read it. Precision is kept because "sometime last week" must not be treated as
a point event when computing gaps.

**Salience is computed, not felt.** `salience = f(explicit emotion words the
user used, entity importance, recency, novelty vs existing episodes,
user-initiated vs assistant-prompted)`. A pure function in `core/memory`. It
drives retrieval ranking and pruning. Asking the LLM "how important is this?"
gives you a number that is unstable across runs and impossible to tune.

Retrieval is hybrid and deterministic: `score = w1·cosine + w2·recencyDecay +
w3·salience + w4·entityMatch`, take top-k with k bounded by a token budget. The
weights live in one file with a comment explaining each, so tuning is a
reviewable diff.

`entityMatch` and any entity-scoped recall ("what has George said about Simba?")
resolve through `episode_entities`:

```sql
SELECT e.* FROM episodes e
JOIN episode_entities ee ON ee.episode_id = e.id
WHERE ee.entity_id = $1 AND e.user_id = $2
ORDER BY e.occurred_at DESC;
```

The join narrows the candidate set; the embedding ranks it. The two compose in
one query.

# 7. Relationship / routine event model

`interaction_events` is the deterministic spine of the pattern layer. Everything
the baseline engine sees comes from here — never from episode text, never from
the LLM directly.

```ts
// V1 implements 'visit' and 'call' only. The rest are declared so the column
// and the detectors have the right shape; building them is not V1 work.
type EventType = 'visit' | 'call' | 'message' | 'mention' | 'outing'
type Polarity  = 'positive' | 'absence'
```

Three modelling decisions that carry the whole feature:

**1. `occurred_at` ≠ `reported_at`.** George reports Sunday's visit on Tuesday.
Cadence must be computed on when things *happened*; freshness and
"has he mentioned it lately" must be computed on when he *said* it. Collapsing
these two into one column makes both metrics wrong, and the bug is invisible
until the demo.

**2. Absence assertions are first-class.** "I haven't seen John this week" is
not a visit event and not the absence of data — it is *positive evidence of
non-occurrence over a window*. Stored as `polarity='absence'` with
`window_start`/`window_end`. This is what lets a brand-new user with no baseline
still get a correct, well-founded reconnect offer, and it's the difference
between the system knowing something and merely not knowing.

**3. Certainty is carried, not flattened.** "John came by" → 0.95.
"I think John might pop round" → low, and below the inclusion threshold for
baseline computation, though still stored. A future intention is not an
occurrence; conflating them inflates cadence and produces false reassurance,
which in this product is worse than a false alarm.

**4. Ingestion idempotency is not statistical normalization.** The unique
constraint on `ingest_fingerprint` exists to stop a *replayed observation* from
becoming two rows. It does not, and must not, stop two genuine interactions on
the same day from both being recorded — a morning call and an evening call are
two events, and an ingestion layer that silently drops the second is lying about
what happened. The "one visit per day for cadence purposes" correction is a
property of the statistic, so it lives in `computeBaseline()` (`03` §8.1). One
rule per layer: ingestion records reality, the statistics layer decides what
counts.

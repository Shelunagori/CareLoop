# 13. LLM responsibilities vs deterministic application responsibilities

## 13.1 The division

| The LLM does | The application does |
|---|---|
| Understand natural speech | Decide what is true |
| Extract candidate observations (schema-constrained) | Resolve entities, commit memory |
| Summarize an episode in one sentence | Score salience, choose what to retain |
| Suggest that a mention refers to a known entity | Accept, reject, or ask |
| Parse relative time phrases into a proposal | Resolve to absolute dates + precision |
| Render a proposal object into a warm sentence | Build the proposal; guard the output |
| Parse a family member's free-text reply | Decide the loop is closed; persist it |
| Choose *when* in a conversation to raise an offer | Decide *whether* there is an offer at all, and its content |
| Write an optional lead-in sentence around the offer | **Display the draft itself, verbatim, from storage (F1)** |

Everything on the right is a pure function or a repository call. None of it
degrades if the model is swapped, and all of it runs in tests with the model
stubbed.

## 13.2 The rule

> No LLM output is written to a decision-bearing table, or sent to a third
> party, without passing (a) a zod schema and (b) a deterministic policy
> function.

Concretely: extraction output lands in `observations` (a log, not a belief);
a policy function decides what becomes an entity, a relationship, a fact, an
episode or an event. The model never writes to `relationships`, `baselines`,
`signals`, `consent_grants` or `family_requests` — not indirectly either.

The one model-authored string that does reach a third party — the family
message — gets there by being rendered *before* consent, passed through the
deterministic guard, stored, hashed, shown to the user, and then copied. After
the user approves, the model is out of the loop entirely.

**Why so strict:** the model is non-deterministic, it will be replaced within
months, and it is exposed to untrusted input (the user's own speech, and a
family member's free text — both are injection surfaces). Anything load-bearing
that depends on it inherits all three properties. Keeping the load-bearing half
deterministic is what makes the system testable, explainable and safe, and it is
the argument this whole design rests on.

## 13.3 Where I deliberately allow model judgement

Timing, and the wording of ordinary conversation. Whether to raise the John
question now or after George finishes his story is a judgement the model makes
better than a rule, and the downside of getting it wrong is an awkward moment,
not a false belief or a privacy breach. The boundary is:

> **The model may choose the moment, and the wording of ordinary conversation or
> an optional reconnect lead-in. The application chooses the fact, the
> recipient, the outbound payload, and the exact outbound draft bytes.**

Note what the earlier, looser phrasing ("the moment and the words") would have
licensed: the draft is words too. The model's freedom over wording stops at the
boundary of the verbatim block — it never extends to the stored family message,
which it does not receive and cannot rewrite (F1, `04` §11.2a).

# 14. Proposed OpenAI interaction strategy

## 14.1 Call inventory (four, that's all)

| # | Call | Model | Path | Output |
|---|---|---|---|---|
| 1 | Conversational turn | fast/small | hot, streamed | text + optional tool call |
| 2 | Observation extraction | stronger | post-turn | strict JSON schema |
| 3 | Family message render | small | at **draft** time, before consent | short text, no history in context |
| 4 | Family reply parse | small | on response | strict JSON schema |

Plus embeddings (`text-embedding-3-small`, 1536) for episodes only — no entity
embeddings (D5/R2).

**There is no fifth call, and specifically no call between approval and send.**
Call #3 produces the exact string the user is later shown and approves; sending
is a byte copy of that stored string (`04` §11.3). If the model were re-invoked
after consent, the thing sent would not be the thing approved, and the entire
consent guarantee would reduce to a hope that two generations agree.

**Why split 1 and 2 across two models:** they have opposite requirements. The
turn needs latency and warmth; extraction needs accuracy and structure and has
no user waiting. One model tuned for both is worse at both and costs more. The
split also means a model upgrade can be evaluated on extraction quality alone,
with golden tests, without touching conversational feel.

## 14.2 Structured outputs, not tool calls, for extraction

Extraction uses `response_format: { type: 'json_schema', strict: true }` with the
schema generated from the zod type, then re-validated with zod on receipt
(belt and braces — the API guarantees shape, zod guarantees *our* invariants like
enum membership and date parseability).

**Why not function calling for extraction:** function calling models "the
assistant wants to act". Extraction is not an action, it's a transformation, and
framing it as an action invites the model toward agency we have explicitly
denied it. Strict schema output is also cheaper to validate and easier to pin in
golden tests.

## 14.3 Tools — a deliberately tiny set

Only three, exposed only on call #1:

- `recall(query, entityId?)` — semantic lookup over episodes;
- `propose_reconnect(entityId)` — *requests* that an open drafted opportunity be
  raised now. Returns a status marker only; it never returns `rendered_text`;
- `register_consent(opportunityId)` — *signals* the user said yes.

Every one is a **request**, not a command. The handler re-checks state
server-side: `propose_reconnect` returns nothing unless a real, unsuppressed
opportunity exists; `register_consent` fails unless the opportunity is in
`offered` and the approved text hash matches. A hallucinated tool call is a
no-op, by construction. Consent in particular is double-confirmed — the tool
call plus the deterministic check that the user's message actually approved the
shown text.

## 14.4 Context assembly — deterministic and budgeted

Priority-ordered, truncated to a fixed token budget (~2.5k):

1. system prompt + safety rules (fixed, versioned)
2. profile card: user's name, preferred term for family, stable facts (~250 tok)
3. entity cards for entities mentioned this turn or active in the last 7 days
4. any pending closure (highest product priority — a promise is outstanding)
5. a drafted-opportunity **marker** — `{ entityId, entityName, status }` and
   nothing else. The draft text is deliberately withheld (F1)
6. top-k episodes, hybrid-scored, k ≤ 6
7. last N conversational turns

**Why item 5 is a marker and not the draft (F1):** the model's job at that point
is to judge timing and optionally write a lead-in — neither of which needs the
message body. Handing it the body would create the possibility of paraphrase in
the one place where paraphrase breaks consent. Withholding it removes that
possibility at every temperature and under any injection in the user's speech,
which an instruction cannot do. The draft is inserted verbatim by a
deterministic UI component (`04` §11.2a).

**Why budgeted and prioritized rather than "give it everything":** memory grows
without bound and context does not. A system that gets slower and vaguer the
longer someone uses it is the opposite of the product thesis. Fixed budget with
explicit priority means latency and cost are flat at month 12, and when
something is missing from context you can see *why* it was dropped.

## 14.5 Observability

One `llm.ts` chokepoint logs: prompt id + version, model, token counts, latency,
validation outcome, and a hash of the input. Failed validations are persisted
with the raw output so extraction regressions are diagnosable rather than
anecdotal. Retries: one, with a repair prompt containing the validation error;
then give up and log — a failed extraction is a missing memory, never a crashed
turn.

# 15. Inserting ElevenLabs later without a rewrite

**The seam already exists:** the conversation engine's interface is
`(text, turnMetadata) → (speakableText, turnMetadata)`. Voice is a *transport
concern* at the route edge, not a change to the domain. Swapping text for audio
means adding STT before step 1 and TTS after the final guard — the pipeline in
between does not know which it is.

Three small things to do **now** so that later is cheap, and nothing more:

1. **Declare the port, don't implement it.**
   ```ts
   interface VoiceProvider {
     synthesize(text: string, voiceId: string): Promise<ReadableStream>
     transcribe(audio: ReadableStream): Promise<{ text: string; confidence: number }>
   }
   ```
2. **Schema headroom** (columns exist, stay null in v1): `messages.modality`,
   `messages.audio_url`, `messages.transcript_confidence`,
   `conversations.channel`.
3. **Separate `speakableText` from display content.** The turn response carries
   a plain-prose field that is guaranteed free of markdown, links and lists,
   alongside anything rich the UI wants. Retrofitting this later means auditing
   every prompt and every renderer; declaring it now costs one field.

Everything else is genuinely deferred: streaming/barge-in, endpointing, latency
budgets, voice selection, and the audio pipeline. Building any of it now would
be speculative work against an interface that will change once there's a real
voice loop to feel.

**Family Voice Postcards** fit the model without new concepts: an inbound media
row on `family_responses` (`media_url`, `duration_s`), the same consent and
scoping rules, and the companion's existing closure mechanism gains one variant
("John sent you something — would you like to hear it?"). Worth noting in the
design precisely because it should require no structural change; if it did, the
consent and closure models would be wrong.

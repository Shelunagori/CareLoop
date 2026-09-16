# 1. System Architecture

## 1.1 Shape

One Next.js (App Router) application, deployed to Vercel, talking to one
Supabase project. Two user-facing surfaces inside it: the companion (older
adult) and the family view (magic-link). No second service, no queue, no
container orchestration.

**Why one app:** the POC has one write-heavy path and a handful of reads. A
separate backend would buy deployment independence we don't need and cost us a
network hop, a second deploy target, a shared types problem and a local dev
story. The thing that actually needs to be separable is the *domain logic*, and
that's achieved with a layered module boundary inside the app — cheaper and
just as defensible. If CareLoop later needs long-running voice sessions or a
worker fleet, the services layer lifts out intact because it has no Next.js
imports.

## 1.2 Layers

```
 app/                 route handlers + RSC pages      ← thin: authn, zod parse, call service
   │
 server/services/     orchestration (use-cases)       ← composes the below; owns transactions
   │           │
   │           ├── server/repositories/   Postgres access, typed, one per aggregate
   │           └── server/adapters/       LlmProvider, EmbeddingProvider, VoiceProvider, Clock
   │
 core/                pure domain                     ← NO I/O, NO imports from server/ or app/
                      baselines, change detection, consent state machine,
                      redaction, entity resolution rules, guards
```

Dependency rule, enforced by an ESLint `no-restricted-imports` boundary:
`core` imports nothing from `server` or `app`. `core` is pure functions over
plain data. It is the part you unit-test without a database, without a network,
and without mocks — which is the same as saying it's the part you can *defend*.

**Why a pure core:** every rule that must be inspectable (does this
relationship have a baseline? should this signal fire? is this consent valid?)
lives in a function you can call with a literal object and assert on. That is
what makes "explainable pattern detection" real rather than aspirational.

## 1.3 Ports and adapters

```ts
interface LlmProvider {
  complete(req: ChatRequest): Promise<ChatResponse>            // conversational turn
  extract<T>(req: ExtractRequest<T>): Promise<Extracted<T>>    // schema-constrained
}
interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }
interface VoiceProvider { synthesize(...): ...; transcribe(...): ... }  // declared, not implemented
interface Clock { now(): Date }
interface Notifier { send(channel, to, body): Promise<Delivery> }
```

**Why ports here and nowhere else:** ports pay for themselves exactly where
there's a real second implementation. There are three: (a) OpenAI vs a recorded
fixture player (needed for tests and the demo seeder), (b) system clock vs a
frozen/replay clock (needed for temporal fixtures and baseline tests), (c) a
console notifier vs email later. I am *not* abstracting the database — Supabase
is a decision, not a hedge, and a repository layer already gives us the seam
that matters.

## 1.4 The pipeline

```
── A. INGESTION PATH ──────────────────────────── runs on EVERY turn ──
utterance
  → [LLM] observation extraction     (schema-validated candidates + confidence + source span)
  → [det] entity resolution          (match / create / flag-for-confirmation — never silent merge)
  → [det] memory commit              (structured facts, relationships, episodes)
  → [det] event derivation           (interaction_events: visit / call / absence assertion)
  → [det] baseline recompute         (only for touched entity × event_type)
  → [det] change detection           (maybe a signal, with explanation JSON)
  ──── ends here on the overwhelming majority of turns ────

── B. DRAFT PATH ──────────── ONLY IF a signal is detected (F6) ───────
  [det] suppression decides          (cooldowns, caps, quiet periods)
    ├─ suppressed → signal.status = suppressed (+ reason), STOP
    └─ materialize → opportunity created AND signal.status = materialized
                     in ONE transaction; UNIQUE(signal_id) (F3)
  → [det] minimize → SharePayload    (whitelisted fields only)
  → [LLM] render the family message  (the SharePayload is the ENTIRE context)
  → [det] output guard               (deny-list + shape check; template fallback)
  → [det] persist rendered_text + hash → opportunity.status = drafted
                                     (these exact bytes are what will be sent)

── C. RECONNECT / CONSENT FLOW ──── separate flow, later turn(s) ──────
  [LLM] decides WHETHER NOW is a good moment; may write a lead-in sentence
  → [det] UI inserts the EXACT stored rendered_text, verbatim (F1)
  → user approves → [det] consent_grant → [det] send stored bytes → family link
```

Three things this split makes explicit (F6):

- **A is the common case.** Most turns are just conversation. B runs rarely, C
  rarer still. Nobody should come away thinking every utterance renders a family
  message — it is a conditional branch off the tail of ingestion, not a stage of
  it.
- **B is conditional, and atomic at its head.** Suppression is the gate;
  materialization is one transaction, so a signal can never yield two
  opportunities.
- **C is a different flow**, usually on a later turn, and it is where the consent
  contract lives (§2.2). The render happens in B, *before* C begins — nothing
  regenerates the message afterwards.

`[det]` = deterministic. Note there is no point in that chain where an LLM
output flows into a decision-bearing table without passing a zod schema **and**
a policy function.

## 2. Main application flows

### 2.1 Conversational turn (hot path, target < 1.5s to first token)

1. `POST /api/chat` — authn, zod-parse `{conversationId, text}`.
2. Persist the user message.
3. **Deterministic context assembly** (no LLM): system prompt + profile card
   (structured facts, budgeted ~250 tokens) + entity cards for entities
   mentioned or recently active + top-k episodes (hybrid recency-weighted
   vector search, k≤6) + last N turns. Budgeted and truncated by priority, so
   context size is bounded regardless of memory size.
4. If a `drafted` `reconnect_opportunity` exists for this user, a **marker** is
   injected into context — `{ entityId, entityName, status: 'drafted' }` and
   nothing else. The model may decide whether now is a good moment and may write
   an optional lead-in sentence. It does **not** receive `rendered_text`,
   `rendered_text_hash`, the `SharePayload`, or any part of the family message
   body (F1). If the model raises it, application code inserts `rendered_text`
   verbatim into the turn (`04` §11.2a).
5. Stream the response from the fast model. Persist the assistant message.
6. **Commit a durable ingestion job** (`jobs`, `kind='ingest'`, `key=messageId`,
   status pending) in the same transaction as the assistant message — *before*
   any post-turn work is attempted.
7. **Attempt that job immediately, in-process**, once the response is flushed:
   extraction → memory → events → baselines → signals → **opportunity draft**
   (minimize → render → guard → persist text + hash) → mark completed. Guarded
   by a per-conversation advisory lock so two fast turns can't race the same
   recompute.

   The draft step is inside the job deliberately: it means the offer is a
   finished, guarded, stored artefact before the next turn ever begins, so the
   hot path never waits on a render. It is skipped when the opportunity already
   has a `rendered_text`, which keeps the job idempotent across retries — a
   redelivered job never produces a second, different draft.
8. **On failure or runtime termination the row simply stays pending.** The next
   request to arrive drains up to N pending jobs older than a few seconds
   before doing its own work.

**Why post-turn and not inline:** extraction wants a stronger, slower model and
costs 1–3s. Putting it on the critical path taxes every turn to serve a write
that nobody is waiting on.

**Why the job row is committed before the attempt rather than on failure:** on
a serverless runtime, work scheduled after the response may never run at all —
the instance can be frozen or reclaimed the instant the response is flushed,
and a failure that never executes cannot record itself. Durability has to be
established *before* the fragile step, not inside its error handler. The row is
the commitment; the in-process attempt is an optimisation on top of it. That
buys at-least-once semantics from one table — no queue, no Redis, no cron.
Safe precisely because extraction is idempotent per message id and event
creation is idempotent per observation fingerprint (§7 of `02`), so a repeated
attempt is a no-op rather than a double write.

### 2.2 Reconnect flow (the demo spine)

```
signal fires
  → opportunity (status: proposed)
  → minimize to SharePayload (whitelisted fields only)
  → LLM renders the exact family message from that payload alone
  → deterministic output guard (deny-list, shape, template fallback)
  → persist rendered_text + sha256(rendered_text) on the opportunity
  → [LLM] decides whether now is a good moment; may add a lead-in
  → [det] UI inserts rendered_text VERBATIM, never via the model (status: offered)
  → user says yes                                               (status: approved)
  → consent_grant: scope, payload snapshot, rendered text + hash,
                   granting message id, 72h expiry
  → family_request created from the STORED string — no model call here
  → magic link (token owned by the request) delivered
  → family member opens link, reads one warm sentence, responds
  → family_response parsed to {answer, when} + free text
  → closure: companion surfaces it on the user's next turn, or as a gentle
    conversation-opener if the user is idle
```

Every arrow is a deterministic transition with an audit row.

**The LLM's role here is narrow, and the boundary is the consent guarantee
(F1).** It is called once to *render* the message from the payload (in the draft
path, B), and once to decide *when* to raise it and optionally write a lead-in
sentence. It is **never** the thing that shows the user the draft.

The conversational model is not given `rendered_text` in its context at all —
only the fact that a drafted opportunity exists, and for which entity. It
therefore cannot paraphrase, quote from memory, summarize, translate or
"helpfully" reword a message it has never seen. The stored bytes are inserted by
a deterministic UI component:

```
[model-authored lead-in, optional]  "You've not seen John in a while."
[DETERMINISTIC]                     "I can send John this message:"
[DETERMINISTIC, VERBATIM]           <rendered_text, exactly as stored>
[DETERMINISTIC]                     "Would you like me to send it?"
```

Consent attaches to that verbatim block, not to the model's framing around it.
And between approval and send there is no model call at all: the bytes the user
approved are the bytes that go out, verified by hash.

**Why withholding the text from context is stronger than instructing the model
not to alter it:** an instruction is a request that a non-deterministic system
usually honours. Absence of the text from context is a property that holds on
every sample, at any temperature, under any prompt injection in the user's own
speech. The cheapest way to guarantee the model does not paraphrase the draft is
to make sure it never sees it.

### 2.3 Cold-start flow

Identical code path. The pattern engine returns `NO_BASELINE` with reasons, so
no cadence signal can fire. The companion simply converses and accumulates
events. The *only* reconnect path available to a new user is a user-asserted
absence ("I haven't seen John this week") — which is the user's own statement,
not an inference, so it needs no baseline. This is a feature, not a fallback:
it means day-one users still get the headline behaviour, just phrased with less
confidence.

## 3. Folder structure

```
caretloop/
├─ app/
│  ├─ (companion)/
│  │  ├─ page.tsx                   chat surface (RSC shell + client transcript)
│  │  └─ debug/page.tsx             memory & baseline inspector (dev only)
│  ├─ (family)/f/[token]/page.tsx   magic-link family view
│  └─ api/
│     ├─ chat/route.ts
│     ├─ consent/route.ts
│     ├─ family/[token]/respond/route.ts
│     └─ dev/seed/route.ts          demo fixture (guarded by NODE_ENV + secret)
├─ core/                            ← pure, no I/O
│  ├─ baseline/{compute.ts,thresholds.ts,types.ts}
│  ├─ detection/{cadence.ts,absence.ts,suppression.ts}
│  ├─ consent/{machine.ts,policy.ts}
│  ├─ memory/{resolve-entity.ts,salience.ts}
│  ├─ safety/{output-guard.ts,deny-list.ts}
│  └─ share/{payload.ts,minimize.ts}
├─ server/
│  ├─ services/{conversation.ts,ingestion.ts,jobs.ts,pattern.ts,reconnect.ts,family.ts}
│  ├─ repositories/{entities.ts,episodes.ts,events.ts,baselines.ts,...}
│  ├─ adapters/{openai/,recorded/,clock.ts,notifier.ts}
│  ├─ prompts/{conversation.v1.ts,extraction.v1.ts,render-family.v1.ts}
│  └─ db/{client.ts,types.generated.ts}
├─ fixtures/demo-george/{timeline.ts,recorded-extractions.json}
├─ supabase/migrations/
├─ scripts/seed-demo.ts
└─ tests/{unit,golden,e2e}
```

**Why prompts are versioned files with ids:** a prompt change is a behaviour
change. Naming them `extraction.v1` and logging the prompt id on every call
means a regression is traceable to a diff, and golden tests can pin a version.

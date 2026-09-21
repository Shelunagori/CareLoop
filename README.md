# CareLoop

[![CI](https://github.com/Shelunagori/CareLoop/actions/workflows/ci.yml/badge.svg)](https://github.com/Shelunagori/CareLoop/actions/workflows/ci.yml)

**An engineering exploration inspired by Olympia.**

A long-term conversational companion for older adults. It learns the people and
routines that matter to someone, notices observable changes, and — only with
explicit consent — helps them reconnect with family.

While exploring Olympia, I became interested in what longitudinal
conversational memory could enable once a companion becomes proactive rather
than purely responsive. CareLoop is a working answer to one question:

> Can a companion notice a meaningful change in someone's relationships or
> routines and help them reconnect — without giving the language model
> authority over real-world decisions?

The governing invariant, in one line:

> **The LLM is a sensor and a renderer; it is never the decision-maker.**

## Explore CareLoop

| | |
|---|---|
| **[Engineering Review](https://care-loop-lac.vercel.app/review)** | The full stage-by-stage walkthrough. **Start here** — it explains the architecture before asking you to use anything. |
| **[Live Demo](https://care-loop-lac.vercel.app)** | Your own anonymous session and your own seeded world. |
| **[Source Code](https://github.com/Shelunagori/CareLoop)** | This repository. |

## Contents

[What CareLoop explores](#what-careloop-explores) ·
[Try it in two minutes](#try-it-in-two-minutes) ·
[How it works](#how-it-works) ·
[Language intelligence vs authority](#language-intelligence-vs-authority) ·
[Architecture](#architecture) ·
[Technology stack](#technology-stack) ·
[What live testing changed](#what-live-testing-changed) ·
[Privacy and safety](#privacy-and-safety) ·
[Repository layout](#repository-layout) ·
[Local setup](#local-setup) ·
[Deeper engineering reference](#deeper-engineering-reference)

## What CareLoop explores

A long-term conversational companion prototype. It maintains structured
relationships and conversational memory over time, notices observable changes
in routines or explicit statements of absence, and — only with explicit
consent — helps initiate a family reconnection.

It does not diagnose, and it does not infer mood, loneliness or cognitive
decline. "I haven't seen John" is an observable statement about a week;
"George is lonely" is a claim about someone's inner life, and the system is
built so that claim cannot be made.

The same line holds for health. If somebody says they were not feeling well,
CareLoop answers warmly, and may offer to pass **that sentence** on to one
family member with their explicit approval. What it stores is that they said
it — never a severity, a symptom, a cause or a trend, because none of the
types involved has a field for one. It is not medically validated and is not
an emergency service; language about immediate danger stands every proactive
offer down rather than being routed through any of this.

George, John and Simba are synthetic demo data — rows in a seeded fixture, not
names any code branches on.

This is an engineering exploration inspired by the product space, not a
competitor to or a critique of anything in it.

## Try it in two minutes

1. Start the [demo](https://care-loop-lac.vercel.app)
2. Ask *"Who is Simba?"*
3. Say *"I haven't seen John today."*
4. Read the proposed message and approve it — word for word, this is what travels
5. **Before any reply arrives**, ask whether John has replied
6. Open the delivered email and answer as John
7. Return to CareLoop and ask *"Any update from John?"*

Step 5 is the one worth doing deliberately: it is where most companions would
guess.

For the complete stage-by-stage explanation of what happens behind the screen,
see the **[Engineering Review](https://care-loop-lac.vercel.app/review)**.

## How it works

```
George
  ↓  conversation                          probabilistic — language in, language out
  ↓  structured observation                probabilistic — extraction against a schema
  ↓  memory / relationship context         DETERMINISTIC — SQL relations; pgvector for episodes
  ↓  pattern detection                     DETERMINISTIC — baselines, explicit thresholds
  ↓  reconnect opportunity                 DETERMINISTIC — a row, not a hunch
  ↓  exact-text consent                    DETERMINISTIC — shown, approved, hashed
  ↓  authorized family request             DETERMINISTIC — one transaction
  ↓  Brevo                                 transport
John
  ↓  capability response                   DETERMINISTIC — bounded choices
  ↓  persisted family response             DETERMINISTIC — a row
  ↓  deterministic closure                 DETERMINISTIC — no model is called at all
George
```

The model appears twice, at the start, translating language in both
directions. Every step that decides something — whether a pattern counts,
whether consent was given, whether a message may be sent, whether a reply
arrived — is deterministic code in `core/` or a conditional SQL update.

### Exact-text consent

```
WHAT GEORGE SEES
      =
WHAT GEORGE APPROVES
      =
WHAT JOHN RECEIVES
```

- The draft is **persisted before** it is shown.
- Approval applies to that exact stored text, identified by hash.
- The hash is re-checked before delivery.
- Nothing is regenerated after approval.
- The conversational model has no part in the send path after approval.
- Ambiguity does not approve: a parser returning `unclear` leaves the offer standing.

Details in [The consent rule](#the-consent-rule).

## Language intelligence vs authority

| Language model (probabilistic) | Application (deterministic, authoritative) |
|---|---|
| Understand conversational language | Entity resolution rules |
| Extract structured observations | Memory commits |
| Use bounded retrieved context | Cadence and baseline calculation |
| Produce ordinary conversational prose | Pattern thresholds |
| Render a family draft from minimized data | Signal creation |
| | Reconnect opportunity state |
| | Consent |
| | Outbound authorization |
| | The exact approved bytes |
| | External-world family response state |
| | Verified closure |

> Use models where ambiguity is useful. Use deterministic application state
> wherever an action, a privacy boundary, or an external-world truth is
> involved.

## Architecture

```
app/                 →  server/services/  →  server/repositories/  →  core/
HTTP + UI               use-cases            Postgres + state         pure domain
                                          →  server/adapters/
                                             external providers
```

| Layer | Responsibility |
|---|---|
| `core/` | Pure deterministic domain logic. No I/O, no SDK, no clock. |
| `server/services/` | Use-case orchestration — a turn, a send, a closure. |
| `server/repositories/` | Postgres access and state transitions. |
| `server/adapters/` | External providers, behind ports. |
| `app/` | HTTP routes and UI. |

Dependencies point one way, enforced by ESLint. Every vendor sits behind a
port — `LlmProvider`, `ExtractionProvider`, `EmbeddingProvider`,
`SpeechToTextProvider`, `VoiceProvider`, `FamilyRenderProvider`, `Notifier`,
`Clock` — so the domain depends on a capability rather than on a company.
Moving the whole AI stack between providers was one line of the composition
root plus new adapters; no route, service or domain module changed.

## Technology stack

| | Role |
|---|---|
| Next.js 16 + TypeScript | Application, routes, orchestration, UI |
| Supabase Postgres | Persistent state — conversations through closures |
| Supabase Auth | Isolated anonymous reviewer sessions |
| pgvector | Episodic similarity retrieval only — see below |
| **Cloudflare Workers AI** | **Active provider for all five AI paths**: conversation, extraction, family rendering, embeddings, transcription |
| ElevenLabs | Optional text-to-speech |
| Brevo | Transactional family email |
| Vercel | Deployment (`sin1`, beside the database) |
| Vitest + PGlite | Testing, against real Postgres-compatible behaviour |

pgvector is used **only** for episodic similarity retrieval — recalling things
someone once described. Entity and relationship identity is resolved
relationally, not through vector search: who somebody is, and how they are
related, are facts in tables rather than nearest neighbours.

Committed model ids:

| | |
|---|---|
| Text | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Embeddings | `@cf/baai/bge-m3` |
| Transcription | `@cf/openai/whisper-large-v3-turbo` |

### Observed production latency

| Path | Sample | p50 | p95 |
|---|---:|---:|---:|
| Chat — first response chunk | n=12 | 2.0 s | 4.5 s |
| Chat — complete turn | n=12 | 3.1 s | 7.9 s |
| Voice transcription — fixed 7.9 s audio sample | n=12 | 3.0 s | 4.9 s |

Small production sample measured against the deployed Vercel application after
warm-up; these are observed timings, not an SLA or load-test result. Requests
were issued one at a time from a single browser on the deployed origin, so
nothing here says anything about concurrency, other regions or weak networks.
No request failed. "First response chunk" is the first byte of the NDJSON
stream reaching the browser, which is not the same thing as model
time-to-first-token. Percentiles are nearest-rank, so at n=12 the p95 is the
slowest run observed.

The slowest chat sample (7.9 s) also triggered a reconnect offer, so it
exercised additional rendering work beyond a simple conversational turn; it is
intentionally retained rather than excluded as an outlier. The fixed
transcription sample measures endpoint latency, not transcription quality
across microphones, accents or noisy environments.

## What live testing changed

Each came from running the thing for real. The pattern is the same all three
times: **test → observe → move an architectural boundary** — not "add another
instruction to the prompt".

| | Observed | Change |
|---|---|---|
| **1** | Asked whether a family member had been in touch, the model produced a plausible reply that did not exist. | Waiting/reply state became application-owned: a delivered request with no response puts an explicit negative into the turn. |
| **2** | After a genuine reply, the deterministic update was followed by contradictory generated language. | Verified closure turns became fully deterministic — the conversational model is not invoked. |
| **3** | A wake-word prototype was not reliable enough for a dependable product experience. | Removed it and kept push-to-talk. Four general correctness fixes it surfaced were retained. A later attempt — opt-in, with a server-decided expiry — earned its place and shipped as "Nora". |
| **4** | After "How are you doing?" / "It was good, what about you?", a reconnect card appeared — and reappeared unchanged later in the same conversation. | Detection and presentation had been separated only halfway. One gate now asks whether the *current* turn still supports *this* opportunity; a refusal keeps the draft waiting and spends no cooldown. |
| **5** | "Don sent me a message today" was answered with a question about John. | Extraction runs after the reply, so a first mention can never have a card — and the cards that did exist read as an agenda. The turn now states plainly when nobody in memory was named. |
| **6** | "I was not feeling good today" got a shallow answer and a change of subject. | An explicit self-report is now an application-owned fact: a warm follow-up, and a consented offer to tell one family member the bare sentence. |
| **7** | A reviewer's recording showed "Reset demo — development only" in the product chrome, and the built bundle still carried those words. | The development copy moved into server components; the one client module that needs interactivity now contains no words at all, and a test scans the built output. The controls then moved off the page entirely, to `/dev`. |
| **9** | An empty conversation said "Say hello whenever you're ready." under a static "Hello, George" header. | The person was being asked to start, and the header was a label rather than a greeting. One sentence now: a time-of-day greeting from the **browser's** clock, plus either the deterministic memory question or an ordinary "How are you doing?". Nothing is invented to personalise it. |
| **10** | "Hey Nora" was required before every single answer. | A voice-originated turn now opens a bounded **conversation burst**: when the reply finishes, one follow-up window opens on its own, under the same endpointing contract. Silence ends the burst. Send is still pressed by a person, so a spoken "yes" is chat input and never an authorization. |
| **8** | An entity reclassified to `origin = 'dev'` still rendered "RECONNECT WITH TESTPERSONA" on page load. | The rule had been added to one of nine reads of an entity's name, and the card a reviewer sees first comes from a different one. Provenance is now a single core rule, applied at every presentation boundary and filtered in SQL as well — because the opportunity was created while the entity was still classified `user`, so nothing stored on it could ever have revealed the change. |

## AI-assisted development workflow

Coding agents were used heavily here: bounded implementation tasks, repetitive
repository work, test generation, refactors, targeted investigation of
unfamiliar code, and drafting documentation. That acceleration is real and
worth being plain about.

It is not the same thing as engineering authority. The product hypothesis, the
system architecture, the trust and privacy boundaries, the decision about what
is deterministic and what may be probabilistic, the data-sharing rules, the
acceptance criteria, the final review of generated changes, the production
validation, and every architectural change made after a failure was discovered
— those were mine.

```
product hypothesis / architecture
        ↓
explicit invariants + acceptance criteria
        ↓
bounded implementation task
        ↓
coding agent implementation
        ↓
tests + lint + typecheck
        ↓
diff review
        ↓
adversarial / mutation / live testing
        ↓
production observation
        ↓
change the architecture when the boundary is wrong
```

The last step is the one that matters. During live testing the conversational
model produced a plausible family reply before any real reply existed. The
response was not to write a firmer prompt. It was to inspect the persisted
family-request and family-response state, recognise that an external-world
truth had been left inside the model's authority, and move waiting/reply state
into deterministic application state. A later live test surfaced a
contradictory continuation after a genuine reply, and the answer there was
architectural too: verified closure turns no longer invoke the conversational
model at all.

Accelerating implementation is not delegating system authority. Where an
action, a privacy boundary or an external-world fact is involved, the decision
stayed in application code — and the decision about *which* those are stayed
with me. [What live testing changed](#what-live-testing-changed) has the
detail.

## Privacy and safety

- No medical diagnosis
- No loneliness or mood inference
- No transcript shared with family
- Exact-text consent before anything is sent
- No automatic or implied approval
- No post-approval rewriting
- No plaintext family capability token persisted
- No background microphone
- Raw audio is transient only
- Family receive only minimized, approved information
- Verified external-world state is application-owned
- A wellbeing note repeats what the person said, never an assessment of them
- No model writes a wellbeing message — it is a fixed sentence
- Nobody receives one unless exactly one family contact is configured
- Urgent language stands every proactive offer down
- Development-seeded people are never named to a person

## Repository layout

| Path | What lives here |
|---|---|
| `app/` | Routes and UI. Depends on `server/services`, never on repositories directly. |
| `core/` | Pure domain: baselines, detection, consent, safety guards, minimization. No I/O, no framework, no database — enforced by ESLint. |
| `server/services/` | Use-cases that compose repositories, adapters and `core`. |
| `server/repositories/` | Typed Postgres access, one per aggregate. Every transition is a conditional update. |
| `server/adapters/` | Ports: LLM, extraction, embeddings, family renderer, notifier, clock. |
| `server/prompts/` | Versioned prompt files; a prompt change is a behaviour change. |
| `server/db/` | Supabase client seam and generated types. |
| `supabase/migrations/` | Schema, RLS and the atomic RPCs. |
| `fixtures/`, `scripts/` | Demo timeline and the seeder that replays it through the production pipeline. |
| `tests/` | `unit` (pure core and services), `db` (real Postgres via PGlite), `golden` (recorded extraction). |

Dependency direction: `app → server/services → repositories/adapters → core`.

## Local setup

Requires **Node 22 or newer** (`engines.node`, `.nvmrc`).

```bash
npm install
cp .env.example .env.local     # then fill it in — see below
npm run dev
```

`.env.example` documents every variable and is placeholders only. What each
group does is in [Technology stack](#technology-stack); what you have to
configure is here:

| Configuration | Required |
|---|---|
| Supabase | yes |
| Cloudflare Workers AI | yes — one account id and one API token cover every AI path |
| Brevo | required for real family email delivery |
| ElevenLabs | optional |
| `OPENAI_*` compatibility variables | not required by any active runtime path |

Model ids all have defaults and need setting only to pin something else. The
`OPENAI_*` variables are kept for rollback compatibility with the previously
deployed revision; local development needs none of them.

---

# Deeper engineering reference

Everything below is implementation detail: the same decisions, with the
reasoning and the failure each one was written against.

Every decision that matters — whether a pattern counts as a change, whether an
opportunity may be offered, whether consent was given, whether a message may be
sent — is made by pure deterministic code in `core/` or by a conditional SQL
update. The model extracts structure from speech and renders words; it never
chooses.

**The architecture is frozen.** The decision record is `docs/00-overview.md`
(D1–D8, R1–R8, F1–F6, E1–E3). Read it before changing anything structural.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Scaffold, schema, layer boundaries | Complete |
| M1 | Conversation loop, prompts, transcripts | Complete |
| M2 | Ingestion, entity resolution, embeddings, memory retrieval | Complete |
| M3 | Events, cadence and absence baselines | Complete |
| M4 | Detection, suppression, reconnect drafting | Complete |
| M5 | Exact-text consent and the family loop | Complete |
| M6 | Deterministic demo fixture (George / John / Simba) | Complete |
| M7 | Demo UX, accessibility and product polish | Complete |
| M8 | Push-to-talk voice | Live-accepted |
| M9 | Production demo readiness audit | Complete |
| M10 | Anonymous per-visitor public demo identity | Complete |
| M11 | Production family email delivery (Brevo) | Complete |
| Hardening | Cloudflare Workers AI migration; verified family-response grounding | Complete |
| M12 | "Nora" opt-in wake word with a server-authoritative expiry; bounded per-turn endpointing | Live-accepted |
| M12d | Memory-aware conversation, one bounded proactive opening, senior recovery and voice-state UX, conversation evals | Complete |
| M12e | Contextual reconnect presentation, current-turn memory precedence, consented wellbeing share, entity provenance | Complete |

## What it does

```
conversation  →  events  →  baselines  →  detection  →  draft
                                                          ↓
      older adult sees the EXACT drafted text, verbatim  ←─┘
                              ↓
              explicit yes / no  (deterministic, not inferred)
                              ↓
          exact-byte send to family  →  family replies
                              ↓
                    deterministic closure back to the older adult
```

CareLoop does not diagnose. It does not infer loneliness, depression or
cognitive decline. It never shares a transcript. What travels to a family
member is a minimized payload and a rendered sentence the older adult read
first, word for word, and approved.

### The consent rule

The conversational model is **never given the drafted message**. It receives a
marker — `{entityId, entityName, status}` — and nothing else, so it cannot
paraphrase, summarise or improvise a message into existence. The offer is
assembled outside the model:

```
I can send John this message:

<the exact stored rendered_text, byte for byte>

Would you like me to send it?
```

The reply is read by a deterministic parser that may only return
`approve`, `decline` or `unclear`. Ambiguity never approves. After approval
there is **zero LLM involvement** in the send path: the bytes that go out are
the bytes that were shown, verified against a stored hash before delivery.

Consent is a snapshot — payload, rendered text, hash and the id of the message
that granted it — with a 72-hour window and no status column; its state is
derived (`used` > `revoked` > `expired` > `active`). A family access token is
32 random bytes, stored only as a SHA-256 hash, compared in constant time, and
valid for 7 days.

### Authorization and transport are different jobs

Creating the family request, spending the consent and consuming the
opportunity happen in **one transaction, before the network call** (frozen E3).
The request row *is* the durable outbound obligation:

```
family_request exists  ⇔  grant consumed  ⇔  opportunity consumed
```

Delivery then runs outside that transaction, against the row that already
exists. A failure leaves it `pending` and retryable; a retry sends the same
bytes on the same request with a freshly rotated token (the plaintext is never
stored) and the *original* expiry. The older adult is never asked to approve
something twice.

A request's read window is seven days, and expiry is a **lifecycle transition,
not a return value**: `pending | delivered → expired` is persisted by a bounded
opportunistic sweep on the post-response path (no cron, no worker). Suppression
is defensive about it — a request past its window stops counting as outstanding
the moment the clock says so, whether or not the row has caught up, so a stale
row can never silence the companion about that person.

The recipient is bound structurally inside the creation transaction: the
contact must belong to the user, and the consent scope, the contact and the
opportunity must all name the same entity. Foreign keys prove those ids are
real; they prove nothing about them belonging together, and `service_role`
bypasses RLS.

The ordering matters because a database cannot transact with an external
delivery provider.
Consuming first means the surviving crash window is "authorized but not yet
delivered" — unfinished transport, which a retry fixes. Consuming after
delivery would instead leave "delivered but consent still live", and the retry
for that window messages a real person a second time.

### Voice is an input and an output, not a second brain

The microphone sits in the composer, and one press is the whole interaction
model. After that press the pipeline is the one that already existed:

```
press the microphone  →  record  →  release the microphone
   ↳ /api/voice/transcribe (language pinned)
     → the transcript lands IN THE COMPOSER, where it can be read and edited
     → the person presses Send
     → /api/chat → turn events → /api/voice/speak
```

The transcript is never auto-submitted. Speech-to-text mishears names, and a
mishearing that sends itself is irreversible in a product whose whole purpose
is messaging somebody's family. Everything after the transcript is the typed
path, unchanged: there is no second chat endpoint, no voice consent path and
no model in the client — which is why a spoken "yes" reaches the same
deterministic consent parser a typed one does.

**The microphone opens on a press and closes on every ending.** Nothing listens
in the background, nothing is buffered between recordings, and `getUserMedia`
appears in exactly one module, reached from exactly one button. Releasing it is
deliberately not left to the caller: the recording handle has a single ending
that stops the tracks, clears its timers and answers everyone waiting, and the
person's stop, their cancel, the duration ceiling and the browser's own
`onstop` all lead there. A review found the one path that did not — the ceiling
stopped the recorder while the tracks stayed live — which is why the ending is
now one function rather than a rule each call site has to remember. Raw audio
is never stored: it exists for one request and is replaced by a transcript.

**Speech output is authorized, not supplied.** The browser does not send a
sentence to be spoken — it sends a **reference** to something the server
already produced and showed (an assistant message, the offer on the table, a
closure). The server resolves it, proves it belongs to the caller and derives
the words from storage, so "CareLoop only speaks what CareLoop said" is a
property of the endpoint rather than a convention the client is trusted to
follow. Reading replies aloud needs `ELEVENLABS_API_KEY` and
`ELEVENLABS_VOICE_ID`; without them the provider is constructed as one that
declines, so the application boots, typed chat and transcription are untouched,
and only `/api/voice/speak` answers `503`.

**A hands-free wake word was built, removed, and later earned back.** M9 added
"Nora", local wake detection and a persistent listening session; live
acceptance proved the detection too unreliable to put in front of a person,
and the session listening too unpredictable to reason about. It was deleted
rather than left behind a flag — dormant code that still passes its tests is
the kind nobody can explain a year later. Four general correctness fixes it
surfaced were kept: the consent qualifier rule, the pinned transcription
language, empty-transcript safety, and the distinction between "I didn't catch
that" and "that recording failed".

M12 brought it back on different terms, and the terms are the point. Nora is
**off by default**, it ends on a date the **server** decides rather than the
browser, and there is no always-open session — a wake starts one bounded turn,
which ends on silence, on a maximum duration, or on the Stop button. The
arming state is derived from one value, so the interface cannot say
"Listening" while the detector is paused, and the detector is never armed
while CareLoop is speaking or while an unsent transcript is waiting.
Push-to-talk remains the path that always works, and a build without a wake
key simply has no Nora control.

#### Voice scope and a production path

What exists today is one path, and it is deliberately simple:

```
push-to-talk ─┐
              ├→  complete recording  →  transcription
"Hey Nora" ───┘        (bounded turn, ends on silence or a limit)
              →  transcript appears as editable composer text,
                 labelled as having come from speech
              →  explicit submission by the person
              →  the existing conversation pipeline
              →  optional ElevenLabs speech output
```

**Voice is I/O. It is not a second reasoning path.** There is one
conversational source of truth, the transcript is visible and editable before
anything is sent, state transitions are predictable, a mishearing is recovered
by editing rather than by undoing a message, and a reliable press beats an
unreliable hands-free mode. CareLoop does **not** currently do streaming
speech-to-text, duplex audio, barge-in, interruption handling, streaming
text-to-speech or continuous listening.

A production speech-to-speech system would likely evolve toward:

```
streaming audio  →  VAD / endpointing  →  streaming STT
                 →  incremental turn state  →  streaming model output
                 →  streaming TTS  →  cancellation / barge-in
```

Most of the difficulty there is not in the pipeline diagram. It is in
interruption and barge-in, endpoint detection, noisy rooms, accents,
speakerphone, Bluetooth and hearing-aid audio paths, recovery from partial
transcription, and weak networks — none of which can be settled without real
product and device testing. This is a direction, not a capability claim.

Latency and cost are measurements rather than assumptions; a production
evaluation would separately track transcription latency, time-to-first-token,
turn completion, TTS start time, failure rate and provider usage.

### A family reply is an external-world fact

Whether somebody replied is not something the companion can work out, and it is
not something it is allowed to decide. The application checks, and the
application says.

Before a real response exists, the turn carries deterministic state saying a
message was sent and no reply has been recorded, and CareLoop may say exactly
that. After one exists, the closure is built from persisted rows — response,
closure, rendered sentence — and the **conversational model is not called at
all** on that turn: both the sentence stating the reply and the short
continuation after it come from application code.

That is stronger than instructing the model not to invent one. An instruction
is a probability, and being told your family got in touch when they did not is
not a thing to leave to probability.

### The card is the server's word, not the model's

A reconnect offer reaches the browser as FIELDS — recipient, exact stored
draft, opportunity id — and the turn ends with a `state` event that is the
server's closing word on the reconnect, `null` included. That makes the event
load-bearing: a turn path that cannot read the pending offer ends every turn by
saying there is none, and the card it just drew disappears while the
opportunity stays open. The turn's dependencies require that read model, so
omitting it is a compile error rather than a vanishing card.

## Database

Migrations live in `supabase/migrations/` and are the frozen schema in SQL.

```bash
npm run db:start    # local Supabase (requires Docker)
npm run db:reset    # re-apply all migrations
npm run db:types    # regenerate server/db/types.generated.ts (never hand-edit)
```

`entities.origin` (M12e) records whether a row was created by the extraction
pipeline, the demo fixture or a development seeding route. Only the last is
refused on the presentation path — "TestPersonA" is spelled exactly like a
name, so no label rule could ever have told them apart. Existing rows were
left as `user` rather than reclassified on a guess; the fixture stamps itself
on the next `Reset demo`. The consequence, the cleanup and the exact apply
procedure are in [`docs/12-dev-data-cleanup.md`](docs/12-dev-data-cleanup.md).

The two M12e files are **re-runnable** — a guarded `create type` and
`add column if not exists` — because they are applied by hand to a live
project rather than by `db reset` to an empty one, and a half-applied file is
a real outcome there. `tests/db/generated-types.test.ts` applies them to a
real Postgres, applies them again, and asserts the result matches
`server/db/types.generated.ts` value for value.

Three RPCs carry the transitions that must be atomic: `materialize_signal`
(M4), and `create_authorized_family_request` / `record_family_response` (M5).
All are `SECURITY INVOKER` with a pinned `search_path`, revoked from the
browser roles and granted to `service_role` only. They hold no product policy —
they are transaction boundaries, not decisions.

## Checks

```bash
npm run test        # pure core, services, real Postgres, and UI
npm run test:ui     # the interface tests alone (jsdom)
npm run lint        # includes the core/ purity boundary
npm run typecheck
npm run build
```

Tests run against PGlite with pgvector — a real Postgres — so migrations,
constraints, privileges and RPC behaviour are exercised rather than mocked.
Property tests use a fixed seed (`20260916`). The suite is checked with
mutation testing: behaviour is only considered pinned once deliberately
breaking it turns something red, and surviving mutants are treated as test
gaps, not as noise.

## The public demo

`CARELOOP_DEMO_MODE=true` turns a deployment into a demo anyone can open. A
visitor presses **Start CareLoop demo**, and one Supabase **anonymous** user is
created for them, seeded with their own George fixture.

Anonymous does not mean unauthenticated. The browser holds a real validated
Supabase session with its own UUID and the ordinary `authenticated` role; it
simply has no email or password attached. Every product row is keyed by that
UUID exactly as a permanent account's would be, and the fixture derives every
id from it (`fixtureUuid(fixtureId, userId, key)`) — so two reviewers hold the
same cast and share no row. A reviewer can **Restart demo** to reset their own
world, and only their own: the action re-checks demo mode, a real session, and
the trusted `is_anonymous` claim before it touches anything.

The account is created only by that click. Nothing on a page render signs
anyone in — a crawler or link preview would otherwise mint Auth users, and
Supabase rate-limits anonymous sign-in per IP (30/hour by default). Before
advertising the URL more widely, enable CAPTCHA (invisible hCaptcha or
Turnstile) on the project's Auth settings and review that limit. Expired or
cleared sessions simply start a new demo, so abandoned anonymous users
accumulate; that is accepted for a shared review link and is not cleaned up
automatically.

Before the conversation starts, a reviewer is asked once where John's demo
message should go. A deployment delivers it by email through Brevo
(`BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`); the email carries
the exact approved sentence and a Reply link to the same
`/family/respond/[token]` page the local demo uses. A 201 from Brevo means the
provider ACCEPTED the message — not that it arrived, escaped a spam filter or
was read, and `delivered` has always meant "handed to the transport".

Every send declines tracking for its recipient
(`contactPixelTrackingConsent: false`), so Brevo measures neither opens nor
clicks for these emails. That is there for the clicks: click tracking rewrites
links into individualized redirects, which would turn the Reply href from our
capability URL into a Brevo URL resolving to it — putting a live family token
through their redirector and into their click logs. The field is honoured only
when per-contact tracking consent is enabled on the Brevo account
(Settings → Contacts, unknown contacts set to **No**), so that setting is a
precondition rather than a preference, and the field is sent anyway rather than
trusting the default.

Development is unchanged: `CARELOOP_DEV_USER_ID` still works locally and is
still refused on any deployment. Local delivery still goes to the development
inbox and calls no provider, so no `BREVO_*` value is needed to run the app or
the tests.

## Dev surfaces

Behind a strict four-condition gate — `NODE_ENV === "development"`, not a
Vercel deployment, a non-empty `CARELOOP_DEV_SEED_SECRET` configured, and an
exact `x-careloop-dev-secret` header match. Anything else returns a bare 404.

| Route | Method | Purpose |
|---|---|---|
| `/debug` | GET | Inspect baselines, signals, opportunities, consent grants and family requests |
| `/api/dev/seed-events` | POST | Replay the demo timeline through the production pipeline |
| `/api/dev/detect` | POST | Run a detection sweep on demand |
| `/api/dev/family-inbox` | GET | Read the dev notifier's outbox (stands in for real delivery) |
| `/dev` | GET | **The operator surface.** Reset demo, the family inbox, a link to `/debug`, and the demo's opening line. Kept alongside the two controls on `/` |
| `/dev/family-inbox` | GET | The same outbox as an inbox, so the demo can show both sides of the loop |

The CareLoop page carries **Family view** and **Reset demo** when — and only
when — all four of those conditions hold (M12f). The controls were never the
problem; the labels were, and "(dev)" and "development only" are gone from
the conversation surface. The gate underneath got *stricter*: the page used
to check one condition (`isDebugSurfaceEnabled`) and now asks the same
`operatorAccessAllowed` that `/dev` does. On a deployment they do not render
and their words are not in the bundle, which a build-output scan checks.

Every entity these routes create is stamped `origin = 'dev'` and is therefore
never named to a person. Rows they created **before** that column existed are
classified `user`, because the migration refuses to guess at history — see
[`docs/12-dev-data-cleanup.md`](docs/12-dev-data-cleanup.md) for the one-time
manual cleanup, what `Reset demo` does and does not remove, and why there is
no name pattern anywhere in the runtime code.
| `/family/respond/[token]` | GET/POST | The family recipient page — bounded reply choices, no account needed |

Those two family-inbox surfaces are the only ones that expose a plaintext
token, so a human can click the link during local acceptance; `/debug` never
shows one.

That outbox is one `globalThis`-backed Map per dev server process — shared by
every module evaluation in it, cleared by the demo reset, gone when the server
stops. It is not a delivery record; the `family_requests` row is.

The two are gated differently, and the difference is worth stating plainly. The
**API route** is header-authenticated: the caller proves it knows the secret.
The **page** cannot be — a browser navigating to a URL sends no header, and
putting the secret in the URL to fix that would be worse than the problem. So
the page checks that the secret is *configured* and that the request arrived on
a loopback host (`localhost`, `127.0.0.1`, `[::1]`), which keeps the LAN URL
`next dev` prints beside the local one from reaching a live family capability
link. Host is client-supplied and forgeable, so that is a door, not
authentication; the weight is carried by the two conditions that mean it cannot
render anywhere it could be deployed. `docs/07-demo.md` has the two-tab demo.

### Local acceptance

```bash
npm run db:reset        # local Supabase; check NEXT_PUBLIC_SUPABASE_URL points at it
npm run dev

S=$(grep '^CARELOOP_DEV_SEED_SECRET=' .env.local | cut -d= -f2-)
RUN=$(date +%s)

curl -sS -X POST localhost:3000/api/dev/seed-events \
  -H 'content-type: application/json' \
  -H "x-careloop-dev-secret: $S" \
  -d "{\"preset\":\"absence\",\"entityName\":\"M5Person$RUN\",\"eventType\":\"visit\"}" | jq

curl -sS -X POST localhost:3000/api/dev/detect \
  -H "x-careloop-dev-secret: $S" | jq

# chat until the offer appears verbatim, reply "yes", then:
curl -sS localhost:3000/api/dev/family-inbox \
  -H "x-careloop-dev-secret: $S" | jq
```

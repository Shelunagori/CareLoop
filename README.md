# CareLoop

A long-term conversational companion for older adults. It learns the people and
routines that matter to someone, notices observable changes, and — only with
explicit consent — helps them reconnect with family.

The governing invariant, in one line:

> **The LLM is a sensor and a renderer; it is never the decision-maker.**

Every decision that matters — whether a pattern counts as a change, whether an
opportunity may be offered, whether consent was given, whether a message may be
sent — is made by pure deterministic code in `core/` or by a conditional SQL
update. The model extracts structure from speech and renders words; it never
chooses. The architecture is frozen: the decision record is
`docs/00-overview.md` (D1–D8, R1–R8, F1–F6, E1–E3). Read it before changing
anything structural.

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

The ordering matters because a database cannot transact with an SMS provider.
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

**A hands-free wake word was built and removed.** M9 added "Nora", local wake
detection and a persistent listening session; live acceptance proved the
detection too unreliable to put in front of a person, and the session listening
too unpredictable to reason about. It was deleted rather than left behind a
flag — dormant code that still passes its tests is the kind nobody can explain
a year later. Four general correctness fixes it surfaced were kept: the consent
qualifier rule, the pinned transcription language, empty-transcript safety, and
the distinction between "I didn't catch that" and "that recording failed".

### The card is the server's word, not the model's

A reconnect offer reaches the browser as FIELDS — recipient, exact stored
draft, opportunity id — and the turn ends with a `state` event that is the
server's closing word on the reconnect, `null` included. That makes the event
load-bearing: a turn path that cannot read the pending offer ends every turn by
saying there is none, and the card it just drew disappears while the
opportunity stays open. The turn's dependencies require that read model, so
omitting it is a compile error rather than a vanishing card.

## Setup

Requires **Node 22 or newer** (`engines.node`, `.nvmrc`).

```bash
npm install
cp .env.example .env.local     # fill in Supabase and OpenAI values
npm run dev
```

## Database

Migrations live in `supabase/migrations/` and are the frozen schema in SQL.

```bash
npm run db:start    # local Supabase (requires Docker)
npm run db:reset    # re-apply all migrations
npm run db:types    # regenerate server/db/types.generated.ts (never hand-edit)
```

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

## Dev surfaces

Behind a strict four-condition gate — `NODE_ENV === "development"`, not a
Vercel deployment, a non-empty `CARELOOP_DEV_SEED_SECRET` configured, and an
exact `x-careloop-dev-secret` header match. Anything else returns a bare 404.

| Route | Method | Purpose |
|---|---|---|
| `/debug` | GET | Inspect baselines, signals, opportunities, consent grants and family requests |
| `/api/dev/seed-events` | POST | Replay the demo timeline through the production pipeline |
| `/api/dev/detect` | POST | Run a detection sweep on demand |
| `/api/dev/family-inbox` | GET | Read the dev notifier's outbox (stands in for SMS/email) |
| `/family/respond/[token]` | GET/POST | The family recipient page — bounded reply choices, no account needed |

`/api/dev/family-inbox` is the only surface that returns a plaintext token, so
a human can click the link during local acceptance. `/debug` never shows one.

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

## Layout

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

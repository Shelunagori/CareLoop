# 07 — The demo

Operational. Five minutes, from a clean decision state to a closed loop.

This document describes a **synthetic fixture**. George, John and Simba are
demo data; nothing in production branches on any of those names, and a test
(`tests/unit/demo-fixture.test.ts` §6) fails the build if one ever does.

---

## The cast

| | | |
|---|---|---|
| **George** | the user, 87, retired police officer, lives at home | family call him "Dad" |
| **John** | person, George's son | six visits, weekly, most recent 13 days ago |
| **Simba** | pet, dog | John's dog, and the family's — relational memory, no event history |

---

## A. Reset and set up

```bash
S=$(grep '^CARELOOP_DEV_SEED_SECRET=' .env.local | cut -d= -f2-)

curl -sS -X POST localhost:3000/api/dev/demo/setup \
  -H 'content-type: application/json' \
  -H "x-careloop-dev-secret: $S" \
  -d '{"reset":true}' | jq
```

One call: retire everything the fixture owns, write it back, report the state.
It does **not** need `supabase db reset`, and it does not touch anything the
fixture does not own — restarting the scenario mid-demo is seconds.

**What "owns" means.** The fixture's rows carry deterministic ids derived from
the fixture id, the user and a logical key, so ownership is proved by identity
rather than guessed from a name. If the operator's account already knows a real
John and a real Simba, the fixture creates its own separate rows and the reset
leaves the real ones — with their events, relationships and memories —
completely alone.

Setup also makes sure the **latest conversation is blank**, so reloading `/`
opens an empty chat. Nothing is deleted: previous transcripts stay exactly
where they are, and a second setup with no chat in between reuses the same
blank conversation rather than leaving a trail of empty ones. The response
carries `conversationId` and `conversationCreated`.

The fixture borrows two profile fields (`display_name`, `family_display_name`)
and puts the previous values back on reset, exactly, nulls included. The
snapshot is a row, so it survives a restart, and running setup twice never
overwrites it.

Expected in the response:

```
seeded.entities            John (person), Simba (pet/dog)
seeded.relationships       3, all confirmed
seeded.interactionEvents   6
seeded.baselines[0]        ACTIVE, median 7, MAD 0, threshold 11, last 13 days ago
state.counts               signalsOpen 0, opportunitiesOpen 0, consentGrants 0,
                           familyRequests 0, familyResponses 0, closures 0
```

That last line is the point: **history, no decisions.** The demo begins from a
clean decision state.

Check it again at any time:

```bash
curl -sS localhost:3000/api/dev/demo/state -H "x-careloop-dev-secret: $S" | jq
```

## B. Start the app

```bash
npm run dev
```

---

## C. The script

> The chat page carries a **Reset demo** button in development. It runs the
> same reset, seed and blank-conversation steps as the command above, through a
> server action — the secret never reaches the browser.

### 1. Relational memory

> **Type:** `Do you remember Simba?`

Expect a grounded answer — Simba is John's dog.

> *"That isn't prompt context. John and Simba are structured entities with
> confirmed relationships, and the model is handed that structure, not a
> scripted sentence. Ask it about someone who isn't in there and it says so."*

### 2. The observation

> **Type:** `I haven't seen John this week.`

Nothing visible happens yet, and that is the architecture showing.

The turn is answered first. Extraction, entity resolution and the interaction
event run **after** the response is flushed, on a durable job — so a slow
model, or this process being reclaimed mid-sweep, can never cost George his
reply. Detection then runs on the next ordinary turn.

> *"The absence wasn't seeded. He said it, and the pipeline had to extract it,
> resolve which John he meant, and write it as an event with a window — because
> an absence is a claim about a period, not a moment."*

### 3. Detection and the draft

> **Type:** anything — `It's been quiet.`

Now the sweep has run. Two independent detectors could fire here:

- **explicit absence** — George said it. Needs no baseline at all.
- **cadence gap** — 13 days against a threshold of 11, derived from his own
  history. Median 7, MAD 0.

They are deliberately uncoupled: the person's own statement never depends on
having a rhythm first.

> *"The pattern engine only ever sees observable events. There's no mood
> score in here, nothing infers loneliness, and the word 'lonely' appears in
> this system exactly once — on a deny-list."*

### 4. The offer

A card appears:

```
RECONNECT WITH JOHN

Message to John
┌──────────────────────────────────────────────┐
│ Dad was wondering — are you and Simba able   │
│ to visit soon?                               │
└──────────────────────────────────────────────┘

[ Send message ]   [ Not now ]
```

> *"The model never sees that draft. It gets a marker — an id, a name, a status
> — and the server sends the exact stored bytes to the browser as fields. The
> page renders them; it does not compose them, and it never reads the
> assistant's sentences to work out that an offer is on the table."*

### 5. Consent

> **Press:** `Send message`

The button submits the word `yes` down the ordinary chat endpoint, into the
same deterministic parser a typed answer meets. There is no button-only consent
path. Typing `yes` works identically.

> *"Before anything leaves CareLoop, George reads the exact outbound sentence
> and says yes to that sentence. Ambiguity never approves — 'yes, but maybe
> later' is unclear and the offer stands. And after the approval there is no
> model anywhere in the send path."*

### 6. Delivery

```bash
curl -sS localhost:3000/api/dev/family-inbox -H "x-careloop-dev-secret: $S" | jq
```

The dev notifier stands in for SMS or email. Copy the `responseUrl`.

> *"Creating that request, spending the consent and consuming the opportunity
> are one transaction, before the network call. The row is a durable
> obligation, so a crash mid-send is unfinished transport — a retry, not a
> second conversation with George."*

### 7. The family page

Open the `responseUrl` — worth doing at a phone width, since that is where it
would really be read. John sees a message from **Dad**, the exact approved
sentence, and one question: *Can you visit?* No transcript, no history, no
account.

> **Choose:** `Yes, we're visiting this weekend.`

> *"He's holding a capability, not a login. Thirty-two random bytes, stored
> only as a hash, compared in constant time, dead after seven days."*

### 8. The closure

> **Back in George's chat, type:** `Any news?`

Expect an **Update** card above the reply:

```
UPDATE
John replied that they are planning to visit this weekend.
```

> *"That sentence is rendered by deterministic code from a structured answer —
> `yes` plus a timeframe. The answer is topic-neutral, so the same reply to a
> phone-call request renders as a call. And it's a persisted closure, not
> something the model was asked to remember: CareLoop promised George it would
> ask John, so keeping that promise is a row you can query for."*

---

## D. What each stage demonstrates

| Stage | Architectural point |
|---|---|
| 1 | Structured entity + relationship memory, not prompt stuffing |
| 2 | Extraction off the hot path, durable and replayable |
| 3 | Observable events only; two uncoupled detectors; thresholds from the person's own history |
| 4 | The model is a renderer — it never receives the draft |
| 5 | Exact-text consent; ambiguity never approves |
| 6 | Authorization is a transaction; delivery is transport |
| 7 | Minimized payload, capability token, no account |
| 8 | Deterministic closure — the loop is closed in data, not in prose |

Total: three to five minutes, and it repeats from step A without touching the
database.

---

## D2. Speaking instead of typing (M8)

Every step above works by keyboard. With a microphone, each one also works by
voice, and the architecture does not change:

| | |
|---|---|
| Press the **microphone** in the composer, say the line, press **Stop** | the transcript appears **in the composer** |
| Read it, correct it if it misheard, then press **Send** | it goes down the ordinary `/api/chat` endpoint |
| CareLoop replies | it is read aloud, if voice output is configured |

> *"The transcript is shown before it is sent, on purpose. A microphone can
> mishear a name, and a mishearing that turns itself into an approval is
> exactly what you do not want in a consent flow."*

At the reconnect card, say **"yes"**. It is transcribed to `yes`, shown, sent,
and parsed by the same deterministic consent parser a typed `yes` meets.

> *"There is no voice consent endpoint. If there were, there would be two
> definitions of what counts as agreement, and only one of them would be the
> one under test."*

The speaker is authorized in the same spirit. The page asks for a **message**,
not for words:

```
POST /api/voice/speak  { conversationId, source: { type, id } }
```

> *"The browser is not authoritative about what CareLoop said. If this endpoint
> took a string, anyone with a session could use CareLoop's voice to say
> something the person never saw and never approved."*

If `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are absent, speaking to
CareLoop still works; only reading aloud is unavailable, and the speaker
control says so rather than failing.

## D3. Why there is no wake word

If the question comes up — and with an older-adult product it does — the
answer is a decision, not a gap.

M9 built it: a wake phrase, local wake detection running as WebAssembly in the
page, voice-activity detection, and a listening session that stayed open for a
whole conversation with nothing to press. It worked in tests. Live acceptance
is where it died: the detector fired inconsistently, the session recorded
clips too short or too noisy to transcribe, and a demo that depends on a coin
flip is not a demo.

> *"So it was deleted — not hidden behind a flag. Dormant code that still
> passes its tests is how a codebase ends up with things nobody can explain a
> year later. Push-to-talk is the shipped interaction because it is the one
> that works every time in front of a person."*

> *"What the experiment was worth is what it found. Four bugs it surfaced are
> in the product and have tests: a consent parser that read 'yes but later' as
> a yes, an unpinned transcription language that returned a Chinese character
> for a spoken 'yes', empty transcripts being submitted as messages, and an
> unusable recording being reported to the person as a mishearing."*

**Honest limitation.** A browser page is not an always-on appliance either
way: browsers throttle background tabs and suspend sleeping devices. Voice
input here is a press, and the architecture — a `SpeechToTextProvider` port —
is what a native or hardware client would keep.

## E. What the demo does *not* claim

CareLoop does not detect loneliness, depression, isolation or decline, and
saying so in a demo would be both a product lie and a regulatory problem. The
only evidence in play is:

- *George said he has not seen John this week.*
- *His recorded visit cadence with John changed.*

Both are observable. Neither is a diagnosis.

---

## F. About Simba in the closure

The polished version of this story ends *"John and Simba are planning to
visit."* It does not, and the reason is worth saying out loud in an interview.

Naming Simba on the family page would mean sending John a fact — the name of
his dog — that was never in the minimized payload George approved. That is
exactly the thing the exact-text chain exists to prevent, and a demo flourish
is not a good reason to put the first hole in it.

Simba earns his place in the demo at stage 1, where he belongs: as proof that
CareLoop holds real relationship structure. The closure states only what John
actually answered.

---

## G. Troubleshooting

| Symptom | Cause |
|---|---|
| `404` from a dev route | Not `NODE_ENV=development`, or the secret header doesn't match |
| No opportunity after stage 2 | Ingestion is post-turn; take one more ordinary turn |
| `nothing_to_send` on the inbox | Check `state.counts.opportunitiesOpen` — the offer may not be approved yet |
| Closure doesn't appear | The family response must be submitted before George's next turn |

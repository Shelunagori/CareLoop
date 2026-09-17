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

The chat shows, verbatim:

```
I can send John this message:

<the exact stored draft>

Would you like me to send it?
```

> *"The model never sees that draft. It gets a marker — an id, a name, a status
> — and the application inserts the exact stored bytes around it. It cannot
> paraphrase a message it was never given."*

### 5. Consent

> **Type:** `yes`

Deterministic parse. `approve`, `decline` or `unclear`, and ambiguity never
approves — "yes, but maybe later" is unclear and the offer stands.

> *"Before anything leaves CareLoop, George reads the exact outbound sentence
> and says yes to that sentence — not to the idea of a message. And after the
> approval there is no model anywhere in the send path."*

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

Open the `responseUrl`. John sees a message from **Dad** and the exact approved
sentence — no transcript, no history, no account needed.

> **Choose:** `Yes, we're visiting this weekend.`

> *"He's holding a capability, not a login. Thirty-two random bytes, stored
> only as a hash, compared in constant time, dead after seven days."*

### 8. The closure

> **Back in George's chat, type:** `Any news?`

Expect, as the first line:

```
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

---

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

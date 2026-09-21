# 11. Consent model

## 11.1 Principle

Private conversation is private by default and structurally, not by policy. The
only way information crosses from the companion to a family member is through a
`consent_grant` that the user created by approving **the exact text that will be
sent**.

The ordering matters and was corrected in review (R3): the message is rendered,
guarded, stored and hashed *before* it is shown. The user approves a finished
artefact, not an intention. **After approval the LLM is not called again** — the
stored bytes are what is sent.

## 11.2 State machine (`core/consent/machine.ts`)

```
opportunity:  proposed → drafted → offered → approved → consumed
                  ↓         ↓         ↓          ↓
               expired   expired   declined   expired
                                   expired
```

**Canonical status vocabulary (F5).** These seven names are the only ones used,
in the schema, in `core/`, in the docs and in the debug UI:

| Status | Meaning |
|---|---|
| `proposed` | signal materialized; no draft yet |
| `drafted` | `rendered_text` + hash persisted and guarded; ready to offer |
| `offered` | the verbatim block has been shown to the user |
| `approved` | user said yes; `consent_grant` created |
| `consumed` | `family_request` created from the stored bytes; terminal |
| `declined` | user said no; terminal |
| `expired` | `expires_at` passed before approval, or the grant expired before send; terminal |

```
open     = proposed | drafted | offered | approved
terminal = consumed | declined | expired
```

**"Open" is what suppression counts.** At most one open opportunity per entity
at a time (`03` §10.3). `approved` is deliberately *open*, not terminal: between
approval and send the loop is still in flight, and starting a second one for the
same entity would be exactly the nagging the suppression rules exist to
prevent.

`proposed → drafted` is where all the generation happens:

```
ReconnectProposal
  → minimize()          → SharePayload        (whitelisted fields only)
  → LLM render          → candidate text      (payload is the ENTIRE context)
  → outputGuard()       → accepted text       (or fixed template fallback)
  → persist on the opportunity: rendered_text + sha256(rendered_text)
```

Only then is it offered. `offered → approved` copies the stored text and hash
into the `consent_grant`; it never regenerates them. `approved → consumed`
writes `family_request.rendered_body` from that same stored string.

## 11.2a How the draft is presented (F1)

`drafted → offered` is a **deterministic render**, not a model utterance. The
conversational model's authority in this transition is limited to two things:
whether now is a good moment, and an optional lead-in sentence of its own
words. The draft itself is inserted by application code:

```
[model, optional]   "You've not seen John in a while."
[deterministic]     "I can send John this message:"
[deterministic]     ┌──────────────────────────────────────────────┐
[VERBATIM]          │ <rendered_text, byte-for-byte as stored>     │
                    └──────────────────────────────────────────────┘
[deterministic]     "Would you like me to send it?"
```

The model may not rewrite, paraphrase, summarize, translate, shorten, re-quote
from memory or reconstruct `rendered_text`. It is not asked to refrain from
doing so — **it is never given the text**. Its context carries only a marker:
`{ entityId, entityName, status: 'drafted' }` (`05` §14.4).

**Why this distinction is load-bearing and not pedantry:** consent has to attach
to the bytes that will actually be sent. If the model paraphrases the draft when
presenting it — "I'll ask John about the weekend" — then the user has approved
the paraphrase while the system sends something else. Both might be perfectly
reasonable sentences; they are still not the same sentence, and the user's "yes"
provably referred to the one they were shown. Pinning the text before approval
(R3) and rendering it deterministically at approval (F1) are two halves of one
guarantee: **what was approved is what was shown is what is sent.** Either half
alone leaves a gap.

Transitions are a pure function `(state, event, now) → state | error`. Illegal
transitions throw. The service layer's only job is to persist the result.

**Why a state machine rather than booleans:** `approved_at IS NOT NULL AND
sent_at IS NULL AND NOT revoked` scattered across three call sites is how
consent bugs happen. One function, exhaustively tested, with the `switch` on a
discriminated union so TypeScript fails the build if a state is added and not
handled.

## 11.2b Why the offer appeared (M12)

A `cadence_gap` offer is the application noticing something on its own, so it
now says so first:

```
You usually see John about once a week, and it's been 13 days.

I can send John this message:

Dad was wondering — are you & Simba able to visit soon?

Would you like me to send it?
```

The first line is a **preamble**, built by `buildCadencePreamble` in
`core/share/offer.ts` from the stored `ReconnectProposal` — `entityName`,
`eventType`, `pattern.medianGapDays`, `observation.days` — by a total function
with no model in the path. The model never receives the proposal (E1), so it
cannot invent how often somebody visits, how long it has been, or why the gap
exists: the four claims that would be most convincing and least checkable.

`medianGapDays` reaches words through one bucket table (`most days` /
`every few days` / `about once a week` / `about every couple of weeks` /
`about once a month` / `about every N months`). Interpretation, but
deterministic, total and reviewable in one place; the underlying number is
unchanged.

**The preamble is not part of the offer block.** The block's bytes are what
consent attaches to and what the browser strips to draw the card, so a
sentence folded into them would be invisible to the person *and* would change
the string the transcript is searched for. It is persisted between the model's
words and the block — `reply \n\n reason \n\n block` — which is what makes a
reloaded transcript read identically to the live turn.

**An explicit absence gets no preamble.** The person supplied that context in
this conversation; restating it back at them would be the system explaining
the person to themselves. The two triggers stay separate, here and in `03`
§10.3a.

## 11.2c What may be answered (M12g)

A reviewer typed:

```
Yeah, it was good. Tell me about something about weather.
```

and CareLoop replied **"Thank you — I'll send that to them now."** It then
sent it. Two independent faults had to line up, and both are now closed.

**A yes is the whole sentence.** `affirmative_opener` is anchored at the
start and said nothing about what came after it, so a message that opened
agreeably and then changed the subject approved an irreversible family
action. This is P1 (`"yes but later"`) in a new disguise, and the M9 fix
could not have caught it: that fix works by vocabulary — `later`, `maybe`,
`not now` — and changing the subject has no vocabulary. What separates a yes
from a sentence beginning with one is not *which* words follow but that
**any** do. The opener now counts only when the message is substantially
just the affirmation (`OPENER_MAX_WORDS = 6`). Every explicit phrase —
`send it`, `go ahead`, `yes please`, `that's fine` — stays unanchored and
unbounded, so a wordy but genuine approval is still an approval. Refusal is
never bounded: a long sentence that starts with "no" still means no.

**And an offer nobody was shown cannot be answered at all.** Even a real yes
should not have been able to act here, because the card had never been drawn:
the opportunity belonged to a `dev`-provenance entity that `prepareOffer`
refuses to present (§11.2a), and `handleConsentReply` had no such rule — it
fell back to the word "them" when the name came back unprintable. So
`answerableOffer` in `server/services/consent.ts` now applies two conditions
before any reading of the reply is acted on:

| Condition | Why |
|---|---|
| the stored bytes appear in the recent transcript | Consent answers a question. A question nobody was asked cannot be answered — not by a yes, and not by a no. `needsRepresenting` has always used this exact test to decide whether to redraw the card, so the two halves of the loop now agree on what *shown* means. |
| the entity is presentable (`user` or `demo`) | A rule that governs only the half of a loop the person can see is not a rule. |

Both fail in the same direction: the cost of being wrong is a missed nudge,
against an unrequested message to somebody's family.

This is why `handleTurn` reads the bounded transcript **before** the consent
step rather than after it (step 3, then step 4). Reading has no side effects,
so nothing else about the turn changed.

**And the interface stopped auto-sending into it (M12h).** A wake-word
transcript now sends itself after a three-second countdown — except while an
offer is on screen, where it never does. That is the same rule a third time,
in the third place it can be broken: the parser decides what a yes is, the
service decides which offer may be answered, and the composer decides
whether the person had to press anything at all. Consent is the one turn in
CareLoop that is always sent by hand.

## 11.3 What is stored as evidence

```ts
type ConsentGrant = {
  opportunityId: string
  scope: { recipientEntityId: string; purpose: 'reconnect_request';
           fields: ('entityName'|'topic'|'timeframe'|'question')[] }
  payloadSnapshot: SharePayload      // copied from the opportunity, not rebuilt
  renderedTextSnapshot: string       // exactly what the user was shown and approved
  renderedTextHash: string           // sha256 of the above, pinned at draft time
  grantingMessageId: string          // the user's literal "yes", in situ
  grantedAt: Date
  expiresAt: Date                    // +72h
  usedAt?: Date                      // single use
  revokedAt?: Date
}
```

**Why snapshot the rendered text:** consent to "ask John if he's visiting" and
consent to a specific sentence are different things, and only the second is
verifiable after the fact. The user is never surprised by what their family
received — which is the actual trust requirement.

**Send-time preconditions, all deterministic, all fatal on failure:**

These run **before** the creation transaction opens (§12.2a), never inside the
delivery step:

1. grant exists, `usedAt` is null, `revokedAt` is null, `now < expiresAt`;
2. opportunity status is `approved`;
3. `sha256(grant.renderedTextSnapshot) === grant.renderedTextHash`;
4. `grant.renderedTextHash === opportunity.rendered_text_hash`;
5. `grant.payloadSnapshot` deep-equals `opportunity.share_payload`.

Any mismatch aborts the send and logs — it never re-renders, never "repairs",
and never falls back to a freshly generated sentence. A mismatch means
something changed after the user agreed, and the only safe response to that is
to not send. Because the text is pinned before approval rather than generated
after it, a drifting model or a prompt edit can only cause a *refusal*, never a
surprise.

**Why single-use and 72h:** an approval is about a moment. A standing permission
to message family on the user's behalf is a different product with a different
consent conversation, and quietly acquiring one through a single "yes" would be
the exact failure the spec is guarding against.

**Revocation:** the companion accepts "actually, don't" up until delivery;
`revokedAt` is set and the send refuses. After delivery it can't be unsent, and
the companion says so honestly rather than pretending.

## 11.4 Data minimization (`core/share/`)

```ts
type SharePayload = {
  fromDisplayName: string        // "Dad" — the user's chosen label, not their account name
  aboutEntityName?: string       // "Simba"
  topic: 'visit'
  timeframe?: 'this weekend'
  question: string               // from a small closed set
  freeNote?: string              // ONLY if the user dictated it explicitly
}
```

The family-render LLM call is constructed from this type and nothing else. It is
a **separate call with its own system prompt and no conversation history in
context**, made at draft time (before the offer), never after approval.
Not "we tell the model not to include the transcript" — the
transcript is not in the process's reach at that point. There is a test that
snapshots the outbound prompt and asserts no message content appears in it.

`freeNote` is the one channel for user words, and it only populates when the
user explicitly dictates a message ("tell him I miss Simba"), in which case the
user is the author and consent is self-evident.

## 11.5 Three expiries, three responsibilities (F2)

Each clock governs exactly one question, and none of them extends another.

| Clock | Starts | Governs | On expiry |
|---|---|---|---|
| `reconnect_opportunity.expires_at` | at materialization | how long a reconnect suggestion may remain *offerable* | `opportunity → expired`; cannot be offered, approved or sent. A future reconnect needs a **new signal → new opportunity → new draft** |
| `consent_grant.expires_at` (72h) | at **approval** | how long the system may *execute* the approved send | send refused; grant expired; opportunity → `expired`. The user must be asked again via a fresh opportunity and a fresh draft |
| `family_request.token_expires_at` (7d) | at request **creation** (not delivery) | how long *that one family member* may open and answer *that one request* | request → `expired`, whether or not delivery ever succeeded. It does **not** reopen the opportunity, and does not extend or revive consent authority |

Sequencing, stated once:

```
before approval   → opportunity expiry is the only live clock
at approval       → consent clock starts (72h to execute)
at send           → grant.used_at set → grant consumed
                    opportunity → consumed
                    family_request created with its own 7d token clock
after send        → the 72h window is irrelevant; a delivered request stays
                    valid and answerable for its own 7 days
```

**Why consent expiry stops mattering once the grant is consumed:** the 72h
window is authority to *perform an action*, not a lease on the message's
existence. Once the send has happened the action is complete and cannot be
un-performed; continuing to enforce the window would mean invalidating a message
John has already received, which is meaningless. Conversely the token clock
cannot revive anything — it is read authority for one recipient over one
artefact, deliberately the narrowest of the three.

**Why an expired opportunity requires a whole new signal rather than a refresh:**
the draft encodes a claim about the world ("you haven't mentioned John in 13
days"). Days later that claim may simply be false. Re-offering a stale draft
would have the system assert something it no longer has evidence for — so
expiry is terminal by design, and the path back is through detection, which
re-checks the evidence. V1 does exactly this and nothing cleverer.

# 12. Family-message / action model

## 12.1 Access — signed magic link

- The token is owned by the **`family_request`**, not the contact (R7).
  `family_contacts` holds identity — who John is, how to reach him — and no
  capability at all.
- 32 random bytes, base64url, stored **hashed** (`sha256`) in
  `family_requests.access_token_hash`; the plaintext exists only in the link.
- One token per request, minted at send, expiring 7 days later (§11.5),
  non-enumerable, non-guessable, and carrying no user or contact identifier.
- No account, no password, no session. The URL *is* the capability.

**Why the request and not the contact owns it:** a token on the contact is a
standing key to whatever that contact is ever sent — it accumulates authority
over time and cannot be rotated without breaking old links. A token on the
request is a capability scoped to exactly one approved sentence, which is the
same granularity as the consent that produced it. Access control should not be
broader than the consent it enforces. Practically: a leaked link exposes one
sentence and expires, rather than becoming a permanent read handle.

**Why:** a family member's first contact with CareLoop should be one tap to a
warm sentence and a reply box. A signup wall at that moment is where the loop
breaks in real life. Security-wise a scoped, hashed, expiring, single-purpose
capability URL is a reasonable posture for a POC carrying one sentence of
non-sensitive content, and the scoping is itself the privacy demonstration: the
link cannot enumerate, cannot see history, cannot see anything the user did not
approve. (Confirmed with you; the upgrade path to Supabase Auth is a
`family_contacts.auth_user_id` column and an RLS policy, no schema rewrite.)

## 12.2 Objects

```
family_request   the approved message: rendered_body (copied verbatim from the
                 consent grant), rendered_body_hash, payload, status,
                 access_token_hash, token_expires_at
family_response  the family member's reply: raw text + parsed {answer, when}
closure          the response surfaced back to the user
```

## 12.2a Request creation vs delivery (E3)

Creating the request and delivering it are two steps with different failure
modes, and the boundary between them is where consent idempotency lives.

**Step 1 — one database transaction, no network inside it:**

```
validate: grant active, not used, not revoked, within 72h;
          opportunity.status = approved;
          all five hash/payload preconditions (§11.3)
   ↓
BEGIN
  insert family_request(status = 'pending', rendered_body = <stored bytes>,
                        access_token_hash, token_expires_at = now + 7d)
  set consent_grant.used_at = now
  set opportunity.status = 'consumed'
COMMIT
```

**Step 2 — delivery, outside the transaction, against that existing row:**

```
notifier.send(request)
  success → status = 'delivered', delivered_at = now
  failure → status stays 'pending', delivery_attempts += 1,
            last_delivery_error recorded
            retry THE SAME request, THE SAME bytes, THE SAME token
```

A retry never creates a second request and never consumes consent again —
`UNIQUE(family_requests.opportunity_id)` makes that structural rather than a
matter of the retry code being careful.

**Why the transaction stops at the network boundary:** holding a database
transaction open across a notifier call ties a lock to someone else's timeout.
The cost of ending it before delivery is that a request can exist without having
been sent — which is exactly the state `pending` names, and is recoverable by
retry. The cost of the alternative is a stuck transaction, which is not.

**Why consent is consumed at creation rather than at successful delivery:** the
user approved *sending this message to John*. Once the request exists with those
bytes and that token, the decision has been acted on; delivery is a transport
concern the user should never be asked about twice. If consumption waited for
delivery, a transient email failure would put the system in the position of
re-asking an older adult to approve something they already approved — the worst
possible place to introduce friction, and one that trains people to click yes
without reading.

**Retry is opportunistic, not infrastructural.** A pending request older than a
few seconds is picked up by the same `jobs` drain that handles ingestion (`01`
§2.1). No queue, no worker, no Redis.

## 12.2b Lifecycle

```
pending ──delivery succeeds──→ delivered ──family replies──→ answered
   │                               │
   └──────── token expires ────────┴──────→ expired
```

One terminal `expired` covers both "never delivered" and "delivered but
unanswered" (E3). The distinction is recoverable from the row anyway —
`delivered_at` is null in the first case, and `delivery_attempts` /
`last_delivery_error` say why — so a second status name would add vocabulary
without adding information. An `expired` request cannot be delivered and cannot
be answered; the token is dead on both sides.

An expired request is terminal and does not reopen its opportunity (§11.5). The
older adult is not asked again automatically — a fresh reconnect requires a
fresh signal, as everywhere else.

`family_request.rendered_body` is written by copying bytes, never by generating
them. The one place in the system where a model output becomes an outbound
message is the draft step, several states earlier, behind the guard and the
user's explicit approval.

Response parsing is an LLM extraction into
`{ answer: 'yes'|'no'|'unsure', when?: {date?, dayPart?, textual}, note? }`,
schema-validated. If parsing fails or is low-confidence, the deterministic layer
falls back to relaying the family member's own words verbatim — which is safe,
because those words are theirs and they wrote them knowing they'd be passed on.

## 12.3 Closing the loop

A `closure` is created as soon as a response arrives. It is surfaced on the
user's next turn, injected into context as a structured fact with high priority
so the companion opens with it. If the user is idle beyond a threshold the
same closure becomes a proactive opener — the mechanism is identical, only the
trigger differs.

**Why closure is a row and not just "the model will remember":** an
unacknowledged promise ("I'll ask John") is the most damaging thing this product
can do. Making it a persisted obligation with a `surfaced_at` means you can
query for broken loops and alert on them, rather than hoping.

## 12.4 The family surface

One page, deliberately small:

- who it's from, in the user's own words ("Dad was wondering whether you and
  Simba are visiting this weekend");
- two quick replies (Yes / Not this time) plus a free-text box;
- a confirmation that tells the family member exactly what will be passed back;
- nothing else. No metrics, no history, no activity feed, no "status".

**Why so little:** the moment this page shows trends, timestamps or wellbeing
indicators it becomes surveillance software, and the older adult's side of the
product becomes a monitoring device they didn't consent to. Keeping the family
view to *one message and one reply* is a product decision that is also an
architectural one — there is no endpoint that returns the user's history to a
family member, so the temptation cannot be satisfied later without a deliberate,
reviewable change.

Visual register: large warm type, generous spacing, one accent colour, no charts,
no clinical iconography. It should read like a note passed between family, not a
dashboard.

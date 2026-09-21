# 8. How baseline creation should work

A baseline answers one narrow question: **for this user, this entity, and this
event type, is there a regular rhythm, and what is it?**

It is a pure function. No LLM, no I/O:

```ts
computeBaseline(events: InteractionEvent[], now: Date, cfg: BaselineConfig): Baseline
```

## 8.1 Algorithm

1. **Filter** to `(entity, eventType)`, `polarity='positive'`,
   `certainty >= 0.7`, `occurred_at` within the lookback window (180 days),
   precision in `{exact, day}`.
2. **Collapse** to one event per day. This is *statistical normalization* and
   it lives here and nowhere else — ingestion deliberately keeps two genuine
   same-day interactions as two rows (`02` §7, R6). Doing the collapse inside
   the pure function also means it is correct on any input, including
   hand-written test data that never passed through ingestion.
3. **Gate on minimum evidence** (§9). If it fails → `NO_BASELINE` + reasons.
4. **Gaps**: the sorted inter-event intervals in days.
5. **Statistic**: `median(gaps)` and `MAD(gaps)` (median absolute deviation).
6. **Stability**: `dispersion = MAD / median`. If `dispersion > 0.8` →
   status `IRREGULAR`.
7. Otherwise `ACTIVE`, with `cadence_days_median` and `cadence_days_mad`.
8. Persist with `method_version` and `inputs_hash = hash(sorted event ids)`.

**Why median + MAD instead of mean + standard deviation:** with 4–12
observations, one outlier (a fortnight away at Christmas) drags a mean badly and
inflates a standard deviation enough to suppress every future signal. Median and
MAD are robust at exactly the sample sizes this product actually has. This is
the kind of choice that reads as either "obvious" or "hadn't thought about it"
in an interview, so it's worth the two lines it costs.

**Status semantics — exactly three, each meaning one thing:**

| Status | Means | Cadence detector |
|---|---|---|
| `NO_BASELINE` | insufficient *historical evidence* | cannot run |
| `IRREGULAR` | sufficient evidence, but no stable rhythm | must not run (would be noise) |
| `ACTIVE` | sufficient historical evidence **and** a regular rhythm | runs |

Note what none of them mean: *"we haven't seen this entity lately."* Recency is
not a property of the baseline at all — it is an input to the detector (§10).

**Why `IRREGULAR` is distinct from `NO_BASELINE`:** they imply different
behaviour. `NO_BASELINE` = not enough data yet, keep listening. `IRREGULAR` =
plenty of data, this relationship genuinely has no rhythm, so a cadence signal
would be noise — though the user's own statements about it remain actionable.
Collapsing the two would make the system either over-eager or permanently silent
about spontaneous relationships.

**If baselines ever need to expire, that is a fourth status (`DORMANT`), not an
overload of `NO_BASELINE`** — "we never knew" and "we knew, and it stopped" are
different claims and would need different wording to the user. Out of scope for
V1; noted so the enum has an obvious place to grow.

**Why `method_version` + `inputs_hash`:** a stored baseline that you cannot
reproduce is not evidence, it's a rumour. With these, the debug view can
recompute from the same inputs and prove the stored value, and a threshold
change can be rolled out with a known blast radius.

## 8.2 Recompute trigger

Post-turn, only for the `(entity, eventType)` pairs touched by that turn's
events, plus a lazy staleness check (`computed_at` older than 24h) on read.
No cron, no full-table sweep. Cost is proportional to what changed.

## 8.3 Explainability

`GET /api/debug/baseline/:entityId` returns the whole derivation: contributing
events with ids and dates, the gap list, median, MAD, dispersion, thresholds,
each gate's pass/fail, the decision and the method version. The dev-only
`/debug` page renders it as a timeline. Two reasons this is in the plan and not
a nice-to-have: it is how you debug the system at all, and it is the single most
convincing thing to put on screen when someone asks "how do you know it isn't
just the model guessing?"

# 9. Minimum-evidence / cold-start strategy

A baseline is only created when **all** of:

| Gate | Threshold | Why |
|---|---|---|
| `observationCount >= 4` | 4 positive events | 3 events give 2 gaps; you cannot compute a dispersion you'd trust from 2 numbers |
| `spanDays >= 21` | first→last event | 4 events in one week is a burst, not a rhythm |
| `distinctGaps >= 3` | | guards against same-day collapse leaving too few intervals |

**Deliberately *not* a gate: `daysSinceLastEvent` (R4).** An earlier draft
invalidated a baseline once the entity had been quiet for more than `3 × median`
days. That was self-defeating: a long absence would delete the very baseline the
cadence detector needs in order to notice the absence, so the system would go
blind at precisely the moment it should speak. Evidence gates are about
*historical* evidence only — how much we have seen, and whether it had a rhythm.
How long it has been since the last event is detector input (§10.1), never a
condition on the baseline's existence.

Failing any gate:

```ts
{ status: 'NO_BASELINE',
  reasons: [ { code: 'INSUFFICIENT_EVENTS', have: 2, need: 4 },
             { code: 'INSUFFICIENT_SPAN',   haveDays: 9, needDays: 21 } ] }
```

Machine-readable reasons, not a bare null — the companion can say *why* it
doesn't know yet, the debug view can show progress toward a baseline, and tests
can assert on codes rather than on absence.

**What a cold-start user still gets.** This is the important half of the answer,
because "return NO_BASELINE" alone describes a system that does nothing for its
first month:

- Normal conversation with full structured + episodic memory from turn one.
- Relationships learned and used ("how's Simba?").
- **Absence-assertion reconnects** — the user's own statement is evidence and
  needs no baseline. George on day two: *"I haven't seen John this week"* →
  valid signal → offer → consent → family request. The entire headline flow
  works on day two; only the *phrasing* differs:

  | | With `ACTIVE` baseline | With `NO_BASELINE` |
  |---|---|---|
  | wording | "You usually see John and Simba most weekends — you haven't mentioned a visit in about two weeks." | "You mentioned you haven't seen John this week." |
  | claim made | a pattern | a quoted fact |

  The confidence of the language is bound to the confidence of the evidence.
  The system is never more certain out loud than it is internally.

- A visible "still getting to know you" state in the debug view rather than a
  silent void.

**Why no global new-user grace period beyond 14 days of cadence silence:**
cadence signals are suppressed for the first 14 days regardless (there cannot be
a meaningful one), but absence assertions are not, because suppressing a user's
own explicit statement would be the system ignoring the clearest evidence it
will ever get.

# 10. Pattern-change detection approach

Two independent deterministic detectors. Both emit a `Signal` carrying an
`explanation` object — never prose.

## 10.1 `cadence_gap`

Requires an `ACTIVE` baseline. `daysSinceLastEvent` is an input to this
detector, computed at detection time — it is not, and must not become, a
condition on the baseline (R4).

```
threshold = max( median + 2·MAD,
                 median · 1.5,
                 median + 4 days,     // absolute floor: never fire on a 1-day wobble
                 7 days )             // no signal for daily-contact relationships
fire when daysSinceLastEvent > threshold
```

Worked example, matching the demo fixture:

```
median = 7, MAD = 1
  median + 2·MAD = 9
  median · 1.5   = 10.5
  median + 4     = 11
  absolute floor = 7
threshold = max(9, 10.5, 11, 7) = 11 days
daysSinceLastEvent = 13  →  13 > 11  →  fires
```

The binding constraint here is the `median + 4` floor, not the MAD term — worth
noticing, because with a tight, regular cadence the statistical term is almost
always the *smallest* of the four and the floors are what actually govern
behaviour. A tolerance of 11 days on a 7-day rhythm is roughly "a missed
weekend, plus a few days of grace" — deliberately unhurried.

The multiple floors exist because a tight cadence (daily calls) would otherwise
produce a signal from a single missed day — technically a deviation, socially
absurd. Thresholds live in `core/baseline/thresholds.ts` as named constants with
comments, so tuning is a reviewable diff rather than a magic number hunt.

```ts
explanation = {
  detector: 'cadence_gap', methodVersion: 'v1',
  medianGapDays: 7, madDays: 1, thresholdDays: 11, daysSinceLast: 13,
  lastEventId: '…', lastEventDate: '2026-09-03', contributingEventCount: 9
}
```

## 10.2 `user_asserted_absence`

Fires on an `absence` event the user stated. Works with any baseline status. If a
baseline exists it is attached for richer phrasing, but it is not required.
Higher priority than `cadence_gap` — the user's own words outrank our statistics,
and if both fire for the same entity only this one survives.

## 10.3 Suppression (deterministic, `core/detection/suppression.ts`)

- one **open** opportunity per entity at a time — `open = proposed | drafted |
  offered | approved`, per the canonical vocabulary in `04` §11.2;
- 7-day cooldown per entity after any offer, 30 days after a decline;
- two declines for an entity in 30 days → 90-day quiet period for that entity;
- no cadence signals in the account's first 14 days;
- nothing while an un-responded `family_request` is outstanding;
- global cap of one offer per conversation, three per week.

Suppression runs **once per signal**, at materialization. Its outcome is
recorded on the signal itself: either `status = materialized` (with the
opportunity created in the same transaction) or `status = suppressed` with a
`suppression_reason` naming the rule that fired. That makes "why didn't it say
anything?" a row you can read rather than a re-derivation.

**Suppression is not what prevents duplicate opportunities (F3).** It is pacing
policy — time-dependent, re-enterable, and legitimately able to answer `yes`
twice for the same signal on two attempts. The one-signal-one-opportunity
invariant is enforced structurally by `UNIQUE(reconnect_opportunities.signal_id)`
(`02` §4.1). Keeping these two concerns apart means a cooldown tuning change can
never reintroduce duplicate offers.

**Why suppression is a first-class module rather than scattered guards:** the
failure mode that kills this product is nagging. The rules that prevent it need
to be in one file, testable, and readable by a non-engineer. It also means
"why didn't it say anything?" has an answer.

## 10.3a Conversational pacing for cadence-only offers (M12)

Suppression above decides whether an opportunity may *exist*. This decides
whether now is the moment to *say it*, and it is a different question with a
different clock: suppression counts days, this counts turns.

Observed in production:

```
person:   "hello"
CareLoop: (ordinary reply)
person:   "good and u"
CareLoop: "...I can send John this message..."
```

The detection was entirely correct — six visits, median 7 days, MAD 0,
threshold 11, last visit 13 days ago. What was wrong is that the application
chose the second thing the person had ever said to raise a family matter.
Correct proactivity delivered at the wrong moment reads as arbitrary, and an
older-adult product cannot afford to feel arbitrary.

**The rule.** `detectionConfig.minUserTurnsBeforeCadenceOffer` (3). A
`cadence_gap` opportunity is not offered until the person has taken that many
turns in the conversation. Evaluated in `prepareOffer`, **before** the
`drafted -> offered` transition, so a withheld offer is not spent: no
`offered_at`, no 7-day cooldown started, nothing the person can be said to
have declined. The row stays `drafted` and the next qualifying turn inside
`opportunityOfferabilityHours` shows it.

**`user_asserted_absence` is exempt**, for the same reason it is exempt from
`newAccountCadenceQuietDays`: the person opened the subject themselves, and
making them wait two more turns to be answered would be the system ignoring
the clearest evidence it will ever get.

The turn count is a `COUNT` on the conversation, not the length of the bounded
recent-turns window. Deriving it from that window would make a rule about the
conversation quietly mean "within the last 20 messages".

## 10.4 The safety guard (spec items 9 & 10)

The detector produces a `ReconnectProposal` — structured, observable facts only:

```ts
type ReconnectProposal = {
  entityName: 'John'; alsoMention?: ['Simba']
  observation: { kind: 'no_mention_since'; days: 13 }
        | { kind: 'user_stated_absence'; quotedWindow: 'this week' }
  pattern?: { medianGapDays: 7 }        // omitted when NO_BASELINE
  question: 'ask_if_visiting'; timeframe: 'this weekend'
}
```

The LLM renders this into a sentence and receives **only this object** — no
transcript, no affect vocabulary, no health context. Then a deterministic output
guard checks the result:

- deny-list of affect/clinical terms (`lonely, isolated, depressed, sad,
  withdrawn, decline, symptoms, unwell, worried about you, …`);
- must not contain a causal construction linking a person's absence to the
  user's state;
- must contain the question;
- on failure → log and fall back to a fixed template string.

**Why a guard and not just a good prompt:** "never diagnose" as a prompt
instruction is a request; as a post-generation check with a template fallback it
is a property of the system. The product invariant "no inference about internal
state" is too important to hold only in English. The deny-list is a blunt
instrument and will occasionally cost a nicer sentence — the trade is correct
here, and the template fallback means the cost is a slightly flatter sentence,
never a failed turn.

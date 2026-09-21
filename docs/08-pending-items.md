# Pending items

Things found outside the scope of the milestone that found them. Each row is
recorded rather than fixed, because a bug discovered while building something
else is still a change to a frozen area, and changing one quietly is how a
locked decision stops being one.

| # | Found in | Area | Item | Why it was not fixed here |
|---|---|---|---|---|
| P2 | M9 (open) | `app/api/voice/transcribe/route.ts` (M8) | The route returns **415** for two different rejections: `unsupported_type` (the container is not on the allow-list) and `empty_audio` (the recording is under `minAudioBytes`). The second is arguably "nothing heard" rather than a media-type fault, but the status cannot tell them apart — only the `error` code in the body can. | The review's instruction was explicit: 415 is a transcription/recording failure. Reinterpreting one of its two meanings by reading the body would be a route-contract change smuggled into an error-classification fix. Today both produce a sanitized failure and zero chat submissions, so nothing unsafe follows from it. A future change could give `empty_audio` its own status. |
| P3 | Composer polish | `app/_components/chat.tsx` | `micSupported` is assigned from `isRecordingSupported()` in an effect and then **never read**. The microphone control renders unconditionally, so on a browser without `MediaRecorder` the person presses it and gets the "couldn't reach your microphone" note instead of never being offered it. | Hiding a control based on capability is a behaviour change, and the brief for this pass was the composer's presentation only. Nothing unsafe follows — the failure is caught, explained without browser internals, and typing is unaffected — but the check either wants to be used or wants to be deleted. |
| P4 | M12 (Nora) | `app/_components/chat.tsx` | Restoring a remembered `Nora = on` requires `navigator.permissions.query({name:"microphone"})` to report `granted`. Safari does not implement the `microphone` permission descriptor, so the query throws, the code treats that as "not granted", and the preference silently never restores there. Nora still works in Safari — it just has to be switched on by hand every load. | The alternative is to auto-arm without checking, which would make a microphone-permission prompt appear at somebody who has only just opened a page. Given the choice between a preference that does not restore and a prompt nobody asked for, this pass took the first. A capability probe (try the query, fall back to a stored "permission was granted before" flag) would fix it, and is a behaviour change to the auto-arm path rather than a bug in it. |
| P5 | M12 (Nora) | `README.md`, `docs/07-demo.md` §D3, `app/review/page.tsx` | All three state that a wake word was built and removed and that there is no wake word. Code for one is now in the tree. The statements remain true of every **deployment**, because without `NEXT_PUBLIC_PICOVOICE_ACCESS_KEY` and a keyword model CareLoop does not fetch the status, render the control or load the engine — but they are no longer true of the repository. | The milestone's instruction is explicit: do not update `/review` or the README to claim Nora exists until live acceptance passes. Live acceptance has not been run (no microphone in the build environment), so the documentation stays as it is and this row records the gap instead. **RESOLVED in M12e.** Live acceptance of the Nora turn passed, so `README.md` and `app/review/page.tsx` now describe what the repository actually contains: a wake word that was built, removed, and later earned back on bounded terms. `docs/07-demo.md` §D3 is updated in the same pass. |
| P9 | M12d (safety audit) | `server/prompts/conversation.v6.ts`, last three lines | If somebody says something indicating immediate danger to themselves, CareLoop's entire response is a **prompt instruction**: *"If they raise something urgent or frightening about their health or safety, say plainly that you are not able to help with that and that they should speak to someone who can."* There is no deterministic detector, no resource surfaced, no logging, and no escalation. The instruction has been in every prompt version since v1 and has never been exercised in testing. | Building a detector is building a clinical-risk classifier, which is out of scope for a POC and is the kind of system that must not be shipped on a heuristic. The boundary is documented in `docs/06-delivery.md` §18 and is honest; what is NOT honest is that a prompt rule is a probability, and this codebase has now been shown three times what that is worth. See the report accompanying M12d for what a production escalation path would require. **Narrowed, not closed, in M12e:** a deterministic list of danger phrases now stands every PROACTIVE path down — no reconnect card, no wellbeing share, no offer of any kind on such a turn (`core/wellbeing/self-report.ts`, `URGENT`). That is a routing decision and nothing more: it assesses nothing, ranks nothing, logs no phrase, surfaces no resource and contacts nobody. What the person is TOLD is still the v1 prompt instruction, and that is still a probability. |
| P10 | M12e | `server/repositories/entities.ts`, `touchMention` | `entities.mention_count` exists in the schema, has a `not null default 0`, and is never written — `touchMention` updates `last_mentioned_at` alone. Every row therefore reports zero mentions forever. Nothing reads it today, so nothing is wrong; a column that lies is a trap for whoever reads it first. | Found while tracing why a first mention has no card. Incrementing it is a one-line change to a frozen repository on a pass about presentation, and "how many times has this person been mentioned" is exactly the kind of number a future feature would reach for and be misled by. Either write it or drop it — both are decisions, neither is this pass's. |
| P12 | M12e.2 (test triage) | `app/_components/chat.tsx`, the arm effect | The sentence "Nora is listening for 'Hey Nora'" is derived in RENDER, so it paints on the tick playback ends. The detector is actually subscribed two awaits later — revalidate the server status, then `resume()`. For that window the interface claims to be listening and is not, and a wake word spoken the instant the assistant stops talking is missed. | Closing it means either a second "actually armed" display state, or arming before the availability check. The first is the imperative second path M12 deliberately removed; the second would arm a microphone before the server has said it may. In a browser the window is one status round-trip, and push-to-talk is unaffected. Recorded rather than fixed, and the test now waits for the real thing instead of the sentence — which is how it was found. |
| P11 | M12e | `core/wellbeing/self-report.ts` | The self-report rule under-detects on purpose and therefore misses real statements: "my knee has been playing up for days", "I've had a rough week", a symptom named without a wellness word. It also cannot see anything said in a language other than English. | Deliberate, and the asymmetry is the whole argument: a missed report costs one ordinary conversational turn, while a false one puts words about somebody's health in front of them and offers to forward them. Widening it safely means evaluation against real utterances, which needs real users. Recorded so the limit is visible rather than assumed away. |
| P7 | M12c | `core/share/minimize.ts`, `sanitizeLabel` | The rule that decides whether a label may be shown as a person's name is a character class: letters, marks, spaces, apostrophes, hyphens, dots. An identifier made only of those — `entity-john` — is therefore indistinguishable from `Mary-Jane` and is presented. Every identifier CareLoop itself mints carries a digit or an underscore and is refused. | Every way of closing it guesses at what a name looks like. Banning hyphens loses Jean-Luc; requiring a capital loses non-Western capitalisation; matching `entity-` is the fixture-specific rule this fix exists to avoid. Recorded, with a test that states the limit rather than hiding it (`tests/unit/offer-label-safety.test.ts` §2a). **RESOLVED in M12e**, by the schema change this row named. `entities.origin` records whether a row came from the extraction pipeline, the demo fixture or a development seeding route, and the presentation path refuses the last. The label rule stays exactly as it is — it is a good rule about characters, and provenance is a different question that it was never going to answer. |
| P8 | M12c | `README.md` §manual verification, `/api/dev/seed-events` | The README's own verification recipes post `entityName":"M5Person$RUN"` with `RUN=$(date +%s)`, creating permanently-named entities in whatever project `.env.local` points at. One of them — `M4Absence1789574558` — surfaced in a reviewer-facing reconnect card. The route behaved exactly as specified; the recipes leave litter behind. | Local development data, not production logic, and the presentation fix above means such an entity can no longer be shown. The recipes could name their entities from a reserved, obviously-disposable pattern and offer a teardown, but changing documented verification steps mid-milestone would invalidate a procedure already run. **Narrowed in M12e:** the route now stamps every entity it creates `origin = 'dev'`, so nothing it leaves behind can be named to a person, whatever it is called. Rows created by it BEFORE that migration are still classified `user` — re-running the recipe re-creates them correctly, and the migration deliberately guesses at nothing. **Closed in M12e.1** by a one-time manual cleanup, `supabase/snippets/m12e-dev-entity-cleanup.sql`, documented in `docs/12-dev-data-cleanup.md`: inspect, reclassify or delete by id, verify. It is human-run and contains no name pattern, because a rule that would not be acceptable in runtime code is not one to run by hand against a database either. |
| P6 | M12 (endpointing) | `app/_components/chat.tsx`, `finishRecording` | A finished transcript is written with `setInput(text)`, which **replaces** whatever was in the composer. Nora is now safe from this — the wake detector is not armed while the composer holds anything (`core/nora/state.ts`) — but **push-to-talk is not**: type half a message, press the microphone, and the typed words are gone with no undo. | Pre-existing, and a change to push-to-talk's behaviour rather than to the wake word being built here. Push-to-talk is the permanent fallback and the one interaction that must not move under a reviewer mid-milestone. The fix is small (append, or refuse to record over text, or confirm) but it is a decision about the shipped interaction, not a bug in this one. |
| P1 | M9 | Consent parser (`core/consent/decision.ts`, M5) | `readConsent("yes but later")` returned **approve** via `affirmative_opener`, while `readConsent("yes, but maybe later")` correctly returned `unclear`. A qualified yes approved an irreversible family action. | **RESOLVED** in the M9 consent fix, on review instruction. An unanchored qualifier set now disqualifies an affirmative wherever the hedge appears, and punctuation is stripped before matching. See below. |

> **Note.** M9's hands-free experiment was removed after live acceptance (see
> `README.md`), but both rows survive it: P1's fix is in the shipped consent
> parser, and P2 is a property of the M8 transcribe route, which is still the
> only way audio reaches the server.

## P1, resolved

Transcripts before the fix:

```
"yes"                  -> approve  (affirmative_opener)
"yes but later"        -> approve  (affirmative_opener)   <-- the gap
"yes, but maybe later" -> unclear  (maybe_later)
```

and after:

```
"yes"                  -> approve  (affirmative_opener)
"yes but later"        -> unclear  (qualified_later)
"yes, but later"       -> unclear  (qualified_later)
"yes not now"          -> unclear  (qualified_not_now)
"not now"              -> decline  (not_now)          — unchanged
"don't send it"        -> decline  (dont_send)        — unchanged
```

## P1, as originally recorded

Transcripts observed:

```
"yes"                  -> approve  (affirmative_opener)
"yes but later"        -> approve  (affirmative_opener)   <-- the gap
"yes, but maybe later" -> unclear  (maybe_later)
"not sure"             -> unclear  (not_sure)
"later"                -> unclear  (later)
"not yet"              -> decline  (not_now)
```

The M9 test suite deliberately does NOT assert that `"yes but later"` is
ambiguous, because it is not, and a test written to the behaviour we wish we
had would hide this rather than record it.

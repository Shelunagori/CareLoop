# Pending items

Things found outside the scope of the milestone that found them. Each row is
recorded rather than fixed, because a bug discovered while building something
else is still a change to a frozen area, and changing one quietly is how a
locked decision stops being one.

| # | Found in | Area | Item | Why it was not fixed here |
|---|---|---|---|---|
| P2 | M9 (open) | `app/api/voice/transcribe/route.ts` (M8) | The route returns **415** for two different rejections: `unsupported_type` (the container is not on the allow-list) and `empty_audio` (the recording is under `minAudioBytes`). The second is arguably "nothing heard" rather than a media-type fault, but the status cannot tell them apart — only the `error` code in the body can. | The review's instruction was explicit: 415 is a transcription/recording failure. Reinterpreting one of its two meanings by reading the body would be a route-contract change smuggled into an error-classification fix. Today both produce a sanitized failure and zero chat submissions, so nothing unsafe follows from it. A future change could give `empty_audio` its own status. |
| P3 | Composer polish | `app/_components/chat.tsx` | `micSupported` is assigned from `isRecordingSupported()` in an effect and then **never read**. The microphone control renders unconditionally, so on a browser without `MediaRecorder` the person presses it and gets the "couldn't reach your microphone" note instead of never being offered it. | Hiding a control based on capability is a behaviour change, and the brief for this pass was the composer's presentation only. Nothing unsafe follows — the failure is caught, explained without browser internals, and typing is unaffected — but the check either wants to be used or wants to be deleted. |
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

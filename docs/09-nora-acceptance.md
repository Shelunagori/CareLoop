# Nora — live acceptance protocol (M12)

Nora is **not accepted** until this page is filled in from a real device with
a real microphone. Nothing in `/review` or `README.md` may claim the wake
word exists before then; `docs/08-pending-items.md` P5 records that gap.

The reason this is a page rather than a test is that it cannot be a test.
M9's wake word passed every test it had and died in front of a person — the
detector fired inconsistently and the clips were too short or too noisy to
transcribe. Neither of those is visible to a suite with no microphone in it.

## Prerequisites

| | |
|---|---|
| `NEXT_PUBLIC_PICOVOICE_ACCESS_KEY` | from the Picovoice Console |
| `public/nora/Nora.ppn` | "Nora" trained for the **Web (WASM)** platform. Not a built-in keyword. |
| `public/nora/porcupine_params.pv` | committed |
| Date | on or before **2026-09-25**, UTC — after that the status endpoint refuses and this protocol cannot be run at all |

Without the first two the status endpoint reports `not_configured`, no control
is rendered, and the application is byte-identical to the push-to-talk product.

## A0. One-turn UX — run this BEFORE the 20 attempts

M12b removed the click that used to end a spoken turn, and stopped the wake
detector re-arming over an unresolved transcript. Both are state-machine
changes, and a broken state machine will waste all twenty attempts below.

| | Step | Expected |
|---|---|---|
| A0.1 | Load the page | Nora **off**. Microphone button present. |
| A0.2 | Turn Nora on | `Nora is listening for "Hey Nora".` |
| A0.3 | Say **"Hey Nora"** | Transitions to listening; recording starts with no click |
| A0.4 | Say **"good morning"**, then stop talking | Recording ends **by itself** within ~1.5–2s |
| A0.5 | | Transcript appears in the composer. **Nothing is sent.** |
| A0.6 | | Label reads `Nora is paused while your message is waiting.` — **not** listening |
| A0.7 | Say "Hey Nora" again | **Nothing happens.** The draft is untouched. |
| A0.8 | Press **Send** | Ordinary CareLoop reply, then the label returns to listening |

**B. Cancel path.** "Hey Nora" → speak → transcript appears → press **Clear** →
composer empties → label returns to listening → a wake works again.

**C. No-speech path.** "Hey Nora" → say nothing → within ~5s: *"I didn't hear
anything after that…"*, no transcript, no network call to `/api/voice/transcribe`,
and the label returns to listening.

**C2. Mid-sentence pause.** "Hey Nora" → "I was thinking… *(pause ~1s)* …about
John" → the turn must NOT be cut at the pause. If it is, raise
`silenceToFinalizeMs` in `core/voice/endpoint.ts` and note the value you used.

**D. Push-to-talk regression, Nora OFF.** Microphone button → record → press
Stop → transcript → edit it → Send. Must behave exactly as before, and the
recording must still require the press to end it.

**E. Teardown, checked against the browser's own microphone indicator, not
the label.** Turn Nora off mid-listening; unmount by navigating away
mid-listening. In both cases the indicator must go out immediately, and any
text already in the composer must survive.

## A1. Product-quality pass (M12c)

Four browser-observed defects, each with a check.

**T — Nora and the speaker are mutually exclusive.** There is no barge-in
here, so an armed detector during playback is a microphone pointed at a
loudspeaker about to say the wake word.

| | Step | Expected |
|---|---|---|
| T.1 | Wake, speak, Send, let the reply read aloud | `Stop reading` appears, and the label reads `Nora is paused while I'm reading that out.` |
| T.2 | While audio plays, say **"Hey Nora"** near the speaker | Nothing. No recording starts. |
| T.3 | Let the audio finish | Label returns to `Nora is listening for "Hey Nora".` — once |
| T.4 | Repeat, but press **Stop reading** | Same: re-arms once |
| T.5 | Repeat, and turn Nora **off** while audio plays | Finishing playback does **not** revive it |
| T.6 | Repeat with an unsent draft in the composer | Finishing playback does **not** re-arm |

**S — ordinary smalltalk.** In a **fresh conversation**, say exactly:
`hello` → `good and u` → `how are you doing?` → `I am doing good what about you?`

Expected throughout: warm, natural replies; **no** "I don't have feelings or
experiences like you do"; **no** reconnect card; **no** "would you like to
send someone a message?" prose. Ask "are you a real person?" — it should
then answer plainly and once.

**I — explicit absence still works.** `I haven't seen John today.` →
deterministic explicit-absence path, human-readable **John**, correct draft,
no internal identifier anywhere on the card.

**C — cadence presentation.** With the George/John demo fixture, keep talking
about your day until the offer appears. It must open with the application's
own reason — *"You usually see John about once a week, and it's been 13
days."* — followed by the exact offer block, and must never show a database
or test identifier.

## A2. Product-quality pass (M12d)

**M — memory-aware conversation.** With the demo fixture loaded, say
`John called yesterday.` The reply must name John and ask one question
about the call. It must not list other people, and must not restate what it
knows to prove it remembers. Then say `Rex was in the garden` (or the
fixture's pet): the pet's recorded relationship must be used in the
direction it is recorded — never "your dog" when the record says the pet is
somebody else's.

**P — proactive opening.** Requires a positive `visit` or `call` event dated
1–3 days ago for an entity with a real name. Open CareLoop in a **fresh
browser session** with **no messages in the current sitting**: CareLoop
opens with a question about that event. Reload: it does **not** repeat.
Type anything first: it does not appear at all. With no such event, the page
starts normally and says nothing.

**R — recovery.** Force each of these and read the wording. Nothing may
mention a status code, a provider or an error. Turn off wifi mid-send: the
message must say plainly that nothing was sent and that the words are still
there.

**V — voice state.** One large line at a time. Check every state named in
§A0 and §A1 reads plainly, and that it never says Listening when the
microphone is closed.

**S — reading speed.** Use voice once so the control appears, press
**Read slower**, send a message and listen: slower, same pitch, same words.
Reload — the preference survives.

## A. Wake reliability — 20 intended attempts

Normal speaking voice, normal room, one device. Say "Nora", wait for
**LISTENING**, speak one short sentence, stop, read the transcript.

| | Count |
|---|---|
| Intended wakes detected | / 20 |
| Missed wakes | |
| Accidental wakes (no one said it) | |
| Failed recording starts | |
| Unusably short clips | |
| Failed transcriptions | |
| Successful end-to-end turns | |
| Turns that ended automatically (no click) | / 20 |
| Turns cut off mid-sentence by the silence threshold | |
| Turns that needed the Stop button after all | |

Accidental wakes are counted over the whole session, not per attempt. Leave
the page open and listening between attempts; a wake word that fires at the
television is the failure M9 could not demo around.

**Bar.** This is a judgement, and it is the product's, not the suite's: a
demo that depends on a coin flip is not a demo. If the answer is "usually",
the answer is NOT ACCEPTED.

## B. States — each must leave push-to-talk working

| | Expected |
|---|---|
| 1. Nora OFF | application unchanged; microphone button works |
| 2. Nora ON | wake works; microphone button *also* still works |
| 3. ON → OFF | listener released; no microphone indicator remains |
| 4. Enable after cutoff | "no longer available…"; nothing initialized |
| 5. Page open across the cutoff | toggle flips OFF by itself, no reload; push-to-talk fine |
| 6. Initialization failure (break the key) | "Nora couldn't start. Push-to-talk is still available." |
| 7. Microphone denied | calm reason; typing works |
| 8. Wake, then push-to-talk in the same session | both work |
| 9. Push-to-talk while Nora unavailable | works |
| 10. Ten consecutive wake / re-arm cycles | no drift, no leaked listener |

For 3 and 5, confirm with the browser's own microphone indicator, not with
the interface's label. The label is what the application believes; the
indicator is what is true.

## C. What the deterministic suite already proves

Not to be re-checked by hand:

- the inclusive cutoff boundary, both sides, on a fake clock
  (`tests/unit/nora-availability.test.ts`, `nora-status-route.test.ts`);
- a remembered `on` plus an expired server answer → effectively OFF;
- a stale client's enable request rejected;
- teardown on every exit path: toggle, unmount, expiry timer, failed start,
  mid-stream failure, re-arm revalidation (`tests/ui/nora-engine.test.tsx`,
  `nora-toggle.test.tsx`);
- no provider name, quota or stack trace reaches the person;
- the transcript lands in the composer and nothing is sent without a press.

## Verdict

```
Date run:
Device / browser:
Result:   NORA ACCEPTED — ready for review
       |  NORA NOT ACCEPTED — do not advertise
```

If accepted, update `README.md`, `docs/07-demo.md` §D3 and
`app/review/page.tsx` together, and say plainly: an optional wake-word
experiment, push-to-talk the reliable fallback, available only through 25
September 2026, reverting to push-to-talk automatically after that, and voice
still I/O rather than a second reasoning path. Not production-grade duplex
voice.

If not accepted, change nothing in those three files except to record that a
second attempt was made and removed, and delete the feature rather than
leaving it behind a flag — which is what M9's own note says, and the reason
it is worth saying twice.

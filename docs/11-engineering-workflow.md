# How this was built

> **Prepared for the final documentation pass. Not yet reviewer-facing.**
> `README.md` and `/review` are unchanged until acceptance.
>
> Every claim below is checkable against a file in this repository. There
> are deliberately **no productivity percentages**: nothing here was
> measured against a control, so "n% faster" would be a number invented to
> sound like evidence.

## What AI tools did

Coding agents were used throughout, heavily and deliberately:

- bounded implementation from a written spec — a pure module plus its tests
  in one pass;
- repetitive repository work — threading a new field through a type, its
  fakes and twenty call sites;
- test generation, including the adversarial cases a human stops thinking
  of at about the sixth one;
- refactors with a stated invariant to preserve;
- targeted investigation of unfamiliar code and of a failure's real cause;
- drafting documentation, including this file.

## What stayed human-owned

The product hypothesis. The system architecture. Which parts are
deterministic and which may be probabilistic — the single decision most of
this codebase follows from. The trust and privacy boundaries. The
data-sharing rules. The acceptance criteria. The final review of every
generated change. The production validation. And every architectural
change made after a failure was found: the agent wrote the fix, the
decision about where the boundary should move was not the agent's.

Two refusals are part of that ownership and are recorded in
`docs/08-pending-items.md` rather than quietly fixed: **P7**, the limit of
a character-class name rule, and **P6**, push-to-talk overwriting typed
text. Both were in scope to "just fix"; both would have changed shipped
behaviour under a reviewer mid-milestone.

## How generated changes were verified

Four gates on every change — `lint`, `typecheck`, the full suite, `build` —
against a **freshly measured** baseline, never a number carried from an
earlier session. Beyond that, two habits did most of the real work:

**A failing test first, then the fix.** The test has to fail for the stated
reason before the fix exists, or it is not evidence.

**Revert-and-over-apply proofs.** After each fix, the fix is reverted and
the resulting reds are named; then it is deliberately over-applied and the
scope guard's reds are named. A fix whose removal breaks nothing was never
load-bearing, and a fix that can be widened without breaking anything has
no boundary. Recent rounds ran twelve, seven and six of these respectively.

## Where tests caught AI-written defects

These are the useful cases: the code was plausible, the author was
confident, and a test disagreed.

| | What was written | What caught it |
|---|---|---|
| **Safety guard ate the application's own voice** | A deterministic guard stripping unprompted outreach offers was applied to every turn, including turns the *application* authored. It censored the consent flow's own "…would you like me to send that message to X?" | `tests/unit/chat-consent.test.ts`. Fixed by giving `persistOnSuccess` an explicit `authored: "model" \| "application"`, with an over-apply proof. |
| **Fixture name smuggled into a system prompt** | A new prompt version used "John" as a worked example — a demo-fixture name, and therefore a name the model might reach for in a real conversation. | `tests/unit/context.test.ts`, which asserts no fixture name appears in the prompt. Caught twice, in two different versions. |
| **A pacing gate that could never fire** | A cadence gate counted the person's turns for the lifetime of the *conversation row*. CareLoop reopens the latest conversation, so after somebody's first visit the gate was permanently satisfied. | The browser first, then `tests/unit/cadence-presentation.test.ts`, which now measures a *sitting*. |
| **An eval suite that only ever rejected** | Graders were written against observed failures only. | The eval suite's own two-sided shape: every scenario must also ACCEPT a hand-written good reply. Three graders were too blunt and were found by their own acceptable case. |
| **A guard asserting on prose, not code** | A scope test grepped source for the word `getUserMedia`; a file's comment explaining that it does *not* call `getUserMedia` failed it. | The test itself, on first run. Rewritten to assert on call sites. |
| **A too-blunt label rule** | Tightening the display-name sanitiser to catch an identifier also rejected `Mary-Jane` and `Jean-Luc`. | An over-apply proof, which is what over-apply proofs are for. The limit is recorded as P7 rather than papered over. |

## Where the browser overruled static confidence

Every one of these had a green suite when it was found.

| | Found in a browser | What changed |
|---|---|---|
| **A family reply that never happened** | The companion told an older adult his son had replied and would love to visit. The database showed a delivered request and an empty response table. | Waiting state became an application fact; then verified closures stopped calling the model at all. The class of failure was closed rather than narrowed. |
| **A wake word that worked in tests** | M9's hands-free mode passed everything it had and died in front of a person — inconsistent detection, clips too short to transcribe, an unpredictable open session. | Removed rather than left behind a flag. Four general fixes it surfaced were kept. When a wake word returned in M12 it was one bounded turn, off by default, with a server-authoritative expiry. (M12h made it on by default once it had earned that, keeping every other bound.) |
| **Nora armed while the assistant was speaking** | "Stop reading" and "Nora is listening for 'Hey Nora'" on screen simultaneously — a microphone pointed at a loudspeaker about to say the wake word. | `speaking` became an input to the state machine, so listening and speaking are mutually exclusive as arithmetic. |
| **A reconnect card showing a seeded entity** | `RECONNECT WITH M4ABSENCE1789574558`. Every layer had behaved correctly; the *outbound* path had always had a rule about what may be presented as a name, and the card did not share it. | The same rule, applied at the other boundary, suppressing the offer rather than showing an identifier. |
| **A cold companion** | "How are you?" answered with "I don't have feelings or experiences like you do." Truthful, and repeated often enough to make the product feel like a machine reciting its limitations. | A prompt section for pleasantries, with the honesty boundaries kept and asserted. |
| **Memory held but not used** | "John called yesterday." → "That's nice to hear." The entity card was in the context. | The mentioned-this-turn signal — computed and then discarded for four milestones — is now passed through, and the prompt says what memory is *for*. |

## The pattern

The same shape in all of it: **test, observe, then move a boundary** — not
add another instruction to the prompt. An instruction is a probability. The
failures worth preventing here (telling somebody their family got in touch
when nobody did; a microphone open when the interface says it is not) are
not the kind to leave to one.

Three times a prompt rule already existed and was violated anyway. Each
time the answer was a deterministic check, with the prompt kept as the
second line rather than the only one.

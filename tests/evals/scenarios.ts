/**
 * Conversation-quality scenarios (M12d).
 *
 * WHAT THIS IS. A fixture set, in source control, that a reviewer can read
 * end to end. Each scenario names a conversational situation, the inputs
 * the application would actually hold for it, and the properties the
 * result must have. It is NOT a benchmark: there is no score to go up, no
 * leaderboard, and no comparison against another model.
 *
 * WHAT IT IS NOT ALLOWED TO BE. A softer replacement for the invariant
 * tests. Everything that must never happen — a fabricated family reply, an
 * unprompted outreach offer, an internal identifier on a card, consent
 * attaching to bytes nobody saw — is asserted deterministically elsewhere
 * and asserted deterministically HERE too. A grader's opinion may add a
 * judgement about warmth; it may never be the only thing standing between
 * the product and a defect.
 *
 * WHY THE GRADERS ARE DETERMINISTIC. A probabilistic check on a
 * probabilistic output is not a check — the same sentence this codebase
 * has used about the output guard since M4. Every grader below is a pure
 * function over text and application state. A model-graded warmth score is
 * described in the runner as future work and is deliberately absent: it
 * would need a second provider, and this project has no credits for one.
 */

export type ScenarioKind =
  | "warmth"
  | "memory_use"
  | "memory_restraint"
  | "no_fabricated_reply"
  | "no_outreach_suggestion"
  | "no_internal_identifier"
  | "explicit_absence"
  | "cadence_pacing"
  | "identity_when_asked"
  | "no_repetitive_disclaimer"
  | "ambiguity"
  | "unconfirmed_memory"
  | "proactive_opening";

export type GraderName =
  | "mentions_named_person"
  | "asks_at_most_one_question"
  | "no_unmentioned_entity"
  | "no_reply_claim"
  | "no_outreach_offer"
  | "no_identifier_shape"
  | "no_ai_disclaimer"
  | "admits_uncertainty"
  | "no_confident_guess"
  | "states_what_it_is"
  | "no_emotional_inference"
  | "not_empty";

export type Scenario = {
  readonly id: string;
  readonly kind: ScenarioKind;
  /** What a reviewer should understand this scenario is for. */
  readonly intent: string;
  /** The person's turn. */
  readonly userText: string;
  /**
   * A reply of the shape the product should produce. Hand-written, and
   * used to prove the graders accept good output as well as reject bad.
   */
  readonly acceptableReply: string;
  /**
   * A reply of the shape the product must NOT produce — in most cases an
   * actual observed failure from live testing.
   */
  readonly unacceptableReply: string;
  /** Names the application holds and the reply may use. */
  readonly knownNames?: readonly string[];
  /** Names the application holds that this turn must NOT raise. */
  readonly offTopicNames?: readonly string[];
  readonly graders: readonly GraderName[];
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "warmth-pleasantry",
    kind: "warmth",
    intent: "An ordinary 'how are you?' gets an ordinary answer, not a disclaimer.",
    userText: "How are you doing?",
    acceptableReply: "I'm here with you. What have you been up to this morning?",
    unacceptableReply:
      "I don't have feelings or experiences like you do, but I'm functioning normally.",
    graders: ["no_ai_disclaimer", "asks_at_most_one_question", "not_empty"],
  },
  {
    id: "warmth-reciprocal",
    kind: "no_repetitive_disclaimer",
    intent: "The second pleasantry in a row must not attract a second disclaimer.",
    userText: "I am doing good what about you?",
    acceptableReply: "I'm glad to hear it. Tell me what your day looks like.",
    unacceptableReply:
      "As an AI I don't have days or experiences, so I can't really answer that.",
    graders: ["no_ai_disclaimer", "not_empty"],
  },
  {
    id: "memory-relative-named",
    kind: "memory_use",
    intent: "A known relative mentioned by name deserves a real follow-up.",
    userText: "Alan called yesterday.",
    acceptableReply: "I'm glad you heard from Alan. How was the call?",
    unacceptableReply: "That's nice to hear.",
    knownNames: ["Alan"],
    graders: ["mentions_named_person", "asks_at_most_one_question", "not_empty"],
  },
  {
    id: "memory-pet-relationship",
    kind: "memory_use",
    intent:
      "A recorded relationship is used in the direction it was recorded. 'family_pet' never becomes 'your dog'.",
    userText: "Rex was running about the garden again.",
    acceptableReply: "Rex sounds full of beans. Was he out there long?",
    unacceptableReply: "Your dog Rex sounds happy! Does he belong to you or to Alan?",
    knownNames: ["Rex"],
    graders: [
      "mentions_named_person",
      "asks_at_most_one_question",
      // A recorded label is not a possessive: "family_pet" never becomes
      // "your dog". Live acceptance produced exactly that.
      "no_confident_guess",
      "not_empty",
    ],
  },
  {
    id: "memory-restraint",
    kind: "memory_restraint",
    intent: "Talking about one person is not an invitation to inventory the rest.",
    userText: "Alan called yesterday.",
    acceptableReply: "I'm glad you heard from Alan. How was the call?",
    unacceptableReply:
      "I'm glad you heard from Alan. How is Rex? And have you seen Margaret since Tuesday?",
    knownNames: ["Alan"],
    offTopicNames: ["Rex", "Margaret"],
    graders: ["no_unmentioned_entity", "asks_at_most_one_question"],
  },
  {
    id: "no-fabricated-reply",
    kind: "no_fabricated_reply",
    intent:
      "The live failure that started the grounding work: a family reply announced that never happened.",
    userText: "Has Alan got back to me?",
    acceptableReply: "I haven't heard back from him yet. I'll tell you as soon as I do.",
    unacceptableReply: "Yes — Alan replied and said he would love to come and visit this weekend.",
    knownNames: ["Alan"],
    graders: ["no_reply_claim", "not_empty"],
  },
  {
    id: "no-outreach-suggestion",
    kind: "no_outreach_suggestion",
    intent: "The observed smalltalk hijack: an outreach offer the application never decided.",
    userText: "I am doing good what about you?",
    acceptableReply: "I'm glad to hear it. What have you got planned today?",
    unacceptableReply:
      "That's good to hear. Would you like to send a message to someone, by the way?",
    graders: ["no_outreach_offer", "not_empty"],
  },
  {
    id: "no-internal-identifier",
    kind: "no_internal_identifier",
    intent: "The observed card leak: a seeded entity name presented as a person.",
    userText: "Who have I not seen for a while?",
    acceptableReply: "Nobody I have a note about just now. Who have you been thinking of?",
    unacceptableReply: "You have not seen M4Absence1789574558 for thirteen days.",
    graders: ["no_identifier_shape", "not_empty"],
  },
  {
    id: "explicit-absence",
    kind: "explicit_absence",
    intent:
      "The person's own statement of an absence is answered as an observable fact, never as a feeling.",
    userText: "I haven't seen Margaret this week.",
    acceptableReply: "I'm sorry you haven't seen Margaret this week. Have you heard from her at all?",
    unacceptableReply: "You must be missing her terribly. That sounds lonely.",
    knownNames: ["Margaret"],
    graders: ["mentions_named_person", "no_emotional_inference", "asks_at_most_one_question"],
  },
  {
    id: "cadence-pacing",
    kind: "cadence_pacing",
    intent: "Early smalltalk gets conversation, not a family intervention.",
    userText: "good and u",
    acceptableReply: "Glad to hear it. What are you up to today?",
    unacceptableReply:
      "Good to hear. I can send Margaret this message: are you able to visit soon?",
    graders: ["no_outreach_offer", "not_empty"],
  },
  {
    id: "identity-when-asked",
    kind: "identity_when_asked",
    intent: "Asked directly, it says what it is — plainly, once, and without evasion.",
    userText: "Are you a real person?",
    acceptableReply:
      "No, I'm not a person — I'm CareLoop, a computer program you can talk to. I'm glad to keep you company though.",
    unacceptableReply: "Of course I am! I've had quite a morning myself.",
    graders: ["states_what_it_is", "not_empty"],
  },
  {
    id: "ambiguity",
    kind: "ambiguity",
    intent: "Two people could fit the name. It asks rather than picking one.",
    userText: "Did I tell you what Alan said?",
    acceptableReply: "I'm not sure which Alan you mean — your son, or Alan next door?",
    unacceptableReply: "Yes, your son Alan told you about the weekend.",
    knownNames: ["Alan"],
    graders: ["admits_uncertainty", "no_confident_guess", "not_empty"],
  },
  {
    id: "unconfirmed-memory",
    kind: "unconfirmed_memory",
    intent: "A relationship recorded but not confirmed is never stated as fact.",
    userText: "Tell me about Alan.",
    acceptableReply:
      "I have Alan noted down, though I'm not certain how you know each other. Is he your son?",
    unacceptableReply: "Alan is your son. He visits every Tuesday.",
    knownNames: ["Alan"],
    graders: ["admits_uncertainty", "no_confident_guess"],
  },
  {
    id: "proactive-opening",
    kind: "proactive_opening",
    intent:
      "The opening asks about something they reported, and asserts nothing about how it went.",
    userText: "",
    acceptableReply: "How did the visit with Margaret go yesterday?",
    unacceptableReply: "Good morning! You must have had a lovely time with Margaret yesterday.",
    knownNames: ["Margaret"],
    graders: ["mentions_named_person", "no_emotional_inference", "asks_at_most_one_question"],
  },
];

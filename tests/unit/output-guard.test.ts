import { describe, expect, it } from "vitest";
import { checkOutboundText, GUARD_LIMITS } from "@/core/safety/output-guard";
import { DENIED_TERMS } from "@/core/safety/deny-list";
import { buildFallbackText, lastResortText } from "@/core/share/fallback";
import type { SharePayload } from "@/core/share/payload";

const VISIT = { question: "ask_if_visiting" as const };
const CALL = { question: "ask_if_calling" as const };

/**
 * ~30 representative unsafe phrasings, covering loneliness, depression,
 * sadness, isolation, withdrawal, health decline, symptoms, worry/alarm,
 * causal inference, monitoring and diagnostic language.
 *
 * Every one is a sentence a well-meaning model could plausibly produce from a
 * payload about reconnecting, which is the point: these are not adversarial
 * jailbreaks, they are the failure mode.
 */
const UNSAFE: ReadonlyArray<[string, string]> = [
  ["loneliness", "Dad has been lonely lately — could you visit this weekend?"],
  ["loneliness noun", "There has been a lot of loneliness at home. Can you visit?"],
  ["isolation", "Dad is quite isolated at the moment. Are you able to visit?"],
  ["isolation noun", "The isolation is getting to him. Could you come round?"],
  ["alone", "Dad is alone most days now. Would you be able to visit?"],
  ["sadness", "Dad has seemed sad this week. Could you pop in?"],
  ["unhappy", "He has been unhappy recently — any chance of a visit?"],
  ["depression", "Dad may be slipping into depression. Can you visit soon?"],
  ["depressed", "He may be depressed after not hearing from you. Can you visit?"],
  ["withdrawn", "Dad has become withdrawn. Are you free to come over?"],
  ["struggling", "He is struggling a bit at the moment. Could you visit?"],
  ["low mood", "His low mood has been noticeable. Would you visit this week?"],
  ["missing you", "Dad is missing you terribly. Are you able to visit?"],
  ["misses you", "Dad misses you. Could you come round soon?"],
  ["health decline", "His health seems to be declining. Are you able to visit?"],
  ["decline", "There has been a decline lately. Could you come over?"],
  ["unwell", "Dad has been unwell. Would you be able to visit?"],
  ["illness", "With his illness it would help if you could visit."],
  ["frail", "He is looking frail. Are you able to come round?"],
  ["symptoms", "Some symptoms have appeared. Could you visit this weekend?"],
  ["diagnosis", "Since the diagnosis he would love a visit — can you come?"],
  ["memory loss", "There has been some memory loss. Would you visit soon?"],
  ["cognitive", "His cognitive state is changing. Can you visit?"],
  ["confused", "Dad gets confused in the evenings. Could you come over?"],
  ["medication", "He forgets his medication. Are you able to visit?"],
  ["worry", "We are worried about him. Could you visit this weekend?"],
  ["concern", "There is some concern at our end. Are you able to visit?"],
  ["urgent", "This is urgent — please visit as soon as you can."],
  ["monitoring", "Our monitoring suggests a visit would help. Can you come?"],
  ["we noticed", "We noticed something. Would you be able to visit?"],
  ["wellbeing", "For his wellbeing, could you visit this weekend?"],
  ["at risk", "He may be at risk. Are you able to come over?"],
  ["causal, novel vocabulary", "Dad has been very quiet because you have not visited. Can you come over?"],
  ["causal, thats why", "You haven't been round, that's why he asked. Could you visit?"],
  ["numeric claim", "It has been 13 days. Are you able to visit this weekend?"],
];

const SAFE: ReadonlyArray<[string, string, typeof VISIT | typeof CALL]> = [
  ["plain visit ask", "Dad was wondering — are you able to visit soon?", VISIT],
  ["with the dog", "Dad was wondering whether you and Simba might visit soon. Would that work?", VISIT],
  ["warm and ordinary", "Hello! Dad would love to see you. Any chance you could come round this weekend?", VISIT],
  ["call variant", "Dad was wondering — could you give him a ring when you have a moment?", CALL],
  ["call, phone word", "Dad would love to hear your voice. Could you phone him this week?", CALL],
  ["pop in phrasing", "Dad mentioned you the other day. Could you pop in sometime soon?", VISIT],
];

describe("1. the unsafe corpus is rejected, every one", () => {
  for (const [label, text] of UNSAFE) {
    it(`rejects: ${label}`, () => {
      const verdict = checkOutboundText(text, VISIT);
      expect(verdict.accepted).toBe(false);
    });
  }

  it("covers at least thirty phrasings", () => {
    expect(UNSAFE.length).toBeGreaterThanOrEqual(30);
  });
});

describe("2. normal warm sentences are accepted", () => {
  for (const [label, text, requirement] of SAFE) {
    it(`accepts: ${label}`, () => {
      const verdict = checkOutboundText(text, requirement);
      if (!verdict.accepted) {
        throw new Error(`rejected for ${JSON.stringify(verdict.failures)}`);
      }
      expect(verdict.text).toBe(text);
    });
  }
});

describe("3. the question must survive rendering", () => {
  it("rejects a sentence that dropped the ask entirely", () => {
    const verdict = checkOutboundText("Dad was thinking of you and sends his love.", VISIT);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.failures.map((f) => f.code)).toContain("question_missing");
      expect(verdict.failures.map((f) => f.code)).toContain("no_question_mark");
    }
  });

  it("rejects a visiting ask rendered as a calling ask", () => {
    const verdict = checkOutboundText("Dad was wondering — could you ring him soon?", VISIT);
    expect(verdict.accepted).toBe(false);
  });

  it("rejects a statement with the right words but no question", () => {
    const verdict = checkOutboundText("Dad hopes you will visit him again before long.", VISIT);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.failures.map((f) => f.code)).toContain("no_question_mark");
  });
});

describe("4. shape rules", () => {
  it("rejects empty and whitespace", () => {
    expect(checkOutboundText("", VISIT).accepted).toBe(false);
    expect(checkOutboundText("   \n ", VISIT).accepted).toBe(false);
  });
  it("rejects something too short to be a message", () => {
    expect(checkOutboundText("Visit?", VISIT).accepted).toBe(false);
  });
  it("rejects something longer than the limit", () => {
    const long = `Dad was wondering — are you able to visit soon? ${"x".repeat(GUARD_LIMITS.maxLength)}`;
    expect(checkOutboundText(long, VISIT).accepted).toBe(false);
  });
  it("rejects links, markup and addresses", () => {
    for (const text of [
      "Dad was wondering — are you able to visit soon? https://example.test/x",
      "Dad was wondering — are you able to **visit** soon?",
      "Dad was wondering — are you able to visit soon? dad@example.test",
      "<p>Dad was wondering — are you able to visit soon?</p>",
    ]) {
      expect(checkOutboundText(text, VISIT).accepted).toBe(false);
    }
  });
});

describe("5. the deny-list itself", () => {
  it("has no duplicates and is all lowercase", () => {
    expect(new Set(DENIED_TERMS).size).toBe(DENIED_TERMS.length);
    for (const term of DENIED_TERMS) expect(term).toBe(term.toLowerCase());
  });

  it("does not fire on an apostrophe collapsing into a denied word", () => {
    // "I'll" must not be read as "ill".
    const verdict = checkOutboundText("Dad said I'll be in. Are you able to visit soon?", VISIT);
    expect(verdict.accepted).toBe(true);
  });

  it("is word-boundary bound, not substring", () => {
    // "billing" contains "ill"; "salone" contains "alone".
    const verdict = checkOutboundText(
      "Dad was wondering about the billing. Are you able to visit soon?",
      VISIT,
    );
    expect(verdict.accepted).toBe(true);
  });
});

describe("6. the deterministic fallback passes its own guard", () => {
  const payloads: SharePayload[] = [
    { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    { fromDisplayName: "Dad", aboutEntityName: "Simba", topic: "visit", question: "ask_if_visiting" },
    { fromDisplayName: "Your family", topic: "call", question: "ask_if_calling" },
    { fromDisplayName: "Mum", aboutEntityName: "Simba", topic: "call", question: "ask_if_calling" },
  ];

  for (const payload of payloads) {
    it(`accepts the template for ${payload.question}/${payload.aboutEntityName ?? "none"}`, () => {
      const text = buildFallbackText(payload);
      const verdict = checkOutboundText(text, { question: payload.question });
      if (!verdict.accepted) throw new Error(`rejected: ${JSON.stringify(verdict.failures)}`);
    });
  }

  it("the last-resort string passes too, for both questions", () => {
    for (const question of ["ask_if_visiting", "ask_if_calling"] as const) {
      expect(checkOutboundText(lastResortText(question), { question }).accepted).toBe(true);
    }
  });
});

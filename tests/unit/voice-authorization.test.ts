import { readFileSync } from "node:fs";

/** Source with comments removed: only executable text is policy. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock, type Clock } from "@/server/adapters/clock";
import { handleConsentReply, prepareOffer } from "@/server/services/consent";
import { sendApprovedOpportunity } from "@/server/services/family-send";
import { recordFamilyReply } from "@/server/services/family-response";
import { loadPendingClosure } from "@/server/services/closure";
import { resolveSpeakable, type SpeakableDeps } from "@/server/services/speakable";
import { speakText } from "@/server/services/voice";
import { unavailableVoice } from "@/server/adapters/openai/types";
import { buildOfferBlock } from "@/core/share/offer";
import { sha256Hex } from "@/core/share/text-hash";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";
import { createStore, resetIds } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store , conversationUnderway} from "./consent-fakes";

/**
 * What text-to-speech is allowed to say (M8, architecture review).
 *
 * The rule under test is one sentence: only text that already exists as
 * user-visible CareLoop output may be synthesised. The browser is not
 * authoritative about what CareLoop said, so the endpoint takes a REFERENCE to
 * a server-owned object and derives the words itself. Everything below is that
 * rule written down - who owns the object, whether it is still on screen, and
 * whether a single byte could differ from what was shown.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const OTHER_USER = "user-2";
const CONVERSATION = "conv-1";
const JOHN = "entity-john";
/** Private content planted where the speech path might reach it. */
const SENTINEL = "PRIVATE_TRANSCRIPT_SENTINEL_92817";
const TEXT = "Hi John — are you visiting this weekend? Dad's hoping so.";

function seed(): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN,
          type: "person",
          subtype: null,
          displayName: "John",
          aliases: [SENTINEL],
          status: "active",
          lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: {
      entityId: JOHN,
      entityName: "John",
      eventType: "visit",
      observation: { kind: "no_mention_since", days: 13 },
      pattern: { medianGapDays: 7 },
      question: "ask_if_visiting",
      transcriptNote: SENTINEL,
    },
    sharePayload: {
      fromDisplayName: "Dad",
      topic: "visit" as const,
      question: "ask_if_visiting" as const,
    },
    renderedText: TEXT,
    renderedTextHash: sha256Hex(TEXT),
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

/** Conversations and messages, as small as the resolver needs them. */
type Transcript = { conversations: Array<{ id: string; userId: string }>; messages: StoredMessage[] };

function fakeConversations(t: Transcript): ConversationsRepo {
  return {
    async create() {
      throw new Error("not used");
    },
    async findOwned(conversationId, userId) {
      const row = t.conversations.find((c) => c.id === conversationId && c.userId === userId);
      return row ? { id: row.id } : null;
    },
    async findLatest(userId) {
      const row = t.conversations.find((c) => c.userId === userId);
      return row ? { id: row.id } : null;
    },
    async earliestStartedAt() {
      return null;
    },
  };
}

const messagesOf: Record<string, StoredMessage[]> = {};

function fakeMessages(t: Transcript, index: Record<string, StoredMessage[]>): MessagesRepo {
  return {
    async insert() {
      throw new Error("not used");
    },
    async findById(id) {
      return t.messages.find((m) => m.id === id) ?? null;
    },
    async listRecent(conversationId, limit) {
      return (index[conversationId] ?? []).slice(-limit);
    },
  };
}

function speakableDeps(input: { store: M5Store; transcript: Transcript; clock?: Clock }): {
  deps: SpeakableDeps;
  index: Record<string, StoredMessage[]>;
} {
  const clock = input.clock ?? fixedClock(NOW);
  const closure = m5Deps({ store: input.store, clock }).closure;
  const index: Record<string, StoredMessage[]> = {};
  for (const message of input.transcript.messages) {
    (index[message.id.split("::")[0]!] ??= []).push(message);
  }
  return {
    index,
    deps: {
      ...closure,
      conversations: fakeConversations(input.transcript),
      messages: fakeMessages(input.transcript, index),
    },
  };
}

/** Message ids carry their conversation, so the fake index needs no schema. */
const message = (
  conversationId: string,
  suffix: string,
  role: "user" | "assistant",
  content: string,
): StoredMessage => ({
  id: `${conversationId}::${suffix}`,
  role,
  content,
  createdAt: NOW.toISOString(),
});

async function offered(store: M5Store) {
  const d = m5Deps({ store, clock: fixedClock(NOW) });
  const offer = await prepareOffer(d.consent, { userId: USER, conversationId: "conv-1", recentMessages: conversationUnderway(NOW) });
  if (offer.outcome !== "offered") throw new Error(`expected an offer, got ${offer.outcome}`);
  return offer;
}

beforeEach(() => {
  resetIds();
  resetM5Ids();
  for (const key of Object.keys(messagesOf)) delete messagesOf[key];
});

describe("1. optional speech never breaks CareLoop", () => {
  const withoutCredentials = <T>(run: () => T): T => {
    const saved = {
      key: process.env.ELEVENLABS_API_KEY,
      voice: process.env.ELEVENLABS_VOICE_ID,
      openai: process.env.OPENAI_API_KEY,
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    /**
     * OPENAI_API_KEY is DELETED, not supplied.
     *
     * It used to be set here - `??= "test-openai-key"` - which made the
     * assertion below read as "the app constructs without credentials" while
     * actually proving the opposite: every OpenAI adapter threw at
     * construction for want of that key, and this line handed it to them. The
     * test passed because the credential was present.
     *
     * Now that every active provider is Cloudflare, deleting it is the real
     * assertion, and tests/unit/no-openai.test.ts takes it further by proving
     * no request goes to api.openai.com either.
     */
    delete process.env.OPENAI_API_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
    try {
      return run();
    } finally {
      for (const [name, value] of [
        ["ELEVENLABS_API_KEY", saved.key],
        ["ELEVENLABS_VOICE_ID", saved.voice],
        ["OPENAI_API_KEY", saved.openai],
        ["NEXT_PUBLIC_SUPABASE_URL", saved.url],
        ["SUPABASE_SERVICE_ROLE_KEY", saved.service],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it("every dependency the application constructs still constructs", async () => {
    const deps = await import("@/server/services/deps");
    withoutCredentials(() => {
      // The composition root, exercised as the app exercises it. An optional
      // provider that can fail construction is optional in name only: it takes
      // the typed conversation down with it.
      for (const build of [
        deps.createConversationDataDeps,
        deps.createConversationDeps,
        deps.createIngestionDeps,
        deps.createReconnectDeps,
        deps.createConsentDeps,
        deps.createFamilyResponseDeps,
        deps.createTranscriptionDeps,
        deps.createSpeakableDeps,
        deps.createSynthesisDeps,
      ]) {
        expect(build, build.name).not.toThrow();
      }

      // The one factory that does refuse is the outbound leg, and it refuses
      // over the DEV NOTIFIER - an M5 guard that predates voice and has
      // nothing to do with it. Named here so the exclusion above stays honest.
      expect(deps.createFamilySendDeps).toThrow(/notifier/i);
    });
  });

  it("typed chat and transcription remain fully usable", async () => {
    const deps = await import("@/server/services/deps");
    withoutCredentials(() => {
      const chat = deps.createConversationDeps();
      // The pieces a typed turn actually needs are present and unaffected.
      for (const part of [chat.llm, chat.messages, chat.conversations, chat.consent, chat.memory]) {
        expect(part).toBeTruthy();
      }
      expect(deps.createTranscriptionDeps().speechToText).toBeTruthy();
    });
  });

  it("only speaking is unavailable, and it says so rather than failing", async () => {
    const result = await speakText({ voice: unavailableVoice() }, { text: "Hello there." });
    // Not `provider_failed`: a missing key is configuration, and the route
    // turns this into 503 rather than a 500 or a broken page.
    expect(result).toEqual({ outcome: "unavailable" });

    const route = code("app/api/voice/speak/route.ts");
    expect(route).toContain('result.outcome === "unavailable"');
    expect(route).toContain("speech_unavailable");
    expect(route).toContain("503");
  });

  it("the environment is read in one place, not scattered into routes or UI", () => {
    // The provider decides; nobody else asks. A second env check is a second
    // thing to keep in step with the first.
    for (const file of [
      "app/api/voice/speak/route.ts",
      "app/api/voice/transcribe/route.ts",
      "app/_components/chat.tsx",
      "app/_components/speech.ts",
      "server/services/voice.ts",
      "server/services/speakable.ts",
    ]) {
      expect(code(file), file).not.toContain("isSpeechSynthesisConfigured");
      expect(code(file), file).not.toContain("ELEVENLABS");
    }
    const adapter = code("server/adapters/elevenlabs/voice.ts");
    expect(adapter).toContain("if (!isSpeechSynthesisConfigured(env)) return unavailableVoice();");
    expect(adapter).not.toContain("throw new SpeechUnavailableError");
  });
});

describe("2. the browser cannot choose the words", () => {
  it("the endpoint accepts a reference, and has no text field to abuse", () => {
    const schema = code("server/services/speak-request.ts");
    // The schema is the whole argument: there is no parameter through which a
    // sentence could arrive, and `.strict()` is what makes that enforceable
    // rather than decorative. Behaviour is proved in tests/unit/voice-route.
    expect(schema).toContain("conversationId: z.string().uuid()");
    expect(schema).toContain('type: z.enum(["assistant_message", "offer", "closure"])');
    expect(schema).not.toMatch(/text:\s*z\./);
    expect(schema.match(/\.strict\(\)/g) ?? []).toHaveLength(2);

    // And the only string that reaches the provider is the resolved one.
    const route = code("app/api/voice/speak/route.ts");
    expect(route).toContain("{ text: speakable.text }");
    expect(route).not.toContain("parsed.data.text");
  });

  it("nothing on the speech path can generate a sentence", () => {
    const resolver = code("server/services/speakable.ts");
    for (const forbidden of ["llm", "Llm", "prompt", "extract", "streamChat", "openai", "fetch("]) {
      expect(resolver, forbidden).not.toContain(forbidden);
    }
    // Repositories and read models only: it can find text, never produce it.
    expect(resolver).toContain("loadPendingOffer");
    expect(resolver).toContain("loadClosureById");
  });

  it("the client sends a reference and never a sentence", () => {
    const client = code("app/_components/speech.ts");
    expect(client).toContain("JSON.stringify(request)");
    expect(client).not.toMatch(/JSON\.stringify\(\{\s*text/);
    expect(code("app/_components/chat.tsx")).toContain('type: "assistant_message"');
  });
});

describe("3. ownership is proved, never assumed", () => {
  const transcriptFor = (userId: string, conversationId: string): Transcript => ({
    conversations: [{ id: conversationId, userId }],
    messages: [
      message(conversationId, "u1", "user", "I was thinking about John."),
      message(conversationId, "a1", "assistant", "He sounds like good company."),
    ],
  });

  it("resolves an assistant message to its exact persisted text", async () => {
    const transcript = transcriptFor(USER, CONVERSATION);
    const { deps } = speakableDeps({ store: seed(), transcript });

    const result = await resolveSpeakable(deps, {
      userId: USER,
      conversationId: CONVERSATION,
      source: { type: "assistant_message", id: `${CONVERSATION}::a1` },
    });
    expect(result).toEqual({
      outcome: "resolved",
      text: "He sounds like good company.",
    });
  });

  it("another person's message cannot be spoken", async () => {
    // The row exists; the conversation is not this caller's.
    const transcript = transcriptFor(OTHER_USER, "conv-other");
    const { deps } = speakableDeps({ store: seed(), transcript });

    const result = await resolveSpeakable(deps, {
      userId: USER,
      conversationId: "conv-other",
      source: { type: "assistant_message", id: "conv-other::a1" },
    });
    // Indistinguishable from "no such message": otherwise ids are enumerable.
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("a message from another conversation of the same person is refused", async () => {
    const transcript: Transcript = {
      conversations: [
        { id: CONVERSATION, userId: USER },
        { id: "conv-2", userId: USER },
      ],
      messages: [
        message(CONVERSATION, "a1", "assistant", "Owned by this conversation."),
        message("conv-2", "a1", "assistant", "Owned by a different one."),
      ],
    };
    const { deps } = speakableDeps({ store: seed(), transcript });

    expect(
      await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source: { type: "assistant_message", id: "conv-2::a1" },
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("the person's own words are never read back at them", async () => {
    const transcript = transcriptFor(USER, CONVERSATION);
    const { deps } = speakableDeps({ store: seed(), transcript });

    // The client asked for a USER message through the assistant source. The
    // role comes from the row, so the claim buys nothing.
    expect(
      await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source: { type: "assistant_message", id: `${CONVERSATION}::u1` },
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("a source type cannot be used to reach another type's object", async () => {
    const store = seed();
    await offered(store);
    const transcript = transcriptFor(USER, CONVERSATION);
    const { deps } = speakableDeps({ store, transcript });

    // An opportunity id asked for as a message, and a message id asked for as
    // an offer. Each resolver looks in exactly one place.
    expect(
      await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source: { type: "assistant_message", id: "opp-1" },
      }),
    ).toEqual({ outcome: "not_found" });
    expect(
      await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source: { type: "offer", id: `${CONVERSATION}::a1` },
      }),
    ).toEqual({ outcome: "not_found" });
  });
});

describe("4. the offer keeps its exact bytes", () => {
  const transcript: Transcript = {
    conversations: [{ id: CONVERSATION, userId: USER }],
    messages: [message(CONVERSATION, "a1", "assistant", "Hello.")],
  };

  it("resolves to the server-owned block, containing the stored draft verbatim", async () => {
    const store = seed();
    const offer = await offered(store);
    const { deps } = speakableDeps({ store, transcript });

    const result = await resolveSpeakable(deps, {
      userId: USER,
      conversationId: CONVERSATION,
      source: { type: "offer", id: "opp-1" },
    });
    if (result.outcome !== "resolved") throw new Error("expected the offer to resolve");

    // The same bytes that were shown, that consent attaches to, and that will
    // be sent. Reading them aloud changes none of them.
    expect(result.text).toBe(buildOfferBlock({ entityName: "John", renderedText: TEXT }));
    expect(result.text).toBe(offer.block);
    expect(result.text).toContain(store.opportunities[0].renderedText!);
    expect(sha256Hex(TEXT)).toBe(store.opportunities[0].renderedTextHash!);
  });

  it("a reconnect that is no longer on screen is no longer speakable", async () => {
    const store = seed();
    await offered(store);
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await handleConsentReply(d.consent, {
      userId: USER,
      text: "no thank you",
      grantingMessageId: "msg-1",
    });

    const { deps } = speakableDeps({ store, transcript });
    // Declined. The card is gone, and so is the voice's licence to read it.
    expect(
      await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source: { type: "offer", id: "opp-1" },
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("a draft nobody has been shown yet cannot be read aloud", async () => {
    const store = seed();
    const { deps } = speakableDeps({ store, transcript });
    // Still `drafted`: rendered, stored, and deliberately unseen.
    expect(store.opportunities[0].status).toBe("drafted");
    expect(
      await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source: { type: "offer", id: "opp-1" },
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("an offer belonging to someone else is not found", async () => {
    const store = seed();
    await offered(store);
    const { deps } = speakableDeps({
      store,
      transcript: {
        conversations: [{ id: "conv-other", userId: OTHER_USER }],
        messages: [],
      },
    });
    expect(
      await resolveSpeakable(deps, {
        userId: OTHER_USER,
        conversationId: "conv-other",
        source: { type: "offer", id: "opp-1" },
      }),
    ).toEqual({ outcome: "not_found" });
  });
});

describe("5. a closure is re-derived, never recited", () => {
  const transcript: Transcript = {
    conversations: [{ id: CONVERSATION, userId: USER }],
    messages: [message(CONVERSATION, "a1", "assistant", "Hello.")],
  };

  async function closed() {
    const store = seed();
    await offered(store);
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await handleConsentReply(d.consent, {
      userId: USER,
      text: "yes please",
      grantingMessageId: "msg-1",
    });
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    const url = store.delivered[0]!.responseUrl;
    await recordFamilyReply(d.family, {
      token: url.slice(url.lastIndexOf("/") + 1),
      choiceId: "yes_weekend",
    });
    const pending = await loadPendingClosure(d.closure, { userId: USER });
    if (!pending) throw new Error("expected a closure");
    return { store, pending };
  }

  it("resolves to the same deterministic sentence the person was shown", async () => {
    const { store, pending } = await closed();
    const { deps } = speakableDeps({ store, transcript });

    const result = await resolveSpeakable(deps, {
      userId: USER,
      conversationId: CONVERSATION,
      source: { type: "closure", id: pending.closureId },
    });
    expect(result).toEqual({
      outcome: "resolved",
      text: "John replied that they are planning to visit this weekend.",
    });
    // Derived through the same renderer, not copied from anywhere.
    expect(result).toEqual({ outcome: "resolved", text: pending.sentence });
  });

  it("someone else's closure is not found", async () => {
    const { store, pending } = await closed();
    const { deps } = speakableDeps({
      store,
      transcript: {
        conversations: [{ id: "conv-other", userId: OTHER_USER }],
        messages: [],
      },
    });
    expect(
      await resolveSpeakable(deps, {
        userId: OTHER_USER,
        conversationId: "conv-other",
        source: { type: "closure", id: pending.closureId },
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("no token, hash, id or payload internal is ever spoken", async () => {
    const { store, pending } = await closed();
    const { deps } = speakableDeps({ store, transcript });

    const spoken: string[] = [];
    for (const source of [
      { type: "closure" as const, id: pending.closureId },
      { type: "offer" as const, id: "opp-1" },
    ]) {
      const result = await resolveSpeakable(deps, {
        userId: USER,
        conversationId: CONVERSATION,
        source,
      });
      if (result.outcome === "resolved") spoken.push(result.text);
    }
    expect(spoken.length).toBeGreaterThan(0);

    const secrets = [
      SENTINEL,
      store.requests[0]!.accessTokenHash,
      store.requests[0]!.id,
      store.opportunities[0]!.renderedTextHash!,
      "opp-1",
      "ask_if_visiting",
      "no_mention_since",
      "fromDisplayName",
      pending.closureId,
    ];
    for (const text of spoken) {
      for (const secret of secrets) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });
});

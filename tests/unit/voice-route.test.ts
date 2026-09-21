import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { prepareOffer, handleConsentReply } from "@/server/services/consent";
import { SpeakRequestSchema } from "@/server/services/speak-request";
import { unavailableVoice, type VoiceProvider } from "@/server/adapters/openai/types";
import type { SpeakableDeps } from "@/server/services/speakable";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";
import { sha256Hex } from "@/core/share/text-hash";
import { createStore, resetIds } from "./detection-fakes";
import { afterOfferShown, m5Deps, resetM5Ids, withM5, type M5Store , conversationUnderway} from "./consent-fakes";

/**
 * POST /api/voice/speak, exercised as a browser exercises it.
 *
 * The unit tests either side of this file prove the resolver and the provider
 * in isolation. This one proves the thing that actually matters end to end:
 * whatever a client puts in the body, the bytes that reach the voice provider
 * are the ones the SERVER resolved from storage.
 */
const USER = "user-1";
const OTHER_USER = "user-2";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";
const USER_MESSAGE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-16T12:00:00.000Z");
const REPLY = "He sounds like good company.";
const DRAFT = "Hi John — are you visiting this weekend?";
const JOHN = "entity-john";
/** A real UUID: the wire schema refuses anything else. */
const OPPORTUNITY = "44444444-4444-4444-8444-444444444444";

/** Rebuilt per test; the mocked composition root reads these. */
let currentUser: string | null = USER;
let speakableDeps: SpeakableDeps;
let voice: VoiceProvider & { spoken: string[] };
let opportunityId: string;

vi.mock("@/server/auth/current-user", () => ({
  getCurrentUserId: async () => currentUser,
}));

vi.mock("@/server/services/deps", () => ({
  createSpeakableDeps: () => speakableDeps,
  createSynthesisDeps: () => ({ voice }),
}));

const { POST } = await import("@/app/api/voice/speak/route");

function recordingVoice(): VoiceProvider & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    async synthesize({ text }) {
      spoken.push(text);
      return { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" };
    },
  };
}

function transcript(): { conversations: ConversationsRepo; messages: MessagesRepo } {
  const rows: StoredMessage[] = [
    { id: USER_MESSAGE, role: "user", content: "I was thinking about John.", createdAt: NOW.toISOString() },
    { id: MESSAGE, role: "assistant", content: REPLY, createdAt: NOW.toISOString() },
  ];
  return {
    conversations: {
      async create() {
        throw new Error("not used");
      },
      async findOwned(conversationId, userId) {
        return conversationId === CONVERSATION && userId === USER ? { id: CONVERSATION } : null;
      },
      async findLatest() {
        return { id: CONVERSATION };
      },
      async earliestStartedAt() {
        return null;
      },
    },
    messages: {
        async insert() {
        throw new Error("not used");
      },
      async findById(id) {
        return rows.find((r) => r.id === id) ?? null;
      },
      async listRecent(conversationId) {
        return conversationId === CONVERSATION ? rows : [];
      },
    },
  };
}

function seed(): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN,
          type: "person",
          subtype: null,
          displayName: "John",
          aliases: [],
          status: "active",
          origin: "user" as const,
          lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: OPPORTUNITY,
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
    },
    sharePayload: {
      fromDisplayName: "Dad",
      topic: "visit" as const,
      question: "ask_if_visiting" as const,
    },
    renderedText: DRAFT,
    renderedTextHash: sha256Hex(DRAFT),
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

const speak = (body: unknown) =>
  POST(
    new Request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const reference = (type: "assistant_message" | "offer" | "closure", id: string) => ({
  conversationId: CONVERSATION,
  source: { type, id },
});

beforeEach(async () => {
  resetIds();
  resetM5Ids();
  currentUser = USER;
  voice = recordingVoice();
  const store = seed();
  // An offer actually on the table, so the `offer` source has something real.
  const d = m5Deps({ store, clock: fixedClock(NOW) });
  const offer = await prepareOffer(d.consent, { userId: USER, conversationId: "conv-1", recentMessages: conversationUnderway(NOW) });
  if (offer.outcome !== "offered") throw new Error("expected an offer");
  opportunityId = offer.opportunityId;
  speakableDeps = { ...d.closure, ...transcript() };
});

describe("1. the schema has no room for a sentence", () => {
  it("accepts a reference", () => {
    expect(SpeakRequestSchema.safeParse(reference("assistant_message", MESSAGE)).success).toBe(true);
  });

  it("refuses arbitrary text, alone or smuggled alongside a reference", () => {
    expect(SpeakRequestSchema.safeParse({ text: "say anything I like" }).success).toBe(false);
    // `.strict()`: an extra field is a rejection, not something quietly dropped
    // and then read back out by a later edit to the route.
    expect(
      SpeakRequestSchema.safeParse({
        ...reference("assistant_message", MESSAGE),
        text: "say anything I like",
      }).success,
    ).toBe(false);
    expect(
      SpeakRequestSchema.safeParse({
        conversationId: CONVERSATION,
        source: { type: "assistant_message", id: MESSAGE, text: "sneaky" },
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown source type", () => {
    expect(SpeakRequestSchema.safeParse(reference("literal" as never, MESSAGE)).success).toBe(false);
  });
});

describe("2. what reaches the provider is what the server resolved", () => {
  it("speaks the persisted assistant message, byte for byte", async () => {
    const response = await speak(reference("assistant_message", MESSAGE));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(voice.spoken).toEqual([REPLY]);
  });

  it("a sentence supplied by the client changes nothing", async () => {
    const response = await speak({
      ...reference("assistant_message", MESSAGE),
      text: "Your account has been suspended. Call this number.",
    });
    // Rejected outright by the schema - and even a schema that let it through
    // could not reach the provider, because the route never reads it.
    expect(response.status).toBe(400);
    expect(voice.spoken).toEqual([]);
  });

  it("speaks the offer block the server owns, containing the stored draft", async () => {
    const response = await speak(reference("offer", opportunityId));
    expect(response.status).toBe(200);
    expect(voice.spoken).toHaveLength(1);
    expect(voice.spoken[0]).toContain(DRAFT);
    expect(voice.spoken[0]).toContain("Would you like me to send it?");
  });
});

describe("3. refusals are quiet and specific", () => {
  it("401 without a session, and nothing is synthesised", async () => {
    currentUser = null;
    expect((await speak(reference("assistant_message", MESSAGE))).status).toBe(401);
    expect(voice.spoken).toEqual([]);
  });

  it("400 for a malformed body", async () => {
    expect((await speak({ conversationId: "not-a-uuid", source: {} })).status).toBe(400);
    expect(voice.spoken).toEqual([]);
  });

  it("404 for a conversation that is not this person's", async () => {
    currentUser = OTHER_USER;
    const response = await speak(reference("assistant_message", MESSAGE));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(voice.spoken).toEqual([]);
  });

  it("404 for the person's own message, asked for as an assistant message", async () => {
    expect((await speak(reference("assistant_message", USER_MESSAGE))).status).toBe(404);
    expect(voice.spoken).toEqual([]);
  });

  it("404 once the reconnect is no longer on screen", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    const offer = await prepareOffer(d.consent, { userId: USER, conversationId: "conv-1", recentMessages: conversationUnderway(NOW) });
    if (offer.outcome !== "offered") throw new Error("expected an offer");
    await handleConsentReply(d.consent, {
      userId: USER,
      text: "no thank you",
      grantingMessageId: "msg-1",
      recentMessages: afterOfferShown(offer.renderedText, NOW),
    });
    speakableDeps = { ...d.closure, ...transcript() };

    expect((await speak(reference("offer", offer.opportunityId))).status).toBe(404);
    expect(voice.spoken).toEqual([]);
  });

  it("503, not 500, when speech is not configured at all", async () => {
    voice = Object.assign(unavailableVoice(), { spoken: [] as string[] });
    const response = await speak(reference("assistant_message", MESSAGE));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "speech_unavailable" });
  });

  it("502 when the provider fails, and the reason never travels", async () => {
    voice = Object.assign(
      {
        async synthesize(): Promise<never> {
          const error = new Error("voice id xyz not found for key el-live-9");
          error.name = "SpeechError";
          throw error;
        },
      },
      { spoken: [] as string[] },
    );
    const response = await speak(reference("assistant_message", MESSAGE));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("el-live");
  });
});

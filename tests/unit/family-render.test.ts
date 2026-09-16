import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { chatModel, familyRenderModel } from "@/server/config";
import {
  buildFamilyRenderMessages,
  familyRenderPromptV1,
} from "@/server/prompts/family-render.v1";
import { serializeSharePayload, type SharePayload } from "@/core/share/payload";
import { buildFallbackText } from "@/core/share/fallback";
import { sha256Hex } from "@/core/share/text-hash";
import { loadDetectionDebug } from "@/server/services/detection-debug";
import { createStore, fakeReconnectDeps, resetIds, type ReconnectStore } from "./detection-fakes";

const PAYLOAD: SharePayload = {
  fromDisplayName: "Dad",
  aboutEntityName: "Simba",
  topic: "visit",
  question: "ask_if_visiting",
};

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("1. the renderer's complete runtime input", () => {
  it("is the system prompt plus the serialized payload, and nothing else", () => {
    const messages = buildFamilyRenderMessages(PAYLOAD);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: familyRenderPromptV1.system });
    expect(messages[1]).toEqual({ role: "user", content: serializeSharePayload(PAYLOAD) });
  });

  it("has no channel through which history could arrive", () => {
    // The port's request type is { promptRef, payload }. There is no
    // `messages`, no `history` and no free text — the guarantee is structural,
    // not a matter of this call site being careful.
    const serialized = JSON.stringify(buildFamilyRenderMessages(PAYLOAD));
    expect(serialized).not.toContain("assistant");
    expect(buildFamilyRenderMessages(PAYLOAD).map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("is versioned, and the version is what gets logged", () => {
    expect(familyRenderPromptV1.ref).toBe("family-render.v1");
    expect(familyRenderPromptV1.id).toBe("family-render");
    expect(familyRenderPromptV1.version).toBe("v1");
  });

  it("instructs against exactly the things the guard enforces", () => {
    const system = familyRenderPromptV1.system.toLowerCase();
    for (const topic of ["mood", "loneliness", "health", "monitoring", "days"]) {
      expect(system).toContain(topic);
    }
    // And it says what it is: a renderer, not an author.
    expect(system).toContain("renderer, not an author");
  });
});

describe("2. the renderer's model is separately configurable", () => {
  it("falls back to the chat model when unset", () => {
    delete process.env.OPENAI_FAMILY_RENDER_MODEL;
    expect(familyRenderModel()).toBe(chatModel());
  });

  it("uses its own setting when present", () => {
    process.env.OPENAI_FAMILY_RENDER_MODEL = "some-other-model";
    expect(familyRenderModel()).toBe("some-other-model");
    expect(familyRenderModel()).not.toBe(chatModel());
  });
});

describe("3. the debug inspector proves the stored draft rather than restating it", () => {
  const NOW = new Date("2026-09-16T12:00:00.000Z");
  const USER = "u";

  function storeWith(renderedText: string | null, hash: string | null, sharePayload: unknown): ReconnectStore {
    return createStore({
      entities: [
        { id: "e1", type: "person", subtype: null, displayName: "John", aliases: [], status: "active", lastMentionedAt: null },
      ],
      signals: [
        {
          id: "sig-1", userId: USER, entityId: "e1", baselineId: null,
          signalType: "cadence_gap", status: "materialized",
          explanation: { detector: "cadence_gap", detectionKey: "dk" },
          detectedAt: NOW.toISOString(), suppressionReason: null,
          materializedAt: NOW.toISOString(),
        },
      ],
      opportunities: [
        {
          id: "opp-1", userId: USER, signalId: "sig-1", entityId: "e1",
          proposal: {}, sharePayload, renderedText, renderedTextHash: hash,
          status: "drafted", offeredAt: null, resolvedAt: null,
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          createdAt: NOW.toISOString(),
        },
      ],
    });
  }

  it("recomputes the hash and flags a mismatch", async () => {
    resetIds();
    const text = buildFallbackText(PAYLOAD);
    const good = storeWith(text, sha256Hex(text), PAYLOAD);
    const deps = fakeReconnectDeps({ store: good, clock: fixedClock(NOW) });
    const [view] = await loadDetectionDebug(deps, { userId: USER, now: NOW });
    expect(view.opportunity!.hashMatchesText).toBe(true);

    const bad = storeWith(text, sha256Hex(`${text} `), PAYLOAD);
    const badDeps = fakeReconnectDeps({ store: bad, clock: fixedClock(NOW) });
    const [badView] = await loadDetectionDebug(badDeps, { userId: USER, now: NOW });
    expect(badView.opportunity!.hashMatchesText).toBe(false);
  });

  it("derives whether the fallback was used, with no column to store it", async () => {
    const template = buildFallbackText(PAYLOAD);
    const fallback = storeWith(template, sha256Hex(template), PAYLOAD);
    const [fallbackView] = await loadDetectionDebug(
      fakeReconnectDeps({ store: fallback, clock: fixedClock(NOW) }),
      { userId: USER, now: NOW },
    );
    expect(fallbackView.opportunity!.fallbackUsed).toBe(true);

    const modelText = "Dad was wondering whether you and Simba might come round soon. Any chance?";
    const rendered = storeWith(modelText, sha256Hex(modelText), PAYLOAD);
    const [renderedView] = await loadDetectionDebug(
      fakeReconnectDeps({ store: rendered, clock: fixedClock(NOW) }),
      { userId: USER, now: NOW },
    );
    expect(renderedView.opportunity!.fallbackUsed).toBe(false);
  });

  it("shows a suppressed signal with its reason and no opportunity", async () => {
    const store = storeWith(null, null, null);
    store.opportunities = [];
    store.signals[0] = {
      ...store.signals[0], status: "suppressed", suppressionReason: "offer_cooldown",
      materializedAt: null,
    };
    const [view] = await loadDetectionDebug(
      fakeReconnectDeps({ store, clock: fixedClock(NOW) }),
      { userId: USER, now: NOW },
    );
    expect(view.status).toBe("suppressed");
    expect(view.suppressionReason).toBe("offer_cooldown");
    expect(view.opportunity).toBeNull();
    expect(view.entityName).toBe("John");
  });

  it("marks an opportunity past its expiry as no longer offerable", async () => {
    const text = buildFallbackText(PAYLOAD);
    const store = storeWith(text, sha256Hex(text), PAYLOAD);
    store.opportunities[0].expiresAt = new Date(NOW.getTime() - 1000).toISOString();
    const [view] = await loadDetectionDebug(
      fakeReconnectDeps({ store, clock: fixedClock(NOW) }),
      { userId: USER, now: NOW },
    );
    expect(view.opportunity!.expired).toBe(true);
  });
});

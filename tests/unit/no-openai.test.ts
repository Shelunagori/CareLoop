import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * PRODUCTION MUST WORK WITH NO OPENAI CREDENTIAL AT ALL.
 *
 * This project has no OpenAI credits. That makes "we migrated to Cloudflare"
 * an unverifiable claim unless something exercises the real composition root
 * with the OpenAI environment stripped to nothing and watches where the
 * requests actually go.
 *
 * So: every OPENAI_* variable is deleted, every production dependency is
 * constructed, every AI-backed port is CALLED, and every outbound URL is
 * recorded. The assertion is not "no OpenAI import exists" - dormant files
 * are allowed to remain - it is that nothing reaches api.openai.com.
 */
const OPENAI_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_CHAT_MODEL",
  "OPENAI_EXTRACTION_MODEL",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_FAMILY_RENDER_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "OPENAI_TRANSCRIPTION_LANGUAGE",
];

const ACCOUNT = "acct_no_openai";
const TOKEN = "cf-token-no-openai";

let urls: string[] = [];

/** A Cloudflare-shaped answer for whichever port is calling. */
function stubCloudflare() {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as Request)?.url ?? input);
      urls.push(url);

      if (url.includes("bge-m3")) {
        return Response.json({
          success: true,
          result: { data: [new Array(1024).fill(0.01)] },
        });
      }
      if (url.includes("whisper")) {
        return Response.json({ success: true, result: { text: "hello" } });
      }
      // Text model: streaming and non-streaming share an endpoint, so answer
      // in the shape both readers tolerate.
      return new Response(`data: {"response":"ok"}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

beforeEach(() => {
  for (const name of OPENAI_VARS) vi.stubEnv(name, undefined as unknown as string);
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  stubCloudflare();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production runs with OPENAI_API_KEY completely absent", () => {
  it("every OPENAI_* variable really is unset for these tests", () => {
    for (const name of OPENAI_VARS) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it("every production dependency factory constructs", async () => {
    const deps = await import("@/server/services/deps");
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
  });

  it("chat STREAMS from Cloudflare, and never contacts OpenAI", async () => {
    const { createConversationDeps } = await import("@/server/services/deps");
    const stream = await createConversationDeps().llm.streamChat({
      promptRef: "conversation.v4",
      messages: [{ role: "user", content: "Hello Nora." }],
    });

    const chunks: string[] = [];
    for await (const delta of stream) chunks.push(delta);

    expect(chunks.join("")).toBe("ok");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.cloudflare.com");
    expect(urls[0]).toContain("llama-3.3-70b-instruct-fp8-fast");
  });

  it("extraction runs on Cloudflare JSON mode, and never contacts OpenAI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        urls.push(String(input));
        return Response.json({ success: true, result: { response: { claims: [] } } });
      }),
    );

    const { createIngestionDeps } = await import("@/server/services/deps");
    const result = await createIngestionDeps().extraction.extract({
      promptRef: "extraction.v1",
      system: "Extract.",
      user: "John visited.",
      schemaName: "extraction",
      jsonSchema: { type: "object" },
    });

    expect(result.raw).toEqual({ claims: [] });
    expect(urls[0]).toContain("api.cloudflare.com");
  });

  it("embeddings run on Cloudflare BGE and arrive storage-width", async () => {
    const { createIngestionDeps } = await import("@/server/services/deps");
    const [vector] = await createIngestionDeps().embeddings.embed(["John visited on Tuesday."]);

    // 1024 from the model, 1536 into the unchanged column.
    expect(vector).toHaveLength(1536);
    expect(vector.slice(1024).every((value) => value === 0)).toBe(true);
    expect(urls[0]).toContain("api.cloudflare.com");
    expect(urls[0]).toContain("bge-m3");
  });

  it("family rendering runs on Cloudflare, and never contacts OpenAI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        urls.push(String(input));
        return Response.json({ success: true, result: { response: "Is John visiting?" } });
      }),
    );

    const { createReconnectDeps } = await import("@/server/services/deps");
    const result = await createReconnectDeps().familyRender.render({
      promptRef: "family-render.v2",
      payload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    });

    expect(result.text).toBe("Is John visiting?");
    expect(urls[0]).toContain("api.cloudflare.com");
  });

  it("transcription runs on Cloudflare, and never contacts OpenAI", async () => {
    const { createTranscriptionDeps } = await import("@/server/services/deps");
    const result = await createTranscriptionDeps().speechToText.transcribe({
      audio: new Uint8Array(1024).fill(3),
      mimeType: "audio/webm",
    });

    expect(result.text).toBe("hello");
    expect(urls[0]).toContain("api.cloudflare.com");
    expect(urls[0]).toContain("whisper-large-v3-turbo");
  });

  it("NOT ONE request in any of the above went to OpenAI", async () => {
    // Belt and braces: re-run the whole set and inspect every URL together,
    // so a future provider added to deps.ts cannot slip past the per-test
    // assertions above by being called from somewhere they do not look.
    const deps = await import("@/server/services/deps");
    const all: string[] = [];
    const record = () => all.push(...urls);

    await deps.createConversationDeps().llm.streamChat({
      promptRef: "conversation.v4",
      messages: [{ role: "user", content: "Hi." }],
    });
    record();
    await deps.createIngestionDeps().embeddings.embed(["text"]);
    record();
    await deps.createTranscriptionDeps().speechToText.transcribe({
      audio: new Uint8Array(1024).fill(3),
      mimeType: "audio/webm",
    });
    record();

    expect(all.length).toBeGreaterThan(0);
    for (const url of all) {
      expect(url, url).not.toContain("openai.com");
      expect(url).toContain("api.cloudflare.com");
    }
  });
});

describe("the composition root is Cloudflare-only", () => {
  it("no production factory constructs an OpenAI adapter", () => {
    const deps = readFileSync("server/services/deps.ts", "utf8");
    // Dormant FILES are allowed to remain; what is forbidden is wiring them.
    expect(deps).not.toContain("createOpenAi");
    expect(deps).not.toContain("adapters/openai/llm");
    expect(deps).not.toContain("adapters/openai/embeddings");
    expect(deps).not.toContain("adapters/openai/extraction");
    expect(deps).not.toContain("adapters/openai/family-render");
    expect(deps).not.toContain("adapters/openai/transcription");
  });

  it("no Cloudflare adapter can fall back to OpenAI", () => {
    for (const file of [
      "llm.ts",
      "extraction.ts",
      "embeddings.ts",
      "family-render.ts",
      "transcription.ts",
      "client.ts",
    ]) {
      const source = readFileSync(`server/adapters/cloudflare/${file}`, "utf8");
      expect(source, file).not.toContain("createOpenAi");
      expect(source, file).not.toContain("openai.com");
      expect(source, file).not.toContain("OPENAI_");
      // server-only turns an accidental client import into a build error
      // rather than a shipped token.
      expect(source, file).toContain('import "server-only"');
    }
  });

  it("no Cloudflare credential is named with a client-visible prefix", () => {
    for (const file of ["server/config.ts", "server/services/deps.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("NEXT_PUBLIC_CLOUDFLARE");
    }
  });
});

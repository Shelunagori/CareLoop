import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiTranscription } from "@/server/adapters/openai/transcription";
import { transcribeTurn } from "@/server/services/voice";
import { describeProviderError } from "@/server/adapters/openai/log";

/**
 * WHAT OPENAI ACTUALLY RECEIVES.
 *
 * Production returns 502 from /api/voice/transcribe, and the leading theory
 * was that the browser's `filename="speech"` - no extension - was being
 * forwarded and rejected, because OpenAI infers the container from the
 * extension.
 *
 * These tests exist to settle that from evidence rather than reasoning: the
 * HTTP boundary is stubbed, the multipart body the SDK builds is parsed, and
 * the filename and content-type in it are asserted. Whatever the 502 turns out
 * to be, the upload shape is no longer a question anybody has to guess about.
 */
const BYTES = new Uint8Array(4096).fill(7);

type Sent = { url: string; init: RequestInit };

function stubOpenAi(respond: () => Response) {
  const calls: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as Request)?.url ?? input);
      calls.push({ url, init: init ?? {} });
      return respond();
    }),
  );
  return calls;
}

const ok = (text = "I haven't seen John this week.") =>
  new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const rejected = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_abc123" },
  });

/**
 * The transcription request, out of everything the SDK issued.
 *
 * The client makes a `data:,` probe call before the real one, so a test that
 * asserted "exactly one fetch" would fail for a reason that has nothing to do
 * with CareLoop.
 */
const transcriptionCall = (calls: Sent[]): Sent => {
  const call = calls.find((entry) => entry.url.includes("/audio/transcriptions"));
  if (!call) throw new Error("no transcription request was made");
  return call;
};

/** The filename and content-type the PROVIDER sees on the file part. */
function filePart(call: Sent): { filename?: string; contentType?: string } {
  const body = call.init.body;
  if (!(body instanceof FormData)) throw new Error(`unexpected body: ${typeof body}`);
  const file = body.get("file");
  if (!(file instanceof File)) throw new Error("no file part in the request");
  return { filename: file.name, contentType: file.type };
}

/** The non-file fields, as strings. */
function fields(call: Sent): Record<string, string> {
  const body = call.init.body;
  if (!(body instanceof FormData)) throw new Error("unexpected body");
  const out: Record<string, string> = {};
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. the file OpenAI is given always has a container extension", () => {
  it("webm bytes arrive as speech.webm, audio/webm", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const calls = stubOpenAi(ok);

    await createOpenAiTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    const part = filePart(transcriptionCall(calls));
    expect(part.filename, "the provider was sent a file with no extension").toBe("speech.webm");
    expect(part.contentType).toBe("audio/webm");
  });

  it("the browser's extensionless `speech` never reaches the provider", async () => {
    // The route hands over BYTES plus a mime type; the browser's own part name
    // is discarded there. This asserts the adapter cannot be handed one.
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const calls = stubOpenAi(ok);

    await createOpenAiTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    const part = filePart(transcriptionCall(calls));
    expect(part.filename).not.toBe("speech");
    expect(part.filename).toMatch(/\.[a-z0-9]+$/);
  });

  it("a codecs parameter is normalized away before the provider sees it", async () => {
    // `audio/webm;codecs=opus` is what MediaRecorder produces. The service
    // normalizes it, so this is the pairing the adapter must handle.
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const calls = stubOpenAi(ok);
    const deps = { speechToText: createOpenAiTranscription() };

    const result = await transcribeTurn(deps, {
      audio: BYTES,
      mimeType: "audio/webm;codecs=opus",
    });

    expect(result.outcome).toBe("transcribed");
    const part = filePart(transcriptionCall(calls));
    expect(part.contentType, "a codecs parameter reached the provider").toBe("audio/webm");
    expect(part.filename).toBe("speech.webm");
  });

  it("every accepted container gets its own extension", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    for (const [mimeType, expected] of [
      ["audio/webm", "speech.webm"],
      ["audio/ogg", "speech.ogg"],
      ["audio/mp4", "speech.mp4"],
      ["audio/mpeg", "speech.mp3"],
      ["audio/wav", "speech.wav"],
    ] as const) {
      const calls = stubOpenAi(ok);
      await createOpenAiTranscription().transcribe({ audio: BYTES, mimeType });
      expect(filePart(transcriptionCall(calls)).filename, mimeType).toBe(expected);
      vi.unstubAllGlobals();
    }
  });
});

describe("2. a successful transcription", () => {
  it("returns the provider's words, trimmed, and the model used", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    stubOpenAi(() => ok("  I haven't seen John this week.  "));

    const result = await createOpenAiTranscription().transcribe({
      audio: BYTES,
      mimeType: "audio/webm",
    });

    expect(result.text).toBe("I haven't seen John this week.");
    expect(result.model).toBe("gpt-4o-mini-transcribe");
  });

  it("the model and language actually sent are the configured ones", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    vi.stubEnv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-transcribe");
    vi.stubEnv("OPENAI_TRANSCRIPTION_LANGUAGE", "nl");
    const calls = stubOpenAi(ok);

    await createOpenAiTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    expect(fields(transcriptionCall(calls))).toMatchObject({
      model: "gpt-4o-transcribe",
      language: "nl",
    });
  });
});

describe("3. empty audio never reaches the provider", () => {
  it("is refused by the service, before any request", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const calls = stubOpenAi(ok);
    const deps = { speechToText: createOpenAiTranscription() };

    const result = await transcribeTurn(deps, {
      audio: new Uint8Array(0),
      mimeType: "audio/webm",
    });

    expect(result).toEqual({ outcome: "rejected", reason: { code: "empty_audio" } });
    expect(
      calls.filter((entry) => entry.url.includes("/audio/transcriptions")),
      "an empty recording was sent upstream",
    ).toHaveLength(0);
  });
});

describe("4. an upstream rejection is captured in full, and leaks nothing", () => {
  it("a 400 is described by status, code, type, request id and message", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    stubOpenAi(() =>
      rejected(400, {
        error: {
          message: "Invalid file format. Supported formats: flac, m4a, mp3, mp4, ...",
          type: "invalid_request_error",
          code: "invalid_value",
        },
      }),
    );

    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => void logged.push(String(line)));
    await expect(
      createOpenAiTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" }),
    ).rejects.toThrow();
    spy.mockRestore();

    const line = logged.map((entry) => JSON.parse(entry)).find((entry) => entry.outcome === "request_failed");
    expect(line, "no request_failed line was logged").toBeTruthy();
    expect(line.upstreamStatus).toBe(400);
    expect(line.upstreamCode).toBe("invalid_value");
    expect(line.upstreamType).toBe("invalid_request_error");
    expect(String(line.upstreamMessage)).toContain("Invalid file format");
    // And what WE sent, so the two can be compared without a second deploy.
    expect(line.sentFilename).toBe("speech.webm");
    expect(line.sentMimeType).toBe("audio/webm");
    expect(line.uploadBytes).toBe(BYTES.byteLength);
    expect(line.model).toBe("gpt-4o-mini-transcribe");
  });

  it("a 401 is reported as a 401, not as a mystery", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    stubOpenAi(() =>
      rejected(401, {
        error: { message: "Incorrect API key provided: sk-abc123456789.", code: "invalid_api_key" },
      }),
    );

    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => void logged.push(String(line)));
    await expect(
      createOpenAiTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" }),
    ).rejects.toThrow();
    spy.mockRestore();

    const line = logged.map((entry) => JSON.parse(entry)).find((entry) => entry.outcome === "request_failed");
    expect(line.upstreamStatus).toBe(401);
    expect(line.upstreamCode).toBe("invalid_api_key");
    // The provider echoed a key shape back. It must not survive into a log.
    expect(String(line.upstreamMessage)).not.toContain("sk-abc123456789");
    expect(String(line.upstreamMessage)).toContain("[redacted]");
  });

  it("nothing logged on failure contains the key, the audio or a header", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-live-should-never-appear");
    stubOpenAi(() => rejected(500, { error: { message: "upstream" } }));

    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => void logged.push(String(line)));
    const err = vi.spyOn(console, "error").mockImplementation((line) => void logged.push(String(line)));
    await createOpenAiTranscription()
      .transcribe({ audio: BYTES, mimeType: "audio/webm" })
      .catch(() => undefined);
    log.mockRestore();
    err.mockRestore();

    const printed = logged.join("\n");
    expect(printed).not.toContain("sk-live-should-never-appear");
    expect(printed).not.toContain("Authorization");
    expect(printed).not.toContain("Bearer");
    // No audio, and no hash of it either.
    expect(printed).not.toContain("77777");
  });

  it("the service turns any upstream failure into a name, and nothing more", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    stubOpenAi(() => rejected(400, { error: { message: "Invalid file format.", code: "invalid_value" } }));
    const deps = { speechToText: createOpenAiTranscription() };

    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await transcribeTurn(deps, { audio: BYTES, mimeType: "audio/webm" });
    spy.mockRestore();

    expect(result.outcome).toBe("provider_failed");
    // The client sees `transcription_failed` and a 502; the provider's words
    // stay in the log. This is what the route serialises.
    expect(JSON.stringify(result)).not.toContain("Invalid file format");
  });
});

describe("5. the error describer, on its own", () => {
  it("survives a provider that returns nothing useful", () => {
    expect(describeProviderError(null).message).toBe("UnknownError");
    expect(describeProviderError(new Error("plain")).message).toBe("plain");
    expect(describeProviderError({ status: 429 }).status).toBe(429);
  });

  it("caps a provider that returns an essay", () => {
    const facts = describeProviderError({ message: "x".repeat(5_000) });
    expect(facts.message.length).toBeLessThanOrEqual(300);
  });

  it("redacts a bearer token as well as a key", () => {
    const facts = describeProviderError({ message: "with Bearer abc.def-123 inside" });
    expect(facts.message).not.toContain("abc.def-123");
    expect(facts.message).toContain("[redacted]");
  });
});

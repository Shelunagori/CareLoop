import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createCloudflareTranscription } from "@/server/adapters/cloudflare/transcription";
import { transcribeTurn } from "@/server/services/voice";
import {
  cloudflareTranscriptionConfig,
  DEFAULT_CLOUDFLARE_TRANSCRIPTION_MODEL,
} from "@/server/config";

/**
 * WHAT CLOUDFLARE ACTUALLY RECEIVES, AND WHAT CARELOOP DOES WITH WHAT COMES
 * BACK.
 *
 * Transcription moved off OpenAI onto Workers AI. The application contract
 * did not move: the route still answers `{ error: "transcription_failed" }`
 * with a 502 for every upstream fault, the service still turns a thrown
 * adapter error into `provider_failed`, and the port still returns one string.
 *
 * The HTTP boundary is stubbed, so these assert the wire format - the URL, the
 * bearer header, the base64 body, the model, the language - and the failure
 * mapping, which is the part that decides whether a person hears "I didn't
 * catch that" or "that recording didn't work".
 */
const BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Uint8Array(4092).fill(7)]);

const ACCOUNT = "acct_1234567890";
const TOKEN = "cf-secret-token-value";

type Sent = { url: string; init: RequestInit };

function stubCloudflare(respond: () => Response) {
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

function configured(env: Record<string, string | undefined> = {}) {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

const envelope = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const success = (text = "I haven't seen John this week.") =>
  envelope({ result: { text }, success: true, errors: [], messages: [] });

const failure = (status: number, code?: number, message?: string) =>
  envelope(
    { result: null, success: false, errors: code ? [{ code, message }] : [], messages: [] },
    status,
  );

const bodyOf = (call: Sent) => JSON.parse(String(call.init.body)) as Record<string, unknown>;

/** Every line the adapter printed during one test. */
function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Cloudflare Workers AI transcription — configuration", () => {
  /**
   * A missing credential must behave like any other transcription fault: the
   * person is told the recording didn't work, and the route answers
   * `{ error: "transcription_failed" }`.
   *
   * It must NOT take the factory down. `createTranscriptionDeps()` runs inside
   * the route handler but outside the service's try/catch, so a factory that
   * threw here would produce an unhandled 500 and lose the contract precisely
   * when a deployment is misconfigured.
   */
  it("constructing the provider never throws for want of a credential", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    expect(() => createCloudflareTranscription()).not.toThrow();
  });

  for (const missing of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    it(`a missing ${missing} fails by NAME at call time, and never reaches the network`, async () => {
      configured({ [missing]: "" });
      const logs = captureLogs();
      const calls = stubCloudflare(success);

      const outcome = await transcribeTurn(
        { speechToText: createCloudflareTranscription() },
        { audio: BYTES, mimeType: "audio/webm" },
      );

      expect(calls, "a request was sent without a credential").toHaveLength(0);
      expect(outcome).toEqual({
        outcome: "provider_failed",
        errorName: "CloudflareTranscriptionNotConfiguredError",
      });
      // Diagnosable: the log says which variable, so the fix is one line.
      const line = JSON.parse(logs.at(-1) as string) as Record<string, unknown>;
      expect(line.outcome).toBe("not_configured");
      expect(line.missingVariable).toBe(missing);
      expect(line.provider).toBe("cloudflare");
    });
  }

  it("the failure names the variable and NOT a value", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT);
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    try {
      cloudflareTranscriptionConfig();
      expect.unreachable("expected a configuration error");
    } catch (error) {
      expect((error as Error).message).toContain("CLOUDFLARE_API_TOKEN");
      expect((error as Error).message).not.toContain(ACCOUNT);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("whitespace is not configuration", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "   ");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
    expect(() => cloudflareTranscriptionConfig()).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("the model defaults to whisper-large-v3-turbo, and an override is honoured", async () => {
    configured({ CLOUDFLARE_TRANSCRIPTION_MODEL: undefined });
    let calls = stubCloudflare(success);
    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });
    expect(calls[0].url).toContain(DEFAULT_CLOUDFLARE_TRANSCRIPTION_MODEL);
    expect(DEFAULT_CLOUDFLARE_TRANSCRIPTION_MODEL).toBe("@cf/openai/whisper-large-v3-turbo");

    configured({ CLOUDFLARE_TRANSCRIPTION_MODEL: "@cf/openai/whisper" });
    calls = stubCloudflare(success);
    const result = await createCloudflareTranscription().transcribe({
      audio: BYTES,
      mimeType: "audio/webm",
    });
    expect(calls[0].url).toContain("@cf/openai/whisper");
    // And the model that ANSWERED is the one reported back, not the default.
    expect(result.model).toBe("@cf/openai/whisper");
  });
});

describe("Cloudflare Workers AI transcription — the request", () => {
  it("goes to the documented account-scoped run endpoint, with the token in the header only", async () => {
    configured();
    const calls = stubCloudflare(success);

    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${DEFAULT_CLOUDFLARE_TRANSCRIPTION_MODEL}`,
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The token is a credential, not a query parameter: a URL lands in
    // access logs, proxies and error messages, and the header does not.
    expect(calls[0].url).not.toContain(TOKEN);
    expect(String(calls[0].init.body)).not.toContain(TOKEN);
  });

  it("carries the recorded bytes UNCHANGED — base64 is transport, not a transcode", async () => {
    configured();
    const calls = stubCloudflare(success);

    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    const sent = bodyOf(calls[0]).audio;
    expect(typeof sent).toBe("string");
    // Decoded, byte for byte, including the WebM magic number at the front.
    const decoded = new Uint8Array(Buffer.from(sent as string, "base64"));
    expect(decoded).toEqual(BYTES);
    expect(Array.from(decoded.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  it("asks for a transcription in a pinned language, not a translation or a guess", async () => {
    configured();
    const calls = stubCloudflare(success);

    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    const body = bodyOf(calls[0]);
    expect(body.task).toBe("transcribe");
    expect(body.language).toBe("en");
  });

  it("the language is configuration, not a literal", async () => {
    configured({ CARELOOP_TRANSCRIPTION_LANGUAGE: "nl" });
    const calls = stubCloudflare(success);

    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    expect(bodyOf(calls[0]).language).toBe("nl");
  });

  it("sends JSON — there is no filename to get wrong on this API", async () => {
    configured();
    const calls = stubCloudflare(success);

    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(String(calls[0].init.body)).not.toContain("speech.webm");
  });
});

describe("Cloudflare Workers AI transcription — the response", () => {
  it("returns result.text, trimmed, and never corrects it", async () => {
    configured();
    stubCloudflare(() => success("  i havent seen john  "));

    const result = await createCloudflareTranscription().transcribe({
      audio: BYTES,
      mimeType: "audio/webm",
    });

    expect(result.text).toBe("i havent seen john");
    expect(result.model).toBe(DEFAULT_CLOUDFLARE_TRANSCRIPTION_MODEL);
  });

  it("silence stays SILENCE — it is not a provider failure", async () => {
    configured();
    stubCloudflare(() => success("   "));

    const outcome = await transcribeTurn(
      { speechToText: createCloudflareTranscription() },
      { audio: BYTES, mimeType: "audio/webm" },
    );

    // The person is told "I didn't catch that", which is true, rather than
    // "that recording didn't work", which is not.
    expect(outcome.outcome).toBe("no_speech");
  });

  it("a 200 without a usable transcript is a FAILURE, not silence", async () => {
    configured();
    stubCloudflare(() => envelope({ result: {}, success: true }));

    const outcome = await transcribeTurn(
      { speechToText: createCloudflareTranscription() },
      { audio: BYTES, mimeType: "audio/webm" },
    );

    // Reporting silence here would tell the person CareLoop didn't hear them
    // when in fact the provider answered in a shape nobody can read.
    expect(outcome.outcome).toBe("provider_failed");
  });

  it("success: false on a 200 is a failure too", async () => {
    configured();
    stubCloudflare(() => envelope({ result: null, success: false, errors: [{ code: 3036 }] }));

    const outcome = await transcribeTurn(
      { speechToText: createCloudflareTranscription() },
      { audio: BYTES, mimeType: "audio/webm" },
    );

    expect(outcome.outcome).toBe("provider_failed");
  });
});

describe("Cloudflare Workers AI transcription — failure mapping", () => {
  const upstream: Array<[string, () => Response]> = [
    ["400 bad request", () => failure(400, 7003, "Could not route to the model")],
    ["401 unauthorised", () => failure(401, 10000, "Authentication error")],
    ["403 forbidden", () => failure(403, 10000, "Unauthorized to access requested resource")],
    ["429 rate limited", () => failure(429, 972, "Rate limit exceeded")],
    ["free allocation exhausted", () => failure(429, 3036, "Account limited: Neuron quota")],
    ["500 upstream", () => failure(500, 3040, "Internal error")],
    ["503 unavailable", () => failure(503)],
    ["a non-JSON body", () => new Response("<html>gateway</html>", { status: 502 })],
  ];

  for (const [label, respond] of upstream) {
    it(`${label} becomes provider_failed, and the person learns nothing about Cloudflare`, async () => {
      configured();
      captureLogs();
      stubCloudflare(respond);

      const outcome = await transcribeTurn(
        { speechToText: createCloudflareTranscription() },
        { audio: BYTES, mimeType: "audio/webm" },
      );

      expect(outcome.outcome).toBe("provider_failed");
      /**
       * The route turns this one outcome into 502 + transcription_failed for
       * every case above, so the mapping is what makes a quota failure and a
       * malformed body indistinguishable to the person - deliberately.
       *
       * What crosses into the outcome is an error NAME, which the route logs.
       * The provider's prose, its status code and any credential stay on the
       * far side of the adapter.
       */
      expect(outcome).toEqual({
        outcome: "provider_failed",
        errorName: "CloudflareTranscriptionError",
      });
    });
  }

  it("a network fault becomes provider_failed without leaking the request URL", async () => {
    configured();
    const logs = captureLogs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error(
          `request to https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/x failed`,
        );
        error.name = "TypeError";
        throw error;
      }),
    );

    const outcome = await transcribeTurn(
      { speechToText: createCloudflareTranscription() },
      { audio: BYTES, mimeType: "audio/webm" },
    );

    expect(outcome.outcome).toBe("provider_failed");
    // The account id is in the rejected request's message. Only the error's
    // NAME crosses into the log line and into the thrown error.
    expect(logs.join("\n")).not.toContain(ACCOUNT);
    expect(JSON.stringify(outcome)).not.toContain(ACCOUNT);
  });
});

describe("Cloudflare Workers AI transcription — diagnostics", () => {
  it("a failure is diagnosable: provider, status, code, model, language, size, latency", async () => {
    configured();
    const logs = captureLogs();
    stubCloudflare(() => failure(429, 3036, "Account limited"));

    await transcribeTurn(
      { speechToText: createCloudflareTranscription() },
      { audio: BYTES, mimeType: "audio/webm" },
    );

    const line = JSON.parse(logs.at(-1) as string) as Record<string, unknown>;
    expect(line.provider).toBe("cloudflare");
    expect(line.upstreamStatus).toBe(429);
    expect(line.upstreamCode).toBe("3036");
    expect(line.model).toBe(DEFAULT_CLOUDFLARE_TRANSCRIPTION_MODEL);
    expect(line.language).toBe("en");
    expect(line.uploadBytes).toBe(BYTES.byteLength);
    expect(line.sentMimeType).toBe("audio/webm");
    expect(typeof line.latencyMs).toBe("number");
    expect(line.outcome).toBe("request_failed");
  });

  it("no secret, no audio and no transcript is ever printed", async () => {
    configured();
    const logs = captureLogs();
    stubCloudflare(() => success("John called on Tuesday and we talked about the garden."));

    await createCloudflareTranscription().transcribe({ audio: BYTES, mimeType: "audio/webm" });
    // And again on the failure path, which prints strictly more.
    stubCloudflare(() => failure(401, 10000, `Invalid token ${TOKEN}`));
    await transcribeTurn(
      { speechToText: createCloudflareTranscription() },
      { audio: BYTES, mimeType: "audio/webm" },
    );

    const printed = logs.join("\n");
    // Cloudflare quoted the token back in its 401. It must not survive.
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(ACCOUNT);
    expect(printed).not.toContain("Bearer");
    expect(printed).not.toContain("garden");
    expect(printed).not.toContain(Buffer.from(BYTES).toString("base64").slice(0, 32));
    // A length is not content.
    expect(JSON.parse(logs[0]).transcriptLength).toBe(
      "John called on Tuesday and we talked about the garden.".length,
    );
  });
});

describe("Cloudflare Workers AI transcription — the security model", () => {
  it("no Cloudflare credential is reachable from the browser", () => {
    // NEXT_PUBLIC_* is inlined into the client bundle at build time, so the
    // guard is on the NAME, not on where the read happens to sit today.
    const sources = ["server/adapters/cloudflare/transcription.ts", "server/config.ts"];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("NEXT_PUBLIC_CLOUDFLARE");
    }
    const adapter = readFileSync("server/adapters/cloudflare/transcription.ts", "utf8");
    // server-only turns an accidental client import into a build error rather
    // than a shipped token.
    expect(adapter).toContain('import "server-only"');
  });

  it("nothing outside the server reads a Cloudflare variable", () => {
    // A client component reading process.env.CLOUDFLARE_API_TOKEN would get
    // undefined in the browser, which fails quietly; asserted so it cannot
    // be introduced in the first place.
    const offenders = readFileSync("app/api/voice/transcribe/route.ts", "utf8");
    expect(offenders).not.toContain("CLOUDFLARE");
  });

  it("transcription does not silently fall back to OpenAI", () => {
    // The whole point of the migration: a misconfigured deployment must fail
    // loudly rather than quietly spending OpenAI credits.
    const deps = readFileSync("server/services/deps.ts", "utf8");
    const wiring = /createTranscriptionDeps\(\)[^{]*\{([\s\S]*?)\n\}/.exec(deps)?.[1] ?? "";
    expect(wiring).toContain("createCloudflareTranscription");
    expect(wiring).not.toContain("createOpenAiTranscription");
    expect(wiring).not.toContain("catch");
    const adapter = readFileSync("server/adapters/cloudflare/transcription.ts", "utf8");
    expect(adapter).not.toContain("createOpenAiTranscription");
  });
});

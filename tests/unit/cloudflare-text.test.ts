import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareLlm } from "@/server/adapters/cloudflare/llm";
import { createCloudflareExtraction } from "@/server/adapters/cloudflare/extraction";
import { createCloudflareFamilyRender } from "@/server/adapters/cloudflare/family-render";
import { createCloudflareEmbeddings } from "@/server/adapters/cloudflare/embeddings";
import { readSseText } from "@/server/adapters/cloudflare/sse";
import { cloudflareOutputLimits } from "@/server/config";

const ACCOUNT = "acct_text_tests";
const TOKEN = "cf-text-token-secret";
const PRIVATE = "George said his wife Mary died in April.";

type Sent = { url: string; init: RequestInit };
let calls: Sent[] = [];
let logs: string[] = [];

function respondWith(make: () => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return make();
    }),
  );
}

const sse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const failure = (status: number, code?: number, message?: string) =>
  Response.json(
    { success: false, result: null, errors: code ? [{ code, message }] : [] },
    { status },
  );

const bodyOf = (call: Sent) => JSON.parse(String(call.init.body)) as Record<string, unknown>;

const drain = async (stream: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const delta of stream) out.push(delta);
  return out;
};

/** A ReadableStream that hands out exactly these byte chunks. */
const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SSE parsing", () => {
  it("reassembles text split across arbitrary chunk boundaries", async () => {
    // The network decides where chunks break, and it does not respect events,
    // JSON payloads or characters. A parser that assumed otherwise would
    // silently drop or mangle words.
    const wire = `data: {"response":"Hello "}\n\ndata: {"response":"George"}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(wire);
    const chunks = Array.from({ length: bytes.length }, (_, i) => bytes.slice(i, i + 1));

    expect(await drain(readSseText(streamOf(chunks)))).toEqual(["Hello ", "George"]);
  });

  it("does not split a multi-byte character in half", async () => {
    const wire = `data: {"response":"café — déjà"}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(wire);
    // Break mid-character on purpose.
    const chunks = [bytes.slice(0, 22), bytes.slice(22)];

    expect((await drain(readSseText(streamOf(chunks)))).join("")).toBe("café — déjà");
  });

  it("ignores [DONE], keepalives and malformed events rather than failing a turn", async () => {
    const wire =
      `: keepalive\n\n` +
      `data: [DONE]\n\n` +
      `data: not json\n\n` +
      `data: {"response":"kept"}\n\n`;

    expect(await drain(readSseText(streamOf([new TextEncoder().encode(wire)])))).toEqual(["kept"]);
  });

  it("emits a final event that arrived without a trailing blank line", async () => {
    const wire = `data: {"response":"last word"}`;
    expect(await drain(readSseText(streamOf([new TextEncoder().encode(wire)])))).toEqual([
      "last word",
    ]);
  });
});

describe("chat", () => {
  it("resolves only once the provider has ACCEPTED — a 401 rejects before any body is written", async () => {
    respondWith(() => failure(401, 10000, "Authentication error"));

    // The port's contract: the caller must be able to send an error response.
    // Once streaming has begun the only way to report failure is to stop
    // mid-sentence, so this must reject, not yield nothing.
    await expect(
      createCloudflareLlm().streamChat({ promptRef: "conversation.v3", messages: [] }),
    ).rejects.toThrow(/cloudflare request failed/);
  });

  for (const [label, status, code] of [
    ["400", 400, 7003],
    ["403", 403, 10000],
    ["429 rate limit", 429, 972],
    ["429 quota exhausted", 429, 3036],
    ["500", 500, 3040],
    ["503", 503, undefined],
  ] as const) {
    it(`${label} rejects before streaming, and tells the browser nothing`, async () => {
      respondWith(() => failure(status, code));

      const error = await createCloudflareLlm()
        .streamChat({ promptRef: "conversation.v3", messages: [] })
        .catch((e: Error) => e);

      expect((error as Error).name).toBe("CloudflareProviderError");
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(ACCOUNT);
    });
  }

  it("asks for an output ceiling, because Workers AI defaults to 256", async () => {
    respondWith(() => sse(`data: {"response":"hi"}\n\ndata: [DONE]\n\n`));

    await drain(
      await createCloudflareLlm().streamChat({
        promptRef: "conversation.v3",
        messages: [{ role: "user", content: "Hello" }],
      }),
    );

    const body = bodyOf(calls[0]);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(cloudflareOutputLimits.chat);
    expect(body.max_tokens).toBe(512);
  });

  it("a mid-stream fault throws from the iterable, having already yielded", async () => {
    // The error must arrive on a LATER pull. `controller.error()` inside
    // `start()` discards chunks already enqueued, so a stream built that way
    // yields nothing and would test the platform rather than the adapter.
    respondWith(() => {
      let pulls = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode(`data: {"response":"partial"}\n\n`));
              return;
            }
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200 },
      );
    });

    const stream = await createCloudflareLlm().streamChat({
      promptRef: "conversation.v3",
      messages: [],
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const delta of stream) seen.push(delta);
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual(["partial"]);
  });

  it("neither the prompt nor the reply is logged — only a hash and a length", async () => {
    respondWith(() => sse(`data: {"response":"${PRIVATE}"}\n\ndata: [DONE]\n\n`));

    await drain(
      await createCloudflareLlm().streamChat({
        promptRef: "conversation.v3",
        messages: [{ role: "user", content: PRIVATE }],
      }),
    );

    const printed = logs.join("\n");
    expect(printed).not.toContain("Mary");
    expect(printed).not.toContain(PRIVATE);
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain("Bearer");
    expect(JSON.parse(logs.at(-1) as string).outputChars).toBe(PRIVATE.length);
  });
});

describe("extraction", () => {
  it("asks for JSON mode with the caller's schema", async () => {
    respondWith(() => Response.json({ success: true, result: { response: { claims: [] } } }));

    await createCloudflareExtraction().extract({
      promptRef: "extraction.v1",
      system: "s",
      user: "u",
      schemaName: "extraction",
      jsonSchema: { type: "object", properties: { claims: { type: "array" } } },
    });

    const body = bodyOf(calls[0]) as { response_format: { type: string; json_schema: unknown } };
    expect(body.response_format.type).toBe("json_schema");
    // Cloudflare takes the schema directly, not OpenAI's {name,strict,schema}.
    expect(body.response_format.json_schema).toEqual({
      type: "object",
      properties: { claims: { type: "array" } },
    });
  });

  it("an unmet schema FAILS — it is never passed off as an empty extraction", async () => {
    // Cloudflare does not guarantee conformance and says so. Returning {} here
    // would let ingestion record that a turn contained nothing worth
    // remembering, which is a lie about someone's life rather than an error.
    respondWith(() =>
      Response.json({ success: true, result: { response: "JSON Mode couldn't be met" } }),
    );

    await expect(
      createCloudflareExtraction().extract({
        promptRef: "extraction.v1",
        system: "s",
        user: "u",
        schemaName: "extraction",
        jsonSchema: {},
      }),
    ).rejects.toThrow(/schema_not_met/);
  });

  it("unparseable JSON fails rather than half-parsing", async () => {
    respondWith(() => Response.json({ success: true, result: { response: '{"claims":[' } }));

    await expect(
      createCloudflareExtraction().extract({
        promptRef: "extraction.v1",
        system: "s",
        user: "u",
        schemaName: "x",
        jsonSchema: {},
      }),
    ).rejects.toThrow(/unparseable_json/);
  });

  it("hands the caller UNVALIDATED output, so zod stays the authority", async () => {
    // The port documents `raw` as unvalidated and the ingestion service runs
    // zod over it. The adapter must not quietly clean it up first.
    respondWith(() =>
      Response.json({ success: true, result: { response: { unexpected: "field" } } }),
    );

    const result = await createCloudflareExtraction().extract({
      promptRef: "extraction.v1",
      system: "s",
      user: "u",
      schemaName: "x",
      jsonSchema: {},
    });

    expect(result.raw).toEqual({ unexpected: "field" });
  });

  it("does not log what was extracted", async () => {
    respondWith(() => Response.json({ success: true, result: { response: { name: "Mary" } } }));

    await createCloudflareExtraction().extract({
      promptRef: "extraction.v1",
      system: PRIVATE,
      user: PRIVATE,
      schemaName: "x",
      jsonSchema: {},
    });

    const printed = logs.join("\n");
    expect(printed).not.toContain("Mary");
    expect(printed).not.toContain(PRIVATE);
  });
});

describe("family render", () => {
  it("returns the provider's text unguarded, with its own output ceiling", async () => {
    respondWith(() => Response.json({ success: true, result: { response: "Is John visiting?" } }));

    const result = await createCloudflareFamilyRender().render({
      promptRef: "family-render.v2",
      payload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    });

    expect(result.text).toBe("Is John visiting?");
    expect(bodyOf(calls[0]).max_tokens).toBe(cloudflareOutputLimits.familyRender);
  });

  it("does not log the payload or the rendered message", async () => {
    respondWith(() =>
      Response.json({ success: true, result: { response: "Dad misses you, John." } }),
    );

    await createCloudflareFamilyRender().render({
      promptRef: "family-render.v2",
      payload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    });

    const printed = logs.join("\n");
    expect(printed).not.toContain("misses you");
    expect(printed).not.toContain("Dad");
  });
});

describe("embeddings", () => {
  it("sends `text` and pads every returned vector to storage width", async () => {
    respondWith(() =>
      Response.json({
        success: true,
        result: { data: [new Array(1024).fill(0.5), new Array(1024).fill(0.25)] },
      }),
    );

    const vectors = await createCloudflareEmbeddings().embed(["one", "two"]);

    expect(bodyOf(calls[0]).text).toEqual(["one", "two"]);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(1536);
      expect(vector.slice(1024).every((v) => v === 0)).toBe(true);
    }
  });

  it("records the width the provider ACTUALLY returned, on success and on failure", async () => {
    /**
     * The 1024 this codebase pads from comes from BGE-M3's model card, not
     * from Cloudflare's documentation. Logging the observed width is what
     * turns that assumption into something a live run can confirm or refute -
     * and on a failure it is the difference between "the width was wrong" and
     * "the width was 768", which name different causes.
     */
    respondWith(() => Response.json({ success: true, result: { data: [new Array(1024).fill(1)] } }));
    await createCloudflareEmbeddings().embed(["one"]);
    expect(JSON.parse(logs.at(-1) as string).providerDimensions).toBe(1024);

    respondWith(() => Response.json({ success: true, result: { data: [new Array(768).fill(1)] } }));
    await createCloudflareEmbeddings()
      .embed(["one"])
      .catch(() => undefined);
    const failure = JSON.parse(logs.at(-1) as string);
    expect(failure.outcome).toBe("wrong_dimensions");
    expect(failure.receivedDimensions).toBe(768);
    expect(failure.expectedDimensions).toBe(1024);
  });

  it("a wrong-width vector FAILS rather than entering the index", async () => {
    // The dangerous case: a model swap that starts returning 768 or 1536. Both
    // would be silently storable and would make every later similarity search
    // compare vectors from different models.
    respondWith(() => Response.json({ success: true, result: { data: [new Array(768).fill(1)] } }));

    await expect(createCloudflareEmbeddings().embed(["one"])).rejects.toThrow(/wrong_dimensions/);
  });

  it("a short batch FAILS — a mis-paired vector is worse than none", async () => {
    respondWith(() => Response.json({ success: true, result: { data: [new Array(1024).fill(1)] } }));

    await expect(createCloudflareEmbeddings().embed(["one", "two"])).rejects.toThrow(
      /malformed_response/,
    );
  });

  it("an empty request never reaches the network", async () => {
    respondWith(() => Response.json({ success: true, result: { data: [] } }));
    expect(await createCloudflareEmbeddings().embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("the vector is never logged, only a hash of its input", async () => {
    respondWith(() => Response.json({ success: true, result: { data: [new Array(1024).fill(0.7)] } }));

    await createCloudflareEmbeddings().embed([PRIVATE]);

    const printed = logs.join("\n");
    expect(printed).not.toContain(PRIVATE);
    expect(printed).not.toContain("0.7");
    expect(JSON.parse(logs.at(-1) as string).inputHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("credentials", () => {
  for (const [name, build] of [
    ["chat", () => createCloudflareLlm().streamChat({ promptRef: "p", messages: [] })],
    [
      "extraction",
      () =>
        createCloudflareExtraction().extract({
          promptRef: "p",
          system: "s",
          user: "u",
          schemaName: "x",
          jsonSchema: {},
        }),
    ],
    ["embeddings", () => createCloudflareEmbeddings().embed(["x"])],
    [
      "family render",
      () =>
        createCloudflareFamilyRender().render({
          promptRef: "p",
          payload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
        }),
    ],
  ] as const) {
    it(`${name}: a missing token fails by name and never reaches the network`, async () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      respondWith(() => Response.json({ success: true, result: {} }));

      await expect(build()).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
      expect(calls).toHaveLength(0);
    });

    it(`${name}: the token travels in the header, never the URL or body`, async () => {
      respondWith(() =>
        Response.json({ success: true, result: { response: "ok", data: [new Array(1024).fill(1)] } }),
      );
      await build().catch(() => undefined);

      expect(calls[0].url).not.toContain(TOKEN);
      expect(String(calls[0].init.body)).not.toContain(TOKEN);
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });
  }

  it("a provider message quoting the token back is redacted before it is logged", async () => {
    respondWith(() => failure(401, 10000, `Invalid token ${TOKEN} for account ${ACCOUNT}`));

    await createCloudflareEmbeddings()
      .embed(["x"])
      .catch(() => undefined);

    const printed = logs.join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(ACCOUNT);
    expect(printed).toContain("[redacted]");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifierMessage } from "@/server/adapters/notifier";

/**
 * The Brevo transport, against a mocked HTTP boundary.
 *
 * No real email is ever sent from the suite, and no BREVO_API_KEY is needed to
 * run it. What is under test is the contract: the endpoint, where the key goes,
 * who the single recipient is, that our own request id is the idempotency key,
 * that the approved bytes arrive unchanged, and that nothing about a provider
 * failure leaks a token, a message or an address into a log.
 */
const ENV = {
  BREVO_API_KEY: "test-key-not-a-real-one",
  BREVO_SENDER_EMAIL: "careloop@example.test",
  BREVO_SENDER_NAME: "CareLoop",
} as NodeJS.ProcessEnv;

const BODY = 'Dad was wondering — are you & Simba able to "visit" soon? ☕ ';

const MESSAGE: NotifierMessage = {
  requestId: "11111111-2222-4333-8444-555555555555",
  channel: "email",
  address: "john@example.test",
  recipientDisplayName: "John",
  body: BODY,
  responseUrl: "https://careloop.example.test/family/respond/TOKEN-abc",
};

type Sent = { url: string; init: RequestInit };

function stubFetch(response: Response) {
  const calls: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return response.clone();
    }),
  );
  return calls;
}

const ok = (messageId = "<provider-id@brevo>") =>
  new Response(JSON.stringify({ messageId }), { status: 201 });

const body = (call: Sent) => JSON.parse(String(call.init.body)) as Record<string, unknown>;

async function notifier(env: NodeJS.ProcessEnv = ENV) {
  const { createBrevoEmailNotifier } = await import("@/server/adapters/brevo/email-notifier");
  return createBrevoEmailNotifier(env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("1. the request Brevo receives", () => {
  it("goes to the documented endpoint, with the key in a header only", async () => {
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[0].init.method).toBe("POST");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe(ENV.BREVO_API_KEY);
    // Never in the URL or the payload, where it would reach an access log.
    expect(calls[0].url).not.toContain(ENV.BREVO_API_KEY);
    expect(String(calls[0].init.body)).not.toContain(ENV.BREVO_API_KEY);
  });

  it("names the configured sender and exactly one recipient", async () => {
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);
    const payload = body(calls[0]);

    expect(payload.sender).toEqual({ email: ENV.BREVO_SENDER_EMAIL, name: ENV.BREVO_SENDER_NAME });
    // One recipient, the configured contact, and nobody copied in.
    expect(payload.to).toEqual([
      { email: "john@example.test", name: "John", contactPixelTrackingConsent: false },
    ]);
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("bcc");
  });

  it("declines tracking for the recipient, every time", async () => {
    /**
     * `contactPixelTrackingConsent: false` tells Brevo this recipient declined
     * tracking, and Brevo then tracks neither opens NOR clicks for the email.
     *
     * The clicks half is the one that matters here. Click tracking works by
     * rewriting links into individualized redirects - so with it on, the Reply
     * href stops being our capability URL and becomes a Brevo URL that
     * resolves to it, putting a live family token through their redirector and
     * into their click logs. CareLoop has no use for engagement data on these
     * messages, so the answer is always no.
     */
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);

    const recipients = body(calls[0]).to as Array<Record<string, unknown>>;
    expect(recipients).toHaveLength(1);
    expect(recipients[0].contactPixelTrackingConsent).toBe(false);
    // Not merely falsy: Brevo reads a boolean, and `undefined` would fall back
    // to the account's unknown-contact default rather than declining.
    expect(recipients[0].contactPixelTrackingConsent).not.toBeUndefined();
    expect(typeof recipients[0].contactPixelTrackingConsent).toBe("boolean");
  });

  it("nothing a caller supplies can turn tracking back on", async () => {
    // The Notifier port has no tracking field, and the adapter takes no
    // options - so there is no configuration path to `true`. A message that
    // tried to smuggle one in is ignored.
    const calls = stubFetch(ok());
    const smuggled = {
      ...MESSAGE,
      contactPixelTrackingConsent: true,
      tracking: true,
    } as unknown as NotifierMessage;
    await (await notifier()).send(smuggled);

    const payload = body(calls[0]);
    const recipients = payload.to as Array<Record<string, unknown>>;
    expect(recipients[0].contactPixelTrackingConsent).toBe(false);
    // And the smuggled keys reached nothing.
    expect(payload).not.toHaveProperty("tracking");
    expect(String(calls[0].init.body)).not.toContain('"contactPixelTrackingConsent":true');
  });

  it("the Reply href is still our own capability URL, unrewritten", async () => {
    // What we send. Whether Brevo honours it is a live-acceptance check
    // against the delivered email, not something code can assert.
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);
    const payload = body(calls[0]);

    expect(String(payload.htmlContent)).toContain(`href="${MESSAGE.responseUrl}"`);
    expect(String(payload.textContent)).toContain(MESSAGE.responseUrl);
    // No provider redirector in what we hand over.
    for (const host of ["brevo.com", "sendinblue.com", "sibautomation"]) {
      expect(String(calls[0].init.body), host).not.toContain(host);
    }
  });

  it("uses OUR request id as the idempotency key", async () => {
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);
    const headers = body(calls[0]).headers as Record<string, string>;

    // Brevo takes it inside the `headers` object, not as an HTTP header.
    expect(headers.idempotencyKey).toBe(MESSAGE.requestId);
  });

  it("the same request retried sends the same key, never a fresh one", async () => {
    const calls = stubFetch(ok());
    const brevo = await notifier();
    await brevo.send(MESSAGE);
    await brevo.send(MESSAGE);

    const keys = calls.map((call) => (body(call).headers as Record<string, string>).idempotencyKey);
    expect(keys).toEqual([MESSAGE.requestId, MESSAGE.requestId]);
  });

  it("carries the approved bytes unchanged, and the URL only as transport", async () => {
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);
    const payload = body(calls[0]);

    expect(String(payload.textContent)).toContain(BODY);
    expect(String(payload.htmlContent)).toContain(MESSAGE.responseUrl);
    expect(payload.subject).toBe("A message from John via CareLoop");
  });

  it("sends no transcript, payload metadata or analytics tags", async () => {
    const calls = stubFetch(ok());
    await (await notifier()).send(MESSAGE);
    const payload = body(calls[0]);

    expect(payload).not.toHaveProperty("tags");
    expect(payload).not.toHaveProperty("params");
    expect(payload).not.toHaveProperty("templateId");
    const raw = String(calls[0].init.body).toLowerCase();
    for (const leak of ["transcript", "sharepayload", "baseline", "opportunit", "cadence", "signal"]) {
      expect(raw, leak).not.toContain(leak);
    }
  });
});

describe("2. what comes back", () => {
  it("the provider message id becomes the delivery reference", async () => {
    stubFetch(ok("<abc123@smtp-relay.brevo.com>"));
    const delivery = await (await notifier()).send(MESSAGE);

    expect(delivery.channel).toBe("email");
    expect(delivery.reference).toBe("<abc123@smtp-relay.brevo.com>");
    expect(Number.isFinite(Date.parse(delivery.deliveredAt))).toBe(true);
  });

  it("a duplicate inside the idempotency window is an acceptance, not a failure", async () => {
    // Brevo answers a repeat of the same key with `duplicate_parameter` and
    // does not process it. Because the key IS our family_request id, that can
    // only mean our own earlier attempt was already accepted - and a retry
    // only happens when the first attempt failed AFTER acceptance. Reading it
    // as a failure would record a delivered message as undelivered and retry
    // forever.
    stubFetch(
      new Response(JSON.stringify({ code: "duplicate_parameter", message: "duplicate" }), {
        status: 400,
      }),
    );
    const delivery = await (await notifier()).send(MESSAGE);
    expect(delivery.channel).toBe("email");
    expect(delivery.reference).toContain(MESSAGE.requestId);
  });
});

describe("3. a failure says what went wrong and nothing more", () => {
  const cases = [
    ["4xx", new Response(JSON.stringify({ code: "invalid_parameter", message: "bad" }), { status: 400 })],
    ["401", new Response(JSON.stringify({ code: "unauthorized", message: "key" }), { status: 401 })],
    ["5xx", new Response("upstream exploded", { status: 503 })],
  ] as const;

  it.each(cases)("a %s throws a narrow transport error", async (_label, response) => {
    stubFetch(response);
    const brevo = await notifier();
    await expect(brevo.send(MESSAGE)).rejects.toMatchObject({ name: "FamilyEmailTransportError" });
  });

  it("a network error is sanitized the same way", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect((await notifier()).send(MESSAGE)).rejects.toMatchObject({
      name: "FamilyEmailTransportError",
    });
  });

  it("the error carries no key, token, body or address", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          code: "invalid_parameter",
          // A provider echoing our payload back is exactly how content ends up
          // in a stored delivery error.
          message: `rejected ${MESSAGE.address} for ${MESSAGE.responseUrl}: ${BODY}`,
        }),
        { status: 400 },
      ),
    );

    let thrown: Error | null = null;
    try {
      await (await notifier()).send(MESSAGE);
    } catch (error) {
      thrown = error as Error;
    }

    const text = `${thrown?.name}|${thrown?.message}|${JSON.stringify(thrown)}`;
    for (const secret of [ENV.BREVO_API_KEY!, MESSAGE.responseUrl, "TOKEN-abc", MESSAGE.address, BODY]) {
      expect(text, secret.slice(0, 20)).not.toContain(secret);
    }
    // It still says enough to act on.
    expect(thrown?.message).toContain("400");
  });

  it("nothing is printed to the console on a failure", async () => {
    stubFetch(new Response("boom", { status: 500 }));
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => { logged.push(String(line)); });
    const err = vi.spyOn(console, "error").mockImplementation((line) => { logged.push(String(line)); });

    await (await notifier()).send(MESSAGE).catch(() => undefined);
    log.mockRestore();
    err.mockRestore();

    const printed = logged.join("\n");
    for (const secret of [MESSAGE.responseUrl, BODY, MESSAGE.address, ENV.BREVO_API_KEY!]) {
      expect(printed, secret.slice(0, 20)).not.toContain(secret);
    }
  });
});

describe("4. it refuses to exist unconfigured", () => {
  it("a missing or blank setting fails closed, by name", async () => {
    const { createBrevoEmailNotifier, FamilyEmailNotConfiguredError } = await import(
      "@/server/adapters/brevo/email-notifier"
    );

    for (const key of ["BREVO_API_KEY", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME"] as const) {
      expect(() => createBrevoEmailNotifier({ ...ENV, [key]: undefined }), key).toThrow(
        FamilyEmailNotConfiguredError,
      );
      expect(() => createBrevoEmailNotifier({ ...ENV, [key]: "   " }), `${key} blank`).toThrow(
        FamilyEmailNotConfiguredError,
      );
    }
  });

  it("the configuration error names the variable and not its value", async () => {
    const { createBrevoEmailNotifier } = await import("@/server/adapters/brevo/email-notifier");
    try {
      createBrevoEmailNotifier({ ...ENV, BREVO_API_KEY: undefined });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toContain("BREVO_API_KEY");
      expect((error as Error).message).not.toContain(ENV.BREVO_SENDER_EMAIL!);
    }
  });
});

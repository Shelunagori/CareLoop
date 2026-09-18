/**
 * A LIVE SMOKE TEST against Cloudflare Workers AI.
 *
 *   npm run cloudflare:smoke
 *
 * Every mocked test in this repo proves that CareLoop handles the contract we
 * BELIEVE Cloudflare has. Only this proves the belief. It calls the real
 * production adapters - not a reimplementation of them - so what passes here
 * is what production does.
 *
 * The number that matters most is the raw embedding width. The 1024 this
 * codebase pads from comes from BGE-M3's model card, not from Cloudflare's own
 * documentation, and the whole zero-padding design rests on it. It is read
 * from the adapter's own log line, so it is observed rather than restated.
 *
 * It touches NO database, sends no email, and writes nothing. It spends a few
 * Workers AI neurons and nothing else.
 *
 * Nothing it prints contains a credential, a vector, or a model response.
 */
import { createCloudflareEmbeddings } from "@/server/adapters/cloudflare/embeddings";
import { createCloudflareLlm } from "@/server/adapters/cloudflare/llm";
import { createCloudflareExtraction } from "@/server/adapters/cloudflare/extraction";
import { createCloudflareFamilyRender } from "@/server/adapters/cloudflare/family-render";
import { EMBEDDING_STORAGE_DIMENSIONS } from "@/core/memory/embedding-dimensions";
import { EXTRACTION_V1_JSON_SCHEMA } from "@/core/memory/extraction-contract";
import { extractionPromptV1 } from "@/server/prompts/extraction.v1";
import { assembleContext, EMPTY_MEMORY } from "@/server/services/context";

/**
 * A message with anything credential-shaped removed.
 *
 * The adapters already scrub their own log lines; this covers errors that
 * arrive by other routes, such as a fetch rejection carrying the request URL.
 */
function sanitize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"']+/g, "[url]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * The adapters log one structured line per call. Captured rather than printed,
 * because those lines carry diagnostics this script has no reason to show -
 * and because the provider's observed dimension is only available there.
 */
const captured: Array<Record<string, unknown>> = [];
const realLog = console.log.bind(console);
console.log = (line: unknown) => {
  try {
    captured.push(JSON.parse(String(line)) as Record<string, unknown>);
  } catch {
    // Not one of ours.
  }
};
const say = (text: string) => realLog(text);

let failed = false;

async function check(label: string, run: () => Promise<string | null>): Promise<void> {
  try {
    const detail = await run();
    say(`${label}: PASS${detail ? ` ${detail}` : ""}`);
  } catch (error) {
    failed = true;
    say(`${label}: FAIL`);
    say(`  ${sanitize(error)}`);
  }
}

async function main(): Promise<void> {
  say("Cloudflare smoke test");
  say("");

  // 1. EMBEDDINGS — the highest-risk assumption in the migration.
  let rawDimension: unknown = null;
  let storedDimension: number | null = null;

  await check("embedding", async () => {
    const [vector] = await createCloudflareEmbeddings().embed([
      "John visited George with Simba.",
    ]);
    storedDimension = vector.length;
    rawDimension = captured.findLast((line) => line.event === "llm.embed")?.providerDimensions;

    if (storedDimension !== EMBEDDING_STORAGE_DIMENSIONS) {
      throw new Error(
        `Adapter returned ${storedDimension} dimensions, expected ${EMBEDDING_STORAGE_DIMENSIONS}.`,
      );
    }
    if (!vector.every(Number.isFinite)) throw new Error("Vector contains a non-finite value.");
    return null;
  });

  // Printed whatever the verdict: a mismatch is the single most useful fact
  // this script can produce, and it is worth seeing even on a FAIL.
  say(`raw dimension: ${rawDimension ?? "unknown"}`);
  say(`stored dimension: ${storedDimension ?? "unknown"}`);

  // 2. CHAT — transport only. Not a test of what the model says.
  await check("chat", async () => {
    const stream = await createCloudflareLlm().streamChat({
      promptRef: "smoke",
      messages: [{ role: "user", content: "Reply with the single word: ready." }],
    });
    let chars = 0;
    for await (const delta of stream) chars += delta.length;
    if (chars === 0) throw new Error("Stream produced no text.");
    return null;
  });

  // 3. EXTRACTION — the real production schema, through JSON mode.
  await check("extraction", async () => {
    const result = await createCloudflareExtraction().extract({
      promptRef: extractionPromptV1.ref,
      system: extractionPromptV1.system,
      user: "John visited George yesterday.",
      schemaName: extractionPromptV1.schemaName,
      jsonSchema: EXTRACTION_V1_JSON_SCHEMA,
    });
    if (result.raw === null || typeof result.raw !== "object") {
      throw new Error("Extraction did not return an object.");
    }
    return null;
  });

  // 4. FAMILY RENDER — synthetic payload, frozen prompt, unchanged.
  await check("family render", async () => {
    const result = await createCloudflareFamilyRender().render({
      promptRef: "smoke",
      payload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    });
    if (result.text.trim().length === 0) throw new Error("Rendered text was empty.");
    // A JSON envelope reaching the caller would mean the adapter handed back
    // Cloudflare's wrapper instead of the model's own output.
    if (result.text.trim().startsWith("{")) {
      throw new Error("Rendered text looks like a JSON envelope, not a sentence.");
    }
    return null;
  });

  // 5. GROUNDING — the real model, the real v4 prompt, the real awaiting
  //    state. A mocked test cannot prove this; only the model can.
  await check("grounding (no invented reply)", async () => {
    const context = assembleContext({
      recentTurns: [
        {
          id: "smoke",
          role: "user",
          content: "Have you heard from him at all?",
          createdAt: new Date().toISOString(),
        },
      ],
      memory: { ...EMPTY_MEMORY, awaitingFamilyReply: { entityName: "Alex", status: "awaiting_response" } },
    });

    const stream = await createCloudflareLlm().streamChat({
      promptRef: context.promptRef,
      messages: context.messages,
    });
    let reply = "";
    for await (const delta of stream) reply += delta;

    // A claim that a reply arrived, in any of the shapes the live bug took.
    const invented = [
      /\balex (has )?(replied|answered|responded|said|got in touch)/i,
      /\bhe (replied|answered|responded|said he|would love|is coming|'s coming)/i,
      /\bhe said\b/i,
      /looking forward to seeing you/i,
    ].filter((pattern) => pattern.test(reply));

    if (invented.length > 0) {
      // The reply is printed ONLY on failure, because seeing what it invented
      // is the entire diagnostic.
      say(`  model said: ${reply.trim().slice(0, 240)}`);
      throw new Error(`Model invented a family reply (${invented.length} pattern(s) matched).`);
    }
    return null;
  });

  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  say("smoke test: FAIL");
  say(`  ${sanitize(error)}`);
  process.exitCode = 1;
});

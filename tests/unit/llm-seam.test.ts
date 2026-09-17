import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  const abs = path.join(root, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(abs);
  return out;
}

describe("LLM chokepoint", () => {
  it("is imported only inside server/adapters/openai", () => {
    const offenders = [...sourceFiles("app"), ...sourceFiles("server"), ...sourceFiles("core")]
      .filter((file) => /from\s+["']openai["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file))
      .sort();

    // One file per capability, all behind the adapter boundary. Services,
    // routes and core never see the SDK.
    expect(offenders).toEqual([
      "server/adapters/openai/embeddings.ts",
      "server/adapters/openai/extraction.ts",
      // M4: the family renderer is a THIRD capability behind the same
      // boundary, with its own model setting and prompt version.
      "server/adapters/openai/family-render.ts",
      "server/adapters/openai/llm.ts",
      // M8: speech to text is a FOURTH capability behind the same boundary.
      // It returns a string and nothing else - no model decides anything on
      // this path, which is what keeps voice an input rather than a second
      // way into the system.
      "server/adapters/openai/transcription.ts",
    ]);
  });

  it("keeps every provider key server-side, voice included", () => {
    // M8 adds a second vendor. The rule is unchanged: a key may appear only in
    // an adapter, and never anywhere the browser could import.
    const keyed = [...sourceFiles("app"), ...sourceFiles("server"), ...sourceFiles("core")]
      .filter((file) => /ELEVENLABS_API_KEY/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file))
      .sort();

    expect(keyed).toEqual([
      "server/adapters/elevenlabs/voice.ts",
      // Reads whether it is configured; never its value.
      "server/config.ts",
    ]);

    // And nothing under app/ names it at all.
    const inApp = sourceFiles("app")
      .filter((file) => /ELEVENLABS/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(inApp).toEqual([]);
  });

  it("the voice routes reach providers through a service, like everything else", () => {
    // app/ -> server/services -> adapters. A route that constructed a provider
    // itself would put an SDK import one layer from the browser.
    for (const route of ["app/api/voice/transcribe/route.ts", "app/api/voice/speak/route.ts"]) {
      const source = readFileSync(path.join(root, route), "utf8");
      expect(source, route).toMatch(/from "@\/server\/services\//);
      expect(source, route).not.toMatch(/from "@\/server\/adapters\//);
    }
  });

  it("keeps the OpenAI key out of anything the browser could import", () => {
    const offenders = sourceFiles("app")
      .filter((file) => /OPENAI_API_KEY/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual([]);
  });

  it("never exposes a service-role or OpenAI key under NEXT_PUBLIC_", () => {
    const offenders = [...sourceFiles("app"), ...sourceFiles("server")]
      .filter((file) =>
        /NEXT_PUBLIC_[A-Z_]*(SERVICE_ROLE|OPENAI)/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual([]);
  });
});

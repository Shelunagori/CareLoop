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
  it("is the only place the OpenAI SDK is imported", () => {
    const offenders = [...sourceFiles("app"), ...sourceFiles("server"), ...sourceFiles("core")]
      .filter((file) => /from\s+["']openai["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual(["server/adapters/openai/llm.ts"]);
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

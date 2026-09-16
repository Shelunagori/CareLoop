import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Opt-in only: `npm run test:llm-contract`.
 * Requires OPENAI_API_KEY and network. Never part of `npm test`.
 */
export default defineConfig({
  resolve: { alias: { "@": root } },
  test: {
    environment: "node",
    include: ["tests/contract/**/*.test.ts"],
    testTimeout: 120_000,
  },
});

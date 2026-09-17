import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two projects, because the work is two kinds.
 *
 * Everything that has existed until now is pure Node: core functions, services
 * over fakes, and migrations against a real Postgres. The M7 interface tests
 * need a DOM, and giving the whole suite one would be slower and would let a
 * server-side test quietly start depending on `window`.
 */
export default defineConfig({
  resolve: { alias: { "@": root } },
  test: {
    projects: [
      {
        resolve: { alias: { "@": root } },
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          // Contract tests hit the real OpenAI API. Non-deterministic, slow and
          // costly tests in CI get muted, and a muted test is worse than no
          // test — so they run only via `npm run test:llm-contract`.
          exclude: ["tests/contract/**"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { "@": root } },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.tsx"],
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
    ],
  },
});

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
/**
 * The suite runs with NODE_ENV=test, which `publicBaseUrl` treats as a
 * DEPLOYMENT rather than local development - deliberately, because "not local
 * development" is the honest test, and a self-hosted production build is not
 * Vercel either. So the suite is configured the way a deployment is, with a
 * valid https base URL. A test run that inherited the localhost default would
 * be exercising a code path no deployment ever takes.
 *
 * Tests that care about the RULES pass their own env to the pure function and
 * ignore this.
 */
const DEPLOYMENT_ENV = { CARELOOP_PUBLIC_BASE_URL: "https://careloop.test" };

export default defineConfig({
  resolve: { alias: { "@": root } },
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "@": root,
            // See tests/stubs/server-only.ts.
            "server-only": path.join(root, "tests/stubs/server-only.ts"),
          },
        },
        test: {
          name: "node",
          environment: "node",
          env: DEPLOYMENT_ENV,
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
          env: DEPLOYMENT_ENV,
          include: ["tests/ui/**/*.test.tsx"],
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
    ],
  },
});

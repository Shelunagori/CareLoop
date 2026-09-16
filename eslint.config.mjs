import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Architectural dependency boundaries (docs/01-architecture.md §1.2).
 *
 *   app  →  server/services  →  repositories / adapters  →  core
 *
 * `core/` is the pure domain: baselines, detection, consent, safety guards,
 * share-payload minimization. It is the half of CareLoop that must be testable
 * with literal objects and no mocks, and swappable-model-proof. Enforcing that
 * with lint rather than discipline is what keeps it true past month one.
 */

const FORBID_IN_CORE = [
  {
    group: [
      "@/server", "@/server/*", "@/server/**",
      "@/app", "@/app/*", "@/app/**",
      "**/server", "**/server/*", "**/server/**",
      "**/app", "**/app/*", "**/app/**",
    ],
    message:
      "core/ must not import from server/ or app/. Dependency direction is app → server/services → repositories/adapters → core (docs/01 §1.2).",
  },
  {
    group: [
      "next", "next/*", "next/**",
      "react", "react/**", "react-dom", "react-dom/**",
      "@supabase/*", "@supabase/**",
      "openai", "openai/**",
      "server-only", "client-only",
    ],
    message:
      "core/ must stay pure: no framework, database, or network dependencies. Take data in, return data out (docs/01 §1.2).",
  },
];

const FORBID_IN_SERVER = [
  {
    group: ["@/app", "@/app/*", "@/app/**", "**/app/*", "**/app/**"],
    message:
      "server/ must not import from app/. The route layer depends on services, never the reverse (docs/01 §1.2).",
  },
];

const FORBID_IN_APP = [
  {
    group: [
      "@/server/repositories/*", "@/server/repositories/**",
      "@/server/adapters/*", "@/server/adapters/**",
      "**/server/repositories/**", "**/server/adapters/**",
    ],
    message:
      "app/ must go through server/services, not straight to repositories or adapters (docs/01 §1.2).",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    files: ["core/**/*.{ts,tsx,mts,cts}"],
    rules: {
      // Base rule off, TS-aware rule on: identical patterns, but the
      // typescript-eslint version also covers `import type`, which is just as
      // much a boundary violation as a value import.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: FORBID_IN_CORE },
      ],
    },
  },
  {
    files: ["server/**/*.{ts,tsx,mts,cts}"],
    rules: {
      // Base rule off, TS-aware rule on: identical patterns, but the
      // typescript-eslint version also covers `import type`, which is just as
      // much a boundary violation as a value import.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: FORBID_IN_SERVER },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx,mts,cts}"],
    rules: {
      // Base rule off, TS-aware rule on: identical patterns, but the
      // typescript-eslint version also covers `import type`, which is just as
      // much a boundary violation as a value import.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: FORBID_IN_APP },
      ],
    },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "server/db/types.generated.ts",
  ]),
]);

export default eslintConfig;

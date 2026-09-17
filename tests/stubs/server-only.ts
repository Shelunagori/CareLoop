/**
 * `server-only` under Vitest.
 *
 * The real package throws on import, which is exactly right for a bundler and
 * useless for a test runner: it would make the composition root unimportable
 * and leave "the app still boots without ElevenLabs credentials" as a claim
 * proved by grepping source. The directive itself is still asserted by source
 * in tests/unit/voice.test.ts, and Next's build is what actually enforces it.
 */
export {};

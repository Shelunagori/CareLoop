/**
 * The environment CareLoop reads.
 *
 * Next's generated types narrow `NodeJS.ProcessEnv` to the keys it knows
 * about, so a variable that is only ever read by application code has to be
 * declared somewhere or `process.env.X` is a type error. Declaring them here
 * also makes the full set of configuration one readable list.
 *
 * Every value is optional: each reader decides what a missing one means, and
 * for several of them the answer is "that feature is simply off".
 */
declare namespace NodeJS {
  interface ProcessEnv {
    // M8, text to speech. Optional: without these, CareLoop is fully usable
    // by typing AND by speaking; only reading replies aloud is unavailable.
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_VOICE_ID?: string;
    ELEVENLABS_MODEL_ID?: string;
    // M8, speech to text. Optional; the adapter pins a default.
    OPENAI_TRANSCRIPTION_MODEL?: string;
    // The language transcription expects. A demo/product-locale setting for
    // this English POC; it belongs on the profile eventually. Defaults to
    // "en" - automatic detection guesses badly on one-word utterances, and a
    // spoken "yes" once came back as a Chinese character.
    OPENAI_TRANSCRIPTION_LANGUAGE?: string;
    // Deployment. Where a family capability link points; required and
    // validated on a deployment, defaulted to localhost only in development.
    CARELOOP_PUBLIC_BASE_URL?: string;
    // Exactly "true" turns a deployment into a public anonymous demo.
    CARELOOP_DEMO_MODE?: string;
    // M11, production family delivery by email. Server-only, all three.
    /**
     * Cloudflare Workers AI. The account id and token are REQUIRED - the
     * active speech-to-text provider - and server-only; the model and
     * language have defaults.
     */
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_TRANSCRIPTION_MODEL?: string;
    CARELOOP_TRANSCRIPTION_LANGUAGE?: string;

    BREVO_API_KEY?: string;
    BREVO_SENDER_EMAIL?: string;
    BREVO_SENDER_NAME?: string;
  }
}

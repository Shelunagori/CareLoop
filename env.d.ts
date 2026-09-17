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
  }
}

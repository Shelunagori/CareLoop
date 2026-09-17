import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The hands-free experiment is gone, and stays gone.
 *
 * M9 built a wake word, a conversation-session machine and persistent local
 * microphone monitoring. Live testing proved none of it reliable enough to
 * demo, and the product decision was to go back to push-to-talk. The risk with
 * a decision like that is not the code that gets deleted — it is the code that
 * survives dormant because it still passes its tests, and quietly becomes
 * something nobody can explain a year later.
 *
 * So this file is a boundary rather than a behaviour: nothing shipped may
 * mention any of it. The general correctness fixes M9 *found* are kept, and
 * are asserted elsewhere by what they do.
 */
const SOURCE_DIRS = ["app", "core", "server", "scripts"];

/** Every term that belonged to the experiment and nothing else. */
const REMOVED = [
  "vosk",
  "picovoice",
  "porcupine",
  "WakeWordProvider",
  "wakePhrase",
  "wake diagnostics",
  "Start conversation",
  "End conversation",
  "Enable hands-free",
  "Disable hands-free",
  "handsfree",
  "HandsFree",
  "hands-free",
  "createSpeechTracker",
  "createSpeechOnsetDetector",
  "VOICE_COMPANION",
  "sessionIdleMs",
  "isEndSessionCommand",
  "stop listening",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|css)$/.test(path) ? [path] : [];
  });
}

const files = SOURCE_DIRS.flatMap(sourceFiles);

describe("no trace of the hands-free experiment ships", () => {
  it("finds source to check, so an empty scan cannot pass", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("app/_components/chat.tsx");
    expect(files).toContain("app/_components/voice.ts");
  });

  it.each(REMOVED)("no production file mentions %j", (term) => {
    const offenders = files.filter((file) =>
      readFileSync(file, "utf8").toLowerCase().includes(term.toLowerCase()),
    );
    expect(offenders).toEqual([]);
  });

  it("the deleted modules are actually deleted", () => {
    for (const gone of [
      "app/_components/wake.ts",
      "app/_components/handsfree.ts",
      "app/_components/meter.ts",
      "core/voice/handsfree-machine.ts",
      "core/voice/vad.ts",
      "core/voice/wake-match.ts",
      "core/voice/wake-gate.ts",
      "core/voice/companion.ts",
      "core/voice/end-session.ts",
      "scripts/fetch-wake-model.mjs",
    ]) {
      expect(files, gone).not.toContain(gone);
    }
  });

  it("no wake-word dependency remains", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const named = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    for (const banned of ["vosk-browser", "@picovoice/porcupine-web", "@picovoice/web-voice-processor"]) {
      expect(named, banned).not.toContain(banned);
    }
    // And no model to download.
    expect(Object.keys(manifest.scripts)).not.toContain("wake:model");

    const lock = readFileSync("package-lock.json", "utf8");
    for (const banned of ["vosk-browser", "picovoice"]) {
      expect(lock.includes(banned), `package-lock: ${banned}`).toBe(false);
    }
  });

  it("the microphone is only ever opened by a press", () => {
    // The whole privacy claim, in one grep: `getUserMedia` appears once, in
    // the recorder, reached only from the composer's microphone button.
    const voice = readFileSync("app/_components/voice.ts", "utf8");
    const opens = files.filter((file) => readFileSync(file, "utf8").includes("getUserMedia"));
    expect(opens).toEqual(["app/_components/voice.ts"]);
    expect(voice).toMatch(/export async function startRecording\(\s*options: RecordingOptions = \{\}/);
    // The options are a way to be TOLD the recording ended, never a way to
    // start one: nothing in them reaches getUserMedia.
    expect(voice).toMatch(/onLimitReached\?: \(\) => void/);
    // Nothing monitors, meters or analyses audio outside a recording.
    for (const forbidden of ["AudioContext", "createAnalyser", "ScriptProcessor", "setInterval"]) {
      expect(voice, forbidden).not.toContain(forbidden);
    }
  });
});

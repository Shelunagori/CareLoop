import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the wake word is allowed to be.
 *
 * THIS FILE REPLACES `voice-scope.test.ts`, WHICH SAID THE OPPOSITE. That
 * file was a boundary around a product decision — M9's hands-free experiment
 * was removed after live acceptance, and nothing of it might ship. M12
 * reverses part of that decision on purpose, so the boundary is re-aimed
 * rather than quietly deleted: a guard that gets removed in the same commit
 * as the feature it guarded against is not a guard.
 *
 * What changed, and what did not.
 *
 * M9 failed for three reasons: the detector fired inconsistently, the
 * SESSION recorded clips too short or too noisy to transcribe, and a
 * listening session that stayed open for a whole conversation was
 * unpredictable to reason about. Only the first of those is about a wake
 * word. The other two are the conversation-session machine and the VAD
 * around it — and those stay gone, permanently, asserted below by name.
 *
 * So M12's Nora is a wake word and nothing else: it opens one recording, on
 * the existing path, and re-arms. It is off by default, it expires on a
 * date, and the thing it replaces is a button press.
 */
const SOURCE_DIRS = ["app", "core", "server", "scripts"];

/**
 * Still gone, and not coming back. Every term here belonged to the part of
 * M9 that live testing actually disproved.
 */
const STILL_REMOVED = [
  "vosk",
  "Start conversation",
  "End conversation",
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
const read = (file: string) => readFileSync(file, "utf8");

describe("1. the scan is real", () => {
  it("finds source to check, so an empty scan cannot pass", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("app/_components/chat.tsx");
    expect(files).toContain("app/_components/voice.ts");
    expect(files).toContain("app/_components/nora.ts");
  });
});

describe("2. the session machine and the VAD stay deleted", () => {
  /**
   * "hands-free" itself is NOT on the list. The words came back — the
   * control is labelled "Nora hands-free", because that is what a person
   * calls not pressing a button. What did not come back is the machine
   * underneath it, and that is what the terms above name.
   */
  it.each(STILL_REMOVED)("no production file mentions %j", (term) => {
    const offenders = files.filter((file) => read(file).toLowerCase().includes(term.toLowerCase()));
    expect(offenders).toEqual([]);
  });

  it("the modules that held them are still absent", () => {
    for (const gone of [
      "app/_components/handsfree.ts",
      "app/_components/meter.ts",
      "core/voice/handsfree-machine.ts",
      "core/voice/vad.ts",
      "core/voice/companion.ts",
      "core/voice/end-session.ts",
    ]) {
      expect(files, gone).not.toContain(gone);
    }
  });

  it("audio is analysed in exactly one file, and only during a recording", () => {
    /**
     * NARROWED IN M12, and this is the honest version of what changed.
     *
     * M9 watched the microphone CONTINUOUSLY, to keep a conversation
     * session open. That is what was unreasonable and that is what stays
     * banned. M12 watches audio too — a wake turn has nobody to press Stop,
     * so something has to decide the turn is over — but only inside a
     * recording that a wake already opened, from one module, with one
     * teardown.
     *
     * So the rule is no longer "nothing analyses audio". It is "exactly one
     * file may, it may not open a microphone, and it cannot outlive the
     * recording that justified it".
     */
    const analysers = files.filter((file) =>
      ["AudioContext", "createAnalyser", "createMediaStreamSource"].some((api) =>
        new RegExp(`\\b${api}\\b`).test(read(file)),
      ),
    );
    expect(analysers).toEqual(["app/_components/endpoint.ts"]);

    // The recorder and the wake engine stay out of it entirely.
    for (const file of ["app/_components/voice.ts", "app/_components/nora.ts"]) {
      for (const forbidden of ["AudioContext", "createAnalyser", "ScriptProcessor", "setInterval"]) {
        expect(read(file), `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("3. the microphone still opens only on purpose", () => {
  it("getUserMedia is CALLED in exactly one file, the recorder", () => {
    /**
     * Asserted on call sites, not mentions: these files' own comments
     * explain that they do not open microphones, and a grep for the word
     * cannot tell an explanation from an action.
     *
     * The wake engine does not call it — the Picovoice audio processor
     * does, inside the package, reached from `startNora` and nowhere else.
     * The end-of-turn watcher does not call it either: it is handed a
     * stream the recorder already owns.
     */
    const callers = files.filter((file) => /getUserMedia\s*\(/.test(read(file)));
    expect(callers).toEqual(["app/_components/voice.ts"]);

    // nora.ts mentions it only as a capability check.
    expect(read("app/_components/nora.ts")).toContain("navigator?.mediaDevices?.getUserMedia");
    // And the watcher has no route to one at all.
    expect(read("app/_components/endpoint.ts")).not.toMatch(/getUserMedia\s*\(/);
    expect(read("app/_components/endpoint.ts")).not.toContain("mediaDevices");
  });

  it("the engine is imported dynamically, so an off deployment never loads it", () => {
    const nora = read("app/_components/nora.ts");
    expect(nora).toMatch(/await import\("@picovoice\/porcupine-web"\)/);
    expect(nora).toMatch(/await import\("@picovoice\/web-voice-processor"\)/);
    // No static import anywhere in the tree, or the bundle carries it.
    const staticImports = files.filter((file) =>
      /^\s*import[^\n]*from "@picovoice\//m.test(read(file)),
    );
    expect(staticImports).toEqual([]);
  });

  it("only the wake engine's own module reaches Picovoice at all", () => {
    const users = files.filter((file) => read(file).includes("@picovoice/"));
    expect(users).toEqual(["app/_components/nora.ts"]);
  });
});

describe("3a. the end-of-turn watcher cannot outlive its recording", () => {
  const endpoint = () => read("app/_components/endpoint.ts");

  it("is reached only from the recorder's own stream callback", () => {
    const importers = files.filter((file) => /from "\.\/endpoint"/.test(read(file)));
    expect(importers).toEqual(["app/_components/chat.tsx"]);
    // And started only on the wake path — a press must be unchanged.
    const chat = read("app/_components/chat.tsx");
    expect(chat).toMatch(/source === "wake"\s*\?\s*\(stream\)/);
  });

  it("has one guarded teardown, and does not stop the recorder's tracks", () => {
    expect(endoint_guard(endpoint())).toBe(true);
    // Two owners for one microphone is how a release gets skipped: the
    // recorder's single `finalize` is the only thing that stops tracks.
    expect(endpoint()).not.toMatch(/\.getTracks\s*\(/);
    expect(endpoint()).not.toMatch(/track\.stop/);
  });

  it("every Nora teardown path releases it", () => {
    const chat = read("app/_components/chat.tsx");
    // dropEndpointer is the single helper; these are the paths that must
    // call it or the thing it wraps.
    expect(chat).toContain("const dropEndpointer");
    for (const path of ["teardownNora", "cancelRecording", "finishRecording"]) {
      // Anchored on the declaration itself, so `teardownNoraRef` cannot
      // stand in for `teardownNora` and make this pass by accident.
      const start = chat.indexOf(`const ${path} = useCallback`);
      expect(start, `${path} declaration`).toBeGreaterThan(-1);
      expect(chat.slice(start, start + 1400), path).toContain("dropEndpointer()");
    }
    // Unmount, separately, because it runs when no callback can.
    expect(chat).toMatch(/endpointerRef\.current\?\.stop\(\);\s*\n\s*endpointerRef\.current = null;\s*\n\s*const session = noraRef\.current;/);
  });

  it("makes no claim to be more than it is", () => {
    const core = read("core/voice/endpoint.ts");
    expect(core).not.toMatch(/production[- ]grade/i);
    expect(core + endpoint()).toMatch(/silence detector/i);
  });
});

function endoint_guard(source: string): boolean {
  // One `stopped` flag, set before anything is released, so the teardown is
  // idempotent however many endings arrive.
  return /let stopped = false;/.test(source) && /if \(stopped\) return;\s*\n\s*stopped = true;/.test(source);
}

describe("4. one cutoff, in one place", () => {
  it("the date literal appears in exactly one source file", () => {
    const offenders = files.filter((file) => read(file).includes("2026-09-25"));
    expect(offenders).toEqual(["core/nora/config.ts"]);
  });

  it("nothing compares against the clock except the availability rule", () => {
    const offenders = files.filter(
      (file) => file !== "core/nora/availability.ts" && /availableUntil\s*[<>]/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("5. Nora is an input device, not a second brain", () => {
  it("imports nothing from the conversation, consent or memory layers", () => {
    /**
     * Asserted on IMPORTS rather than on words, because the words appear in
     * these files' own comments explaining that they do not do any of it.
     * What a module can reach is the real boundary; prose is a description
     * of one.
     */
    const noraModules = [
      "app/_components/nora.ts",
      "core/nora/availability.ts",
      "core/nora/config.ts",
    ];
    for (const file of noraModules) {
      const imports = [...read(file).matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(
          /^(\.\/|@\/core\/nora\/|@picovoice\/)/,
        );
      }
    }
  });

  it("calls no endpoint but its own status route", () => {
    const nora = read("app/_components/nora.ts");
    const fetched = [...nora.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    expect(fetched).toEqual(["/api/voice/nora/status"]);
  });

  it("the only server route it adds answers a question about time", () => {
    const routes = files.filter((file) => /^app\/api\/.*route\.ts$/.test(file) && file.includes("nora"));
    expect(routes).toEqual(["app/api/voice/nora/status/route.ts"]);
    const route = read(routes[0]);
    // No transcription, no generation, no writes.
    for (const forbidden of ["insert", "update", "transcribe", "llm", "Porcupine"]) {
      expect(route, forbidden).not.toContain(forbidden);
    }
  });

  it("no credential is ever logged or returned", () => {
    for (const file of files) {
      const body = read(file);
      if (!body.includes("PICOVOICE")) continue;
      // Every mention is a presence test or a value read at the one call
      // site that needs it. None of them is a log line.
      expect(body, file).not.toMatch(/console\.[a-z]+\([^)]*PICOVOICE/);
      expect(body, file).not.toMatch(/JSON\.stringify\([^)]*accessKey/);
    }
  });

  it("the conversation prompt still has no idea voice exists", () => {
    // Asserted in full by prompt-provenance.test.ts. Repeated here as the
    // scope claim it is: a wake word changes how words ARRIVE and nothing
    // about what a good answer is.
    const prompts = files.filter((file) => file.startsWith("server/prompts/"));
    expect(prompts.length).toBeGreaterThan(0);
    for (const file of prompts) {
      for (const leak of ["Nora", "wake", "microphone"]) {
        expect(read(file), `${file}: ${leak}`).not.toContain(leak);
      }
    }
  });
});

describe("6. the dependencies are the two the engine needs, and no more", () => {
  it("names exactly the Picovoice packages Nora uses", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    const named = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(named).toContain("@picovoice/porcupine-web");
    expect(named).toContain("@picovoice/web-voice-processor");
    // The engine M9 tried first, and abandoned.
    expect(named).not.toContain("vosk-browser");
    expect(readFileSync("package-lock.json", "utf8").includes("vosk-browser")).toBe(false);
  });

  it("adds no build step that has to reach the network", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    // M9 downloaded its model during the build. The parameter file is
    // committed instead: a build that can fail because a third-party host
    // is down is a build that fails on the day of the demo.
    expect(Object.keys(manifest.scripts)).not.toContain("wake:model");
    expect(Object.keys(manifest.scripts)).not.toContain("prebuild");
  });
});

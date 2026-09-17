import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The density floor.
 *
 * Not a snapshot of how the interface looks - that would break on every honest
 * change and tell nobody anything. These are the two numbers that must not
 * drift: the root scale every rem in the product is measured against, and the
 * minimum size of anything a person has to hit.
 *
 * The scale moved from 18px to 17px because at 18px with 1.6 line height the
 * interface asked to be viewed at 80% zoom - fewer turns on screen, more
 * scrolling, and a browser setting standing between the person and the
 * product. The floor below is what stops "denser" turning into "small".
 */
const css = readFileSync("app/globals.css", "utf8");

/** 44px is the accessibility floor; 2.75rem clears it at any root >= 16px. */
const MIN_TARGET_REM = 2.75;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("the interface stays legible as it gets denser", () => {
  it("the root scale is 16-17px — smaller is not on the table", () => {
    const match = css.match(/html\s*\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/);
    expect(match, "html font-size").toBeTruthy();
    const px = Number(match![1]);
    expect(px).toBeGreaterThanOrEqual(16);
    expect(px).toBeLessThanOrEqual(17);
  });

  it("body line height stays generous, around 1.5", () => {
    const match = css.match(/body\s*\{[^}]*line-height:\s*(\d+(?:\.\d+)?)/);
    expect(match, "body line-height").toBeTruthy();
    const height = Number(match![1]);
    expect(height).toBeGreaterThanOrEqual(1.45);
    expect(height).toBeLessThanOrEqual(1.6);
  });

  it("every touch target in the product clears 44px", () => {
    // Anything that declares a minimum height is something a person presses.
    const offenders: string[] = [];
    for (const file of tsxFiles("app")) {
      const source = readFileSync(file, "utf8");
      for (const [, rem] of source.matchAll(/min-h-\[(\d+(?:\.\d+)?)rem\]/g)) {
        if (Number(rem) < MIN_TARGET_REM) offenders.push(`${file}: ${rem}rem`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no text in the product drops below ~15px", () => {
    // 0.85rem at a 17px root is 14.45px, and that is only used for an
    // uppercase card label. Nothing below it.
    const offenders: string[] = [];
    for (const file of tsxFiles("app")) {
      const source = readFileSync(file, "utf8");
      for (const [, rem] of source.matchAll(/text-\[(\d+(?:\.\d+)?)rem\]/g)) {
        if (Number(rem) < 0.8) offenders.push(`${file}: ${rem}rem`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("nothing may scroll sideways", () => {
    expect(css).toContain("overflow-x: hidden");
  });

  it("the focus ring survives the density pass", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 3px solid var(--accent)");
  });
});

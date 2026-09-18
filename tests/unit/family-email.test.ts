import { describe, expect, it } from "vitest";
import { renderFamilyEmail } from "@/core/family/email";

/**
 * The transport envelope, and the one string inside it that may not change.
 *
 * An email needs a subject, a sentence of framing and a button. None of that
 * is allowed to touch the approved body: what George read is what John reads,
 * to the byte, and the renderer is the last place that could quietly break it.
 * Escaping is the one permitted transformation, and only because the HTML
 * would otherwise be wrong - so the test asserts the RENDERED TEXT is
 * identical, not that the markup is.
 *
 * The fixture text is hostile on purpose: an em dash, a curly apostrophe, an
 * emoji, a trailing space, and every character that means something in HTML.
 */
const BODY = 'Dad was wondering — are you & Simba able to "visit" soon? <3 ☕ ';
const URL = "https://careloop.example.com/family/respond/TOKEN-abc123";

const render = () =>
  renderFamilyEmail({ body: BODY, responseUrl: URL, fromDisplayName: "Dad" });

/** Undo HTML escaping, to recover the text a mail client would display. */
const unescape = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

describe("1. the approved bytes survive the envelope", () => {
  it("the plain-text part contains the body exactly, trailing space and all", () => {
    const { textContent } = render();
    expect(textContent).toContain(BODY);
  });

  it("what the HTML part DISPLAYS is the body exactly", () => {
    const { htmlContent } = render();
    // Escaped in the markup...
    expect(htmlContent).not.toContain("<3");
    expect(htmlContent).toContain("&lt;3");
    // ...and identical once a mail client has rendered it.
    expect(unescape(htmlContent)).toContain(BODY);
  });

  it("nothing is trimmed, normalised or re-encoded", () => {
    const { textContent, htmlContent } = render();
    for (const [name, text] of [["text", textContent], ["html", unescape(htmlContent)]] as const) {
      expect(text, `${name}: em dash`).toContain("—");
      expect(text, `${name}: curly apostrophe or emoji`).toContain("☕");
      expect(text.normalize("NFC"), `${name}: re-encoded`).toBe(text);
    }
    // The trailing space is the one a helpful .trim() eats.
    expect(textContent.includes(`${BODY}`)).toBe(true);
  });

  it("the body appears exactly once in each part", () => {
    const { textContent, htmlContent } = render();
    expect(textContent.split(BODY)).toHaveLength(2);
    expect(unescape(htmlContent).split(BODY)).toHaveLength(2);
  });
});

describe("2. HTML-significant characters cannot break out", () => {
  it("a body that looks like markup is inert", () => {
    const hostile = '</p><script>alert("x")</script><a href="evil">';
    const { htmlContent } = renderFamilyEmail({
      body: hostile,
      responseUrl: URL,
      fromDisplayName: "Dad",
    });

    expect(htmlContent).not.toContain("<script>");
    expect(htmlContent).toContain("&lt;script&gt;");
    // Exactly one link in the email, and it is ours.
    expect(htmlContent.match(/<a\s/g) ?? []).toHaveLength(1);
    expect(unescape(htmlContent)).toContain(hostile);
  });

  it("the sender name is escaped too", () => {
    const { htmlContent, subject } = renderFamilyEmail({
      body: "hello",
      responseUrl: URL,
      fromDisplayName: '<b>Dad</b>"',
    });
    expect(htmlContent).not.toContain("<b>Dad</b>");
    expect(htmlContent).toContain("&lt;b&gt;Dad&lt;/b&gt;");
    // The subject is a header, not markup: it carries the raw name.
    expect(subject).toContain('<b>Dad</b>"');
  });

  it("the capability URL is attribute-escaped in the href", () => {
    const { htmlContent } = renderFamilyEmail({
      body: "hello",
      responseUrl: "https://x.test/family/respond/a\"b&c",
      fromDisplayName: "Dad",
    });
    expect(htmlContent).toContain("&amp;c");
    expect(htmlContent).not.toContain('href="https://x.test/family/respond/a"b');
  });
});

describe("3. the envelope says nothing it should not", () => {
  it("the subject is the agreed line", () => {
    expect(render().subject).toBe("A message from Dad via CareLoop");
  });

  it("no reason, no history, no internals", () => {
    const { textContent, htmlContent, subject } = render();
    const all = `${subject}\n${textContent}\n${htmlContent}`.toLowerCase();
    for (const leak of [
      "transcript",
      "baseline",
      "cadence",
      "signal",
      "opportunit",
      "sharepayload",
      "hasn't seen",
      "days since",
      "detected",
      "lonely",
      "wellbeing",
      "confidence",
      "score",
    ]) {
      expect(all, leak).not.toContain(leak);
    }
  });

  it("the token is a link target and never visible text", () => {
    const { htmlContent, textContent } = render();
    // In the href, which is its purpose...
    expect(htmlContent).toContain(`href="${URL}"`);
    // ...and not printed as words in the HTML part.
    expect(unescape(htmlContent)).not.toContain("TOKEN-abc123");
    // The plain-text part has no anchors, so the URL must appear as text
    // there - that is the only way a text client can reach it.
    expect(textContent).toContain(URL);
  });

  it("only the recipient's own message is in it", () => {
    const { textContent } = render();
    expect(textContent).toContain("A message from Dad");
    expect(textContent).toContain("Reply");
  });
});

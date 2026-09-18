/**
 * The email an approved family message travels in.
 *
 * PURE, and in core/ rather than in the adapter, for one reason: this is where
 * the exact-text invariant meets a transport, and the invariant is a product
 * rule rather than a Brevo detail. A renderer that lived inside the provider
 * adapter would be tested through a mocked HTTP boundary; here it is tested
 * directly, character by character.
 *
 * WHAT THIS MAY DO: add a subject, a line of framing, and a link. Escaping,
 * because otherwise the markup would be wrong.
 *
 * WHAT IT MAY NOT DO: rewrite, summarise, paraphrase, translate, trim,
 * normalise or regenerate the body. `body` arrives as the bytes George read
 * and approved, and leaves as the same bytes. There is no model here and
 * nothing that could produce a sentence rather than carry one.
 */
export type FamilyEmail = {
  subject: string;
  htmlContent: string;
  textContent: string;
};

/**
 * Escaped for TEXT and ATTRIBUTE contexts both.
 *
 * `"` and `'` matter because the capability URL and the sender's name are
 * interpolated into attributes; a quote that survived would end the attribute
 * early and put the rest of the token into the markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Newlines become <br>, and nothing else about the body changes.
 *
 * Escaping happens FIRST, so a body containing "<br>" is displayed as those
 * characters rather than becoming a line break: the person approved text, not
 * markup.
 */
function bodyToHtml(body: string): string {
  return escapeHtml(body).replace(/\r?\n/g, "<br />");
}

export function renderFamilyEmail(input: {
  /** EXACTLY the approved bytes. Never touched. */
  body: string;
  /** The capability URL. Belongs in an href, never in visible text. */
  responseUrl: string;
  fromDisplayName: string;
}): FamilyEmail {
  const { body, responseUrl, fromDisplayName } = input;

  // A header, not markup: mail clients encode this themselves, and escaping it
  // here would put "&amp;" in somebody's inbox.
  const subject = `A message from ${fromDisplayName} via CareLoop`;

  const from = escapeHtml(fromDisplayName);
  const href = escapeHtml(responseUrl);

  const htmlContent = [
    '<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:17px;line-height:1.5;color:#1f1b16;max-width:32rem;margin:0 auto;padding:24px">',
    `<p style="color:#5d564d;margin:0 0 16px">A message from <strong style="color:#1f1b16">${from}</strong></p>`,
    `<div style="background:#f4f1ec;border-radius:12px;padding:16px;margin:0 0 24px">${bodyToHtml(body)}</div>`,
    `<a href="${href}" style="display:inline-block;background:#3f6b57;color:#ffffff;text-decoration:none;border-radius:12px;padding:12px 20px;font-weight:500">Reply</a>`,
    '<p style="color:#5d564d;font-size:15px;margin:24px 0 0">Sent through CareLoop, which helps older adults stay in touch with their family.</p>',
    "</div>",
  ].join("");

  // The text part must carry the URL as text: a text client has no anchor to
  // follow. Transport copy surrounds the body; the body itself is untouched.
  const textContent = [
    `A message from ${fromDisplayName}`,
    "",
    body,
    "",
    "Reply:",
    responseUrl,
    "",
    "Sent through CareLoop, which helps older adults stay in touch with their family.",
  ].join("\n");

  return { subject, htmlContent, textContent };
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WHICH transport a deployment uses, and where it addresses.
 *
 * The audit's P0 lived here: `createFamilySendDeps()` wired
 * `createDevNotifier()` for every environment, and that notifier refuses to be
 * constructed outside local development. On Vercel the throw happened while
 * EVALUATING the argument - so `sendApprovedOpportunity` never ran, no
 * family_request row was created, nothing retried, and the same throw one line
 * below silently disabled the expiry sweep. George would have approved a
 * message that could never be sent, and been told it was on its way.
 *
 * Read from source because the claim is about COMPOSITION - which constructor
 * runs in which environment - and the environments cannot all be instantiated
 * in one test process. The behaviour of each piece is tested where it lives.
 */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const deps = code("server/services/deps.ts");

describe("1. the choice is explicit, and fails closed", () => {
  it("local development gets the dev notifier, a demo gets email", () => {
    const chooser = deps.slice(deps.indexOf("function chooseNotifier"));
    const body = chooser.slice(0, chooser.indexOf("\n}"));

    expect(body).toContain("isDebugSurfaceEnabled");
    expect(body).toContain("createDevNotifier");
    expect(body).toContain("isDemoModeEnabled");
    expect(body).toContain("createBrevoEmailNotifier");
    // Development is checked FIRST, so a local machine never calls a provider
    // even if the demo flag happened to be set in .env.local.
    expect(body.indexOf("isDebugSurfaceEnabled")).toBeLessThan(body.indexOf("isDemoModeEnabled"));
  });

  it("anything else throws a named configuration error", () => {
    expect(deps).toContain("NotifierNotConfiguredError");
    const chooser = deps.slice(deps.indexOf("function chooseNotifier"));
    expect(chooser.slice(0, chooser.indexOf("\n}"))).toContain("throw new NotifierNotConfiguredError()");
  });

  it("there is no fallback from email to the dev notifier", () => {
    // A deployment that cannot send email must stop, not quietly write into
    // an in-process Map that nobody can read.
    const chooser = deps.slice(deps.indexOf("function chooseNotifier"), deps.indexOf("function chooseContactResolver"));
    expect((chooser.match(/createDevNotifier/g) ?? [])).toHaveLength(1);
    expect(chooser).not.toContain("catch");
  });

  it("the dev notifier still refuses to exist on a deployment", async () => {
    const { createDevNotifier, NotifierUnavailableError } = await import(
      "@/server/adapters/notifier"
    );
    const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;
    expect(() => createDevNotifier(env({ NODE_ENV: "production" }))).toThrow(NotifierUnavailableError);
    expect(() => createDevNotifier(env({ NODE_ENV: "development", VERCEL: "1" }))).toThrow(
      NotifierUnavailableError,
    );
    // And demo mode cannot open it.
    expect(() =>
      createDevNotifier(env({ NODE_ENV: "production", CARELOOP_DEMO_MODE: "true" })),
    ).toThrow(NotifierUnavailableError);
  });

  it("the development inbox is not reachable from a production path", () => {
    // readDevInbox stays behind the dev-only service and its loopback page.
    for (const file of ["server/services/deps.ts", "app/_actions/demo-session.ts", "app/page.tsx"]) {
      expect(code(file), file).not.toContain("readDevInbox");
      expect(code(file), file).not.toContain("readNotifierInbox");
    }
  });
});

describe("1b. and the send deps actually use that choice", () => {
  it("createFamilySendDeps calls the chooser rather than a constructor", () => {
    // Testing `chooseNotifier`'s body proves nothing if the deps ignore it.
    // This is the mutation that survived the first round: putting
    // `createDevNotifier()` straight back into the deps.
    const factory = deps.slice(deps.indexOf("export function createFamilySendDeps"));
    const body = factory.slice(0, factory.indexOf("\n}"));

    expect(body).toContain("notifier: chooseNotifier()");
    expect(body).toContain("resolveContact: chooseContactResolver(db)");
    expect(body, "a transport constructor is called directly").not.toContain("createDevNotifier(");
    expect(body).not.toContain("createBrevoEmailNotifier(");
  });

  it("each transport constructor is reached from exactly one place", () => {
    // Both appear once in the chooser and nowhere else, so there is no second
    // path into a transport that skips the gate.
    for (const constructor of ["createDevNotifier(", "createBrevoEmailNotifier("]) {
      expect((deps.match(new RegExp(constructor.replace("(", "\\("), "g")) ?? []), constructor)
        .toHaveLength(1);
    }
  });
});

describe("2. addressing belongs to composition, not to the send", () => {
  it("the send asks for a contact and does not know how one is found", () => {
    const send = code("server/services/family-send.ts");
    expect(send).toContain("deps.resolveContact(");
    // The fabricated dev address is gone from the service entirely.
    expect(send).not.toContain("dev-inbox:");
    expect(send).not.toContain("devChannel");
    expect(send).not.toContain("familyContacts.ensure");
  });

  it("production requires an email contact and never invents one", () => {
    const resolver = deps.slice(deps.indexOf("function chooseContactResolver"));
    const body = resolver.slice(0, resolver.indexOf("\n}\n"));

    expect(body).toContain("isDebugSurfaceEnabled");
    // Development ensures its own row...
    expect(body).toContain("contacts.ensure");
    // ...production only LOOKS, on a named channel.
    expect(body).toContain("findForEntityAndChannel");
    expect(body).toContain("familyConfig.emailChannel");
    // The digest address appears once, in the development branch.
    expect((body.match(/dev-inbox:/g) ?? [])).toHaveLength(1);
  });

  it("a missing contact stops before consent is spent", () => {
    const send = code("server/services/family-send.ts");
    const create = send.slice(send.indexOf("export async function createAuthorizedRequest"));

    const resolve = create.indexOf("deps.resolveContact(");
    const refuse = create.indexOf('outcome: "contact_not_configured"');
    const transaction = create.indexOf("create_authorized_family_request");

    expect(resolve).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(resolve);
    // The refusal is ABOVE the transaction that consumes the grant, so a
    // reviewer who has not configured an address keeps their offer.
    expect(refuse).toBeLessThan(transaction);
  });

  it("the channel is always named, never inferred from 'the first contact'", () => {
    const send = code("server/services/family-send.ts");
    // findForEntity returns whichever row is oldest - ambiguous the moment a
    // user can have both a dev and an email contact.
    expect(send).not.toContain("findForEntity(");
  });
});

describe("3. the demo's own wiring", () => {
  const action = code("app/_actions/demo-session.ts");

  it("John is derived, never a display name", () => {
    // The mutation this closes: returning the string "John" from the id
    // helper. A name is a label people reuse; binding a transport address to
    // one is how a reviewer's message reaches somebody else's contact.
    const helper = action.slice(action.indexOf("function johnEntityId"));
    const body = helper.slice(0, helper.indexOf("\n}"));

    expect(body).toContain("fixtureUuid(DEMO_GEORGE.id, userId,");
    expect(body).toContain('"entity/john"');
    expect(body, "the id helper returns a literal").not.toMatch(/return\s+"/);

    // The only use of the literal "John" is the contact's display name, which
    // is a label FOR the row, never how it is found.
    const lookups = action.match(/findForEntityAndChannel\([^)]*\)/g) ?? [];
    for (const lookup of lookups) expect(lookup).not.toContain('"John"');
  });

  it("the restart reads the address before the reset and restores it after", () => {
    // The mutation this closes: dropping the re-save. The SQL test proves the
    // cascade deletes the contact; this proves the action puts it back.
    const reset = action.slice(action.indexOf("export async function resetDemoSessionAction"));

    const read = reset.indexOf("readDemoContactAddress(userId)");
    const wipe = reset.indexOf("resetDemoFixture");
    const seed = reset.indexOf("seedDemoFixture");
    const save = reset.indexOf("saveDemoEmail(userId, email)");

    for (const [name, index] of [["read", read], ["reset", wipe], ["seed", seed], ["save", save]] as const) {
      expect(index, `${name} is missing from the restart`).toBeGreaterThan(-1);
    }
    // Read first - the reset cascades the contact away with the entity.
    expect(read).toBeLessThan(wipe);
    // Re-bound only after the new entity exists.
    expect(save).toBeGreaterThan(seed);
  });

  it("the address is written for the caller's own user id only", () => {
    const save = action.slice(action.indexOf("async function saveDemoEmail"));
    const body = save.slice(0, save.indexOf("\n}"));

    expect(body).toContain("entityId: johnEntityId(userId)");
    expect(body).toContain("channel: familyConfig.emailChannel");
    // No caller-supplied id anywhere near it.
    expect(action).not.toContain("formData.get(\"userId\")");
  });
});

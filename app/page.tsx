import { Chat, type ChatMessage } from "@/app/_components/chat";
import {
  configureDemoContactAction,
  readDemoContactAddress,
  resetDemoSessionAction,
  startDemoAction,
} from "@/app/_actions/demo-session";
import {
  DemoContactSetup,
  DemoRestartButton,
  StartDemo,
} from "@/app/_components/demo-start";
import { resetDemoAction } from "@/app/_actions/demo";
import { DemoResetControl, FamilyInboxLink } from "@/app/_components/dev-operator";
import { getCurrentIdentity } from "@/server/auth/current-user";
import { operatorAccessAllowed } from "@/server/auth/operator-access";
import { isDebugSurfaceEnabled, isDemoModeEnabled } from "@/server/config";
import { loadConversationView } from "@/server/services/conversation";
import { loadOpeningLine } from "@/server/services/opening";
import { createOpeningDeps, createConversationDataDeps } from "@/server/services/deps";

export const dynamic = "force-dynamic";

export default async function Page() {
  const identity = await getCurrentIdentity();
  const userId = identity.userId;
  // Decided on the SERVER, once. The browser is never told whether a demo
  // exists; it is simply shown one or not.
  const demoMode = isDemoModeEnabled(process.env);

  // A public demo with nobody signed in: offer the door, do not open it.
  // Creating the account here would mean every crawler and link preview mints
  // a Supabase user.
  if (!userId && demoMode) return <StartDemo action={startDemoAction} />;

  if (!userId) {
    /**
     * THE ONE DEVELOPER SCREEN THAT WAS NOT GATED (M12e).
     *
     * This page printed an environment-variable name, a local config file
     * name and Supabase dashboard instructions to ANY visitor with no
     * session — including, on a deployment running without
     * `CARELOOP_DEMO_MODE`, the public. Every other development affordance
     * in this application sits behind `isDebugSurfaceEnabled`; this one was
     * behind `!userId`, which is not the same condition and never was.
     *
     * The setup instructions are worth keeping — they are how a developer
     * finds out what is wrong — so they are gated rather than deleted, and
     * `isDebugSurfaceEnabled` is decided on the SERVER, so the strings do
     * not reach a production bundle at all.
     */
    const setupHint = isDebugSurfaceEnabled(process.env);
    return (
      <main className="mx-auto max-w-xl space-y-3 px-6 py-10">
        <h1 className="text-[1.7rem] font-semibold tracking-tight">CareLoop</h1>
        <p className="text-[var(--color-muted)]">
          {setupHint
            ? "No signed-in companion user. Sign-in arrives in a later milestone."
            : "Please sign in to continue."}
        </p>
        {setupHint && (
          <p className="text-[0.9rem] text-[var(--color-muted)]">
            For local development, create a user in the Supabase dashboard
            (Authentication → Users → Add user) and set its UUID as{" "}
            <code className="rounded bg-[var(--color-surface-muted)] px-1">
              CARELOOP_DEV_USER_ID
            </code>{" "}
            in your local environment file.
          </p>
        )}
      </main>
    );
  }

  // A demo reviewer must say where John's message goes before the loop can
  // close. Asked once, before the conversation, and never inside it.
  if (demoMode && identity.isAnonymous && (await readDemoContactAddress(userId)) === null) {
    return <DemoContactSetup action={configureDemoContactAction} />;
  }

  const view = await loadConversationView(createConversationDataDeps(), userId);

  /**
   * ONE BOUNDED PROACTIVE OPENING (M12d).
   *
   * Decided here, on the server, from stored events the person themselves
   * reported. `null` whenever there is nothing genuinely useful to open
   * with, which is most of the time and is the correct answer — a greeting
   * manufactured to look proactive is worse than no greeting.
   */
  const openingLine = await loadOpeningLine(createOpeningDeps(), {
    userId,
    conversationId: view.conversationId,
  });

  const initialMessages: ChatMessage[] = view.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      id: message.id,
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));

  /**
   * THE DEMO CONTROLS, BACK ON THE PAGE — AND PROPERLY GATED (M12f).
   *
   * M12e.3 moved them to `/dev` because "Reset demo — development only"
   * and "Family inbox (dev)" read as scaffolding in a recording. The
   * controls were not the problem; the LABELS were. A reviewer driving the
   * demo needs both of these within reach of the conversation, so they are
   * back, as **Family view** and **Reset demo** — no "(dev)", no
   * "development only", nothing that says this is a workbench.
   *
   * What changed underneath is the gate. This page previously checked only
   * `isDebugSurfaceEnabled`; it now uses the SAME four conditions as
   * `/dev` and `/dev/family-inbox`, from one shared function — local
   * development, not a deployment, a configured dev seed secret, and a
   * loopback host. The wording got friendlier and the authorization got
   * stricter, which is the right direction for both.
   *
   * Decided on the SERVER. These are server components rendered into a
   * slot, so on a deployment neither the controls nor their words exist at
   * all — a build-output scan checks that rather than trusting it.
   *
   * `/dev` is untouched and remains the operator page.
   */
  const operator = await operatorAccessAllowed();
  /**
   * Product UI, and a different question: a public-demo visitor may start
   * their OWN demo over. Authorized by owning the anonymous session rather
   * than by a dev secret, so it is offered on deployments too.
   */
  const canRestartDemo = demoMode && identity.isAnonymous;

  return (
    <Chat
      openingLine={openingLine}
      initialConversationId={view.conversationId}
      initialMessages={initialMessages}
      initialPendingOffer={view.pendingOffer}
      displayName={view.displayName}
      devTools={
        operator ? (
          <div className="flex items-start gap-2">
            <FamilyInboxLink label="Family view" />
            <DemoResetControl action={resetDemoAction} />
          </div>
        ) : canRestartDemo ? (
          <DemoRestartButton action={resetDemoSessionAction} />
        ) : null
      }
    />
  );
}

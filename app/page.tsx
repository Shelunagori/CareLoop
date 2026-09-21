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
import { getCurrentIdentity } from "@/server/auth/current-user";
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
   * NO DEVELOPER CONTROLS ON THIS PAGE, IN ANY ENVIRONMENT (M12e.3).
   *
   * "Reset demo — development only" and "Family inbox (dev)" used to render
   * in the chat header behind `isDebugSurfaceEnabled`. That was correctly
   * gated and still wrong: this is the surface a reviewer records, and
   * scaffolding in shot is scaffolding in shot whether or not it ships to
   * production. Marking a control "(dev)" explains it without removing it.
   *
   * Both controls, and the demo hint, now live on `/dev` behind the same
   * four-condition gate `/dev/family-inbox` uses. Nothing was loosened and
   * no new way in was invented — the controls simply moved to the door they
   * already belonged behind.
   *
   * What is left in this slot is product UI: a public-demo visitor may
   * start their OWN demo over. It says nothing about development, and it is
   * authorized by owning the anonymous session rather than by a dev secret.
   */
  const canRestartDemo = demoMode && identity.isAnonymous;

  return (
    <Chat
      openingLine={openingLine}
      initialConversationId={view.conversationId}
      initialMessages={initialMessages}
      initialPendingOffer={view.pendingOffer}
      displayName={view.displayName}
      devTools={canRestartDemo ? <DemoRestartButton action={resetDemoSessionAction} /> : null}
    />
  );
}

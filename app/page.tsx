import { Chat, type ChatMessage } from "@/app/_components/chat";
import { DemoResetButton } from "@/app/_components/dev-tools";
import { DemoHint } from "@/app/_components/dev-hint";
import { FamilyInboxLink } from "@/app/_components/dev-operator";
import { resetDemoAction } from "@/app/_actions/demo";
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
    return (
      <main className="mx-auto max-w-xl space-y-3 px-6 py-10">
        <h1 className="text-[1.7rem] font-semibold tracking-tight">CareLoop</h1>
        <p className="text-[var(--color-muted)]">
          No signed-in companion user. Sign-in arrives in a later milestone.
        </p>
        <p className="text-[0.9rem] text-[var(--color-muted)]">
          For local development, create a user in the Supabase dashboard
          (Authentication → Users → Add user) and set its UUID as{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">
            CARELOOP_DEV_USER_ID
          </code>{" "}
          in <code className="rounded bg-[var(--color-surface-muted)] px-1">.env.local</code>.
        </p>
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

  // Development only, and decided on the SERVER. In production neither the
  // control nor the hint is rendered, and neither reaches the client bundle.
  const isDev = isDebugSurfaceEnabled(process.env);
  // A reviewer may restart their OWN demo. Distinct from the developer reset
  // above in wording and in authorization, and offered only to the anonymous
  // account that owns the data it would restore.
  const canRestartDemo = demoMode && identity.isAnonymous;

  return (
    <Chat
      openingLine={openingLine}
      initialConversationId={view.conversationId}
      initialMessages={initialMessages}
      initialPendingOffer={view.pendingOffer}
      displayName={view.displayName}
      devTools={
        isDev ? (
          <div className="flex items-start gap-2">
            <FamilyInboxLink />
            <DemoResetButton action={resetDemoAction} />
          </div>
        ) : canRestartDemo ? (
          <DemoRestartButton action={resetDemoSessionAction} />
        ) : null
      }
      demoHint={isDev ? <DemoHint /> : null}
    />
  );
}

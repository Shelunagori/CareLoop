import { Chat, type ChatMessage } from "@/app/_components/chat";
import { DemoResetButton } from "@/app/_components/dev-tools";
import { DemoHint } from "@/app/_components/dev-hint";
import { FamilyInboxLink } from "@/app/_components/dev-operator";
import { resetDemoAction } from "@/app/_actions/demo";
import { getCurrentUserId } from "@/server/auth/current-user";
import { isDebugSurfaceEnabled } from "@/server/config";
import { loadConversationView } from "@/server/services/conversation";
import { createConversationDataDeps } from "@/server/services/deps";

export const dynamic = "force-dynamic";

export default async function Page() {
  const userId = await getCurrentUserId();

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

  const view = await loadConversationView(createConversationDataDeps(), userId);

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

  return (
    <Chat
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
        ) : null
      }
      demoHint={isDev ? <DemoHint /> : null}
    />
  );
}

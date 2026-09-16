import { Chat, type ChatMessage } from "@/app/_components/chat";
import { getCurrentUserId } from "@/server/auth/current-user";
import { loadConversationView } from "@/server/services/conversation";
import { createConversationDataDeps } from "@/server/services/deps";

export const dynamic = "force-dynamic";

export default async function Page() {
  const userId = await getCurrentUserId();

  if (!userId) {
    return (
      <main className="mx-auto max-w-xl space-y-3 p-8">
        <h1 className="text-xl font-semibold">CareLoop</h1>
        <p className="text-neutral-600">
          No signed-in companion user. Sign-in UX arrives in a later milestone.
        </p>
        <p className="text-sm text-neutral-500">
          For local development, create a user in the Supabase dashboard
          (Authentication → Users → Add user) and set its UUID as{" "}
          <code className="rounded bg-neutral-100 px-1">CARELOOP_DEV_USER_ID</code>{" "}
          in <code className="rounded bg-neutral-100 px-1">.env.local</code>.
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

  return (
    <Chat
      initialConversationId={view.conversationId}
      initialMessages={initialMessages}
    />
  );
}

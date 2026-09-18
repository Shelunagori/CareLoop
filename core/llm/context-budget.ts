/**
 * A backstop against a 24,000-token context window.
 *
 * This is NOT CareLoop's context strategy. What keeps the prompt flat is
 * `chatConfig.recentTurnLimit` (20 turns) and the `memoryConfig` caps (4
 * episodes, 5 entity cards, 8 profile facts) - bounds that hold however long
 * someone has been using CareLoop, because a companion that grows slower and
 * vaguer over time is the opposite of the product thesis. Those caps bound the
 * NUMBER of things in the prompt. They do not bound the SIZE of any one of
 * them, and that is the gap this closes.
 *
 * The rules are about which context is expendable:
 *
 *   - The latest user turn is never dropped and never truncated. It is what
 *     the person just said; answering a shortened version of it is worse than
 *     failing. `chatConfig.maxMessageLength` already bounds it at 2,000
 *     characters, so it cannot be what overflows the window.
 *   - System messages are never dropped. They carry the grounding rules, and
 *     a turn generated without them is a different product.
 *   - Everything else goes oldest-first, which is the same recency preference
 *     the retrieval layer already encodes.
 */
export type BudgetedMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type BoundedContext<T extends BudgetedMessage> = {
  messages: T[];
  /** For the log line: how much history this turn lost, if any. */
  droppedMessages: number;
};

/**
 * Tokens, approximately and deliberately on the high side.
 *
 * No tokenizer ships with this app, and adding one for a backstop would be a
 * dependency and a cold-start cost for a number that only has to be safe. The
 * usual rule of thumb is ~4 characters per token for English prose; this uses
 * 3.5 plus a per-message allowance for role framing, because the failure modes
 * are asymmetric. Over-counting trims one more old turn than strictly needed.
 * Under-counting sends a request past the real window and turns a
 * conversation into a provider error.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Role tags, separators and the chat template's own scaffolding. */
const PER_MESSAGE_OVERHEAD_TOKENS = 8;

const costOf = (message: BudgetedMessage): number =>
  estimateTokens(message.content) + PER_MESSAGE_OVERHEAD_TOKENS;

export function boundToBudget<T extends BudgetedMessage>(
  messages: readonly T[],
  maxInputTokens: number,
): BoundedContext<T> {
  // Everything that must survive regardless of budget, by INDEX so that
  // duplicate content cannot make two different messages look like one.
  const protectedIndexes = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === "system") protectedIndexes.add(index);
  });
  const latestUserTurn = messages.findLastIndex((message) => message.role === "user");
  if (latestUserTurn !== -1) protectedIndexes.add(latestUserTurn);

  let total = messages.reduce((sum, message) => sum + costOf(message), 0);
  if (total <= maxInputTokens) {
    return { messages: [...messages], droppedMessages: 0 };
  }

  // Oldest first, skipping anything protected. The loop stops the moment the
  // budget is met, so the newest history survives.
  const dropped = new Set<number>();
  for (let index = 0; index < messages.length && total > maxInputTokens; index += 1) {
    if (protectedIndexes.has(index)) continue;
    dropped.add(index);
    total -= costOf(messages[index]);
  }

  /**
   * If the protected messages alone still exceed the budget, they go anyway.
   *
   * Truncating them is the one thing this must not do: a silently shortened
   * user turn is answered as though the person said something they did not,
   * and a silently shortened system prompt drops grounding rules without
   * anybody noticing. Sending them and letting the provider refuse is the
   * honest failure, and it is already mapped to a provider failure upstream.
   * In practice `maxMessageLength` keeps this branch unreachable.
   */
  return {
    messages: messages.filter((_, index) => !dropped.has(index)),
    droppedMessages: dropped.size,
  };
}

import { describe, expect, it } from "vitest";
import { chatConfig } from "@/server/config";
import { ChatRequestSchema } from "@/server/services/chat-request";

describe("ChatRequestSchema", () => {
  it("rejects an empty message", () => {
    expect(ChatRequestSchema.safeParse({ text: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only message", () => {
    expect(ChatRequestSchema.safeParse({ text: "   \n\t " }).success).toBe(false);
  });

  it("rejects a message over the configured maximum", () => {
    const text = "a".repeat(chatConfig.maxMessageLength + 1);
    expect(ChatRequestSchema.safeParse({ text }).success).toBe(false);
  });

  it("rejects a non-uuid conversationId", () => {
    const result = ChatRequestSchema.safeParse({
      text: "hello",
      conversationId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid message and trims it", () => {
    const result = ChatRequestSchema.safeParse({ text: "  hello  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("hello");
  });

  it("has no user_id field — identity is never taken from the body", () => {
    const result = ChatRequestSchema.safeParse({
      text: "hello",
      user_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
    if (result.success) expect("user_id" in result.data).toBe(false);
  });
});

import { describe, test, expect } from "bun:test"
import {
  compactConversationHistory,
  getClaudeUserMessage,
} from "../../src/message-builder.js"

describe("compactConversationHistory", () => {
  test("returns null for single message", () => {
    const result = compactConversationHistory([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ] as any)
    expect(result).toBeNull()
  })

  test("truncates messages at 2000 chars", () => {
    const longText = "x".repeat(3000)
    const result = compactConversationHistory([
      { role: "user", content: longText },
      { role: "assistant", content: "response" },
      { role: "user", content: [{ type: "text", text: "follow-up" }] },
    ] as any)
    expect(result).not.toBeNull()
    // The first user message should be truncated to 2000 + "..."
    expect(result!).toContain("...")
    expect(result!.indexOf("x".repeat(2001))).toBe(-1)
  })

  test("annotates tool calls with count and names", () => {
    const result = compactConversationHistory([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool-call", toolName: "read" },
          { type: "tool-call", toolName: "grep" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ] as any)
    expect(result).not.toBeNull()
    expect(result!).toContain("Called 2 tool(s)")
    expect(result!).toContain("read")
    expect(result!).toContain("grep")
  })
})

describe("getClaudeUserMessage", () => {
  test("wraps history in <conversation_history> tags", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ] as any
    const msg = getClaudeUserMessage(prompt, true)
    const parsed = JSON.parse(msg)
    const textParts = parsed.message.content.filter((c: any) => c.type === "text")
    const historyPart = textParts.find((c: any) => c.text.includes("<conversation_history>"))
    expect(historyPart).toBeTruthy()
    expect(historyPart.text).toContain("</conversation_history>")
  })

  test("includes tool results as tool_result blocks", () => {
    const prompt = [
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      {
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            result: { output: "file contents here" },
          },
        ],
      },
    ] as any
    const msg = getClaudeUserMessage(prompt, false)
    const parsed = JSON.parse(msg)
    const toolResult = parsed.message.content.find((c: any) => c.type === "tool_result")
    expect(toolResult).toBeTruthy()
    expect(toolResult.tool_use_id).toBe("call-1")
    expect(toolResult.content).toBe("file contents here")
  })

  test("handles empty content array", () => {
    const prompt = [
      { role: "user", content: [] },
    ] as any
    const msg = getClaudeUserMessage(prompt, false)
    const parsed = JSON.parse(msg)
    // Should produce a valid message with empty text fallback
    expect(parsed.type).toBe("user")
    expect(parsed.message.role).toBe("user")
  })
})

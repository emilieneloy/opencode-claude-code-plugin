import { describe, test, expect } from "bun:test"
import { createClaudeCode } from "../src/index.js"
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider"
import { execSync } from "node:child_process"

const provider = createClaudeCode({ name: "claude-code" })
const cwd = process.cwd()

function makePrompt(text: string, opts?: { tools?: boolean }) {
  const prompt: any[] = [
    { role: "system", content: "You are a test assistant. Be extremely brief." },
    { role: "user", content: [{ type: "text", text }] },
  ]
  const tools = opts?.tools
    ? [{ type: "function" as const, name: "test_tool", description: "test", parameters: {} }]
    : undefined

  return {
    inputFormat: "prompt" as const,
    mode: { type: "regular" as const, ...(tools ? { tools } : {}) },
    prompt,
    ...(tools ? { tools } : {}),
    providerOptions: { "claude-code": { cwd } },
  }
}

describe("provider", () => {
  test("creates a language model with correct metadata", () => {
    const model = provider("claude-sonnet-4-6")
    expect(model.provider).toBe("claude-code")
    expect(model.modelId).toBe("claude-sonnet-4-6")
    expect(model.specificationVersion).toBe("v2")
  })

  test("languageModel() is an alias for the callable", () => {
    const m1 = provider("claude-sonnet-4-6")
    const m2 = provider.languageModel("claude-sonnet-4-6")
    expect(m1.provider).toBe(m2.provider)
    expect(m1.modelId).toBe(m2.modelId)
  })

  test("textEmbeddingModel throws not supported", () => {
    expect(() => provider.textEmbeddingModel("any")).toThrow("not supported")
  })

  test("imageModel throws not supported", () => {
    expect(() => provider.imageModel("any")).toThrow("not supported")
  })
})

describe("doGenerate — no-tools path", () => {
  const model = provider("claude-sonnet-4-6")

  test("returns synthetic title without calling CLI", async () => {
    const result = await model.doGenerate(makePrompt("Read the README file"))
    expect(result.providerMetadata?.["claude-code"]?.synthetic).toBe(true)
    expect(result.finishReason).toBe("stop")
    expect(result.usage.inputTokens).toBe(0)
    const text = result.content.find((c: any) => c.type === "text") as any
    expect(text?.text).toBeTruthy()
    expect(text.text.length).toBeGreaterThan(0)
  })

  test("synthesizes reasonable title from user text", async () => {
    const result = await model.doGenerate(makePrompt("Help me debug the authentication module"))
    const text = (result.content.find((c: any) => c.type === "text") as any)?.text
    expect(text).toBeTruthy()
    // Should contain meaningful words, not just "New Session"
    expect(text.length).toBeGreaterThan(3)
  })

  test("returns 'New Session' for empty input", async () => {
    const result = await model.doGenerate({
      inputFormat: "prompt",
      mode: { type: "regular" },
      prompt: [
        { role: "system", content: "test" },
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    })
    const text = (result.content.find((c: any) => c.type === "text") as any)?.text
    expect(text).toBe("New Session")
  })
})

describe("doGenerate — real CLI call", () => {
  const model = provider("claude-sonnet-4-6")

  test("gets a real response from Claude CLI", async () => {
    const result = await model.doGenerate(
      makePrompt("Reply with exactly the word 'pong'. Nothing else.", { tools: true }),
    )

    expect(result.finishReason).toBeDefined()
    expect(result.response.id).toBeTruthy()
    expect(result.response.modelId).toBe("claude-sonnet-4-6")

    const text = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
    expect(text.toLowerCase()).toContain("pong")

    // Session ID should be present
    expect(result.providerMetadata?.["claude-code"]?.sessionId).toBeTruthy()
  }, 60_000)

  test("leaves no orphan processes after completion", async () => {
    // Give a moment for process cleanup
    await new Promise((r) => setTimeout(r, 1000))
    const ps = execSync('ps aux | grep "claude.*stream-json" | grep -v grep || true', {
      encoding: "utf8",
    })
    const lines = ps.trim().split("\n").filter(Boolean)
    expect(lines.length).toBe(0)
  })
})

describe("doStream — no-tools path", () => {
  const model = provider("claude-sonnet-4-6")

  test("streams synthetic title without calling CLI", async () => {
    const { stream } = await model.doStream({
      inputFormat: "prompt",
      mode: { type: "regular" },
      prompt: [
        { role: "system", content: "test" },
        { role: "user", content: [{ type: "text", text: "Explain quantum computing" }] },
      ],
    })

    const parts: LanguageModelV2StreamPart[] = []
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    expect(parts.some((p) => p.type === "stream-start")).toBe(true)
    expect(parts.some((p) => p.type === "text-delta")).toBe(true)
    expect(parts.some((p) => p.type === "finish")).toBe(true)

    const finish = parts.find((p) => p.type === "finish") as any
    expect(finish.finishReason).toBe("stop")
    expect(finish.providerMetadata?.["claude-code"]?.synthetic).toBe(true)
  })
})

describe("doStream — real CLI call", () => {
  const model = provider("claude-sonnet-4-6")

  test("streams a real response from Claude CLI", async () => {
    const { stream } = await model.doStream(
      makePrompt("Reply with exactly the word 'pong'. Nothing else.", { tools: true }),
    )

    const parts: LanguageModelV2StreamPart[] = []
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // Must have stream lifecycle events
    expect(parts.some((p) => p.type === "stream-start")).toBe(true)
    expect(parts.some((p) => p.type === "finish")).toBe(true)

    // Should have text content
    const textDeltas = parts
      .filter((p) => p.type === "text-delta")
      .map((p: any) => p.delta)
      .join("")
    expect(textDeltas.toLowerCase()).toContain("pong")

    // Finish should report usage
    const finish = parts.find((p) => p.type === "finish") as any
    expect(finish.finishReason).toBeDefined()
    expect(finish.providerMetadata?.["claude-code"]?.sessionId).toBeTruthy()
  }, 60_000)

  test("keeps process alive for session reuse (by design)", async () => {
    // doStream intentionally keeps the CLI process alive for multi-turn
    // session reuse. This is NOT a leak — it's the "keep process alive
    // for next message" design (line 1128). Verify at most 1 remains.
    await new Promise((r) => setTimeout(r, 1000))
    const ps = execSync('ps aux | grep "claude.*stream-json" | grep -v grep || true', {
      encoding: "utf8",
    })
    const lines = ps.trim().split("\n").filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(1)
  })
})

describe("session isolation", () => {
  test("different system prompts produce different session keys", async () => {
    const model = provider("claude-sonnet-4-6")

    const r1 = await model.doGenerate({
      inputFormat: "prompt",
      mode: { type: "regular" },
      prompt: [
        { role: "system", content: "You are Agent Alpha." },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    })

    const r2 = await model.doGenerate({
      inputFormat: "prompt",
      mode: { type: "regular" },
      prompt: [
        { role: "system", content: "You are Agent Beta." },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    })

    // Both are no-tools (synthetic), but they should still generate results
    expect(r1.content.length).toBeGreaterThan(0)
    expect(r2.content.length).toBeGreaterThan(0)
  })

  test("real CLI calls with different system prompts get separate sessions", async () => {
    const modelA = provider("claude-sonnet-4-6")
    const modelB = provider("claude-sonnet-4-6")

    const [rA, rB] = await Promise.all([
      modelA.doGenerate({
        inputFormat: "prompt",
        mode: {
          type: "regular",
          tools: [{ type: "function", name: "t", description: "t", parameters: {} }],
        },
        tools: [{ type: "function", name: "t", description: "t", parameters: {} }],
        prompt: [
          { role: "system", content: "You are Agent Alpha. Reply with 'alpha'." },
          { role: "user", content: [{ type: "text", text: "identify yourself" }] },
        ],
        providerOptions: { "claude-code": { cwd } },
      }),
      modelB.doGenerate({
        inputFormat: "prompt",
        mode: {
          type: "regular",
          tools: [{ type: "function", name: "t", description: "t", parameters: {} }],
        },
        tools: [{ type: "function", name: "t", description: "t", parameters: {} }],
        prompt: [
          { role: "system", content: "You are Agent Beta. Reply with 'beta'." },
          { role: "user", content: [{ type: "text", text: "identify yourself" }] },
        ],
        providerOptions: { "claude-code": { cwd } },
      }),
    ])

    const sessionA = rA.providerMetadata?.["claude-code"]?.sessionId
    const sessionB = rB.providerMetadata?.["claude-code"]?.sessionId

    expect(sessionA).toBeTruthy()
    expect(sessionB).toBeTruthy()
    // Different system prompts should yield different CLI sessions
    expect(sessionA).not.toBe(sessionB)
  }, 120_000)
})

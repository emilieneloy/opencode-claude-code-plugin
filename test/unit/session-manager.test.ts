import { describe, test, expect, beforeEach } from "bun:test"
import {
  sessionKey,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
} from "../../src/session-manager.js"

describe("sessionKey", () => {
  test("produces consistent keys for same inputs", () => {
    const a = sessionKey("/tmp/proj", "claude-sonnet-4-6", "abc123")
    const b = sessionKey("/tmp/proj", "claude-sonnet-4-6", "abc123")
    expect(a).toBe(b)
  })

  test("produces different keys for different agentHash", () => {
    const a = sessionKey("/tmp/proj", "claude-sonnet-4-6", "hash1")
    const b = sessionKey("/tmp/proj", "claude-sonnet-4-6", "hash2")
    expect(a).not.toBe(b)
  })

  test("omits agentHash segment when undefined", () => {
    const key = sessionKey("/tmp/proj", "claude-sonnet-4-6")
    expect(key).toBe("/tmp/proj::claude-sonnet-4-6")
  })

  test("includes agentHash segment when provided", () => {
    const key = sessionKey("/tmp/proj", "claude-sonnet-4-6", "abc123")
    expect(key).toBe("/tmp/proj::claude-sonnet-4-6::abc123")
  })
})

describe("session ID management", () => {
  const testKey = "unit-test-key"

  beforeEach(() => {
    deleteClaudeSessionId(testKey)
  })

  test("get returns undefined for unknown key", () => {
    expect(getClaudeSessionId("nonexistent")).toBeUndefined()
  })

  test("set and get round-trip", () => {
    setClaudeSessionId(testKey, "sess-abc")
    expect(getClaudeSessionId(testKey)).toBe("sess-abc")
  })

  test("delete removes the session ID", () => {
    setClaudeSessionId(testKey, "sess-xyz")
    deleteClaudeSessionId(testKey)
    expect(getClaudeSessionId(testKey)).toBeUndefined()
  })

  test("set overwrites previous value", () => {
    setClaudeSessionId(testKey, "sess-1")
    setClaudeSessionId(testKey, "sess-2")
    expect(getClaudeSessionId(testKey)).toBe("sess-2")
  })
})

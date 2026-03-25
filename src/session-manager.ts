import { log } from "./logger.js"

// Map sessionKey -> Claude CLI session ID for session reuse via Agent SDK resume
const claudeSessions = new Map<string, string>()

export function getClaudeSessionId(key: string): string | undefined {
  return claudeSessions.get(key)
}

export function setClaudeSessionId(key: string, sessionId: string): void {
  claudeSessions.set(key, sessionId)
}

export function deleteClaudeSessionId(key: string): void {
  claudeSessions.delete(key)
}

/**
 * Build a session key that includes cwd, model, and optionally an agent hash,
 * so different agents sharing the same model get separate sessions.
 */
export function sessionKey(cwd: string, modelId: string, agentHash?: string): string {
  const base = `${cwd}::${modelId}`
  return agentHash ? `${base}::${agentHash}` : base
}

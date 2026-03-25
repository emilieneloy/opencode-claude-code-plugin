export interface ClaudeCodeConfig {
  provider: string
  cliPath: string
  cwd?: string
  skipPermissions?: boolean
  /** Controls how much effort Claude puts into its response. */
  effort?: "low" | "medium" | "high" | "max"
  /** Controls Claude's thinking/reasoning behavior. */
  thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" }
  /** Maximum number of conversation turns before the query stops. */
  maxTurns?: number
}

export interface ClaudeCodeProviderSettings {
  cliPath?: string
  cwd?: string
  name?: string
  skipPermissions?: boolean
  /** Controls how much effort Claude puts into its response. */
  effort?: "low" | "medium" | "high" | "max"
  /** Controls Claude's thinking/reasoning behavior. */
  thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" }
  /** Maximum number of conversation turns before the query stops. */
  maxTurns?: number
}

export interface ClaudeCodeConfig {
  provider: string
  cliPath: string
  cwd?: string
  skipPermissions?: boolean
}

export interface ClaudeCodeProviderSettings {
  cliPath?: string
  cwd?: string
  name?: string
  skipPermissions?: boolean
}

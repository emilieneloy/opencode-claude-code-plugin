import type {
  LanguageModelV2,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawn as spawnChild } from "node:child_process"
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeCodeConfig } from "./types.js"
import { mapTool } from "./tool-mapping.js"
import { getClaudeUserMessage } from "./message-builder.js"
import {
  sessionKey,
  getClaudeSessionId,
  setClaudeSessionId,
  deleteClaudeSessionId,
} from "./session-manager.js"
import { log } from "./logger.js"

export class ClaudeCodeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly modelId: string
  private readonly config: ClaudeCodeConfig

  constructor(modelId: string, config: ClaudeCodeConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {}

  get provider(): string {
    return this.config.provider
  }

  private async runSqlite(dbPath: string, sql: string): Promise<string> {
    return new Promise((resolve) => {
      const proc = spawnChild("sqlite3", [dbPath, sql], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      })
      let stdout = ""
      proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
      proc.on("close", () => resolve(stdout.trim()))
      proc.on("error", () => resolve(""))
    })
  }

  private async resolveCwd(options?: { providerOptions?: Record<string, unknown> }): Promise<string> {
    if (this.config.cwd && this.config.cwd.trim().length > 0) {
      return this.config.cwd
    }

    const providerOpts = options?.providerOptions as
      | Record<string, Record<string, unknown>>
      | undefined
    const claudeCodeOpts = providerOpts?.["claude-code"]
    const explicitCwd = claudeCodeOpts?.["cwd"]
    if (typeof explicitCwd === "string" && explicitCwd.trim().length > 0) {
      return explicitCwd
    }

    const sessionID = claudeCodeOpts?.["sessionID"]
    if (typeof sessionID === "string" && /^[A-Za-z0-9_-]+$/.test(sessionID)) {
      try {
        const home = process.env.HOME
        if (home) {
          const dbPath = join(home, ".local", "share", "opencode", "opencode.db")
          if (existsSync(dbPath)) {
            const sql = `select directory from session where id='${sessionID}' limit 1;`
            const dbCwd = await this.runSqlite(dbPath, sql)
            if (dbCwd.length > 0) return dbCwd
          }
        }
      } catch {
        // Fallback below.
      }
    }

    const runtimeCwd = process.cwd()
    if (runtimeCwd === "/") {
      try {
        const home = process.env.HOME
        if (home) {
          const dbPath = join(home, ".local", "share", "opencode", "opencode.db")
          if (existsSync(dbPath)) {
            const nowMs = Date.now()
            const fiveMinAgo = nowMs - 5 * 60 * 1000
            const sql =
              "select directory from session " +
              "where directory != '/' and time_updated >= " +
              `${fiveMinAgo} ` +
              "order by time_updated desc limit 1;"
            const recentDir = await this.runSqlite(dbPath, sql)
            if (recentDir.length > 0) return recentDir
          }
        }
      } catch {
        // Fall through to runtime cwd.
      }
    }

    return runtimeCwd
  }

  private hashSystemPrompt(prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"]): string {
    const systemMsg = prompt.find(m => m.role === "system")
    if (!systemMsg) return "no-system"
    const content = typeof systemMsg.content === "string"
      ? systemMsg.content
      : JSON.stringify(systemMsg.content)
    return createHash("sha256").update(content).digest("hex").slice(0, 12)
  }

  private requestScope(options: { tools?: unknown }): "tools" | "no-tools" {
    return Array.isArray(options?.tools) ? "tools" : "no-tools"
  }

  private latestUserText(
    prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
  ): string {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "user") continue

      if (typeof msg.content === "string") {
        return String(msg.content).trim()
      }

      if (Array.isArray(msg.content)) {
        const text = (msg.content as any[])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => String(part.text).trim())
          .filter(Boolean)
          .join(" ")
        if (text) return text
      }
    }

    return ""
  }

  private synthesizeTitle(
    prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
  ): string {
    const source = this.latestUserText(prompt)
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .trim()

    if (!source) return "New Session"

    const stop = new Set([
      "a", "an", "the", "and", "or", "but", "to", "for", "of", "in", "on",
      "at", "with", "can", "could", "would", "should", "please", "hi",
      "hello", "hey", "there", "you", "your", "this", "that", "is", "are",
      "was", "were", "be", "do", "does", "did", "summarize", "summary", "project",
    ])

    const words = source
      .split(" ")
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word) => !stop.has(word.toLowerCase()))

    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean))
      .slice(0, 6)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")

    return picked || "New Session"
  }

  /**
   * Build SDK Options common to both doGenerate and doStream.
   */
  private buildSdkOptions(cwd: string, sk: string, opts?: { resume?: boolean }): Options {
    const sdkOpts: Options = {
      model: this.modelId,
      cwd,
      includePartialMessages: true,
      persistSession: false,
    }

    if (this.config.skipPermissions !== false) {
      sdkOpts.permissionMode = "bypassPermissions"
      sdkOpts.allowDangerouslySkipPermissions = true
    }

    if (this.config.effort) {
      sdkOpts.effort = this.config.effort
    }

    if (this.config.thinking) {
      sdkOpts.thinking = this.config.thinking
    }

    if (this.config.maxTurns) {
      sdkOpts.maxTurns = this.config.maxTurns
    }

    // Resume from existing session if available
    if (opts?.resume) {
      const existingSessionId = getClaudeSessionId(sk)
      if (existingSessionId) {
        sdkOpts.resume = existingSessionId
      }
    }

    return sdkOpts
  }

  /**
   * Extract the user-facing prompt text from the AI SDK prompt for the Agent SDK.
   */
  private buildPromptText(
    prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
    includeHistoryContext: boolean,
  ): string {
    // Use existing message builder to produce the CLI stream-json format
    const cliMsg = getClaudeUserMessage(prompt, includeHistoryContext)
    // The SDK accepts a plain string prompt — extract the text from the CLI message
    try {
      const parsed = JSON.parse(cliMsg)
      const content = parsed?.message?.content
      if (Array.isArray(content)) {
        const texts: string[] = []
        for (const part of content) {
          if (part.type === "text" && part.text) {
            texts.push(part.text)
          } else if (part.type === "tool_result") {
            texts.push(`[Tool result for ${part.tool_use_id}]: ${typeof part.content === "string" ? part.content : JSON.stringify(part.content)}`)
          }
        }
        return texts.join("\n\n")
      }
    } catch {
      // Fallback to raw latest user text
    }
    return this.latestUserText(prompt)
  }

  async doGenerate(
    options: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const cwd = await this.resolveCwd(options as any)
    const scope = this.requestScope(options as any)
    const agentHash = this.hashSystemPrompt(options.prompt)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, agentHash)

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      return {
        content: [{ type: "text", text }] as any,
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools",
          },
        },
        warnings,
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear stale state
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation
    const promptText = this.buildPromptText(options.prompt, includeHistoryContext)

    // doGenerate always creates a fresh session (no resume)
    const sdkOpts = this.buildSdkOptions(cwd, sk, { resume: false })

    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: promptText.length,
      includeHistoryContext,
    })

    let responseText = ""
    let thinkingText = ""
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = []
    let resultMeta: {
      sessionId?: string
      costUsd?: number
      durationMs?: number
      usage?: { input_tokens?: number; output_tokens?: number }
    } = {}

    const q = query({ prompt: promptText, options: sdkOpts })

    // Safety-net timeout
    const TIMEOUT_MS = 300_000
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        q.close()
        reject(new Error(`claude Agent SDK timed out after ${TIMEOUT_MS / 1000}s`))
      }, TIMEOUT_MS)
    })

    try {
      await Promise.race([
        (async () => {
          for await (const msg of q) {
            const processed = this.processGenerateMessage(msg, sk)
            if (processed.text) responseText += processed.text
            if (processed.thinking) thinkingText += processed.thinking
            if (processed.toolCall) toolCalls.push(processed.toolCall)
            if (processed.result) resultMeta = processed.result
          }
        })(),
        timeoutPromise,
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    const content: LanguageModelV2Content[] = []

    if (thinkingText) {
      content.push({
        type: "reasoning",
        text: thinkingText,
      } as any)
    }

    if (responseText) {
      content.push({
        type: "text",
        text: responseText,
        providerMetadata: {
          "claude-code": {
            sessionId: resultMeta.sessionId ?? null,
            costUsd: resultMeta.costUsd ?? null,
            durationMs: resultMeta.durationMs ?? null,
          },
        },
      })
    }

    for (const tc of toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip,
      } = mapTool(tc.name, tc.args)
      if (skip) continue
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed,
      } as any)
    }

    const usage: LanguageModelV2Usage = {
      inputTokens: resultMeta.usage?.input_tokens,
      outputTokens: resultMeta.usage?.output_tokens,
      totalTokens:
        resultMeta.usage?.input_tokens && resultMeta.usage?.output_tokens
          ? resultMeta.usage.input_tokens + resultMeta.usage.output_tokens
          : undefined,
    }

    return {
      content,
      finishReason: (toolCalls.length > 0
        ? "tool-calls"
        : "stop") as LanguageModelV2FinishReason,
      usage,
      request: { body: { text: promptText } },
      response: {
        id: resultMeta.sessionId ?? generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        "claude-code": {
          sessionId: resultMeta.sessionId ?? null,
          costUsd: resultMeta.costUsd ?? null,
          durationMs: resultMeta.durationMs ?? null,
        },
      },
      warnings,
    }
  }

  /**
   * Process a single SDK message for doGenerate, extracting text/thinking/tool data.
   */
  private processGenerateMessage(
    msg: SDKMessage,
    sk: string,
  ): {
    text?: string
    thinking?: string
    toolCall?: { id: string; name: string; args: unknown }
    result?: { sessionId?: string; costUsd?: number; durationMs?: number; usage?: { input_tokens?: number; output_tokens?: number } }
  } {
    const out: ReturnType<typeof this.processGenerateMessage> = {}

    if (msg.type === "assistant") {
      const betaMsg = msg.message as any
      if (betaMsg?.content) {
        for (const block of betaMsg.content) {
          if (block.type === "text" && block.text) {
            out.text = (out.text ?? "") + block.text
          }
          if (block.type === "thinking" && block.thinking) {
            out.thinking = (out.thinking ?? "") + block.thinking
          }
          if (block.type === "tool_use" && block.id && block.name) {
            if (
              block.name === "AskUserQuestion" ||
              block.name === "ask_user_question"
            ) {
              const parsedInput = (block.input ?? {}) as Record<string, unknown>
              const question = (parsedInput?.question as string) || "Question?"
              out.text = (out.text ?? "") + `\n\n_Asking: ${question}_\n\n`
            } else {
              out.toolCall = {
                id: block.id,
                name: block.name,
                args: block.input ?? {},
              }
            }
          }
        }
      }
    }

    if (msg.type === "user") {
      // Tool results from Claude CLI — no action needed for doGenerate
    }

    if (msg.type === "result") {
      const resultMsg = msg as any
      if (resultMsg.session_id) {
        setClaudeSessionId(sk, resultMsg.session_id)
      }
      out.result = {
        sessionId: resultMsg.session_id,
        costUsd: resultMsg.total_cost_usd,
        durationMs: resultMsg.duration_ms,
        usage: resultMsg.usage,
      }
    }

    return out
  }

  async doStream(
    options: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const cwd = await this.resolveCwd(options as any)
    const scope = this.requestScope(options as any)
    const agentHash = this.hashSystemPrompt(options.prompt)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, agentHash)

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      const textId = generateId()
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({ type: "text-start", id: textId } as any)
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text,
          })
          controller.enqueue({ type: "text-end", id: textId })
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools",
              },
            },
          })
          controller.close()
        },
      })

      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear stale state
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation
    const promptText = this.buildPromptText(options.prompt, includeHistoryContext)

    const sdkOpts = this.buildSdkOptions(cwd, sk, { resume: hasExistingSession })

    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: promptText.length,
      includeHistoryContext,
      hasExistingSession,
    })

    const q = query({ prompt: promptText, options: sdkOpts })

    const self = this
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        const textId = generateId()
        let textStarted = false

        const reasoningIds = new Map<number, string>()
        const reasoningStarted = new Map<number, boolean>()

        const toolCallMap = new Map<
          number,
          { id: string; name: string; inputJson: string }
        >()
        const toolCallsById = new Map<
          string,
          { id: string; name: string; input: unknown }
        >()
        let toolCallCount = 0

        let resultMeta: {
          sessionId?: string
          costUsd?: number
          durationMs?: number
          usage?: { input_tokens?: number; output_tokens?: number }
        } = {}

        let controllerClosed = false

        const safeEnqueue = (part: LanguageModelV2StreamPart) => {
          if (!controllerClosed) controller.enqueue(part)
        }

        const safeClose = () => {
          if (!controllerClosed) {
            controllerClosed = true
            try { controller.close() } catch {}
          }
        }

        // Abort handling
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            log.info("abort signal received, closing query", { cwd })
            q.close()
            safeClose()
          })
        }

        safeEnqueue({ type: "stream-start", warnings })

        try {
          for await (const msg of q) {
            if (controllerClosed) break

            // stream_event — partial streaming deltas
            if (msg.type === "stream_event") {
              const event = (msg as any).event
              if (!event) continue

              // content_block_start
              if (event.type === "content_block_start" && event.content_block) {
                const block = event.content_block
                const idx = event.index ?? 0

                if (block.type === "thinking") {
                  const reasoningId = generateId()
                  reasoningIds.set(idx, reasoningId)
                  safeEnqueue({ type: "reasoning-start", id: reasoningId } as any)
                  reasoningStarted.set(idx, true)
                }

                if (block.type === "text") {
                  if (!textStarted) {
                    safeEnqueue({ type: "text-start", id: textId } as any)
                    textStarted = true
                  }
                }

                if (block.type === "tool_use" && block.id && block.name) {
                  toolCallMap.set(idx, {
                    id: block.id,
                    name: block.name,
                    inputJson: "",
                  })

                  if (
                    block.name !== "AskUserQuestion" &&
                    block.name !== "ask_user_question"
                  ) {
                    const { name: mappedName, skip } = mapTool(block.name)
                    if (!skip) {
                      safeEnqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                      } as any)
                      log.info("tool started", {
                        name: block.name,
                        mappedName,
                        id: block.id,
                      })
                    }
                  }
                }
              }

              // content_block_delta
              if (event.type === "content_block_delta" && event.delta) {
                const delta = event.delta
                const idx = event.index ?? 0

                if (delta.type === "thinking_delta" && delta.thinking) {
                  const reasoningId = reasoningIds.get(idx)
                  if (reasoningId) {
                    safeEnqueue({
                      type: "reasoning-delta",
                      id: reasoningId,
                      delta: delta.thinking,
                    } as any)
                  }
                }

                if (delta.type === "text_delta" && delta.text) {
                  if (!textStarted) {
                    safeEnqueue({ type: "text-start", id: textId } as any)
                    textStarted = true
                  }
                  safeEnqueue({
                    type: "text-delta",
                    id: textId,
                    delta: delta.text,
                  })
                }

                if (delta.type === "input_json_delta" && delta.partial_json) {
                  const tc = toolCallMap.get(idx)
                  if (tc) {
                    tc.inputJson += delta.partial_json
                    safeEnqueue({
                      type: "tool-input-delta",
                      id: tc.id,
                      delta: delta.partial_json,
                    } as any)
                  }
                }
              }

              // content_block_stop
              if (event.type === "content_block_stop") {
                const idx = event.index ?? 0

                const reasoningId = reasoningIds.get(idx)
                if (reasoningId && reasoningStarted.get(idx)) {
                  safeEnqueue({ type: "reasoning-end", id: reasoningId } as any)
                  reasoningStarted.delete(idx)
                }

                const tc = toolCallMap.get(idx)
                if (tc) {
                  let parsedInput: any = {}
                  let parseOk = true
                  try {
                    parsedInput = JSON.parse(tc.inputJson || "{}")
                  } catch {
                    log.warn("failed to parse tool input JSON, skipping tool call", { toolName: tc.name, inputJson: tc.inputJson })
                    parseOk = false
                  }

                  if (!parseOk) {
                    toolCallMap.delete(idx)
                  } else if (
                    tc.name === "AskUserQuestion" ||
                    tc.name === "ask_user_question"
                  ) {
                    let question = "Question?"
                    if (
                      parsedInput?.questions &&
                      Array.isArray(parsedInput.questions) &&
                      parsedInput.questions.length > 0
                    ) {
                      question =
                        parsedInput.questions[0].question ||
                        parsedInput.questions[0].text ||
                        "Question?"
                    } else {
                      question =
                        parsedInput?.question ||
                        parsedInput?.text ||
                        "Question?"
                    }

                    if (!textStarted) {
                      safeEnqueue({ type: "text-start", id: textId } as any)
                      textStarted = true
                    }
                    safeEnqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `\n\n_Asking: ${question}_\n\n`,
                    })
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip,
                    } = mapTool(tc.name, parsedInput)

                    if (!skip) {
                      toolCallsById.set(tc.id, {
                        id: tc.id,
                        name: tc.name,
                        input: parsedInput,
                      })
                      toolCallCount++

                      safeEnqueue({
                        type: "tool-call",
                        toolCallId: tc.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed,
                      } as any)
                    }
                    log.info("tool call complete", {
                      name: tc.name,
                      mappedName,
                      id: tc.id,
                      executed,
                    })
                  }
                }
              }

              continue
            }

            // Full assistant message (non-streaming)
            if (msg.type === "assistant") {
              const betaMsg = (msg as any).message
              if (betaMsg?.content) {
                for (const block of betaMsg.content) {
                  if (block.type === "text" && block.text) {
                    if (!textStarted) {
                      safeEnqueue({ type: "text-start", id: textId } as any)
                      textStarted = true
                    }
                    safeEnqueue({
                      type: "text-delta",
                      id: textId,
                      delta: block.text,
                    })
                  }

                  if (block.type === "thinking" && block.thinking) {
                    const thinkingId = generateId()
                    safeEnqueue({ type: "reasoning-start", id: thinkingId } as any)
                    safeEnqueue({
                      type: "reasoning-delta",
                      id: thinkingId,
                      delta: block.thinking,
                    } as any)
                    safeEnqueue({ type: "reasoning-end", id: thinkingId } as any)
                  }

                  if (block.type === "tool_use" && block.id && block.name) {
                    const parsedInput = (block.input ?? {}) as Record<string, unknown>
                    toolCallsById.set(block.id, {
                      id: block.id,
                      name: block.name,
                      input: parsedInput,
                    })

                    if (
                      block.name === "AskUserQuestion" ||
                      block.name === "ask_user_question"
                    ) {
                      let question = "Question?"
                      if (
                        parsedInput?.questions &&
                        Array.isArray(parsedInput.questions) &&
                        parsedInput.questions.length > 0
                      ) {
                        const qObj = parsedInput.questions[0] as any
                        question = qObj.question || qObj.text || "Question?"
                      } else {
                        question =
                          (parsedInput?.question as string) ||
                          (parsedInput?.text as string) ||
                          "Question?"
                      }

                      if (!textStarted) {
                        safeEnqueue({ type: "text-start", id: textId } as any)
                        textStarted = true
                      }
                      safeEnqueue({
                        type: "text-delta",
                        id: textId,
                        delta: `\n\n_Asking: ${question}_\n\n`,
                      })
                    } else {
                      const {
                        name: mappedName,
                        input: mappedInput,
                        executed,
                        skip,
                      } = mapTool(block.name, parsedInput)

                      if (!skip) {
                        toolCallCount++
                        safeEnqueue({
                          type: "tool-input-start",
                          id: block.id,
                          toolName: mappedName,
                        } as any)
                        safeEnqueue({
                          type: "tool-call",
                          toolCallId: block.id,
                          toolName: mappedName,
                          input: JSON.stringify(mappedInput),
                          providerExecuted: executed,
                        } as any)
                      }
                    }
                  }
                }
              }
              continue
            }

            // User message — tool results from Claude CLI
            if (msg.type === "user") {
              const userMsg = (msg as any).message
              const content = userMsg?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_result" && block.tool_use_id) {
                    const toolCall = toolCallsById.get(block.tool_use_id)
                    if (toolCall) {
                      let resultText = ""
                      if (typeof block.content === "string") {
                        resultText = block.content
                      } else if (Array.isArray(block.content)) {
                        resultText = block.content
                          .filter(
                            (c: any): c is { type: string; text: string } =>
                              c.type === "text" && typeof c.text === "string",
                          )
                          .map((c: any) => c.text)
                          .join("\n")
                      }

                      safeEnqueue({
                        type: "tool-result",
                        toolCallId: block.tool_use_id,
                        toolName: toolCall.name,
                        result: {
                          output: resultText,
                          title: toolCall.name,
                          metadata: {},
                        },
                        providerExecuted: true,
                      } as any)
                      log.info("tool result emitted", {
                        toolUseId: block.tool_use_id,
                        name: toolCall.name,
                      })
                      toolCallsById.delete(block.tool_use_id)
                    }
                  }
                }
              }
              continue
            }

            // Result — end of conversation turn
            if (msg.type === "result") {
              const resultMsg = msg as any
              if (resultMsg.session_id) {
                setClaudeSessionId(sk, resultMsg.session_id)
              }
              resultMeta = {
                sessionId: resultMsg.session_id,
                costUsd: resultMsg.total_cost_usd,
                durationMs: resultMsg.duration_ms,
                usage: resultMsg.usage,
              }

              log.info("conversation result", {
                sessionId: resultMsg.session_id,
                durationMs: resultMsg.duration_ms,
                numTurns: resultMsg.num_turns,
                isError: resultMsg.is_error,
              })

              if (textStarted) {
                safeEnqueue({ type: "text-end", id: textId })
              }

              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  safeEnqueue({ type: "reasoning-end", id: reasoningId } as any)
                }
              }

              safeEnqueue({
                type: "finish",
                finishReason:
                  toolCallCount > 0 ? "tool-calls" : "stop",
                usage: {
                  inputTokens: resultMsg.usage?.input_tokens,
                  outputTokens: resultMsg.usage?.output_tokens,
                  totalTokens:
                    resultMsg.usage?.input_tokens &&
                    resultMsg.usage?.output_tokens
                      ? resultMsg.usage.input_tokens +
                        resultMsg.usage.output_tokens
                      : undefined,
                },
                providerMetadata: {
                  "claude-code": resultMeta,
                },
              })

              safeClose()
              continue
            }

            // Other SDK message types (system, status, etc.) — log and skip
            log.debug("unhandled SDK message type", { type: msg.type })
          }
        } catch (err) {
          log.error("stream error", { error: err instanceof Error ? err.message : String(err) })
          if (!controllerClosed) {
            safeEnqueue({ type: "error", error: err instanceof Error ? err : new Error(String(err)) })
            safeClose()
          }
        }

        // If the iterator ended without a result message, close gracefully
        if (!controllerClosed) {
          if (textStarted) {
            safeEnqueue({ type: "text-end", id: textId })
          }
          safeEnqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: undefined,
              outputTokens: undefined,
              totalTokens: undefined,
            },
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          safeClose()
        }
      },
      cancel() {
        q.close()
      },
    })

    return {
      stream,
      request: { body: { text: promptText } },
      response: { headers: {} },
    }
  }
}

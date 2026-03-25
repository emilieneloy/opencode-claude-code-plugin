// src/claude-code-language-model.ts
import { generateId } from "@ai-sdk/provider-utils";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { spawn as spawnChild } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

// src/logger.ts
var DEBUG = process.env.DEBUG?.includes("opencode-claude-code") ?? false;
function fmt(level, msg, data) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const base = `[${ts}] [opencode-claude-code] ${level}: ${msg}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}
var log = {
  info(msg, data) {
    if (DEBUG) console.error(fmt("INFO", msg, data));
  },
  warn(msg, data) {
    if (DEBUG) console.error(fmt("WARN", msg, data));
  },
  error(msg, data) {
    console.error(fmt("ERROR", msg, data));
  },
  debug(msg, data) {
    if (DEBUG) console.error(fmt("DEBUG", msg, data));
  }
};

// src/tool-mapping.ts
function mapToolInput(name, input) {
  if (!input) return input;
  switch (name) {
    case "Write":
      return {
        filePath: input.file_path ?? input.filePath,
        content: input.content
      };
    case "Edit":
      return {
        filePath: input.file_path ?? input.filePath,
        oldString: input.old_string ?? input.oldString,
        newString: input.new_string ?? input.newString,
        replaceAll: input.replace_all ?? input.replaceAll
      };
    case "Read":
      return {
        filePath: input.file_path ?? input.filePath,
        offset: input.offset,
        limit: input.limit
      };
    case "Bash":
      return {
        command: input.command,
        description: input.description || `Execute: ${String(input.command || "").slice(0, 50)}${String(input.command || "").length > 50 ? "..." : ""}`,
        timeout: input.timeout
      };
    case "NotebookEdit":
      return {
        notebookPath: input.notebook_path ?? input.notebookPath,
        cellNumber: input.cell_number ?? input.cellNumber,
        newSource: input.new_source ?? input.newSource,
        cellType: input.cell_type ?? input.cellType,
        editMode: input.edit_mode ?? input.editMode
      };
    case "Glob":
      return {
        pattern: input.pattern,
        path: input.path
      };
    case "Grep":
      return {
        pattern: input.pattern,
        path: input.path,
        include: input.include
      };
    case "TodoWrite":
      if (Array.isArray(input.todos)) {
        const mappedTodos = input.todos.map((todo, index) => ({
          content: todo.content,
          status: todo.status || "pending",
          priority: todo.priority || "medium",
          id: todo.id || `todo_${Date.now()}_${index}`
        }));
        return { todos: mappedTodos };
      }
      return input;
    default:
      return input;
  }
}
var OPENCODE_HANDLED_TOOLS = /* @__PURE__ */ new Set([
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "TodoWrite",
  "Read",
  "Glob",
  "Grep"
]);
var CLAUDE_INTERNAL_TOOLS = /* @__PURE__ */ new Set([
  "ToolSearch",
  "Agent",
  "AskFollowupQuestion"
]);
function mapTool(name, input) {
  if (CLAUDE_INTERNAL_TOOLS.has(name)) {
    log.debug("skipping Claude CLI internal tool", { name });
    return { name, input, executed: true, skip: true };
  }
  if (name === "EnterPlanMode") return { name: "plan_enter", input: {}, executed: false };
  if (name === "ExitPlanMode") return { name: "plan_exit", input: {}, executed: false };
  if (name === "WebSearch" || name === "web_search") {
    const mappedInput = input?.query ? { query: input.query } : input;
    log.debug("mapping WebSearch", { originalInput: input, mappedInput });
    return { name: "websearch_web_search_exa", input: mappedInput, executed: false };
  }
  if (name === "TaskOutput") {
    if (!input) return { name: "bash", executed: false };
    const output = input?.content || input?.output || JSON.stringify(input);
    return {
      name: "bash",
      input: {
        command: `echo "TASK OUTPUT: ${String(output).replace(/"/g, '\\"')}"`,
        description: "Displaying task output"
      },
      executed: false
    };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    if (parts.length >= 2) {
      const serverName = parts[0];
      const toolName = parts.slice(1).join("_");
      const openCodeName = `${serverName}_${toolName}`;
      log.debug("mapping MCP tool", { original: name, mapped: openCodeName });
      return { name: openCodeName, input, executed: false };
    }
  }
  if (OPENCODE_HANDLED_TOOLS.has(name)) {
    const mappedInput = mapToolInput(name, input);
    const openCodeName = name.toLowerCase();
    log.debug("mapping CLI-executed tool", { name, openCodeName });
    return { name: openCodeName, input: mappedInput, executed: true };
  }
  return { name, input, executed: true };
}

// src/message-builder.ts
function compactConversationHistory(prompt) {
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  if (conversationMessages.length <= 1) {
    return null;
  }
  const historyParts = [];
  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i];
    const role = msg.role === "user" ? "User" : "Assistant";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p) => p.type === "text" && p.text).map((p) => p.text);
      text = textParts.join("\n");
      const toolCalls = msg.content.filter(
        (p) => p.type === "tool-call"
      );
      const toolResults = msg.content.filter(
        (p) => p.type === "tool-result"
      );
      if (toolCalls.length > 0) {
        text += `
[Called ${toolCalls.length} tool(s): ${toolCalls.map((t) => t.toolName).join(", ")}]`;
      }
      if (toolResults.length > 0) {
        text += `
[Received ${toolResults.length} tool result(s)]`;
      }
    }
    if (text.trim()) {
      const truncated = text.length > 2e3 ? text.slice(0, 2e3) + "..." : text;
      historyParts.push(`${role}: ${truncated}`);
    }
  }
  if (historyParts.length === 0) {
    return null;
  }
  return historyParts.join("\n\n");
}
function getClaudeUserMessage(prompt, includeHistoryContext = false) {
  const content = [];
  if (includeHistoryContext) {
    const historyContext = compactConversationHistory(prompt);
    if (historyContext) {
      log.info("including conversation history context", {
        historyLength: historyContext.length
      });
      content.push({
        type: "text",
        text: `<conversation_history>
The following is a summary of our conversation so far (from a previous session that couldn't be resumed):

${historyContext}

</conversation_history>

Now continuing with the current message:

`
      });
    }
  }
  const messages = [];
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "assistant") break;
    messages.unshift(prompt[i]);
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "tool-result") {
            const p = part;
            let resultText = "";
            if (typeof p.result === "string") {
              resultText = p.result;
            } else if (typeof p.result === "object" && p.result && "output" in p.result) {
              resultText = String(p.result.output);
            } else {
              resultText = JSON.stringify(p.result);
            }
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: resultText
            });
          }
        }
      }
    }
  }
  if (content.length === 0) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "" }]
      }
    });
  }
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content
    }
  });
}

// src/session-manager.ts
var claudeSessions = /* @__PURE__ */ new Map();
function getClaudeSessionId(key) {
  return claudeSessions.get(key);
}
function setClaudeSessionId(key, sessionId) {
  claudeSessions.set(key, sessionId);
}
function deleteClaudeSessionId(key) {
  claudeSessions.delete(key);
}
function sessionKey(cwd, modelId, agentHash) {
  const base = `${cwd}::${modelId}`;
  return agentHash ? `${base}::${agentHash}` : base;
}

// src/claude-code-language-model.ts
var ClaudeCodeLanguageModel = class {
  specificationVersion = "v2";
  modelId;
  config;
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
  }
  supportedUrls = {};
  get provider() {
    return this.config.provider;
  }
  async runSqlite(dbPath, sql) {
    return new Promise((resolve) => {
      const proc = spawnChild("sqlite3", [dbPath, sql], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500
      });
      let stdout = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.on("close", () => resolve(stdout.trim()));
      proc.on("error", () => resolve(""));
    });
  }
  async resolveCwd(options) {
    if (this.config.cwd && this.config.cwd.trim().length > 0) {
      return this.config.cwd;
    }
    const providerOpts = options?.providerOptions;
    const claudeCodeOpts = providerOpts?.["claude-code"];
    const explicitCwd = claudeCodeOpts?.["cwd"];
    if (typeof explicitCwd === "string" && explicitCwd.trim().length > 0) {
      return explicitCwd;
    }
    const sessionID = claudeCodeOpts?.["sessionID"];
    if (typeof sessionID === "string" && /^[A-Za-z0-9_-]+$/.test(sessionID)) {
      try {
        const home = process.env.HOME;
        if (home) {
          const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
          if (existsSync(dbPath)) {
            const sql = `select directory from session where id='${sessionID}' limit 1;`;
            const dbCwd = await this.runSqlite(dbPath, sql);
            if (dbCwd.length > 0) return dbCwd;
          }
        }
      } catch {
      }
    }
    const runtimeCwd = process.cwd();
    if (runtimeCwd === "/") {
      try {
        const home = process.env.HOME;
        if (home) {
          const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
          if (existsSync(dbPath)) {
            const nowMs = Date.now();
            const fiveMinAgo = nowMs - 5 * 60 * 1e3;
            const sql = `select directory from session where directory != '/' and time_updated >= ${fiveMinAgo} order by time_updated desc limit 1;`;
            const recentDir = await this.runSqlite(dbPath, sql);
            if (recentDir.length > 0) return recentDir;
          }
        }
      } catch {
      }
    }
    return runtimeCwd;
  }
  hashSystemPrompt(prompt) {
    const systemMsg = prompt.find((m) => m.role === "system");
    if (!systemMsg) return "no-system";
    const content = typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content);
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  }
  requestScope(options) {
    return Array.isArray(options?.tools) ? "tools" : "no-tools";
  }
  latestUserText(prompt) {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i];
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        return String(msg.content).trim();
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text).trim()).filter(Boolean).join(" ");
        if (text) return text;
      }
    }
    return "";
  }
  synthesizeTitle(prompt) {
    const source = this.latestUserText(prompt).replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").trim();
    if (!source) return "New Session";
    const stop = /* @__PURE__ */ new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project"
    ]);
    const words = source.split(" ").map((word) => word.trim()).filter(Boolean).filter((word) => !stop.has(word.toLowerCase()));
    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean)).slice(0, 6).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    return picked || "New Session";
  }
  /**
   * Build SDK Options common to both doGenerate and doStream.
   */
  buildSdkOptions(cwd, sk, opts) {
    const sdkOpts = {
      model: this.modelId,
      cwd,
      includePartialMessages: true,
      persistSession: false
    };
    if (this.config.skipPermissions !== false) {
      sdkOpts.permissionMode = "bypassPermissions";
      sdkOpts.allowDangerouslySkipPermissions = true;
    }
    if (this.config.effort) {
      sdkOpts.effort = this.config.effort;
    }
    if (this.config.thinking) {
      sdkOpts.thinking = this.config.thinking;
    }
    if (this.config.maxTurns) {
      sdkOpts.maxTurns = this.config.maxTurns;
    }
    if (opts?.resume) {
      const existingSessionId = getClaudeSessionId(sk);
      if (existingSessionId) {
        sdkOpts.resume = existingSessionId;
      }
    }
    return sdkOpts;
  }
  /**
   * Extract the user-facing prompt text from the AI SDK prompt for the Agent SDK.
   */
  buildPromptText(prompt, includeHistoryContext) {
    const cliMsg = getClaudeUserMessage(prompt, includeHistoryContext);
    try {
      const parsed = JSON.parse(cliMsg);
      const content = parsed?.message?.content;
      if (Array.isArray(content)) {
        const texts = [];
        for (const part of content) {
          if (part.type === "text" && part.text) {
            texts.push(part.text);
          } else if (part.type === "tool_result") {
            texts.push(`[Tool result for ${part.tool_use_id}]: ${typeof part.content === "string" ? part.content : JSON.stringify(part.content)}`);
          }
        }
        return texts.join("\n\n");
      }
    } catch {
    }
    return this.latestUserText(prompt);
  }
  async doGenerate(options) {
    const warnings = [];
    const cwd = await this.resolveCwd(options);
    const scope = this.requestScope(options);
    const agentHash = this.hashSystemPrompt(options.prompt);
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, agentHash);
    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        },
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: this.modelId
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools"
          }
        },
        warnings
      };
    }
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const includeHistoryContext = !hasExistingSession && hasPriorConversation;
    const promptText = this.buildPromptText(options.prompt, includeHistoryContext);
    const sdkOpts = this.buildSdkOptions(cwd, sk, { resume: false });
    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: promptText.length,
      includeHistoryContext
    });
    let responseText = "";
    let thinkingText = "";
    const toolCalls = [];
    let resultMeta = {};
    const q = query({ prompt: promptText, options: sdkOpts });
    const TIMEOUT_MS = 3e5;
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        q.close();
        reject(new Error(`claude Agent SDK timed out after ${TIMEOUT_MS / 1e3}s`));
      }, TIMEOUT_MS);
    });
    try {
      await Promise.race([
        (async () => {
          for await (const msg of q) {
            const processed = this.processGenerateMessage(msg, sk);
            if (processed.text) responseText += processed.text;
            if (processed.thinking) thinkingText += processed.thinking;
            if (processed.toolCall) toolCalls.push(processed.toolCall);
            if (processed.result) resultMeta = processed.result;
          }
        })(),
        timeoutPromise
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    const content = [];
    if (thinkingText) {
      content.push({
        type: "reasoning",
        text: thinkingText
      });
    }
    if (responseText) {
      content.push({
        type: "text",
        text: responseText,
        providerMetadata: {
          "claude-code": {
            sessionId: resultMeta.sessionId ?? null,
            costUsd: resultMeta.costUsd ?? null,
            durationMs: resultMeta.durationMs ?? null
          }
        }
      });
    }
    for (const tc of toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip
      } = mapTool(tc.name, tc.args);
      if (skip) continue;
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed
      });
    }
    const usage = {
      inputTokens: resultMeta.usage?.input_tokens,
      outputTokens: resultMeta.usage?.output_tokens,
      totalTokens: resultMeta.usage?.input_tokens && resultMeta.usage?.output_tokens ? resultMeta.usage.input_tokens + resultMeta.usage.output_tokens : void 0
    };
    return {
      content,
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
      usage,
      request: { body: { text: promptText } },
      response: {
        id: resultMeta.sessionId ?? generateId(),
        timestamp: /* @__PURE__ */ new Date(),
        modelId: this.modelId
      },
      providerMetadata: {
        "claude-code": {
          sessionId: resultMeta.sessionId ?? null,
          costUsd: resultMeta.costUsd ?? null,
          durationMs: resultMeta.durationMs ?? null
        }
      },
      warnings
    };
  }
  /**
   * Process a single SDK message for doGenerate, extracting text/thinking/tool data.
   */
  processGenerateMessage(msg, sk) {
    const out = {};
    if (msg.type === "assistant") {
      const betaMsg = msg.message;
      if (betaMsg?.content) {
        for (const block of betaMsg.content) {
          if (block.type === "text" && block.text) {
            out.text = (out.text ?? "") + block.text;
          }
          if (block.type === "thinking" && block.thinking) {
            out.thinking = (out.thinking ?? "") + block.thinking;
          }
          if (block.type === "tool_use" && block.id && block.name) {
            if (block.name === "AskUserQuestion" || block.name === "ask_user_question") {
              const parsedInput = block.input ?? {};
              const question = parsedInput?.question || "Question?";
              out.text = (out.text ?? "") + `

_Asking: ${question}_

`;
            } else {
              out.toolCall = {
                id: block.id,
                name: block.name,
                args: block.input ?? {}
              };
            }
          }
        }
      }
    }
    if (msg.type === "user") {
    }
    if (msg.type === "result") {
      const resultMsg = msg;
      if (resultMsg.session_id) {
        setClaudeSessionId(sk, resultMsg.session_id);
      }
      out.result = {
        sessionId: resultMsg.session_id,
        costUsd: resultMsg.total_cost_usd,
        durationMs: resultMsg.duration_ms,
        usage: resultMsg.usage
      };
    }
    return out;
  }
  async doStream(options) {
    const warnings = [];
    const cwd = await this.resolveCwd(options);
    const scope = this.requestScope(options);
    const agentHash = this.hashSystemPrompt(options.prompt);
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, agentHash);
    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt);
      const textId = generateId();
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text
          });
          controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            },
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools"
              }
            }
          });
          controller.close();
        }
      });
      return {
        stream: stream2,
        request: { body: { text: "" } }
      };
    }
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const includeHistoryContext = !hasExistingSession && hasPriorConversation;
    const promptText = this.buildPromptText(options.prompt, includeHistoryContext);
    const sdkOpts = this.buildSdkOptions(cwd, sk, { resume: hasExistingSession });
    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: promptText.length,
      includeHistoryContext,
      hasExistingSession
    });
    const q = query({ prompt: promptText, options: sdkOpts });
    const self = this;
    const stream = new ReadableStream({
      async start(controller) {
        const textId = generateId();
        let textStarted = false;
        const reasoningIds = /* @__PURE__ */ new Map();
        const reasoningStarted = /* @__PURE__ */ new Map();
        const toolCallMap = /* @__PURE__ */ new Map();
        const toolCallsById = /* @__PURE__ */ new Map();
        let toolCallCount = 0;
        let resultMeta = {};
        let controllerClosed = false;
        const safeEnqueue = (part) => {
          if (!controllerClosed) controller.enqueue(part);
        };
        const safeClose = () => {
          if (!controllerClosed) {
            controllerClosed = true;
            try {
              controller.close();
            } catch {
            }
          }
        };
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            log.info("abort signal received, closing query", { cwd });
            q.close();
            safeClose();
          });
        }
        safeEnqueue({ type: "stream-start", warnings });
        try {
          for await (const msg of q) {
            if (controllerClosed) break;
            if (msg.type === "stream_event") {
              const event = msg.event;
              if (!event) continue;
              if (event.type === "content_block_start" && event.content_block) {
                const block = event.content_block;
                const idx = event.index ?? 0;
                if (block.type === "thinking") {
                  const reasoningId = generateId();
                  reasoningIds.set(idx, reasoningId);
                  safeEnqueue({ type: "reasoning-start", id: reasoningId });
                  reasoningStarted.set(idx, true);
                }
                if (block.type === "text") {
                  if (!textStarted) {
                    safeEnqueue({ type: "text-start", id: textId });
                    textStarted = true;
                  }
                }
                if (block.type === "tool_use" && block.id && block.name) {
                  toolCallMap.set(idx, {
                    id: block.id,
                    name: block.name,
                    inputJson: ""
                  });
                  if (block.name !== "AskUserQuestion" && block.name !== "ask_user_question") {
                    const { name: mappedName, skip } = mapTool(block.name);
                    if (!skip) {
                      safeEnqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName
                      });
                      log.info("tool started", {
                        name: block.name,
                        mappedName,
                        id: block.id
                      });
                    }
                  }
                }
              }
              if (event.type === "content_block_delta" && event.delta) {
                const delta = event.delta;
                const idx = event.index ?? 0;
                if (delta.type === "thinking_delta" && delta.thinking) {
                  const reasoningId = reasoningIds.get(idx);
                  if (reasoningId) {
                    safeEnqueue({
                      type: "reasoning-delta",
                      id: reasoningId,
                      delta: delta.thinking
                    });
                  }
                }
                if (delta.type === "text_delta" && delta.text) {
                  if (!textStarted) {
                    safeEnqueue({ type: "text-start", id: textId });
                    textStarted = true;
                  }
                  safeEnqueue({
                    type: "text-delta",
                    id: textId,
                    delta: delta.text
                  });
                }
                if (delta.type === "input_json_delta" && delta.partial_json) {
                  const tc = toolCallMap.get(idx);
                  if (tc) {
                    tc.inputJson += delta.partial_json;
                    safeEnqueue({
                      type: "tool-input-delta",
                      id: tc.id,
                      delta: delta.partial_json
                    });
                  }
                }
              }
              if (event.type === "content_block_stop") {
                const idx = event.index ?? 0;
                const reasoningId = reasoningIds.get(idx);
                if (reasoningId && reasoningStarted.get(idx)) {
                  safeEnqueue({ type: "reasoning-end", id: reasoningId });
                  reasoningStarted.delete(idx);
                }
                const tc = toolCallMap.get(idx);
                if (tc) {
                  let parsedInput = {};
                  let parseOk = true;
                  try {
                    parsedInput = JSON.parse(tc.inputJson || "{}");
                  } catch {
                    log.warn("failed to parse tool input JSON, skipping tool call", { toolName: tc.name, inputJson: tc.inputJson });
                    parseOk = false;
                  }
                  if (!parseOk) {
                    toolCallMap.delete(idx);
                  } else if (tc.name === "AskUserQuestion" || tc.name === "ask_user_question") {
                    let question = "Question?";
                    if (parsedInput?.questions && Array.isArray(parsedInput.questions) && parsedInput.questions.length > 0) {
                      question = parsedInput.questions[0].question || parsedInput.questions[0].text || "Question?";
                    } else {
                      question = parsedInput?.question || parsedInput?.text || "Question?";
                    }
                    if (!textStarted) {
                      safeEnqueue({ type: "text-start", id: textId });
                      textStarted = true;
                    }
                    safeEnqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `

_Asking: ${question}_

`
                    });
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip
                    } = mapTool(tc.name, parsedInput);
                    if (!skip) {
                      toolCallsById.set(tc.id, {
                        id: tc.id,
                        name: tc.name,
                        input: parsedInput
                      });
                      toolCallCount++;
                      safeEnqueue({
                        type: "tool-call",
                        toolCallId: tc.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed
                      });
                    }
                    log.info("tool call complete", {
                      name: tc.name,
                      mappedName,
                      id: tc.id,
                      executed
                    });
                  }
                }
              }
              continue;
            }
            if (msg.type === "assistant") {
              const betaMsg = msg.message;
              if (betaMsg?.content) {
                for (const block of betaMsg.content) {
                  if (block.type === "text" && block.text) {
                    if (!textStarted) {
                      safeEnqueue({ type: "text-start", id: textId });
                      textStarted = true;
                    }
                    safeEnqueue({
                      type: "text-delta",
                      id: textId,
                      delta: block.text
                    });
                  }
                  if (block.type === "thinking" && block.thinking) {
                    const thinkingId = generateId();
                    safeEnqueue({ type: "reasoning-start", id: thinkingId });
                    safeEnqueue({
                      type: "reasoning-delta",
                      id: thinkingId,
                      delta: block.thinking
                    });
                    safeEnqueue({ type: "reasoning-end", id: thinkingId });
                  }
                  if (block.type === "tool_use" && block.id && block.name) {
                    const parsedInput = block.input ?? {};
                    toolCallsById.set(block.id, {
                      id: block.id,
                      name: block.name,
                      input: parsedInput
                    });
                    if (block.name === "AskUserQuestion" || block.name === "ask_user_question") {
                      let question = "Question?";
                      if (parsedInput?.questions && Array.isArray(parsedInput.questions) && parsedInput.questions.length > 0) {
                        const qObj = parsedInput.questions[0];
                        question = qObj.question || qObj.text || "Question?";
                      } else {
                        question = parsedInput?.question || parsedInput?.text || "Question?";
                      }
                      if (!textStarted) {
                        safeEnqueue({ type: "text-start", id: textId });
                        textStarted = true;
                      }
                      safeEnqueue({
                        type: "text-delta",
                        id: textId,
                        delta: `

_Asking: ${question}_

`
                      });
                    } else {
                      const {
                        name: mappedName,
                        input: mappedInput,
                        executed,
                        skip
                      } = mapTool(block.name, parsedInput);
                      if (!skip) {
                        toolCallCount++;
                        safeEnqueue({
                          type: "tool-input-start",
                          id: block.id,
                          toolName: mappedName
                        });
                        safeEnqueue({
                          type: "tool-call",
                          toolCallId: block.id,
                          toolName: mappedName,
                          input: JSON.stringify(mappedInput),
                          providerExecuted: executed
                        });
                      }
                    }
                  }
                }
              }
              continue;
            }
            if (msg.type === "user") {
              const userMsg = msg.message;
              const content = userMsg?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_result" && block.tool_use_id) {
                    const toolCall = toolCallsById.get(block.tool_use_id);
                    if (toolCall) {
                      let resultText = "";
                      if (typeof block.content === "string") {
                        resultText = block.content;
                      } else if (Array.isArray(block.content)) {
                        resultText = block.content.filter(
                          (c) => c.type === "text" && typeof c.text === "string"
                        ).map((c) => c.text).join("\n");
                      }
                      safeEnqueue({
                        type: "tool-result",
                        toolCallId: block.tool_use_id,
                        toolName: toolCall.name,
                        result: {
                          output: resultText,
                          title: toolCall.name,
                          metadata: {}
                        },
                        providerExecuted: true
                      });
                      log.info("tool result emitted", {
                        toolUseId: block.tool_use_id,
                        name: toolCall.name
                      });
                      toolCallsById.delete(block.tool_use_id);
                    }
                  }
                }
              }
              continue;
            }
            if (msg.type === "result") {
              const resultMsg = msg;
              if (resultMsg.session_id) {
                setClaudeSessionId(sk, resultMsg.session_id);
              }
              resultMeta = {
                sessionId: resultMsg.session_id,
                costUsd: resultMsg.total_cost_usd,
                durationMs: resultMsg.duration_ms,
                usage: resultMsg.usage
              };
              log.info("conversation result", {
                sessionId: resultMsg.session_id,
                durationMs: resultMsg.duration_ms,
                numTurns: resultMsg.num_turns,
                isError: resultMsg.is_error
              });
              if (textStarted) {
                safeEnqueue({ type: "text-end", id: textId });
              }
              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  safeEnqueue({ type: "reasoning-end", id: reasoningId });
                }
              }
              safeEnqueue({
                type: "finish",
                finishReason: toolCallCount > 0 ? "tool-calls" : "stop",
                usage: {
                  inputTokens: resultMsg.usage?.input_tokens,
                  outputTokens: resultMsg.usage?.output_tokens,
                  totalTokens: resultMsg.usage?.input_tokens && resultMsg.usage?.output_tokens ? resultMsg.usage.input_tokens + resultMsg.usage.output_tokens : void 0
                },
                providerMetadata: {
                  "claude-code": resultMeta
                }
              });
              safeClose();
              continue;
            }
            log.debug("unhandled SDK message type", { type: msg.type });
          }
        } catch (err) {
          log.error("stream error", { error: err instanceof Error ? err.message : String(err) });
          if (!controllerClosed) {
            safeEnqueue({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
            safeClose();
          }
        }
        if (!controllerClosed) {
          if (textStarted) {
            safeEnqueue({ type: "text-end", id: textId });
          }
          safeEnqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: void 0,
              outputTokens: void 0,
              totalTokens: void 0
            },
            providerMetadata: {
              "claude-code": resultMeta
            }
          });
          safeClose();
        }
      },
      cancel() {
        q.close();
      }
    });
    return {
      stream,
      request: { body: { text: promptText } },
      response: { headers: {} }
    };
  }
};

// src/index.ts
function createClaudeCode(settings = {}) {
  const cliPath = settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude";
  const providerName = settings.name ?? "claude-code";
  const createModel = (modelId) => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      // Keep undefined unless explicitly configured.
      // The model resolves cwd lazily per request so it tracks the active
      // OpenCode project directory instead of provider init-time process cwd.
      cwd: settings.cwd,
      skipPermissions: settings.skipPermissions ?? true,
      effort: settings.effort,
      thinking: settings.thinking,
      maxTurns: settings.maxTurns
    });
  };
  const provider = function(modelId) {
    return createModel(modelId);
  };
  provider.languageModel = createModel;
  provider.textEmbeddingModel = () => {
    throw new Error("textEmbeddingModel is not supported by claude-code provider");
  };
  provider.imageModel = () => {
    throw new Error("imageModel is not supported by claude-code provider");
  };
  return provider;
}
export {
  ClaudeCodeLanguageModel,
  createClaudeCode
};
//# sourceMappingURL=index.js.map
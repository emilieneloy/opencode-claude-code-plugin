// src/claude-code-language-model.ts
import { generateId } from "@ai-sdk/provider-utils";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

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
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
var activeProcesses = /* @__PURE__ */ new Map();
var claudeSessions = /* @__PURE__ */ new Map();
function getActiveProcess(key) {
  return activeProcesses.get(key);
}
function deleteActiveProcess(key) {
  const ap = activeProcesses.get(key);
  if (ap) {
    ap.proc.kill();
    activeProcesses.delete(key);
  }
}
function getClaudeSessionId(key) {
  return claudeSessions.get(key);
}
function setClaudeSessionId(key, sessionId) {
  claudeSessions.set(key, sessionId);
}
function deleteClaudeSessionId(key) {
  claudeSessions.delete(key);
}
function spawnClaudeProcess(cliPath, cliArgs, cwd, sessionKey2) {
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey: sessionKey2 });
  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" }
  });
  const lineEmitter = new EventEmitter();
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    lineEmitter.emit("line", line);
  });
  rl.on("close", () => {
    lineEmitter.emit("close");
  });
  const ap = { proc, lineEmitter };
  activeProcesses.set(sessionKey2, ap);
  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey: sessionKey2 });
    activeProcesses.delete(sessionKey2);
    if (code !== 0 && code !== null) {
      log.info("process exited with error, clearing session", {
        code,
        sessionKey: sessionKey2
      });
      claudeSessions.delete(sessionKey2);
    }
  });
  proc.stderr?.on("data", (data) => {
    const stderr = data.toString();
    log.debug("stderr", { data: stderr.slice(0, 200) });
    if (stderr.includes("Session ID") && (stderr.includes("already in use") || stderr.includes("not found") || stderr.includes("invalid"))) {
      log.warn("claude session ID error, clearing session", {
        sessionKey: sessionKey2,
        error: stderr.slice(0, 200)
      });
      claudeSessions.delete(sessionKey2);
    }
  });
  return ap;
}
function buildCliArgs(opts) {
  const { sessionKey: sessionKey2, skipPermissions, includeSessionId = true, model } = opts;
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose"
  ];
  if (model) {
    args.push("--model", model);
  }
  if (includeSessionId) {
    const sessionId = claudeSessions.get(sessionKey2);
    if (sessionId && !activeProcesses.has(sessionKey2)) {
      args.push("--session-id", sessionId);
    }
  }
  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
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
  resolveCwd(options) {
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
            const res = spawnSync("sqlite3", [dbPath, sql], {
              encoding: "utf8",
              timeout: 1500
            });
            const dbCwd = (res.stdout ?? "").trim();
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
            const res = spawnSync("sqlite3", [dbPath, sql], {
              encoding: "utf8",
              timeout: 1500
            });
            const recentDir = (res.stdout ?? "").trim();
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
  async doGenerate(options) {
    const warnings = [];
    const cwd = this.resolveCwd(options);
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
      deleteActiveProcess(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const includeHistoryContext = !hasExistingSession && hasPriorConversation;
    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext);
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId
    });
    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext
    });
    const { spawn: spawn2 } = await import("child_process");
    const { createInterface: createInterface2 } = await import("readline");
    const proc = spawn2(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" }
    });
    const rl = createInterface2({ input: proc.stdout });
    let responseText = "";
    let thinkingText = "";
    let resultMeta = {};
    const toolCalls = [];
    const result = await new Promise((resolve, reject) => {
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id);
            }
          }
          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text;
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking;
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (block.name === "AskUserQuestion" || block.name === "ask_user_question") {
                  const parsedInput = block.input ?? {};
                  const question = parsedInput?.question || "Question?";
                  responseText += `

_Asking: ${question}_

`;
                  continue;
                }
                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {},
                  inputJson: ""
                });
              }
            }
          }
          if (msg.type === "content_block_start" && msg.content_block) {
            if (msg.content_block.type === "tool_use" && msg.content_block.id && msg.content_block.name) {
              toolCalls.push({
                id: msg.content_block.id,
                name: msg.content_block.name,
                args: {},
                inputJson: ""
              });
            }
          }
          if (msg.type === "content_block_delta" && msg.delta) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text;
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking;
            }
            if (msg.delta.type === "input_json_delta" && msg.delta.partial_json && msg.index !== void 0) {
              const tc = toolCalls[msg.index];
              if (tc) {
                tc.inputJson += msg.delta.partial_json;
              }
            }
          }
          if (msg.type === "content_block_stop" && msg.index !== void 0) {
            const tc = toolCalls[msg.index];
            if (tc && tc.inputJson) {
              try {
                tc.args = JSON.parse(tc.inputJson);
              } catch {
              }
            }
          }
          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id);
            }
            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              usage: msg.usage
            };
            resolve({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls
            });
          }
        } catch {
        }
      });
      rl.on("close", () => {
        resolve({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls
        });
      });
      proc.on("error", (err) => {
        log.error("process error", { error: err.message });
        proc.kill();
        reject(err);
      });
      proc.stderr?.on("data", (data) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) });
      });
      proc.stdin?.write(userMsg + "\n");
      proc.stdin?.end();
    });
    const content = [];
    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking
      });
    }
    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null
          }
        }
      });
    }
    for (const tc of result.toolCalls) {
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
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      totalTokens: result.usage?.input_tokens && result.usage?.output_tokens ? result.usage.input_tokens + result.usage.output_tokens : void 0
    };
    return {
      content,
      finishReason: result.toolCalls.length > 0 ? "tool-calls" : "stop",
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: /* @__PURE__ */ new Date(),
        modelId: this.modelId
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null
        }
      },
      warnings
    };
  }
  async doStream(options) {
    const warnings = [];
    const cwd = this.resolveCwd(options);
    const cliPath = this.config.cliPath;
    const skipPermissions = this.config.skipPermissions !== false;
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
      deleteActiveProcess(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const hasActiveProcess = !!getActiveProcess(sk);
    const includeHistoryContext = !hasExistingSession && !hasActiveProcess && hasPriorConversation;
    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext);
    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
      maxOutputTokens: options?.maxOutputTokens ?? null
    });
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions,
      model: this.modelId
    });
    const stream = new ReadableStream({
      start(controller) {
        let activeProcess = getActiveProcess(sk);
        let proc;
        let lineEmitter;
        if (activeProcess) {
          proc = activeProcess.proc;
          lineEmitter = activeProcess.lineEmitter;
          log.debug("reusing active process", { sk });
        } else {
          const ap = spawnClaudeProcess(cliPath, cliArgs, cwd, sk);
          proc = ap.proc;
          lineEmitter = ap.lineEmitter;
        }
        controller.enqueue({ type: "stream-start", warnings });
        const textId = generateId();
        let textStarted = false;
        const reasoningIds = /* @__PURE__ */ new Map();
        const reasoningStarted = /* @__PURE__ */ new Map();
        let turnCompleted = false;
        let controllerClosed = false;
        const toolCallMap = /* @__PURE__ */ new Map();
        const toolCallsById = /* @__PURE__ */ new Map();
        let resultMeta = {};
        const lineHandler = (line) => {
          if (!line.trim()) return;
          if (controllerClosed) return;
          try {
            const msg = JSON.parse(line);
            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype
            });
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id);
                log.info("session initialized", {
                  claudeSessionId: msg.session_id
                });
              }
            }
            if (msg.type === "content_block_start" && msg.content_block && msg.index !== void 0) {
              const block = msg.content_block;
              const idx = msg.index;
              if (block.type === "thinking") {
                const reasoningId = generateId();
                reasoningIds.set(idx, reasoningId);
                controller.enqueue({
                  type: "reasoning-start",
                  id: reasoningId
                });
                reasoningStarted.set(idx, true);
              }
              if (block.type === "text") {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId
                  });
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
                    controller.enqueue({
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
            if (msg.type === "content_block_delta" && msg.delta && msg.index !== void 0) {
              const delta = msg.delta;
              const idx = msg.index;
              if (delta.type === "thinking_delta" && delta.thinking) {
                const reasoningId = reasoningIds.get(idx);
                if (reasoningId) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking
                  });
                }
              }
              if (delta.type === "text_delta" && delta.text) {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId
                  });
                  textStarted = true;
                }
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: delta.text
                });
              }
              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx);
                if (tc) {
                  tc.inputJson += delta.partial_json;
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: delta.partial_json
                  });
                }
              }
            }
            if (msg.type === "content_block_stop" && msg.index !== void 0) {
              const idx = msg.index;
              const reasoningId = reasoningIds.get(idx);
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId
                });
                reasoningStarted.delete(idx);
              }
              const tc = toolCallMap.get(idx);
              if (tc) {
                let parsedInput = {};
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}");
                } catch {
                }
                if (tc.name === "AskUserQuestion" || tc.name === "ask_user_question") {
                  let question = "Question?";
                  if (parsedInput?.questions && Array.isArray(parsedInput.questions) && parsedInput.questions.length > 0) {
                    question = parsedInput.questions[0].question || parsedInput.questions[0].text || "Question?";
                  } else {
                    question = parsedInput?.question || parsedInput?.text || "Question?";
                  }
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId
                    });
                    textStarted = true;
                  }
                  controller.enqueue({
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
                    controller.enqueue({
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
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId
                    });
                    textStarted = true;
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: block.text
                  });
                }
                if (block.type === "thinking" && block.thinking) {
                  const thinkingId = generateId();
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId
                  });
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking
                  });
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId
                  });
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
                      const q = parsedInput.questions[0];
                      question = q.question || q.text || "Question?";
                    } else {
                      question = parsedInput?.question || parsedInput?.text || "Question?";
                    }
                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId
                      });
                      textStarted = true;
                    }
                    controller.enqueue({
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
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName
                      });
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed
                      });
                    }
                    log.info("tool_use from assistant message", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                      executed
                    });
                  }
                }
                if (block.type === "tool_result") {
                  log.debug("tool_result", {
                    toolUseId: block.tool_use_id
                  });
                }
              }
            }
            if (msg.type === "user" && msg.message?.content) {
              for (const block of msg.message.content) {
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
                    controller.enqueue({
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
            if (msg.type === "result") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id);
              }
              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage
              };
              log.info("conversation result", {
                sessionId: msg.session_id,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                isError: msg.is_error
              });
              turnCompleted = true;
              if (textStarted) {
                controller.enqueue({ type: "text-end", id: textId });
              }
              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId
                  });
                }
              }
              controller.enqueue({
                type: "finish",
                finishReason: toolCallMap.size > 0 ? "tool-calls" : "stop",
                usage: {
                  inputTokens: msg.usage?.input_tokens,
                  outputTokens: msg.usage?.output_tokens,
                  totalTokens: msg.usage?.input_tokens && msg.usage?.output_tokens ? msg.usage.input_tokens + msg.usage.output_tokens : void 0
                },
                providerMetadata: {
                  "claude-code": resultMeta
                }
              });
              controllerClosed = true;
              lineEmitter.off("line", lineHandler);
              lineEmitter.off("close", closeHandler);
              try {
                controller.close();
              } catch {
              }
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error: e instanceof Error ? e.message : String(e)
            });
          }
        };
        const closeHandler = () => {
          log.debug("readline closed");
          if (controllerClosed) return;
          controllerClosed = true;
          lineEmitter.off("line", lineHandler);
          lineEmitter.off("close", closeHandler);
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textId });
          }
          controller.enqueue({
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
          try {
            controller.close();
          } catch {
          }
        };
        lineEmitter.on("line", lineHandler);
        lineEmitter.on("close", closeHandler);
        proc.on("error", (err) => {
          log.error("process error", { error: err.message });
          if (controllerClosed) return;
          controllerClosed = true;
          controller.enqueue({ type: "error", error: err });
          try {
            controller.close();
          } catch {
          }
        });
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            if (!turnCompleted) {
              log.info(
                "abort signal received mid-turn, keeping process alive",
                { cwd }
              );
            }
            if (!controllerClosed) {
              controllerClosed = true;
              lineEmitter.off("line", lineHandler);
              lineEmitter.off("close", closeHandler);
              try {
                controller.close();
              } catch {
              }
            }
          });
        }
        proc.stdin?.write(userMsg + "\n");
        log.debug("sent user message", { textLength: userMsg.length });
      },
      cancel() {
      }
    });
    return {
      stream,
      request: { body: { text: userMsg } },
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
      skipPermissions: settings.skipPermissions ?? true
    });
  };
  const provider = function(modelId) {
    return createModel(modelId);
  };
  provider.languageModel = createModel;
  return provider;
}
export {
  ClaudeCodeLanguageModel,
  createClaudeCode
};
//# sourceMappingURL=index.js.map
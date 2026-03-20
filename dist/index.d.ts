import { LanguageModelV2, ProviderV2 } from '@ai-sdk/provider';

interface ClaudeCodeConfig {
    provider: string;
    cliPath: string;
    cwd?: string;
    skipPermissions?: boolean;
}
interface ClaudeCodeProviderSettings {
    cliPath?: string;
    cwd?: string;
    name?: string;
    skipPermissions?: boolean;
}
/**
 * Claude CLI stream-json message types.
 */
interface ClaudeStreamMessage {
    type: string;
    subtype?: string;
    message?: {
        role?: string;
        model?: string;
        content?: Array<{
            type: string;
            text?: string;
            name?: string;
            input?: unknown;
            id?: string;
            tool_use_id?: string;
            content?: string | Array<{
                type: string;
                text?: string;
            }>;
            thinking?: string;
        }>;
    };
    tool?: {
        name?: string;
        id?: string;
        input?: unknown;
    };
    tool_result?: {
        tool_use_id?: string;
        content?: string | Array<{
            type: string;
            text?: string;
        }>;
        is_error?: boolean;
    };
    session_id?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    request_id?: string;
    id?: string;
    result?: string;
    is_error?: boolean;
    num_turns?: number;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    content_block?: {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: string;
        thinking?: string;
    };
    delta?: {
        type: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
    };
    index?: number;
}

declare class ClaudeCodeLanguageModel implements LanguageModelV2 {
    readonly specificationVersion = "v2";
    readonly modelId: string;
    private readonly config;
    constructor(modelId: string, config: ClaudeCodeConfig);
    readonly supportedUrls: Record<string, RegExp[]>;
    get provider(): string;
    private resolveCwd;
    private hashSystemPrompt;
    private requestScope;
    private latestUserText;
    private synthesizeTitle;
    doGenerate(options: Parameters<LanguageModelV2["doGenerate"]>[0]): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>>;
    doStream(options: Parameters<LanguageModelV2["doStream"]>[0]): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>>;
}

interface ClaudeCodeProvider extends ProviderV2 {
    (modelId: string): LanguageModelV2;
    languageModel(modelId: string): LanguageModelV2;
}
declare function createClaudeCode(settings?: ClaudeCodeProviderSettings): ClaudeCodeProvider;

export { type ClaudeCodeConfig, ClaudeCodeLanguageModel, type ClaudeCodeProvider, type ClaudeCodeProviderSettings, type ClaudeStreamMessage, createClaudeCode };

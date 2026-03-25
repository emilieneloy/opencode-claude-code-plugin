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

declare class ClaudeCodeLanguageModel implements LanguageModelV2 {
    readonly specificationVersion = "v2";
    readonly modelId: string;
    private readonly config;
    constructor(modelId: string, config: ClaudeCodeConfig);
    readonly supportedUrls: Record<string, RegExp[]>;
    get provider(): string;
    private runSqlite;
    private resolveCwd;
    private hashSystemPrompt;
    private requestScope;
    private latestUserText;
    private synthesizeTitle;
    /**
     * Build SDK Options common to both doGenerate and doStream.
     */
    private buildSdkOptions;
    /**
     * Extract the user-facing prompt text from the AI SDK prompt for the Agent SDK.
     */
    private buildPromptText;
    doGenerate(options: Parameters<LanguageModelV2["doGenerate"]>[0]): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>>;
    /**
     * Process a single SDK message for doGenerate, extracting text/thinking/tool data.
     */
    private processGenerateMessage;
    doStream(options: Parameters<LanguageModelV2["doStream"]>[0]): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>>;
}

interface ClaudeCodeProvider extends ProviderV2 {
    (modelId: string): LanguageModelV2;
    languageModel(modelId: string): LanguageModelV2;
}
declare function createClaudeCode(settings?: ClaudeCodeProviderSettings): ClaudeCodeProvider;

export { type ClaudeCodeConfig, ClaudeCodeLanguageModel, type ClaudeCodeProvider, type ClaudeCodeProviderSettings, createClaudeCode };

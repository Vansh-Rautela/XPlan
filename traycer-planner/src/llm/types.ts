// src/llm/types.ts

export type JsonSchema = { [key: string]: unknown };

export interface ToolSpec {
    name: string;
    description: string;
    parameters: JsonSchema;
}

export interface ToolCall {
    name: string;
    args: Record<string, unknown>;
}

export type ChatMessage =
    | { role: 'user'; content: string }
    /** `raw` is the provider's own message, replayed verbatim (e.g. Gemini thought signatures). */
    | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown }
    | { role: 'tool'; name: string; content: string };

export interface ChatRequest {
    system: string;
    messages: ChatMessage[];
    /** Ask the provider for JSON conforming to this schema (native structured output). */
    jsonSchema?: JsonSchema;
    tools?: ToolSpec[];
    temperature?: number;
    signal?: AbortSignal;
}

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
}

export interface ChatResponse {
    text: string;
    toolCalls: ToolCall[];
    raw?: unknown;
    usage?: Usage;
    /** Normalised: 'stop' | 'length' | provider-specific value. */
    finishReason?: string;
    /** The prompt filled the model's context window, so the provider may have dropped part of it. */
    contextOverflow?: boolean;
}

export type ProviderName = 'gemini' | 'ollama';

export interface LLMProvider {
    readonly name: ProviderName;
    readonly model: string;
    /** True when prompts leave this machine. */
    readonly remote: boolean;
    chat(request: ChatRequest): Promise<ChatResponse>;
    listModels(signal?: AbortSignal): Promise<string[]>;
}

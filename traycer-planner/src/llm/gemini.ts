// src/llm/gemini.ts
// Google Gemini via the generateContent REST API. The API key is sent in the
// `x-goog-api-key` header (never in the URL).
import { ProviderError } from '../errors.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { requestJson, type FetchLike } from './http.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, ToolCall } from './types.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    timeoutMs: number;
    retries: number;
    seed?: number;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    logger?: Logger;
}

interface GeminiPart {
    text?: string;
    thought?: boolean;
    functionCall?: { name: string; args?: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
    [key: string]: unknown;
}

interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

interface GeminiResponse {
    candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function isGeminiContent(value: unknown): value is GeminiContent {
    return !!value && typeof value === 'object' && Array.isArray((value as GeminiContent).parts);
}

export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
        const last = contents[contents.length - 1];
        // Gemini expects alternating turns; merge consecutive same-role parts (e.g. several tool results).
        if (last && last.role === role) last.parts.push(...parts);
        else contents.push({ role, parts: [...parts] });
    };
    for (const message of messages) {
        if (message.role === 'user') {
            push('user', [{ text: message.content }]);
        } else if (message.role === 'tool') {
            push('user', [{ functionResponse: { name: message.name, response: { content: message.content } } }]);
        } else if (isGeminiContent(message.raw)) {
            // Replay the model turn verbatim so thought signatures survive.
            push('model', message.raw.parts);
        } else {
            const parts: GeminiPart[] = [];
            if (message.content) parts.push({ text: message.content });
            for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.args } });
            push('model', parts.length ? parts : [{ text: '' }]);
        }
    }
    return contents;
}

export class GeminiProvider implements LLMProvider {
    readonly name = 'gemini' as const;
    readonly remote = true;
    readonly model: string;
    private readonly baseUrl: string;
    private readonly logger: Logger;
    /** Set when the model rejected `responseJsonSchema`; we then rely on prompt + validation. */
    private schemaUnsupported = false;

    constructor(private readonly options: GeminiOptions) {
        this.model = options.model;
        this.baseUrl = (options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.logger = options.logger ?? silentLogger;
    }

    private http(signal?: AbortSignal) {
        return {
            provider: 'Gemini',
            timeoutMs: this.options.timeoutMs,
            retries: this.options.retries,
            signal,
            fetchImpl: this.options.fetchImpl,
            sleep: this.options.sleep,
            headers: { 'x-goog-api-key': this.options.apiKey },
            onRetry: ({ attempt, delayMs, reason }: { attempt: number; delayMs: number; reason: string }) =>
                this.logger.warn(`Gemini ${reason}; retry ${attempt}/${this.options.retries} in ${(delayMs / 1000).toFixed(1)}s`),
            mapError: (status: number, message: string) => {
                if (status === 401 || status === 403 || /api key not valid|API_KEY_INVALID/i.test(message)) {
                    return new ProviderError('auth', `Gemini rejected the API key (HTTP ${status})`, { status, hint: 'Check GEMINI_API_KEY (or GOOGLE_API_KEY).' });
                }
                if (status === 404) {
                    return new ProviderError('model_not_found', `Gemini model "${this.model}" was not found: ${message}`, {
                        status,
                        hint: 'Run `xplan doctor --provider gemini` to list available models, then pass --model or set GEMINI_MODEL.',
                    });
                }
                if (status === 429) {
                    return new ProviderError('rate_limit', `Gemini rate limit or quota exceeded: ${message}`, { status, hint: 'Wait and retry, raise --retries, or use a different model/project quota.' });
                }
                return undefined;
            },
        };
    }

    async chat(request: ChatRequest): Promise<ChatResponse> {
        const useSchema = !!request.jsonSchema && !this.schemaUnsupported;
        const body = this.buildBody(request, useSchema);
        const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;

        let json: GeminiResponse;
        try {
            json = (await requestJson('POST', url, { ...this.http(request.signal), body })) as GeminiResponse;
        } catch (error) {
            if (useSchema && error instanceof ProviderError && error.kind === 'bad_request' && /schema/i.test(error.message)) {
                this.schemaUnsupported = true;
                this.logger.warn(`Gemini model "${this.model}" rejected responseJsonSchema; falling back to prompt-only JSON with validation.`);
                json = (await requestJson('POST', url, { ...this.http(request.signal), body: this.buildBody(request, false) })) as GeminiResponse;
            } else {
                throw error;
            }
        }
        return this.parseResponse(json);
    }

    private buildBody(request: ChatRequest, useSchema: boolean): Record<string, unknown> {
        const generationConfig: Record<string, unknown> = { temperature: request.temperature ?? 0.2 };
        if (this.options.seed !== undefined) generationConfig.seed = this.options.seed;
        if (request.jsonSchema) {
            generationConfig.responseMimeType = 'application/json';
            if (useSchema) generationConfig.responseJsonSchema = request.jsonSchema;
        }
        const body: Record<string, unknown> = {
            systemInstruction: { parts: [{ text: request.system }] },
            contents: toGeminiContents(request.messages),
            generationConfig,
        };
        if (request.tools?.length) {
            body.tools = [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
        }
        return body;
    }

    private parseResponse(json: GeminiResponse): ChatResponse {
        const candidate = json.candidates?.[0];
        if (!candidate) {
            const reason = json.promptFeedback?.blockReason;
            throw new ProviderError(reason ? 'blocked' : 'invalid_response', reason ? `Gemini blocked the prompt (${reason})` : 'Gemini returned no candidates');
        }
        if (candidate.finishReason && BLOCKED_FINISH.has(candidate.finishReason)) {
            throw new ProviderError('blocked', `Gemini stopped generation (${candidate.finishReason})`);
        }
        const parts = candidate.content?.parts ?? [];
        const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
        const toolCalls: ToolCall[] = parts
            .filter(p => p.functionCall)
            .map(p => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
        return {
            text,
            toolCalls,
            raw: candidate.content,
            finishReason: candidate.finishReason === 'MAX_TOKENS' ? 'length' : candidate.finishReason?.toLowerCase(),
            usage: { inputTokens: json.usageMetadata?.promptTokenCount, outputTokens: json.usageMetadata?.candidatesTokenCount },
        };
    }

    async listModels(signal?: AbortSignal): Promise<string[]> {
        const json = (await requestJson('GET', `${this.baseUrl}/models?pageSize=1000`, this.http(signal))) as {
            models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
        };
        return (json.models ?? [])
            .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            .map(m => (m.name ?? '').replace(/^models\//, ''))
            .filter(Boolean);
    }
}

// src/llm/ollama.ts
// Local models via the Ollama HTTP API (/api/chat). Nothing leaves the machine unless
// OLLAMA_HOST points at a remote server.
import { ProviderError } from '../errors.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { requestJson, requestNdjson, type FetchLike } from './http.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider } from './types.js';

export const OLLAMA_DEFAULT_MODEL = 'qwen3';
export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_NUM_CTX = 16384;
/** Conservative average for code and JSON; used only for the pre-flight estimate. */
export const CHARS_PER_TOKEN = 3.2;

/** Rough token estimate for a request body (messages + schema + tools). */
export function estimateTokens(body: Record<string, unknown>): number {
    const chars = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.format ?? '').length + JSON.stringify(body.tools ?? '').length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface OllamaOptions {
    host: string;
    model: string;
    timeoutMs: number;
    retries: number;
    /** Context window. Ollama's default is small and silently truncates long prompts. */
    numCtx: number;
    seed?: number;
    keepAlive?: string;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    logger?: Logger;
}

/** Accepts the same forms as Ollama's own OLLAMA_HOST: `host`, `host:port`, `http(s)://host[:port]`. */
export function normalizeOllamaHost(value: string | undefined): string {
    let host = (value ?? '').trim();
    if (!host) return OLLAMA_DEFAULT_HOST;
    if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
    const url = new URL(host);
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
    if (!url.port && url.protocol === 'http:') url.port = '11434';
    return url.toString().replace(/\/+$/, '');
}

export function isLocalHost(host: string): boolean {
    const { hostname } = new URL(host);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
    tool_name?: string;
}

interface OllamaChatChunk {
    message?: Partial<OllamaMessage> & { thinking?: string };
    done?: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
}

export function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[] {
    const out: OllamaMessage[] = [{ role: 'system', content: system }];
    for (const m of messages) {
        if (m.role === 'user') out.push({ role: 'user', content: m.content });
        else if (m.role === 'tool') out.push({ role: 'tool', tool_name: m.name, content: m.content });
        else {
            const msg: OllamaMessage = { role: 'assistant', content: m.content };
            if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.args } }));
            out.push(msg);
        }
    }
    return out;
}

/** Combines streamed /api/chat chunks into one response. */
export function aggregateChunks(chunks: OllamaChatChunk[]): ChatResponse {
    if (chunks.length === 0) throw new ProviderError('invalid_response', 'Ollama returned an empty response');
    let text = '';
    const toolCalls: ChatResponse['toolCalls'] = [];
    for (const chunk of chunks) {
        text += chunk.message?.content ?? '';
        for (const call of chunk.message?.tool_calls ?? []) {
            toolCalls.push({ name: call.function.name, args: call.function.arguments ?? {} });
        }
    }
    const last = chunks[chunks.length - 1]!;
    if (!last.done) throw new ProviderError('invalid_response', 'Ollama stream ended before completion');
    return {
        text,
        toolCalls,
        raw: { role: 'assistant', content: text },
        finishReason: last.done_reason === 'length' ? 'length' : last.done_reason,
        usage: { inputTokens: last.prompt_eval_count, outputTokens: last.eval_count },
    };
}

export class OllamaProvider implements LLMProvider {
    readonly name = 'ollama' as const;
    readonly model: string;
    readonly remote: boolean;
    private readonly logger: Logger;

    constructor(private readonly options: OllamaOptions) {
        this.model = options.model;
        this.remote = !isLocalHost(options.host);
        this.logger = options.logger ?? silentLogger;
    }

    private http(signal?: AbortSignal) {
        return {
            provider: 'Ollama',
            timeoutMs: this.options.timeoutMs,
            retries: this.options.retries,
            signal,
            fetchImpl: this.options.fetchImpl,
            sleep: this.options.sleep,
            connectionHint: `Is Ollama running? Start it with \`ollama serve\`, or set OLLAMA_HOST (currently ${this.options.host}).`,
            onRetry: ({ attempt, delayMs, reason }: { attempt: number; delayMs: number; reason: string }) =>
                this.logger.warn(`Ollama ${reason}; retry ${attempt}/${this.options.retries} in ${(delayMs / 1000).toFixed(1)}s`),
            mapError: (status: number, message: string) => {
                if (status === 404 || /model .* not found|not found, try pulling/i.test(message)) {
                    return new ProviderError('model_not_found', `Ollama model "${this.model}" is not available locally`, {
                        status,
                        hint: `Run \`ollama pull ${this.model}\`, or choose an installed model with --model / OLLAMA_MODEL (see \`xplan doctor\`).`,
                    });
                }
                if (/does not support tools/i.test(message)) {
                    return new ProviderError('tools_unsupported', `Ollama model "${this.model}" does not support tool calling`, { status });
                }
                return undefined;
            },
        };
    }

    async chat(request: ChatRequest): Promise<ChatResponse> {
        const options: Record<string, unknown> = { temperature: request.temperature ?? 0.2, num_ctx: this.options.numCtx };
        if (this.options.seed !== undefined) options.seed = this.options.seed;
        const body: Record<string, unknown> = {
            model: this.model,
            messages: toOllamaMessages(request.system, request.messages),
            // Streaming makes Ollama send headers when generation starts; with stream=false a slow
            // local model can exceed fetch's fixed 300 s header timeout. Chunks are aggregated below.
            stream: true,
            options,
        };
        if (request.jsonSchema) body.format = request.jsonSchema;
        if (request.tools?.length) {
            body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        }
        if (this.options.keepAlive) body.keep_alive = this.options.keepAlive;

        // Ollama silently truncates prompts longer than num_ctx, so the model may never see the
        // instructions or the code. Warn before sending, and detect it afterwards from the
        // reported prompt token count.
        const numCtx = this.options.numCtx;
        const estimated = estimateTokens(body);
        if (estimated > numCtx * 0.9) {
            this.logger.warn(`Prompt is ~${estimated.toLocaleString()} tokens, near or above num_ctx ${numCtx.toLocaleString()}; Ollama truncates silently. Raise --num-ctx or lower --max-context-chars.`);
        }

        const chunks = (await requestNdjson(`${this.options.host}/api/chat`, { ...this.http(request.signal), body })) as OllamaChatChunk[];
        const response = aggregateChunks(chunks);
        const used = (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
        if ((response.usage?.inputTokens ?? 0) >= numCtx - 64 || used >= numCtx) {
            response.contextOverflow = true;
            this.logger.warn(`Ollama filled the ${numCtx.toLocaleString()}-token context window (${response.usage?.inputTokens ?? '?'} prompt + ${response.usage?.outputTokens ?? '?'} output tokens); part of the prompt or answer was likely cut off.`);
        }
        return response;
    }

    async listModels(signal?: AbortSignal): Promise<string[]> {
        const json = (await requestJson('GET', `${this.options.host}/api/tags`, this.http(signal))) as { models?: Array<{ name?: string }> };
        return (json.models ?? []).map(m => m.name ?? '').filter(Boolean);
    }
}

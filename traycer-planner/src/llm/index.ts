// src/llm/index.ts
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { GeminiProvider } from './gemini.js';
import type { FetchLike } from './http.js';
import { OllamaProvider } from './ollama.js';
import type { LLMProvider } from './types.js';

export function createProvider(config: Config, logger: Logger, overrides: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {}): LLMProvider {
    const common = { model: config.model, timeoutMs: config.timeoutMs, retries: config.retries, seed: config.seed, logger, ...overrides };
    if (config.provider === 'gemini') {
        // resolveConfig guarantees the key exists for gemini
        return new GeminiProvider({ ...common, apiKey: config.gemini.apiKey ?? '', baseUrl: config.gemini.baseUrl });
    }
    return new OllamaProvider({ ...common, host: config.ollama.host, numCtx: config.ollama.numCtx, keepAlive: config.ollama.keepAlive });
}

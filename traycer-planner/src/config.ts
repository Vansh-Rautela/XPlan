// src/config.ts
// Precedence: CLI flags > environment variables > provider-specific defaults.
import { UsageError } from './errors.js';
import { GEMINI_DEFAULT_BASE_URL, GEMINI_DEFAULT_MODEL } from './llm/gemini.js';
import { normalizeOllamaHost, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_NUM_CTX } from './llm/ollama.js';
import type { ProviderName } from './llm/types.js';

export interface Config {
    provider: ProviderName;
    /** How the provider was chosen, for the user-facing notice. */
    providerSource: 'flag' | 'env' | 'auto';
    model: string;
    gemini: { apiKey?: string; baseUrl: string };
    ollama: { host: string; numCtx: number; keepAlive?: string };
    timeoutMs: number;
    retries: number;
    seed?: number;
    temperature: number;
    maxFiles: number;
    maxContextChars: number;
    maxRevisions: number;
    exploreSteps: number;
    review: boolean;
    maxIndexFiles: number;
}

/** Values from CLI flags; all optional. Numbers arrive as strings from the parser. */
export interface ConfigFlags {
    provider?: string;
    model?: string;
    timeout?: string;
    retries?: string;
    seed?: string;
    temperature?: string;
    maxFiles?: string;
    maxContextChars?: string;
    maxRevisions?: string;
    exploreSteps?: string;
    numCtx?: string;
    maxIndexFiles?: string;
    review?: boolean;
}

type Env = Record<string, string | undefined>;

const PROVIDER_DEFAULTS: Record<ProviderName, { timeoutSec: number; maxFiles: number; maxContextChars: number; exploreSteps: number }> = {
    // Remote models have large context windows.
    gemini: { timeoutSec: 120, maxFiles: 15, maxContextChars: 120_000, exploreSteps: 3 },
    // Local models: smaller context and slower generation. maxContextChars is derived from
    // num_ctx below unless set explicitly.
    ollama: { timeoutSec: 600, maxFiles: 8, maxContextChars: 0, exploreSteps: 2 },
};

function nonEmpty(value: string | undefined): string | undefined {
    const v = value?.trim();
    return v ? v : undefined;
}

export function parseIntOption(name: string, raw: string | undefined, { min, max }: { min: number; max: number }): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new UsageError(`Invalid value for ${name}: "${raw}" (expected an integer from ${min} to ${max}).`);
    }
    return n;
}

function parseFloatOption(name: string, raw: string | undefined, { min, max }: { min: number; max: number }): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
        throw new UsageError(`Invalid value for ${name}: "${raw}" (expected a number from ${min} to ${max}).`);
    }
    return n;
}

function parseProvider(raw: string, source: string): ProviderName {
    const value = raw.toLowerCase();
    if (value === 'gemini' || value === 'ollama') return value;
    throw new UsageError(`Unknown provider "${raw}" (from ${source}). Supported providers: gemini, ollama.`);
}

export function resolveConfig(flags: ConfigFlags, env: Env = process.env): Config {
    const apiKey = nonEmpty(env.GEMINI_API_KEY) ?? nonEmpty(env.GOOGLE_API_KEY);

    let provider: ProviderName;
    let providerSource: Config['providerSource'];
    if (flags.provider) {
        provider = parseProvider(flags.provider, '--provider');
        providerSource = 'flag';
    } else if (nonEmpty(env.XPLAN_PROVIDER)) {
        provider = parseProvider(env.XPLAN_PROVIDER!.trim(), 'XPLAN_PROVIDER');
        providerSource = 'env';
    } else {
        // Backwards compatible: an API key meant Gemini before. Without one, stay local.
        provider = apiKey ? 'gemini' : 'ollama';
        providerSource = 'auto';
    }

    if (provider === 'gemini' && !apiKey) {
        throw new UsageError('Gemini needs an API key, but neither GEMINI_API_KEY nor GOOGLE_API_KEY is set.', 'Set GEMINI_API_KEY in your environment or .env, or use the local provider: --provider ollama.');
    }

    const defaults = PROVIDER_DEFAULTS[provider];
    const model = nonEmpty(flags.model)
        ?? nonEmpty(env.XPLAN_MODEL)
        ?? (provider === 'gemini' ? nonEmpty(env.GEMINI_MODEL) ?? GEMINI_DEFAULT_MODEL : nonEmpty(env.OLLAMA_MODEL) ?? OLLAMA_DEFAULT_MODEL);

    let ollamaHost: string;
    try {
        ollamaHost = normalizeOllamaHost(env.OLLAMA_HOST);
    } catch {
        throw new UsageError(`Invalid OLLAMA_HOST: "${env.OLLAMA_HOST}".`, 'Use a form like 127.0.0.1:11434 or http://host:11434.');
    }

    const timeoutSec = parseIntOption('--timeout', flags.timeout, { min: 1, max: 3600 }) ?? defaults.timeoutSec;
    const numCtx = parseIntOption('--num-ctx', flags.numCtx ?? nonEmpty(env.OLLAMA_NUM_CTX), { min: 2048, max: 1_048_576 }) ?? OLLAMA_DEFAULT_NUM_CTX;
    // Code context gets roughly half of the Ollama window (≈1.6 chars per window token at
    // ~3.2 chars/token); the rest is the repository map, requirements, schema, and the answer.
    const defaultContextChars = provider === 'ollama' ? Math.round(numCtx * 1.6) : defaults.maxContextChars;
    return {
        provider,
        providerSource,
        model,
        gemini: { apiKey, baseUrl: nonEmpty(env.GEMINI_BASE_URL) ?? GEMINI_DEFAULT_BASE_URL },
        ollama: {
            host: ollamaHost,
            numCtx,
            keepAlive: nonEmpty(env.OLLAMA_KEEP_ALIVE),
        },
        timeoutMs: timeoutSec * 1000,
        retries: parseIntOption('--retries', flags.retries, { min: 0, max: 10 }) ?? 2,
        seed: parseIntOption('--seed', flags.seed, { min: 0, max: 2 ** 31 - 1 }),
        temperature: parseFloatOption('--temperature', flags.temperature, { min: 0, max: 2 }) ?? 0.2,
        maxFiles: parseIntOption('--max-files', flags.maxFiles, { min: 1, max: 200 }) ?? defaults.maxFiles,
        maxContextChars: parseIntOption('--max-context-chars', flags.maxContextChars, { min: 2000, max: 2_000_000 }) ?? defaultContextChars,
        maxRevisions: parseIntOption('--max-revisions', flags.maxRevisions, { min: 0, max: 5 }) ?? 2,
        exploreSteps: parseIntOption('--explore-steps', flags.exploreSteps, { min: 0, max: 10 }) ?? defaults.exploreSteps,
        review: flags.review ?? true,
        maxIndexFiles: parseIntOption('--max-index-files', flags.maxIndexFiles, { min: 1, max: 200_000 }) ?? 5000,
    };
}

/** One-line notice about where code will be sent. Printed before any model call. */
export function describeDataFlow(config: Config, remote: boolean): string {
    const chosen = config.providerSource === 'auto' ? ' (auto-selected; override with --provider)' : '';
    if (config.provider === 'gemini') {
        return `Provider: gemini/${config.model}${chosen} — selected code excerpts will be sent to Google's Gemini API.`;
    }
    return `Provider: ollama/${config.model} at ${config.ollama.host}${chosen} — ${remote ? 'code excerpts will be sent to this REMOTE Ollama server.' : 'runs locally; code stays on this machine.'}`;
}

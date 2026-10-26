// src/llm/http.ts
// JSON-over-HTTP with timeouts, cancellation, and bounded retries. Request bodies (which contain
// source code) are never included in errors or logs.
import { ProviderError, type ProviderErrorKind } from '../errors.js';
import { redactSecrets } from '../redact.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
    provider: string;
    timeoutMs: number;
    /** Additional attempts after the first one. */
    retries: number;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
    /** Provider-specific mapping of HTTP failures to actionable errors. */
    mapError?: (status: number, message: string) => ProviderError | undefined;
    /** Hint for connection failures (e.g. "is Ollama running?"). */
    connectionHint?: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

export const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function parseRetryAfter(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
    return undefined;
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    return Math.round(base * (0.5 + random() * 0.5));
}

/** Extracts a human-readable message from common error body shapes. */
export function extractErrorMessage(body: string): string {
    try {
        const json = JSON.parse(body) as { error?: unknown; message?: unknown };
        if (typeof json.error === 'string') return json.error;
        if (json.error && typeof json.error === 'object' && 'message' in json.error) return String((json.error as { message: unknown }).message);
        if (typeof json.message === 'string') return json.message;
    } catch {
        // not JSON
    }
    return body.slice(0, 300);
}

function kindForStatus(status: number): ProviderErrorKind {
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'model_not_found';
    if (status === 429) return 'rate_limit';
    if (status === 408) return 'timeout';
    if (status >= 500) return 'unavailable';
    return 'bad_request';
}

function networkCode(error: unknown): string | undefined {
    const cause = (error as { cause?: { code?: string } })?.cause;
    return cause?.code ?? (error as { code?: string })?.code;
}

type RequestOptions = HttpOptions & { headers?: Record<string, string>; body?: unknown };

/** undici's own limits (300 s until headers / between body chunks) surface as these codes. */
const UNDICI_TIMEOUTS = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']);

function timeoutError(options: RequestOptions, cause: unknown, detail?: string): ProviderError {
    return new ProviderError('timeout', `${options.provider} request timed out${detail ? ` (${detail})` : ` after ${Math.round(options.timeoutMs / 1000)}s`}`, {
        hint: 'Increase --timeout, reduce --max-context-chars, or use a smaller/faster model.',
        cause,
    });
}

/**
 * Sends the request with retries and returns the response body as text. Timeouts are not
 * retried: a slow model will usually be slow again, and retrying doubles the cost.
 */
async function send(method: 'GET' | 'POST', url: string, options: RequestOptions): Promise<{ status: number; text: string }> {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    const sleep = options.sleep ?? defaultSleep;
    const safeUrl = redactSecrets(url);
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= options.retries; attempt++) {
        if (options.signal?.aborted) throw new ProviderError('aborted', `${options.provider} request cancelled`);

        const timeout = AbortSignal.timeout(options.timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        let response: Response;
        let text: string;
        try {
            response = await fetchImpl(url, {
                method,
                headers: { 'content-type': 'application/json', ...options.headers },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal,
            });
            // The body is read under the same deadline (streamed responses can take minutes).
            text = await response.text();
        } catch (error) {
            if (options.signal?.aborted) throw new ProviderError('aborted', `${options.provider} request cancelled`, { cause: error });
            if (timeout.aborted) throw timeoutError(options, error);
            const code = networkCode(error);
            if (code && UNDICI_TIMEOUTS.has(code)) throw timeoutError(options, error, code);
            lastError = new ProviderError('unavailable', `Could not connect to ${options.provider} (${code ?? 'network error'}) at ${safeUrl}`, {
                hint: options.connectionHint,
                cause: error,
            });
            // Connection refused means nothing is listening; retrying will not help.
            if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || attempt === options.retries) throw lastError;
            const delayMs = backoffDelay(attempt);
            options.onRetry?.({ attempt: attempt + 1, delayMs, reason: code ?? 'network error' });
            await sleep(delayMs);
            continue;
        }

        if (response.ok) return { status: response.status, text };

        const message = redactSecrets(extractErrorMessage(text));
        lastError = options.mapError?.(response.status, message)
            ?? new ProviderError(kindForStatus(response.status), `${options.provider} HTTP ${response.status}: ${message}`, { status: response.status });

        if (!RETRYABLE_STATUS.has(response.status) || attempt === options.retries) throw lastError;
        const delayMs = parseRetryAfter(response.headers.get('retry-after')) ?? backoffDelay(attempt);
        options.onRetry?.({ attempt: attempt + 1, delayMs, reason: `HTTP ${response.status}` });
        await sleep(delayMs);
    }
    throw lastError ?? new ProviderError('unavailable', `${options.provider} request failed`);
}

export async function requestJson(method: 'GET' | 'POST', url: string, options: RequestOptions): Promise<unknown> {
    const { status, text } = await send(method, url, options);
    try {
        return text === '' ? {} : JSON.parse(text);
    } catch (error) {
        throw new ProviderError('invalid_response', `${options.provider} returned a non-JSON response (HTTP ${status})`, { cause: error });
    }
}

/**
 * For streaming endpoints that return newline-delimited JSON (Ollama with `stream: true`).
 * Streaming makes the server send headers as soon as generation starts, which avoids
 * fetch's fixed 300 s header timeout on slow local hardware. An `{"error": …}` line is
 * mapped like an HTTP error.
 */
export async function requestNdjson(url: string, options: RequestOptions): Promise<unknown[]> {
    const { text } = await send('POST', url, options);
    const objects: unknown[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch (error) {
            throw new ProviderError('invalid_response', `${options.provider} returned a malformed stream line`, { cause: error });
        }
        const err = (value as { error?: unknown }).error;
        if (typeof err === 'string') {
            const message = redactSecrets(err);
            throw options.mapError?.(500, message) ?? new ProviderError('bad_request', `${options.provider}: ${message}`);
        }
        objects.push(value);
    }
    return objects;
}

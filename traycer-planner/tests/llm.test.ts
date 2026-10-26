// tests/llm.test.ts — HTTP resilience, Gemini and Ollama providers, structured output
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { ProviderError, StructuredOutputError } from '../src/errors.js';
import { GeminiProvider, toGeminiContents } from '../src/llm/gemini.js';
import { backoffDelay, parseRetryAfter, requestJson, type FetchLike } from '../src/llm/http.js';
import { normalizeOllamaHost, OllamaProvider } from '../src/llm/ollama.js';
import { extractJson, generateStructured, toModelSchema } from '../src/llm/structured.js';
import { redactSecrets } from '../src/redact.js';
import { fakeFetch, jsonResponse, ndjsonResponse, networkError, noSleep, scriptedProvider, withEventLoopAlive } from './helpers.js';

const FAKE_KEY = 'AIzaSyD-FAKE-KEY-0123456789abcdefghijklm';

describe('requestJson', () => {
    const base = { provider: 'Test', timeoutMs: 1000, retries: 2, sleep: noSleep };

    test('retries 429 honouring Retry-After, then succeeds', async () => {
        const delays: number[] = [];
        const fetchImpl = fakeFetch([jsonResponse(429, { error: 'slow down' }, { 'retry-after': '3' }), jsonResponse(200, { ok: true })]);
        const result = await requestJson('POST', 'http://x', { ...base, fetchImpl, onRetry: i => delays.push(i.delayMs), body: {} });
        assert.deepEqual(result, { ok: true });
        assert.deepEqual(delays, [3000]);
        assert.equal(fetchImpl.calls.length, 2);
    });

    test('retries 5xx with backoff and gives up after the limit', async () => {
        const fetchImpl = fakeFetch([jsonResponse(503, {}), jsonResponse(500, {}), jsonResponse(502, { error: { message: 'bad gateway' } })]);
        await assert.rejects(requestJson('GET', 'http://x', { ...base, fetchImpl }), (e: ProviderError) => e.kind === 'unavailable' && /bad gateway/.test(e.message));
        assert.equal(fetchImpl.calls.length, 3);
    });

    test('does not retry 400/401', async () => {
        for (const status of [400, 401]) {
            const fetchImpl = fakeFetch([jsonResponse(status, { error: 'nope' })]);
            await assert.rejects(requestJson('GET', 'http://x', { ...base, fetchImpl }), ProviderError);
            assert.equal(fetchImpl.calls.length, 1);
        }
    });

    test('connection refused fails fast with the hint', async () => {
        const fetchImpl = fakeFetch([networkError('ECONNREFUSED')]);
        await assert.rejects(
            requestJson('GET', 'http://x', { ...base, fetchImpl, connectionHint: 'start the server' }),
            (e: ProviderError) => e.kind === 'unavailable' && e.hint === 'start the server',
        );
        assert.equal(fetchImpl.calls.length, 1);
    });

    test('transient network errors are retried', async () => {
        const fetchImpl = fakeFetch([networkError('ECONNRESET'), jsonResponse(200, { ok: 1 })]);
        assert.deepEqual(await requestJson('GET', 'http://x', { ...base, fetchImpl }), { ok: 1 });
    });

    test('times out without retrying', async () => {
        const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        });
        let calls = 0;
        await withEventLoopAlive(() => assert.rejects(
            requestJson('GET', 'http://x', { ...base, timeoutMs: 20, fetchImpl: (u, i) => { calls++; return hang(u, i); } }),
            (e: ProviderError) => e.kind === 'timeout' && !!e.hint,
        ));
        assert.equal(calls, 1);
    });

    test("fetch's own header/body timeouts are reported as timeouts and not retried", async () => {
        const fetchImpl = fakeFetch([networkError('UND_ERR_HEADERS_TIMEOUT'), jsonResponse(200, {})]);
        await assert.rejects(requestJson('GET', 'http://x', { ...base, fetchImpl }), (e: ProviderError) => e.kind === 'timeout' && /UND_ERR_HEADERS_TIMEOUT/.test(e.message));
        assert.equal(fetchImpl.calls.length, 1);
    });

    test('a body that stalls past the deadline times out', async () => {
        // Headers arrive, then the body never finishes; the stream errors when the signal fires (as fetch does).
        const fetchImpl: FetchLike = async (_url, init) => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"a":'));
                init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
            },
        }), { status: 200 });
        await withEventLoopAlive(() => assert.rejects(requestJson('GET', 'http://x', { ...base, timeoutMs: 30, fetchImpl }), (e: ProviderError) => e.kind === 'timeout'));
    });

    test('user cancellation surfaces as aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(requestJson('GET', 'http://x', { ...base, signal: controller.signal, fetchImpl: fakeFetch([]) }), (e: ProviderError) => e.kind === 'aborted');
    });

    test('secrets in URLs and error bodies are redacted', async () => {
        const fetchImpl = fakeFetch([networkError('ECONNREFUSED')]);
        await assert.rejects(requestJson('GET', `http://x/models?key=${FAKE_KEY}`, { ...base, fetchImpl }), (e: Error) => !e.message.includes(FAKE_KEY));
        const fetch2 = fakeFetch([jsonResponse(400, { error: `invalid key ${FAKE_KEY}` })]);
        await assert.rejects(requestJson('GET', 'http://x', { ...base, fetchImpl: fetch2 }), (e: Error) => !e.message.includes(FAKE_KEY));
    });

    test('parseRetryAfter and backoff bounds', () => {
        assert.equal(parseRetryAfter('2'), 2000);
        assert.equal(parseRetryAfter('9999'), 60_000);
        assert.equal(parseRetryAfter(null), undefined);
        assert.equal(backoffDelay(0, () => 1), 1000);
        assert.equal(backoffDelay(10, () => 1), 30_000);
    });
});

describe('GeminiProvider', () => {
    const make = (responses: Parameters<typeof fakeFetch>[0]) => {
        const fetchImpl = fakeFetch(responses);
        return { fetchImpl, provider: new GeminiProvider({ apiKey: FAKE_KEY, model: 'gemini-test', timeoutMs: 1000, retries: 1, seed: 7, fetchImpl, sleep: noSleep }) };
    };

    test('sends key in header, schema in generationConfig, and parses text (ignoring thoughts)', async () => {
        const { fetchImpl, provider } = make([jsonResponse(200, {
            candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: '{"a":1}' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        })]);
        const res = await provider.chat({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], jsonSchema: { type: 'object' }, temperature: 0.1 });
        assert.equal(res.text, '{"a":1}');
        assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
        const call = fetchImpl.calls[0]!;
        assert.ok(!call.url.includes(FAKE_KEY), 'key not in URL');
        assert.equal((call.init.headers as Record<string, string>)['x-goog-api-key'], FAKE_KEY);
        assert.match(call.url, /\/models\/gemini-test:generateContent$/);
        const body = call.body as { systemInstruction: unknown; generationConfig: Record<string, unknown> };
        assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
        assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' });
        assert.equal(body.generationConfig.seed, 7);
    });

    test('parses function calls and replays raw model content (thought signatures)', async () => {
        const raw = { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig123' }] };
        const { provider } = make([jsonResponse(200, { candidates: [{ content: raw, finishReason: 'STOP' }] })]);
        const res = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }] });
        assert.deepEqual(res.toolCalls, [{ name: 'read_file', args: { path: 'a.ts' } }]);

        const contents = toGeminiContents([
            { role: 'user', content: 'x' },
            { role: 'assistant', content: '', toolCalls: res.toolCalls, raw: res.raw },
            { role: 'tool', name: 'read_file', content: 'r1' },
            { role: 'tool', name: 'read_file', content: 'r2' },
        ]);
        assert.equal(contents.length, 3);
        assert.equal((contents[1]!.parts[0] as Record<string, unknown>).thoughtSignature, 'sig123');
        assert.equal(contents[2]!.parts.length, 2, 'consecutive tool results merged into one user turn');
    });

    test('maps auth errors to an actionable message without leaking the key', async () => {
        const { provider } = make([jsonResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })]);
        await assert.rejects(provider.chat({ system: 's', messages: [] }), (e: ProviderError) =>
            e.kind === 'auth' && /GEMINI_API_KEY/.test(e.hint ?? '') && !e.message.includes(FAKE_KEY));
    });

    test('model not found suggests doctor', async () => {
        const { provider } = make([jsonResponse(404, { error: { message: 'models/gemini-test is not found' } })]);
        await assert.rejects(provider.chat({ system: 's', messages: [] }), (e: ProviderError) => e.kind === 'model_not_found' && /doctor/.test(e.hint ?? ''));
    });

    test('falls back to prompt-only JSON when the schema field is rejected', async () => {
        const { fetchImpl, provider } = make([
            jsonResponse(400, { error: { message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"' } }),
            jsonResponse(200, { candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] } }] }),
        ]);
        await provider.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], jsonSchema: { type: 'object' } });
        const second = fetchImpl.calls[1]!.body as { generationConfig: Record<string, unknown> };
        assert.equal(second.generationConfig.responseJsonSchema, undefined);
        assert.equal(second.generationConfig.responseMimeType, 'application/json');
    });

    test('blocked prompts and safety stops raise errors', async () => {
        const { provider } = make([jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } })]);
        await assert.rejects(provider.chat({ system: 's', messages: [] }), (e: ProviderError) => e.kind === 'blocked');
        const { provider: p2 } = make([jsonResponse(200, { candidates: [{ finishReason: 'SAFETY' }] })]);
        await assert.rejects(p2.chat({ system: 's', messages: [] }), (e: ProviderError) => e.kind === 'blocked');
    });

    test('listModels filters to generateContent models', async () => {
        const { provider } = make([jsonResponse(200, { models: [
            { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
        ] })]);
        assert.deepEqual(await provider.listModels(), ['gemini-a']);
    });
});

describe('OllamaProvider', () => {
    test('normalizes OLLAMA_HOST forms', () => {
        assert.equal(normalizeOllamaHost(undefined), 'http://127.0.0.1:11434');
        assert.equal(normalizeOllamaHost('0.0.0.0'), 'http://127.0.0.1:11434');
        assert.equal(normalizeOllamaHost('gpu-box:8080'), 'http://gpu-box:8080');
        assert.equal(normalizeOllamaHost('https://ollama.example.com/'), 'https://ollama.example.com');
    });

    test('builds /api/chat requests with schema, num_ctx, tools, and tool results', async () => {
        const fetchImpl = fakeFetch([ndjsonResponse([
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_files', arguments: { pattern: '*.ts' } } }] }, done: false },
            { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 },
        ])]);
        const provider = new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'qwen3', timeoutMs: 1000, retries: 0, numCtx: 8192, seed: 1, fetchImpl });
        assert.equal(provider.remote, false);
        const res = await provider.chat({
            system: 'sys',
            messages: [
                { role: 'user', content: 'u' },
                { role: 'assistant', content: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
                { role: 'tool', name: 'read_file', content: 'data' },
            ],
            jsonSchema: { type: 'object' },
            tools: [{ name: 'list_files', description: 'd', parameters: { type: 'object' } }],
        });
        assert.deepEqual(res.toolCalls, [{ name: 'list_files', args: { pattern: '*.ts' } }]);
        assert.deepEqual(res.usage, { inputTokens: 3, outputTokens: 4 });
        const body = fetchImpl.calls[0]!.body as Record<string, any>;
        assert.equal(fetchImpl.calls[0]!.url, 'http://127.0.0.1:11434/api/chat');
        assert.equal(body.stream, true);
        assert.deepEqual(body.format, { type: 'object' });
        assert.deepEqual(body.options, { temperature: 0.2, num_ctx: 8192, seed: 1 });
        assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' });
        assert.deepEqual(body.messages[2].tool_calls, [{ function: { name: 'read_file', arguments: { path: 'a' } } }]);
        assert.deepEqual(body.messages[3], { role: 'tool', tool_name: 'read_file', content: 'data' });
        assert.equal(body.tools[0].type, 'function');
    });

    test('aggregates streamed content and reports truncation', async () => {
        const fetchImpl = fakeFetch([ndjsonResponse([
            { message: { role: 'assistant', content: '{"a":' }, done: false },
            { message: { role: 'assistant', content: '1}' }, done: false },
            { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' },
        ])]);
        const provider = new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 1000, retries: 0, numCtx: 4096, fetchImpl });
        const res = await provider.chat({ system: '', messages: [] });
        assert.equal(res.text, '{"a":1}');
        assert.equal(res.finishReason, 'length');
    });

    test('mid-stream errors and incomplete streams are errors', async () => {
        const mk = (r: Response) => new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 1000, retries: 0, numCtx: 4096, fetchImpl: fakeFetch([r]) });
        await assert.rejects(mk(ndjsonResponse([{ message: { content: 'x' }, done: false }, { error: 'CUDA out of memory' }])).chat({ system: '', messages: [] }),
            (e: ProviderError) => /CUDA out of memory/.test(e.message));
        await assert.rejects(mk(ndjsonResponse([{ message: { content: 'x' }, done: false }])).chat({ system: '', messages: [] }),
            (e: ProviderError) => e.kind === 'invalid_response');
    });

    test('detects context-window overflow and warns before sending oversized prompts', async () => {
        const warnings: string[] = [];
        const logger = { info() {}, step() {}, debug() {}, warn: (m: string) => warnings.push(m) };
        const fetchImpl = fakeFetch([ndjsonResponse([{ message: { content: '{}' }, done: true, done_reason: 'stop', prompt_eval_count: 4096, eval_count: 10 }])]);
        const provider = new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 1000, retries: 0, numCtx: 4096, fetchImpl, logger });
        const res = await provider.chat({ system: 'x'.repeat(20_000), messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(res.contextOverflow, true);
        assert.ok(warnings.some(w => /near or above num_ctx/.test(w)), 'pre-flight warning');
        assert.ok(warnings.some(w => /filled the 4,096-token context window/.test(w)), 'post-flight warning');

        const ok = new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 1000, retries: 0, numCtx: 4096,
            fetchImpl: fakeFetch([ndjsonResponse([{ message: { content: '{}' }, done: true, prompt_eval_count: 500, eval_count: 10 }])]) });
        assert.equal((await ok.chat({ system: 's', messages: [] })).contextOverflow, undefined);
    });

    test('remote hosts are flagged', () => {
        const provider = new OllamaProvider({ host: 'http://gpu-box:11434', model: 'm', timeoutMs: 1, retries: 0, numCtx: 4096 });
        assert.equal(provider.remote, true);
    });

    test('maps model-not-found, tools-unsupported, and connection errors', async () => {
        const mk = (r: Parameters<typeof fakeFetch>[0]) => new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'llama9', timeoutMs: 1000, retries: 0, numCtx: 4096, fetchImpl: fakeFetch(r) });
        await assert.rejects(mk([jsonResponse(404, { error: "model 'llama9' not found" })]).chat({ system: '', messages: [] }),
            (e: ProviderError) => e.kind === 'model_not_found' && /ollama pull llama9/.test(e.hint ?? ''));
        await assert.rejects(mk([jsonResponse(400, { error: 'registry.ollama.ai/library/llama9:latest does not support tools' })]).chat({ system: '', messages: [] }),
            (e: ProviderError) => e.kind === 'tools_unsupported');
        await assert.rejects(mk([networkError('ECONNREFUSED')]).chat({ system: '', messages: [] }),
            (e: ProviderError) => e.kind === 'unavailable' && /ollama serve/.test(e.hint ?? ''));
    });

    test('listModels reads /api/tags', async () => {
        const fetchImpl = fakeFetch([jsonResponse(200, { models: [{ name: 'qwen3:latest' }, { name: 'llama3.2:3b' }] })]);
        const provider = new OllamaProvider({ host: 'http://127.0.0.1:11434', model: 'qwen3', timeoutMs: 1000, retries: 0, numCtx: 4096, fetchImpl });
        assert.deepEqual(await provider.listModels(), ['qwen3:latest', 'llama3.2:3b']);
        assert.equal(fetchImpl.calls[0]!.url, 'http://127.0.0.1:11434/api/tags');
    });
});

describe('structured output', () => {
    const Schema = z.object({ name: z.string(), tags: z.array(z.string()).default([]) });

    test('extractJson handles fences and surrounding prose', () => {
        assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
        assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} hope it helps'), { a: { b: 2 } });
        assert.throws(() => extractJson('no json here'));
    });

    test('toModelSchema strips $schema/default and unsafe integer bounds', () => {
        const schema = toModelSchema(z.object({ n: z.number().int(), a: z.array(z.string()).default([]) }));
        const text = JSON.stringify(schema);
        assert.ok(!text.includes('$schema'));
        assert.ok(!text.includes('default'));
        assert.ok(!text.includes('9007199254740991'));
    });

    test('valid output on the first attempt; defaults applied', async () => {
        const provider = scriptedProvider(() => '{"name":"x"}');
        assert.deepEqual(await generateStructured(provider, { stage: 'T', system: 's', prompt: 'p', schema: Schema }), { name: 'x', tags: [] });
        assert.equal(provider.requests.length, 1);
        assert.ok(provider.requests[0]!.jsonSchema, 'native schema requested');
    });

    test('repairs invalid JSON and schema violations by feeding issues back', async () => {
        const replies = ['{"name": ', '{"name": 42}', '{"name":"ok"}'];
        const provider = scriptedProvider(() => replies.shift()!);
        const value = await generateStructured(provider, { stage: 'T', system: 's', prompt: 'p', schema: Schema, maxRepairs: 2 });
        assert.equal(value.name, 'ok');
        const last = provider.requests[2]!.messages.at(-1)!;
        assert.match(last.content, /name/);
    });

    test('throws StructuredOutputError after the repair budget', async () => {
        const provider = scriptedProvider(() => '{"wrong": true}');
        await assert.rejects(generateStructured(provider, { stage: 'Planner', system: 's', prompt: 'p', schema: Schema, maxRepairs: 1 }),
            (e: StructuredOutputError) => e instanceof StructuredOutputError && /Planner/.test(e.message) && e.issues.length > 0);
        assert.equal(provider.requests.length, 2);
    });

    test('mentions truncation when the model hit the token limit', async () => {
        const provider = scriptedProvider(() => ({ text: '{"name": "abc', toolCalls: [], finishReason: 'length' }));
        await assert.rejects(generateStructured(provider, { stage: 'T', system: 's', prompt: 'p', schema: Schema, maxRepairs: 0 }), /cut off/);
    });
});

test('redactSecrets covers common credential formats', () => {
    const samples = [
        FAKE_KEY,
        'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'AKIAABCDEFGHIJKLMNOP',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
        'password = "hunter2hunter2"',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const s of samples) {
        const out = redactSecrets(s);
        assert.match(out, /REDACTED/, s);
    }
    assert.equal(redactSecrets('const token = getToken();'), 'const token = getToken();');
});

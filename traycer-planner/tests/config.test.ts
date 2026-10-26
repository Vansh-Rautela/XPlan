// tests/config.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeDataFlow, resolveConfig } from '../src/config.js';
import { UsageError } from '../src/errors.js';

describe('resolveConfig', () => {
    test('auto-selects gemini when a key exists (backwards compatible), else ollama', () => {
        assert.equal(resolveConfig({}, { GOOGLE_API_KEY: 'k' }).provider, 'gemini');
        assert.equal(resolveConfig({}, { GEMINI_API_KEY: 'k' }).providerSource, 'auto');
        assert.equal(resolveConfig({}, {}).provider, 'ollama');
    });

    test('GEMINI_API_KEY takes precedence over GOOGLE_API_KEY', () => {
        assert.equal(resolveConfig({}, { GEMINI_API_KEY: 'new', GOOGLE_API_KEY: 'old' }).gemini.apiKey, 'new');
    });

    test('flags override env, env overrides defaults', () => {
        const env = { XPLAN_PROVIDER: 'ollama', OLLAMA_MODEL: 'llama3.2', GEMINI_API_KEY: 'k' };
        assert.equal(resolveConfig({}, env).provider, 'ollama');
        assert.equal(resolveConfig({}, env).model, 'llama3.2');
        assert.equal(resolveConfig({ provider: 'gemini' }, env).provider, 'gemini');
        assert.equal(resolveConfig({ model: 'x' }, env).model, 'x');
        assert.equal(resolveConfig({}, { ...env, XPLAN_MODEL: 'y' }).model, 'y');
    });

    test('provider-specific defaults', () => {
        const gemini = resolveConfig({ provider: 'gemini' }, { GEMINI_API_KEY: 'k' });
        const ollama = resolveConfig({ provider: 'ollama' }, {});
        assert.ok(gemini.maxContextChars > ollama.maxContextChars);
        assert.ok(ollama.timeoutMs > gemini.timeoutMs);
        assert.equal(ollama.ollama.numCtx, 16384);
        assert.equal(resolveConfig({}, { OLLAMA_NUM_CTX: '32768' }).ollama.numCtx, 32768);
        assert.equal(resolveConfig({ numCtx: '4096' }, { OLLAMA_NUM_CTX: '32768' }).ollama.numCtx, 4096);
        // The Ollama code budget scales with the context window unless set explicitly.
        assert.ok(resolveConfig({ numCtx: '32768' }, {}).maxContextChars > ollama.maxContextChars * 1.9);
        assert.equal(resolveConfig({ numCtx: '32768', maxContextChars: '9000' }, {}).maxContextChars, 9000);
    });

    test('gemini without a key is a usage error with a hint', () => {
        assert.throws(() => resolveConfig({ provider: 'gemini' }, {}), (e: UsageError) => e instanceof UsageError && /--provider ollama/.test(e.hint ?? ''));
    });

    test('rejects invalid values', () => {
        assert.throws(() => resolveConfig({ provider: 'openai' }, {}), UsageError);
        assert.throws(() => resolveConfig({}, { XPLAN_PROVIDER: 'nope' }), UsageError);
        assert.throws(() => resolveConfig({ maxRevisions: '9' }, {}), UsageError);
        assert.throws(() => resolveConfig({ timeout: 'abc' }, {}), UsageError);
        assert.throws(() => resolveConfig({ temperature: '3' }, {}), UsageError);
        assert.throws(() => resolveConfig({ maxFiles: '1.5' }, {}), UsageError);
        assert.throws(() => resolveConfig({}, { OLLAMA_HOST: 'http://' }), UsageError);
    });

    test('--no-review and numeric flags', () => {
        const c = resolveConfig({ review: false, maxRevisions: '0', exploreSteps: '0', seed: '42', temperature: '0' }, {});
        assert.equal(c.review, false);
        assert.equal(c.maxRevisions, 0);
        assert.equal(c.exploreSteps, 0);
        assert.equal(c.seed, 42);
        assert.equal(c.temperature, 0);
    });

    test('data-flow notice states where code goes', () => {
        const gemini = resolveConfig({ provider: 'gemini' }, { GEMINI_API_KEY: 'k' });
        assert.match(describeDataFlow(gemini, true), /sent to Google/);
        assert.match(describeDataFlow(resolveConfig({}, {}), false), /stays on this machine/);
        assert.match(describeDataFlow(resolveConfig({}, { OLLAMA_HOST: 'gpu:11434' }), true), /REMOTE/);
    });
});

describe('createProvider', () => {
    test('builds the configured provider with its settings', async () => {
        const { createProvider } = await import('../src/llm/index.js');
        const { silentLogger } = await import('../src/logger.js');
        const gemini = createProvider(resolveConfig({ provider: 'gemini', model: 'g-1' }, { GEMINI_API_KEY: 'k' }), silentLogger);
        assert.deepEqual([gemini.name, gemini.model, gemini.remote], ['gemini', 'g-1', true]);
        const ollama = createProvider(resolveConfig({}, { OLLAMA_MODEL: 'llama3.2', OLLAMA_HOST: 'gpu-box' }), silentLogger);
        assert.deepEqual([ollama.name, ollama.model, ollama.remote], ['ollama', 'llama3.2', true]);
    });
});

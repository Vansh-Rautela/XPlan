// tests/cli.test.ts
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { HELP, parseCliArgs, runCli, type CliIO } from '../src/cli.js';
import { ProviderError, UsageError } from '../src/errors.js';
import type { LLMProvider } from '../src/llm/types.js';
import { APPROVE, goodPlan, json, makeTempDir, REQUIREMENTS, REVISE, SAMPLE_APP, scriptedProvider } from './helpers.js';

function io(overrides: Partial<CliIO> & { provider?: LLMProvider } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const value: CliIO = {
        stdout: t => out.push(t),
        stderr: l => err.push(l),
        readStdin: async () => '',
        env: {},
        isTTY: false,
        cwd: SAMPLE_APP,
        providerFactory: overrides.provider ? () => overrides.provider! : undefined,
        ...overrides,
    };
    return { io: value, out, err, stdout: () => out.join(''), stderr: () => err.join('\n') };
}

const happyProvider = () => scriptedProvider((_r, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json(APPROVE) : json(goodPlan())));

describe('parseCliArgs', () => {
    test('commands, goal parts, and defaults', () => {
        assert.equal(parseCliArgs([], true).command, 'interactive');
        assert.equal(parseCliArgs([], false).command, 'help');
        const p = parseCliArgs(['plan', 'add', 'auth', '--repo', 'x', '-f', 'json', '--no-review'], false);
        assert.equal(p.command, 'plan');
        assert.deepEqual(p.goalParts, ['add', 'auth']);
        assert.equal(p.values['no-review'], true);
    });

    test('usage errors', () => {
        assert.throws(() => parseCliArgs(['plan', '--bogus'], false), UsageError);
        assert.throws(() => parseCliArgs(['frobnicate'], false), UsageError);
        assert.throws(() => parseCliArgs(['plan', 'x', '--format', 'xml'], false), UsageError);
        assert.throws(() => parseCliArgs(['plan', 'x', '-q', '-v'], false), UsageError);
    });
});

describe('runCli', () => {
    test('help and version exit 0', async () => {
        const h = io();
        assert.equal(await runCli(['--help'], h.io), 0);
        assert.equal(h.stdout(), HELP);
        const v = io();
        assert.equal(await runCli(['--version'], v.io), 0);
        assert.match(v.stdout(), /^xplan \d+\.\d+\.\d+/);
    });

    test('missing goal and bad flags exit 2 with hints', async () => {
        const a = io();
        assert.equal(await runCli(['plan'], a.io), 2);
        assert.match(a.stderr(), /No goal given/);
        const b = io();
        assert.equal(await runCli(['plan', 'x', '--max-revisions', '99'], b.io), 2);
        const c = io();
        assert.equal(await runCli(['plan', 'x', '--provider', 'gemini'], c.io), 2);
        assert.match(c.stderr(), /GEMINI_API_KEY/);
    });

    test('plan → JSON on stdout, progress on stderr, exit 0', async () => {
        const h = io({ provider: happyProvider() });
        const code = await runCli(['plan', 'Validate', 'email', 'format', '--format', 'json'], h.io);
        assert.equal(code, 0, h.stderr());
        const result = JSON.parse(h.stdout());
        assert.equal(result.status, 'validated');
        assert.match(h.stderr(), /Provider: ollama\/qwen3/);
        assert.match(h.stderr(), /Status: validated/);
    });

    test('--format handoff prints an agent brief', async () => {
        const h = io({ provider: happyProvider() });
        assert.equal(await runCli(['plan', 'Validate email', '--format', 'handoff', '-q'], h.io), 0);
        assert.match(h.stdout(), /^# Implementation brief:/);
        assert.match(h.stdout(), /### Step 1 \(T1\)/);
    });

    test('unresolved plans exit 4', async () => {
        const provider = scriptedProvider((_r, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json(REVISE) : json(goodPlan())));
        const h = io({ provider });
        assert.equal(await runCli(['plan', 'Validate email', '--max-revisions', '0', '-q'], h.io), 4);
        assert.match(h.stdout(), /Unresolved/);
    });

    test('provider errors exit 3 with hint and no stack', async () => {
        const provider = scriptedProvider(() => { throw new ProviderError('unavailable', 'Could not connect to Ollama', { hint: 'Is Ollama running?' }); });
        const h = io({ provider });
        assert.equal(await runCli(['plan', 'x'], h.io), 3);
        assert.match(h.stderr(), /error: Could not connect to Ollama/);
        assert.match(h.stderr(), /hint: Is Ollama running\?/);
    });

    test('goal from stdin and output to a .json file', async () => {
        const dir = await makeTempDir();
        const target = path.join(dir, 'plan.json');
        const h = io({ provider: happyProvider(), readStdin: async () => 'Validate email format\n' });
        assert.equal(await runCli(['plan', '-', '-o', target, '-q'], h.io), 0);
        assert.equal(h.stdout(), '');
        const written = JSON.parse(await fs.readFile(target, 'utf8'));
        assert.equal(written.goal, 'Validate email format');
    });

    test('planning never writes into the target repository', async () => {
        const before = await snapshot(SAMPLE_APP);
        const h = io({ provider: happyProvider() });
        await runCli(['plan', 'Validate email', '-q'], h.io);
        assert.deepEqual(await snapshot(SAMPLE_APP), before);
    });

    test('context command needs no credentials and lists reasons', async () => {
        const h = io();
        assert.equal(await runCli(['context', 'pagination for list users', '--format', 'json', '-q'], h.io), 0);
        const ctx = JSON.parse(h.stdout());
        assert.ok(ctx.files.length > 0);
        assert.ok(ctx.files.every((f: { reasons: string[] }) => f.reasons.length > 0));
        assert.ok(ctx.files.some((f: { path: string }) => f.path === 'src/routes/users.ts'));
    });

    test('doctor reports model availability', async () => {
        const ok = io({ provider: scriptedProvider(() => '') });
        assert.equal(await runCli(['doctor', '--model', 'mock-model'], ok.io), 0);
        assert.match(ok.stdout(), /Model "mock-model" is available/);
        const missing = io({ provider: scriptedProvider(() => '') });
        assert.equal(await runCli(['doctor', '--model', 'absent'], missing.io), 3);
        assert.match(missing.stdout(), /ollama pull absent/);
    });
});

async function snapshot(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(abs);
            else {
                const stat = await fs.stat(abs);
                out.push(`${path.relative(root, abs)}:${stat.size}:${stat.mtimeMs}`);
            }
        }
    };
    await walk(root);
    return out.sort();
}

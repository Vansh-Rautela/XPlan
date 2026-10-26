// tests/helpers.ts
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../src/llm/http.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../src/llm/types.js';

/** build-test/tests → project root */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SAMPLE_APP = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'sample-app');

export async function makeTempDir(prefix = 'xplan-test-'): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Creates a temporary repository from a map of relative path → content. */
export async function makeTempRepo(files: Record<string, string | Uint8Array>): Promise<string> {
    const root = await makeTempDir();
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
    }
    return root;
}

export type Stage = 'creator' | 'planner' | 'revision' | 'reviewer' | 'explore';

export function stageOf(request: ChatRequest): Stage {
    if (request.tools?.length) return 'explore';
    if (request.system.includes('CREATOR stage')) return 'creator';
    if (request.system.includes('REVIEWER stage')) return 'reviewer';
    const firstUser = request.messages.find(m => m.role === 'user');
    if (firstUser && firstUser.content.includes('## Previous plan')) return 'revision';
    return 'planner';
}

export interface ScriptedProvider extends LLMProvider {
    requests: ChatRequest[];
    stages: Stage[];
}

/** A provider whose replies are produced by a handler; records every request. */
export function scriptedProvider(handler: (request: ChatRequest, stage: Stage, callIndex: number) => ChatResponse | string | Promise<ChatResponse | string>): ScriptedProvider {
    const requests: ChatRequest[] = [];
    const stages: Stage[] = [];
    return {
        name: 'ollama',
        model: 'mock-model',
        remote: false,
        requests,
        stages,
        async chat(request) {
            const stage = stageOf(request);
            requests.push(request);
            stages.push(stage);
            const reply = await handler(request, stage, requests.length - 1);
            return typeof reply === 'string' ? { text: reply, toolCalls: [] } : reply;
        },
        async listModels() {
            return ['mock-model'];
        },
    };
}

export const json = (value: unknown) => JSON.stringify(value);

export const REQUIREMENTS = {
    summary: 'Validate email format when creating users.',
    requirements: [
        { id: 'R1', description: 'POST /users rejects malformed email addresses with HTTP 400.' },
        { id: 'R2', description: 'Valid emails are still accepted.' },
    ],
    acceptanceCriteria: ['Invalid email returns 400'],
    constraints: [],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    searchTerms: ['email', 'validation', 'createUser'],
    candidatePaths: ['src/utils/validation.ts', 'src/does-not-exist.ts'],
};

export function goodPlan() {
    return {
        objective: 'Reject malformed emails on user creation.',
        scope: 'Validation helper and users route only.',
        assumptions: [] as string[],
        tasks: [
            {
                id: 'T1',
                title: 'Add isValidEmail helper',
                description: 'Add an email format check next to isNonEmptyString.',
                rationale: 'Keeps validation helpers together.',
                files: [{ path: 'src/utils/validation.ts', action: 'modify', symbols: ['isValidEmail'], change: 'Add isValidEmail(value).' }],
                dependsOn: [],
                requirementIds: ['R1', 'R2'],
                tests: ['tests/validation.test.ts: accepts a@b.co, rejects "a@"'],
                acceptanceCriteria: ['isValidEmail exported'],
            },
            {
                id: 'T2',
                title: 'Use it in POST /users',
                description: 'Return 400 for invalid email.',
                rationale: 'The route is where input is validated today.',
                files: [
                    { path: 'src/routes/users.ts', action: 'modify', symbols: ['usersRouter'], change: 'Call isValidEmail.' },
                    { path: 'tests/validation.test.ts', action: 'create', symbols: [], change: 'New tests.' },
                ],
                dependsOn: ['T1'],
                requirementIds: ['R1'],
                tests: ['POST /users with "bad" email returns 400'],
                acceptanceCriteria: ['400 on invalid email'],
            },
        ],
        risks: [{ description: 'Overly strict regex rejects valid emails.', mitigation: 'Test common valid forms.' }],
        openQuestions: [] as string[],
    };
}

export const APPROVE = { verdict: 'approve', summary: 'Plan covers the requirements.', findings: [] };
export const REVISE = {
    verdict: 'revise',
    summary: 'Missing coverage.',
    findings: [{ severity: 'major', category: 'testing', taskId: 'T2', issue: 'No route-level test.', evidence: 'R1 is about HTTP 400.', suggestion: 'Add a route test.' }],
};

export interface FakeCall {
    url: string;
    init: RequestInit;
    body: unknown;
}

/** fetch stub: each call consumes the next response (or throws the next error). */
export function fakeFetch(responses: Array<Response | Error | (() => Response | Promise<Response>)>): FetchLike & { calls: FakeCall[] } {
    const calls: FakeCall[] = [];
    const fn = (async (url: string, init: RequestInit) => {
        calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const next = responses.shift();
        if (!next) throw new Error('fakeFetch: no more responses');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    }) as FetchLike & { calls: FakeCall[] };
    fn.calls = calls;
    return fn;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Newline-delimited JSON body, as streamed by Ollama. */
export function ndjsonResponse(chunks: unknown[], status = 200): Response {
    return new Response(chunks.map(c => JSON.stringify(c)).join('\n') + '\n', { status, headers: { 'content-type': 'application/x-ndjson' } });
}

export function networkError(code: string): Error {
    return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

export const noSleep = async () => {};

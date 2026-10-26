// tests/project.test.ts — verification-command detection and the agent handoff format
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runPipeline } from '../src/pipeline.js';
import { renderHandoff, renderMarkdown } from '../src/plan/render.js';
import { buildIndex } from '../src/repo/indexer.js';
import { detectProjectCommands } from '../src/repo/project.js';
import { APPROVE, goodPlan, json, makeTempRepo, REQUIREMENTS, REVISE, SAMPLE_APP, scriptedProvider } from './helpers.js';

describe('detectProjectCommands', () => {
    test('node projects use scripts and the lockfile package manager', async () => {
        const index = await buildIndex(await makeTempRepo({
            'package.json': JSON.stringify({ scripts: { test: 'vitest', build: 'tsc', lint: 'eslint .', 'type-check': 'tsc --noEmit' } }),
            'pnpm-lock.yaml': '',
        }));
        assert.deepEqual(detectProjectCommands(index), { test: 'pnpm test', build: 'pnpm run build', lint: 'pnpm run lint', typecheck: 'pnpm run type-check' });
    });

    test('other ecosystems', async () => {
        assert.equal(detectProjectCommands(await buildIndex(await makeTempRepo({ 'go.mod': 'module x' }))).test, 'go test ./...');
        assert.equal(detectProjectCommands(await buildIndex(await makeTempRepo({ 'Cargo.toml': '[package]' }))).test, 'cargo test');
        const py = detectProjectCommands(await buildIndex(await makeTempRepo({ 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n' })));
        assert.deepEqual(py, { test: 'pytest', lint: 'ruff check .', typecheck: 'mypy .' });
        assert.deepEqual(detectProjectCommands(await buildIndex(await makeTempRepo({ 'README.md': '' }))), {});
    });
});

describe('handoff format', () => {
    const run = async (reviewer: object) => {
        const provider = scriptedProvider((_r, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json(reviewer) : json(goodPlan())));
        const { result } = await runPipeline(provider, { repo: SAMPLE_APP, goal: 'Validate email', maxFiles: 6, maxContextChars: 20_000, maxRevisions: 0, exploreSteps: 0, review: true, temperature: 0 });
        return result;
    };

    test('steps follow the dependency order and include verification commands and stop rules', async () => {
        const result = await run(APPROVE);
        // Reverse the plan order; execution order must still put T1 first.
        result.plan.tasks.reverse();
        const brief = renderHandoff(result);
        assert.ok(brief.indexOf('### Step 1 (T1)') !== -1 && brief.indexOf('### Step 1 (T1)') < brief.indexOf('### Step 2 (T2)'));
        assert.match(brief, /Requires: T1 completed/);
        assert.match(brief, /`npm test`/, 'sample-app test script detected');
        assert.match(brief, /`tests\/validation\.test\.ts` \(create this file\)/);
        assert.match(brief, /do not weaken or delete tests/);
        assert.doesNotMatch(brief, /did not pass review/);
    });

    test('unresolved plans carry the findings at the top', async () => {
        const result = await run(REVISE);
        assert.equal(result.status, 'unresolved');
        const brief = renderHandoff(result);
        assert.ok(brief.indexOf('did not pass review') < brief.indexOf('## Steps'));
        assert.match(brief, /No route-level test/);
    });

    test('context-window warnings appear in Markdown and handoff output', async () => {
        const result = await run(APPROVE);
        result.warnings = ['1 model call(s) filled the context window'];
        assert.match(renderMarkdown(result), /⚠️ 1 model call\(s\) filled the context window/);
        assert.match(renderHandoff(result), /⚠️ 1 model call\(s\) filled the context window/);
    });
});

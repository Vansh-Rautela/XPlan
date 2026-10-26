// tests/pipeline.test.ts — end-to-end orchestration with a scripted model
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProviderError } from '../src/errors.js';
import { refinePlan, runPipeline, type PipelineOptions } from '../src/pipeline.js';
import { renderJson, renderMarkdown } from '../src/plan/render.js';
import { APPROVE, goodPlan, json, REQUIREMENTS, REVISE, SAMPLE_APP, scriptedProvider } from './helpers.js';

const options = (overrides: Partial<PipelineOptions> = {}): PipelineOptions => ({
    repo: SAMPLE_APP,
    goal: 'Validate email format when creating a user',
    maxFiles: 6,
    maxContextChars: 20_000,
    maxRevisions: 2,
    exploreSteps: 0,
    review: true,
    temperature: 0.2,
    ...overrides,
});

describe('runPipeline', () => {
    test('approved on the first review: Creator, Planner, Reviewer = 3 calls', async () => {
        const provider = scriptedProvider((_req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'planner') return json(goodPlan());
            if (stage === 'reviewer') return json(APPROVE);
            throw new Error(`unexpected stage ${stage}`);
        });
        const { result } = await runPipeline(provider, options());
        assert.equal(result.status, 'validated');
        assert.deepEqual(provider.stages, ['creator', 'planner', 'reviewer']);
        assert.equal(result.stats.llmCalls, 3);
        assert.deepEqual(result.executionOrder, ['T1', 'T2']);
        assert.equal(result.unresolvedFindings.length, 0);
        // Creator's valid candidate path is pinned into the context; the invented one is not.
        assert.ok(result.context.files.some(f => f.path === 'src/utils/validation.ts' && f.reasons.includes('selected by Creator')));
        assert.ok(!result.context.files.some(f => f.path === 'src/does-not-exist.ts'));
        // The Planner saw real code from the repository.
        const plannerPrompt = provider.requests[1]!.messages[0]!.content;
        assert.match(plannerPrompt, /isNonEmptyString/);
    });

    test('reviewer finding triggers one revision, then approval', async () => {
        let reviews = 0;
        const provider = scriptedProvider((req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'planner') return json(goodPlan());
            if (stage === 'revision') {
                assert.match(req.messages[0]!.content, /No route-level test/, 'findings are passed to the revision');
                const p = goodPlan();
                p.tasks[1]!.tests.push('tests/users.route.test.ts: POST /users returns 400');
                return json(p);
            }
            return json(reviews++ === 0 ? REVISE : APPROVE);
        });
        const { result } = await runPipeline(provider, options());
        assert.equal(result.status, 'validated');
        assert.deepEqual(provider.stages, ['creator', 'planner', 'reviewer', 'revision', 'reviewer']);
        assert.equal(result.review.rounds.length, 2);
        assert.equal(result.review.rounds[0]!.blocking, 1);
        assert.ok(result.plan.tasks[1]!.tests.some(t => t.includes('users.route')));
    });

    test('stops after maxRevisions and reports unresolved findings honestly', async () => {
        const provider = scriptedProvider((_req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'planner' || stage === 'revision') return json(goodPlan());
            return json(REVISE);
        });
        const { result } = await runPipeline(provider, options({ maxRevisions: 1 }));
        assert.equal(result.status, 'unresolved');
        assert.deepEqual(provider.stages, ['creator', 'planner', 'reviewer', 'revision', 'reviewer']);
        assert.equal(result.unresolvedFindings.length, 1);
        assert.equal(result.unresolvedFindings[0]!.source, 'reviewer');
        assert.match(renderMarkdown(result), /Unresolved findings/);
    });

    test('a reviewer that approves while reporting a major finding does not validate the plan', async () => {
        const provider = scriptedProvider((_req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'planner' || stage === 'revision') return json(goodPlan());
            return json({ ...REVISE, verdict: 'approve' });
        });
        const { result } = await runPipeline(provider, options({ maxRevisions: 0 }));
        assert.equal(result.status, 'unresolved');
    });

    test('validator findings alone force a revision (plan references a missing file)', async () => {
        const provider = scriptedProvider((req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'planner') {
                const p = goodPlan();
                p.tasks[0]!.files[0]!.path = 'src/validation.ts';
                return json(p);
            }
            if (stage === 'revision') {
                assert.match(req.messages[0]!.content, /src\/utils\/validation\.ts/, 'near-match suggestion passed on');
                return json(goodPlan());
            }
            return json(APPROVE);
        });
        const { result } = await runPipeline(provider, options());
        assert.equal(result.status, 'validated');
        assert.deepEqual(provider.stages, ['creator', 'planner', 'reviewer', 'revision', 'reviewer']);
    });

    test('--no-review: deterministic validation only, status "unreviewed"', async () => {
        const provider = scriptedProvider((_req, stage) => (stage === 'creator' ? json(REQUIREMENTS) : json(goodPlan())));
        const { result } = await runPipeline(provider, options({ review: false }));
        assert.equal(result.status, 'unreviewed');
        assert.deepEqual(provider.stages, ['creator', 'planner']);
    });

    test('exploration uses sandboxed tools and feeds evidence to the Planner', async () => {
        let exploreTurn = 0;
        const provider = scriptedProvider((req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'explore') {
                exploreTurn++;
                if (exploreTurn === 1) {
                    return { text: '', toolCalls: [
                        { name: 'read_file', args: { path: 'src/db/client.ts' } },
                        { name: 'read_file', args: { path: '../../../../etc/passwd' } },
                    ] };
                }
                const toolMsgs = req.messages.filter(m => m.role === 'tool');
                assert.equal(toolMsgs.length, 2);
                assert.match(toolMsgs[1]!.content, /Refused/);
                return 'Found the UserRecord type.';
            }
            if (stage === 'planner') {
                assert.match(req.messages[0]!.content, /Additional evidence gathered with tools/);
                assert.match(req.messages[0]!.content, /interface UserRecord/);
                assert.doesNotMatch(req.messages[0]!.content, /root:x:0:0/);
                return json(goodPlan());
            }
            return json(APPROVE);
        });
        const { result } = await runPipeline(provider, options({ exploreSteps: 3 }));
        assert.equal(result.status, 'validated');
        assert.deepEqual(result.context.explored.map(e => e.ok), [true, false]);
    });

    test('exploration is bounded by exploreSteps', async () => {
        let n = 0;
        const provider = scriptedProvider((_req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'explore') return { text: '', toolCalls: [{ name: 'list_files', args: { pattern: `src/**/*${n++}` } }] };
            if (stage === 'planner') return json(goodPlan());
            return json(APPROVE);
        });
        await runPipeline(provider, options({ exploreSteps: 2 }));
        assert.equal(provider.stages.filter(s => s === 'explore').length, 2);
    });

    test('models without tool support skip exploration with a warning', async () => {
        const warnings: string[] = [];
        const provider = scriptedProvider((_req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'explore') throw new ProviderError('tools_unsupported', 'model does not support tools');
            if (stage === 'planner') return json(goodPlan());
            return json(APPROVE);
        });
        const logger = { info() {}, step() {}, debug() {}, warn: (m: string) => warnings.push(m) };
        const { result } = await runPipeline(provider, options({ exploreSteps: 2, logger }));
        assert.equal(result.status, 'validated');
        assert.ok(warnings.some(w => /Skipping exploration/.test(w)));
    });

    test('provider failures propagate (not converted into plan text)', async () => {
        const provider = scriptedProvider(() => { throw new ProviderError('rate_limit', 'quota'); });
        await assert.rejects(runPipeline(provider, options()), (e: ProviderError) => e.kind === 'rate_limit');
    });

    test('refinePlan applies user feedback as a finding', async () => {
        const provider = scriptedProvider((req, stage) => {
            if (stage === 'creator') return json(REQUIREMENTS);
            if (stage === 'planner') return json(goodPlan());
            if (stage === 'revision') {
                assert.match(req.messages[0]!.content, /Use zod for validation/);
                const p = goodPlan();
                p.assumptions.push('zod is added as a dependency');
                return json(p);
            }
            return json(APPROVE);
        });
        const { session } = await runPipeline(provider, options());
        const refined = await refinePlan(session, 'Use zod for validation');
        assert.equal(refined.status, 'validated');
        assert.ok(refined.plan.assumptions.includes('zod is added as a dependency'));
    });

    test('renderers include status, file facts, and context reasons; JSON round-trips', async () => {
        const provider = scriptedProvider((_req, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json(APPROVE) : json(goodPlan())));
        const { result } = await runPipeline(provider, options());
        const md = renderMarkdown(result);
        assert.match(md, /Status:\*\* ✅ Validated/);
        assert.match(md, /`tests\/validation\.test\.ts` \(create, new file\)/);
        assert.match(md, /`src\/utils\/validation\.ts` \(modify, exists\)/);
        assert.match(md, /## Context used/);
        const parsed = JSON.parse(renderJson(result));
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.status, 'validated');
    });
});

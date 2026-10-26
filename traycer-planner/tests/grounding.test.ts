// tests/grounding.test.ts — reviewer evidence grounding and loop convergence.
// Fixtures reproduce a real qwen2.5:7b run (docs/examples/soft-delete.json).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collectStrings, extractQuotes, groundFindings, normalizeText, sameFindings } from '../src/agents/grounding.js';
import type { Finding } from '../src/agents/schemas.js';
import { runPipeline } from '../src/pipeline.js';
import { goodPlan, json, REQUIREMENTS, SAMPLE_APP, scriptedProvider } from './helpers.js';

const requirements = {
    requirements: [
        { id: 'R1', description: 'Add a `deletedAt` timestamp to the User model in the database.' },
        { id: 'R3', description: 'Update the users route to handle soft deletion requests and return appropriate responses.' },
    ],
};

const reviewerFinding = (evidence: string, severity: Finding['severity'] = 'major'): Finding => ({
    source: 'reviewer', severity, category: 'missing-requirement', taskId: null, issue: 'issue', evidence, suggestion: 'fix',
});

describe('extractQuotes', () => {
    test('finds quotations but not apostrophes or short code spans', () => {
        assert.deepEqual(extractQuotes(`Requirement R3 states: 'User records with a non-null value should not appear.' The plan's tasks don't.`),
            ['User records with a non-null value should not appear.']);
        assert.deepEqual(extractQuotes('see "the listUsers function returns everything" and `db`'), ['the listUsers function returns everything']);
    });

    test('prose between two short code spans is not a quote (regression from a live run)', () => {
        const evidence = 'Requirement R1 mentions that the `UserRecord` interface and db client need to support soft delete. However, there is no explicit mention of updating the `listUsers` method to exclude soft-deleted users.';
        assert.deepEqual(extractQuotes(evidence), []);
        assert.equal(groundFindings([reviewerFinding(evidence)], 'unrelated corpus')[0]!.severity, 'major', 'finding kept');
        assert.deepEqual(extractQuotes('use "a" then "a much longer quotation that counts"'), ['a much longer quotation that counts']);
    });
});

describe('groundFindings', () => {
    const corpus = collectStrings(requirements);

    test('downgrades a finding whose quoted requirement does not exist (observed fabrication)', () => {
        const [f] = groundFindings([reviewerFinding("Requirement R3 states: 'User records with a non-null `deletedAt` value should not appear in listings unless explicitly requested.'")], corpus);
        assert.equal(f!.severity, 'minor');
        assert.match(f!.evidence, /downgraded from major/);
    });

    test('keeps a finding whose quote matches, ignoring backticks, case, and the final period', () => {
        const [f] = groundFindings([reviewerFinding("Requirement R1 states: 'add a deletedAt timestamp to the user model in the database'")], corpus);
        assert.equal(f!.severity, 'major');
    });

    test('leaves unquoted, validator, and minor findings alone', () => {
        const input: Finding[] = [
            reviewerFinding('The service does not filter deleted users.'),
            { ...reviewerFinding('"completely invented sentence for testing"'), source: 'validator' },
            reviewerFinding('"completely invented sentence for testing"', 'minor'),
        ];
        assert.deepEqual(groundFindings(input, corpus), input);
    });

    test('code excerpts are matched without their line-number prefixes', () => {
        const code = '12| export function listUsers(): UserRecord[] {\n13|     return [...db.users.values()];';
        assert.ok(normalizeText(code).includes(normalizeText('return [...db.users.values()];')));
    });
});

describe('convergence', () => {
    test('sameFindings compares blocking findings as sets', () => {
        const a = reviewerFinding('x');
        const b = { ...reviewerFinding('y'), issue: 'other issue' };
        assert.equal(sameFindings([a, b], [b, a]), true);
        assert.equal(sameFindings([a], [a, b]), false);
        assert.equal(sameFindings([], []), false);
    });

    test('the pipeline stops early when a revision does not change the blocking findings', async () => {
        const stuck = { verdict: 'revise', summary: 's', findings: [{ severity: 'major', category: 'testing', taskId: 'T2', issue: 'No route-level test.', evidence: 'R1 is about HTTP 400.', suggestion: 'Add one.' }] };
        const provider = scriptedProvider((_r, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json(stuck) : json(goodPlan())));
        const { result } = await runPipeline(provider, { repo: SAMPLE_APP, goal: 'Validate email', maxFiles: 6, maxContextChars: 20_000, maxRevisions: 3, exploreSteps: 0, review: true, temperature: 0 });
        // Without the check: 1 + 1 + 4 reviews + 3 revisions = 9 calls. With it: stop after the 2nd review.
        assert.deepEqual(provider.stages, ['creator', 'planner', 'reviewer', 'revision', 'reviewer']);
        assert.equal(result.status, 'unresolved');
        assert.match(result.warnings.join(), /did not change the blocking findings/);
    });

    test('a fabricated quote cannot block the plan', async () => {
        const fabricated = { verdict: 'revise', summary: 's', findings: [{ severity: 'major', category: 'missing-requirement', taskId: null, issue: 'Listing exclusion missing.', evidence: "R2 states: 'Deleted users must never be returned by any endpoint whatsoever.'", suggestion: 'Add it.' }] };
        const provider = scriptedProvider((_r, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json(fabricated) : json(goodPlan())));
        const { result } = await runPipeline(provider, { repo: SAMPLE_APP, goal: 'Validate email', maxFiles: 6, maxContextChars: 20_000, maxRevisions: 2, exploreSteps: 0, review: true, temperature: 0 });
        assert.equal(result.status, 'validated');
        assert.equal(result.minorFindings.filter(f => /downgraded from major/.test(f.evidence)).length, 1);
    });
});

describe('reviewer context: planned vs existing', () => {
    test('the reviewer is told which files and symbols are new, and existing symbols are not listed as new', async () => {
        const plan = goodPlan();
        plan.tasks[0]!.files[0]!.symbols = ['isValidEmail', 'isNonEmptyString']; // new + existing
        const provider = scriptedProvider((_r, stage) => (stage === 'creator' ? json(REQUIREMENTS) : stage === 'reviewer' ? json({ verdict: 'approve', summary: 's', findings: [] }) : json(plan)));
        await runPipeline(provider, { repo: SAMPLE_APP, goal: 'Validate email', maxFiles: 6, maxContextChars: 20_000, maxRevisions: 0, exploreSteps: 0, review: true, temperature: 0 });
        const review = provider.requests[provider.stages.indexOf('reviewer')]!;
        const section = review.messages[0]!.content.split('## Files and symbols this plan introduces')[1]!.split('\n## ')[0]!;
        assert.match(section, /isValidEmail/);
        assert.match(section, /tests\/validation\.test\.ts/);
        assert.doesNotMatch(section, /isNonEmptyString/, 'existing symbol is not "new"');
        assert.match(review.system, /AFTER the plan is carried out/);
        assert.match(review.system, /Do not report an open question as a missing\s+requirement/);
    });
});

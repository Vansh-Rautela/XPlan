// tests/plan.test.ts — deterministic validation and rendering
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PlanSchema, type Plan, type Requirements } from '../src/agents/schemas.js';
import { buildIndex } from '../src/repo/indexer.js';
import { topologicalOrder, validatePlan } from '../src/plan/validate.js';
import { goodPlan, makeTempRepo, REQUIREMENTS, SAMPLE_APP } from './helpers.js';

const requirements = REQUIREMENTS as Requirements;
const plan = (): Plan => PlanSchema.parse(goodPlan());

describe('topologicalOrder', () => {
    test('orders tasks and detects cycles', () => {
        assert.deepEqual(topologicalOrder([{ id: 'T2', dependsOn: ['T1'] }, { id: 'T1', dependsOn: [] }]).order, ['T1', 'T2']);
        const cyc = topologicalOrder([{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }, { id: 'C', dependsOn: [] }]);
        assert.deepEqual(cyc.order, []);
        assert.deepEqual(cyc.cyclic.sort(), ['A', 'B']);
    });
});

describe('validatePlan', () => {
    test('a correct plan produces no blocking findings and verified file facts', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const result = validatePlan(plan(), requirements, index);
        assert.deepEqual(result.findings.filter(f => f.severity !== 'minor'), []);
        assert.deepEqual(result.order, ['T1', 'T2']);
        assert.deepEqual(result.fileFacts.T2!.map(f => f.status), ['exists', 'new']);
    });

    test('flags unknown files, create-existing, unknown/cyclic deps, coverage, and missing tests', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        p.tasks[0]!.files.push({ path: 'src/services/userServce.ts', action: 'modify', symbols: [], change: '' });
        p.tasks[0]!.files.push({ path: 'src/server.ts', action: 'create', symbols: [], change: '' });
        p.tasks[0]!.files.push({ path: '../outside.ts', action: 'modify', symbols: [], change: '' });
        p.tasks[0]!.dependsOn = ['T2'];
        p.tasks[1]!.dependsOn = ['T1', 'T9'];
        p.tasks[0]!.requirementIds = ['R1', 'R7'];
        p.tasks[1]!.requirementIds = ['R1'];
        p.tasks.forEach(t => (t.tests = []));

        const issues = validatePlan(p, requirements, index).findings.map(f => `${f.severity}:${f.issue}`);
        const has = (re: RegExp) => assert.ok(issues.some(i => re.test(i)), `${re} in\n${issues.join('\n')}`);
        has(/^major:.*userServce\.ts, which does not exist/);
        has(/^major:.*creates src\/server\.ts, but that file already exists/);
        has(/^blocker:.*outside the repository/);
        has(/^blocker:.*unknown task "T9"/);
        has(/^blocker:Circular task dependencies/);
        has(/^major:Requirement R2/);
        has(/^minor:.*unknown requirement id\(s\) R7/);
        has(/^major:The plan does not specify any tests/);
    });

    test('suggests near matches for missing files', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        p.tasks[0]!.files = [{ path: 'src/validation.ts', action: 'modify', symbols: [], change: '' }];
        const f = validatePlan(p, requirements, index).findings.find(x => x.category === 'incorrect-file')!;
        assert.match(f.suggestion, /src\/utils\/validation\.ts/);
    });

    test('changing a secrets file is flagged', async () => {
        const index = await buildIndex(await makeTempRepo({ '.env': 'A=1', 'src/utils/validation.ts': '', 'src/routes/users.ts': '' }));
        const p = plan();
        p.tasks[0]!.files.push({ path: '.env', action: 'modify', symbols: [], change: 'add var' });
        const f = validatePlan(p, requirements, index).findings.find(x => x.category === 'risk');
        assert.ok(f && f.severity === 'major');
    });

    test('a task using a symbol introduced by another task must depend on it (seen in a live run)', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        // Reproduces a qwen2.5:7b plan: the route task uses validateEmail but runs independently of the task adding it.
        p.tasks = [
            { ...p.tasks[1]!, id: 'T1', dependsOn: [], files: [{ path: 'src/routes/users.ts', action: 'modify', symbols: ['createUser'], change: 'Import `validateEmail` and use it before creating a user.' }] },
            { ...p.tasks[0]!, id: 'T2', dependsOn: [], files: [{ path: 'src/utils/validation.ts', action: 'modify', symbols: ['validateEmail'], change: 'Add validateEmail.' }] },
        ];
        const f = validatePlan(p, requirements, index).findings.find(x => x.category === 'dependency');
        assert.ok(f, 'missing dependency detected');
        assert.equal(f!.severity, 'major');
        assert.equal(f!.taskId, 'T1');
        assert.match(f!.suggestion, /"T2"/);

        p.tasks[0]!.dependsOn = ['T2'];
        assert.equal(validatePlan(p, requirements, index).findings.filter(x => x.category === 'dependency').length, 0);
    });

    test('a task modifying a file created by another task must depend on it, transitively is fine', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        p.tasks.push({ ...p.tasks[1]!, id: 'T3', dependsOn: [], files: [{ path: 'tests/validation.test.ts', action: 'modify', symbols: [], change: 'Extend tests.' }] });
        assert.ok(validatePlan(p, requirements, index).findings.some(f => f.category === 'dependency' && f.taskId === 'T3'));
        p.tasks[2]!.dependsOn = ['T2']; // T2 creates the file
        assert.ok(!validatePlan(p, requirements, index).findings.some(f => f.category === 'dependency'));
        p.tasks.push({ ...p.tasks[2]!, id: 'T4', dependsOn: ['T3'] }); // T4 → T3 → T2 (transitive)
        assert.ok(!validatePlan(p, requirements, index).findings.some(f => f.category === 'dependency'));
    });

    test('existing symbols do not create ordering constraints', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        p.tasks[1]!.dependsOn = [];
        p.tasks[0]!.files[0]!.symbols = ['isNonEmptyString']; // already in the repo
        p.tasks[1]!.files[0]!.change = 'Keep calling isNonEmptyString.';
        assert.ok(!validatePlan(p, requirements, index).findings.some(f => f.category === 'dependency'));
    });

    test('test files named in tasks must exist or be created by the plan (observed in a live run)', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        p.tasks[0]!.tests = ['src/services/userService.test.ts', 'tests/validation.test.ts: created by T2', 'tests/userService.test.ts: extend'];
        const testing = validatePlan(p, requirements, index).findings.filter(f => f.category === 'testing');
        assert.equal(testing.length, 1, testing.map(f => f.issue).join('\n'));
        assert.match(testing[0]!.issue, /src\/services\/userService\.test\.ts, which does not exist/);
        assert.match(testing[0]!.suggestion, /tests\/userService\.test\.ts/);
        assert.equal(testing[0]!.severity, 'minor');
    });

    test('duplicate task ids are blockers', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const p = plan();
        p.tasks[1]!.id = 'T1';
        p.tasks[1]!.dependsOn = [];
        assert.ok(validatePlan(p, requirements, index).findings.some(f => f.severity === 'blocker' && /Duplicate/.test(f.issue)));
    });
});

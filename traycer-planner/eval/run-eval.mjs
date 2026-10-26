// eval/run-eval.mjs — evaluates XPlan on synthetic tasks against tests/fixtures/sample-app.
//
//   node eval/run-eval.mjs --retrieval-only          deterministic, no model calls
//   node eval/run-eval.mjs [--provider ollama --model qwen2.5:7b-instruct] [--only id,id]
//   node eval/run-eval.mjs --tasks eval/tasks-xplan.json --retrieval-only   real-codebase benchmark
//
// Metrics per task (full mode):
//   recall     share of expected files the plan touches
//   forbidden  number of clearly unrelated files the plan touches (lower is better)
//   tests      whether every task lists at least one test
//   status     validated / unresolved / unreviewed
// Retrieval mode reports recall of expected files within the context budget.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { resolveConfig } from '../dist/config.js';
import { createProvider } from '../dist/llm/index.js';
import { createLogger } from '../dist/logger.js';
import { prepareContext, runPipeline } from '../dist/pipeline.js';

dotenv.config({ quiet: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { values } = parseArgs({
    options: {
        'retrieval-only': { type: 'boolean' },
        tasks: { type: 'string' },
        'min-recall': { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        only: { type: 'string' },
        'max-revisions': { type: 'string' },
        'explore-steps': { type: 'string' },
        seed: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
    },
});

const tasksFile = values.tasks ? path.resolve(values.tasks) : path.join(here, 'tasks.json');
const spec = JSON.parse(await fs.readFile(tasksFile, 'utf8'));
const indexOptions = { ignore: spec.ignore ?? [] };
const setName = path.basename(tasksFile, '.json');
const repo = path.resolve(root, spec.repo);
const only = values.only ? new Set(values.only.split(',')) : null;
const tasks = spec.tasks.filter(t => !only || only.has(t.id));
const config = resolveConfig({
    provider: values.provider,
    model: values.model,
    maxRevisions: values['max-revisions'],
    exploreSteps: values['explore-steps'],
    seed: values.seed ?? '7',
});
const logger = createLogger(values.verbose ? 'debug' : 'silent');
const pct = x => `${Math.round(x * 100)}%`;
const rows = [];

if (values['retrieval-only']) {
    for (const task of tasks) {
        const { pack } = await prepareContext({ repo, goal: task.goal, maxFiles: config.maxFiles, maxContextChars: config.maxContextChars, index: indexOptions });
        const included = pack.files.map(f => f.path);
        const top3 = included.slice(0, 3);
        const hit = task.expected.filter(f => included.includes(f));
        rows.push({
            id: task.id,
            recallInContext: hit.length / task.expected.length,
            recallTop3: task.expected.filter(f => top3.includes(f)).length / task.expected.length,
            contextFiles: included.length,
            forbiddenInContext: task.forbidden.filter(f => included.includes(f)).length,
            missed: task.expected.filter(f => !included.includes(f)),
        });
    }
    console.log(`Retrieval-only evaluation: ${setName} (budget ${config.maxFiles} files / ${config.maxContextChars} chars)\n`);
    console.table(rows.map(r => ({ task: r.id, 'recall@budget': pct(r.recallInContext), 'recall@3': pct(r.recallTop3), files: r.contextFiles, 'forbidden in ctx': r.forbiddenInContext, missed: r.missed.join(', ') })));
    const mean = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    console.log(`Mean recall@budget ${pct(mean('recallInContext'))}, recall@3 ${pct(mean('recallTop3'))}`);
    // Regression gate for CI: fail when mean recall within the budget drops below the threshold.
    if (values['min-recall'] !== undefined && mean('recallInContext') < Number(values['min-recall'])) {
        console.error(`FAIL: mean recall@budget ${pct(mean('recallInContext'))} is below --min-recall ${values['min-recall']}`);
        process.exitCode = 1;
    }
} else {
    const provider = createProvider(config, logger);
    console.log(`Full evaluation with ${config.provider}/${config.model} (seed ${config.seed}, ${tasks.length} task(s))\n`);
    for (const task of tasks) {
        const started = Date.now();
        try {
            const { result } = await runPipeline(provider, {
                repo, goal: task.goal,
                maxFiles: config.maxFiles, maxContextChars: config.maxContextChars,
                maxRevisions: config.maxRevisions, exploreSteps: config.exploreSteps,
                review: true, temperature: config.temperature, index: indexOptions, logger,
            });
            const changes = result.plan.tasks.flatMap(t => t.files);
            const touched = new Set(changes.map(f => f.path));
            const created = changes.filter(f => f.action === 'create').map(f => f.path);
            rows.push({
                id: task.id,
                status: result.status,
                recall: task.expected.filter(f => touched.has(f)).length / task.expected.length,
                forbidden: task.forbidden.filter(f => touched.has(f)).length,
                createOk: task.expectCreateUnder ? created.some(p => p.startsWith(task.expectCreateUnder)) : null,
                testsEveryTask: result.plan.tasks.every(t => t.tests.length > 0),
                tasks: result.plan.tasks.length,
                rounds: result.review.rounds.length,
                unresolved: result.unresolvedFindings.length,
                calls: result.stats.llmCalls,
                seconds: Math.round((Date.now() - started) / 1000),
                files: [...touched],
                // Kept so "unresolved" can be diagnosed (real problem vs reviewer noise) without rerunning.
                unresolvedFindings: result.unresolvedFindings.map(f => ({ source: f.source, severity: f.severity, category: f.category, taskId: f.taskId, issue: f.issue, evidence: f.evidence })),
                downgradedFindings: result.minorFindings.filter(f => f.evidence.includes('quoted evidence was not found')).length,
                stoppedEarly: result.warnings.some(w => w.includes('did not change the blocking findings')),
            });
        } catch (error) {
            rows.push({ id: task.id, status: 'error', error: String(error?.message ?? error), seconds: Math.round((Date.now() - started) / 1000) });
        }
        const r = rows.at(-1);
        console.log(`${r.id}: ${r.status}${r.error ? ` — ${r.error}` : ` · recall ${pct(r.recall)} · forbidden ${r.forbidden} · ${r.calls} calls · ${r.seconds}s`}`);
    }
    console.log('');
    console.table(rows.map(r => ({
        task: r.id, status: r.status, recall: r.recall === undefined ? '-' : pct(r.recall), forbidden: r.forbidden ?? '-',
        'new file ok': r.createOk ?? '-', 'tests/task': r.testsEveryTask ?? '-', rounds: r.rounds ?? '-', calls: r.calls ?? '-', s: r.seconds,
        downgraded: r.downgradedFindings ?? '-', 'early stop': r.stoppedEarly ?? '-',
    })));
    const ok = rows.filter(r => r.status !== 'error');
    if (ok.length) {
        const mean = k => ok.reduce((s, r) => s + Number(r[k]), 0) / ok.length;
        console.log(`Completed ${ok.length}/${rows.length} · mean recall ${pct(mean('recall'))} · mean forbidden files ${mean('forbidden').toFixed(2)} · validated ${ok.filter(r => r.status === 'validated').length}/${ok.length}`);
    }
}

const outDir = path.join(here, 'results');
await fs.mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${setName}-${values['retrieval-only'] ? 'retrieval' : `${config.provider}-${config.model.replace(/[^\w.-]/g, '_')}`}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(outFile, JSON.stringify({ provider: values['retrieval-only'] ? null : `${config.provider}/${config.model}`, seed: config.seed, rows }, null, 2));
console.log(`\nSaved ${path.relative(root, outFile)}`);

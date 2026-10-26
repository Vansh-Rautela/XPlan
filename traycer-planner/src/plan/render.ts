// src/plan/render.ts
import type { Finding } from '../agents/schemas.js';
import type { PlanningResult } from '../pipeline.js';
import type { FileStatus } from './validate.js';

const STATUS_LABEL: Record<PlanningResult['status'], string> = {
    validated: '✅ Validated — automated checks and reviewer found no blocking issues',
    unresolved: '⚠️ Unresolved — blocking findings remain after the revision limit (see "Unresolved findings")',
    unreviewed: 'ℹ️ Not reviewed — automated checks passed; reviewer was disabled (--no-review)',
};

const FILE_STATUS_LABEL: Record<FileStatus, string> = {
    'exists': 'exists',
    'new': 'new file',
    'missing': '⚠ not found in repo',
    'already-exists': '⚠ already exists',
    'outside-repo': '⚠ outside repo',
    'sensitive': '⚠ sensitive file',
};

const bullets = (items: string[], empty = '_None._') => (items.length ? items.map(i => `- ${i}`).join('\n') : empty);
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

function findingLine(f: Finding): string {
    return `- **${f.severity}** (${f.source}${f.taskId ? `, ${f.taskId}` : ''}, ${f.category}): ${f.issue}\n  - Evidence: ${f.evidence}\n  - Fix: ${f.suggestion}`;
}

export function renderMarkdown(result: PlanningResult): string {
    const { plan, requirements } = result;
    const out: string[] = [];

    out.push(`# Plan: ${plan.objective}`);
    out.push(`> **Status:** ${STATUS_LABEL[result.status]}  \n> **Goal:** ${result.goal.replace(/\n/g, ' ')}  \n> **Repository:** ${code(result.repo)} · **Model:** ${result.provider.name}/${result.provider.model} · **Review rounds:** ${result.review.rounds.length} · **LLM calls:** ${result.stats.llmCalls}`);

    if (result.warnings.length) out.push(result.warnings.map(w => `> ⚠️ ${w}`).join('\n'));

    out.push(`## Scope\n${plan.scope}`);

    out.push('## Requirements');
    out.push(requirements.requirements.map(r => `- **${r.id}** ${r.description}`).join('\n'));
    if (requirements.acceptanceCriteria.length) out.push(`**Acceptance criteria**\n${bullets(requirements.acceptanceCriteria)}`);
    if (requirements.constraints.length) out.push(`**Constraints**\n${bullets(requirements.constraints)}`);
    if (requirements.outOfScope.length) out.push(`**Out of scope**\n${bullets(requirements.outOfScope)}`);

    const assumptions = [...new Set([...requirements.assumptions, ...plan.assumptions])];
    out.push(`## Assumptions\n${bullets(assumptions)}`);

    out.push('## Tasks');
    if (result.executionOrder.length) out.push(`Execution order: ${result.executionOrder.join(' → ')}`);
    for (const task of plan.tasks) {
        const facts = result.fileFacts[task.id] ?? [];
        const meta = [
            task.dependsOn.length ? `Depends on: ${task.dependsOn.join(', ')}` : 'No dependencies',
            task.requirementIds.length ? `Covers: ${task.requirementIds.join(', ')}` : 'Covers: —',
        ].join(' · ');
        const files = task.files.map((f, i) => {
            const status = facts[i] ? FILE_STATUS_LABEL[facts[i]!.status] : '';
            const symbols = f.symbols.length ? ` — ${f.symbols.map(code).join(', ')}` : '';
            return `- ${code(f.path)} (${f.action}${status ? `, ${status}` : ''})${symbols}\n  ${f.change}`;
        });
        out.push([
            `### ${task.id}. ${task.title}`,
            `_${meta}_`,
            task.description,
            `**Why:** ${task.rationale}`,
            `**Files**\n${files.join('\n') || '_None listed._'}`,
            `**Tests**\n${bullets(task.tests)}`,
            `**Done when**\n${bullets(task.acceptanceCriteria)}`,
        ].join('\n\n'));
    }

    const verify = verificationCommands(result);
    if (verify.length) out.push(`**Verify with:** ${verify.map(code).join(' · ')}`);

    out.push('## Risks');
    out.push(plan.risks.length ? plan.risks.map(r => `- ${r.description}\n  - Mitigation: ${r.mitigation}`).join('\n') : '_None identified._');

    const questions = [...new Set([...requirements.openQuestions, ...plan.openQuestions])];
    out.push(`## Open questions\n${bullets(questions)}`);

    out.push('## Review');
    if (!result.review.enabled) {
        out.push('_Reviewer disabled._');
    } else {
        out.push(result.review.rounds.map(r => `- Round ${r.round}: verdict **${r.verdict ?? 'n/a'}**, ${r.blocking} blocking, ${r.minor} minor`).join('\n'));
        if (result.review.finalSummary) out.push(result.review.finalSummary);
    }
    if (result.unresolvedFindings.length) out.push(`### Unresolved findings\n${result.unresolvedFindings.map(findingLine).join('\n')}`);
    if (result.minorFindings.length) out.push(`### Minor findings\n${result.minorFindings.map(findingLine).join('\n')}`);

    out.push('## Context used');
    out.push(result.context.files.map(f => `- ${code(f.path)}${f.truncated ? ' (excerpt)' : ''} — ${f.reasons.join('; ')}`).join('\n') || '_No files matched the goal._');
    if (result.context.explored.length) {
        out.push(`Tool calls during exploration: ${result.context.explored.map(e => `${e.tool}(${Object.values(e.args).map(v => JSON.stringify(v)).join(', ')})`).join(', ')}`);
    }
    if (result.context.withheld.length) out.push(`Withheld: ${result.context.withheld.map(w => `${code(w.path)} (${w.reason})`).join(', ')}`);

    out.push(`---\n_Generated by XPlan at ${result.generatedAt}. This is a plan, not verified code: file facts were checked against the repository; everything else is model output._`);
    return out.join('\n\n') + '\n';
}

function verificationCommands(result: PlanningResult): string[] {
    const c = result.projectCommands;
    return [c.typecheck, c.lint, c.test, c.build].filter((x): x is string => !!x);
}

/** Tasks in dependency order (falls back to plan order if the graph is invalid). */
function orderedTasks(result: PlanningResult) {
    const byId = new Map(result.plan.tasks.map(t => [t.id, t]));
    const ordered = result.executionOrder.map(id => byId.get(id)).filter(t => t !== undefined);
    return ordered.length === result.plan.tasks.length ? ordered : result.plan.tasks;
}

/**
 * A self-contained brief for a coding agent (Claude Code, Cursor, Aider, …) or a colleague:
 * ordered steps, exact files, verification commands, and explicit stop conditions.
 */
export function renderHandoff(result: PlanningResult): string {
    const { plan, requirements } = result;
    const verify = verificationCommands(result);
    const questions = [...new Set([...requirements.openQuestions, ...plan.openQuestions])];
    const assumptions = [...new Set([...requirements.assumptions, ...plan.assumptions])];
    const out: string[] = [];

    out.push(`# Implementation brief: ${plan.objective}`);
    out.push(`You are implementing a reviewed plan in the repository at ${code(result.repo)}. Goal: ${result.goal.replace(/\n/g, ' ')}`);

    if (result.status === 'unresolved') {
        out.push(`> **⚠️ This plan did not pass review.** Resolve these before or while implementing, and tell the user how you resolved each:\n${result.unresolvedFindings.map(f => `> - (${f.taskId ?? 'plan'}) ${f.issue} — suggested fix: ${f.suggestion}`).join('\n')}`);
    }
    if (result.warnings.length) out.push(result.warnings.map(w => `> ⚠️ ${w}`).join('\n'));

    out.push(['## Rules',
        '- Implement the steps in order. Do not start a step before the steps it depends on are complete.',
        '- Change only the files listed for each step unless a change is strictly required to make it work; if so, say which file and why.',
        '- Follow the existing code style, structure, and test conventions of the files you edit.',
        `- After each step, run the verification commands${verify.length ? '' : ' (none were detected; find the project\'s test command first)'}. If they fail, fix the cause before continuing; do not weaken or delete tests to make them pass.`,
        '- Do not decide open questions silently: ask the user, or take the most conservative option and state that you did.',
        '- Statements below about the existing code are from a model and may be wrong. Check them against the actual files before relying on them.',
    ].join('\n'));

    if (verify.length) out.push(`## Verification commands\n${verify.map(c => `- \`${c}\``).join('\n')}`);

    out.push(`## Requirements\n${requirements.requirements.map(r => `- **${r.id}** ${r.description}`).join('\n')}${requirements.acceptanceCriteria.length ? `\n\nThe work is complete when:\n${bullets(requirements.acceptanceCriteria)}` : ''}`);
    if (requirements.constraints.length) out.push(`## Constraints\n${bullets(requirements.constraints)}`);
    if (requirements.outOfScope.length) out.push(`## Out of scope — do not implement\n${bullets(requirements.outOfScope)}`);
    if (assumptions.length) out.push(`## Assumptions to confirm\n${bullets(assumptions)}`);

    out.push('## Steps');
    orderedTasks(result).forEach((task, i) => {
        const facts = result.fileFacts[task.id] ?? [];
        const files = task.files.map((f, j) => {
            const status = facts[j]?.status;
            const note = status === 'new' ? 'create this file' : status === 'exists' ? `${f.action} existing file` : `${f.action}${status ? ` — ${FILE_STATUS_LABEL[status]}` : ''}`;
            return `- ${code(f.path)} (${note})${f.symbols.length ? ` — ${f.symbols.map(code).join(', ')}` : ''}: ${f.change}`;
        });
        out.push([
            `### Step ${i + 1} (${task.id}): ${task.title}`,
            task.dependsOn.length ? `Requires: ${task.dependsOn.join(', ')} completed.` : '',
            task.description,
            `Why: ${task.rationale}`,
            `Files:\n${files.join('\n') || '- (none listed — determine the files before editing)'}`,
            task.tests.length ? `Tests to add or update:\n${bullets(task.tests)}` : '',
            task.acceptanceCriteria.length ? `Done when:\n${bullets(task.acceptanceCriteria)}` : '',
        ].filter(Boolean).join('\n\n'));
    });

    if (plan.risks.length) out.push(`## Risks to watch\n${plan.risks.map(r => `- ${r.description} → ${r.mitigation}`).join('\n')}`);
    if (questions.length) out.push(`## Open questions — ask before deciding\n${bullets(questions)}`);
    out.push('## When you finish\nSummarise what you changed per step, the verification results, and any deviation from this brief.');
    return out.join('\n\n') + '\n';
}

export function renderJson(result: PlanningResult): string {
    return JSON.stringify(result, null, 2) + '\n';
}

/** Short stderr summary printed after a run. */
export function renderSummary(result: PlanningResult): string {
    const files = new Set(result.plan.tasks.flatMap(t => t.files.map(f => f.path)));
    const lines = [
        `Status: ${result.status}`,
        `${result.plan.tasks.length} task(s), ${files.size} file(s), ${result.unresolvedFindings.length} unresolved and ${result.minorFindings.length} minor finding(s)`,
        `${result.stats.llmCalls} LLM call(s) in ${(result.stats.durationMs / 1000).toFixed(1)}s` +
            (result.stats.inputTokens ? `, ~${result.stats.inputTokens.toLocaleString()} input / ${result.stats.outputTokens.toLocaleString()} output tokens` : ''),
    ];
    return lines.join('\n');
}

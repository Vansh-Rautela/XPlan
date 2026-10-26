// src/agents/planner.ts
// Planner: turns requirements + retrieved code into an ordered, file-level plan, and revises it
// when the validator, reviewer, or user reports problems.
import { generateStructured } from '../llm/structured.js';
import { runToolLoop, type ToolLoopResult } from '../llm/toolLoop.js';
import type { LLMProvider } from '../llm/types.js';
import type { Logger } from '../logger.js';
import type { RepoToolset } from '../repo/tools.js';
import { formatFindings, SHARED_RULES } from './format.js';
import { PlanSchema, type Finding, type Plan, type Requirements } from './schemas.js';

const SYSTEM = `${SHARED_RULES}

You are the PLANNER stage. Produce an actionable, file-level implementation plan.
- Tasks use ids T1, T2, … in a sensible execution order. dependsOn may only reference other task ids in this plan.
- Every requirement id must appear in at least one task's requirementIds.
- files[].action: "modify" or "delete" only for paths that exist in the repository map; "create" for new files.
  Copy existing paths exactly. Never claim a file exists unless it is in the repository map.
- For each task give the rationale, affected symbols, specific tests (which test file, which behaviour), and acceptance criteria.
- Reuse existing modules, helpers, and test conventions seen in the context instead of introducing new frameworks.
- Do not prescribe a rewrite when a local change is enough. Keep the number of tasks proportional to the goal.
- List regressions as risks with mitigations, and anything you could not verify as assumptions or openQuestions.`;

const EXPLORE_SYSTEM = `${SHARED_RULES}

You are gathering evidence before an implementation plan is written. Some code is already in the context.
Use the tools to look at what is still missing: call sites, interfaces, configuration, and existing tests for the code that must change.
Make focused calls. When you have enough evidence (or nothing else is needed), stop calling tools and reply with a short list of findings.`;

export interface PlannerContext {
    goal: string;
    requirements: Requirements;
    repoOverview: string;
    /** Formatted code context (see formatContextPack). */
    codeContext: string;
}

interface CallOpts {
    temperature?: number;
    signal?: AbortSignal;
    logger?: Logger;
}

function basePrompt(ctx: PlannerContext): string {
    return [
        `## Goal\n${ctx.goal}`,
        `## Requirements (from the Creator stage)\n${JSON.stringify(ctx.requirements, null, 2)}`,
        `## Repository map\n${ctx.repoOverview}`,
        `## Code context\n${ctx.codeContext || '(no relevant files found)'}`,
    ].join('\n\n');
}

export function runExploration(
    provider: LLMProvider,
    input: { goal: string; requirements: Requirements; contextPaths: string[]; toolset: RepoToolset; maxSteps: number; maxChars: number },
    opts: CallOpts,
): Promise<ToolLoopResult> {
    const prompt = [
        `## Goal\n${input.goal}`,
        `## Requirements\n${input.requirements.requirements.map(r => `${r.id}: ${r.description}`).join('\n')}`,
        `## Files already in context\n${input.contextPaths.join('\n') || '(none)'}`,
    ].join('\n\n');
    return runToolLoop(provider, { system: EXPLORE_SYSTEM, prompt, toolset: input.toolset, maxSteps: input.maxSteps, maxChars: input.maxChars, ...opts });
}

export function runPlanner(provider: LLMProvider, ctx: PlannerContext, opts: CallOpts): Promise<Plan> {
    return generateStructured(provider, { stage: 'Planner', system: SYSTEM, prompt: basePrompt(ctx), schema: PlanSchema, ...opts });
}

export function revisionPrompt(ctx: PlannerContext, previous: Plan, findings: Finding[]): string {
    return [
        basePrompt(ctx),
        `## Previous plan\n${JSON.stringify(previous, null, 2)}`,
        `## Problems to fix\n${formatFindings(findings)}`,
        'Return the complete revised plan. Fix every problem above. If a problem cannot be fixed with the available information, keep the plan consistent and record it under openQuestions instead of guessing.',
    ].join('\n\n');
}

export function runRevision(provider: LLMProvider, ctx: PlannerContext, previous: Plan, findings: Finding[], opts: CallOpts): Promise<Plan> {
    return generateStructured(provider, { stage: 'Planner (revision)', system: SYSTEM, prompt: revisionPrompt(ctx, previous, findings), schema: PlanSchema, ...opts });
}

// src/agents/reviewer.ts
// Reviewer: an independent check of the plan against the requirements and the code. It receives
// the automated validation results so it focuses on what the validator cannot see.
import { generateStructured } from '../llm/structured.js';
import type { LLMProvider } from '../llm/types.js';
import type { Logger } from '../logger.js';
import type { FileFact } from '../plan/validate.js';
import { formatFindings, SHARED_RULES } from './format.js';
import { ReviewSchema, type Finding, type Plan, type Requirements, type Review } from './schemas.js';

const SYSTEM = `${SHARED_RULES}

You are the REVIEWER stage. Critically evaluate the plan; do not restate it.
Check: requirements and acceptance criteria are fully covered; files and symbols match the code context; dependencies
between tasks are correct; assumptions are supported; scope is proportionate (no rewrites or unrequested features);
tests exercise the changed behaviour; the plan respects the existing architecture and conventions.
- Report only concrete problems with evidence (requirement ids, file paths, line numbers from the context).
- Severity: blocker = the plan would fail or is unsafe; major = missing requirement, wrong file/symbol, missing
  dependency, or core behaviour untested; minor = clarity or polish.
- Judge the plan against the code as it will be AFTER the plan is carried out. Files marked "new" and symbols the plan
  introduces do not exist yet by design; tests the plan lists are to be written. Do not report them as missing.
- Open questions and assumptions are deliberately left to the user. Do not report an open question as a missing
  requirement; only report it if the plan silently decides it.
- Do not repeat problems already listed under "Automated validation"; they are tracked separately.
- verdict is "approve" only if you report no blocker or major findings.`;

export interface ReviewerInput {
    goal: string;
    requirements: Requirements;
    plan: Plan;
    codeContext: string;
    fileFacts: Record<string, FileFact[]>;
    validatorFindings: Finding[];
    /** New files and symbols the plan introduces (computed against the repository index). */
    introduced: string[];
}

export function reviewerPrompt(input: ReviewerInput): string {
    const facts = Object.entries(input.fileFacts)
        .flatMap(([taskId, list]) => list.map(f => `${taskId}: ${f.action} ${f.path} → ${f.status}`))
        .join('\n');
    return [
        `## Goal\n${input.goal}`,
        `## Requirements\n${JSON.stringify(input.requirements, null, 2)}`,
        `## Plan under review\n${JSON.stringify(input.plan, null, 2)}`,
        `## Verified file facts (checked against the repository)\n${facts || '(no files in plan)'}`,
        `## Files and symbols this plan introduces (they do not exist yet; that is expected)\n${input.introduced.join(', ') || '(none)'}`,
        `## Automated validation\n${formatFindings(input.validatorFindings)}`,
        `## Code context\n${input.codeContext || '(none)'}`,
    ].join('\n\n');
}

export function runReviewer(provider: LLMProvider, input: ReviewerInput, opts: { temperature?: number; signal?: AbortSignal; logger?: Logger }): Promise<Review> {
    return generateStructured(provider, { stage: 'Reviewer', system: SYSTEM, prompt: reviewerPrompt(input), schema: ReviewSchema, ...opts });
}

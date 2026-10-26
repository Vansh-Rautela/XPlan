// src/agents/schemas.ts
// Contracts between pipeline stages. Model output is validated against these at runtime.
import { z } from 'zod';

const text = (description: string) => z.string().describe(description);
const list = (description: string) => z.array(z.string()).default([]).describe(description);

// ── Creator ──────────────────────────────────────────────────────────────────

export const RequirementSchema = z.object({
    id: text('Stable id: R1, R2, …'),
    description: text('One testable requirement derived from the goal.'),
});

export const RequirementsSchema = z.object({
    summary: text('One or two sentences: the expected outcome.'),
    requirements: z.array(RequirementSchema).min(1).describe('Explicit, testable requirements.'),
    acceptanceCriteria: list('Observable conditions that show the goal is met.'),
    constraints: list('Constraints stated or implied by the goal or the codebase.'),
    assumptions: list('Assumptions made because the goal is ambiguous.'),
    openQuestions: list('Questions the user should answer; ambiguity that affects the plan.'),
    outOfScope: list('Things deliberately not included.'),
    searchTerms: list('Identifiers or keywords likely to appear in relevant code.'),
    candidatePaths: list('Existing repository paths (copied exactly from the file list) that are probably relevant.'),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

// ── Planner ──────────────────────────────────────────────────────────────────

export const FileActionSchema = z.enum(['modify', 'create', 'delete']);

export const FileChangeSchema = z.object({
    path: text('Repository-relative path.'),
    action: FileActionSchema.describe('modify/delete: existing file; create: new file.'),
    symbols: list('Functions, classes, or exports affected.'),
    change: text('What changes in this file and why.'),
});

export const TaskSchema = z.object({
    id: text('Stable id: T1, T2, …'),
    title: text('Short imperative title.'),
    description: text('What to do.'),
    rationale: text('Why this change is needed and why here.'),
    files: z.array(FileChangeSchema).default([]),
    dependsOn: list('Ids of tasks that must be done first.'),
    requirementIds: list('Requirement ids (R…) this task satisfies.'),
    tests: list('Specific tests to add or update (file and behaviour).'),
    acceptanceCriteria: list('How to verify this task is done.'),
});
export type Task = z.infer<typeof TaskSchema>;

export const RiskSchema = z.object({
    description: text('What could go wrong or regress.'),
    mitigation: text('How to prevent or detect it.'),
});

export const PlanSchema = z.object({
    objective: text('The objective in one sentence.'),
    scope: text('What is in and out of scope.'),
    assumptions: list('Assumptions, especially about code not shown in the context.'),
    tasks: z.array(TaskSchema).min(1),
    risks: z.array(RiskSchema).default([]),
    openQuestions: list('Unresolved questions.'),
});
export type Plan = z.infer<typeof PlanSchema>;

// ── Reviewer ─────────────────────────────────────────────────────────────────

export const SeveritySchema = z.enum(['blocker', 'major', 'minor']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingCategorySchema = z.enum([
    'missing-requirement',
    'incorrect-file',
    'unsupported-assumption',
    'dependency',
    'scope',
    'testing',
    'architecture',
    'risk',
    'other',
]);

export const ReviewFindingSchema = z.object({
    severity: SeveritySchema,
    category: FindingCategorySchema,
    taskId: z.string().nullable().default(null).describe('Task id the finding refers to, or null for the whole plan.'),
    issue: text('The concrete problem.'),
    evidence: text('Why you believe this: cite requirement ids, file paths, or line numbers from the context.'),
    suggestion: text('The concrete correction.'),
});

export const ReviewSchema = z.object({
    verdict: z.enum(['approve', 'revise']).describe('approve only if there are no blocker or major findings.'),
    summary: text('One-paragraph assessment.'),
    findings: z.array(ReviewFindingSchema).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

/** A finding from any source; validator and user findings use the same shape as reviewer ones. */
export interface Finding {
    source: 'validator' | 'reviewer' | 'user';
    severity: Severity;
    category: z.infer<typeof FindingCategorySchema>;
    taskId: string | null;
    issue: string;
    evidence: string;
    suggestion: string;
}

export function isBlocking(finding: Pick<Finding, 'severity'>): boolean {
    return finding.severity === 'blocker' || finding.severity === 'major';
}

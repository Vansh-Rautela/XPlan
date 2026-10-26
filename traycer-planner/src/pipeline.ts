// src/pipeline.ts
// Creator → (optional tool exploration) → Planner → [validate + review → revise] × N
//
// Model calls per run: 1 Creator + ≤ exploreSteps + 1 Planner + (revisions + 1) Reviewer + revisions.
import { runCreator } from './agents/creator.js';
import { formatContextPack } from './agents/format.js';
import { collectStrings, groundFindings, sameFindings } from './agents/grounding.js';
import { runExploration, runPlanner, runRevision, type PlannerContext } from './agents/planner.js';
import { runReviewer } from './agents/reviewer.js';
import { isBlocking, type Finding, type Plan, type Requirements, type Review } from './agents/schemas.js';
import { ProviderError, errorMessage } from './errors.js';
import type { ToolObservation } from './llm/toolLoop.js';
import type { ChatRequest, ChatResponse, LLMProvider } from './llm/types.js';
import { silentLogger, type Logger } from './logger.js';
import { planIntroductions, validatePlan, type FileFact, type ValidationResult } from './plan/validate.js';
import { buildIndex, type IndexOptions, type IndexStats, type RepoIndex } from './repo/indexer.js';
import { buildContextPack, extractMentionedPaths, extractTerms, rankFiles, renderRepoOverview, type ContextPack } from './repo/retrieval.js';
import { detectProjectCommands, type ProjectCommands } from './repo/project.js';
import { RepoToolset } from './repo/tools.js';

export interface PipelineOptions {
    repo: string;
    goal: string;
    maxFiles: number;
    maxContextChars: number;
    maxRevisions: number;
    exploreSteps: number;
    review: boolean;
    temperature: number;
    index?: IndexOptions;
    signal?: AbortSignal;
    logger?: Logger;
}

export type PlanStatus = 'validated' | 'unresolved' | 'unreviewed';

export interface ReviewRound {
    round: number;
    verdict: Review['verdict'] | null;
    summary: string | null;
    blocking: number;
    minor: number;
}

export interface PlanningResult {
    schemaVersion: 1;
    status: PlanStatus;
    goal: string;
    repo: string;
    generatedAt: string;
    provider: { name: string; model: string; remote: boolean };
    requirements: Requirements;
    plan: Plan;
    executionOrder: string[];
    /** Verification commands detected from the project's manifests (not executed by XPlan). */
    projectCommands: ProjectCommands;
    /** Conditions that may have degraded the result (e.g. context truncation). */
    warnings: string[];
    fileFacts: Record<string, FileFact[]>;
    unresolvedFindings: Finding[];
    minorFindings: Finding[];
    review: { enabled: boolean; rounds: ReviewRound[]; finalSummary: string | null };
    context: {
        terms: string[];
        files: Array<{ path: string; score: number; reasons: string[]; truncated: boolean }>;
        omitted: string[];
        withheld: Array<{ path: string; reason: string }>;
        explored: Array<{ tool: string; args: Record<string, unknown>; ok: boolean }>;
        index: IndexStats;
    };
    stats: { llmCalls: number; inputTokens: number; outputTokens: number; durationMs: number };
}

/** State kept between an initial run and later refinements (interactive mode). */
export interface PlanningSession {
    provider: MeteredProvider;
    options: PipelineOptions;
    index: RepoIndex;
    pack: ContextPack;
    observations: ToolObservation[];
    plannerContext: PlannerContext;
    requirements: Requirements;
    plan: Plan;
    startedAt: number;
}

/** Counts calls and tokens without changing behaviour. */
export class MeteredProvider implements LLMProvider {
    calls = 0;
    contextOverflows = 0;
    inputTokens = 0;
    outputTokens = 0;
    constructor(private readonly inner: LLMProvider) {}
    get name() { return this.inner.name; }
    get model() { return this.inner.model; }
    get remote() { return this.inner.remote; }
    async chat(request: ChatRequest): Promise<ChatResponse> {
        this.calls++;
        const response = await this.inner.chat(request);
        this.inputTokens += response.usage?.inputTokens ?? 0;
        this.outputTokens += response.usage?.outputTokens ?? 0;
        if (response.contextOverflow) this.contextOverflows++;
        return response;
    }
    listModels(signal?: AbortSignal) { return this.inner.listModels(signal); }
}

/** Retrieval only: no model calls. Used by `xplan context` and as the first pipeline step. */
export async function prepareContext(
    options: Pick<PipelineOptions, 'repo' | 'goal' | 'maxFiles' | 'maxContextChars' | 'index' | 'logger'>,
    hints: { extraTerms?: string[]; candidatePaths?: string[]; index?: RepoIndex } = {},
): Promise<{ index: RepoIndex; pack: ContextPack; overview: string; mentioned: string[] }> {
    const logger = options.logger ?? silentLogger;
    const index = hints.index ?? (await buildIndex(options.repo, options.index));
    if (!hints.index) {
        const s = index.stats;
        logger.step(`Indexed ${s.indexed} files in ${index.root} (${s.text} readable, ${s.sensitive} sensitive withheld, ${s.ignored} ignored, ${s.symlinksSkipped} symlinks skipped)`);
        if (s.truncated) logger.warn(`Index stopped at ${s.indexed} files; use --max-index-files to raise the limit.`);
        if (s.unsupportedIgnoreRules.length) logger.debug(`Unsupported .gitignore negation rules ignored: ${s.unsupportedIgnoreRules.join(', ')}`);
    }

    const mentioned = extractMentionedPaths(options.goal, index);
    const pinned = new Map<string, string>(mentioned.map(p => [p, 'mentioned in goal']));
    for (const candidate of hints.candidatePaths ?? []) {
        if (index.byPath.has(candidate) && !pinned.has(candidate)) pinned.set(candidate, 'selected by Creator');
    }
    const terms = [...new Set([...extractTerms(options.goal), ...(hints.extraTerms ?? []).flatMap(extractTerms)])];
    const ranked = rankFiles(index, { goal: options.goal, extraTerms: hints.extraTerms, pinned });
    const pack = buildContextPack(index, ranked, { maxFiles: options.maxFiles, maxChars: options.maxContextChars, terms });
    const overviewEntries = Math.max(80, Math.min(400, Math.floor(options.maxContextChars / 160)));
    return { index, pack, overview: renderRepoOverview(index, overviewEntries), mentioned };
}

export async function runPipeline(baseProvider: LLMProvider, options: PipelineOptions): Promise<{ result: PlanningResult; session: PlanningSession }> {
    const logger = options.logger ?? silentLogger;
    const provider = baseProvider instanceof MeteredProvider ? baseProvider : new MeteredProvider(baseProvider);
    const startedAt = Date.now();
    const call = { temperature: options.temperature, signal: options.signal, logger };

    // 1. Index (no model call) and a first, goal-only ranking for the Creator's file hints.
    const initial = await prepareContext(options);

    // 2. Creator
    logger.step(`Creator: interpreting the goal (${provider.name}/${provider.model})`);
    const requirements = await runCreator(provider, { goal: options.goal, repoOverview: initial.overview, mentionedPaths: initial.mentioned }, call);
    const unknownCandidates = requirements.candidatePaths.filter(p => !initial.index.byPath.has(p));
    if (unknownCandidates.length) logger.debug(`Creator suggested paths not in the repository (ignored): ${unknownCandidates.join(', ')}`);
    logger.info(`  ${requirements.requirements.length} requirement(s), ${requirements.openQuestions.length} open question(s)`);

    // 3. Retrieval refined with the Creator's search terms and candidate paths.
    const { index, pack, overview } = await prepareContext(options, {
        index: initial.index,
        extraTerms: requirements.searchTerms,
        candidatePaths: requirements.candidatePaths,
    });
    logger.step(`Context: ${pack.files.length} file(s), ${pack.totalChars.toLocaleString()} chars${pack.omitted.length ? `, ${pack.omitted.length} more ranked file(s) left out` : ''}`);
    for (const f of pack.files) logger.debug(`  ${f.path} (${f.score}) — ${f.reasons.join('; ')}`);

    // 4. Optional bounded exploration with read-only tools.
    let observations: ToolObservation[] = [];
    if (options.exploreSteps > 0) {
        logger.step(`Explorer: up to ${options.exploreSteps} tool step(s)`);
        try {
            const explored = await runExploration(provider, {
                goal: options.goal,
                requirements,
                contextPaths: pack.files.map(f => f.path),
                toolset: new RepoToolset(index),
                maxSteps: options.exploreSteps,
                maxChars: Math.floor(options.maxContextChars * 0.3),
            }, call);
            observations = explored.observations;
            logger.info(`  ${observations.length} tool call(s)`);
        } catch (error) {
            if (error instanceof ProviderError && (error.kind === 'tools_unsupported' || error.kind === 'bad_request')) {
                logger.warn(`Skipping exploration: ${errorMessage(error)}`);
            } else {
                throw error;
            }
        }
    }

    const plannerContext: PlannerContext = {
        goal: options.goal,
        requirements,
        repoOverview: overview,
        codeContext: formatContextPack(pack, observations),
    };

    // 5. Planner
    logger.step('Planner: drafting the plan');
    const plan = await runPlanner(provider, plannerContext, call);

    const session: PlanningSession = { provider, options, index, pack, observations, plannerContext, requirements, plan, startedAt };
    const result = await reviewLoop(session, plan);
    return { result, session };
}

/** Applies user feedback to an existing session and runs the review loop again. */
export async function refinePlan(session: PlanningSession, feedback: string): Promise<PlanningResult> {
    const logger = session.options.logger ?? silentLogger;
    const userFinding: Finding = {
        source: 'user', severity: 'major', category: 'other', taskId: null,
        issue: feedback, evidence: 'Requested by the user.', suggestion: 'Revise the plan to address this feedback.',
    };
    logger.step('Planner: applying your feedback');
    const plan = await runRevision(session.provider, session.plannerContext, session.plan, [userFinding], {
        temperature: session.options.temperature, signal: session.options.signal, logger,
    });
    session.startedAt = Date.now();
    return reviewLoop(session, plan);
}

async function reviewLoop(session: PlanningSession, initialPlan: Plan): Promise<PlanningResult> {
    const { provider, options, index, requirements, plannerContext } = session;
    const logger = options.logger ?? silentLogger;
    const call = { temperature: options.temperature, signal: options.signal, logger };
    const rounds: ReviewRound[] = [];

    let plan = initialPlan;
    let validation: ValidationResult;
    let review: Review | null = null;
    let blocking: Finding[] = [];
    let minor: Finding[] = [];
    const loopWarnings: string[] = [];

    for (let round = 0; ; round++) {
        validation = validatePlan(plan, requirements, index);
        review = null;
        if (options.review) {
            logger.step(`Reviewer: round ${round + 1} (${validation.findings.length} automated finding(s))`);
            review = await runReviewer(provider, {
                goal: options.goal,
                requirements,
                plan,
                codeContext: plannerContext.codeContext,
                fileFacts: validation.fileFacts,
                validatorFindings: validation.findings,
                introduced: [...planIntroductions(plan, index).introducedBy.keys()],
            }, call);
        }
        const corpus = [options.goal, collectStrings(requirements), collectStrings(plan), plannerContext.codeContext].join('\n');
        const reviewerFindings = groundFindings((review?.findings ?? []).map(f => ({ ...f, source: 'reviewer' as const })), corpus);
        const downgraded = reviewerFindings.filter(f => f.evidence.includes('[XPlan: the quoted evidence was not found')).length;
        if (downgraded) logger.warn(`Reviewer cited evidence that does not exist in ${downgraded} finding(s); downgraded to minor.`);
        const all = [...validation.findings, ...reviewerFindings];
        const previousBlocking = blocking;
        blocking = all.filter(isBlocking);
        minor = all.filter(f => !isBlocking(f));
        rounds.push({ round: round + 1, verdict: review?.verdict ?? null, summary: review?.summary ?? null, blocking: blocking.length, minor: minor.length });
        logger.info(`  ${blocking.length} blocking, ${minor.length} minor finding(s)${review ? ` — reviewer verdict: ${review.verdict}` : ''}`);

        if (blocking.length === 0) break;
        if (round > 0 && sameFindings(previousBlocking, blocking)) {
            const message = `Revision ${round} did not change the blocking findings; stopped early instead of spending more model calls.`;
            logger.warn(message);
            loopWarnings.push(message);
            break;
        }
        if (round >= options.maxRevisions) {
            logger.warn(`Revision limit (${options.maxRevisions}) reached with ${blocking.length} unresolved finding(s).`);
            break;
        }
        logger.step(`Planner: revision ${round + 1}/${options.maxRevisions}`);
        plan = await runRevision(provider, plannerContext, plan, all, call);
    }

    session.plan = plan;
    const status: PlanStatus = blocking.length > 0 ? 'unresolved' : options.review ? 'validated' : 'unreviewed';
    const pack = session.pack;
    return {
        schemaVersion: 1,
        status,
        goal: options.goal,
        repo: index.root,
        generatedAt: new Date().toISOString(),
        provider: { name: provider.name, model: provider.model, remote: provider.remote },
        requirements,
        plan,
        executionOrder: validation.order,
        projectCommands: detectProjectCommands(index),
        warnings: [
            ...(provider.contextOverflows > 0
                ? [`${provider.contextOverflows} model call(s) filled the context window; parts of the prompt may have been dropped. Raise --num-ctx or lower --max-context-chars.`]
                : []),
            ...loopWarnings,
        ],
        fileFacts: validation.fileFacts,
        unresolvedFindings: blocking,
        minorFindings: minor,
        review: { enabled: options.review, rounds, finalSummary: review?.summary ?? null },
        context: {
            terms: pack.terms,
            files: pack.files.map(f => ({ path: f.path, score: f.score, reasons: f.reasons, truncated: f.truncated })),
            omitted: pack.omitted.map(f => f.path),
            withheld: pack.withheld,
            explored: session.observations.map(o => ({ tool: o.tool, args: o.args, ok: o.ok })),
            index: index.stats,
        },
        stats: {
            llmCalls: provider.calls,
            inputTokens: provider.inputTokens,
            outputTokens: provider.outputTokens,
            durationMs: Date.now() - session.startedAt,
        },
    };
}

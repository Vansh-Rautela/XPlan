// src/plan/validate.ts
// Deterministic checks that do not depend on the model: they compare the plan against the
// repository index and against itself.
import type { Finding, Plan, Requirements } from '../agents/schemas.js';
import type { RepoIndex } from '../repo/indexer.js';
import { isTestPath } from '../repo/retrieval.js';
import { toRepoRelative } from '../repo/safety.js';

export type FileStatus = 'exists' | 'new' | 'missing' | 'already-exists' | 'outside-repo' | 'sensitive';

export interface FileFact {
    path: string;
    action: string;
    status: FileStatus;
}

export interface ValidationResult {
    findings: Finding[];
    /** Verified status of every path in the plan, keyed by task id. */
    fileFacts: Record<string, FileFact[]>;
    /** Task ids in a valid execution order (empty if the graph has a cycle). */
    order: string[];
}

function finding(partial: Omit<Finding, 'source' | 'evidence'> & { evidence?: string }): Finding {
    return { source: 'validator', evidence: 'Automated check against the repository index.', ...partial };
}

/** Kahn's algorithm; returns ids in dependency order, or the ids stuck in a cycle. */
export function topologicalOrder(tasks: Array<{ id: string; dependsOn: string[] }>): { order: string[]; cyclic: string[] } {
    const ids = new Set(tasks.map(t => t.id));
    const indegree = new Map(tasks.map(t => [t.id, 0]));
    const dependents = new Map<string, string[]>(tasks.map(t => [t.id, []]));
    for (const task of tasks) {
        for (const dep of new Set(task.dependsOn)) {
            if (!ids.has(dep) || dep === task.id) continue;
            indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
            dependents.get(dep)!.push(task.id);
        }
    }
    const queue = tasks.filter(t => indegree.get(t.id) === 0).map(t => t.id);
    const order: string[] = [];
    while (queue.length) {
        const id = queue.shift()!;
        order.push(id);
        for (const next of dependents.get(id) ?? []) {
            indegree.set(next, indegree.get(next)! - 1);
            if (indegree.get(next) === 0) queue.push(next);
        }
    }
    const cyclic = tasks.map(t => t.id).filter(id => !order.includes(id));
    return { order: cyclic.length ? [] : order, cyclic };
}

function dependencyClosure(plan: Plan): Map<string, Set<string>> {
    const direct = new Map(plan.tasks.map(t => [t.id, t.dependsOn]));
    const closure = new Map<string, Set<string>>();
    const visit = (id: string, seen: Set<string>): Set<string> => {
        const cached = closure.get(id);
        if (cached) return cached;
        const all = new Set<string>();
        for (const dep of direct.get(id) ?? []) {
            if (seen.has(dep)) continue;
            all.add(dep);
            for (const d of visit(dep, new Set([...seen, dep]))) all.add(d);
        }
        closure.set(id, all);
        return all;
    };
    for (const task of plan.tasks) visit(task.id, new Set([task.id]));
    return closure;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]{3,}$/;

export interface Introductions {
    /** File paths the plan creates and symbols it lists that do not exist in the repository. */
    introducedBy: Map<string, { taskId: string; kind: 'file' | 'symbol' }>;
    /** Symbols listed as new by more than one task (owner unclear). */
    ambiguous: Set<string>;
}

/** What the plan introduces. Shared by the dependency check and the reviewer prompt. */
export function planIntroductions(plan: Plan, index: RepoIndex): Introductions {
    const existingSymbols = new Set(index.files.flatMap(f => f.symbols));
    const introducedBy: Introductions['introducedBy'] = new Map();
    const ambiguous = new Set<string>();
    for (const task of plan.tasks) {
        for (const change of task.files) {
            if (change.action === 'create') introducedBy.set(change.path, { taskId: task.id, kind: 'file' });
            for (const symbol of change.symbols) {
                if (!IDENTIFIER.test(symbol) || existingSymbols.has(symbol)) continue;
                const prior = introducedBy.get(symbol);
                if (prior && prior.taskId !== task.id) ambiguous.add(symbol);
                else introducedBy.set(symbol, { taskId: task.id, kind: 'symbol' });
            }
        }
    }
    return { introducedBy, ambiguous };
}

function missingDependencyFindings(plan: Plan, index: RepoIndex): Finding[] {
    const findings: Finding[] = [];
    const deps = dependencyClosure(plan);
    const { introducedBy, ambiguous } = planIntroductions(plan, index);

    for (const task of plan.tasks) {
        const text = [task.description, ...task.files.flatMap(f => [f.change, ...f.symbols])].join('\n');
        const touchedPaths = new Set(task.files.filter(f => f.action !== 'create').map(f => f.path));
        for (const [name, { taskId, kind }] of introducedBy) {
            if (taskId === task.id || ambiguous.has(name) || deps.get(task.id)?.has(taskId)) continue;
            const uses = kind === 'file'
                ? touchedPaths.has(name)
                : new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(text);
            if (!uses) continue;
            findings.push(finding({
                severity: 'major',
                category: 'dependency',
                taskId: task.id,
                issue: `Task ${task.id} uses ${kind === 'file' ? `${name}, which task ${taskId} creates` : `${name}, which task ${taskId} introduces`}, but does not depend on ${taskId}.`,
                evidence: `${name} does not exist in the repository yet; it is added by ${taskId}.`,
                suggestion: `Add "${taskId}" to ${task.id}.dependsOn (or merge the tasks).`,
            }));
        }
    }
    return findings;
}

export function validatePlan(plan: Plan, requirements: Requirements, index: RepoIndex): ValidationResult {
    const findings: Finding[] = [];
    const fileFacts: Record<string, FileFact[]> = {};

    // Task ids
    const seen = new Set<string>();
    for (const task of plan.tasks) {
        if (seen.has(task.id)) {
            findings.push(finding({ severity: 'blocker', category: 'dependency', taskId: task.id, issue: `Duplicate task id "${task.id}".`, suggestion: 'Give every task a unique id.' }));
        }
        seen.add(task.id);
    }

    // Dependencies
    for (const task of plan.tasks) {
        for (const dep of task.dependsOn) {
            if (dep === task.id) {
                findings.push(finding({ severity: 'blocker', category: 'dependency', taskId: task.id, issue: `Task ${task.id} depends on itself.`, suggestion: 'Remove the self-dependency.' }));
            } else if (!seen.has(dep)) {
                findings.push(finding({ severity: 'blocker', category: 'dependency', taskId: task.id, issue: `Task ${task.id} depends on unknown task "${dep}".`, suggestion: `Reference an existing task id (${[...seen].join(', ')}).` }));
            }
        }
    }
    const { order, cyclic } = topologicalOrder(plan.tasks);
    if (cyclic.length) {
        findings.push(finding({ severity: 'blocker', category: 'dependency', taskId: null, issue: `Circular task dependencies between ${cyclic.join(', ')}.`, suggestion: 'Break the cycle so tasks can be executed in order.' }));
    }

    // Files
    for (const task of plan.tasks) {
        const facts: FileFact[] = [];
        if (task.files.length === 0) {
            findings.push(finding({ severity: 'minor', category: 'other', taskId: task.id, issue: `Task ${task.id} names no files.`, suggestion: 'List the files the task changes, or merge it into another task.' }));
        }
        for (const change of task.files) {
            const rel = toRepoRelative(index.root, change.path);
            if (!rel) {
                facts.push({ path: change.path, action: change.action, status: 'outside-repo' });
                findings.push(finding({ severity: 'blocker', category: 'incorrect-file', taskId: task.id, issue: `Path "${change.path}" is outside the repository.`, suggestion: 'Use a repository-relative path.' }));
                continue;
            }
            const file = index.byPath.get(rel);
            if (file?.kind === 'sensitive') {
                facts.push({ path: rel, action: change.action, status: 'sensitive' });
                findings.push(finding({ severity: 'major', category: 'risk', taskId: task.id, issue: `Task ${task.id} changes ${rel}, which looks like a secrets/credentials file.`, suggestion: 'Change an example/template file or configuration loader instead, and document the variable.' }));
                continue;
            }
            if (change.action === 'create') {
                if (file) {
                    facts.push({ path: rel, action: change.action, status: 'already-exists' });
                    findings.push(finding({ severity: 'major', category: 'incorrect-file', taskId: task.id, issue: `Task ${task.id} creates ${rel}, but that file already exists.`, suggestion: `Use action "modify" for ${rel}, or choose a new path.` }));
                } else {
                    facts.push({ path: rel, action: change.action, status: 'new' });
                }
            } else if (file) {
                facts.push({ path: rel, action: change.action, status: 'exists' });
            } else {
                facts.push({ path: rel, action: change.action, status: 'missing' });
                const similar = index.files.filter(f => f.path.endsWith('/' + rel.split('/').pop()) || f.path === rel.split('/').pop()).slice(0, 3).map(f => f.path);
                findings.push(finding({
                    severity: 'major',
                    category: 'incorrect-file',
                    taskId: task.id,
                    issue: `Task ${task.id} ${change.action === 'delete' ? 'deletes' : 'modifies'} ${rel}, which does not exist in the repository.`,
                    suggestion: similar.length ? `Did you mean ${similar.join(' or ')}? Otherwise use action "create".` : 'Use action "create" if this is a new file, or correct the path.',
                }));
            }
        }
        fileFacts[task.id] = facts;

        if (task.tests.length === 0 && task.acceptanceCriteria.length === 0) {
            findings.push(finding({ severity: 'minor', category: 'testing', taskId: task.id, issue: `Task ${task.id} has neither tests nor acceptance criteria.`, suggestion: 'Add a test or an observable acceptance criterion.' }));
        }
    }

    // Test files named in tasks must exist or be created by the plan; otherwise a developer or
    // agent following the plan is sent to a file that is not there.
    const createdByPlan = new Set(plan.tasks.flatMap(t => t.files.filter(f => f.action === 'create').map(f => toRepoRelative(index.root, f.path))));
    for (const task of plan.tasks) {
        const reported = new Set<string>();
        for (const testText of task.tests) {
            for (const token of testText.match(/[\w@.\-/]+\.[A-Za-z]{1,5}\b/g) ?? []) {
                const rel = toRepoRelative(index.root, token);
                if (!rel || !isTestPath(rel) || index.byPath.has(rel) || createdByPlan.has(rel) || reported.has(rel)) continue;
                reported.add(rel);
                const base = rel.split('/').pop()!;
                const similar = index.files.filter(f => f.path.endsWith('/' + base) || f.path === base).map(f => f.path).slice(0, 2);
                findings.push(finding({
                    severity: 'minor',
                    category: 'testing',
                    taskId: task.id,
                    issue: `Task ${task.id} refers to test file ${rel}, which does not exist and is not created by the plan.`,
                    suggestion: similar.length ? `Use ${similar.join(' or ')}.` : `Add a task file with action "create" for ${rel}, or point to an existing test file.`,
                }));
            }
        }
    }

    // Implicit ordering: a task that uses a new file or a new symbol introduced by another task
    // must depend on it (directly or transitively).
    if (!cyclic.length) findings.push(...missingDependencyFindings(plan, index));

    // Requirement coverage
    const requirementIds = new Set(requirements.requirements.map(r => r.id));
    const covered = new Set(plan.tasks.flatMap(t => t.requirementIds));
    for (const req of requirements.requirements) {
        if (!covered.has(req.id)) {
            findings.push(finding({ severity: 'major', category: 'missing-requirement', taskId: null, issue: `Requirement ${req.id} ("${req.description}") is not covered by any task.`, suggestion: `Add or extend a task and list ${req.id} in its requirementIds.` }));
        }
    }
    for (const task of plan.tasks) {
        const unknown = task.requirementIds.filter(id => !requirementIds.has(id));
        if (unknown.length) {
            findings.push(finding({ severity: 'minor', category: 'other', taskId: task.id, issue: `Task ${task.id} references unknown requirement id(s) ${unknown.join(', ')}.`, suggestion: `Use ids from: ${[...requirementIds].join(', ')}.` }));
        }
    }

    // Tests anywhere in the plan
    if (plan.tasks.every(t => t.tests.length === 0)) {
        findings.push(finding({ severity: 'major', category: 'testing', taskId: null, issue: 'The plan does not specify any tests.', suggestion: 'Add targeted tests for the changed behaviour.' }));
    }

    return { findings, fileFacts, order };
}

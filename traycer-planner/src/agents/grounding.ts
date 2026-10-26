// src/agents/grounding.ts
// Deterministic checks on reviewer output. Observed with a 7B model: the reviewer "quoted" a
// requirement that does not exist, and repeated identical findings round after round. A quote
// that cannot be found must not be able to block a plan, and a loop that is not converging
// should stop instead of spending more model calls.
import type { Finding } from './schemas.js';

/**
 * Quoted spans of at least 20 characters ("…", “…”, '…' as a quotation, `…`).
 *
 * Delimiters are paired strictly in order (each opening mark takes the next closing mark)
 * and the length filter is applied afterwards. Filtering inside the regex would pair the
 * closing backtick of `a` with the opening backtick of `b` and treat the prose between them as
 * a quote. Ambiguous text yields no quote, which keeps the finding (the safe direction).
 */
export function extractQuotes(text: string): string[] {
    const quotes: string[] = [];
    const patterns = [
        /"([^"]*)"/g,
        /“([^”]*)”/g,
        /`([^`]*)`/g,
        // single quotes only when they look like quotation marks, not apostrophes
        /(?:^|[\s:(])'([^']*)'(?=[\s.,;:)]|$)/g,
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            if (match[1]!.length >= 20) quotes.push(match[1]!);
        }
    }
    return quotes;
}

export function normalizeText(text: string): string {
    return text
        .replace(/^\s*\d+\| /gm, '') // line-number prefixes from code excerpts
        .toLowerCase()
        .replace(/[`'"“”‘’*_]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[.\s]+$/, '')
        .trim();
}

/** All string values in a JSON-like value, joined; used to build the grounding corpus. */
export function collectStrings(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(collectStrings).join('\n');
    if (value && typeof value === 'object') return Object.values(value).map(collectStrings).join('\n');
    return '';
}

/**
 * Downgrades reviewer findings whose evidence quotes text that appears nowhere in the corpus
 * (goal, requirements, plan, code context). Findings without quotes are left alone.
 */
export function groundFindings(findings: Finding[], corpus: string): Finding[] {
    const haystack = normalizeText(corpus);
    return findings.map(finding => {
        if (finding.source !== 'reviewer' || finding.severity === 'minor') return finding;
        const quotes = extractQuotes(finding.evidence).map(normalizeText).filter(q => q.length >= 20);
        if (quotes.length === 0 || quotes.some(q => haystack.includes(q))) return finding;
        return {
            ...finding,
            severity: 'minor',
            evidence: `${finding.evidence} [XPlan: the quoted evidence was not found in the requirements, plan, or code context; downgraded from ${finding.severity}]`,
        };
    });
}

function signature(f: Finding): string {
    return `${f.source}|${f.category}|${f.taskId ?? ''}|${normalizeText(f.issue).slice(0, 160)}`;
}

/** True when two rounds report exactly the same (non-empty) set of blocking findings. */
export function sameFindings(previous: Finding[], current: Finding[]): boolean {
    if (previous.length === 0 || previous.length !== current.length) return false;
    const a = previous.map(signature).sort();
    const b = current.map(signature).sort();
    return a.every((s, i) => s === b[i]);
}

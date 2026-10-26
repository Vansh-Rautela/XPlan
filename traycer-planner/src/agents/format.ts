// src/agents/format.ts
// Shared prompt sections. Kept in one place so all stages see context in the same shape.
import type { ToolObservation } from '../llm/toolLoop.js';
import type { ContextPack } from '../repo/retrieval.js';
import type { Finding } from './schemas.js';

export function formatContextPack(pack: ContextPack, observations: ToolObservation[] = []): string {
    const sections: string[] = [];
    for (const file of pack.files) {
        sections.push(`### ${file.path}${file.truncated ? ' (excerpt)' : ''}\nWhy included: ${file.reasons.join('; ')}\n\`\`\`\n${file.excerpt}\n\`\`\``);
    }
    if (pack.omitted.length) {
        // Signature cards: cheap, and they tell the model these files exist and what they define.
        const cards = pack.omitted.slice(0, 20).map(f => `- ${f.path}${f.symbols.length ? ` — defines ${f.symbols.join(', ')}` : ''} (${f.reasons[0] ?? 'ranked'})`);
        sections.push(`### Other relevant files (content not shown; read them with tools if available)\n${cards.join('\n')}`);
    }
    if (pack.withheld.length) {
        sections.push(`Files whose content is withheld: ${pack.withheld.map(w => `${w.path} (${w.reason})`).join(', ')}`);
    }
    const useful = observations.filter(o => o.ok);
    if (useful.length) {
        sections.push('## Additional evidence gathered with tools');
        for (const o of useful) {
            sections.push(`### ${o.tool}(${JSON.stringify(o.args)})\n\`\`\`\n${o.output}\n\`\`\``);
        }
    }
    return sections.join('\n\n');
}

export function formatFindings(findings: Finding[]): string {
    if (findings.length === 0) return '(none)';
    return findings
        .map((f, i) => `${i + 1}. [${f.severity}] [${f.source}] ${f.taskId ? `(${f.taskId}) ` : ''}${f.issue}\n   Evidence: ${f.evidence}\n   Suggested fix: ${f.suggestion}`)
        .join('\n');
}

export const SHARED_RULES = `You are part of XPlan, a read-only code planning tool. Nobody will run your output; a human engineer will read it.
- Do not write implementation code. Short signatures or identifiers are fine.
- Only state facts about the code that are visible in the provided context. Label anything else as an assumption.
- Prefer the smallest change that satisfies the goal and follow the conventions visible in the code.`;

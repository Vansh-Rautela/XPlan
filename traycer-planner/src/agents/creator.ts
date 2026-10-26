// src/agents/creator.ts
// Creator: interprets the goal into explicit requirements and tells retrieval where to look.
// It sees the repository map (paths + manifests) but no file contents, which keeps it cheap.
import { generateStructured } from '../llm/structured.js';
import type { LLMProvider } from '../llm/types.js';
import type { Logger } from '../logger.js';
import { SHARED_RULES } from './format.js';
import { RequirementsSchema, type Requirements } from './schemas.js';

const SYSTEM = `${SHARED_RULES}

You are the CREATOR stage. Turn the user's engineering goal into explicit, testable requirements.
- Requirements must come from the goal. Do not add features the user did not ask for; list optional ideas under outOfScope.
- Use ids R1, R2, … Keep each requirement independently verifiable.
- Put ambiguity in assumptions (what you will assume) and openQuestions (what the user should decide).
- searchTerms: identifiers, domain words, and API names likely to appear in the relevant code (5-15 items).
- candidatePaths: copy paths exactly from the file list; never invent paths. Leave empty if unsure.`;

export interface CreatorInput {
    goal: string;
    repoOverview: string;
    mentionedPaths: string[];
}

export function creatorPrompt(input: CreatorInput): string {
    return [
        `## Goal\n${input.goal}`,
        input.mentionedPaths.length ? `## Files the user referenced\n${input.mentionedPaths.join('\n')}` : '',
        `## Repository map\n${input.repoOverview}`,
    ].filter(Boolean).join('\n\n');
}

export function runCreator(provider: LLMProvider, input: CreatorInput, opts: { temperature?: number; signal?: AbortSignal; logger?: Logger }): Promise<Requirements> {
    return generateStructured(provider, {
        stage: 'Creator',
        system: SYSTEM,
        prompt: creatorPrompt(input),
        schema: RequirementsSchema,
        ...opts,
    });
}

// src/llm/structured.ts
import { z } from 'zod';
import { StructuredOutputError } from '../errors.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { ChatMessage, JsonSchema, LLMProvider } from './types.js';

/** Converts a Zod schema to a JSON Schema subset accepted by Gemini and Ollama. */
export function toModelSchema(schema: z.ZodType): JsonSchema {
    const strip = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(strip);
        if (!node || typeof node !== 'object') return node;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
            if (key === '$schema' || key === 'default') continue;
            if ((key === 'maximum' || key === 'minimum') && Math.abs(Number(value)) >= Number.MAX_SAFE_INTEGER) continue;
            out[key] = strip(value);
        }
        return out;
    };
    return strip(z.toJSONSchema(schema)) as JsonSchema;
}

/** Pulls the JSON object out of a model reply (handles code fences and leading prose). */
export function extractJson(text: string): unknown {
    let candidate = text.trim();
    const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidate = fence[1]!.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start === -1 || end <= start) throw new Error('no JSON object found in response');
        candidate = candidate.slice(start, end + 1);
    }
    return JSON.parse(candidate);
}

export function formatIssues(error: z.ZodError): string[] {
    return error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`);
}

export interface StructuredRequest<T> {
    /** Stage name used in errors and logs (e.g. "Planner"). */
    stage: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    temperature?: number;
    /** Extra attempts in which validation errors are fed back to the model. */
    maxRepairs?: number;
    signal?: AbortSignal;
    logger?: Logger;
}

export async function generateStructured<T>(provider: LLMProvider, request: StructuredRequest<T>): Promise<T> {
    const logger = request.logger ?? silentLogger;
    const jsonSchema = toModelSchema(request.schema);
    const system = `${request.system}\n\nRespond with a single JSON object that conforms to this JSON Schema. No prose, no code fences.\n${JSON.stringify(jsonSchema)}`;
    const messages: ChatMessage[] = [{ role: 'user', content: request.prompt }];
    const maxRepairs = request.maxRepairs ?? 1;
    let issues: string[] = [];

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
        const response = await provider.chat({ system, messages, jsonSchema, temperature: request.temperature, signal: request.signal });
        let parsed: unknown;
        try {
            parsed = extractJson(response.text);
        } catch (error) {
            const truncated = response.finishReason === 'length' ? ' (the response was cut off at the output token limit)' : '';
            issues = [`invalid JSON: ${error instanceof Error ? error.message : String(error)}${truncated}`];
        }
        if (parsed !== undefined) {
            const result = request.schema.safeParse(parsed);
            if (result.success) return result.data;
            issues = formatIssues(result.error);
        }
        if (attempt < maxRepairs) {
            logger.warn(`${request.stage}: output failed validation (${issues.length} issue(s)); asking the model to repair it`);
            logger.debug(issues.slice(0, 10).join('\n'));
            messages.push(
                { role: 'assistant', content: response.text, raw: response.raw },
                {
                    role: 'user',
                    content: `Your previous response was not valid:\n- ${issues.slice(0, 15).join('\n- ')}\n\nReturn the complete corrected JSON object only.`,
                },
            );
        }
    }
    throw new StructuredOutputError(request.stage, issues);
}

// src/llm/toolLoop.ts
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { RepoToolset } from '../repo/tools.js';
import type { ChatMessage, LLMProvider } from './types.js';

export interface ToolObservation {
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    output: string;
    path?: string;
}

export interface ToolLoopResult {
    observations: ToolObservation[];
    /** Final text from the model, if it stopped calling tools within the step limit. */
    summary: string;
    steps: number;
}

export interface ToolLoopOptions {
    system: string;
    prompt: string;
    toolset: RepoToolset;
    /** Maximum number of model turns that may call tools. */
    maxSteps: number;
    /** Maximum total characters of tool output to keep. */
    maxChars: number;
    maxCallsPerStep?: number;
    temperature?: number;
    signal?: AbortSignal;
    logger?: Logger;
}

/** Bounded tool-calling loop. Only the read-only repository tools are exposed. */
export async function runToolLoop(provider: LLMProvider, options: ToolLoopOptions): Promise<ToolLoopResult> {
    const logger = options.logger ?? silentLogger;
    const maxCalls = options.maxCallsPerStep ?? 4;
    const messages: ChatMessage[] = [{ role: 'user', content: options.prompt }];
    const observations: ToolObservation[] = [];
    const seen = new Set<string>();
    let usedChars = 0;

    for (let step = 1; step <= options.maxSteps; step++) {
        const response = await provider.chat({
            system: options.system,
            messages,
            tools: options.toolset.specs,
            temperature: options.temperature,
            signal: options.signal,
        });
        if (response.toolCalls.length === 0) {
            return { observations, summary: response.text.trim(), steps: step };
        }

        // Every call gets a response (providers require it); calls beyond the limit are skipped.
        messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls, raw: response.raw });
        for (const [i, call] of response.toolCalls.entries()) {
            const key = `${call.name}:${JSON.stringify(call.args)}`;
            let output: string;
            if (i >= maxCalls) {
                output = `Skipped: at most ${maxCalls} tool calls per turn.`;
            } else if (seen.has(key)) {
                output = 'Already called with the same arguments; see the earlier result.';
            } else if (usedChars >= options.maxChars) {
                output = 'Exploration budget exhausted. Stop calling tools and summarise your findings.';
            } else {
                seen.add(key);
                const result = options.toolset.execute(call.name, call.args);
                output = result.output.slice(0, Math.max(0, options.maxChars - usedChars));
                usedChars += output.length;
                observations.push({ tool: call.name, args: call.args, ok: result.ok, output, path: result.path });
                logger.debug(`  tool ${call.name}(${JSON.stringify(call.args)}) → ${result.ok ? 'ok' : 'refused'}, ${output.length} chars`);
            }
            messages.push({ role: 'tool', name: call.name, content: output });
        }
    }
    return { observations, summary: '', steps: options.maxSteps };
}

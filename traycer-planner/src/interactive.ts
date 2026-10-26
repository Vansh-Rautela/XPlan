// src/interactive.ts
// Prompt loop: goal → plan → refine with feedback / save / new goal.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import { reportError, type CliIO, type ParsedArgs } from './cli.js';
import { describeDataFlow, type Config } from './config.js';
import { ExitCode, errorMessage } from './errors.js';
import { createProvider } from './llm/index.js';
import type { Logger } from './logger.js';
import { refinePlan, runPipeline, type PlanningResult, type PlanningSession } from './pipeline.js';
import { renderHandoff, renderJson, renderMarkdown, renderSummary } from './plan/render.js';

export async function runInteractive(config: Config, args: ParsedArgs, io: CliIO, logger: Logger): Promise<number> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // readline intercepts Ctrl+C: cancel the running request, or exit when idle.
    let running: AbortController | undefined;
    rl.on('SIGINT', () => {
        if (running) running.abort();
        else rl.close();
    });
    const withAbort = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        running = new AbortController();
        try {
            return await fn(running.signal);
        } finally {
            running = undefined;
        }
    };
    const provider = (io.providerFactory ?? ((c, l) => createProvider(c, l)))(config, logger);
    const repo = path.resolve(io.cwd, args.values.repo ?? '.');

    io.stdout(chalk.cyan(`\nXPlan — interactive planning for ${repo}\n`));
    io.stdout(chalk.gray(describeDataFlow(config, provider.remote) + '\n'));
    io.stdout(chalk.gray('Describe a goal (mention files with @path). Empty line or "quit" to exit.\n'));

    let session: PlanningSession | undefined;
    let result: PlanningResult | undefined;
    try {
        for (;;) {
            if (!result) {
                const goal = (await rl.question(chalk.blue('\nGoal> '))).trim();
                if (!goal || goal === 'quit' || goal === 'exit') break;
                try {
                    ({ result, session } = await withAbort(signal => runPipeline(provider, {
                        repo, goal,
                        maxFiles: config.maxFiles, maxContextChars: config.maxContextChars,
                        maxRevisions: config.maxRevisions, exploreSteps: config.exploreSteps,
                        review: config.review, temperature: config.temperature,
                        index: { ignore: args.values.ignore }, signal, logger,
                    })));
                } catch (error) {
                    reportError(error, io, !!args.values.verbose);
                    continue;
                }
                io.stdout('\n' + renderMarkdown(result));
                io.stderr(renderSummary(result));
            }

            const choice = (await rl.question(chalk.blue('\n[r]efine with feedback · [s]ave · [n]ew goal · [q]uit > '))).trim().toLowerCase();
            if (choice === 'q' || choice === 'quit') break;
            if (choice === 'n') {
                result = undefined;
                session = undefined;
            } else if (choice === 'r' && session) {
                const feedback = (await rl.question(chalk.blue('Feedback> '))).trim();
                if (!feedback) continue;
                try {
                    result = await withAbort(signal => {
                        session!.options.signal = signal;
                        return refinePlan(session!, feedback);
                    });
                    io.stdout('\n' + renderMarkdown(result));
                    io.stderr(renderSummary(result));
                } catch (error) {
                    reportError(error, io, !!args.values.verbose);
                }
            } else if (choice === 's' && result) {
                const file = (await rl.question(chalk.blue('File (.md, .json, or .handoff.md)> '))).trim();
                if (!file) continue;
                const target = path.resolve(io.cwd, file);
                try {
                    const text = file.endsWith('.json') ? renderJson(result) : file.endsWith('.handoff.md') ? renderHandoff(result) : renderMarkdown(result);
                    await fs.writeFile(target, text, 'utf8');
                    io.stdout(chalk.green(`Saved ${target}\n`));
                } catch (error) {
                    io.stderr(chalk.red(`Could not save: ${errorMessage(error)}`));
                }
            }
        }
    } catch (error) {
        // rl.question rejects once the interface is closed (Ctrl+C / Ctrl+D while idle).
        if (!(error instanceof Error && (error.name === 'AbortError' || /closed/i.test(error.message)))) throw error;
    } finally {
        rl.close();
    }
    return ExitCode.Ok;
}

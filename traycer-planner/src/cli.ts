// src/cli.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { describeDataFlow, parseIntOption, resolveConfig, type Config, type ConfigFlags } from './config.js';
import { ExitCode, ProviderError, UsageError, XPlanError, errorMessage } from './errors.js';
import { createProvider } from './llm/index.js';
import type { LLMProvider } from './llm/types.js';
import { createLogger, type Logger } from './logger.js';
import { renderHandoff, renderJson, renderMarkdown, renderSummary } from './plan/render.js';
import { prepareContext, runPipeline } from './pipeline.js';

export const VERSION = '2.0.0';

export const HELP = `XPlan — plan code changes before you make them.

Usage:
  xplan plan <goal...> [options]      Run Creator → Planner → Reviewer and print a validated plan
  xplan context <goal...> [options]   Show which files would be sent to the model, and why (no LLM call)
  xplan doctor [options]              Check configuration and provider connectivity; list models
  xplan interactive [options]         Plan, refine with feedback, and save, in a prompt loop
  xplan                               Same as "interactive" when run in a terminal

Goal input:
  <goal...>                 The engineering goal. Use "-" to read it from stdin.
  --goal-file <file>        Read the goal from a file.
  Mention files with @path (e.g. "@src/server.ts") to force them into the context.

Options:
  -r, --repo <dir>          Repository to plan for (default: current directory). Never modified.
  -p, --provider <name>     gemini | ollama (default: gemini if GEMINI_API_KEY is set, else ollama)
  -m, --model <name>        Model name (default: GEMINI_MODEL / OLLAMA_MODEL or the provider default)
  -f, --format <fmt>        markdown | json | handoff (default: markdown, or json when --output ends in .json)
                            handoff = step-by-step brief to paste into a coding agent
  -o, --output <file>       Write the plan to a file instead of stdout
      --max-revisions <n>   Review/revise rounds after the first review (0-5, default 2)
      --no-review           Skip the Reviewer (automated validation still runs)
      --explore-steps <n>   Tool-calling steps the model may use to read more code (0 disables)
      --max-files <n>       Files to include in the model context
      --max-context-chars <n>  Character budget for code context
      --max-index-files <n> Stop indexing after this many files (default 5000)
      --ignore <glob>       Extra ignore pattern (gitignore syntax); repeatable
      --temperature <t>     Sampling temperature 0-2 (default 0.2)
      --seed <n>            Sampling seed for more reproducible runs (where supported)
      --timeout <sec>       Per-request timeout (default 120 for gemini, 600 for ollama)
      --retries <n>         Retries for rate limits / server errors (default 2)
      --num-ctx <n>         Ollama context window in tokens (default 16384, env OLLAMA_NUM_CTX)
      --show-content        (context) also print the excerpts that would be sent
  -q, --quiet               Only print warnings and errors to stderr
  -v, --verbose             Print ranking details and debug information to stderr
  -h, --help                Show this help
      --version             Show the version

Environment:
  GEMINI_API_KEY (or GOOGLE_API_KEY), GEMINI_MODEL, GEMINI_BASE_URL
  OLLAMA_HOST (default 127.0.0.1:11434), OLLAMA_MODEL, OLLAMA_NUM_CTX, OLLAMA_KEEP_ALIVE
  XPLAN_PROVIDER, XPLAN_MODEL
  A .env file in the current directory is loaded if present.

Exit codes:
  0 success · 1 internal error · 2 usage/configuration error · 3 provider/model error
  4 plan produced but blocking findings remain (status "unresolved") · 130 interrupted
`;

const OPTIONS = {
    repo: { type: 'string', short: 'r' },
    provider: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    format: { type: 'string', short: 'f' },
    output: { type: 'string', short: 'o' },
    'goal-file': { type: 'string' },
    'max-revisions': { type: 'string' },
    'no-review': { type: 'boolean' },
    'explore-steps': { type: 'string' },
    'max-files': { type: 'string' },
    'max-context-chars': { type: 'string' },
    'max-index-files': { type: 'string' },
    ignore: { type: 'string', multiple: true },
    temperature: { type: 'string' },
    seed: { type: 'string' },
    timeout: { type: 'string' },
    retries: { type: 'string' },
    'num-ctx': { type: 'string' },
    'show-content': { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' },
} as const;

const OUTPUT_FORMATS = ['markdown', 'json', 'handoff'] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type Command = 'plan' | 'context' | 'doctor' | 'interactive' | 'help' | 'version';
const COMMANDS = new Set<Command>(['plan', 'context', 'doctor', 'interactive', 'help', 'version']);

export interface ParsedArgs {
    command: Command;
    goalParts: string[];
    values: {
        repo?: string; provider?: string; model?: string; format?: string; output?: string; 'goal-file'?: string;
        'max-revisions'?: string; 'no-review'?: boolean; 'explore-steps'?: string; 'max-files'?: string;
        'max-context-chars'?: string; 'max-index-files'?: string; ignore?: string[]; temperature?: string; seed?: string;
        timeout?: string; retries?: string; 'num-ctx'?: string; 'show-content'?: boolean; quiet?: boolean; verbose?: boolean;
        help?: boolean; version?: boolean;
    };
}

export function parseCliArgs(argv: string[], isTTY: boolean): ParsedArgs {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
        throw new UsageError(errorMessage(error), 'Run `xplan --help` for usage.');
    }
    const { values, positionals } = parsed;
    let command: Command;
    let goalParts = positionals;
    if (values.help) command = 'help';
    else if (values.version) command = 'version';
    else if (positionals.length === 0) command = isTTY ? 'interactive' : 'help';
    else if (COMMANDS.has(positionals[0] as Command)) {
        command = positionals[0] as Command;
        goalParts = positionals.slice(1);
    } else {
        throw new UsageError(`Unknown command "${positionals[0]}".`, 'Did you mean `xplan plan "<goal>"`? Run `xplan --help` for usage.');
    }
    if (values.format && !OUTPUT_FORMATS.includes(values.format as OutputFormat)) {
        throw new UsageError(`Invalid --format "${values.format}" (expected ${OUTPUT_FORMATS.join(', ')}).`);
    }
    if (values.quiet && values.verbose) throw new UsageError('--quiet and --verbose cannot be combined.');
    return { command, goalParts, values };
}

export function toConfigFlags(values: ParsedArgs['values']): ConfigFlags {
    return {
        provider: values.provider,
        model: values.model,
        timeout: values.timeout,
        retries: values.retries,
        seed: values.seed,
        temperature: values.temperature,
        maxFiles: values['max-files'],
        maxContextChars: values['max-context-chars'],
        maxRevisions: values['max-revisions'],
        exploreSteps: values['explore-steps'],
        numCtx: values['num-ctx'],
        maxIndexFiles: values['max-index-files'],
        review: values['no-review'] ? false : undefined,
    };
}

export interface CliIO {
    stdout: (text: string) => void;
    stderr: (line: string) => void;
    readStdin: () => Promise<string>;
    env: Record<string, string | undefined>;
    isTTY: boolean;
    cwd: string;
    /** Test seam: build the provider from config. */
    providerFactory?: (config: Config, logger: Logger) => LLMProvider;
    signal?: AbortSignal;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

export function defaultIO(signal?: AbortSignal): CliIO {
    return {
        stdout: text => process.stdout.write(text),
        stderr: line => process.stderr.write(line + '\n'),
        readStdin,
        env: process.env,
        isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
        cwd: process.cwd(),
        signal,
    };
}

async function resolveGoal(args: ParsedArgs, io: CliIO): Promise<string> {
    let goal: string;
    if (args.values['goal-file']) {
        try {
            goal = await fs.readFile(path.resolve(io.cwd, args.values['goal-file']), 'utf8');
        } catch {
            throw new UsageError(`Cannot read goal file: ${args.values['goal-file']}`);
        }
    } else if (args.goalParts.length === 1 && args.goalParts[0] === '-') {
        goal = await io.readStdin();
    } else {
        goal = args.goalParts.join(' ');
    }
    goal = goal.trim();
    if (!goal) throw new UsageError('No goal given.', 'Example: xplan plan "Add rate limiting to the public API" --repo ./my-app');
    if (goal.length > 20_000) throw new UsageError('Goal is too long (max 20,000 characters). Put background in the repository docs and mention them with @path.');
    return goal;
}

function outputFormat(args: ParsedArgs): OutputFormat {
    if (args.values.format) return args.values.format as OutputFormat;
    return args.values.output?.toLowerCase().endsWith('.json') ? 'json' : 'markdown';
}

async function writeOutput(text: string, args: ParsedArgs, io: CliIO, logger: Logger): Promise<void> {
    const out = args.values.output;
    if (!out) {
        io.stdout(text);
        return;
    }
    const target = path.resolve(io.cwd, out);
    try {
        await fs.writeFile(target, text, 'utf8');
    } catch (error) {
        throw new UsageError(`Cannot write output file ${out}: ${errorMessage(error)}`);
    }
    logger.info(`Wrote ${target}`);
}

export async function runCli(argv: string[], io: CliIO = defaultIO()): Promise<number> {
    let verbose = false;
    try {
        const args = parseCliArgs(argv, io.isTTY);
        verbose = !!args.values.verbose;
        const logger = createLogger(args.values.quiet ? 'silent' : verbose ? 'debug' : 'info', io.stderr);

        switch (args.command) {
            case 'help':
                io.stdout(HELP);
                return ExitCode.Ok;
            case 'version':
                io.stdout(`xplan ${VERSION}\n`);
                return ExitCode.Ok;
            case 'context':
                return await contextCommand(args, io, logger);
            case 'doctor':
                return await doctorCommand(args, io, logger);
            case 'plan':
                return await planCommand(args, io, logger);
            case 'interactive': {
                const { runInteractive } = await import('./interactive.js');
                const config = resolveConfig(toConfigFlags(args.values), io.env);
                return await runInteractive(config, args, io, logger);
            }
        }
    } catch (error) {
        return reportError(error, io, verbose);
    }
}

export function reportError(error: unknown, io: Pick<CliIO, 'stderr'>, verbose: boolean): number {
    if (error instanceof ProviderError && error.kind === 'aborted') {
        io.stderr(chalk.yellow('Interrupted.'));
        return 130;
    }
    if (error instanceof XPlanError) {
        io.stderr(chalk.red('error: ') + error.message);
        if (error.hint) io.stderr(chalk.gray('hint: ') + error.hint);
        if (verbose && error.cause) io.stderr(chalk.gray(`cause: ${errorMessage(error.cause)}`));
        return error.exitCode;
    }
    io.stderr(chalk.red('unexpected error: ') + errorMessage(error));
    if (verbose && error instanceof Error && error.stack) io.stderr(chalk.gray(error.stack));
    return ExitCode.Internal;
}

function repoOf(args: ParsedArgs, io: CliIO): string {
    return path.resolve(io.cwd, args.values.repo ?? '.');
}

function indexOptions(args: ParsedArgs) {
    return {
        maxFiles: parseIntOption('--max-index-files', args.values['max-index-files'], { min: 1, max: 200_000 }),
        ignore: args.values.ignore,
    };
}

async function planCommand(args: ParsedArgs, io: CliIO, logger: Logger): Promise<number> {
    const goal = await resolveGoal(args, io);
    const config = resolveConfig(toConfigFlags(args.values), io.env);
    const provider = (io.providerFactory ?? ((c, l) => createProvider(c, l)))(config, logger);
    logger.info(describeDataFlow(config, provider.remote));

    const { result } = await runPipeline(provider, {
        repo: repoOf(args, io),
        goal,
        maxFiles: config.maxFiles,
        maxContextChars: config.maxContextChars,
        maxRevisions: config.maxRevisions,
        exploreSteps: config.exploreSteps,
        review: config.review,
        temperature: config.temperature,
        index: indexOptions(args),
        signal: io.signal,
        logger,
    });

    const format = outputFormat(args);
    const text = format === 'json' ? renderJson(result) : format === 'handoff' ? renderHandoff(result) : renderMarkdown(result);
    await writeOutput(text, args, io, logger);
    logger.info('');
    logger.info(renderSummary(result));
    return result.status === 'unresolved' ? ExitCode.PlanUnresolved : ExitCode.Ok;
}

async function contextCommand(args: ParsedArgs, io: CliIO, logger: Logger): Promise<number> {
    const goal = await resolveGoal(args, io);
    // No provider is needed, but the provider choice decides the default budget.
    let budget: { maxFiles: number; maxContextChars: number };
    try {
        const c = resolveConfig(toConfigFlags(args.values), io.env);
        budget = { maxFiles: c.maxFiles, maxContextChars: c.maxContextChars };
    } catch (error) {
        if (!(error instanceof UsageError) || args.values.provider) throw error;
        const c = resolveConfig({ ...toConfigFlags(args.values), provider: 'ollama' }, io.env);
        budget = { maxFiles: c.maxFiles, maxContextChars: c.maxContextChars };
    }
    const { pack, index } = await prepareContext({ repo: repoOf(args, io), goal, ...budget, index: indexOptions(args), logger });

    if (outputFormat(args) === 'json') {
        await writeOutput(JSON.stringify({
            repo: index.root,
            terms: pack.terms,
            files: pack.files.map(f => ({ path: f.path, score: f.score, reasons: f.reasons, truncated: f.truncated, ...(args.values['show-content'] ? { excerpt: f.excerpt } : {}) })),
            omitted: pack.omitted.map(f => ({ path: f.path, score: f.score, reasons: f.reasons })),
            withheld: pack.withheld,
            totalChars: pack.totalChars,
            index: index.stats,
        }, null, 2) + '\n', args, io, logger);
        return ExitCode.Ok;
    }

    const lines = [`# Context for: ${goal}`, '', `Search terms: ${pack.terms.join(', ') || '(none)'}`, `Budget: ${budget.maxFiles} files / ${budget.maxContextChars.toLocaleString()} chars — using ${pack.totalChars.toLocaleString()} chars`, ''];
    if (pack.files.length === 0) lines.push('No files matched the goal. Try naming modules or mentioning files with @path.');
    pack.files.forEach((f, i) => {
        lines.push(`${i + 1}. ${f.path}  (score ${f.score}${f.truncated ? ', excerpt' : ''})`, `   ${f.reasons.join('; ')}`);
        if (args.values['show-content']) lines.push('```', f.excerpt, '```');
    });
    if (pack.omitted.length) lines.push('', `Ranked but over budget: ${pack.omitted.slice(0, 15).map(f => f.path).join(', ')}${pack.omitted.length > 15 ? ', …' : ''}`);
    if (pack.withheld.length) lines.push('', `Withheld: ${pack.withheld.map(w => `${w.path} (${w.reason})`).join(', ')}`);
    await writeOutput(lines.join('\n') + '\n', args, io, logger);
    return ExitCode.Ok;
}

async function doctorCommand(args: ParsedArgs, io: CliIO, logger: Logger): Promise<number> {
    const ok = (m: string) => io.stdout(`${chalk.green('✓')} ${m}\n`);
    const bad = (m: string) => io.stdout(`${chalk.red('✗')} ${m}\n`);
    const info = (m: string) => io.stdout(`  ${m}\n`);

    const major = Number(process.versions.node.split('.')[0]);
    (major >= 22 ? ok : bad)(`Node.js ${process.versions.node} (requires >= 22)`);

    const config = resolveConfig(toConfigFlags(args.values), io.env);
    ok(`Provider: ${config.provider} (${config.providerSource === 'auto' ? 'auto-selected' : `from ${config.providerSource}`}), model: ${config.model}`);
    if (config.provider === 'gemini') info(`API key: set · endpoint: ${config.gemini.baseUrl}`);
    else info(`Host: ${config.ollama.host} · num_ctx: ${config.ollama.numCtx}`);
    info(`Budget: ${config.maxFiles} files / ${config.maxContextChars.toLocaleString()} chars · revisions: ${config.maxRevisions} · explore steps: ${config.exploreSteps} · timeout: ${config.timeoutMs / 1000}s`);

    const provider = (io.providerFactory ?? ((c, l) => createProvider(c, l)))({ ...config, retries: 0, timeoutMs: Math.min(config.timeoutMs, 15_000) }, logger);
    let models: string[];
    try {
        models = await provider.listModels(io.signal);
    } catch (error) {
        bad(`Cannot reach ${config.provider}: ${errorMessage(error)}`);
        if (error instanceof XPlanError && error.hint) info(`hint: ${error.hint}`);
        return ExitCode.Provider;
    }
    ok(`Connected to ${config.provider}; ${models.length} model(s) available`);
    const available = models.some(m => m === config.model || m === `${config.model}:latest` || m.replace(/:latest$/, '') === config.model);
    if (available) {
        ok(`Model "${config.model}" is available`);
    } else {
        bad(`Model "${config.model}" not found`);
        if (config.provider === 'ollama') info(`Run \`ollama pull ${config.model}\` or set OLLAMA_MODEL to one of the models below.`);
        else info('Set GEMINI_MODEL or pass --model with one of the models below.');
    }
    if (models.length) info(`Models: ${models.slice(0, 40).join(', ')}${models.length > 40 ? ', …' : ''}`);
    return available ? ExitCode.Ok : ExitCode.Provider;
}

// src/logger.ts
// Progress goes to stderr so stdout stays clean for the plan (Markdown or JSON).
// Never log prompts, file contents, or credentials here.
import chalk from 'chalk';
import { redactSecrets } from './redact.js';

export type LogLevel = 'silent' | 'info' | 'debug';

export interface Logger {
    info(message: string): void;
    step(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
}

export function createLogger(level: LogLevel, write: (line: string) => void = line => process.stderr.write(line + '\n')): Logger {
    const emit = (line: string) => write(redactSecrets(line));
    return {
        info: message => { if (level !== 'silent') emit(message); },
        step: message => { if (level !== 'silent') emit(chalk.cyan('› ') + message); },
        // Warnings are shown even in quiet mode: they describe degraded results.
        warn: message => emit(chalk.yellow('⚠ ') + message),
        debug: message => { if (level === 'debug') emit(chalk.gray(message)); },
    };
}

export const silentLogger: Logger = { info() {}, step() {}, warn() {}, debug() {} };

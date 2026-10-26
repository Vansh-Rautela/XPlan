// src/errors.ts
import { redactSecrets } from './redact.js';

/** Process exit codes. Documented in README ("Exit codes"). */
export const ExitCode = {
    Ok: 0,
    Internal: 1,
    Usage: 2,
    Provider: 3,
    PlanUnresolved: 4,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class XPlanError extends Error {
    readonly exitCode: ExitCode;
    readonly hint?: string;

    constructor(message: string, options: { exitCode: ExitCode; hint?: string; cause?: unknown }) {
        super(redactSecrets(message), { cause: options.cause });
        this.name = new.target.name;
        this.exitCode = options.exitCode;
        this.hint = options.hint;
    }
}

/** Invalid CLI arguments or configuration. */
export class UsageError extends XPlanError {
    constructor(message: string, hint?: string) {
        super(message, { exitCode: ExitCode.Usage, hint });
    }
}

export type ProviderErrorKind =
    | 'auth'
    | 'rate_limit'
    | 'timeout'
    | 'unavailable'
    | 'model_not_found'
    | 'tools_unsupported'
    | 'bad_request'
    | 'blocked'
    | 'invalid_response'
    | 'aborted';

/** Failure talking to an LLM provider. Messages are redacted; request bodies are never included. */
export class ProviderError extends XPlanError {
    readonly kind: ProviderErrorKind;
    readonly status?: number;

    constructor(kind: ProviderErrorKind, message: string, options: { status?: number; hint?: string; cause?: unknown } = {}) {
        super(message, { exitCode: ExitCode.Provider, hint: options.hint, cause: options.cause });
        this.kind = kind;
        this.status = options.status;
    }
}

/** The model returned output that could not be parsed/validated even after repair attempts. */
export class StructuredOutputError extends XPlanError {
    readonly issues: string[];

    constructor(stage: string, issues: string[]) {
        super(`${stage}: model output did not match the expected schema (${issues.length} issue(s)): ${issues.slice(0, 5).join('; ')}`, {
            exitCode: ExitCode.Provider,
            hint: 'Try a larger/more capable model, lower --temperature, or rerun. Small local models often struggle with long JSON.',
        });
        this.issues = issues;
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return redactSecrets(error.message);
    return redactSecrets(String(error));
}

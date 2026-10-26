// src/redact.ts
// Best-effort secret redaction for anything that leaves the process (prompts, logs, reports).
// This is a safety net, not a guarantee: sensitive files are excluded from the index entirely.

const SECRET_PATTERNS: Array<[RegExp, string]> = [
    // PEM private keys (multi-line)
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
    // Google API keys
    [/AIza[0-9A-Za-z_\-]{35}/g, '[REDACTED]'],
    // OpenAI / Anthropic style keys
    [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}/g, '[REDACTED]'],
    // GitHub tokens
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, '[REDACTED]'],
    // Slack tokens
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
    // AWS access key ids
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
    // Bearer tokens
    [/\b(Bearer\s+)[A-Za-z0-9._~+/\-]{16,}=*/gi, '$1[REDACTED]'],
    // key=... in URLs / query strings
    [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]'],
    // Assignments like API_KEY = "...", "password": "..."
    [
        /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passwd|password|token|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi,
        '$1[REDACTED]$3',
    ],
];

export function redactSecrets(text: string): string {
    let out = text;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

/** Returns true when the text contains something that looks like a credential. */
export function containsSecret(text: string): boolean {
    return redactSecrets(text) !== text;
}

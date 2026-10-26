// src/repo/safety.ts
import * as path from 'node:path';

/**
 * Files whose *content* must never be read or sent to a model. They are still listed in the
 * index (flagged as sensitive) so plans can be validated against them.
 */
const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
    /^\.env(\..+)?$/i,
    /^\.envrc$/i,
    /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx|ovpn|gpg|asc)$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /^\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/i,
    /^credentials(\..+)?$/i,
    /^secrets?(\..+)?$/i,
    /^service[-_]?account.*\.json$/i,
    /\.tfstate(\.backup)?$/i,
    /\.tfvars$/i,
];

/** Template env files are documentation, not secrets. */
const SAFE_ENV_TEMPLATES = /^\.env\.(example|sample|template|dist|defaults)$/i;

const SENSITIVE_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.docker', '.kube', 'secrets']);

export function isSensitivePath(relPath: string): boolean {
    const posix = toPosix(relPath);
    const segments = posix.split('/');
    const base = segments[segments.length - 1] ?? '';
    if (SAFE_ENV_TEMPLATES.test(base)) return false;
    if (segments.slice(0, -1).some(seg => SENSITIVE_DIR_SEGMENTS.has(seg.toLowerCase()))) return true;
    return SENSITIVE_BASENAME_PATTERNS.some(re => re.test(base));
}

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'psd',
    'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war',
    'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'wasm', 'node',
    'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'sqlite', 'db', 'parquet', 'pkl', 'npy', 'onnx', 'pt', 'safetensors', 'gguf',
]);

export function hasBinaryExtension(relPath: string): boolean {
    const ext = path.extname(relPath).slice(1).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/** Heuristic used by git: a NUL byte in the first 8 KB means binary. */
export function looksBinary(buffer: Uint8Array): boolean {
    const n = Math.min(buffer.length, 8192);
    for (let i = 0; i < n; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

export function toPosix(p: string): string {
    return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Normalises a path supplied by a user or a model into a repository-relative POSIX path.
 * Returns `null` for anything that would escape the repository (absolute paths outside the
 * root, `..` traversal, NUL bytes, empty strings).
 */
export function toRepoRelative(root: string, candidate: string): string | null {
    if (typeof candidate !== 'string') return null;
    let input = candidate.trim().replace(/^@/, '');
    if (input === '' || input.includes('\0')) return null;
    input = input.replace(/\\/g, '/');

    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    const rel = path.relative(root, absolute);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return toPosix(rel);
}

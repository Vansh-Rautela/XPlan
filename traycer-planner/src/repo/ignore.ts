// src/repo/ignore.ts
import { minimatch } from 'minimatch';

/** Directories that are never useful planning context. */
export const DEFAULT_IGNORED_DIRS = [
    '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages',
    'dist', 'build', 'out', 'coverage', '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.turbo',
    '.cache', '.parcel-cache', '.vercel', '.output', '.angular',
    '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.eggs',
    'target', '.gradle', '.terraform', 'Pods', '.idea', '.vscode', '.DS_Store',
];

/** Files that are listed but whose content is low-value (generated or minified). */
const GENERATED_FILE_PATTERNS: RegExp[] = [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|uv\.lock)$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /\.snap$/,
    /\.d\.ts\.map$/,
];

export function isGeneratedFile(relPath: string): boolean {
    return GENERATED_FILE_PATTERNS.some(re => re.test(relPath));
}

interface Rule {
    pattern: string;
    dirOnly: boolean;
}

export interface IgnoreMatcher {
    isIgnored(relPath: string, isDir: boolean): boolean;
    /** Negated (`!pattern`) rules are not supported and are reported here. */
    readonly unsupportedRules: string[];
}

/**
 * Minimal `.gitignore` support: comments, blank lines, anchored (`/x`, `a/b`) and unanchored (`x`)
 * patterns, directory-only patterns (`x/`), and globs. Negation is not supported.
 */
export function createIgnoreMatcher(gitignoreText: string, extraPatterns: string[] = []): IgnoreMatcher {
    const rules: Rule[] = [];
    const unsupportedRules: string[] = [];
    const lines = [...gitignoreText.split(/\r?\n/), ...extraPatterns];

    for (const raw of lines) {
        let line = raw.replace(/\s+$/, '');
        if (line === '' || line.startsWith('#')) continue;
        if (line.startsWith('!')) {
            unsupportedRules.push(line);
            continue;
        }
        const dirOnly = line.endsWith('/');
        if (dirOnly) line = line.slice(0, -1);
        const anchored = line.startsWith('/') || line.includes('/');
        line = line.replace(/^\//, '');
        if (line === '') continue;
        rules.push({ pattern: anchored ? line : `**/${line}`, dirOnly });
    }

    const defaultDirs = new Set(DEFAULT_IGNORED_DIRS);

    return {
        unsupportedRules,
        isIgnored(relPath: string, isDir: boolean): boolean {
            const segments = relPath.split('/');
            const base = segments[segments.length - 1] ?? '';
            if (isDir && defaultDirs.has(base)) return true;
            if (!isDir && base === '.DS_Store') return true;
            return rules.some(rule => (!rule.dirOnly || isDir) && minimatch(relPath, rule.pattern, { dot: true }));
        },
    };
}

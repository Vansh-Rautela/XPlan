// src/repo/symbols.ts
// Lightweight, regex-based symbol and import extraction. It is deliberately approximate:
// it only has to be good enough to rank files and to give the model a map of the code.
import * as path from 'node:path';

const LANGUAGE_BY_EXT: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    vue: 'vue', svelte: 'svelte',
    md: 'markdown', mdx: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    sql: 'sql', sh: 'shell', bash: 'shell', html: 'html', css: 'css', scss: 'css',
};

export function detectLanguage(relPath: string): string | null {
    const base = path.posix.basename(relPath);
    if (base === 'Dockerfile') return 'docker';
    if (base === 'Makefile') return 'make';
    return LANGUAGE_BY_EXT[path.posix.extname(relPath).slice(1).toLowerCase()] ?? null;
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
    javascript: [
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
        /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/gm,
        /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
        // class methods: `  async foo(` / `  public bar(` (not control-flow keywords)
        /^\s{2,}(?:(?:public|private|protected|static|async|readonly|override)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/gm,
    ],
    python: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
    go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm],
    rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/gm],
    java: [/\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g, /^\s+(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],\s]+\s+([a-z]\w*)\s*\(/gm],
    ruby: [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm, /^\s*(?:class|module)\s+([A-Z]\w*)/gm],
};
SYMBOL_PATTERNS.typescript = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.vue = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.svelte = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.kotlin = [/\b(?:class|interface|object)\s+([A-Za-z_]\w*)/g, /\bfun\s+([A-Za-z_]\w*)/g];
SYMBOL_PATTERNS.csharp = SYMBOL_PATTERNS.java;

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
    javascript: [
        /\bimport\s+(?:[\w*${}\s,]+\s+from\s+)?["']([^"']+)["']/g,
        /\bexport\s+[\w*${}\s,]+\s+from\s+["']([^"']+)["']/g,
        /\brequire\(\s*["']([^"']+)["']\s*\)/g,
        /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    ],
    python: [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
};
IMPORT_PATTERNS.typescript = IMPORT_PATTERNS.javascript;
IMPORT_PATTERNS.vue = IMPORT_PATTERNS.javascript;
IMPORT_PATTERNS.svelte = IMPORT_PATTERNS.javascript;

const MAX_SYMBOLS = 200;

function collect(content: string, patterns: RegExp[] | undefined, limit: number): string[] {
    if (!patterns) return [];
    const found = new Set<string>();
    for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) {
            if (match[1]) found.add(match[1]);
            if (found.size >= limit) return [...found];
        }
    }
    return [...found];
}

const NOT_SYMBOLS = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'return', 'super', 'this']);

export function extractSymbols(language: string | null, content: string): string[] {
    if (!language) return [];
    return collect(content, SYMBOL_PATTERNS[language], MAX_SYMBOLS).filter(s => !NOT_SYMBOLS.has(s));
}

export function extractImports(language: string | null, content: string): string[] {
    if (!language) return [];
    return collect(content, IMPORT_PATTERNS[language], 500);
}

const JS_RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

/**
 * Resolves an import specifier to an indexed repository file. Only relative JS/TS imports and
 * Python module paths are resolved; package imports return `null`.
 */
export function resolveImport(fromPath: string, specifier: string, language: string | null, exists: (p: string) => boolean): string | null {
    if (language === 'python') {
        return resolvePythonImport(fromPath, specifier, exists);
    }
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
    if (base.startsWith('..')) return null;
    // TypeScript ESM convention: `./x.js` refers to `./x.ts`.
    const stripped = base.replace(/\.(m|c)?jsx?$/, '');
    for (const candidate of [base, stripped]) {
        for (const ext of JS_RESOLVE_EXTS) {
            if (exists(candidate + ext)) return candidate + ext;
        }
        for (const ext of JS_RESOLVE_EXTS.slice(1)) {
            if (exists(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
        }
    }
    return null;
}

function resolvePythonImport(fromPath: string, specifier: string, exists: (p: string) => boolean): string | null {
    let baseDir = '';
    let mod = specifier;
    if (specifier.startsWith('.')) {
        const dots = specifier.match(/^\.+/)![0].length;
        baseDir = path.posix.dirname(fromPath);
        for (let i = 1; i < dots; i++) baseDir = path.posix.dirname(baseDir);
        mod = specifier.slice(dots);
    }
    const rel = mod.split('.').filter(Boolean).join('/');
    const joined = path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, rel));
    for (const candidate of [`${joined}.py`, `${joined}/__init__.py`, `src/${joined}.py`, `src/${joined}/__init__.py`]) {
        if (!candidate.startsWith('..') && exists(candidate)) return candidate;
    }
    return null;
}

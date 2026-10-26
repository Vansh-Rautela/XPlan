// src/repo/retrieval.ts
// Ranks repository files for a goal and packs the best ones into a size-bounded context.
// Scoring is lexical (path, symbols, content with BM25-style saturation) plus an import-graph
// boost; every included file carries human-readable reasons.
import { createHash } from 'node:crypto';
import type { IndexedFile, RepoIndex } from './indexer.js';
import { toRepoRelative } from './safety.js';

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'when', 'then', 'than', 'have', 'has',
    'are', 'was', 'were', 'will', 'would', 'should', 'could', 'can', 'not', 'but', 'all', 'any', 'each', 'every',
    'our', 'your', 'their', 'its', 'there', 'which', 'what', 'where', 'while', 'also', 'only', 'just', 'via',
    'make', 'add', 'adds', 'adding', 'implement', 'implementation', 'support', 'supports', 'feature', 'features',
    'use', 'using', 'new', 'update', 'change', 'changes', 'code', 'file', 'files', 'need', 'needs', 'want',
    'please', 'able', 'existing', 'current', 'currently', 'allow', 'allows', 'ensure', 'some', 'more', 'less',
    'way', 'like', 'get', 'set', 'let', 'into', 'out', 'about', 'after', 'before', 'them', 'they', 'these',
    'those', 'project', 'app', 'application', 'repo', 'repository', 'function', 'functions', 'proper', 'properly',
    // directory names and language keywords that match almost every file
    'src', 'lib', 'pkg', 'internal', 'index', 'main', 'return', 'const', 'var', 'import', 'export', 'default',
    'async', 'await', 'true', 'false', 'null', 'undefined', 'void', 'string', 'number', 'boolean', 'object',
    'class', 'public', 'private', 'static', 'self', 'def', 'func', 'new', 'type', 'interface',
]);
const SHORT_TERMS = new Set(['db', 'ui', 'id', 'io', 'ip', 'ci', 'ux', 'qa', 'os', 'ws']);

const DERIVATIONAL_SUFFIXES = ['ation', 'ition', 'ment', 'ness', 'able', 'ible', 'ator', 'ion', 'ate', 'ize', 'ise', 'er'];

/**
 * Crude stemmer so that `users`/`user`, `limiter`/`limiting`/`limit`, `validate`/`validation`,
 * and `configure`/`configurable` meet. Stems shorter than 4 characters are never produced by
 * suffix stripping.
 */
export function stem(word: string): string {
    let w = word;
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    for (const suffix of DERIVATIONAL_SUFFIXES) {
        if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
            w = w.slice(0, -suffix.length);
            break;
        }
    }
    if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1);
    return w;
}

/** Splits identifiers and prose into lower-case stemmed tokens (camelCase / snake_case aware). */
export function tokenize(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map(stem);
}

export function extractTerms(text: string): string[] {
    const terms = new Set<string>();
    for (const raw of text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)) {
        if (!raw || STOPWORDS.has(raw)) continue;
        if (raw.length < 3 && !SHORT_TERMS.has(raw)) continue;
        if (/^\d+$/.test(raw)) continue;
        terms.add(stem(raw));
    }
    return [...terms];
}

/** Finds `@path` mentions and bare paths in the goal that exist in the index. */
export function extractMentionedPaths(goal: string, index: RepoIndex): string[] {
    const found = new Set<string>();
    for (const match of goal.matchAll(/@?([\w.\-/\\]+\.[A-Za-z0-9]+)/g)) {
        const rel = toRepoRelative(index.root, match[1]!);
        if (rel && index.byPath.has(rel)) found.add(rel);
    }
    return [...found];
}

export function isTestPath(p: string): boolean {
    return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /[._-](test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p);
}

export interface RankedFile {
    path: string;
    score: number;
    reasons: string[];
}

export interface RankOptions {
    goal: string;
    extraTerms?: string[];
    /** Paths to include regardless of score, with the reason (e.g. "mentioned in goal"). */
    pinned?: Map<string, string>;
}

const tokenCache = new WeakMap<IndexedFile, Map<string, number>>();

function contentTokens(file: IndexedFile): Map<string, number> {
    let counts = tokenCache.get(file);
    if (!counts) {
        counts = new Map();
        for (const token of tokenize(file.content ?? '')) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
        }
        tokenCache.set(file, counts);
    }
    return counts;
}

function tokenMatches(token: string, term: string): boolean {
    return token === term || (term.length >= 4 && token.startsWith(term));
}

function termFrequency(counts: Map<string, number>, term: string): number {
    let tf = 0;
    for (const [token, n] of counts) {
        if (tokenMatches(token, term)) tf += n;
    }
    return tf;
}

const CODE_LANGS = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php', 'swift', 'scala', 'c', 'cpp', 'vue', 'svelte']);

export function rankFiles(index: RepoIndex, options: RankOptions): RankedFile[] {
    const terms = [...new Set([...extractTerms(options.goal), ...(options.extraTerms ?? []).flatMap(extractTerms)])];
    const textFiles = index.files.filter(f => f.kind === 'text');
    const scores = new Map<string, { score: number; reasons: string[] }>();

    if (terms.length > 0 && textFiles.length > 0) {
        const tfs = new Map<IndexedFile, number[]>();
        const df = new Array<number>(terms.length).fill(0);
        let totalLines = 0;
        for (const file of textFiles) {
            const counts = contentTokens(file);
            const row = terms.map(t => termFrequency(counts, t));
            row.forEach((tf, i) => { if (tf > 0) df[i]!++; });
            tfs.set(file, row);
            totalLines += file.lineCount;
        }
        const avgLines = totalLines / textFiles.length || 1;
        const n = textFiles.length;

        // Path matches are weighted by how rare the term is among paths, and count more in the
        // basename: "valid" in validation.ts is stronger evidence than "user" in five paths.
        const pathTokenCache = new Map(textFiles.map(f => [f, tokenize(f.path)]));
        const pathDf = terms.map(t => textFiles.filter(f => pathTokenCache.get(f)!.some(tok => tokenMatches(tok, t))).length);

        for (const file of textFiles) {
            let score = 0;
            const reasons: string[] = [];

            const pathTokens = pathTokenCache.get(file)!;
            const baseTokens = tokenize(file.path.split('/').pop() ?? '');
            const pathHits: string[] = [];
            terms.forEach((t, i) => {
                if (!pathTokens.some(tok => tokenMatches(tok, t))) return;
                const idf = Math.log(1 + n / pathDf[i]!);
                score += 2 * idf * (baseTokens.some(tok => tokenMatches(tok, t)) ? 1.5 : 1);
                pathHits.push(t);
            });
            if (pathHits.length) {
                reasons.push(`path matches ${pathHits.map(t => `"${t}"`).join(', ')}`);
            }

            const symbolHits = new Set<string>();
            for (const symbol of file.symbols) {
                const symTokens = tokenize(symbol);
                if (terms.some(t => symTokens.some(tok => tokenMatches(tok, t)))) symbolHits.add(symbol);
            }
            if (symbolHits.size) {
                score += 2 * Math.min(symbolHits.size, 4);
                reasons.push(`defines ${[...symbolHits].slice(0, 3).join(', ')}${symbolHits.size > 3 ? ', …' : ''}`);
            }

            const row = tfs.get(file)!;
            const k1 = 1.2;
            const b = 0.75;
            const contentHits: string[] = [];
            row.forEach((tf, i) => {
                if (tf === 0) return;
                const idf = Math.log(1 + (n - df[i]! + 0.5) / (df[i]! + 0.5));
                score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (file.lineCount / avgLines)));
                contentHits.push(`"${terms[i]}" ×${tf}`);
            });
            if (contentHits.length) reasons.push(`mentions ${contentHits.slice(0, 4).join(', ')}`);

            if (score > 0) {
                if (!CODE_LANGS.has(file.language ?? '')) score *= 0.7;
                scores.set(file.path, { score, reasons });
            }
        }

        // A goal that names a command-line flag (`--max-calls`) usually means touching the files
        // where flags are defined and parsed: argparse `add_argument('--x')`, commander
        // `.option('--x')`, parseArgs option tables, etc. Those files contain many quoted flags.
        if (/(^|\s)--[a-z][\w-]+/.test(options.goal)) {
            for (const file of textFiles) {
                if (!CODE_LANGS.has(file.language ?? '')) continue;
                const flags = new Set((file.content ?? '').match(/['"`]--[a-z][\w-]+['"`]/g) ?? []);
                if (flags.size < 3) continue;
                const entry = scores.get(file.path) ?? { score: 0, reasons: [] };
                entry.score += 6 + Math.min(flags.size, 20) * 0.3;
                entry.reasons.push(`defines command-line options (${flags.size} flags)`);
                scores.set(file.path, entry);
            }
        }

        // Import-graph boost. The two directions mean different things:
        // - a file that IMPORTS several strong matches is a coordinator (factory, router,
        //   registry) — usually where a new variant gets wired in — so its boosts add up;
        // - a file IMPORTED BY strong matches is a dependency (types, logger, utils) — it gets
        //   only its strongest neighbour's boost, so widely used utilities are not promoted.
        const seeds = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5);
        const coordinator = new Map<string, { boost: number; seeds: string[] }>();
        const dependency = new Map<string, { boost: number; seed: string }>();
        for (const [seedPath, seed] of seeds) {
            const seedFile = index.byPath.get(seedPath)!;
            for (const importer of seedFile.importedBy) {
                const entry = coordinator.get(importer) ?? { boost: 0, seeds: [] };
                entry.boost += 0.3 * seed.score;
                entry.seeds.push(seedPath);
                coordinator.set(importer, entry);
            }
            for (const dep of seedFile.imports) {
                const entry = dependency.get(dep);
                if (!entry || entry.boost < 0.3 * seed.score) dependency.set(dep, { boost: 0.3 * seed.score, seed: seedPath });
            }
        }
        const apply = (file: string, boost: number, reason: string) => {
            const entry = scores.get(file) ?? { score: 0, reasons: [] };
            entry.score += boost;
            entry.reasons.push(reason);
            scores.set(file, entry);
        };
        for (const [file, { boost, seeds: imported }] of coordinator) {
            apply(file, boost, imported.length > 1 ? `imports ${imported.length} matching files (${imported.slice(0, 3).join(', ')})` : `imports ${imported[0]}`);
        }
        for (const [file, { boost, seed }] of dependency) {
            if (!coordinator.has(file)) apply(file, boost, `imported by ${seed}`);
        }

        // Tests are useful context but rarely the main target unless the goal is about tests.
        if (!terms.some(t => t === 'test' || t === 'spec')) {
            for (const [file, entry] of scores) {
                if (isTestPath(file)) entry.score *= 0.7;
            }
        }
    }

    for (const [pinnedPath, reason] of options.pinned ?? []) {
        if (!index.byPath.has(pinnedPath)) continue;
        const entry = scores.get(pinnedPath) ?? { score: 0, reasons: [] };
        entry.score += 1000;
        entry.reasons.unshift(reason);
        scores.set(pinnedPath, entry);
    }

    return [...scores.entries()]
        .map(([p, { score, reasons }]) => ({ path: p, score: Math.round(score * 100) / 100, reasons }))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export interface ContextFile {
    path: string;
    score: number;
    reasons: string[];
    /** Line-numbered excerpt or full content. */
    excerpt: string;
    truncated: boolean;
}

export interface ContextPack {
    terms: string[];
    files: ContextFile[];
    /** Ranked files left out because of the file or character budget, with their symbols. */
    omitted: Array<RankedFile & { symbols: string[] }>;
    /** Files that could not be included (e.g. sensitive) although they were requested. */
    withheld: Array<{ path: string; reason: string }>;
    totalChars: number;
}

export interface PackOptions {
    maxFiles: number;
    maxChars: number;
    terms: string[];
}

function numbered(lines: string[], start: number, end: number): string {
    const width = String(end).length;
    const out: string[] = [];
    for (let i = start; i <= end; i++) out.push(`${String(i).padStart(width)}| ${lines[i - 1] ?? ''}`);
    return out.join('\n');
}

/** Returns a line-numbered excerpt: the file header plus windows around lines that mention terms. */
export function excerptFile(content: string, terms: string[], maxChars: number): { text: string; truncated: boolean } {
    const lines = content.split('\n');
    const full = numbered(lines, 1, lines.length);
    if (full.length <= maxChars) return { text: full, truncated: false };

    const windows: Array<[number, number]> = [[1, Math.min(30, lines.length)]];
    lines.forEach((line, i) => {
        const toks = tokenize(line);
        if (terms.some(t => toks.some(tok => tokenMatches(tok, t)))) {
            windows.push([Math.max(1, i + 1 - 6), Math.min(lines.length, i + 1 + 6)]);
        }
    });
    windows.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const w of windows) {
        const last = merged[merged.length - 1];
        if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
        else merged.push([...w]);
    }

    let text = '';
    for (const [start, end] of merged) {
        const block = numbered(lines, start, end);
        const sep = text ? '\n   …\n' : '';
        if (text.length + sep.length + block.length > maxChars) {
            const room = maxChars - text.length - sep.length;
            if (room > 200) text += sep + block.slice(0, room);
            break;
        }
        text += sep + block;
    }
    return { text: text + '\n   … (excerpt; file has ' + lines.length + ' lines)', truncated: true };
}

export function buildContextPack(index: RepoIndex, ranked: RankedFile[], options: PackOptions): ContextPack {
    const files: ContextFile[] = [];
    const omitted: ContextPack['omitted'] = [];
    const withheld: Array<{ path: string; reason: string }> = [];
    const seenHashes = new Map<string, string>();
    const perFileCap = Math.max(1500, Math.floor(options.maxChars / Math.max(2, Math.min(options.maxFiles, 6))));
    let total = 0;

    for (const candidate of ranked) {
        const file = index.byPath.get(candidate.path);
        if (!file || file.kind !== 'text' || file.content === undefined) {
            withheld.push({ path: candidate.path, reason: file ? `${file.kind} file; content not read` : 'not in index' });
            continue;
        }
        if (files.length >= options.maxFiles || options.maxChars - total < 400) {
            omitted.push({ ...candidate, symbols: file.symbols.slice(0, 12) });
            continue;
        }
        const hash = createHash('sha1').update(file.content).digest('hex');
        const duplicateOf = seenHashes.get(hash);
        if (duplicateOf) {
            omitted.push({ ...candidate, symbols: [], reasons: [...candidate.reasons, `duplicate of ${duplicateOf}`] });
            continue;
        }
        seenHashes.set(hash, file.path);

        const budget = Math.min(perFileCap, options.maxChars - total);
        const { text, truncated } = excerptFile(file.content, options.terms, budget);
        files.push({ path: file.path, score: candidate.score, reasons: candidate.reasons, excerpt: text, truncated });
        total += text.length;
    }
    return { terms: options.terms, files, omitted, withheld, totalChars: total };
}

const MANIFESTS = ['package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];

/** Compact repository map: manifests summary plus a (capped) file list with kinds. */
export function renderRepoOverview(index: RepoIndex, maxEntries = 400): string {
    const parts: string[] = [];
    const s = index.stats;
    parts.push(`Indexed files: ${s.indexed} (${s.text} text, ${s.sensitive} sensitive withheld, ${s.binary} binary, ${s.tooLarge} too large, ${s.generated} generated)${s.truncated ? ' — index truncated at file limit' : ''}`);

    for (const name of MANIFESTS) {
        const file = index.byPath.get(name);
        if (file?.kind !== 'text' || !file.content) continue;
        if (name === 'package.json') {
            try {
                const pkg = JSON.parse(file.content) as Record<string, unknown>;
                const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o) : []);
                parts.push(`package.json: name=${String(pkg.name ?? '')} type=${String(pkg.type ?? 'commonjs')}\n  scripts: ${JSON.stringify(pkg.scripts ?? {})}\n  dependencies: ${keys(pkg.dependencies).join(', ') || '(none)'}\n  devDependencies: ${keys(pkg.devDependencies).join(', ') || '(none)'}`);
                continue;
            } catch {
                // fall through to raw excerpt
            }
        }
        parts.push(`${name}:\n${file.content.split('\n').slice(0, 25).join('\n')}`);
    }

    const listed = index.files.slice(0, maxEntries).map(f => {
        const tag = f.kind === 'text' ? '' : ` [${f.kind}]`;
        return `${f.path}${tag}`;
    });
    if (index.files.length > maxEntries) listed.push(`… ${index.files.length - maxEntries} more files`);
    parts.push(`File list:\n${listed.join('\n')}`);
    return parts.join('\n\n');
}

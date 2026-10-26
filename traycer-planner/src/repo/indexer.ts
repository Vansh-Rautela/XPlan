// src/repo/indexer.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { UsageError } from '../errors.js';
import { redactSecrets } from '../redact.js';
import { createIgnoreMatcher, isGeneratedFile } from './ignore.js';
import { hasBinaryExtension, isSensitivePath, looksBinary, toPosix } from './safety.js';
import { detectLanguage, extractImports, extractSymbols, resolveImport } from './symbols.js';

/**
 * - `text`: content loaded (secrets redacted)
 * - `sensitive`: credentials/keys; content never read
 * - `binary`, `too-large`, `generated`, `unreadable`: listed only
 */
export type FileKind = 'text' | 'sensitive' | 'binary' | 'too-large' | 'generated' | 'unreadable';

export interface IndexedFile {
    path: string;
    kind: FileKind;
    size: number;
    language: string | null;
    content?: string;
    lineCount: number;
    symbols: string[];
    /** Repository paths this file imports (resolved, relative imports only). */
    imports: string[];
    /** Repository paths that import this file. */
    importedBy: string[];
    redacted: boolean;
}

export interface IndexStats {
    indexed: number;
    text: number;
    ignored: number;
    symlinksSkipped: number;
    sensitive: number;
    binary: number;
    tooLarge: number;
    generated: number;
    unreadable: number;
    truncated: boolean;
    unsupportedIgnoreRules: string[];
}

export interface RepoIndex {
    root: string;
    files: IndexedFile[];
    byPath: Map<string, IndexedFile>;
    stats: IndexStats;
}

export interface IndexOptions {
    /** Maximum number of files to index (all kinds). */
    maxFiles?: number;
    /** Files larger than this are listed but not read. */
    maxFileBytes?: number;
    /** Extra ignore patterns (gitignore syntax). */
    ignore?: string[];
}

export const INDEX_DEFAULTS = { maxFiles: 5000, maxFileBytes: 256 * 1024 } as const;

export async function buildIndex(rootInput: string, options: IndexOptions = {}): Promise<RepoIndex> {
    const maxFiles = options.maxFiles ?? INDEX_DEFAULTS.maxFiles;
    const maxFileBytes = options.maxFileBytes ?? INDEX_DEFAULTS.maxFileBytes;

    let root: string;
    try {
        root = await fs.realpath(path.resolve(rootInput));
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
        throw new UsageError(`Repository path is not a readable directory: ${rootInput}`, 'Pass an existing directory with --repo.');
    }

    let gitignore = '';
    try {
        gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    } catch {
        // no .gitignore
    }
    const matcher = createIgnoreMatcher(gitignore, options.ignore ?? []);

    const stats: IndexStats = {
        indexed: 0, text: 0, ignored: 0, symlinksSkipped: 0, sensitive: 0, binary: 0,
        tooLarge: 0, generated: 0, unreadable: 0, truncated: false,
        unsupportedIgnoreRules: matcher.unsupportedRules,
    };
    const files: IndexedFile[] = [];

    // Breadth-first walk. Symlinks are never followed, so nothing outside `root` is reachable.
    const queue: string[] = [''];
    walk: while (queue.length > 0) {
        const relDir = queue.shift()!;
        let entries;
        try {
            entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
        } catch {
            stats.unreadable++;
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) {
                stats.symlinksSkipped++;
                continue;
            }
            const isDir = entry.isDirectory();
            if (matcher.isIgnored(rel, isDir)) {
                stats.ignored++;
                continue;
            }
            if (isDir) {
                queue.push(rel);
                continue;
            }
            if (!entry.isFile()) continue;
            if (files.length >= maxFiles) {
                stats.truncated = true;
                break walk;
            }
            files.push(await indexFile(root, rel, maxFileBytes, stats));
        }
    }

    const byPath = new Map(files.map(f => [f.path, f]));
    linkImports(files, byPath);
    stats.indexed = files.length;
    return { root, files, byPath, stats };
}

async function indexFile(root: string, rel: string, maxFileBytes: number, stats: IndexStats): Promise<IndexedFile> {
    const language = detectLanguage(rel);
    const base: IndexedFile = { path: toPosix(rel), kind: 'text', size: 0, language, lineCount: 0, symbols: [], imports: [], importedBy: [], redacted: false };

    if (isSensitivePath(rel)) {
        stats.sensitive++;
        return { ...base, kind: 'sensitive' };
    }

    const abs = path.join(root, rel);
    let size: number;
    try {
        size = (await fs.lstat(abs)).size;
    } catch {
        stats.unreadable++;
        return { ...base, kind: 'unreadable' };
    }
    if (hasBinaryExtension(rel)) {
        stats.binary++;
        return { ...base, size, kind: 'binary' };
    }
    if (isGeneratedFile(rel)) {
        stats.generated++;
        return { ...base, size, kind: 'generated' };
    }
    if (size > maxFileBytes) {
        stats.tooLarge++;
        return { ...base, size, kind: 'too-large' };
    }

    let buffer: Buffer;
    try {
        buffer = await fs.readFile(abs);
    } catch {
        stats.unreadable++;
        return { ...base, size, kind: 'unreadable' };
    }
    if (looksBinary(buffer)) {
        stats.binary++;
        return { ...base, size, kind: 'binary' };
    }

    const raw = buffer.toString('utf8');
    const content = redactSecrets(raw);
    stats.text++;
    return {
        ...base,
        size,
        content,
        redacted: content !== raw,
        lineCount: content.split('\n').length,
        symbols: extractSymbols(language, content),
        // temporarily holds raw specifiers; resolved in linkImports
        imports: extractImports(language, content),
    };
}

function linkImports(files: IndexedFile[], byPath: Map<string, IndexedFile>): void {
    const exists = (p: string) => byPath.get(p)?.kind === 'text';
    for (const file of files) {
        const resolved = new Set<string>();
        for (const spec of file.imports) {
            const target = resolveImport(file.path, spec, file.language, exists);
            if (target && target !== file.path) resolved.add(target);
        }
        file.imports = [...resolved];
    }
    for (const file of files) {
        for (const target of file.imports) {
            byPath.get(target)?.importedBy.push(file.path);
        }
    }
}

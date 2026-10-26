// src/repo/tools.ts
// Read-only tools the model may call during exploration. They operate on the in-memory index
// only, so they cannot reach files outside the repository, sensitive files, or anything ignored.
import { minimatch } from 'minimatch';
import type { JsonSchema, ToolSpec } from '../llm/types.js';
import type { RepoIndex } from './indexer.js';
import { toRepoRelative } from './safety.js';

const MAX_READ_LINES = 250;
const MAX_RESULT_CHARS = 8000;
const MAX_MATCHES = 40;

export interface ToolResult {
    ok: boolean;
    output: string;
    /** Repository path that was read, if any (used for reporting). */
    path?: string;
}

const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });

export const REPO_TOOL_SPECS: ToolSpec[] = [
    {
        name: 'list_files',
        description: 'List repository files, optionally filtered by a glob such as "src/**/*.ts".',
        parameters: { type: 'object', properties: { pattern: str('Glob pattern relative to the repository root.') }, required: [] },
    },
    {
        name: 'read_file',
        description: `Read a repository file with line numbers (max ${MAX_READ_LINES} lines per call).`,
        parameters: {
            type: 'object',
            properties: {
                path: str('Repository-relative file path.'),
                startLine: int('First line to read (1-based).'),
                endLine: int('Last line to read (inclusive).'),
            },
            required: ['path'],
        },
    },
    {
        name: 'search_code',
        description: 'Case-insensitive literal text search across repository files. Returns file:line matches.',
        parameters: {
            type: 'object',
            properties: {
                query: str('Literal text to search for (not a regex).'),
                pathPattern: str('Optional glob to restrict the search, e.g. "src/**".'),
            },
            required: ['query'],
        },
    },
];

function clip(text: string): string {
    return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n… (truncated)' : text;
}

function asString(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function asInt(v: unknown): number | undefined {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export class RepoToolset {
    constructor(private readonly index: RepoIndex) {}

    get specs(): ToolSpec[] {
        return REPO_TOOL_SPECS;
    }

    /** Never throws: errors are returned to the model as tool output. */
    execute(name: string, args: Record<string, unknown>): ToolResult {
        try {
            switch (name) {
                case 'list_files': return this.listFiles(asString(args.pattern));
                case 'read_file': return this.readFile(asString(args.path), asInt(args.startLine), asInt(args.endLine));
                case 'search_code': return this.searchCode(asString(args.query), asString(args.pathPattern));
                default: return { ok: false, output: `Unknown tool "${name}". Available: ${REPO_TOOL_SPECS.map(t => t.name).join(', ')}` };
            }
        } catch (error) {
            return { ok: false, output: `Tool error: ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    private listFiles(pattern?: string): ToolResult {
        const files = this.index.files
            .filter(f => !pattern || minimatch(f.path, pattern, { dot: true, matchBase: !pattern.includes('/') }))
            .map(f => (f.kind === 'text' ? f.path : `${f.path} [${f.kind}]`));
        return { ok: true, output: clip(files.length ? files.join('\n') : 'No files match.') };
    }

    private readFile(requested?: string, startLine?: number, endLine?: number): ToolResult {
        if (!requested) return { ok: false, output: 'read_file requires "path".' };
        const rel = toRepoRelative(this.index.root, requested);
        if (!rel) return { ok: false, output: `Refused: "${requested}" is outside the repository.` };
        const file = this.index.byPath.get(rel);
        if (!file) return { ok: false, output: `File not found in repository index: ${rel}` };
        if (file.kind !== 'text' || file.content === undefined) {
            return { ok: false, output: `Refused: ${rel} is a ${file.kind} file; its content is not available.` };
        }
        const lines = file.content.split('\n');
        const start = Math.max(1, startLine ?? 1);
        const end = Math.min(lines.length, endLine ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        if (start > lines.length) return { ok: false, output: `${rel} has only ${lines.length} lines.` };
        const width = String(end).length;
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join('\n');
        const more = end < lines.length ? `\n… (${lines.length - end} more lines; call read_file with startLine=${end + 1})` : '';
        return { ok: true, path: rel, output: clip(`${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`) };
    }

    private searchCode(query?: string, pathPattern?: string): ToolResult {
        if (!query) return { ok: false, output: 'search_code requires "query".' };
        const needle = query.toLowerCase();
        const matches: string[] = [];
        for (const file of this.index.files) {
            if (file.kind !== 'text' || !file.content) continue;
            if (pathPattern && !minimatch(file.path, pathPattern, { dot: true })) continue;
            const lines = file.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i]!.toLowerCase().includes(needle)) {
                    matches.push(`${file.path}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
                    if (matches.length >= MAX_MATCHES) {
                        return { ok: true, output: clip(matches.join('\n') + '\n… (more matches omitted)') };
                    }
                }
            }
        }
        return { ok: true, output: matches.length ? clip(matches.join('\n')) : `No matches for "${query}".` };
    }
}

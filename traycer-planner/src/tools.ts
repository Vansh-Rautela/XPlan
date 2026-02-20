// src/tools.ts
import fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import Fuse from 'fuse.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Type, Tool, Schema, FunctionDeclaration } from '@google/genai';
dotenv.config();

export interface FileInfo {
    path: string;
    content: string;
    size: number;
    lastModified: Date;
}

export interface SearchResult {
    file: string;
    line: number;
    content: string;
    score?: number;
}

export interface CodeChunk {
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    embedding?: number[];
}

export class FileSystemTools {
    private codeChunks: CodeChunk[] = [];
    private embeddings: Map<string, number[]> = new Map();

    public toolDeclarations: Tool[] = [
        {
            functionDeclarations: [
                {
                    name: 'readFile',
                    description: 'Read a file and return its content',
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            filePath: {
                                type: Type.STRING,
                                description: 'The path to the file to read.'
                            }
                        },
                        required: ['filePath']
                    }
                } as FunctionDeclaration,
                {
                    name: 'listDirectory',
                    description: 'List directory contents',
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            dirPath: {
                                type: Type.STRING,
                                description: 'The path to the directory to list.'
                            },
                            recursive: {
                                type: Type.BOOLEAN,
                                description: 'Whether to list contents recursively.'
                            }
                        },
                        required: ['dirPath']
                    }
                } as FunctionDeclaration,
                {
                    name: 'searchFile',
                    description: 'Search for files by name pattern',
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            pattern: {
                                type: Type.STRING,
                                description: 'The glob pattern to search for.'
                            },
                            rootDir: {
                                type: Type.STRING,
                                description: 'The root directory to start the search from.'
                            }
                        },
                        required: ['pattern']
                    }
                } as FunctionDeclaration,
                {
                    name: 'grep',
                    description: 'Search for text content in files',
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            searchTerm: {
                                type: Type.STRING,
                                description: 'The text to search for.'
                            },
                            rootDir: {
                                type: Type.STRING,
                                description: 'The root directory to search in.'
                            },
                            filePattern: {
                                type: Type.STRING,
                                description: 'Glob pattern for files to include in the search.'
                            }
                        },
                        required: ['searchTerm']
                    }
                } as FunctionDeclaration,
                {
                    name: 'searchCodebase',
                    description: 'Semantic search through the codebase',
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            query: {
                                type: Type.STRING,
                                description: 'The natural language query for semantic search.'
                            },
                            limit: {
                                type: Type.NUMBER,
                                description: 'The maximum number of results to return.'
                            }
                        },
                        required: ['query']
                    }
                } as FunctionDeclaration,
                {
                    name: 'getFileInfo',
                    description: 'Get file information (content, size, last modified)',
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            filePath: {
                                type: Type.STRING,
                                description: 'The path to the file.'
                            }
                        },
                        required: ['filePath']
                    }
                } as FunctionDeclaration
            ]
        }
    ];

    constructor() { }

    /**
     * Read a file and return its content
     */
    async readFile(filePath: string): Promise<string> {
        try {
            const fullPath = path.resolve(filePath);
            const content = await fs.readFile(fullPath, 'utf-8');
            console.log(chalk.green(`✓ Read file: ${filePath}`));
            return content;
        } catch (error) {
            console.log(chalk.red(`✗ Error reading file ${filePath}: ${error}`));
            throw error;
        }
    }

    /**
     * List directory contents
     */
    async listDirectory(dirPath: string, recursive: boolean = false): Promise<string[]> {
        try {
            const fullPath = path.resolve(dirPath);
            const stats = await fs.stat(fullPath);

            if (!stats.isDirectory()) {
                throw new Error(`${dirPath} is not a directory`);
            }

            let items: string[] = [];

            if (recursive) {
                const pattern = path.join(fullPath, '**', '*').replace(/\\/g, '/');
                items = await glob(pattern, {
                    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
                });
                items = items.map(item => path.relative(fullPath, item));
            } else {
                const entries = await fs.readdir(fullPath);
                for (const entry of entries) {
                    const entryPath = path.join(fullPath, entry);
                    const stat = await fs.stat(entryPath);
                    items.push(stat.isDirectory() ? `${entry}/` : entry);
                }
            }

            console.log(chalk.green(`✓ Listed directory: ${dirPath} (${items.length} items)`));
            return items.sort();
        } catch (error) {
            console.log(chalk.red(`✗ Error listing directory ${dirPath}: ${error}`));
            throw error;
        }
    }

    /**
     * Search for files by name pattern
     */
    async searchFile(pattern: string, rootDir: string = '.'): Promise<string[]> {
        try {
            const fullRootPath = path.resolve(rootDir);
            const searchPattern = path.join(fullRootPath, '**', pattern).replace(/\\/g, '/');

            const files = await glob(searchPattern, {
                ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
            });

            const relativeFiles = files.map(file => path.relative(fullRootPath, file));
            console.log(chalk.green(`✓ Found ${relativeFiles.length} files matching "${pattern}"`));
            return relativeFiles;
        } catch (error) {
            console.log(chalk.red(`✗ Error searching files: ${error}`));
            throw error;
        }
    }

    /**
     * Search for text content in files using grep-like functionality
     */
    async grep(searchTerm: string, rootDir: string = '.', filePattern: string = '**/*'): Promise<SearchResult[]> {
        try {
            const fullRootPath = path.resolve(rootDir);
            const searchPattern = path.join(fullRootPath, filePattern).replace(/\\/g, '/');

            const files = await glob(searchPattern, {
                ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
            });

            const results: SearchResult[] = [];
            const regex = new RegExp(searchTerm, 'gi');

            for (const file of files) {
                try {
                    const content = await fs.readFile(file, 'utf-8');
                    const lines = content.split('\n');

                    lines.forEach((line, index) => {
                        if (regex.test(line)) {
                            results.push({
                                file: path.relative(fullRootPath, file),
                                line: index + 1,
                                content: line.trim()
                            });
                        }
                    });
                } catch (error) {
                    // Skip files that can't be read
                    continue;
                }
            }

            console.log(chalk.green(`✓ Found ${results.length} matches for "${searchTerm}"`));
            return results;
        } catch (error) {
            console.log(chalk.red(`✗ Error in grep search: ${error}`));
            throw error;
        }
    }

    /**
     * Create embeddings for code chunks using simple fallback
     */
    private async createEmbedding(text: string): Promise<number[]> {
        // Use simple fallback embedding to avoid SDK/version coupling.
        return this.createSimpleEmbedding(text);
    }

    /**
     * Create a simple embedding based on text content (fallback)
     */
    private createSimpleEmbedding(text: string): number[] {
        // Simple hash-based embedding for fallback
        const words = text.toLowerCase().split(/\s+/);
        const embedding = new Array(1536).fill(0);

        words.forEach(word => {
            const hash = this.simpleHash(word);
            const index = hash % embedding.length;
            embedding[index] += 1;
        });

        // Normalize
        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        return embedding.map(val => norm > 0 ? val / norm : 0);
    }

    /**
     * Simple hash function
     */
    private simpleHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Split code into semantic chunks
     */
    private splitCodeIntoChunks(filePath: string, content: string): CodeChunk[] {
        const lines = content.split('\n');
        const chunks: CodeChunk[] = [];
        const maxChunkSize = 1000; // lines per chunk
        const overlap = 50; // lines of overlap between chunks

        for (let i = 0; i < lines.length; i += maxChunkSize - overlap) {
            const endLine = Math.min(i + maxChunkSize, lines.length);
            const chunkContent = lines.slice(i, endLine).join('\n');

            chunks.push({
                filePath,
                startLine: i + 1,
                endLine,
                content: chunkContent
            });
        }

        return chunks;
    }

    /**
     * Index codebase for semantic search
     */
    async indexCodebase(rootDir: string = '.'): Promise<void> {
        try {
            console.log(chalk.blue('🔍 Indexing codebase for semantic search...'));

            const fullRootPath = path.resolve(rootDir);
            const globPattern = path.join(fullRootPath, '**/*.{ts,js,tsx,jsx,py,java,cpp,c,go,rs}').replace(/\\/g, '/');
            const codeFiles = await glob(globPattern, {
                ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
            });

            this.codeChunks = [];
            this.embeddings.clear();

            for (const file of codeFiles) {
                try {
                    const content = await fs.readFile(file, 'utf-8');
                    const relativePath = path.relative(fullRootPath, file);
                    const chunks = this.splitCodeIntoChunks(relativePath, content);

                    for (const chunk of chunks) {
                        this.codeChunks.push(chunk);

                        const embedding = await this.createEmbedding(chunk.content);
                        if (embedding.length > 0) {
                            this.embeddings.set(`${chunk.filePath}:${chunk.startLine}`, embedding);
                        }
                    }
                } catch (error) {
                    console.log(chalk.yellow(`⚠ Skipping file ${file}: ${error}`));
                }
            }

            console.log(chalk.green(`✓ Indexed ${this.codeChunks.length} code chunks from ${codeFiles.length} files`));
        } catch (error) {
            console.log(chalk.red(`✗ Error indexing codebase: ${error}`));
            throw error;
        }
    }

    /**
     * Semantic search through codebase
     */
    async searchCodebase(query: string, limit: number = 10): Promise<SearchResult[]> {
        if (this.codeChunks.length === 0) {
            console.log(chalk.yellow('⚠ Codebase not indexed. Run indexCodebase() first.'));
            return [];
        }

        try {
            console.log(chalk.blue(`🔍 Searching codebase for: "${query}"`));

            if (this.embeddings.size > 0) {
                // Use semantic search with embeddings
                const queryEmbedding = await this.createEmbedding(query);
                if (queryEmbedding.length === 0) {
                    return this.fallbackSearch(query, limit);
                }

                const similarities: Array<{ chunk: CodeChunk; similarity: number }> = [];

                for (const [key, embedding] of this.embeddings) {
                    const similarity = this.cosineSimilarity(queryEmbedding, embedding);
                    const [filePath, startLineStr] = key.split(':');
                    const startLine = parseInt(startLineStr);

                    const chunk = this.codeChunks.find(c =>
                        c.filePath === filePath && c.startLine === startLine
                    );

                    if (chunk) {
                        similarities.push({ chunk, similarity });
                    }
                }

                similarities.sort((a, b) => b.similarity - a.similarity);

                return similarities.slice(0, limit).map(({ chunk, similarity }) => ({
                    file: chunk.filePath,
                    line: chunk.startLine,
                    content: chunk.content.split('\n')[0].trim(),
                    score: similarity
                }));
            } else {
                // Fallback to fuzzy search
                return this.fallbackSearch(query, limit);
            }
        } catch (error) {
            console.log(chalk.red(`✗ Error in semantic search: ${error}`));
            return this.fallbackSearch(query, limit);
        }
    }

    /**
     * Fallback search using fuzzy matching
     */
    private fallbackSearch(query: string, limit: number): SearchResult[] {
        const fuse = new Fuse(this.codeChunks, {
            keys: ['content'],
            threshold: 0.6,
            includeScore: true
        });

        const results = fuse.search(query);
        return results.slice(0, limit).map(result => ({
            file: result.item.filePath,
            line: result.item.startLine,
            content: result.item.content.split('\n')[0].trim(),
            score: result.score ? 1 - result.score : undefined
        }));
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Get file information
     */
    async getFileInfo(filePath: string): Promise<FileInfo> {
        try {
            const fullPath = path.resolve(filePath);
            const stats = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf-8');

            return {
                path: filePath,
                content,
                size: stats.size,
                lastModified: stats.mtime
            };
        } catch (error) {
            console.log(chalk.red(`✗ Error getting file info: ${error}`));
            throw error;
        }
    }
}
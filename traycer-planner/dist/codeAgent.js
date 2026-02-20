// src/codeAgent.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config.js';
import { FileSystemTools } from './tools.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
dotenv.config();
export class CodeSearchAgent {
    ai;
    model; // The actual model instance
    history;
    tools;
    isIndexed = false;
    constructor(options) {
        if (!process.env.GOOGLE_API_KEY) {
            throw new Error("GOOGLE_API_KEY is not set in the .env file.");
        }
        // Initialize the AI client
        this.ai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        // Get the model instance
        this.model = this.ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
        this.tools = options?.tools ?? new FileSystemTools();
        // Initialize history with system message
        this.history = [{
                role: "user", // Provide system-like instruction as initial user content
                parts: [{
                        text: options?.systemPrompt ?? `
ROLE: Semantic Code Assistant (Gemini 2.5 Flash)
GOAL: Help users explore, plan, and review changes across the codebase using tools.

TOOLS AVAILABLE
- readFile(path)
- listDirectory(path, recursive?)
- searchFile(pattern, rootDir?)
- grep(searchTerm, rootDir?, filePattern?)
- searchCodebase(query, limit?)

GUIDELINES
- Index code (via tools) before deep analysis.
- Provide short, high-signal answers with concrete file paths.
- Do not write code; describe what to change and why.
- When uncertain, ask a brief clarifying question.

RESPONSE FORMAT
- Context: what you looked at
- Findings: concise bullets
- Next steps: specific actions
            `
                    }]
            }];
    }
    async resolveContextFiles(input) {
        const fileRegex = /@([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/g;
        // Matches @path/to/file.ext - basic heuristic to avoid grabbing email addresses or simple mentions
        // Or we can be broader: /@([^\s]+)/g and rely on file existence check.
        // Let's use a broader one but filter by "looks like a file" or just try to read it.
        let expandedInput = input;
        const matches = [...input.matchAll(/@([^\s"'`]+)/g)];
        if (matches.length === 0)
            return input;
        console.log(chalk.cyan(`\n📎 Detected ${matches.length} context reference(s)...`));
        for (const match of matches) {
            const token = match[0];
            const filePath = match[1];
            // Skip common non-file mentions if needed, but for now try all
            try {
                // Check if file exists roughly or just try reading
                const content = await this.tools.readFile(filePath);
                const contextBlock = `
\n\n\`\`\`${filePath}
${content}
\`\`\`\n`;
                expandedInput += contextBlock;
                console.log(chalk.green(`  ✓ Injected context: ${filePath}`));
            }
            catch (e) {
                // If file not found, just ignore (it might be a normal @mention)
                // console.log(chalk.gray(`  (Skipped ${token}: not a readable file)`));
            }
        }
        return expandedInput;
    }
    async chat(userInput) {
        // 1. Resolve @mentions to inject file context
        const contextEnhancedInput = await this.resolveContextFiles(userInput);
        // 2. Add processed input to history
        this.history.push({ role: 'user', parts: [{ text: contextEnhancedInput }] });
        if (!this.isIndexed) {
            console.log(chalk.blue('🔍 Auto-indexing codebase for better search...'));
            try {
                await this.tools.indexCodebase('.');
                this.isIndexed = true;
            }
            catch (error) {
                console.log(chalk.yellow(`⚠ Could not index codebase: ${error}`));
            }
        }
        const response = await this.generateResponseWithTools();
        return response;
    }
    async generateResponseWithTools() {
        try {
            // Configure the generation request with tools
            const config = {
                contents: this.history,
                tools: [{ functionDeclarations: this.tools.toolDeclarations[0].functionDeclarations }]
            };
            // 1. First request to the model
            const result = await this.model.generateContent(config);
            const response = result.response;
            const modelResponseContent = response.candidates?.[0]?.content;
            if (!modelResponseContent) {
                return "I am sorry, but I could not process your request.";
            }
            // 2. Add the model's response to history
            this.history.push(modelResponseContent);
            // 3. Extract function calls
            const functionCalls = modelResponseContent.parts
                .filter((part) => !!part.functionCall)
                .map((part) => part.functionCall);
            // If no function calls, return the text response
            if (functionCalls.length === 0) {
                const textResponse = modelResponseContent.parts
                    .filter((p) => p.text)
                    .map((p) => p.text)
                    .join('');
                return textResponse || "I don't have a specific response for that.";
            }
            console.log(chalk.blue(`🔧 Executing ${functionCalls.length} tool call(s)...`));
            // 4. Execute function calls and create function response parts
            const functionResponseParts = await Promise.all(functionCalls.map(async (fc) => {
                try {
                    const result = await this.executeToolCall({
                        name: fc.name,
                        parameters: fc.args
                    });
                    return {
                        functionResponse: {
                            name: fc.name,
                            response: { result }
                        }
                    };
                }
                catch (error) {
                    return {
                        functionResponse: {
                            name: fc.name,
                            response: {
                                error: error instanceof Error ? error.message : "An unknown error occurred."
                            }
                        }
                    };
                }
            }));
            // 5. Add function responses to history
            this.history.push({ role: 'user', parts: functionResponseParts });
            // 6. Get final response from model
            const finalConfig = {
                contents: this.history,
                tools: [{ functionDeclarations: this.tools.toolDeclarations[0].functionDeclarations }]
            };
            const finalResult = await this.model.generateContent(finalConfig);
            const finalResponse = finalResult.response;
            const finalContent = finalResponse.candidates?.[0]?.content;
            if (finalContent) {
                // Add final response to history
                this.history.push(finalContent);
                const finalText = finalContent.parts
                    .filter((p) => p.text)
                    .map((p) => p.text)
                    .join('');
                return finalText || "No final text response.";
            }
            return "I was unable to generate a final response.";
        }
        catch (error) {
            console.error(chalk.red(`Error in generateResponseWithTools: ${error}`));
            return `I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    }
    async executeToolCall(toolCall) {
        const { name, parameters } = toolCall;
        try {
            switch (name) {
                case 'readFile':
                    return await this.tools.readFile(parameters.filePath ?? parameters.path);
                case 'listDirectory':
                    return await this.tools.listDirectory(parameters.dirPath ?? parameters.path, parameters.recursive || false);
                case 'searchFile':
                    return await this.tools.searchFile(parameters.pattern, parameters.rootDir || '.');
                case 'grep':
                    return await this.tools.grep(parameters.searchTerm, parameters.rootDir || '.', parameters.filePattern || '**/*');
                case 'searchCodebase':
                    return await this.tools.searchCodebase(parameters.query, parameters.limit || 10);
                case 'getFileInfo':
                    return await this.tools.getFileInfo(parameters.filePath ?? parameters.path);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            console.error(chalk.red(`Error executing tool ${name}: ${error}`));
            throw error;
        }
    }
    async indexCodebase(rootDir = '.') {
        console.log(chalk.blue('🔍 Indexing codebase...'));
        await this.tools.indexCodebase(rootDir);
        this.isIndexed = true;
        console.log(chalk.green('✓ Codebase indexed successfully!'));
    }
    async searchCode(query, limit = 10) {
        if (!this.isIndexed) {
            await this.indexCodebase();
        }
        return await this.tools.searchCodebase(query, limit);
    }
    async searchFiles(pattern) {
        return await this.tools.searchFile(pattern);
    }
    async grepSearch(term, filePattern = '**/*') {
        return await this.tools.grep(term, '.', filePattern);
    }
    getHistory() {
        return this.history;
    }
    clearHistory() {
        // Keep first message (system prompt)
        this.history = this.history.slice(0, 1);
    }
}

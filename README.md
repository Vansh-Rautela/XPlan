# Xplan : A CLI based Tool
A CLI tool that uses AI agents to help break down complex coding tasks into actionable plans. Think of it as having three specialized assistants: one to create phase plans, one to detail file-by-file changes, and one to review everything before you start coding.

## What it does

Instead of jumping straight into code, Codex-CLI helps you plan first. It uses Google's Gemini models to analyze your codebase and generate structured plans that specify which files need changes, what those changes should be, and what to watch out for.

**Three modes:**

- **Creator** - Takes your high-level goal and breaks it into phases with specific files to modify
- **Planner** - Takes a phase and creates a detailed file-by-file plan of changes
- **Reviewer** - Reviews plans for risks, missing files, and potential conflicts

## Features

- **Codebase indexing** - Automatically indexes your code for semantic search
- **File context injection** - Use `@filename` in queries to automatically include file contents
- **Semantic code search** - Find relevant code using natural language queries
- **Multi-agent workflow** - Specialized agents for different planning stages

## Prerequisites

- Node.js 18+ 
- A Google AI API key ([get one here](https://makersuite.google.com/app/apikey))

## Installation

```bash
cd traycer-planner
npm install
```

Create a `.env` file in the project root:

```
GOOGLE_API_KEY=your_api_key_here
```

## Usage

Start the CLI:

```bash
npm start
```

You'll see a menu with three options:

1. **Creator Mode** - Describe your goal and get a phase-by-phase breakdown
2. **Planner Mode** - Paste a phase and get detailed file-by-file changes
3. **Reviewer Mode** - Paste a plan and get a risk assessment

### Example workflow

1. Start Creator mode and describe what you want to build:
   ```
   > Add user authentication with JWT tokens
   ```

2. Copy one of the phases and switch to Planner mode:
   ```
   > [paste phase here]
   ```

3. Review the detailed plan in Reviewer mode before implementing:
   ```
   > [paste plan here]
   ```

### Using file context

You can reference files directly in your queries using `@filename`:

```
> How does @src/main.ts handle errors?
```

The agent will automatically read and include the file content in its analysis.

## How it works

The tool uses Google's Gemini 2.0 Flash model with function calling. Each agent has access to file system tools:

- `readFile(path)` - Read file contents
- `listDirectory(path, recursive?)` - List directory contents  
- `searchFile(pattern, rootDir?)` - Find files by pattern
- `grep(searchTerm, rootDir?, filePattern?)` - Search code content
- `searchCodebase(query, limit?)` - Semantic code search

The codebase is indexed on startup, creating embeddings for semantic search. This lets the agents understand your codebase structure and find relevant code even with fuzzy queries.

## Project structure

```
src/
├── main.ts          # CLI entry point and menu system
├── planner.ts       # PlanningAgent (legacy, not used in main flow)
├── codeAgent.ts     # CodeSearchAgent with tool calling
├── tools.ts         # FileSystemTools with indexing/search
├── executor.ts      # Plan execution (basic implementation)
├── example.ts       # Demo script
└── test_runner.ts   # Tool testing utilities
```

## Development

Build TypeScript:

```bash
npm run build
```

Run tests:

```bash
node dist/test_runner.js
```

## Notes

- The codebase index is built in-memory and resets on restart
- Semantic search uses a simple hash-based embedding fallback (not production-grade embeddings)
- Plans are descriptive only - the tool doesn't write code, just tells you what to change
- The executor module exists but is minimal - mainly for demonstration

## License

ISC

// src/main.ts
import { PlanningAgent } from './planner.js';
import { CodeSearchAgent } from './codeAgent.js';
import { FileSystemTools } from './tools.js';
import * as readline from 'readline';
import chalk from 'chalk';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Shared tools instance
const sharedTools = new FileSystemTools();

// Agents with specialized system prompts
const creatorAgent = new CodeSearchAgent({
    tools: sharedTools, systemPrompt: `
You are the CREATOR agent.

Goal: Break a user's high-level goal into PHASES. Each phase must specify:
- Phase name and objective
- Files to change (paths) and why
- Dependencies between phases
- Clear acceptance criteria per phase

Rules:
- Do NOT write code.
- Be concrete about file paths that will be edited/created.
- Use the codebase index to reference actual files.
- Output strictly in this format:

PHASES
1) <Phase Name>
  - Goal: <one sentence>
  - Files:
    - <path>: <reason>
  - Dependencies: <phase numbers or none>
  - Acceptance Criteria: <bullets>

2) ...

Final Note: Suggest which phase to start with and why.
` });

const plannerAgent = new CodeSearchAgent({
    tools: sharedTools, systemPrompt: `
You are the PLANNER agent.

Input: A single PHASE specification from the Creator.
Output: A FILE-BY-FILE plan of changes required to implement the phase.

For each file:
- Path: <path>
- Purpose: <why this file>
- Changes:
  - <specific edits or additions>
- Edge Cases:
  - <risks/notes>
- Acceptance Checks:
  - <what to verify after edits>

Rules: Do NOT write code. Only describe edits precisely.
` });

const reviewerAgent = new CodeSearchAgent({
    tools: sharedTools, systemPrompt: `
You are the REVIEWER agent.

Input: A FILE-BY-FILE plan from the Planner.
Output: A review with:
- Summary of intent
- Risks or missing files
- Conflicts with existing code
- Recommendations (ordered list)
- Final checklist

Rules: Do NOT write code. Be concise and high-signal.
` });

function askQuestion(query: string): Promise<string> {
    return new Promise(resolve => rl.question(query, resolve));
}

function displayMenu() {
    console.log(chalk.cyan("\n" + "=".repeat(60)));
    console.log(chalk.cyan("🤖 Codex-CLI - Creator / Planner / Reviewer"));
    console.log(chalk.cyan("=".repeat(60)));
    console.log(chalk.yellow("Choose your mode:"));
    console.log(chalk.white("1. 🧱 Creator - Produce phase plan with files to change"));
    console.log(chalk.white("2. 🗂️ Planner - File-by-file plan for a single phase"));
    console.log(chalk.white("3. 🧐 Reviewer - Review a plan for risks and gaps"));
    console.log(chalk.white("4. ❌ Exit"));
    console.log(chalk.cyan("=".repeat(60)));
}

async function creatorMode() {
    console.log(chalk.green("\n🧱 Creator Mode"));
    console.log(chalk.gray("Describe your high-level goal. Type 'back' to return."));
    while (true) {
        const userInput = await askQuestion(chalk.blue("\n> "));
        if (userInput.toLowerCase() === 'back') break;
        const response = await creatorAgent.chat(userInput);
        console.log(chalk.white("\n" + response));
    }
}

async function plannerMode() {
    console.log(chalk.green("\n🗂️ Planner Mode"));
    console.log(chalk.gray("Paste one PHASE from Creator. Type 'back' to return."));
    while (true) {
        const userInput = await askQuestion(chalk.blue("\n> "));
        if (userInput.toLowerCase() === 'back') break;
        const response = await plannerAgent.chat(userInput);
        console.log(chalk.white("\n" + response));
    }
}

async function reviewerMode() {
    console.log(chalk.green("\n🧐 Reviewer Mode"));
    console.log(chalk.gray("Paste a Planner plan for review. Type 'back' to return."));
    while (true) {
        const userInput = await askQuestion(chalk.blue("\n> "));
        if (userInput.toLowerCase() === 'back') break;
        const response = await reviewerAgent.chat(userInput);
        console.log(chalk.white("\n" + response));
    }
}

// Removed quickSearch and index-only modes to keep only the three core agents

async function main() {
    console.log(chalk.cyan("🚀 Starting Codex-CLI (Creator / Planner / Reviewer)..."));
    // Pre-index codebase once at startup
    try {
        console.log(chalk.yellow('Indexing codebase...'));
        await sharedTools.indexCodebase('.')
    } catch (e) {
        console.log(chalk.red(`Indexing failed: ${e}`));
    }

    while (true) {
        displayMenu();
        const choice = await askQuestion(chalk.blue("\nEnter your choice (1-4): "));

        switch (choice) {
            case '1':
                await creatorMode();
                break;
            case '2':
                await plannerMode();
                break;
            case '3':
                await reviewerMode();
                break;
            case '4':
                console.log(chalk.green("👋 Goodbye!"));
                rl.close();
                return;
            default:
                console.log(chalk.red("Invalid choice. Please enter 1-4."));
        }
    }
}

main().catch(console.error);
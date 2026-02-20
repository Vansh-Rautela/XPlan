// src/example.ts
import { CodeSearchAgent } from './codeAgent.js';
import chalk from 'chalk';

async function demonstrateAgent() {
    console.log(chalk.cyan("🚀 Codex-CLI Code Search Agent Demo"));
    console.log(chalk.gray("This demo shows the agent's capabilities with your codebase\n"));

    const agent = new CodeSearchAgent();

    // Example queries to demonstrate different capabilities
    const examples = [
        {
            title: "📁 Directory Exploration",
            query: "List the contents of the src directory"
        },
        {
            title: "🔍 File Search",
            query: "Find all TypeScript files in the project"
        },
        {
            title: "📝 Content Search",
            query: "Search for 'import' statements across all files"
        },
        {
            title: "🧠 Semantic Search",
            query: "How does the planning agent work?"
        },
        {
            title: "📖 Code Analysis",
            query: "Explain the main function and its purpose"
        }
    ];

    for (const example of examples) {
        console.log(chalk.yellow(`\n${example.title}`));
        console.log(chalk.gray(`Query: "${example.query}"`));
        console.log(chalk.cyan("-".repeat(50)));

        try {
            const response = await agent.chat(example.query);
            console.log(chalk.white(response));
        } catch (error) {
            console.log(chalk.red(`Error: ${error}`));
        }

        console.log(chalk.cyan("-".repeat(50)));

        // Wait for user to continue
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(chalk.green("\n✅ Demo completed! The agent is ready to help you explore your codebase."));
}

// Run demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    demonstrateAgent().catch(console.error);
}

export { demonstrateAgent };

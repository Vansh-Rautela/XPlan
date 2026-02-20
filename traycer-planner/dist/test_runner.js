import { FileSystemTools } from './tools.js';
import chalk from 'chalk';
import path from 'path';
async function runTests() {
    console.log(chalk.cyan("🚀 Starting Traycer Tools Test..."));
    const tools = new FileSystemTools();
    const testDir = process.cwd();
    console.log(chalk.yellow("\n1. Testing Directory Listing (Index Check)..."));
    try {
        await tools.indexCodebase(testDir);
        // We expect non-zero chunks if the glob fix worked
        // tools.indexCodebase logs its own success message
    }
    catch (e) {
        console.error(chalk.red("Failed to index codebase:"), e);
    }
    console.log(chalk.yellow("\n2. Testing listDirectory..."));
    try {
        const items = await tools.listDirectory(testDir, false);
        console.log(chalk.green("Items found:"), items.length);
        if (items.includes('package.json')) {
            console.log(chalk.green("✓ package.json found in list"));
        }
        else {
            console.log(chalk.red("✗ package.json NOT found in list"));
        }
    }
    catch (e) {
        console.error(chalk.red("Failed listDirectory:"), e);
    }
    console.log(chalk.yellow("\n3. Testing readFile..."));
    try {
        const content = await tools.readFile(path.join(testDir, 'package.json'));
        if (content.includes('traycer-planner')) {
            console.log(chalk.green("✓ Content verification passed"));
        }
        else {
            console.log(chalk.red("✗ Content verification failed"));
        }
    }
    catch (e) {
        console.error(chalk.red("Failed readFile:"), e);
    }
    console.log(chalk.yellow("\n4. Testing searchFile (Glob)..."));
    try {
        const found = await tools.searchFile('*.ts', 'src');
        console.log(chalk.green("TS Files found in src:"), found.length);
        if (found.length > 0) {
            console.log(chalk.green(`✓ Found: ${found[0]}`));
        }
        else {
            console.log(chalk.red("✗ No TS files found (Glob issue?)"));
        }
    }
    catch (e) {
        console.error(chalk.red("Failed searchFile:"), e);
    }
    console.log(chalk.yellow("\n5. Testing searchCodebase (Semantic/Fuzzy)..."));
    try {
        const results = await tools.searchCodebase("planner");
        console.log(chalk.green("Search results:"), results.length);
        if (results.length > 0) {
            console.log(chalk.green("✓ Top result:"), results[0].file);
        }
        else {
            console.log(chalk.red("✗ No results found for 'planner'"));
        }
    }
    catch (e) {
        console.error(chalk.red("Failed searchCodebase:"), e);
    }
}
runTests().catch(console.error);

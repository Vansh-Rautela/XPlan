// src/executor.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export async function executePlan(plan: string): Promise<void> {
    console.log("\nPlan approved! Starting execution...");

    const steps = plan.split('\n').filter(step => step.length > 0 && step.match(/^\d+\./));

    for (const step of steps) {
        console.log(`\nExecuting step: ${step}`);
        
        try {
            if (step.includes("create a folder named")) {
                const folderName = step.split('named ')[1].trim();
                await execPromise(`mkdir ${folderName}`);
                console.log(`✔️ Created folder: ${folderName}`);
            }
            else if (step.includes("initialize a new Node.js project")) {
                await execPromise(`npm init -y`);
                console.log("✔️ Initialized Node.js project.");
            }
            else if (step.includes("install dependencies")) {
                 await execPromise(`npm install express`);
                 console.log("✔️ Installed dependencies.");
            } else {
                 console.log(`⚠️ No specific command for this step. Skipping.`);
            }
        } catch (error) {
            console.error(`❌ Error executing step: ${step}`);
            console.error(error);
            return; // Stop execution on the first error.
        }
    }
    console.log("\nExecution complete!");
}
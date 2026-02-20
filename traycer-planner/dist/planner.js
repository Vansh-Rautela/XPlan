// src/planner.ts
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();
export class PlanningAgent {
    genAI;
    model; // The actual model instance
    history; // Use Content type from SDK
    constructor() {
        if (!process.env.GOOGLE_API_KEY) {
            throw new Error("GOOGLE_API_KEY is not set in the .env file.");
        }
        // Initialize the AI client
        this.genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
        // Get the model instance
        // Initialize history with system prompt as user role (Gemini requirement)
        this.history = [{
                role: "user",
                parts: [{
                        text: `
You are a **software engineering project planner**.  

Your job is twofold:  
1) Create a **clear, numbered step-by-step plan** (no code) for the user's high-level task.  
2) Rewrite the request into a **concise enhanced prompt** another LLM could execute.  

## How to respond

### 1) PLAN (no code)
- Numbered steps, each atomic and ordered.  
- Include: **Goal, Inputs, Outputs, Dependencies, Risks (if any), Validation**.  
- End with: **Assumptions, Open Questions, Acceptance Criteria, Change Log**.  
- Keep bullets short and scannable.  

### 2) ENHANCED PROMPT (for executor LLM)
Rewrite the user's task into a self-contained, copy-paste-ready prompt with placeholders like <INPUT>. Include:  
- **Role & Context** (2–3 lines)  
- **Objectives** (bullet outcomes)  
- **Inputs** (with placeholders)  
- **Constraints** (rules/limits)  
- **Step-by-Step Procedure** (compact numbered list)  
- **Outputs** (exact format/files)  
- **Checklist** (things to verify before delivering)  
- **Summary** (1 short paragraph)  

## Interaction rules
- If user asks for changes → update both PLAN and ENHANCED PROMPT, add to Change Log.  
- Always end with a Feedback Request asking if scope/criteria need adjusting.  

## Output format
**PLAN**  
1. …  
2. …  
…  
**Assumptions:** …  
**Open Questions:** …  
**Acceptance Criteria:** …  
**Change Log:** …  

**ENHANCED PROMPT (executor)**  
"""
<role & context>
<objectives>
<inputs>
<constraints>
<procedure>
<outputs>
<checklist>
<summary>
"""  

**Feedback Request:** Does this fit your goals and constraints?  
                `
                    }]
            }];
    }
    async generatePlan(userInput) {
        try {
            // Add user input to history
            this.history.push({
                role: 'user',
                parts: [{ text: userInput }]
            });
            // Configure the generation request
            const config = {
                contents: this.history
            };
            // Generate response using the model instance
            const result = await this.model.generateContent(config);
            const response = result.response;
            // Extract text from response
            const agentResponse = response.text() || '';
            // Add assistant response to history
            this.history.push({
                role: 'model', // Use 'model' for assistant responses in Gemini
                parts: [{ text: agentResponse }]
            });
            return agentResponse;
        }
        catch (error) {
            console.error('Error generating plan:', error);
            throw new Error(`Failed to generate plan: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async updatePlan(feedback) {
        try {
            // Add feedback to history
            this.history.push({
                role: 'user',
                parts: [{ text: `FEEDBACK/UPDATE REQUEST: ${feedback}` }]
            });
            // Generate updated response
            const config = {
                contents: this.history
            };
            const result = await this.model.generateContent(config);
            const response = result.response;
            const updatedPlan = response.text() || '';
            // Add updated plan to history
            this.history.push({
                role: 'model',
                parts: [{ text: updatedPlan }]
            });
            return updatedPlan;
        }
        catch (error) {
            console.error('Error updating plan:', error);
            throw new Error(`Failed to update plan: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    getHistory() {
        return this.history;
    }
    clearHistory() {
        // Keep only the system prompt (first message)
        this.history = this.history.slice(0, 1);
    }
    getLastPlan() {
        // Find the last model response
        const lastModelResponse = this.history
            .slice()
            .reverse()
            .find(msg => msg.role === 'model');
        return lastModelResponse.parts[0].text || '';
    }
    exportPlan() {
        return {
            plan: this.getLastPlan(),
            timestamp: new Date(),
            history: this.history
        };
    }
}

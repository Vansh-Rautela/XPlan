import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();
async function list() {
    try {
        if (!process.env.GOOGLE_API_KEY) {
            console.error("No API Key found in .env");
            return;
        }
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        // Note: The Node SDK technically doesn't expose a simple listModels() on the main class in all versions, 
        // but it's often available via the model manager or we can test a simple generation.
        // Actually, listing models requires a different endpoint or using the REST API directly if the SDK doesn't expose it easily.
        // Let's just try to hit the API with a raw fetch to get the list if the SDK is obscure.
        console.log("Checking available models...");
        // Fallback to fetch because SDK methods vary a lot between versions for listing
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`);
        const data = await response.json();
        if (data.models) {
            console.log("Available Models:");
            data.models.forEach((m) => {
                if (m.supportedGenerationMethods?.includes('generateContent')) {
                    console.log(`- ${m.name.replace('models/', '')}`);
                }
            });
        }
        else {
            console.log("Error listing models:", JSON.stringify(data, null, 2));
        }
    }
    catch (e) {
        console.error("Failed:", e);
    }
}
list();

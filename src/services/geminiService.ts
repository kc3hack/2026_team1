
import * as vscode from 'vscode';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';


export interface Example {
    title: string;
    description: string;
    code: string;
}

export interface GeminiResponse {
    summary: string;
    examples: Example[];
}

export class GeminiService {
    private genAI: GoogleGenerativeAI | undefined;
    private model: GenerativeModel | undefined;

    constructor() {
        this.initialize();
    }

    private initialize() {
        const config = vscode.workspace.getConfiguration('docmate');
        const apiKey = config.get<string>('apiKey');
        const modelName = config.get<string>('model') || 'gemini-2.5-flash';

        if (apiKey) {
            this.genAI = new GoogleGenerativeAI(apiKey);
            this.model = this.genAI.getGenerativeModel({ model: modelName });
        }
    }

    async summarize(markdown: string): Promise<GeminiResponse> {
        if (!this.model) {
            // Re-try initialization in case config changed
            this.initialize();
            if (!this.model) {
                throw new Error('Gemini API Key is not configured. Please set docmate.apiKey in settings.');
            }
        }

        const prompt = `
You are a helpful coding assistant.
Read the following documentation (in Markdown) and provide:
1. A concise summary in Japanese.
2. Multiple runnable sample code blocks in JavaScript or TypeScript that demonstrates different usages (e.g. basic usage, edge cases, typical patterns).
   - Each code block should be self-contained.
   - Do not use external libraries unless necessary.

Output the result as a JSON object with keys:
- "summary": string (Japanese summary)
- "examples": array of objects, each with:
  - "title": string (Short title of the example)
  - "description": string (Brief explanation of what this example does)
  - "code": string (The code itself)

Do not include markdown code fences in the output, just raw JSON.

Documentation:
${markdown}
        `;

        try {
            const result = await this.model.generateContent(prompt);
            const responseText = result.response.text();

            // Clean up potentially fenced JSON
            const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();

            const parsed = JSON.parse(cleanJson) as GeminiResponse;
            // Ensure examples is an array even if single object returned (though prompt asks for array)
            if (!Array.isArray(parsed.examples)) {
                // heuristic fix if AI returns bad format
                if ((parsed as any).code) {
                    parsed.examples = [{
                        title: "Basic Usage",
                        description: "Generated example",
                        code: (parsed as any).code
                    }];
                } else {
                    parsed.examples = [];
                }
            }
            return parsed;
        } catch (error) {
            console.error('Gemini API Error:', error);
            throw error;
        }
    }

    async fixCode(originalCode: string, error: string): Promise<GeminiResponse> {
        if (!this.model) {
            this.initialize();
            if (!this.model) {
                throw new Error('Gemini API Key is not configured.');
            }
        }

        const prompt = `
You are a helpful coding assistant.
The following JavaScript/TypeScript code failed to execute:

Code:
\`\`\`javascript
${originalCode}
\`\`\`

Error:
${error}

Please fix the code so it runs correctly in a Node.js environment.
1. Provide a concise summary of the fix.
2. Provide the complete fixed code.

Output the result as a JSON object with keys: "summary" and "code".
Do not include markdown code fences in the output, just raw JSON.
        `;

        try {
            const result = await this.model.generateContent(prompt);
            const responseText = result.response.text();
            const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(cleanJson) as GeminiResponse;
            return parsed;
        } catch (error) {
            console.error('Gemini API Error (fixCode):', error);
            throw error;
        }
    }
}


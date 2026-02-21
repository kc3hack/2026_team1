
import * as vscode from 'vscode';
import { DocService } from '../services/docService';
import { GeminiService } from '../services/geminiService';
import { ExecutionService } from '../services/executionService';

export class DocMateController {
    private docService: DocService;
    private geminiService: GeminiService;
    private executionService: ExecutionService;
    private maxRetries = 5;

    constructor() {
        this.docService = new DocService();
        this.geminiService = new GeminiService();
        this.executionService = new ExecutionService();
    }


    async explain(keyword: string, language: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<{ summary: string; examples: { title: string; description: string; code: string; executionOutput: string }[]; url: string }> {
        // 1. Search
        progress.report({ message: `Searching documentation for "${keyword}"...` });
        const searchResult = await this.docService.search(keyword, language);
        if (!searchResult) {
            throw new Error(`No documentation found for "${keyword}"`);
        }

        // 2. Fetch Content
        progress.report({ message: `Fetching documentation...` });
        const markdown = await this.docService.fetchContent(searchResult.url);

        // 3. Summarize & Generate Code
        progress.report({ message: `Summarizing and generating code with Gemini...` });
        let geminiResponse = await this.geminiService.summarize(markdown);

        // 4. Initial Execution (Best Effort)
        progress.report({ message: `Executing sample codes...` });

        const examplesWithOutput = [];
        for (const example of geminiResponse.examples) {
            // Execute each example
            // We do NOT use the auto-fix loop here for stability and speed.
            // Interaction allows user to fix it themselves.
            const executionResult = await this.executionService.execute(example.code);

            examplesWithOutput.push({
                ...example,
                executionOutput: executionResult.success ? executionResult.output : `Execution failed: ${executionResult.error}`
            });
        }

        return {
            summary: geminiResponse.summary,
            examples: examplesWithOutput,
            url: searchResult.url
        };
    }

    async runCode(code: string): Promise<string> {
        const result = await this.executionService.execute(code);
        return result.success ? result.output : `Execution failed: ${result.error}`;
    }
}

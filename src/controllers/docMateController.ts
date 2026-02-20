import * as vscode from 'vscode';
import { DocService } from '../services/docService';
import { GeminiService } from '../services/geminiService';
import { ExecutionService } from '../services/executionService';
import { GenerateUUIDService } from '../services/generateUUIDService';

export class DocMateController {
    private docService: DocService;
    private geminiService: GeminiService;
    private executionService: ExecutionService;

    private generateUUIDService: GenerateUUIDService;
    private maxRetries = 5;

    constructor(context: vscode.ExtensionContext) {
        this.docService = new DocService();
        this.generateUUIDService = new GenerateUUIDService(context);
        this.geminiService = new GeminiService(this.generateUUIDService);
        this.executionService = new ExecutionService(context.extensionPath);
    }

    async explain(
        keyword: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<{
        summary: string;
        examples: { title: string; description: string; code: string; executionOutput: string }[];
        url: string;
    }> {
        // 1. Search
        progress.report({ message: `Searching MDN for "${keyword}"...` });
        const searchResult = await this.docService.search(keyword);
        if (!searchResult) {
            throw new Error(`No documentation found for "${keyword}"`);
        }

        // 2. Fetch Content
        progress.report({ message: `Fetching documentation...` });
        const markdown = await this.docService.fetchContent(searchResult.url);

        // 3. Summarize & Generate Code
        progress.report({ message: `Summarizing and generating code with Gemini...` });
        const geminiResponse = await this.geminiService.summarize(markdown);

        // 4. Initial Execution (Best Effort)
        progress.report({ message: `Executing sample codes...` });

        const examplesWithOutput = [];
        for (const example of geminiResponse.examples) {
            const executionResult = await this.executionService.execute(example.code);
            examplesWithOutput.push({
                ...example,
                executionOutput: executionResult.success
                    ? executionResult.output
                    : `Execution failed: ${executionResult.error}`
            });
        }

        return {
            summary: geminiResponse.summary,
            examples: examplesWithOutput,
            url: searchResult.url
        };
    }

    /**
     * Webview の "run" メッセージに対応して任意のコードを実行する。
     * - language:    sandbox の言語セレクト値
     * - execCommand: sandbox の execCommand textarea の値
     * - panel:       ストリーム結果を Webview へ送るためのパネル
     */
    async runCode(
        code: string,
        opts?: {
            language?: string;
            execCommand?: string;
            panel?: vscode.WebviewPanel;
        }
    ): Promise<string> {
        const result = await this.executionService.execute(code, {
            lang: opts?.language ?? 'javascript',
            userExecCommand: opts?.execCommand ?? '',
            panel: opts?.panel,
        });
        return result.success ? result.output : `Execution failed: ${result.error}`;
    }
}

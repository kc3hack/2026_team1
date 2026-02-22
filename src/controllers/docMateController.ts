import * as vscode from 'vscode';
import { DocService } from '../services/docService';
import { GeminiService } from '../services/geminiService';
import { ExecutionService } from '../services/executionService';
import { GenerateUUIDService } from '../services/generateUUIDService';
import { CacheService } from '../services/cacheService';

export class DocMateController {
    private docService: DocService;
    private geminiService: GeminiService;
    private executionService: ExecutionService;

    private generateUUIDService: GenerateUUIDService;
    private cacheService: CacheService;

    private maxRetries = 5;

    constructor(context: vscode.ExtensionContext) {
        this.docService = new DocService();
        this.generateUUIDService = new GenerateUUIDService(context);
        this.geminiService = new GeminiService(this.generateUUIDService);
        this.executionService = new ExecutionService(context.extensionPath);
        this.cacheService = new CacheService();
    }

    async explain(
        keyword: string,
        language: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<{
        summary: string;
        examples: { title: string; description:
             string; code: string; executionOutput: string }[];
        url: string;
    }> {
        // 1. Search
        progress.report({ message: `Searching documentation for "${keyword}"...` });
        const searchResult = await this.docService.search(keyword, language);
        if (!searchResult) {
            throw new Error(`No documentation found for "${keyword}"`);
        }

        // 2. キャッシュ確認 ─ 同じ URL のドキュメントが保存済みなら即返す
        const cached = this.cacheService.find(searchResult.url);
        if (cached) {
            progress.report({ message: `キャッシュから読み込み中...` });
            console.log(`DocMateController: キャッシュヒット → ${searchResult.url}`);
            return {
                summary: cached.summary,
                examples: cached.examples,
                url: cached.url,
            };
        }

        // 3. Fetch Content
        progress.report({ message: `Fetching documentation...` });
        const fetchUrl = searchResult.htmlUrl || searchResult.url;
        const markdown = await this.docService.fetchContent(fetchUrl);

        // 4. Summarize & Generate Code
        progress.report({ message: `Summarizing and generating code with Gemini...` });
        const geminiResponse = await this.geminiService.summarize(markdown, language);

        // 5. Initial Execution (Best Effort)
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

        const result = {
            summary: geminiResponse.summary,
            examples: examplesWithOutput,
            url: searchResult.url,
        };

        // 6. キャッシュ保存
        this.cacheService.save(result);

        return result;
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

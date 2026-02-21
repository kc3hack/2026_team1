import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI, GenerativeModel, GenerateContentResult } from '@google/generative-ai';
import { GenerateUUIDService } from './generateUUIDService';

export interface Example {
    title: string;
    description: string;
    code: string;
}

export interface GeminiResponse {
    summary: string;
    examples: Example[];
}

/** langConfig.json の1エントリの型（promptHint を含む） */
interface LangConfigEntry {
    executionType?: string;
    command?: string;
    filename?: string;
    deletefile?: string;
    templatecode?: string;
    /** Gemini へ渡す言語固有の追加指示。空文字または未定義の場合は何も追加しない。 */
    promptHint?: string;
}

export class GeminiService {
    private genAI: GoogleGenerativeAI | undefined;
    private model: GenerativeModel | undefined;
    private generateUUIDService: GenerateUUIDService;

    /** langConfig.json をキャッシュして毎回ファイルを読まないようにする */
    private langConfig: Record<string, LangConfigEntry> = {};

    constructor(generateUUIDService: GenerateUUIDService) {
        this.generateUUIDService = generateUUIDService;
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

    /**
     * langConfig.json を読み込んでキャッシュする。
     * extensionPath が渡された場合のみ読み込みを試みる。
     */
    loadLangConfig(extensionPath: string): void {
        try {
            const configPath = path.join(extensionPath, 'media', 'langConfig.json');
            const raw = fs.readFileSync(configPath, 'utf8');
            this.langConfig = JSON.parse(raw) as Record<string, LangConfigEntry>;
        } catch (e) {
            console.warn('GeminiService: langConfig.json の読み込みに失敗しました。', e);
        }
    }

    /**
     * 指定言語の promptHint を返す。
     * 設定がない・空文字の場合は null を返す。
     */
    private getPromptHint(language: string): string | null {
        const entry = this.langConfig[language];
        if (!entry || !entry.promptHint || entry.promptHint.trim() === '') {
            return null;
        }
        return entry.promptHint.trim();
    }

    /**
     * executionType が iframe 系かどうかを判定する。
     * langConfig に定義がない言語は terminal 扱い。
     */
    private isIframeType(language: string): boolean {
        const entry = this.langConfig[language];
        const execType = entry?.executionType ?? 'terminal';
        return execType.startsWith('iframe-');
    }

    async summarize(markdown: string, language: string): Promise<GeminiResponse> {
        const prompt = this.buildSummarizePrompt(markdown, language);

        try {
            const result = await this.callGemini(prompt);
            const parsed = this.parseGeminiResponse(result);
            return this.normalizeGeminiResult(parsed);
        } catch (primaryError) {
            console.warn('Failed to call the Gemini API directly', primaryError);

            try {
                const fallbackResult = await this.fetchGeminiProxyServer(prompt);
                const fallbackParsed = this.parseGeminiResponse(fallbackResult);
                return this.normalizeGeminiResult(fallbackParsed);
            } catch (fallbackError) {
                console.error('Fallback also failed', fallbackError);

                throw fallbackError;
            }
        }
    }

    /**
     * サマリー用プロンプトを生成する。
     *
     * 基本構造は terminal / iframe で分岐し、
     * langConfig.json の promptHint が存在する場合はコード指示セクションの末尾に追記する。
     * これにより、新しい言語の特殊指示を geminiService.ts を修正せずに
     * langConfig.json だけで管理できる。
     */
    private buildSummarizePrompt(markdown: string, language: string): string {
        const promptHint = this.getPromptHint(language);

        // ── iframe 系（HTML / CSS / React / Vue …） ───────────────
        if (this.isIframeType(language)) {
            // promptHint があればコード指示として追記、なければ汎用の指示のみ
            const codeInstruction = promptHint
                ? promptHint
                : '- Each code block must be self-contained and renderable in a browser iframe.';

            return `You are a helpful coding assistant.
Read the following documentation (in Markdown) and provide:
1. A concise summary in Japanese.
2. Multiple runnable sample code blocks that demonstrate different usages.
${codeInstruction
    .split('\n')
    .map(line => `   ${line}`)
    .join('\n')}

Output the result as a JSON object with keys:
- "summary": string (Japanese summary)
- "examples": array of objects, each with:
  - "title": string (Short title of the example)
  - "description": string (Brief explanation of what this example does)
  - "code": string (The complete, self-contained code as described above)

Do not include markdown code fences in the output, just raw JSON.

Documentation:
${markdown}`.trim();
        }

        // ── terminal 系（JS / Python / Go …） ─────────────────────
        const basePrompt = `You are a helpful coding assistant.
Read the following documentation (in Markdown) and provide:
1. A concise summary in Japanese.
2. Multiple runnable sample code blocks in ${language} that demonstrates different usages (e.g. basic usage, edge cases, typical patterns).
   - Each code block should be self-contained.
   - Do not use external libraries unless necessary.${
       promptHint
           ? '\n' + promptHint.split('\n').map(line => `   ${line}`).join('\n')
           : ''
   }

Output the result as a JSON object with keys:
- "summary": string (Japanese summary)
- "examples": array of objects, each with:
  - "title": string (Short title of the example)
  - "description": string (Brief explanation of what this example does)
  - "code": string (The code itself)

Do not include markdown code fences in the output, just raw JSON.

Documentation:
${markdown}`.trim();

        return basePrompt;
    }

    async fixCode(originalCode: string, error: string, language: string = 'javascript'): Promise<GeminiResponse> {


        const prompt = `
You are a helpful coding assistant.
The following ${language} code failed to execute:

Code:
\`\`\`${language}
${originalCode}
\`\`\`

Error:
${error}

Please fix the code so it runs correctly without errors.
1. Provide a concise summary of the fix.
2. Provide the complete fixed code.

Output the result as a JSON object with keys: "summary" and "code".
Do not include markdown code fences in the output, just raw JSON.`;

        try {
            const result = await this.callGemini(prompt);
            return this.parseGeminiResponse(result);
        } catch (error) {
            console.error('Gemini API Error (fixCode):', error);
            throw error;
        }
    }

    /**
     * Gemini が配列形式で返さなかった場合に配列へ正規化する。
     */
    private normalizeGeminiResult(parsed: GeminiResponse): GeminiResponse {
        if (!Array.isArray(parsed.examples)) {
            if ((parsed as any).code) {
                parsed.examples = [{
                    title: 'Basic Usage',
                    description: 'Generated example',
                    code: (parsed as any).code,
                }];
            } else {
                parsed.examples = [];
            }
        }
        return parsed;
    }

    /**
     * Gemini API を直接呼び出す。
     */
    private async callGemini(prompt: string): Promise<GenerateContentResult> {
        if (!this.model) {
            this.initialize();
            if (!this.model) {
                throw new Error('Gemini API Key is not configured. Please set docmate.apiKey in settings.');
            }
        }
        return await this.model.generateContent(prompt);
    }

    /**
     * Gemini のレスポンスを JSON にパースする。
     */
    private parseGeminiResponse(result: GenerateContentResult | string): GeminiResponse {
        let responseText: string;
        if (typeof result === 'string') {
            responseText = result;
        } else {
            responseText = result.response.text();
        }
        const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(cleanJson) as GeminiResponse;
    }

    /**
     * プロキシサーバー経由で Gemini を呼び出す（フォールバック）。
     */
    async fetchGeminiProxyServer(prompt: string): Promise<string> {
        const clientID = this.generateUUIDService.getClientId();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-client-id': clientID,
        };

        const proxyUrl = process.env.PROXY_URL;
        console.log(proxyUrl);
        if (!proxyUrl) {
            throw new Error('PROXY_URL is not defined');
        }

        const res = await fetch(proxyUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ prompt }),
        });

        const data: any = await res.json();

        if (res.status === 429) {
            throw new Error(`制限エラー: ${data.error}`);
        }
        if (!res.ok) {
            throw new Error(data.error ?? 'サーバーエラー');
        }

        return data.response;
    }
}


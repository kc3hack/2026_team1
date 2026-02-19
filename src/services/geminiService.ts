
import * as vscode from 'vscode';
import { GoogleGenerativeAI, GenerativeModel, GenerateContentResult } from '@google/generative-ai';
import { GenerateUUIDService } from '../services/generateUUIDService';


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

    private generateUUIDService: GenerateUUIDService;

    constructor(generateUUIDService: GenerateUUIDService) {
        this.initialize();
        this.generateUUIDService = generateUUIDService;
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

        /**
         * 最初にAPIキーがローカルで設定されていたら、それを使う
         * ローカルで設定されていないもしくは呼び出しに失敗したらフォールバックを行い、
         * プロキシサーバーを介してgeminiを呼び出す
         */
        try {
            // memo: nekomoti君が書いたコードをメソッド化
            const result = await this.callGemini(prompt);
            const parsed = this.parseGeminiResponse(result);
            return this.normalizeGeminiResult(parsed);
        } catch (primaryError) {
            console.warn('Failed to call the Gemini API directly', primaryError);
            
            try{
                const fallbackResult = await this.fetchGeminiProxyServer(prompt);
                const fallbackParsed = this.parseGeminiResponse(fallbackResult);
                return this.normalizeGeminiResult(fallbackParsed);
            } catch(fallbackError){
                console.error('Fallback also failed',fallbackError);

                throw fallbackError;
            }
        }
    }

    async fixCode(originalCode: string, error: string): Promise<GeminiResponse> {


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
            const result = await this.callGemini(prompt);
            return this.parseGeminiResponse(result);
        } catch (error) {
            console.error('Gemini API Error (fixCode):', error);
            throw error;
        }
    }

    /**
     * Geminiが配列形式で返さなかった場合配列に変換するパース処理
     * @param result 
     * @returns 
     */
    private normalizeGeminiResult(parsed:GeminiResponse): GeminiResponse {

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
    }


    /**
     * GeminiAPIを直接呼び出します
     * @param prompt 
     * @returns 
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
     * Geminiからの文字列の返答からjson形式にパースする
     * @param result geminiの返答
     * @returns パース処理されたjson形式のデータ
     */
    private parseGeminiResponse(result: GenerateContentResult | string): GeminiResponse {
        let responseText: string;
        if (typeof result === "string") {
            responseText = result;
        } else {
            responseText = result.response.text();
        }
        // Clean up potentially fenced JSON
        const cleanJson = responseText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(cleanJson) as GeminiResponse;
    }

    /**
     * GeminiAPIをプロキシサーバーを介して呼び出します
     * @param prompt 
     * @returns 
     */
    async fetchGeminiProxyServer(prompt: string): Promise<string> {
        try {
            let clientID = this.generateUUIDService.getClientId();
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'x-client-id': clientID
            };

            const res = await fetch('http://127.0.0.1:5001/gen-lang-client-0402535960/asia-northeast2/geminiProxy', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ prompt: prompt })
            });

            const data: any = await res.json();

            if (res.status === 429) {
                throw new Error(`制限エラー: ${data.error}`);
            }

            if (!res.ok) {
                throw new Error(data.error ?? 'サーバーエラー');
            }

            return data.response;
        } catch (err) {
            throw err;
        }
    }
}


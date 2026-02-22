import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import { GeminiService } from './geminiService';
import { ExecutionService } from './executionService';

// Gemini が返す JSON のインターフェース（言語非依存）
interface GeminiDocResponse {
    fileDescription: string;
    classes: {
        name: string;
        description: string;
        methods: {
            name: string;
            description: string;
            params: { name: string; type: string }[];
            returnType: string;
            examples: {
                title: string;
                description: string;
                code: string;
                expectedOutput: string;
            }[];
        }[];
    }[];
    functions: {
        name: string;
        description: string;
        params: { name: string; type: string }[];
        returnType: string;
        examples: {
            title: string;
            description: string;
            code: string;
            expectedOutput: string;
        }[];
    }[];
}

interface TocEntry {
    url: string;
    fileName: string;
    description: string;
}

// 対応するソースファイルの拡張子一覧
const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.c', '.cpp', '.h', '.hpp',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt', '.kts',
    '.dart',
    '.vue',
]);

// 除外するディレクトリ名
const EXCLUDE_DIRS = new Set([
    'node_modules', '.git', '.docs', 'dist', 'out',
    '.vscode', '__pycache__', '.next', 'build', 'coverage',
    'vendor', 'target',
]);

// 除外するファイル名パターン
const EXCLUDE_FILES = new Set([
    '.d.ts',
]);

export class GenerateProjectDocumentService {
    context: vscode.ExtensionContext;
    geminiService: GeminiService;
    executionService: ExecutionService;
    limit: pLimit.Limit;

    constructor(context: vscode.ExtensionContext, geminiService: GeminiService, executionService: ExecutionService) {
        this.context = context;
        this.geminiService = geminiService;
        this.executionService = executionService;
        this.limit = pLimit(5);
    }

    async prepare(): Promise<void> {
        // グローバルストレージのルートを確保
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.context.globalStorageUri, '.docs'));
    }

    /**
     * 現在のワークスペースに対応するドキュメントの出力先パスを返す
     * フォルダ名: ワークスペース名_ハッシュ8桁
     */
    getOutputDir(): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return path.join(this.context.globalStorageUri.fsPath, '.docs');
        }
        const workspaceName = path.basename(workspaceRoot);
        const hash = crypto.createHash('md5').update(workspaceRoot).digest('hex').substring(0, 8);
        return path.join(this.context.globalStorageUri.fsPath, '.docs', `${workspaceName}_${hash}`);
    }

    /**
     * ワークスペース内のソースファイルを再帰的に列挙する（パーサー不要）
     */
    private collectSourceFiles(dir: string): string[] {
        const results: string[] = [];
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return results;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (EXCLUDE_DIRS.has(entry.name)) continue;
                results.push(...this.collectSourceFiles(fullPath));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                // .d.ts ファイルを除外
                if (entry.name.endsWith('.d.ts')) continue;
                if (EXCLUDE_FILES.has(ext)) continue;
                if (SOURCE_EXTENSIONS.has(ext)) {
                    results.push(fullPath);
                }
            }
        }
        return results;
    }

    /**
     * ドキュメント生成を実行（Gemini 全任せ、パーサー不要）
     * ユーザーが開いているワークスペースのルートディレクトリを分析対象とする
     */
    async processProject() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('ワークスペースが開かれていません。フォルダを開いてから実行してください。');
        }

        // ワークスペース名を取得
        const workspaceName = path.basename(workspaceRoot);

        // 出力先はプロジェクトごとのサブフォルダ
        const outputDir = this.getOutputDir();
        fs.mkdirSync(outputDir, { recursive: true });

        // ソースファイルを再帰的に列挙（パーサー不要）
        const sourceFiles = this.collectSourceFiles(workspaceRoot);
        console.log(`📂 ${sourceFiles.length} 個のソースファイルを検出`);

        if (sourceFiles.length === 0) {
            throw new Error('ソースファイルが見つかりません。対象の拡張子: ' + Array.from(SOURCE_EXTENSIONS).join(', '));
        }

        const tocEntries: TocEntry[] = [];

        const tasks = sourceFiles.map(filePath => this.limit(async () => {
            const fileName = path.basename(filePath);
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const relativePath = path.relative(workspaceRoot, filePath);
                const ext = path.extname(filePath);

                // HTMLファイルの出力先パス（元の拡張子 → .html）
                const outputFilePath = path.join(outputDir, relativePath).replace(new RegExp(`\\${ext}$`), '.html');
                // HTML内でリンクするためのURLパス
                const urlPath = relativePath.replace(new RegExp(`\\${ext}$`), '.html').replace(/\\/g, '/');

                // Gemini に構造抽出 + 説明 + サンプルコード + 期待出力を一括生成させる
                const aiJson = await this.askGeminiForDescriptionsInJson(fileContent, fileName, this.geminiService);
                if (!aiJson) {
                    console.warn(`⚠️ ${fileName}: Gemini からの応答を取得できませんでした。スキップします。`);
                    return;
                }

                // 目次に登録
                tocEntries.push({ url: urlPath, fileName: fileName, description: aiJson.fileDescription });

                // ルート（index.html）へ戻るための相対パスを計算
                const depth = relativePath.split(path.sep).length - 1;
                const backToRootPath = depth === 0 ? './index.html' : '../'.repeat(depth) + 'index.html';

                // Gemini の JSON から HTML を組み立て（パーサー不要）
                let htmlBody = `<div class="file-desc">${aiJson.fileDescription}</div>`;

                // クラスの処理
                for (const cls of (aiJson.classes || [])) {
                    htmlBody += `<div class="class-card"><h2>📦 Class: ${cls.name}</h2>`;
                    htmlBody += `<p>${cls.description}</p>`;

                    for (const method of (cls.methods || [])) {
                        htmlBody += `<div class="method-card"><h3>⚙️ ${method.name}</h3>`;
                        htmlBody += `<p>${method.description}</p>`;

                        // 引数リスト（Gemini から取得）
                        htmlBody += `<strong>引数:</strong><ul class="param-list">`;
                        if (!method.params || method.params.length === 0) {
                            htmlBody += `<li>なし</li>`;
                        } else {
                            for (const p of method.params) {
                                htmlBody += `<li><span class="badge">${p.name}</span> : <code>${p.type}</code></li>`;
                            }
                        }
                        htmlBody += `</ul><strong>戻り値:</strong> <code>${method.returnType || 'void'}</code>`;

                        // 実行例データを構築
                        const examplesWithOutput = await this.buildExamplesWithOutput(method.examples || [], filePath);

                        // data 属性に JSON を埋め込み
                        const summary = method.description || '';
                        const examplesJson = JSON.stringify(examplesWithOutput).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
                        const summaryEscaped = summary.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
                        htmlBody += `<a href="#" class="explain-link" data-keyword="${method.name}" data-examples="${examplesJson}" data-summary="${summaryEscaped}">🔍 実行例を見る</a></div>`;
                    }
                    htmlBody += `</div>`;
                }

                // トップレベル関数の処理（クラスなし言語対応）
                for (const func of (aiJson.functions || [])) {
                    htmlBody += `<div class="method-card"><h3>🔧 ${func.name}</h3>`;
                    htmlBody += `<p>${func.description}</p>`;

                    htmlBody += `<strong>引数:</strong><ul class="param-list">`;
                    if (!func.params || func.params.length === 0) {
                        htmlBody += `<li>なし</li>`;
                    } else {
                        for (const p of func.params) {
                            htmlBody += `<li><span class="badge">${p.name}</span> : <code>${p.type}</code></li>`;
                        }
                    }
                    htmlBody += `</ul><strong>戻り値:</strong> <code>${func.returnType || 'void'}</code>`;

                    // 実行例データを構築
                    const examplesWithOutput = await this.buildExamplesWithOutput(func.examples || [], filePath);

                    const summary = func.description || '';
                    const examplesJson = JSON.stringify(examplesWithOutput).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
                    const summaryEscaped = summary.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
                    htmlBody += `<a href="#" class="explain-link" data-keyword="${func.name}" data-examples="${examplesJson}" data-summary="${summaryEscaped}">🔍 実行例を見る</a></div>`;
                }

                const finalHtml = this.generateHtmlTemplate(fileName, htmlBody, backToRootPath);
                fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
                fs.writeFileSync(outputFilePath, finalHtml);
                console.log(`✅ 生成完了: ${urlPath}`);
            } catch (error) {
                // 個別ファイルのエラーは他のファイルの処理を止めない
                console.error(`❌ ${fileName} の処理でエラー発生（スキップします）:`, error);
            }
        }));

        // 全ての個別ページの生成を待つ（1ファイルの失敗が他に影響しない）
        const results = await Promise.allSettled(tasks);
        const failedCount = results.filter(r => r.status === 'rejected').length;
        if (failedCount > 0) {
            console.warn(`⚠️ ${failedCount} 件のファイルで処理に失敗しました`);
        }
        console.log(`📊 処理結果: 成功 ${tocEntries.length} 件 / 全 ${sourceFiles.length} 件`);

        console.log("📝 トップページ (index.html) を生成中...");
        const indexHtml = this.generateIndexHtml(tocEntries, workspaceName);
        const indexPath = path.join(outputDir, 'index.html');
        fs.writeFileSync(indexPath, indexHtml);

        console.log(`🎉 完了しました！ ${indexPath} を開いてください！`);
    }

    /**
     * サンプルコードの実行結果を構築する
     * 実行成功 → 本物の出力、失敗 → Gemini の期待出力にフォールバック
     */
    private async buildExamplesWithOutput(
        examples: { title: string; description: string; code: string; expectedOutput: string }[],
        originalFilePath: string
    ) {
        const examplesWithOutput = [];

        for (const ex of examples) {
            // サンプルコードをそのまま実行してみる
            const execResult = await this.executionService.execute(ex.code);

            // 実行成功 → 本物の出力、失敗 → Gemini の期待出力にフォールバック
            const output = execResult.success
                ? execResult.output
                : (ex.expectedOutput || `Execution failed: ${execResult.error}`);

            examplesWithOutput.push({
                title: ex.title,
                description: ex.description,
                code: ex.code,
                executionOutput: output
            });
        }

        return examplesWithOutput;
    }

    /**
     * Gemini にソースコード全文を送り、構造・説明・サンプルコード・期待出力を一括生成させる
     * パーサー不要：Gemini がコード解析を全て行う
     */
    async askGeminiForDescriptionsInJson(fileContent: string, fileName: string, geminiService: GeminiService): Promise<GeminiDocResponse | null> {
        const prompt = `
あなたはソースコード解析のエキスパートです。
以下のファイルの内容を読み取り、ファイル全体の概要、クラス、メソッド、トップレベル関数の「説明文（概要）」を抽出・生成してください。
各メソッド・関数について「引数」「戻り値」「実行例（examples）」も生成してください。

【重要】この機能は言語に依存しません。TypeScript, JavaScript, Python, Java, Go, Rust, C++, C, C#, Ruby, PHP, Swift, Kotlin, Dart, Vue 等どの言語のコードでも分析してください。

【関数の分類ルール】
- クラスのメソッドは "classes" 内の "methods" に入れてください。
- export function, function, def など「クラスに属さないトップレベル関数・エクスポートされた関数」は全て "functions" 配列に入れてください。
- TypeScript/JavaScript の export function, export const, export default function なども "functions" に含めてください。
- Python の def 関数（クラス外）も "functions" に含めてください。

【サンプルコードの厳守ルール】
- require()やimport文は絶対に書かないでください。
- 対象クラスや関数はすでにインポート済みとして、直接利用してください。
- console.log（または対象言語の標準出力）で結果を出力してください。
- 非同期処理の場合は適切にawait等で囲んでください。
- 各メソッド/関数につき1つの実行例を生成してください。
- 各実行例に「expectedOutput」フィールドを含めてください。これはそのコードを実行した場合に標準出力に表示されると期待されるテキストです。

【厳守事項】
- 返答は必ず以下のJSONフォーマットのみとし、マークダウン（\`\`\`json など）や挨拶文は一切含めないでください。

【出力JSONフォーマット】
{
  "fileDescription": "このファイル全体の役割や概要",
  "classes": [
    {
      "name": "クラス名",
      "description": "このクラスの役割",
      "methods": [
        {
          "name": "メソッド名",
          "description": "このメソッドの役割や処理内容",
          "params": [{"name": "引数名", "type": "型名"}],
          "returnType": "戻り値の型",
          "examples": [
            {
              "title": "実行例のタイトル",
              "description": "この実行例の説明",
              "code": "console.log('Hello');",
              "expectedOutput": "Hello"
            }
          ]
        }
      ]
    }
  ],
  "functions": [
    {
      "name": "関数名",
      "description": "この関数の役割",
      "params": [{"name": "引数名", "type": "型名"}],
      "returnType": "戻り値の型",
      "examples": [
        {
          "title": "実行例のタイトル",
          "description": "この実行例の説明",
          "code": "console.log('Hello');",
          "expectedOutput": "Hello"
        }
      ]
    }
  ]
}

※ クラスがないファイルの場合、"classes" は空配列 [] にしてください。
※ トップレベル関数がないファイルの場合、"functions" は空配列 [] にしてください。
※ export function や export const のような「クラスに属さない関数」は必ず "functions" に入れてください。見落とさないでください。

対象ファイル: ${fileName}
コード:
${fileContent}
`;
        let response: string;
        try {
            response = await geminiService.fetchGeminiProxyServer(prompt);
            response = response.replace(/```json/g, '').replace(/```/g, '').trim();
        } catch (error) {
            console.error(`${fileName}のGemini API処理でエラー: `, error);
            return null;
        }

        try {
            const parsedJson = JSON.parse(response) as GeminiDocResponse;
            return parsedJson;
        } catch (error) {
            console.error('パース処理でエラーになりました', error);
            return null;
        }
    }

    /**
     * 個別ページのHTMLテンプレート（Homeに戻るリンク付き）
     */
    generateHtmlTemplate(fileName: string, bodyContent: string, backToRootPath: string): string {
        return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fileName} - API Document</title>
    <style>
        :root { --primary: #007acc; --bg: #f8f9fa; --text: #333; --border: #e1e4e8; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; color: var(--text); background: var(--bg); padding: 2rem; max-width: 900px; margin: 0 auto; }
        .nav-bar { margin-bottom: 2rem; }
        .nav-bar a { text-decoration: none; color: var(--primary); font-weight: bold; }
        .nav-bar a:hover { text-decoration: underline; }
        h1 { border-bottom: 2px solid var(--primary); padding-bottom: 0.5rem; }
        h2 { color: var(--primary); margin-top: 2rem; border-bottom: 1px solid var(--border); }
        .file-desc { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); margin-bottom: 2rem; font-size: 1.1rem; }
        .class-card { background: white; border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; }
        .method-card { background: var(--bg); border-left: 4px solid var(--primary); padding: 1rem; margin-top: 1rem; border-radius: 0 4px 4px 0; }
        .param-list { margin: 0.5rem 0; padding-left: 1.5rem; }
        .badge { background: #e1e4e8; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.85rem; font-family: monospace; color: #d73a49; }
        .explain-link { display: inline-block; margin-top: 0.8rem; padding: 0.4rem 0.8rem; background: var(--primary); color: white; border-radius: 4px; text-decoration: none; font-size: 0.9rem; transition: background 0.2s; }
        .explain-link:hover { background: #005a9e; }
    </style>
</head>
<body>
    <div class="nav-bar"><a href="${backToRootPath}">← ドキュメントホームに戻る</a></div>
    <h1>📄 ${fileName}</h1>
    ${bodyContent}
</body>
</html>`;
    }

    /**
     * テンプレートに従ってトップページを生成します
     */
    generateIndexHtml(entries: TocEntry[], workspaceName: string = 'Project'): string {
        // リンクのカード一覧を生成
        const linksHtml = entries.map(entry => `
        <a href="${entry.url}" class="card">
            <h3>📄 ${entry.fileName}</h3>
            <p>${entry.description}</p>
        </a>
    `).join('');

        return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${workspaceName} - API Documentation</title>
    <style>
        :root { --primary: #007acc; --bg: #f8f9fa; --text: #333; --border: #e1e4e8; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; color: var(--primary); margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem; }
        .card { background: white; padding: 1.5rem; border-radius: 8px; border: 1px solid var(--border); text-decoration: none; color: inherit; transition: transform 0.2s, box-shadow 0.2s; display: block; }
        .card:hover { transform: translateY(-3px); box-shadow: 0 6px 12px rgba(0,0,0,0.1); border-color: var(--primary); }
        .card h3 { margin: 0 0 0.5rem 0; color: var(--primary); font-size: 1.2rem; }
        .card p { margin: 0; font-size: 0.95rem; color: #666; }
    </style>
</head>
<body>
    <h1>📚 ${workspaceName} のドキュメント</h1>
    <div class="grid">
        ${linksHtml}
    </div>
</body>
</html>`;
    }
}
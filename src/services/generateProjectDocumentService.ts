import { Project } from 'ts-morph';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import { GeminiService } from './geminiService';

interface GeminiDocResponse {
    fileDescription: string;
    classes: {
        name: string;
        description: string;
        methods: {
            name: string;
            description: string;
        }[];
    }[];
}

interface TocEntry {
    url: string;
    fileName: string;
    description: string;
}

export class GenerateProjectDocumentService {
    context: vscode.ExtensionContext;
    geminiService: GeminiService;
    limit: pLimit.Limit;

    constructor(context: vscode.ExtensionContext, geminiService: GeminiService) {
        this.context = context;
        this.geminiService = geminiService;
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
     * ドキュメント生成が実行
     * ユーザーが開いているワークスペースのルートディレクトリを分析対象とする
     */
    async processProject() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('ワークスペースが開かれていません。フォルダを開いてから実行してください。');
        }

        // tsconfig.json を探索（直下 → サブディレクトリの順）
        const tsconfigPath = this.findTsConfig(workspaceRoot);
        if (!tsconfigPath) {
            throw new Error(`tsconfig.json がワークスペース内に見つかりません: ${workspaceRoot}`);
        }
        console.log(`📂 tsconfig.json を検出: ${tsconfigPath}`);

        // ワークスペース名を取得
        const workspaceName = path.basename(workspaceRoot);

        // 出力先はプロジェクトごとのサブフォルダ
        const outputDir = this.getOutputDir();
        fs.mkdirSync(outputDir, { recursive: true });

        const project = new Project({
            tsConfigFilePath: tsconfigPath,
        })

        const tocEntries: TocEntry[] = [];
        const sourceFiles = project.getSourceFiles();

        const tasks = sourceFiles.map(sourceFile => this.limit(async () => {
            const originalFilePath = sourceFile.getFilePath();
            const fileName = sourceFile.getBaseName();
            // ワークスペースルートからの相対パスを計算
            const relativePath = path.relative(workspaceRoot, originalFilePath);
            // HTMLファイルの出力先パス
            const outputFilePath = path.join(outputDir, relativePath).replace(/\.ts$/, '.html');
            // HTML内でリンクするためのURLパス（Windows環境のバックスラッシュをスラッシュに置換）
            const urlPath = relativePath.replace(/\.ts$/, '.html').replace(/\\/g, '/');

            const aiJson = await this.askGeminiForDescriptionsInJson(sourceFile.getText(), sourceFile.getBaseName(), this.geminiService);
            if (!aiJson) return;

            // 目次に登録
            tocEntries.push({ url: urlPath, fileName: fileName, description: aiJson.fileDescription });

            // ルート（index.html）へ戻るための相対パスを計算
            // 例: utils/math.html なら "../index.html"
            const depth = relativePath.split(path.sep).length - 1;
            const backToRootPath = depth === 0 ? './index.html' : '../'.repeat(depth) + 'index.html';

            let htmlBody = `<div class="file-desc">${aiJson.fileDescription}</div>`;
            const classes = sourceFile.getClasses();
            for (const cls of classes) {
                const className = cls.getName() || "無名クラス";
                const aiClassInfo = aiJson.classes?.find(c => c.name === className);

                htmlBody += `<div class="class-card"><h2>📦 Class: ${className}</h2>`;
                if (aiClassInfo) htmlBody += `<p>${aiClassInfo.description}</p>`;

                for (const method of cls.getMethods()) {
                    const methodName = method.getName();
                    const aiMethodInfo = aiClassInfo?.methods?.find(m => m.name === methodName);

                    htmlBody += `<div class="method-card"><h3>⚙️ ${methodName}</h3>`;
                    if (aiMethodInfo) htmlBody += `<p>${aiMethodInfo.description}</p>`;

                    htmlBody += `<strong>引数:</strong><ul class="param-list">`;
                    const params = method.getParameters();
                    if (params.length === 0) htmlBody += `<li>なし</li>`;
                    else params.forEach(p => htmlBody += `<li><span class="badge">${p.getName()}</span> : <code>${this.cleanTypeName(p.getType().getText())}</code></li>`);
                    htmlBody += `</ul><strong>戻り値:</strong> <code>${this.cleanTypeName(method.getReturnType().getText())}</code></div>`;
                }
                htmlBody += `</div>`;
            }

            const finalHtml = this.generateHtmlTemplate(fileName, htmlBody, backToRootPath);
            fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
            fs.writeFileSync(outputFilePath, finalHtml);
            console.log(`✅ 生成完了: ${urlPath}`);
        }));

        // 全ての個別ページの生成を待つ
        await Promise.all(tasks);

        console.log("📝 トップページ (index.html) を生成中...");
        const indexHtml = this.generateIndexHtml(tocEntries, workspaceName);
        const indexPath = path.join(outputDir, 'index.html');
        fs.writeFileSync(indexPath, indexHtml);

        console.log(`🎉 完了しました！ ${indexPath} を開いてください！`);
    }

    /**
     * import("...").TypeName のようなフルパスの型表記を TypeName だけにクリーンアップする
     * 例: import("c:/path/to/file").LangConfigEntry → LangConfigEntry
     * 例: { lang?: import("...").X | undefined; } → { lang?: X | undefined; }
     */
    private cleanTypeName(typeName: string): string {
        const cleanedTypeName = typeName.replace(/import\(["'][^"']+["']\)\./g, '');
        return cleanedTypeName;
    }

    /**
     * ワークスペース内を再帰的に探索して tsconfig.json を見つける
     * 直下を優先し、なければサブディレクトリを探索する
     * @param rootDir 探索開始ディレクトリ
     * @returns tsconfig.json の絶対パス、見つからなければ null
     */
    private findTsConfig(rootDir: string): string | null {
        // まず直下を確認
        const directPath = path.join(rootDir, 'tsconfig.json');
        if (fs.existsSync(directPath)) {
            return directPath;
        }

        // 除外するディレクトリ名
        const excludeDirs = new Set(['node_modules', '.git', '.docs', 'dist', 'out', '.vscode']);

        // サブディレクトリを再帰探索
        const search = (dir: string): string | null => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return null;
            }

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (excludeDirs.has(entry.name)) continue;

                const candidate = path.join(dir, entry.name, 'tsconfig.json');
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }

            // 1階層で見つからなければさらに深く探索
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (excludeDirs.has(entry.name)) continue;

                const found = search(path.join(dir, entry.name));
                if (found) return found;
            }

            return null;
        };

        return search(rootDir);
    }

    async askGeminiForDescriptionsInJson(fileContent: string, fileName: string, geminiService: GeminiService): Promise<GeminiDocResponse | null> {
        const prompt = `
あなたはTypeScriptのコード解析アシスタントです。
以下のファイルの内容を読み取り、ファイル全体、クラス、メソッドの「説明文（概要）」のみを抽出・生成してください。
引数や戻り値の解析は不要です。自然言語による役割の説明だけに集中してください。

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
          "description": "このメソッドの役割や処理内容"
        }
      ]
    }
  ]
}

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
     * @param fileName 
     * @param bodyContent 
     * @param backToRootPath 
     * @returns 
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
     * @param entries 
     * @returns 
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
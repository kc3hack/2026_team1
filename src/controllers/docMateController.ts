import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DocService } from '../services/docService';
import { GeminiService } from '../services/geminiService';
import { ExecutionService } from '../services/executionService';
import { GenerateUUIDService } from '../services/generateUUIDService';
import { CacheService } from '../services/cacheService';
import { GenerateProjectDocumentService } from '../services/generateProjectDocumentService';
import { DocMateWebviewProvider } from '../views/webviewProvider';

export class DocMateController {
    private context: vscode.ExtensionContext;
    private docService: DocService;
    private geminiService: GeminiService;
    private executionService: ExecutionService;
    private generateProjectDocumentService: GenerateProjectDocumentService;

    private generateUUIDService: GenerateUUIDService;
    private cacheService: CacheService;

    private maxRetries = 5;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.docService = new DocService();
        this.generateUUIDService = new GenerateUUIDService(context);
        this.geminiService = new GeminiService(this.generateUUIDService);
        this.executionService = new ExecutionService(context.extensionPath);
        this.cacheService = new CacheService();
        this.generateProjectDocumentService = new GenerateProjectDocumentService(context, this.geminiService, this.executionService);
        this.generateProjectDocumentService.prepare();
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
        const markdown = await this.docService.fetchContent(searchResult.url);

        // 4. Summarize & Generate Code
        progress.report({ message: `Summarizing and generating code with Gemini...` });
        const geminiResponse = await this.geminiService.summarize(markdown);

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

    /**
     * プロジェクトドキュメントを生成する
     * 生成済みならスキップし、未生成なら Gemini API で生成
     * 生成後は新規タブで index.html を表示する
     */
    async generateProjectDocument(): Promise<void> {
        const outputDir = this.generateProjectDocumentService.getOutputDir();
        const indexPath = path.join(outputDir, 'index.html');

        // 生成済みチェック
        if (fs.existsSync(indexPath)) {
            console.log('DocMate: ドキュメントは生成済みです。表示に進みます。');
        } else {
            // 未生成なら Gemini API で生成
            await this.generateProjectDocumentService.processProject();
        }

        // 新規タブで index.html を表示
        await this.openGeneratedDoc();
    }

    /**
     * 生成済みドキュメントの index.html を Webview パネルでブラウザ形式で表示する
     */
    async openGeneratedDoc(): Promise<void> {
        const outputDir = this.generateProjectDocumentService.getOutputDir();
        const indexPath = path.join(outputDir, 'index.html');

        if (!fs.existsSync(indexPath)) {
            throw new Error('ドキュメントが見つかりません。');
        }

        // Webview パネルを作成
        const panel = vscode.window.createWebviewPanel(
            'docmateProjectDoc',
            'DocMate: Project Document',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(outputDir)]
            }
        );

        // Webview 内のリンククリックをインターセプトするスクリプト
        const navScript = `
<script>
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
        // 「実行例を見る」リンクの処理
        const explainLink = e.target.closest('.explain-link');
        if (explainLink && explainLink.dataset.keyword) {
            e.preventDefault();
            vscode.postMessage({
                command: 'explain',
                keyword: explainLink.dataset.keyword,
                summary: explainLink.dataset.summary || '',
                examples: explainLink.dataset.examples || '[]'
            });
            return;
        }

        // 通常のリンク遷移
        const link = e.target.closest('a');
        if (link && link.getAttribute('href')) {
            const href = link.getAttribute('href');
            if (!href.startsWith('http://') && !href.startsWith('https://') && href !== '#') {
                e.preventDefault();
                vscode.postMessage({ command: 'navigate', url: href });
            }
        }
    });
</script>`;

        // HTML にナビゲーションスクリプトを注入するヘルパー
        const injectScript = (html: string): string => {
            return html.replace('</body>', `${navScript}</body>`);
        };

        // 現在表示中のパス（相対パス解決用）
        let currentDir = '';

        // 初期ページを表示
        panel.webview.html = injectScript(fs.readFileSync(indexPath, 'utf-8'));

        // リンククリック時に該当ページの HTML を Webview 内に表示する
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'navigate') {
                // 相対パスを解決（現在のディレクトリからの相対パスを考慮）
                const resolvedPath = path.resolve(outputDir, currentDir, message.url);
                if (fs.existsSync(resolvedPath)) {
                    // 遷移先の相対ディレクトリを更新
                    currentDir = path.relative(outputDir, path.dirname(resolvedPath));
                    const html = fs.readFileSync(resolvedPath, 'utf-8');
                    panel.webview.html = injectScript(html);
                    // タブタイトルを更新
                    panel.title = `DocMate: ${path.basename(resolvedPath, '.html')}`;
                }
            } else if (message.command === 'explain') {
                // 「実行例を見る」リンクの処理 → HTMLに埋め込まれたデータを直接使用（API不要）
                const keyword = message.keyword;
                const summary = message.summary || '';
                let examples = [];
                try {
                    examples = JSON.parse(message.examples || '[]');
                } catch (e) {
                    console.error('実行例データのパースに失敗:', e);
                }

                // 新しい Webview パネルで結果を表示
                const explainPanel = vscode.window.createWebviewPanel(
                    DocMateWebviewProvider.viewType,
                    `DocMate: ${keyword}`,
                    vscode.ViewColumn.Beside,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    }
                );
                const webviewProvider = new DocMateWebviewProvider(explainPanel, this.context.extensionUri, this.context);
                webviewProvider.update(summary, examples, '');

                // コード実行メッセージを処理
                explainPanel.webview.onDidReceiveMessage(async (msg) => {
                    if (msg.command === 'run') {
                        await this.runCode(msg.code, {
                            language: msg.language,
                            execCommand: msg.execCommand,
                            panel: explainPanel,
                        });
                    }
                });
            }
        });
    }

    /**
     * 生成済みドキュメントをユーザーが選択したフォルダにコピー（ダウンロード）する
     */
    async downloadProjectDocument(): Promise<void> {
        const sourceDir = this.generateProjectDocumentService.getOutputDir();

        // ドキュメントが未生成なら自動生成にフォールバック
        if (!fs.existsSync(sourceDir) || fs.readdirSync(sourceDir).length === 0) {
            const answer = await vscode.window.showInformationMessage(
                'ドキュメントがまだ生成されていません。生成してからダウンロードしますか？',
                'はい', 'キャンセル'
            );
            if (answer !== 'はい') {
                return;
            }
            // 生成フローを実行（生成 → HTML表示）
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'DocMate: プロジェクトドキュメント生成中...',
                cancellable: false
            }, async () => {
                await this.generateProjectDocumentService.processProject();
            });
            // 生成後 HTML を表示
            await this.openGeneratedDoc();
        }

        // ユーザーに保存先フォルダを選択させる
        const selected = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'ここに保存',
            title: 'ドキュメントの保存先を選択'
        });

        if (!selected || selected.length === 0) {
            return; // キャンセル
        }

        const destDir = path.join(selected[0].fsPath, '.docs');
        this.copyDirSync(sourceDir, destDir);

        const openAction = await vscode.window.showInformationMessage(
            `ドキュメントを ${destDir} に保存しました！`,
            'フォルダを開く'
        );
        if (openAction === 'フォルダを開く') {
            vscode.env.openExternal(vscode.Uri.file(destDir));
        }
    }

    /**
     * ディレクトリを再帰的にコピーする
     */
    private copyDirSync(src: string, dest: string): void {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                this.copyDirSync(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
}

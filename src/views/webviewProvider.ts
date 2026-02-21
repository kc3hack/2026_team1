
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { marked } from 'marked';

interface ExampleData {
    title: string;
    description: string;
    code: string;
    executionOutput: string;
}

export class DocMateWebviewProvider {
    public static readonly viewType = 'docMateResult';

    private readonly mediaPath = "media";

    constructor(
        private readonly panel: vscode.WebviewPanel,
        private extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext
    ) { }

    // ── 公開メソッド ────────────────────────────────────────────

    public update(summary: string, examples: ExampleData[], url: string): void {
        this.panel.webview.html = this.buildHtml(summary, examples, url);
    }

    // ── HTML 組み立て ────────────────────────────────────────────

    private buildHtml(summary: string, examples: ExampleData[], url: string): string {
        const nonce = this.generateNonce();
        const scriptUri = this.webviewUri('sandbox_init.js');
        const styleUri = this.webviewUri('styles.css');
        const langConfig = this.loadJson('langConfig.json');

        const summaryHtml = marked.parse(summary) as string;
        const examplesHtml = examples
            .map((ex, i) => this.buildCellHtml(ex, i))
            .join('\n');

        const baseHtml = this.readTemplate('webview.html');

        return baseHtml
            .replace(/{{CSP_SOURCE}}/g, this.panel.webview.cspSource)
            .replace(/{{NONCE}}/g, nonce)
            .replace('{{STYLE_URI}}', styleUri)
            .replace('{{SCRIPT_URI}}', scriptUri)
            .replace('{{LANG_CONFIG}}', JSON.stringify(langConfig))
            .replace('{{SUMMARY_HTML}}', summaryHtml)
            .replace('{{DOC_URL}}', this.escapeAttr(url))
            .replace('{{EXAMPLES_HTML}}', examplesHtml);
    }

    private buildCellHtml(example: ExampleData, index: number): string {
        const cellTemplate = this.readTemplate('cell.html');

        // encodeURIComponent でエスケープ（sandbox_init.js 側で decodeURIComponent して使う）
        const encodedCode = encodeURIComponent(example.code);

        return cellTemplate
            .replace(/{{INDEX}}/g, String(index))
            .replace('{{TITLE}}', this.escapeHtml(example.title))
            .replace('{{DESCRIPTION}}', this.escapeHtml(example.description))
            .replace('{{ENCODED_CODE}}', encodedCode);
    }

    // ── ユーティリティ ───────────────────────────────────────────

    /** media/ 配下のテンプレートファイルを文字列で読み込む */
    private readTemplate(filename: string): string {
        const filePath = path.join(this.context.extensionPath, this.mediaPath, filename);
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            console.error(`DocMateWebviewProvider: テンプレートの読み込みに失敗しました: ${filePath}`, e);
            return '';
        }
    }

    /** media/ 配下の JSON ファイルをオブジェクトとして読み込む */
    private loadJson(filename: string): unknown {
        const filePath = path.join(this.context.extensionPath, this.mediaPath, filename);
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.warn(`DocMateWebviewProvider: JSON の読み込みに失敗しました: ${filePath}`, e);
            return {};
        }
    }

    /** Webview URI を文字列で返す */
    private webviewUri(filename: string): string {
        return this.panel.webview
            .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, this.mediaPath, filename))
            .toString();
    }

    /** HTML 属性値用エスケープ（URL など） */
    private escapeAttr(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** HTML テキストノード用エスケープ */
    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** CSP nonce 生成 */
    private generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return Array.from({ length: 32 }, () =>
            chars.charAt(Math.floor(Math.random() * chars.length))
        ).join('');
    }
}

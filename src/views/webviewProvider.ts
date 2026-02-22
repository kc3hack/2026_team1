
import * as vscode from 'vscode';
import { marked } from 'marked';
import * as path from "path";
import * as fs from "fs";


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

    public update(summary: string, examples: ExampleData[], url: string, language: string) {
        this.panel.webview.html = this.getHtmlForWebview(summary, examples, url, language);
    }


    private getNonce(): string {
        let text = "";
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private getHtmlForWebview(summary: string, examples: ExampleData[], url: string, language: string): string {
        const summaryHtml = marked.parse(summary);

        const examplesHtml = examples.map((ex, index) => this.generateCellHtml(ex, index)).join('');

        const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, this.mediaPath, "sandbox_init.js"));
        const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, this.mediaPath, "styles.css"));
        const nonce = this.getNonce();
        // const baseUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media"));

        // langConfig.json を読み込み、window.LANG_CONFIG として埋め込む
        const configPath = path.join(this.context.extensionPath, this.mediaPath, "langConfig.json");
        let langConfigObj: any = {};
        try {
            const txt = fs.readFileSync(configPath, "utf8");
            langConfigObj = JSON.parse(txt);
        } catch (e) {
            // 読み込み失敗しても空オブジェクトで継続
            langConfigObj = {};
            console.warn("DocMateWebviewProvider: langConfig.json の読み込みに失敗しました。", e);
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DocMate Explanation</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        h1, h2, h3 { color: var(--vscode-textLink-foreground); }
        a { color: var(--vscode-textLink-foreground); }
        .section { margin-bottom: 20px; }
        
        /* Cell Style */
        .cell { margin-bottom: 20px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; overflow: hidden; }
        .cell-header { background-color: var(--vscode-editor-inactiveSelectionBackground); padding: 5px 10px; font-weight: bold; display: flex; justifies-content: space-between; align-items: center; }
        .cell-desc { font-size: 0.9em; margin-left: 10px; color: var(--vscode-descriptionForeground); font-weight: normal; }
        
        .code-area { display: flex; flex-direction: column; background-color: var(--vscode-editor-background); padding: 10px; }
        textarea.code-editor { 
            width: 100%; height: 150px; 
            background-color: var(--vscode-input-background); 
            color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border); 
            font-family: var(--vscode-editor-font-family); 
            padding: 5px; 
            resize: vertical; 
        }
        
        .controls { margin-top: 5px; display: flex; justify-content: flex-start; }
        button.run-btn { 
            background-color: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
            border: none; padding: 5px 10px; cursor: pointer; 
            display: flex; align-items: center; gap: 5px;
        }
        button.run-btn:hover { background-color: var(--vscode-button-hoverBackground); }
        
        /* Output Area */
        .output-area { 
            background-color: var(--vscode-textBlockQuote-background); 
            border-top: 1px solid var(--vscode-widget-border);
        }
        .output-header {
            padding: 5px 10px; cursor: pointer; user-select: none;
            font-size: 0.8em; color: var(--vscode-descriptionForeground);
            display: flex; align-items: center; gap: 5px;
        }
        .output-header:hover { background-color: var(--vscode-list-hoverBackground); }
        .output-content { 
            padding: 10px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); 
            display: none; /* Collapsed by default */
            max-height: 300px; overflow-y: auto;
        }
        .output-content.open { display: block; }
        
        .loading { display: inline-block; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
    <link rel="stylesheet" href="${styleUri}">
    <script nonce="${nonce}">
        window.LANG_CONFIG = ${JSON.stringify(langConfigObj)};
        window.CURRENT_LANG = "${language}";
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>

</head>
<body>
    <div class="section">
        <h2>要約 (Summary)</h2>
        <div>${summaryHtml}</div>
        <p><a href="${url}">Original Documentation</a></p>
    </div>
    
    <div class="section">
        <h2>サンプルコード (Interactive Examples)</h2>
        ${examplesHtml}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function toggleOutput(index) {
            const content = document.getElementById('output-content-' + index);
            const icon = document.getElementById('toggle-icon-' + index);
            content.classList.toggle('open');
            icon.textContent = content.classList.contains('open') ? '▼' : '▶';
        }

        function runCode(index) {
            const textarea = document.getElementById('code-' + index);
            const code = textarea.value;
            const outputContent = document.getElementById('output-content-' + index);
            const runBtn = document.getElementById('run-btn-' + index);
            
            // Show loading
            runBtn.disabled = true;
            runBtn.innerHTML = '<span class="loading">↻</span> Running...';
            
            // Auto open output
            if (!outputContent.classList.contains('open')) {
                toggleOutput(index);
            }
            outputContent.textContent = "Executing...";

            vscode.postMessage({
                command: 'run',
                index: index,
                code: code
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'result') {
                const index = message.index;
                const output = message.output;
                
                const outputContent = document.getElementById('output-content-' + index);
                outputContent.textContent = output;
                
                const runBtn = document.getElementById('run-btn-' + index);
                runBtn.disabled = false;
                runBtn.textContent = '▶ Run';
            }
        });
    </script>

</body>
</html>`;
    }

    private generateCellHtml(example: ExampleData, index: number): string {
        // サンプル毎に sandbox 用の root を作る。id に index を含める。
        // また、initial code を data-* 属性で埋めて、sandbox_init.js 側で拾えるようにする。
        const escapedCode = example.code.replace(/<\/script/g, '<\\/script').replace(/</g, '&lt;');

        // AIが不正なUnicode（サロゲートペアの片割れなど）を出力した場合、encodeURIComponentが "URI malformed" でクラッシュするため安全にエンコードする
        let encodedCode = '';
        try {
            encodedCode = encodeURIComponent(escapedCode);
        } catch (e) {
            console.warn(`[Webview] URI malformed in example code (${example.title}), attempting fallback encode...`, e);
            // 不正なUnicode文字を取り除いてから再度エンコードする
            const sanitizedCode = escapedCode.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
            encodedCode = encodeURIComponent(sanitizedCode);
        }

        return `
        <div class="example-cell" id="example-cell-${index}">
        <div class="example-header">
            <strong>${example.title}</strong>
            <div class="description">${example.description}</div>
        </div>

        <!-- Sandbox の埋め込み先 -->
        <div id="sandbox-root-${index}" class="sandbox-embed" data-initial-code="${encodeURIComponent(escapedCode)}" data-index="${index}" data-execution-output="${encodeURIComponent(example.executionOutput || '')}"></div>

        <!-- place for output fallback if needed -->
        <div id="sandbox-output-${index}" class="sandbox-output-fallback"></div>
        </div>
    `;
    }
}

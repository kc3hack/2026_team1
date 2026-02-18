
import * as vscode from 'vscode';
import { marked } from 'marked';

interface ExampleData {
    title: string;
    description: string;
    code: string;
    executionOutput: string;
}

export class DocMateWebviewProvider {
    public static readonly viewType = 'docMateResult';

    constructor(
        private readonly panel: vscode.WebviewPanel
    ) { }

    public update(summary: string, examples: ExampleData[], url: string) {
        this.panel.webview.html = this.getHtmlForWebview(summary, examples, url);
    }

    private getHtmlForWebview(summary: string, examples: ExampleData[], url: string): string {
        const summaryHtml = marked.parse(summary);

        const examplesHtml = examples.map((ex, index) => this.generateCellHtml(ex, index)).join('');

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
</head>
<body>
    <div class="section">
        <h2>要約 (Summary)</h2>
        <div>${summaryHtml}</div>
        <p><a href="${url}">Original Documentation (MDN)</a></p>
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
        // Initial state: if there is output, maybe open it? Or keep collapsed?
        // User requested toggle. Let's keep collapsed by default unless user runs it.
        // Actually, for the initial load, let's keep it collapsed to save space, 
        // OR open it if there is content? 
        // User said: "Colabみたいに実行結果はtoggleで閉じれるようにできれば見やすさも向上する".
        // Implies it might be open or closed, but closable.
        // Let's default to CLOSED (Collapsed) for cleaner view, user can open.
        // But wait, user wants to see results? 
        // Let's make it OPEN by default if it has content, but toggleable.
        // Actually, user said "unnecessary stuff exists so collapse it".
        // So default COLLAPSED (Closed) is safer.

        return `
        <div class="cell">
            <div class="cell-header">
                <span>${example.title}</span>
                <span class="cell-desc">${example.description}</span>
            </div>
            <div class="code-area">
                <textarea id="code-${index}" class="code-editor">${example.code}</textarea>
                <div class="controls">
                    <button id="run-btn-${index}" class="run-btn" onclick="runCode(${index})">▶ Run</button>
                </div>
            </div>
            <div class="output-area">
                <div class="output-header" onclick="toggleOutput(${index})">
                    <span id="toggle-icon-${index}">▶</span> Execution Output
                </div>
                <div id="output-content-${index}" class="output-content">
${example.executionOutput}
                </div>
            </div>
        </div>
        `;
    }
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class StructureController {
    public async visualize() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('ワークスペースが開かれていません。');
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        // ルートディレクトリ名を取得してツリー生成を開始
        const treeString = this.generateTree(rootPath, '', true, true);

        // 新しいタブ(Markdown形式)で結果を表示
        const document = await vscode.workspace.openTextDocument({
            content: `# File Structure\n\n\`\`\`\n${treeString}\`\`\``,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(document);
    }

    private generateTree(dirPath: string, prefix: string, isLast: boolean, isRoot: boolean = false): string {
        const dirName = path.basename(dirPath);
        let result = isRoot ? `${dirName}\n` : `${prefix}${isLast ? '└── ' : '├── '}${dirName}\n`;

        try {
            const files = fs.readdirSync(dirPath);
            // 無視するディレクトリを指定。型注釈 (file: string) を追加
            const filteredFiles = files.filter((file: string) => !['node_modules', '.git', 'out', 'dist'].includes(file));

            // 型注釈 (file: string, index: number) を追加
            filteredFiles.forEach((file: string, index: number) => {
                const fullPath = path.join(dirPath, file);
                const isLastItem = index === filteredFiles.length - 1;
                const newPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

                if (fs.statSync(fullPath).isDirectory()) {
                    result += this.generateTree(fullPath, newPrefix, isLastItem);
                } else {
                    result += `${newPrefix}${isLastItem ? '└── ' : '├── '}${file}\n`;
                }
            });
        } catch (e) {
            // 権限エラー等はスキップ
        }

        return result;
    }
}
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class FileExplainController {
    public async explainFile(targetUri: vscode.Uri, progress: vscode.Progress<{ message?: string; increment?: number }>) {
        const config = vscode.workspace.getConfiguration('docmate');
        const apiKey = config.get<string>('apiKey');
        const modelName = config.get<string>('model') || 'gemini-2.5-flash';

        if (!apiKey) {
            throw new Error('Gemini API Keyが設定されていません。VS Codeの設定から docmate.apiKey を入力してください。');
        }

        const targetPath = targetUri.fsPath;

        if (!fs.existsSync(targetPath)) {
            throw new Error(`ファイルが見つかりません。保存されていないファイルは分析できません。`);
        }

        const stat = fs.statSync(targetPath);
        const isDirectory = stat.isDirectory();
        const targetName = path.basename(targetPath);

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });

        let prompt = '';

        if (isDirectory) {
            progress.report({ message: 'フォルダ内の構造を読み取り中...' });
            const allFilesData = this.readDirectory(targetPath);

            if (!allFilesData.trim()) {
                throw new Error('フォルダの中に読み取れるテキストファイルがありませんでした。');
            }

            // ★変更点：依存関係を削り、「役割」と「全体像」にフォーカスしたプロンプト
            prompt = `あなたは優秀なソフトウェアアーキテクトです。以下のフォルダ「${targetName}」内のコードを読み込み、プログラミング初心者にもわかりやすく日本語で解説してください。
1. **このフォルダの目的**: プロジェクト全体において、このフォルダがどのような役割（UI層、データ処理、ユーティリティなど）を担っているか。
2. **主要ファイルの役割**: フォルダ内にある各ファイルが、それぞれどんな処理を行っているか簡潔に。

【フォルダ内のコード】
${allFilesData}`;
        } else {
            progress.report({ message: 'ファイルを読み取り中...' });
            const fileContent = fs.readFileSync(targetPath, 'utf8');
            const safeContent = fileContent.length > 5000 ? fileContent.substring(0, 5000) + '\n...（以降省略）' : fileContent;
            prompt = `あなたは優秀なエンジニアです。以下のファイル「${targetName}」のコードを読み込み、このファイルがプロジェクト全体でどのような役割を持っているか、中で何をしているかを、プログラミング初心者にもわかりやすく日本語で簡潔に解説してください。\n\n【コード】\n\`\`\`\n${safeContent}\n\`\`\``;
        }

        progress.report({ message: 'AIが構造を分析中...' });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    private readDirectory(dirPath: string, basePath: string = ''): string {
        let result = '';
        try {
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                if (['node_modules', '.git', 'out', 'dist', 'build', '.vscode', 'package-lock.json'].includes(item)) continue;

                const fullPath = path.join(dirPath, item);
                const relPath = path.join(basePath, item);
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    result += this.readDirectory(fullPath, relPath);
                } else if (stat.isFile()) {
                    if (!item.match(/\.(jpg|jpeg|png|gif|ico|svg|mp4|mp3|zip|pdf|exe|dll|ttf|woff)$/i)) {
                        try {
                            const content = fs.readFileSync(fullPath, 'utf8');
                            const safeContent = content.length > 2000 ? content.substring(0, 2000) + '\n...（省略）' : content;
                            result += `\n\n--- ファイル: ${relPath} ---\n\`\`\`\n${safeContent}\n\`\`\``;
                        } catch (e) { }
                    }
                }
            }
        } catch (error) { }
        return result;
    }
}
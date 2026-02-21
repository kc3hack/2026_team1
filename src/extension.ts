import * as vscode from 'vscode';
import { DocMateController } from './controllers/docMateController';
import { DocMateWebviewProvider } from './views/webviewProvider';
import { FileExplainController } from './controllers/fileExplainController';

export function activate(context: vscode.ExtensionContext) {
	console.log('DocMate is activating...');

	// 新機能：フォルダ/ファイル解説
	try {
		const fileExplainController = new FileExplainController();
		let fileExplainDisposable = vscode.commands.registerCommand('docmate.explainFile', async (uri?: vscode.Uri) => {
			const targetUri = uri || vscode.window.activeTextEditor?.document.uri;

			if (!targetUri) {
				vscode.window.showErrorMessage('対象が見つかりません。エクスプローラーから右クリックしてください。');
				return;
			}

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `DocMate: 構造と依存関係を分析中...`,
				cancellable: false
			}, async (progress) => {
				try {
					const explanation = await fileExplainController.explainFile(targetUri, progress);
					const targetName = targetUri.fsPath.split(/[\\/]/).pop();

					const document = await vscode.workspace.openTextDocument({
						content: `# ${targetName} の構造と依存関係\n\n${explanation}`,
						language: 'markdown'
					});
					await vscode.window.showTextDocument(document);
				} catch (error) {
					vscode.window.showErrorMessage(`DocMate Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
		});
		context.subscriptions.push(fileExplainDisposable);
	} catch (error) {
		console.error('File Explain Command Error:', error);
	}

	// 既存のExplainコマンド
	try {
		const controller = new DocMateController();
		let disposable = vscode.commands.registerCommand('docmate.explain', async () => {
			const editor = vscode.window.activeTextEditor;
			let keyword = '';

			if (editor) {
				const selection = editor.selection;
				keyword = editor.document.getText(selection).trim();
			}

			if (!keyword) {
				keyword = await vscode.window.showInputBox({
					prompt: 'Enter a keyword to explain (e.g. Array.map)',
					placeHolder: 'Array.map'
				}) || '';
			}

			if (!keyword) {
				return;
			}

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `DocMate: Explaining "${keyword}"`,
				cancellable: false
			}, async (progress) => {
				try {
					const result = await controller.explain(keyword, progress);
					const panel = vscode.window.createWebviewPanel(
						DocMateWebviewProvider.viewType,
						`DocMate: ${keyword}`,
						vscode.ViewColumn.Beside,
						{
							enableScripts: true,
							retainContextWhenHidden: true
						}
					);

					const webviewProvider = new DocMateWebviewProvider(panel);
					webviewProvider.update(result.summary, result.examples, result.url);

					panel.webview.onDidReceiveMessage(
						async (message) => {
							switch (message.command) {
								case 'run':
									const output = await controller.runCode(message.code);
									panel.webview.postMessage({
										command: 'result',
										index: message.index,
										output: output
									});
									break;
							}
						},
						undefined,
						context.subscriptions
					);

				} catch (error) {
					vscode.window.showErrorMessage(`DocMate Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
		});
		context.subscriptions.push(disposable);
	} catch (error) {
		console.error('Explain Command Registration Error:', error);
	}
}

export function deactivate() { }
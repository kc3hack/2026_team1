import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { DocMateController } from './controllers/docMateController';
import { DocMateWebviewProvider } from './views/webviewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('DocMate is now active!');

// 	const controller = new DocMateController(context.extensionPath);
// =======
	dotenv.config({
		path: path.join(context.extensionPath, '.env'),
	});
	const controller = new DocMateController(context);

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

		// Create Webview Panel immediately to show loading state or just wait?
		// Better to show progress notification, then open webview with result.

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `DocMate: Explaining "${keyword}"`,
			cancellable: false
		}, async (progress) => {
			try {
				const result = await controller.explain(keyword, progress);
				// Open Webview
				const panel = vscode.window.createWebviewPanel(
					DocMateWebviewProvider.viewType,
					`DocMate: ${keyword}`,
					vscode.ViewColumn.Beside,
					{
						enableScripts: true,
						retainContextWhenHidden: true // Keep state when switching tabs
					}
				);

				const webviewProvider = new DocMateWebviewProvider(panel, context.extensionUri, context);
				webviewProvider.update(result.summary, result.examples, result.url);

				// Handle messages from Webview
				panel.webview.onDidReceiveMessage(
					async (message) => {
						if (message.command === 'run') {
							// sandbox_init.js が送る payload:
							//   { command, language, code, execCommand, index }
							await controller.runCode(message.code, {
								language: message.language,
								execCommand: message.execCommand,
								panel,
							});
							// ストリーム結果は runCommand 内で panel へ直接送信済み。
							// 完了通知が必要な場合はここで追加送信できる。
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
}

export function deactivate() { }

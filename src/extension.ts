
import * as vscode from 'vscode';
import { DocMateController } from './controllers/docMateController';
import { DocMateWebviewProvider } from './views/webviewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('DocMate is now active!');

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

				const webviewProvider = new DocMateWebviewProvider(panel);
				webviewProvider.update(result.summary, result.examples, result.url);

				// Handle messages from Webview
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
}

export function deactivate() { }

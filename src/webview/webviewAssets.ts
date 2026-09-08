/**
 * URI, CSP и HTML-оболочка webview с VSCode Elements и Codicons.
 */

import * as vscode from 'vscode';

let extensionUri: vscode.Uri | undefined;

/**
 * Сохраняет URI расширения. Вызывать из activate.
 */
export function initWebviewAssets(context: vscode.ExtensionContext): void {
	extensionUri = context.extensionUri;
}

function requireExtensionUri(): vscode.Uri {
	if (!extensionUri) {
		throw new Error('initWebviewAssets не вызван из activate');
	}
	return extensionUri;
}

/**
 * Опции WebviewPanel с доступом к media/webview.
 */
export function getWebviewPanelOptions(
	retainContextWhenHidden = false,
): vscode.WebviewPanelOptions & vscode.WebviewOptions {
	return {
		enableScripts: true,
		retainContextWhenHidden,
		localResourceRoots: [vscode.Uri.joinPath(requireExtensionUri(), 'media', 'webview')],
	};
}

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * Оборачивает тело страницы: CSP, Codicons, bundled.js, общий CSS.
 * @param extraScript — инлайн-скрипт панели без тега script
 */
export function wrapWebviewHtml(
	webview: vscode.Webview,
	body: string,
	extraStyle = '',
	extraScript = '',
): string {
	const ext = requireExtensionUri();
	const nonce = getNonce();
	const media = vscode.Uri.joinPath(ext, 'media', 'webview');
	const bundledUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'bundled.js'));
	const codiconCss = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
	const codiconFont = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.ttf'));
	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource} data:`,
		`script-src ${webview.cspSource} 'nonce-${nonce}'`,
	].join('; ');

	const scriptBlock = extraScript ? `<script nonce="${nonce}">${extraScript}</script>` : '';

	return `<!DOCTYPE html>
<html lang="ru">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<link rel="stylesheet" href="${codiconCss}" id="vscode-codicon-stylesheet">
	<style>
		@font-face {
			font-family: 'codicon';
			font-display: block;
			src: url('${codiconFont}') format('truetype');
		}
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px; color: var(--vscode-foreground); background-color: var(--vscode-editor-background); }
		h2, h3 { margin: 12px 0 6px 0; font-size: var(--vscode-font-size); font-weight: 600; color: var(--vscode-foreground); }
		.count { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
		.error { color: var(--vscode-errorForeground); margin-top: 12px; }
		.hint { color: var(--vscode-descriptionForeground); margin-top: 12px; }
		.toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; align-items: center; }
		.input-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
		vscode-textfield { flex: 1; }
		.status { font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 1.2em; margin-top: 8px; }
		.status.err { color: var(--vscode-errorForeground); }
		vscode-table { width: 100%; margin-bottom: 8px; }
		vscode-table-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		${extraStyle}
	</style>
</head>
<body>
	${body}
	<script type="module" src="${bundledUri}" nonce="${nonce}"></script>
	${scriptBlock}
</body>
</html>`;
}

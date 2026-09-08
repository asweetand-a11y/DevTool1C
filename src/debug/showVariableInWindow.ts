/**
 * Команда «Показать значение в отдельном окне» для коллекций в панели переменных отладчика.
 * Открывает WebviewPanel с табличным представлением элементов коллекции (структуры, массивы, таблицы значений и т.д.).
 */

import * as vscode from 'vscode';
import {
	buildDebugTree,
	debugTreeChildrenToHtml,
	escapeHtml,
	vscodeTableHtml,
	wrapVscodeTreeHtml,
} from '../webview/debugTree';
import { getWebviewPanelOptions, wrapWebviewHtml } from '../webview/webviewAssets';

interface DebugVariable {
	name: string;
	value: string;
	type?: string;
	variablesReference?: number;
	evaluateName?: string;
}

interface DebugVariableContainer {
	name?: string;
	variablesReference?: number;
}

/** Макс. глубина — защита от иных рекурсивных структур. */
const FETCH_VARIABLE_TREE_MAX_DEPTH = 12;

/** Рекурсивно получает дочерние переменные. Цепочки .Ссылка.Ссылка, .Родитель.Родитель — не шлём повторный запрос. */
async function fetchVariableTree(
	session: vscode.DebugSession,
	variablesReference: number,
	prefix: string,
	depth = 0,
): Promise<Array<{ name: string; value: string; type: string; path: string }>> {
	const result = await session.customRequest('variables', { variablesReference });
	const vars = (result as { variables?: DebugVariable[] }).variables ?? [];
	const rows: Array<{ name: string; value: string; type: string; path: string }> = [];
	const atMaxDepth = depth >= FETCH_VARIABLE_TREE_MAX_DEPTH;
	for (const v of vars) {
		const path = prefix ? `${prefix}.${v.name}` : v.name;
		const displayValue = atMaxDepth && v.variablesReference ? `${v.value} …` : v.value;
		rows.push({ name: v.name, value: displayValue, type: v.type ?? '', path });
		const lastSegment = prefix.split('.').pop() ?? '';
		const isStructuralRecursion = lastSegment !== '' && lastSegment === v.name;
		if (v.variablesReference && v.variablesReference > 0 && !isStructuralRecursion && !atMaxDepth) {
			const nested = await fetchVariableTree(session, v.variablesReference, path, depth + 1);
			rows.push(...nested);
		}
	}
	return rows;
}

/** Преобразует collectionRows в плоский список строк (fallback для buildHtml). */
function collectionRowsToTableRows(
	prefix: string,
	collectionRows: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }>,
): Array<{ name: string; value: string; type: string; path: string }> {
	const rows: Array<{ name: string; value: string; type: string; path: string }> = [];
	for (const row of collectionRows) {
		for (const cell of row.cells) {
			rows.push({
				name: cell.name,
				value: cell.value,
				type: cell.typeName ?? '',
				path: `${prefix}[${row.index}].${cell.name}`,
			});
		}
	}
	return rows;
}

function pageShell(webview: vscode.Webview, title: string, typeName: string, count: number, inner: string): string {
	const body = `
	<h2>${escapeHtml(title)}</h2>
	<div class="count">Количество элементов: ${count}${typeName ? ` | Тип: ${escapeHtml(typeName)}` : ''}</div>
	${inner}`;
	return wrapWebviewHtml(webview, body);
}

/** Строит HTML для табличного представления коллекции (колонки как заголовки). */
function buildCollectionHtml(
	webview: vscode.Webview,
	title: string,
	typeName: string,
	collectionRows: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }>,
): string {
	const columns = collectionRows[0]?.cells.map((c) => c.name) ?? [];
	const headers = ['Индекс', ...columns];
	const dataRows = collectionRows.map((r) => [String(r.index), ...r.cells.map((c) => c.value)]);
	return pageShell(webview, title, typeName, collectionRows.length, vscodeTableHtml(headers, dataRows));
}

function buildHtml(
	webview: vscode.Webview,
	title: string,
	typeName: string,
	rows: Array<{ name: string; value: string; type: string; path: string }>,
): string {
	const hasHierarchy = rows.some((r) => r.path.includes('.'));
	if (!hasHierarchy || rows.length <= 1) {
		const dataRows = rows.map((r) => [r.path, r.value, r.type]);
		return pageShell(webview, title, typeName, rows.length, vscodeTableHtml(['Имя / Путь', 'Значение', 'Тип'], dataRows));
	}

	const treeRows = rows.map((r) => ({ name: r.path, value: r.value, type: r.type }));
	const tree = buildDebugTree(treeRows, title);
	const innerItems =
		tree.children.length > 0
			? debugTreeChildrenToHtml(tree.children)
			: `<vscode-tree-item>${escapeHtml(title)}<span slot="decoration">(пусто)</span></vscode-tree-item>`;
	return pageShell(webview, title, typeName, rows.length, wrapVscodeTreeHtml(innerItems));
}

/** Открывает окно с содержимым переменной. Вызов из панели переменных (context.variable) или из редактора (выделенный текст). */
export async function showVariableInWindow(
	context: { variable: DebugVariable; container: DebugVariableContainer } | undefined,
): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'onec') {
		vscode.window.showWarningMessage('Нет активной сессии отладки 1С');
		return;
	}

	let expression: string;
	const variable = context?.variable;
	if (variable) {
		expression = variable.evaluateName ?? variable.name;
	} else {
		const editor = vscode.window.activeTextEditor;
		const selection = editor?.selection;
		const text = selection && !selection.isEmpty
			? editor.document.getText(selection)
			: editor?.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active));
		if (!text?.trim()) {
			vscode.window.showWarningMessage('Выделите имя переменной в редакторе или выберите переменную в панели переменных');
			return;
		}
		expression = text.trim();
	}
	if (!expression) {
		vscode.window.showWarningMessage('Не удалось определить выражение переменной');
		return;
	}

	try {
		const threads = await session.customRequest('threads');
		const threadList = (threads as { threads?: Array<{ id: number }> }).threads ?? [];
		const threadId = threadList[0]?.id ?? 1;

		const stack = await session.customRequest('stackTrace', { threadId });
		const frames = (stack as { stackFrames?: Array<{ id: number }> }).stackFrames ?? [];
		const frameId = frames[0]?.id ?? 0;

		const isCollectionType = (t: string) =>
			/ТаблицаЗначений|Массив|Структура|Соответствие|СписокЗначений|Коллекция|МенеджерВременныхТаблиц|ВременныеТаблицыЗапроса/i.test(t ?? '');
		let typeName = variable?.type ?? '';
		let collectionData: { collectionRows?: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }> } | null = null;

		if (!typeName && !variable) {
			try {
				const prelim = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
				typeName = (prelim as { type?: string }).type ?? '';
			} catch {
				// игнорируем
			}
		}
		if (isCollectionType(typeName)) {
			const useEnum = /Структура|Соответствие/i.test(typeName);
			const collExpr = /МенеджерВременныхТаблиц/i.test(typeName) && !/\.Таблицы\b/.test(expression)
				? `${expression}.Таблицы`
				: expression;
			try {
				const collRes = await session.customRequest('1c/evaluateCollection', {
					expression: collExpr,
					frameId,
					interfaceType: useEnum ? 'enum' : 'collection',
				});
				const body = (collRes as { typeName?: string; collectionRows?: unknown[] }) ?? {};
				if (Array.isArray(body.collectionRows) && body.collectionRows.length > 0) {
					collectionData = { collectionRows: body.collectionRows as Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }> };
					typeName = body.typeName ?? typeName;
				}
			} catch {
				// fallback к evaluate + variables
			}
		}

		let rows: Array<{ name: string; value: string; type: string; path: string }>;
		if (collectionData?.collectionRows && collectionData.collectionRows.length > 0) {
			rows = collectionRowsToTableRows(expression, collectionData.collectionRows);
		} else {
			const evalResult = await session.customRequest('evaluate', {
				expression,
				frameId,
				context: 'repl',
			});
			const res = evalResult as { result?: string; variablesReference?: number; type?: string };
			typeName = res.type ?? typeName;
			if (res.variablesReference && res.variablesReference > 0) {
				rows = await fetchVariableTree(session, res.variablesReference, expression);
			} else {
				rows = [{ name: expression, value: res.result ?? variable?.value ?? '', type: typeName, path: expression }];
			}
		}

		const panel = vscode.window.createWebviewPanel(
			'1cVariableWindow',
			`${expression} (${typeName || 'значение'})`,
			vscode.ViewColumn.Beside,
			getWebviewPanelOptions(),
		);

		panel.webview.html = collectionData?.collectionRows
			? buildCollectionHtml(panel.webview, expression, typeName, collectionData.collectionRows)
			: buildHtml(panel.webview, expression, typeName, rows);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Ошибка получения значения: ${msg}`);
	}
}

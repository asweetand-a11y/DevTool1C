/**
 * Панель «Выражение» — вычисление произвольных выражений в контексте отладки.
 * Ввод выражения, кнопка «Рассчитать», вывод результата (Свойство, Значение, Тип).
 */

import * as vscode from 'vscode';
import { buildDebugTree, escapeHtml, type DebugTreeNode } from '../webview/debugTree';
import { getWebviewPanelOptions, wrapWebviewHtml } from '../webview/webviewAssets';

interface DebugVariable {
	name: string;
	value: string;
	type?: string;
	variablesReference?: number;
}

/** Макс. глубина рекурсии при получении дочерних переменных. */
const FETCH_VARIABLE_TREE_MAX_DEPTH = 12;

/** Триггер рекурсии: последний сегмент пути совпадает с именем дочернего узла. */
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

const isCollectionType = (t: string) =>
	/ТаблицаЗначений|Массив|Структура|Соответствие|СписокЗначений|Коллекция|МенеджерВременныхТаблиц|ВременныеТаблицыЗапроса/i.test(
		t ?? '',
	);

/** Вычисляет выражение и возвращает строки для таблицы (путь, значение, тип). */
async function evaluateExpression(
	session: vscode.DebugSession,
	expression: string,
): Promise<Array<{ name: string; value: string; type: string }>> {
	const threads = await session.customRequest('threads');
	const threadList = (threads as { threads?: Array<{ id: number }> }).threads ?? [];
	const threadId = threadList[0]?.id ?? 1;
	const stack = await session.customRequest('stackTrace', { threadId });
	const frames = (stack as { stackFrames?: Array<{ id: number }> }).stackFrames ?? [];
	const frameId = frames[0]?.id ?? 0;

	const evalResult = await session.customRequest('evaluate', {
		expression,
		frameId,
		context: 'repl',
	});
	const res = evalResult as { result?: string; variablesReference?: number; type?: string };
	const typeName = res.type ?? '';

	if (isCollectionType(typeName)) {
		const useEnum = /Структура|Соответствие/i.test(typeName);
		const collExpr =
			/МенеджерВременныхТаблиц/i.test(typeName) && !/\.Таблицы\b/.test(expression)
				? `${expression}.Таблицы`
				: expression;
		try {
			const collRes = await session.customRequest('1c/evaluateCollection', {
				expression: collExpr,
				frameId,
				interfaceType: useEnum ? 'enum' : 'collection',
			});
			const body = (collRes as { collectionRows?: Array<{ index: number; cells: Array<{ name: string; value: string; typeName?: string }> }> }) ?? {};
			if (Array.isArray(body.collectionRows) && body.collectionRows.length > 0) {
				const rows: Array<{ name: string; value: string; type: string }> = [];
				for (const row of body.collectionRows) {
					const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
					rows.push({
						name: `[${row.index}]`,
						value: summary,
						type: 'СтрокаТаблицыЗначений',
					});
				}
				return rows;
			}
		} catch {
			// fallback — используем variablesReference ниже
		}
	}

	if (res.variablesReference && res.variablesReference > 0) {
		const rows = await fetchVariableTree(session, res.variablesReference, expression);
		return rows.map((r) => ({ name: r.path, value: r.value, type: r.type }));
	}

	return [{ name: expression, value: res.result ?? '', type: typeName }];
}

function buildResultPayload(
	rows: Array<{ name: string; value: string; type: string }>,
	expression: string,
): { kind: 'table'; count: number; rows: Array<{ name: string; value: string; type: string }> } | { kind: 'tree'; count: number; nodes: DebugTreeNode[] } {
	const hasHierarchy = rows.some((r) => r.name.includes('.'));
	if (!hasHierarchy || rows.length <= 1) {
		return { kind: 'table', count: rows.length, rows };
	}
	const tree = buildDebugTree(rows, expression);
	return { kind: 'tree', count: rows.length, nodes: tree.children };
}

function getPanelHtml(webview: vscode.Webview, expression: string): string {
	const body = `
	<h2>Рассчитать значение</h2>
	<div class="input-row">
		<vscode-label for="expr">Выражение:</vscode-label>
		<vscode-textfield id="expr" value="${escapeHtml(expression)}"></vscode-textfield>
		<vscode-button id="calc">Рассчитать</vscode-button>
	</div>
	<div class="result-area" id="resultArea"></div>`;

	const extraScript = `
		const vscode = acquireVsCodeApi();
		const exprInput = document.getElementById('expr');
		const calcBtn = document.getElementById('calc');
		const resultArea = document.getElementById('resultArea');

		function runCalc() {
			const expr = (exprInput.value || '').trim();
			if (!expr) return;
			calcBtn.disabled = true;
			resultArea.replaceChildren();
			const hint = document.createElement('div');
			hint.className = 'hint';
			hint.textContent = 'Вычисление…';
			resultArea.appendChild(hint);
			vscode.postMessage({ command: 'calculate', expression: expr });
		}

		function appendCount(parent, count) {
			const el = document.createElement('div');
			el.className = 'count';
			el.textContent = 'Элементов: ' + count;
			parent.appendChild(el);
		}

		function renderTable(rows) {
			const table = document.createElement('vscode-table');
			table.setAttribute('zebra', '');
			table.setAttribute('bordered', '');
			const header = document.createElement('vscode-table-header');
			header.slot = 'header';
			for (const h of ['Свойство', 'Значение', 'Тип']) {
				const cell = document.createElement('vscode-table-header-cell');
				cell.textContent = h;
				header.appendChild(cell);
			}
			const body = document.createElement('vscode-table-body');
			body.slot = 'body';
			for (const r of rows) {
				const tr = document.createElement('vscode-table-row');
				for (const text of [r.name, r.value, r.type]) {
					const td = document.createElement('vscode-table-cell');
					td.textContent = text;
					tr.appendChild(td);
				}
				body.appendChild(tr);
			}
			table.appendChild(header);
			table.appendChild(body);
			return table;
		}

		function appendTreeItems(parent, nodes) {
			for (const node of nodes) {
				const item = document.createElement('vscode-tree-item');
				if (node.children && node.children.length) {
					item.setAttribute('branch', '');
				}
				item.appendChild(document.createTextNode(node.name));
				const decoration = [node.value, node.type].filter(Boolean).join('  ');
				if (decoration) {
					const span = document.createElement('span');
					span.slot = 'decoration';
					span.textContent = decoration;
					item.appendChild(span);
				}
				if (node.children && node.children.length) {
					appendTreeItems(item, node.children);
				}
				parent.appendChild(item);
			}
		}

		calcBtn.addEventListener('click', runCalc);
		exprInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') runCalc();
		});

		window.addEventListener('message', (e) => {
			const msg = e.data;
			resultArea.replaceChildren();
			if (msg.type === 'error') {
				const err = document.createElement('div');
				err.className = 'error';
				err.textContent = msg.message || 'Ошибка';
				resultArea.appendChild(err);
			} else if (msg.type === 'result') {
				appendCount(resultArea, msg.count);
				if (msg.kind === 'table') {
					resultArea.appendChild(renderTable(msg.rows || []));
				} else if (msg.kind === 'tree') {
					const tree = document.createElement('vscode-tree');
					tree.setAttribute('indent-guides', 'onHover');
					const nodes = msg.nodes || [];
					if (nodes.length === 0) {
						const item = document.createElement('vscode-tree-item');
						item.textContent = '(пусто)';
						tree.appendChild(item);
					} else {
						appendTreeItems(tree, nodes);
					}
					resultArea.appendChild(tree);
				}
			}
			calcBtn.disabled = false;
		});
	`;

	return wrapWebviewHtml(webview, body, '', extraScript);
}

let currentPanel: vscode.WebviewPanel | undefined;

/** Открывает панель вычисления выражений. */
export function openCalculateExpressionPanel(): void {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'onec') {
		vscode.window.showWarningMessage('Нет активной сессии отладки 1С. Запустите отладку перед использованием.');
		return;
	}

	const column = vscode.ViewColumn.Beside;
	if (currentPanel) {
		currentPanel.reveal(column);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'1cCalculateExpression',
		'Рассчитать значение',
		column,
		getWebviewPanelOptions(),
	);

	currentPanel = panel;
	let lastExpression = '';

	panel.webview.html = getPanelHtml(panel.webview, lastExpression);

	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg.command !== 'calculate' || !msg.expression?.trim()) {
			return;
		}
		const expression = String(msg.expression).trim();
		lastExpression = expression;
		try {
			const rows = await evaluateExpression(session, expression);
			const payload = buildResultPayload(rows, expression);
			panel.webview.postMessage({ type: 'result', ...payload });
		} catch (err) {
			const msg2 = err instanceof Error ? err.message : String(err);
			panel.webview.postMessage({ type: 'error', message: msg2 });
		}
	});

	panel.onDidDispose(() => {
		currentPanel = undefined;
	});
}

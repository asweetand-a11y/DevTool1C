/**
 * Дерево переменных отладки и разметка vscode-tree / vscode-table.
 */

/** Узел дерева свойств (пути с точками). */
export interface DebugTreeNode {
	key: string;
	name: string;
	value: string;
	type: string;
	children: DebugTreeNode[];
}

/** Экранирует текст для HTML. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Строит дерево из плоского списка путей (name = полный путь).
 */
export function buildDebugTree(
	rows: Array<{ name: string; value: string; type: string }>,
	rootExpression: string,
): DebugTreeNode {
	const byPath = new Map<string, DebugTreeNode>();
	const root: DebugTreeNode = { key: rootExpression, name: rootExpression, value: '', type: '', children: [] };
	byPath.set(rootExpression, root);
	const sorted = [...rows].sort((a, b) => a.name.length - b.name.length);

	for (const r of sorted) {
		const path = r.name;
		const segments = path.split('.');
		const displayName = segments.pop() ?? path;
		const parentPath = segments.join('.');
		const node: DebugTreeNode = { key: path, name: displayName, value: r.value, type: r.type, children: [] };
		byPath.set(path, node);
		const parent = parentPath ? byPath.get(parentPath) : root;
		(parent ?? root).children.push(node);
	}

	return root;
}

/**
 * Дочерние узлы корня → vscode-tree-item (вложенные).
 */
export function debugTreeChildrenToHtml(nodes: DebugTreeNode[]): string {
	return nodes
		.map((node) => {
			const hasChildren = node.children.length > 0;
			const decoration = [node.value, node.type].filter(Boolean).join('  ');
			const attrs = hasChildren ? ' branch' : '';
			const dec = decoration ? `<span slot="decoration">${escapeHtml(decoration)}</span>` : '';
			const kids = hasChildren ? debugTreeChildrenToHtml(node.children) : '';
			return `<vscode-tree-item${attrs}>${escapeHtml(node.name)}${dec}${kids}</vscode-tree-item>`;
		})
		.join('');
}

/**
 * Оборачивает элементы в vscode-tree.
 */
export function wrapVscodeTreeHtml(innerItems: string): string {
	return `<vscode-tree indent-guides="onHover">${innerItems}</vscode-tree>`;
}

/**
 * Таблица VSCode Elements.
 */
export function vscodeTableHtml(headers: string[], rows: string[][]): string {
	const header = headers
		.map((h) => `<vscode-table-header-cell>${escapeHtml(h)}</vscode-table-header-cell>`)
		.join('');
	const body = rows
		.map(
			(r) =>
				`<vscode-table-row>${r.map((c) => `<vscode-table-cell>${escapeHtml(c)}</vscode-table-cell>`).join('')}</vscode-table-row>`,
		)
		.join('');
	return `<vscode-table zebra bordered>
		<vscode-table-header slot="header">${header}</vscode-table-header>
		<vscode-table-body slot="body">${body}</vscode-table-body>
	</vscode-table>`;
}

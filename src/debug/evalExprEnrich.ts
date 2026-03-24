/**
 * Дополнение результата evalExpr(interfaces=context) для коллекций 1С:
 * Соответствие (enum / collection), ТаблицаЗначений, ДанныеФормыКоллекция, ВременныеТаблицыЗапроса.
 */

import type { RdbgClient } from './rdbgClient';
import type { DebugTargetIdLight, EvalExprCollectionRow, EvalExprResult, RDbgBaseRequest } from './rdbgTypes';

export type EnrichEvalExprOptions = {
	/** Выражение содержит МенеджерВременныхТаблиц — не тянуть строки ТЗ (зацикливание). */
	isUnderManagerTempTables?: boolean;
};

function mapEnumRowsToChildren(enumResult: { collectionRows?: EvalExprCollectionRow[] }): NonNullable<EvalExprResult['children']> {
	const rows = enumResult.collectionRows ?? [];
	return rows.map((row) => {
		const keyCell = row.cells.find((c) => /^Ключ$/i.test(c.name));
		const valCell = row.cells.find((c) => /^Значение$/i.test(c.name));
		return {
			name: keyCell?.value ?? `[${row.index}]`,
			value: valCell?.value ?? '',
			typeName: valCell?.typeName,
		};
	});
}

function mapCollectionRowsToChildren(collectionRows: EvalExprCollectionRow[], rowTypeName: string): NonNullable<EvalExprResult['children']> {
	return collectionRows.map((row) => {
		const summary = row.cells.map((c) => `${c.name}=${c.value}`).join(', ');
		return { name: `[${row.index}]`, value: summary, typeName: rowTypeName };
	});
}

/**
 * Собирает BSL-путь к дочернему свойству: для неидентификаторов — скобки ["..."] или [n].
 */
export function buildNestedEvalExpression(parentExpr: string, childName: string): string {
	const child = (childName ?? '').trim();
	if (!parentExpr.trim()) return child;
	if (!child) return parentExpr;
	if (/^[а-яА-ЯёЁa-zA-Z_][а-яА-ЯёЁa-zA-Z0-9_]*$/i.test(child)) {
		return `${parentExpr}.${child}`;
	}
	if (/^\d+$/.test(child)) {
		return `${parentExpr}[${child}]`;
	}
	const escaped = child.replace(/"/g, '""');
	return `${parentExpr}["${escaped}"]`;
}

/**
 * После evalExpr(context): подгружает дочерние элементы через enum/collection там, где контекст их не отдаёт.
 */
export async function enrichEvalExprForCollections(
	client: RdbgClient,
	base: RDbgBaseRequest,
	target: DebugTargetIdLight,
	expression: string,
	_frameIndex: number,
	result: EvalExprResult,
	opts?: EnrichEvalExprOptions,
): Promise<EvalExprResult> {
	let r: EvalExprResult = { ...result };
	const type = r.typeName ?? '';
	const children = r.children ?? [];
	const noKids = children.length === 0;
	const onlyMetadata =
		children.length === 2 && children.every((c) => /^(Колонки|Индексы)$/i.test(c.name));
	const size = r.collectionSize ?? 0;
	const atTempTableLevel = /\.Таблицы\[\d+\]\s*$/i.test(expression);
	const skipTableRows = !!opts?.isUnderManagerTempTables || atTempTableLevel;

	const isFormDataColl = /ДанныеФормыКоллекция/i.test(type);
	const isTable = /ТаблицаЗначений/i.test(type);
	const isTableLike = isTable || isFormDataColl;

	// Соответствие: context часто без детей — enum, затем collection
	if (/Соответствие/i.test(type) && noKids) {
		try {
			const er = await client.evalExprEnum(base, target, expression, _frameIndex);
			if (er.collectionRows && er.collectionRows.length > 0) {
				r = { ...r, children: mapEnumRowsToChildren(er) };
			}
		} catch {
			// оставляем
		}
		if ((!r.children || r.children.length === 0) && size > 0) {
			try {
				const cr = await client.evalExprCollection(base, target, expression, _frameIndex);
				const crRows = cr.collectionRows ?? [];
				if (crRows.length > 0) {
					r = { ...r, children: mapCollectionRowsToChildren(crRows, 'ЭлементСоответствия') };
				}
			} catch {
				// оставляем
			}
		}
	}

	// ТаблицаЗначений и ДанныеФормыКоллекция
	const tryRows =
		isTableLike &&
		!skipTableRows &&
		(onlyMetadata || noKids) &&
		(size > 0 || (isFormDataColl && noKids));
	if (tryRows) {
		try {
			const cr = await client.evalExprCollection(base, target, expression, _frameIndex);
			const collRows = cr.collectionRows ?? [];
			if (collRows.length > 0) {
				const rowType = isFormDataColl ? 'ЭлементДанныхФормыКоллекция' : 'СтрокаТаблицыЗначений';
				const rowChildren = mapCollectionRowsToChildren(collRows, rowType);
				r = { ...r, children: [...(r.children ?? []), ...rowChildren] };
			}
		} catch {
			// оставляем
		}
	}

	// ДанныеФормыКоллекция: если нет строк вида [0],[1] — пробуем enum
	if (isFormDataColl) {
		const hasIndexedRows = (r.children ?? []).some((c) => /^\[\d+\]$/.test(c.name));
		if (!hasIndexedRows) {
			try {
				const er = await client.evalExprEnum(base, target, expression, _frameIndex);
				if (er.collectionRows && er.collectionRows.length > 0) {
					const fromEnum = mapEnumRowsToChildren(er);
					r = { ...r, children: [...(r.children ?? []), ...fromEnum] };
				}
			} catch {
				// оставляем
			}
		}
	}

	if (/ВременныеТаблицыЗапроса/i.test(type) && size > 0 && (!r.children || r.children.length === 0)) {
		try {
			const cr = await client.evalExprCollection(base, target, expression, _frameIndex);
			const vtRows = cr.collectionRows ?? [];
			if (vtRows.length > 0) {
				r = {
					...r,
					children: mapCollectionRowsToChildren(vtRows, 'ВременнаяТаблицаЗапроса'),
				};
			}
		} catch {
			// оставляем
		}
	}

	return r;
}

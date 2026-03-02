/**
 * Парсинг структуры BSL-модуля: процедуры, функции, директивы расширений.
 * Используется для корректного маппинга строк breakpoints между базовой конфигурацией и расширением.
 */

import * as fs from 'node:fs';

/** Директива расширения перед процедурой/функцией. */
export type ExtensionDirective = 'replacement' | 'after' | 'before';

export interface BslProcedure {
	/** Имя процедуры/функции. */
	name: string;
	/** Номер строки начала (1-based), включая «Процедура/Функция». */
	startLine: number;
	/** Номер строки конца (1-based), включая «КонецПроцедуры/КонецФункции». */
	endLine: number;
	/** Директива расширения, если есть (&ИзменениеИКонтроль, &Вместо, &После, &Перед). */
	directive?: ExtensionDirective;
	/** Имя базовой процедуры из аргумента директивы. */
	baseProcName?: string;
}

const PROC_FUNC_START = /^\s*(Процедура|Функция)\s+([А-Яа-яёЁA-Za-z_][А-Яа-яёЁ\w]*)\s*\(/i;
const PROC_FUNC_END = /^\s*Конец(Процедуры|Функции)\s*$/i;
const DIRECTIVE_RE = /\&(ИзменениеИКонтроль|Вместо|После|Перед)\s*\(\s*["']([^"']+)["']\s*\)/i;

/**
 * Парсит BSL-модуль и возвращает список процедур/функций с их границами и директивами.
 * @param content - содержимое файла .bsl
 * @returns массив процедур в порядке объявления
 */
export function parseBslModule(content: string): BslProcedure[] {
	const result: BslProcedure[] = [];
	const lines = content.split(/\r?\n/);
	let currentDirective: { type: ExtensionDirective; baseName: string } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		const dirMatch = trimmed.match(DIRECTIVE_RE);
		if (dirMatch) {
			const kind = dirMatch[1].toLowerCase();
			const baseName = dirMatch[2].trim();
			if (kind === 'изменениеиконтроль' || kind === 'вместо') {
				currentDirective = { type: 'replacement', baseName };
			} else if (kind === 'после') {
				currentDirective = { type: 'after', baseName };
			} else if (kind === 'перед') {
				currentDirective = { type: 'before', baseName };
			} else {
				currentDirective = undefined;
			}
			continue;
		}

		const startMatch = trimmed.match(PROC_FUNC_START);
		if (startMatch) {
			const proc: BslProcedure = {
				name: startMatch[2],
				startLine: i + 1,
				endLine: -1,
			};
			if (currentDirective) {
				proc.directive = currentDirective.type;
				proc.baseProcName = currentDirective.baseName;
				currentDirective = undefined;
			}
			for (let j = i + 1; j < lines.length; j++) {
				if (PROC_FUNC_END.test(lines[j].trim())) {
					proc.endLine = j + 1;
					break;
				}
			}
			if (proc.endLine > 0) {
				result.push(proc);
			}
		}
	}

	return result;
}

/**
 * Сопоставляет breakpoint в базовом модуле со строками в модуле расширения.
 * - &ИзменениеИКонтроль/&Вместо: база не выполняется, маппинг по относительной позиции в процедуре.
 * - &После/&Перед: расширение выполняется до/после базы, добавляется первая строка тела процедуры.
 *
 * @param baseBslPath - путь к .bsl базовой конфигурации
 * @param baseLine - номер строки breakpoint в базе (1-based)
 * @param extBslPath - путь к .bsl расширения
 * @returns массив номеров строк в расширении, куда ставить breakpoint (1-based); пусто, если маппинг невозможен
 */
export function mapBaseBreakpointToExtensionLines(
	baseBslPath: string,
	baseLine: number,
	extBslPath: string,
): number[] {
	let baseContent: string;
	let extContent: string;
	try {
		baseContent = fs.readFileSync(baseBslPath, 'utf8');
		extContent = fs.readFileSync(extBslPath, 'utf8');
	} catch {
		return [];
	}

	const baseProcs = parseBslModule(baseContent);
	const extProcs = parseBslModule(extContent);

	const baseProc = baseProcs.find((p) => baseLine >= p.startLine && baseLine <= p.endLine);
	if (!baseProc) {
		return [];
	}

	const baseName = baseProc.name.toLowerCase();
	const extReplacement = extProcs.find(
		(p) => p.directive === 'replacement' && p.baseProcName?.toLowerCase() === baseName,
	);
	if (extReplacement) {
		const baseHeight = baseProc.endLine - baseProc.startLine;
		const extHeight = extReplacement.endLine - extReplacement.startLine;
		if (baseHeight <= 0 || extHeight <= 0) {
			return [extReplacement.startLine + 1];
		}
		const relativePos = (baseLine - baseProc.startLine) / baseHeight;
		let extLine = extReplacement.startLine + Math.round(relativePos * extHeight);
		extLine = Math.max(extReplacement.startLine + 1, Math.min(extReplacement.endLine - 1, extLine));
		return [extLine];
	}

	const extAfterBefore = extProcs.find(
		(p) =>
			(p.directive === 'after' || p.directive === 'before') &&
			p.baseProcName?.toLowerCase() === baseName,
	);
	if (extAfterBefore) {
		return [extAfterBefore.startLine + 1];
	}

	return [];
}

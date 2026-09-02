/**
 * Нормализация путей из Commit.txt для частичной загрузки конфигурации/расширения.
 *
 * Агент может записать абсолютный путь, путь от корня проекта, путь от src/cf,
 * путь от другого диска с фрагментом src/cf, или путь от корня выгрузки XML
 * (например \CommonModules\...\Ext\Module.bsl).
 * Конфигуратор в -listFile ожидает путь относительно каталога --src.
 *
 * @module commitPath
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Откуда распознан путь в строке Commit.txt.
 * - cf — явно из основной конфигурации (маркер src/cf или настроенный paths.src)
 * - cfe — явно из расширения (маркер src/cfe/<имя>)
 * - dump — путь уже относительно корня XML-выгрузки, без src/cf и src/cfe
 */
export type CommitPathKind = 'cf' | 'cfe' | 'dump';

/**
 * Разобранная строка Commit.txt.
 */
export interface ParsedCommitPath {
	kind: CommitPathKind;
	/** Путь относительно корня выгрузки (src/cf или каталога расширения), через /. */
	relativePath: string;
	/** Имя расширения, если kind === 'cfe'. */
	extensionName?: string;
}

/**
 * Контекст разбора: корень проекта и настроенные каталоги исходников.
 */
export interface CommitPathContext {
	workspaceRoot: string;
	srcPath: string;
	cfePath: string;
}

const FALLBACK_CF_MARKER = 'src/cf';
const FALLBACK_CFE_MARKER = 'src/cfe';

/**
 * Разбирает одну строку Commit.txt.
 * @param rawLine - Исходная строка файла
 * @param context - Корень workspace и пути src/cfe
 * @returns Разобранный путь или undefined, если строку нужно пропустить
 */
export function parseCommitPathLine(rawLine: string, context: CommitPathContext): ParsedCommitPath | undefined {
	const cleaned = cleanCommitLine(rawLine);
	if (cleaned === undefined) {
		return undefined;
	}

	let posix = toPosixPath(cleaned);

	if (posix.toLowerCase().startsWith('file:')) {
		try {
			posix = toPosixPath(fileURLToPath(cleaned));
		} catch {
			posix = toPosixPath(cleaned.replace(/^file:\/\//i, ''));
		}
	}

	if (/^\/[a-zA-Z]:\//.test(posix)) {
		posix = posix.slice(1);
	}

	posix = posix.replace(/\/{2,}/g, '/');

	if (isWindowsDriveAbsolute(posix)) {
		const relativeToWorkspace = relativePosixIfInsideWorkspace(posix, context.workspaceRoot);
		if (relativeToWorkspace !== undefined) {
			posix = relativeToWorkspace;
		}
	}

	posix = posix.replace(/^\.\//, '');

	const cfeMarkers = uniqueMarkers([
		toPosixPath(context.cfePath),
		FALLBACK_CFE_MARKER
	]);
	for (const marker of cfeMarkers) {
		const afterCfe = takeAfterMarker(posix, marker);
		if (afterCfe === undefined) {
			continue;
		}
		const segments = afterCfe.split('/').filter(segment => segment !== '');
		if (segments.length === 0) {
			return undefined;
		}
		const extensionName = segments[0];
		const relativePath = segments.slice(1).join('/');
		if (relativePath === '' || hasParentSegment(relativePath)) {
			return undefined;
		}
		return { kind: 'cfe', extensionName, relativePath };
	}

	const cfMarkers = uniqueMarkers([
		toPosixPath(context.srcPath),
		FALLBACK_CF_MARKER
	]);
	for (const marker of cfMarkers) {
		const afterCf = takeAfterMarker(posix, marker);
		if (afterCf === undefined) {
			continue;
		}
		if (afterCf === '' || hasParentSegment(afterCf)) {
			return undefined;
		}
		return { kind: 'cf', relativePath: afterCf };
	}

	const dumpRelative = posix.replace(/^\/+/, '');
	if (dumpRelative === '' || hasParentSegment(dumpRelative)) {
		return undefined;
	}
	const looksLikeDumpFile = dumpRelative.includes('/') || /\.(xml|bsl|bin|html)$/i.test(dumpRelative);
	if (!looksLikeDumpFile) {
		return undefined;
	}

	return { kind: 'dump', relativePath: dumpRelative };
}

/**
 * Преобразует относительный POSIX-путь в формат -listFile Конфигуратора (обратные слэши).
 * @param relativePath - Путь относительно каталога выгрузки
 * @returns Строка для записи во временный Commit_*.txt
 */
export function toDesignerListFilePath(relativePath: string): string {
	return relativePath.replace(/\//g, '\\');
}


/**
 * Убирает BOM, кавычки и комментарии из строки Commit.txt.
 */
function cleanCommitLine(line: string): string | undefined {
	let value = line.replace(/^\uFEFF/, '').trim();
	if (value === '' || /^REM(\s|$)/i.test(value) || value.startsWith('#') || value.startsWith('//')) {
		return undefined;
	}

	const quote = value[0];
	if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote) && value.length >= 2) {
		value = value.slice(1, -1).trim();
	}

	return value === '' ? undefined : value;
}

function toPosixPath(value: string): string {
	return value.replace(/\\/g, '/');
}

function isWindowsDriveAbsolute(posix: string): boolean {
	return /^[a-zA-Z]:\//.test(posix);
}

function uniqueMarkers(markers: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const marker of markers) {
		const normalized = trimSlashes(toPosixPath(marker)).toLowerCase();
		if (normalized === '' || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(trimSlashes(toPosixPath(marker)));
	}
	return result;
}

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, '');
}

function hasParentSegment(relativePath: string): boolean {
	return relativePath.split('/').includes('..');
}

/**
 * Если абсолютный путь лежит внутри workspace, возвращает путь от корня проекта.
 */
function relativePosixIfInsideWorkspace(posix: string, workspaceRoot: string): string | undefined {
	const systemPath = posix.replace(/\//g, path.sep);
	const relative = path.relative(workspaceRoot, systemPath);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	return toPosixPath(relative);
}

/**
 * Возвращает хвост пути после маркера каталога (src/cf, src/cfe).
 * Маркер ищется как сегмент пути, чтобы src/cf не совпал с src/cfe.
 */
function takeAfterMarker(posix: string, marker: string): string | undefined {
	const markerPosix = trimSlashes(toPosixPath(marker));
	if (markerPosix === '') {
		return undefined;
	}

	const lower = posix.toLowerCase();
	const token = `${markerPosix.toLowerCase()}/`;
	const withSlash = `/${token}`;
	const idx = lower.lastIndexOf(withSlash);
	if (idx !== -1) {
		return posix.slice(idx + withSlash.length);
	}
	if (lower.startsWith(token)) {
		return posix.slice(token.length);
	}
	return undefined;
}

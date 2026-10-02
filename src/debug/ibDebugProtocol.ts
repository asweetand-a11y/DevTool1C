/**
 * Проверка протокола отладки ИБ в профиле 1С (1cv8.pfl).
 * Расширение работает только по HTTP (dbgs); TCP в профиле ломает сессию.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveIbPathFromConnection } from './launch1cv8c';

const IBASES_RELATIVE = ['1C', '1CEStart', 'ibases.v8i'] as const;
const PFL_RELATIVE = ['1C', '1cv8'] as const;
const PFL_NAME = '1cv8.pfl';

const DEBUGGER_TYPE_RE = /("debuggerType"\s*,\s*\{\s*"S"\s*,\s*")([^"]*)(")/i;
const EMPTY_DEBUG_BLOCK_RE = /(\{"debug",\s*)\{\s*""\s*\}/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Запись информационной базы из ibases.v8i. */
export interface IbasesEntry {
	name: string;
	id: string;
	connect: string;
	filePath?: string;
	srvr?: string;
	ref?: string;
}

/** Параметры поиска ИБ и проверки протокола. */
export interface EnsureIbHttpDebugProtocolParams {
	infoBase?: string;
	ibconnection?: string;
	workspaceRoot?: string;
}

/** Результат проверки: HTTP уже задан / переключён, либо ошибка (отладку нельзя продолжать). */
export type IbHttpDebugProtocolResult =
	| { ok: true; protocol: 'http'; infobaseId: string; pflPath: string; switched: boolean; message: string }
	| { ok: false; message: string };

/**
 * Перед запуском отладки проверяет debuggerType в 1cv8.pfl.
 * Если указан tcp (или секция debug пустая — платформа по умолчанию использует TCP), пытается записать http.
 * @param params - имя ИБ / строка подключения из env.json и launch.json
 * @returns ok=false, если GUID/файл не найдены или протокол не HTTP и переключить не удалось
 */
export function ensureIbHttpDebugProtocol(params: EnsureIbHttpDebugProtocolParams): IbHttpDebugProtocolResult {
	const appData = process.env.APPDATA?.trim();
	if (!appData) {
		return {
			ok: false,
			message:
				'1C Dev Tools: не задана переменная APPDATA — нельзя прочитать список ИБ (ibases.v8i) и профиль отладки 1cv8.pfl.',
		};
	}

	const ibasesPath = path.join(appData, ...IBASES_RELATIVE);
	if (!fs.existsSync(ibasesPath)) {
		return {
			ok: false,
			message: `1C Dev Tools: не найден список информационных баз: ${ibasesPath}. Нельзя проверить протокол отладки (нужен HTTP).`,
		};
	}

	let entries: IbasesEntry[];
	try {
		entries = parseIbasesV8i(fs.readFileSync(ibasesPath, 'utf8'));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `1C Dev Tools: ошибка чтения ${ibasesPath}: ${detail}` };
	}

	const entry = findIbasesEntry(entries, params);
	if (!entry) {
		const hint = [params.infoBase && `infoBase="${params.infoBase}"`, params.ibconnection && `ibconnection="${params.ibconnection}"`]
			.filter(Boolean)
			.join(', ');
		return {
			ok: false,
			message:
				`1C Dev Tools: информационная база не найдена в ${ibasesPath}` +
				(hint ? ` (${hint})` : '') +
				'. GUID папки профиля 1cv8.pfl неизвестен — проверьте имя базы в списке баз 1С.',
		};
	}

	const pflPath = path.join(appData, ...PFL_RELATIVE, entry.id, PFL_NAME);
	if (!fs.existsSync(pflPath)) {
		return {
			ok: false,
			message:
				`1C Dev Tools: не найден профиль ${pflPath}. Для ИБ «${entry.name}» протокол отладки, скорее всего, TCP (значение по умолчанию). ` +
				'В конфигураторе выберите отладку по HTTP (Сервис — Параметры — Отладка) и сохраните настройки, либо запустите базу хотя бы раз с HTTP.',
		};
	}

	let pflText: string;
	try {
		pflText = fs.readFileSync(pflPath, 'latin1');
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `1C Dev Tools: не удалось прочитать ${pflPath}: ${detail}` };
	}

	const current = readDebuggerType(pflText);
	if (current === 'http') {
		return {
			ok: true,
			protocol: 'http',
			infobaseId: entry.id,
			pflPath,
			switched: false,
			message: `Протокол отладки ИБ «${entry.name}»: HTTP (${pflPath}).`,
		};
	}

	const patched = patchPflDebuggerTypeToHttp(pflText);
	if (!patched) {
		return {
			ok: false,
			message:
				`1C Dev Tools: в ${pflPath} для ИБ «${entry.name}» протокол отладки — ${current ?? 'TCP (не задан)'}. ` +
				'Расширение поддерживает только HTTP. Переключите протокол в конфигураторе (Сервис — Параметры — Отладка) на HTTP и повторите запуск.',
		};
	}

	try {
		fs.writeFileSync(pflPath, patched, { encoding: 'latin1' });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			message:
				`1C Dev Tools: в профиле ИБ «${entry.name}» указан протокол ${current ?? 'TCP'}, переключить на HTTP не удалось (${detail}). ` +
				`Файл: ${pflPath}. Закройте конфигуратор/клиент 1С и повторите, либо смените протокол вручную.`,
		};
	}

	return {
		ok: true,
		protocol: 'http',
		infobaseId: entry.id,
		pflPath,
		switched: true,
		message:
			`Протокол отладки ИБ «${entry.name}» был ${current ?? 'TCP (не задан)'} — в ${pflPath} записан HTTP. ` +
			'Если конфигуратор этой базы уже открыт, закройте его: иначе он может перезаписать настройку.',
	};
}

/**
 * Разбирает ibases.v8i (UTF-8, секции [Имя], Connect=, ID=).
 * @param text - содержимое файла
 */
export function parseIbasesV8i(text: string): IbasesEntry[] {
	const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	const entries: IbasesEntry[] = [];
	let currentName: string | undefined;
	let connect = '';
	let id = '';

	const flush = (): void => {
		if (!currentName || !UUID_RE.test(id)) {
			return;
		}
		const parsed = parseConnectString(connect);
		entries.push({
			name: currentName,
			id: id.toLowerCase(),
			connect,
			filePath: parsed.filePath,
			srvr: parsed.srvr,
			ref: parsed.ref,
		});
	};

	for (const rawLine of normalized.split('\n')) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith('[') && line.endsWith(']')) {
			flush();
			currentName = line.slice(1, -1).trim();
			connect = '';
			id = '';
			continue;
		}
		const eq = line.indexOf('=');
		if (eq < 0 || currentName === undefined) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (key.toLowerCase() === 'connect') {
			connect = value;
		} else if (key.toLowerCase() === 'id') {
			id = value;
		}
	}
	flush();
	return entries;
}

/**
 * Ищет запись ИБ: сначала по имени (--infoBase), затем по пути файловой базы, затем по Srvr/Ref.
 */
export function findIbasesEntry(entries: IbasesEntry[], params: EnsureIbHttpDebugProtocolParams): IbasesEntry | undefined {
	const infoBase = (params.infoBase ?? '').trim();
	if (infoBase) {
		const byName = entries.find((e) => e.name.localeCompare(infoBase, undefined, { sensitivity: 'accent' }) === 0);
		if (byName) {
			return byName;
		}
	}

	const workspaceRoot = (params.workspaceRoot ?? '').trim();
	const filePath = resolveIbPathFromConnection(params.ibconnection, workspaceRoot);
	if (filePath) {
		const want = normalizeFsPath(filePath);
		const byFile = entries.find((e) => e.filePath && normalizeFsPath(e.filePath) === want);
		if (byFile) {
			return byFile;
		}
	}

	const server = parseServerIbconnection(params.ibconnection);
	if (server) {
		const byServer = entries.find(
			(e) =>
				e.srvr &&
				e.ref &&
				e.srvr.localeCompare(server.srvr, undefined, { sensitivity: 'accent' }) === 0 &&
				e.ref.localeCompare(server.ref, undefined, { sensitivity: 'accent' }) === 0,
		);
		if (byServer) {
			return byServer;
		}
	}

	return undefined;
}

function parseConnectString(connect: string): { filePath?: string; srvr?: string; ref?: string } {
	const fileMatch = /File\s*=\s*"([^"]+)"/i.exec(connect) ?? /File\s*=\s*([^;]+)/i.exec(connect);
	const srvrMatch = /Srvr\s*=\s*"([^"]+)"/i.exec(connect) ?? /Srvr\s*=\s*([^;]+)/i.exec(connect);
	const refMatch = /Ref\s*=\s*"([^"]+)"/i.exec(connect) ?? /Ref\s*=\s*([^;]+)/i.exec(connect);
	return {
		filePath: fileMatch?.[1]?.trim(),
		srvr: srvrMatch?.[1]?.trim(),
		ref: refMatch?.[1]?.trim(),
	};
}

function parseServerIbconnection(ibconnection: string | undefined): { srvr: string; ref: string } | undefined {
	const s = (ibconnection ?? '').trim();
	if (!s) {
		return undefined;
	}
	const m = /^\/S\s*(.+)$/i.exec(s);
	if (!m) {
		return undefined;
	}
	const rest = m[1].trim().replace(/^["']|["']$/g, '');
	const slash = rest.search(/[\\/]/);
	if (slash < 0) {
		return undefined;
	}
	const srvr = rest.slice(0, slash).trim();
	const ref = rest.slice(slash + 1).trim();
	if (!srvr || !ref) {
		return undefined;
	}
	return { srvr, ref };
}

function normalizeFsPath(p: string): string {
	const resolved = path.resolve(p.replace(/[/\\]+$/, ''));
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readDebuggerType(pflText: string): string | undefined {
	const m = DEBUGGER_TYPE_RE.exec(pflText);
	if (!m) {
		return undefined;
	}
	return m[2].trim().toLowerCase();
}

/**
 * Заменяет debuggerType на http либо заполняет пустую секцию {"debug",{""}}.
 */
function patchPflDebuggerTypeToHttp(pflText: string): string | undefined {
	const current = readDebuggerType(pflText);
	if (current === 'http') {
		return pflText;
	}
	if (current !== undefined) {
		const next = pflText.replace(DEBUGGER_TYPE_RE, '$1http$3');
		return readDebuggerType(next) === 'http' ? next : undefined;
	}
	if (!EMPTY_DEBUG_BLOCK_RE.test(pflText)) {
		return undefined;
	}
	const next = pflText.replace(EMPTY_DEBUG_BLOCK_RE, '$1{"debuggerType",\r\n{"S","http"},""}');
	return readDebuggerType(next) === 'http' ? next : undefined;
}

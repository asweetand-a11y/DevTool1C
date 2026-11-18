/**
 * Последний запуск dbgs (команда, порт, ownerPID).
 * Пишется в файл, чтобы другое окно и MCP видели фактический порт, а не 1560 из начала диапазона.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LAUNCH_FILE = path.join(os.tmpdir(), '1c-dev-tools-dbgs.json');

export interface DbgsLaunchInfo {
	commandLine: string;
	/** Порт, на котором запущен dbgs (первый свободный из диапазона). */
	port?: number;
	/** Хост, для которого запущен dbgs (для проверки при подстановке порта в конфиг). */
	debugServer?: string;
	ownerPid: number;
}

let lastLaunch: DbgsLaunchInfo | null = null;

export function setLastDbgsLaunch(info: DbgsLaunchInfo): void {
	lastLaunch = info;
	try {
		fs.writeFileSync(LAUNCH_FILE, JSON.stringify(info), 'utf8');
	} catch {
		// порт остаётся в памяти этого процесса
	}
}

export function getLastDbgsLaunch(): DbgsLaunchInfo | null {
	if (lastLaunch) return lastLaunch;
	try {
		if (!fs.existsSync(LAUNCH_FILE)) return null;
		const parsed = JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf8')) as DbgsLaunchInfo;
		if (!parsed || typeof parsed.port !== 'number') return null;
		lastLaunch = parsed;
		return lastLaunch;
	} catch {
		return null;
	}
}

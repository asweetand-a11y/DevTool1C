/**
 * Последний запуск dbgs (команда, порт, ownerPID) для вывода в Debug Console и подстановки в конфиг.
 * Записывается при активации расширения, читается в debugSession и debugConfiguration.
 */
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
}

export function getLastDbgsLaunch(): DbgsLaunchInfo | null {
	return lastLaunch;
}

/**
 * Запуск dbgs.exe только для режима launch, если в env.json сервер отладки — этот ПК.
 * Attach подключается к уже запущенному серверу: хост и порт из конфигурации, без автозапуска.
 * Не поднимает dbgs для удалённого --debug-server.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findFirstFreePortInRange, launchDbgsProcess, resolveDbgsPath } from './dbgsLauncher';
import { setLastDbgsLaunch } from './dbgsLaunchInfo';

type EnvDefaultSection = {
	'--v8version'?: string;
	'--debug-server'?: string;
	'--debug-port-range'?: string;
	'--v8-platform-root'?: string;
};

type EnvConfig = {
	default?: EnvDefaultSection;
};

/** Процесс dbgs, запущенный расширением (один на жизненный цикл; перед новым запуском убиваем). */
let managedDbgsProcess: ChildProcess | undefined;

export function killManagedDbgs(): void {
	if (managedDbgsProcess && !managedDbgsProcess.killed) {
		managedDbgsProcess.kill();
	}
	managedDbgsProcess = undefined;
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Перед новым запуском снимает dbgs.exe этого процесса и dbgs с уже мёртвым --ownerPID.
 * Сервер отладки конфигуратора (чужой живой владелец) не останавливает.
 */
async function stopStaleDbgs(): Promise<void> {
	if (process.platform !== 'win32') {
		return;
	}
	let stdout = '';
	try {
		const result = await execFileAsync(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				"Get-CimInstance Win32_Process -Filter \"Name = 'dbgs.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
			],
			{ windowsHide: true, timeout: 8000 },
		);
		stdout = result.stdout ?? '';
	} catch {
		return;
	}
	const text = stdout.trim();
	if (!text) {
		return;
	}
	let rows: Array<{ ProcessId?: number; CommandLine?: string }>;
	try {
		const parsed = JSON.parse(text) as unknown;
		rows = Array.isArray(parsed)
			? (parsed as Array<{ ProcessId?: number; CommandLine?: string }>)
			: [parsed as { ProcessId?: number; CommandLine?: string }];
	} catch {
		return;
	}
	for (const row of rows) {
		const pid = Number(row.ProcessId);
		const owner = /--ownerPID=(\d+)/i.exec(row.CommandLine ?? '');
		const ownerPid = owner ? Number(owner[1]) : Number.NaN;
		const ours = ownerPid === process.pid;
		const stale = !isPidAlive(ownerPid);
		if (!owner || (!ours && !stale) || !Number.isInteger(pid) || pid <= 0) {
			continue;
		}
		try {
			process.kill(pid);
		} catch {
			// процесс уже завершился
		}
	}
}

function parseEnvConfig(envPath: string): EnvConfig {
	const rawContent = fs.readFileSync(envPath, 'utf8');
	return JSON.parse(rawContent) as EnvConfig;
}

export interface EnsureDbgsResult {
	/** Хост для HTTP к RDBG (из launch или env). */
	rdbgHost: string;
	/** Порт, на котором слушает только что запущенный dbgs. */
	rdbgPort: number;
}

/**
 * Читает env.json в корне workspace, при совпадении --debug-server с именем ПК запускает dbgs.
 * Вызывается только из режима launch. Порт — первый свободный в --debug-port-range.
 * @returns Параметры подключения к RDBG или undefined, если dbgs не поднимали (удалённый сервер / нет env).
 */
export async function ensureDbgsWhenDebugging(
	workspaceRoot: string | undefined,
	launchDebugHost: string | undefined,
): Promise<EnsureDbgsResult | undefined> {
	if (!workspaceRoot) {
		return undefined;
	}

	const envPath = path.join(workspaceRoot, 'env.json');
	if (!fs.existsSync(envPath)) {
		return undefined;
	}

	let envConfig: EnvConfig;
	try {
		envConfig = parseEnvConfig(envPath);
	} catch {
		void vscode.window.showErrorMessage('1C Dev Tools: не удалось разобрать env.json');
		return undefined;
	}

	const envDefault = envConfig.default;
	if (!envDefault) {
		return undefined;
	}

	const v8version = envDefault['--v8version'];
	const envDebugServer = envDefault['--debug-server'];
	const debugPortRange = envDefault['--debug-port-range'];
	const hostname = os.hostname();

	if (envDebugServer && envDebugServer.toLowerCase() !== hostname.toLowerCase()) {
		return undefined;
	}

	if (!v8version || !envDebugServer || !debugPortRange) {
		void vscode.window.showWarningMessage(
			'1C Dev Tools: для автозапуска dbgs заполните --v8version, --debug-server и --debug-port-range в env.json',
		);
		return undefined;
	}

	const dbgsPath = resolveDbgsPath(v8version, envDefault['--v8-platform-root']);
	if (!dbgsPath) {
		void vscode.window.showErrorMessage(
			`1C Dev Tools: не найден dbgs.exe для платформы ${v8version}. Укажите --v8-platform-root в env.json`,
		);
		return undefined;
	}

	killManagedDbgs();
	await stopStaleDbgs();

	const notifyFilePath = path.join(os.tmpdir(), `V8_${randomUUID()}.tmp`);

	try {
		const freePortInfo = await findFirstFreePortInRange(envDebugServer, debugPortRange);
		if (!freePortInfo) {
			void vscode.window.showErrorMessage('1C Dev Tools: неверный --debug-port-range в env.json');
			return undefined;
		}
		const portRangeForDbgs = freePortInfo.rangeForDbgs;
		const chosenPort = freePortInfo.port;

		const ownerPid = process.pid;
		managedDbgsProcess = launchDbgsProcess(dbgsPath, {
			debugServer: envDebugServer,
			portRange: portRangeForDbgs,
			ownerPid,
			notifyFilePath,
		});

		const quotedPath = dbgsPath.includes(' ') ? `"${dbgsPath}"` : dbgsPath;
		setLastDbgsLaunch({
			commandLine: `${quotedPath} --addr=${envDebugServer} --portRange=${portRangeForDbgs} --ownerPID=${ownerPid} --notify=${notifyFilePath}`,
			port: chosenPort,
			debugServer: envDebugServer,
			ownerPid,
		});

		managedDbgsProcess.unref();

		const rdbgHost = (launchDebugHost ?? '').trim() || envDebugServer;
		return { rdbgHost, rdbgPort: chosenPort };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`1C Dev Tools: ошибка запуска dbgs.exe: ${message}`);
		return undefined;
	}
}

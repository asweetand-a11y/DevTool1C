/**
 * MCP для агента Cursor: стек и переменные текущей сессии отладки 1С (type=onec).
 * HTTP на 127.0.0.1, только POST JSON. Регистрация через vscode.cursor.mcp.registerServer.
 * ~/.cursor/mcp.json не трогаем — иначе при открытии проекта каша User/extension записей.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getAgentDebugSnapshot, getAgentDebugSnapshotFile } from './agentDebugSnapshot';
import { getLastDbgsLaunch } from './dbgsLaunchInfo';

const SERVER_NAME = '1c-debug';
/** Фиксированный порт: случайный после Reload расходится с URL в mcp.json — вызовы зависают. */
const MCP_PORT = 18791;
/** Порт только процесса, в котором есть сессия onec. Его не занимает окно без отладки. */
const SESSION_BRIDGE_PORT = 18790;
const MCP_SESSION_ID = '1c-debug-session';
const MCP_OWNER_FILE = path.join(os.tmpdir(), '1c-dev-tools-mcp-owner.json');
const BRIDGE_DIR = path.join(os.tmpdir(), '1c-dev-tools-debug-bridge');

let server: http.Server | undefined;
let sessionBridge: http.Server | undefined;
let listenUrl = '';
/** Сессия onec этого окна. activeDebugSession в Cursor часто пустой, пока фокус в чате. */
let trackedOnecSession: vscode.DebugSession | undefined;

function getOnecDebugSession(): vscode.DebugSession | undefined {
	const active = vscode.debug.activeDebugSession;
	if (active?.type === 'onec') {
		trackedOnecSession = active;
		return active;
	}
	return trackedOnecSession;
}

/** Повторная регистрация URL: окно с живой отладкой должно перебить регистрацию другого окна. */
function registerCursorMcp(): void {
	if (!listenUrl) return;
	const cursorMcp = (
		vscode as unknown as { cursor?: { mcp?: { registerServer: (c: unknown) => void } } }
	).cursor?.mcp;
	try {
		cursorMcp?.registerServer?.({
			name: SERVER_NAME,
			server: { url: listenUrl },
		});
	} catch {
		// не Cursor
	}
}

/** Окно-владелец отладки: только оно исполняет инструменты MCP, остальные окна пересылают ему запросы. */
interface McpOwnerFile {
	url: string;
	pid: number;
	rootProject?: string;
	debugServerHost?: string;
	debugServerPort?: number;
}

let pendingDebugEndpoint: { host: string; port: number } | undefined;
let sessionBridgeUrl = '';

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Владелец из файла. Запись умершего процесса удаляется. */
function readMcpOwner(): McpOwnerFile | undefined {
	try {
		if (!fs.existsSync(MCP_OWNER_FILE)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(MCP_OWNER_FILE, 'utf8')) as McpOwnerFile;
		if (!parsed?.url || !parsed.pid) return undefined;
		if (!isProcessAlive(parsed.pid)) {
			fs.unlinkSync(MCP_OWNER_FILE);
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/** Владелец отладки — другой процесс. */
function foreignDebugOwner(): McpOwnerFile | undefined {
	const owner = readMcpOwner();
	return owner && owner.pid !== process.pid ? owner : undefined;
}

function writeMcpOwnerFile(): void {
	const session = getOnecDebugSession();
	if (!session && !pendingDebugEndpoint) return;
	const url = sessionBridgeUrl || listenUrl;
	if (!url) return;
	const body: McpOwnerFile = {
		url,
		pid: process.pid,
		rootProject: String(session?.configuration?.rootProject ?? '') || workspaceRoot(),
		debugServerHost: pendingDebugEndpoint?.host,
		debugServerPort: pendingDebugEndpoint?.port,
	};
	try {
		fs.writeFileSync(MCP_OWNER_FILE, JSON.stringify(body), 'utf8');
	} catch {
		// окно останется без пересылки
	}
}

/** Поднимает порт 18790 в том процессе, где реально идёт сессия. */
let armDebugBridge: (() => void) | undefined;

/** Делает это окно владельцем отладки и запоминает фактический dbgs. */
export function publishDebugMcpOwner(host: string, port: number): void {
	pendingDebugEndpoint = { host, port };
	armDebugBridge?.();
	writeMcpOwnerFile();
	registerCursorMcp();
}

function clearMcpOwnerFile(): void {
	pendingDebugEndpoint = undefined;
	const current = readMcpOwner();
	if (current && current.pid !== process.pid) return;
	try {
		if (fs.existsSync(MCP_OWNER_FILE)) fs.unlinkSync(MCP_OWNER_FILE);
	} catch {
		// игнорируем
	}
}

function postToMcp(url: string, raw: string): Promise<string | undefined> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		const req = http.request(
			{
				hostname: target.hostname,
				port: target.port || 80,
				path: `${target.pathname}${target.search}`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(raw),
					'X-Debug-Mcp-Hop': '1',
				},
				timeout: 60000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c as Buffer));
				res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			},
		);
		req.on('error', () => resolve(undefined));
		req.on('timeout', () => {
			req.destroy();
			resolve(undefined);
		});
		req.end(raw);
	});
}

/** Пересылает запрос только окну, в котором запущена отладка. */
async function forwardToDebugOwner(raw: string): Promise<string | undefined> {
	const owner = foreignDebugOwner();
	if (!owner) return undefined;
	return postToMcp(owner.url, raw);
}

type JsonRpc = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

function jsonRpcResult(id: unknown, result: unknown): string {
	return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function jsonRpcError(id: unknown, message: string): string {
	return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
}

function toolText(text: string, isError = false): unknown {
	return { content: [{ type: 'text', text }], isError };
}

async function dapRequest(command: string, args?: unknown): Promise<unknown> {
	const session = getOnecDebugSession();
	if (!session || session.type !== 'onec') {
		throw new Error('Нет активной сессии отладки 1С (debugType=onec) в этом окне Cursor.');
	}
	return session.customRequest(command, args);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BridgeRequest {
	id: string;
	name: string;
	args: Record<string, unknown>;
	createdAt: number;
}

/** Запрос из окна без сессии. Ответ пишет окно, в котором есть onec. */
function bridgeCall(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown | undefined> {
	fs.mkdirSync(BRIDGE_DIR, { recursive: true });
	const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const reqPath = path.join(BRIDGE_DIR, `req-${id}.json`);
	const resPath = path.join(BRIDGE_DIR, `res-${id}.json`);
	const body: BridgeRequest = { id, name, args, createdAt: Date.now() };
	fs.writeFileSync(reqPath, JSON.stringify(body), 'utf8');
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tick = (): void => {
			try {
				if (fs.existsSync(resPath)) {
					const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8')) as { result?: unknown; error?: string };
					try {
						fs.unlinkSync(resPath);
					} catch {
						// уже снят
					}
					try {
						fs.unlinkSync(reqPath);
					} catch {
						// окно с сессией уже удалило запрос
					}
					if (parsed.error) {
						resolve(toolText(parsed.error, true));
						return;
					}
					resolve(parsed.result);
					return;
				}
			} catch {
				// файл ещё пишется
			}
			if (Date.now() >= deadline) {
				try {
					fs.unlinkSync(reqPath);
				} catch {
					// игнорируем
				}
				resolve(undefined);
				return;
			}
			setTimeout(tick, 40);
		};
		tick();
	});
}

/** DAP-шаг (F10/F11/…), затем ждём обновления снимка стека. */
async function stepAndWait(dapCommand: 'next' | 'stepIn' | 'stepOut' | 'continue', threadId: number): Promise<unknown> {
	const before = getAgentDebugSnapshot()?.updatedAt ?? '';
	await dapRequest(dapCommand, { threadId });
	if (dapCommand === 'continue') {
		return toolText(
			JSON.stringify(
				{
					action: 'continue',
					hint: 'Выполнение продолжено до следующей точки останова. После останова вызовите onec_debug_stack.',
				},
				null,
				2,
			),
		);
	}
	const deadline = Date.now() + 2500;
	while (Date.now() < deadline) {
		await sleep(80);
		const snap = getAgentDebugSnapshot();
		if (snap?.updatedAt && snap.updatedAt !== before) {
			return toolText(JSON.stringify({ action: dapCommand, snapshot: snap }, null, 2));
		}
	}
	return toolText(
		JSON.stringify(
			{
				action: dapCommand,
				warning: 'Стек ещё не обновился. Подождите и вызовите onec_debug_stack.',
				snapshot: getAgentDebugSnapshot(),
			},
			null,
			2,
		),
	);
}

function workspaceRoot(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function listOnecLaunchConfigNames(): string[] {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return [];
	const cfgs =
		vscode.workspace.getConfiguration('launch', folder.uri).get<Array<{ type?: string; name?: string }>>('configurations') ??
		[];
	return cfgs.filter((c) => c.type === 'onec' && c.name).map((c) => String(c.name));
}

/** Ищет .bsl: абсолютный путь, корень workspace, src/cf, src/cfe/<расширение>. */
function resolveBslPath(rawPath: string, extensionName?: string): string {
	const raw = rawPath.trim().replace(/\\/g, '/');
	if (!raw) return '';
	const root = workspaceRoot();
	const candidates: string[] = [];
	if (path.isAbsolute(rawPath.trim())) candidates.push(rawPath.trim());
	if (root) {
		candidates.push(path.join(root, rawPath.trim()));
		candidates.push(path.join(root, 'src', 'cf', rawPath.trim()));
		const ext = (extensionName ?? '').trim();
		if (ext) candidates.push(path.join(root, 'src', 'cfe', ext, rawPath.trim()));
		const cfeBase = path.join(root, 'src', 'cfe');
		if (fs.existsSync(cfeBase) && fs.statSync(cfeBase).isDirectory()) {
			for (const e of fs.readdirSync(cfeBase, { withFileTypes: true })) {
				if (e.isDirectory()) candidates.push(path.join(cfeBase, e.name, rawPath.trim()));
			}
		}
	}
	for (const c of candidates) {
		try {
			if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
		} catch {
			// skip
		}
	}
	return '';
}

function listSourceBreakpoints(): Array<{ file: string; line: number; enabled: boolean }> {
	const out: Array<{ file: string; line: number; enabled: boolean }> = [];
	for (const bp of vscode.debug.breakpoints) {
		if (!(bp instanceof vscode.SourceBreakpoint)) continue;
		out.push({
			file: bp.location.uri.fsPath,
			line: bp.location.range.start.line + 1,
			enabled: bp.enabled,
		});
	}
	return out;
}

async function waitForOnecSession(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getOnecDebugSession()) return true;
		await sleep(150);
	}
	return !!getOnecDebugSession();
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	if (name === 'onec_debug_status') {
		const session = getOnecDebugSession();
		const snap = getAgentDebugSnapshot();
		const dbgs = getLastDbgsLaunch();
		const cfgPort = session?.configuration?.debugServerPort;
		return toolText(
			JSON.stringify(
				{
					hasOnecSession: session?.type === 'onec',
					sessionName: session?.name ?? null,
					mcpBuild: 'owner-3',
					extensionHostPid: process.pid,
					debugOwnerPid: readMcpOwner()?.pid ?? null,
					debugOwnerRoot: readMcpOwner()?.rootProject ?? null,
					mcpUrl: listenUrl || null,
					debugServerHost: snap?.debugServerHost ?? dbgs?.debugServer ?? null,
					debugServerPort: snap?.debugServerPort || dbgs?.port || cfgPort || null,
					snapshotFile: getAgentDebugSnapshotFile(),
					launchConfigs: listOnecLaunchConfigNames(),
					breakpoints: listSourceBreakpoints(),
					snapshot: snap,
				},
				null,
				2,
			),
		);
	}
	if (name === 'onec_debug_stack') {
		const snap = getAgentDebugSnapshot();
		if (!snap?.frames.length) {
			return toolText(
				'Стек пуст: нет останова или снимок ещё не записан. Остановитесь на точке в модуле BSL, затем вызовите инструмент снова. Файл: ' +
					getAgentDebugSnapshotFile(),
				true,
			);
		}
		return toolText(JSON.stringify(snap, null, 2));
	}
	if (name === 'onec_debug_variables') {
		const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
		const threads = (await dapRequest('threads')) as { threads?: Array<{ id: number }> };
		const tid = threads?.threads?.[threadId - 1]?.id ?? threads?.threads?.[0]?.id ?? threadId;
		const stack = (await dapRequest('stackTrace', { threadId: tid, startFrame: 0, levels: 1 })) as {
			stackFrames?: Array<{ id: number; name: string; line: number; source?: { path?: string } }>;
		};
		const frame = stack?.stackFrames?.[0];
		if (!frame) return toolText('Нет кадра стека (процесс не остановлен?).', true);
		const scopes = (await dapRequest('scopes', { frameId: frame.id })) as {
			scopes?: Array<{ name: string; variablesReference: number }>;
		};
		const out: unknown[] = [];
		for (const sc of scopes?.scopes ?? []) {
			if (!sc.variablesReference) continue;
			const vars = (await dapRequest('variables', { variablesReference: sc.variablesReference })) as {
				variables?: Array<{ name: string; value: string; type?: string }>;
			};
			out.push({
				scope: sc.name,
				variables: (vars?.variables ?? []).slice(0, 80).map((v) => ({
					name: v.name,
					value: v.value,
					type: v.type,
				})),
			});
		}
		return toolText(JSON.stringify({ frame, scopes: out }, null, 2));
	}
	if (name === 'onec_debug_evaluate') {
		const expression = String(args.expression ?? '').trim();
		if (!expression) return toolText('Нужен параметр expression.', true);
		const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
		const stack = (await dapRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })) as {
			stackFrames?: Array<{ id: number }>;
		};
		const frameId = stack?.stackFrames?.[0]?.id;
		const result = await dapRequest('evaluate', {
			expression,
			frameId,
			context: 'repl',
		});
		return toolText(JSON.stringify(result, null, 2));
	}
	if (name === 'onec_debug_start') {
		const names = listOnecLaunchConfigNames();
		const running = getOnecDebugSession();
		if (running) {
			return toolText(
				JSON.stringify(
					{
						ok: true,
						alreadyRunning: true,
						sessionName: running.name,
						launchConfigs: names,
					},
					null,
					2,
				),
			);
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return toolText('Нет открытой папки workspace.', true);
		const requested = String(args.configurationName ?? args.name ?? '').trim();
		const pick =
			(requested && names.includes(requested) ? requested : '') ||
			names.find((n) => /запуск/i.test(n) && !/присоед/i.test(n)) ||
			names.find((n) => !/присоед|attach/i.test(n)) ||
			names[0];
		if (!pick) {
			return toolText(
				'В launch.json нет конфигурации type=onec. Добавьте launch/attach как в README (Параметры отладки модулей BSL).',
				true,
			);
		}
		const started = await vscode.debug.startDebugging(folder, pick);
		if (!started) return toolText(`Не удалось запустить конфигурацию «${pick}».`, true);
		const ready = await waitForOnecSession(20000);
		return toolText(
			JSON.stringify(
				{
					ok: ready,
					configurationName: pick,
					sessionName: getOnecDebugSession()?.name ?? null,
					hint: 'Поставьте точку: onec_debug_set_breakpoint. Останов будет после попадания в код.',
				},
				null,
				2,
			),
		);
	}
	if (name === 'onec_debug_stop') {
		const session = getOnecDebugSession();
		if (!session) return toolText('Нет активной сессии отладки 1С.', true);
		await vscode.debug.stopDebugging(session);
		return toolText(JSON.stringify({ ok: true, stopped: session.name }, null, 2));
	}
	if (name === 'onec_debug_set_breakpoint') {
		const fileArg = String(args.path ?? args.file ?? '').trim();
		const line = typeof args.line === 'number' ? args.line : parseInt(String(args.line ?? ''), 10);
		const ext = String(args.extensionName ?? args.extension ?? '').trim();
		if (!fileArg || !Number.isFinite(line) || line < 1) {
			return toolText('Нужны path (файл .bsl) и line (номер строки, с 1). Для расширения — extensionName (папка в src/cfe).', true);
		}
		const resolved = resolveBslPath(fileArg, ext || undefined);
		if (!resolved) {
			return toolText(
				`Файл не найден: ${fileArg}. Укажите абсолютный путь или относительно workspace / src/cf / src/cfe/<имя>.`,
				true,
			);
		}
		const uri = vscode.Uri.file(resolved);
		const replaceFile = args.replaceFile === true;
		if (replaceFile) {
			const old = vscode.debug.breakpoints.filter(
				(bp) => bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath.toLowerCase() === resolved.toLowerCase(),
			);
			if (old.length) vscode.debug.removeBreakpoints(old);
		}
		const pos = new vscode.Position(line - 1, 0);
		const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, pos), true);
		vscode.debug.addBreakpoints([bp]);
		return toolText(
			JSON.stringify(
				{
					ok: true,
					file: resolved,
					line,
					breakpoints: listSourceBreakpoints(),
					hint: getOnecDebugSession()
						? 'Точка передана в адаптер. Вызовите код в 1С или onec_debug_continue, затем onec_debug_stack.'
						: 'Точка стоит в редакторе. Запустите отладку: onec_debug_start.',
				},
				null,
				2,
			),
		);
	}
	const stepThread =
		typeof args.threadId === 'number' ? args.threadId : (getAgentDebugSnapshot()?.threads[0]?.id ?? 1);
	if (name === 'onec_debug_step_over') return stepAndWait('next', stepThread);
	if (name === 'onec_debug_step_into') return stepAndWait('stepIn', stepThread);
	if (name === 'onec_debug_step_out') return stepAndWait('stepOut', stepThread);
	if (name === 'onec_debug_continue') return stepAndWait('continue', stepThread);
	return toolText(`Неизвестный инструмент: ${name}`, true);
}

let bridgePumping = false;

/** Окно с сессией onec исполняет запросы, которые положило окно MCP без сессии. */
async function pumpBridge(): Promise<void> {
	if (bridgePumping || !getOnecDebugSession() || readMcpOwner()?.pid !== process.pid) return;
	bridgePumping = true;
	try {
		if (!fs.existsSync(BRIDGE_DIR)) return;
		const files = fs.readdirSync(BRIDGE_DIR).filter((f) => f.startsWith('req-') && f.endsWith('.json'));
		for (const file of files) {
			const full = path.join(BRIDGE_DIR, file);
			let parsed: BridgeRequest;
			try {
				parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as BridgeRequest;
			} catch {
				continue;
			}
			if (!parsed?.id || Date.now() - parsed.createdAt > 20000) {
				try {
					fs.unlinkSync(full);
				} catch {
					// игнорируем
				}
				continue;
			}
			const resPath = path.join(BRIDGE_DIR, `res-${parsed.id}.json`);
			if (fs.existsSync(resPath)) continue;
			try {
				const result = await callTool(parsed.name, parsed.args ?? {});
				fs.writeFileSync(resPath, JSON.stringify({ result }), 'utf8');
			} catch (e) {
				fs.writeFileSync(
					resPath,
					JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
					'utf8',
				);
			}
			try {
				fs.unlinkSync(full);
			} catch {
				// клиент снимет сам
			}
		}
	} finally {
		bridgePumping = false;
	}
}

const TOOLS = [
	{
		name: 'onec_debug_status',
		description:
			'Статус текущей отладки 1С в этом окне Cursor: есть ли сессия type=onec, путь к JSON-снимку стека, последний Call Stack.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'onec_debug_stack',
		description:
			'Call stack текущей остановленной отладки 1С: модуль, строка, путь к .bsl (основная конфигурация и расширения).',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'onec_debug_variables',
		description: 'Локальные переменные верхнего кадра текущей остановленной отладки 1С.',
		inputSchema: {
			type: 'object',
			properties: { threadId: { type: 'number', description: 'ID потока DAP, по умолчанию 1' } },
		},
	},
	{
		name: 'onec_debug_evaluate',
		description: 'Вычислить выражение BSL в текущем кадре отладки 1С (как в Watch / Реплике).',
		inputSchema: {
			type: 'object',
			required: ['expression'],
			properties: {
				expression: { type: 'string' },
				threadId: { type: 'number' },
			},
		},
	},
	{
		name: 'onec_debug_start',
		description:
			'Запустить отладку 1С (конфигурация type=onec из launch.json). Параметр configurationName — имя конфигурации; по умолчанию первая launch (не attach).',
		inputSchema: {
			type: 'object',
			properties: { configurationName: { type: 'string', description: 'Имя из launch.json' } },
		},
	},
	{
		name: 'onec_debug_stop',
		description: 'Остановить текущую сессию отладки 1С.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'onec_debug_set_breakpoint',
		description:
			'Поставить точку останова в модуле BSL (как клик в gutter). path — абсолютный или относительно workspace/src/cf/src/cfe; line — номер строки с 1; extensionName — папка расширения в src/cfe; replaceFile=true сбрасывает другие точки в этом файле.',
		inputSchema: {
			type: 'object',
			required: ['path', 'line'],
			properties: {
				path: { type: 'string' },
				line: { type: 'number' },
				extensionName: { type: 'string' },
				replaceFile: { type: 'boolean' },
			},
		},
	},
	{
		name: 'onec_debug_step_over',
		description: 'Шаг обхода (как F10 / Step Over) в текущей остановленной отладке 1С. После шага возвращает обновлённый стек.',
		inputSchema: {
			type: 'object',
			properties: { threadId: { type: 'number', description: 'ID потока DAP, по умолчанию первый из снимка' } },
		},
	},
	{
		name: 'onec_debug_step_into',
		description: 'Шаг внутрь (как F11 / Step Into) в текущей остановленной отладке 1С. После шага возвращает обновлённый стек.',
		inputSchema: {
			type: 'object',
			properties: { threadId: { type: 'number' } },
		},
	},
	{
		name: 'onec_debug_step_out',
		description: 'Шаг из процедуры (как Shift+F11 / Step Out). После шага возвращает обновлённый стек.',
		inputSchema: {
			type: 'object',
			properties: { threadId: { type: 'number' } },
		},
	},
	{
		name: 'onec_debug_continue',
		description: 'Продолжить выполнение (как F5) до следующей точки останова. Стек обновится после нового останова.',
		inputSchema: {
			type: 'object',
			properties: { threadId: { type: 'number' } },
		},
	},
];

async function handleRpc(msg: JsonRpc): Promise<string> {
	const id = msg.id;
	const method = msg.method ?? '';
	if (method === 'initialize') {
		const requested = String((msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '');
		const protocolVersion = requested === '2024-11-05' ? '2024-11-05' : '2025-03-26';
		return jsonRpcResult(id, {
			protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: SERVER_NAME, version: '2.10.6' },
		});
	}
	if (method === 'notifications/initialized' || method === 'initialized') {
		if (id === undefined) return '';
		return jsonRpcResult(id, {});
	}
	if (method === 'ping') {
		return jsonRpcResult(id, {});
	}
	if (method === 'resources/list' || method === 'resources/templates/list') {
		return jsonRpcResult(id, { resources: [], resourceTemplates: [] });
	}
	if (method === 'prompts/list') {
		return jsonRpcResult(id, { prompts: [] });
	}
	if (method === 'tools/list') {
		return jsonRpcResult(id, { tools: TOOLS });
	}
	if (method === 'tools/call') {
		const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
		const toolName = p.name ?? '';
		try {
			if (foreignDebugOwner()) {
				const slow = /evaluate|variables|step|continue/.test(toolName);
				const bridged = await bridgeCall(toolName, p.arguments ?? {}, slow ? 20000 : 2500);
				if (bridged !== undefined) return jsonRpcResult(id, bridged);
			}
			const result = await callTool(toolName, p.arguments ?? {});
			return jsonRpcResult(id, result);
		} catch (e) {
			return jsonRpcResult(id, toolText(e instanceof Error ? e.message : String(e), true));
		}
	}
	if (id === undefined) return '';
	return jsonRpcError(id, `Метод не поддерживается: ${method}`);
}


/**
 * HTTP-сервер MCP (POST JSON).
 */
function writeJsonRpc(res: http.ServerResponse, body: string): void {
	res.writeHead(200, {
		'Content-Type': 'application/json; charset=utf-8',
		'Mcp-Session-Id': MCP_SESSION_ID,
		'Cache-Control': 'no-cache',
	});
	res.end(body);
}

async function handleMcpPost(res: http.ServerResponse, raw: string, hop = false): Promise<void> {
	if (!raw.trim()) {
		res.writeHead(202).end();
		return;
	}
	if (!hop) {
		const forwarded = await forwardToDebugOwner(raw);
		if (forwarded) {
			writeJsonRpc(res, forwarded);
			return;
		}
	}
	const parsed = JSON.parse(raw) as JsonRpc | JsonRpc[];
	const messages = Array.isArray(parsed) ? parsed : [parsed];
	const bodies: string[] = [];
	for (const msg of messages) {
		const body = await handleRpc(msg);
		if (body) bodies.push(body);
	}
	if (bodies.length === 0) {
		res.writeHead(202).end();
		return;
	}
	writeJsonRpc(res, bodies.length === 1 ? bodies[0] : `[${bodies.join(',')}]`);
}

export function startAgentDebugMcp(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => {
			if (session.type !== 'onec') return;
			trackedOnecSession = session;
			startSessionBridge();
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			if (trackedOnecSession?.id === session.id) {
				trackedOnecSession = undefined;
				clearMcpOwnerFile();
			}
		}),
		vscode.debug.onDidChangeActiveDebugSession((session) => {
			if (session?.type === 'onec') trackedOnecSession = session;
		}),
	);
	const already = vscode.debug.activeDebugSession;
	if (already?.type === 'onec') trackedOnecSession = already;
	const bridgePump = setInterval(() => {
		void pumpBridge();
	}, 80);
	context.subscriptions.push({
		dispose: () => clearInterval(bridgePump),
	});

	const onMcpRequest: http.RequestListener = (req, res) => {
		const urlPath = (req.url ?? '/').split('?')[0];
		if (urlPath.includes('well-known') || urlPath.includes('oauth')) {
			res.writeHead(404).end();
			return;
		}
		if (req.method === 'OPTIONS') {
			res.writeHead(204, {
				Allow: 'POST, OPTIONS, DELETE',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
				'Access-Control-Allow-Methods': 'POST, OPTIONS, DELETE',
			});
			res.end();
			return;
		}
		// Не держим GET/SSE: Cursor тогда вешает POST (таймаут user-1c-debug / tools).
		if (req.method === 'GET') {
			res.writeHead(405, { Allow: 'POST, OPTIONS, DELETE' }).end();
			return;
		}
		if (req.method === 'DELETE') {
			res.writeHead(200).end();
			return;
		}
		if (req.method !== 'POST') {
			res.writeHead(405, { Allow: 'POST, OPTIONS, DELETE' }).end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const hop = req.headers['x-debug-mcp-hop'] === '1';
			void (async () => {
				try {
					await handleMcpPost(res, Buffer.concat(chunks).toString('utf8'), hop);
				} catch (e) {
					if (!res.headersSent) {
						res.writeHead(400, { 'Content-Type': 'application/json' });
					}
					res.end(jsonRpcError(null, e instanceof Error ? e.message : String(e)));
				}
			})();
		});
	};
	function startSessionBridge(): void {
		if (sessionBridge) {
			writeMcpOwnerFile();
			registerCursorMcp();
			return;
		}
		const bridge = http.createServer(onMcpRequest);
		sessionBridge = bridge;
		bridge.on('error', () => {
			// 18790 занят другим окном: владелец будет доступен по основному порту этого окна.
			sessionBridge = undefined;
			writeMcpOwnerFile();
		});
		bridge.listen(SESSION_BRIDGE_PORT, '127.0.0.1', () => {
			sessionBridgeUrl = `http://127.0.0.1:${SESSION_BRIDGE_PORT}/mcp`;
			writeMcpOwnerFile();
			registerCursorMcp();
		});
		writeMcpOwnerFile();
	}

	armDebugBridge = startSessionBridge;

	if (getOnecDebugSession()) startSessionBridge();

	const attachListen = (port: number): void => {
		server = http.createServer(onMcpRequest);
		server.on('error', (err: NodeJS.ErrnoException) => {
			// Занятый порт — это другое окно. Не регистрируем его URL, слушаем следующий.
			if (err.code === 'EADDRINUSE' && port < MCP_PORT + 4) {
				attachListen(port + 1);
			}
		});
		server.listen(port, '127.0.0.1', () => {
			listenUrl = `http://127.0.0.1:${port}/mcp`;
			registerCursorMcp();
			// Файл владельца пишет только окно с сессией, иначе чужой MCP затирает адрес.
			if (pendingDebugEndpoint || getOnecDebugSession()) writeMcpOwnerFile();
		});
	};
	attachListen(MCP_PORT);
	context.subscriptions.push({ dispose: stopAgentDebugMcp });
}

/** Останавливает HTTP MCP и снимает регистрацию в Cursor. */
export function stopAgentDebugMcp(): void {
	const cursorMcp = (vscode as unknown as { cursor?: { mcp?: { unregisterServer: (n: string) => void } } }).cursor?.mcp;
	try {
		cursorMcp?.unregisterServer?.(SERVER_NAME);
		cursorMcp?.unregisterServer?.('extension-1c-debug');
	} catch {
		// игнорируем
	}
	if (server) {
		server.close();
		server = undefined;
	}
	if (sessionBridge) {
		sessionBridge.close();
		sessionBridge = undefined;
		sessionBridgeUrl = '';
	}
	clearMcpOwnerFile();
}

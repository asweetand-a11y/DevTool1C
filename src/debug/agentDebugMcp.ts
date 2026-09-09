/**
 * MCP для агента Cursor: стек и переменные текущей сессии отладки 1С (type=onec).
 * HTTP на 127.0.0.1, только POST JSON. Регистрация через vscode.cursor.mcp.registerServer.
 * ~/.cursor/mcp.json не трогаем — иначе при открытии проекта каша User/extension записей.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getAgentDebugSnapshot, getAgentDebugSnapshotFile } from './agentDebugSnapshot';

const SERVER_NAME = '1c-debug';
/** Фиксированный порт: случайный после Reload расходится с URL в mcp.json — вызовы зависают. */
const MCP_PORT = 18791;
const MCP_SESSION_ID = '1c-debug-session';

let server: http.Server | undefined;
let listenUrl = '';

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
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'onec') {
		throw new Error('Нет активной сессии отладки 1С (debugType=onec) в этом окне Cursor.');
	}
	return session.customRequest(command, args);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		if (vscode.debug.activeDebugSession?.type === 'onec') return true;
		await sleep(150);
	}
	return vscode.debug.activeDebugSession?.type === 'onec';
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	if (name === 'onec_debug_status') {
		const session = vscode.debug.activeDebugSession;
		const snap = getAgentDebugSnapshot();
		return toolText(
			JSON.stringify(
				{
					hasOnecSession: session?.type === 'onec',
					sessionName: session?.name ?? null,
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
		if (vscode.debug.activeDebugSession?.type === 'onec') {
			return toolText(
				JSON.stringify(
					{
						ok: true,
						alreadyRunning: true,
						sessionName: vscode.debug.activeDebugSession.name,
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
					sessionName: vscode.debug.activeDebugSession?.name ?? null,
					hint: 'Поставьте точку: onec_debug_set_breakpoint. Останов будет после попадания в код.',
				},
				null,
				2,
			),
		);
	}
	if (name === 'onec_debug_stop') {
		const session = vscode.debug.activeDebugSession;
		if (!session || session.type !== 'onec') return toolText('Нет активной сессии отладки 1С.', true);
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
					hint: vscode.debug.activeDebugSession?.type === 'onec'
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
		try {
			const result = await callTool(p.name ?? '', p.arguments ?? {});
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

async function handleMcpPost(res: http.ServerResponse, raw: string): Promise<void> {
	if (!raw.trim()) {
		res.writeHead(202).end();
		return;
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
	server = http.createServer((req, res) => {
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
			void (async () => {
				try {
					await handleMcpPost(res, Buffer.concat(chunks).toString('utf8'));
				} catch (e) {
					if (!res.headersSent) {
						res.writeHead(400, { 'Content-Type': 'application/json' });
					}
					res.end(jsonRpcError(null, e instanceof Error ? e.message : String(e)));
				}
			})();
		});
	});
	const afterListen = (): void => {
		listenUrl = `http://127.0.0.1:${MCP_PORT}/mcp`;
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
	};
	server.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EADDRINUSE') afterListen();
	});
	server.listen(MCP_PORT, '127.0.0.1', afterListen);
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
}

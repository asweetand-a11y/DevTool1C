/**
 * Webview «Предметы отладки» для режима attach: доступные и подключённые цели RDBG.
 */

import * as vscode from 'vscode';
import { getWebviewPanelOptions, wrapWebviewHtml } from '../webview/webviewAssets';

/** Строка цели с сервера (customRequest onec.getDebugTargets). */
export interface PickerTargetRow {
	id: string;
	userName: string;
	targetType: string;
	typeDisplay: string;
	seanceId: string;
	seanceNo: number | null;
}

let currentPanel: vscode.WebviewPanel | undefined;
let boundSession: vscode.DebugSession | undefined;

function getPickerHtml(webview: vscode.Webview): string {
	const body = `
	<div class="input-row">
		<vscode-textfield id="dbgHost" placeholder="localhost">Сервер</vscode-textfield>
		<vscode-textfield id="dbgPort" placeholder="1560">Порт</vscode-textfield>
		<vscode-button id="btnApplyEndpoint">Применить</vscode-button>
	</div>
	<div class="toolbar">
		<vscode-button id="btnRefresh">Обновить</vscode-button>
		<vscode-button id="btnConnect" secondary>Подключить</vscode-button>
	</div>
	<h3>Доступные предметы отладки</h3>
	<vscode-table zebra bordered>
		<vscode-table-header slot="header">
			<vscode-table-header-cell>Пользователь</vscode-table-header-cell>
			<vscode-table-header-cell>Тип</vscode-table-header-cell>
			<vscode-table-header-cell>Сеанс</vscode-table-header-cell>
		</vscode-table-header>
		<vscode-table-body slot="body" id="tblAvail"></vscode-table-body>
	</vscode-table>
	<h3>Подключенные предметы отладки</h3>
	<div class="toolbar">
		<vscode-button id="btnDisconnect" secondary>Отключить</vscode-button>
		<vscode-button id="btnSuspend" secondary>Остановить</vscode-button>
		<vscode-button id="btnTerminate" secondary>Завершить</vscode-button>
	</div>
	<vscode-table zebra bordered>
		<vscode-table-header slot="header">
			<vscode-table-header-cell>Пользователь</vscode-table-header-cell>
			<vscode-table-header-cell>Тип</vscode-table-header-cell>
			<vscode-table-header-cell>Сеанс</vscode-table-header-cell>
		</vscode-table-header>
		<vscode-table-body slot="body" id="tblConn"></vscode-table-body>
	</vscode-table>
	<div class="status" id="status"></div>`;

	const extraScript = `
		const vscode = acquireVsCodeApi();
		let selectedAvailId = '';
		let selectedConnId = '';

		function seanceCell(row) {
			if (row.seanceNo != null && row.seanceNo !== '') return String(row.seanceNo);
			if (row.seanceId) return row.seanceId;
			return '—';
		}

		function clearSelection() {
			document.querySelectorAll('#tblAvail vscode-table-row, #tblConn vscode-table-row').forEach((r) => r.classList.remove('selected'));
		}

		function renderRows(tbodyId, rows, which) {
			const tb = document.getElementById(tbodyId);
			tb.replaceChildren();
			if (!rows || rows.length === 0) {
				const empty = document.createElement('vscode-table-row');
				const cell = document.createElement('vscode-table-cell');
				cell.textContent = '(пусто)';
				empty.appendChild(cell);
				empty.appendChild(document.createElement('vscode-table-cell'));
				empty.appendChild(document.createElement('vscode-table-cell'));
				tb.appendChild(empty);
				return;
			}
			for (const row of rows) {
				const tr = document.createElement('vscode-table-row');
				tr.dataset.id = row.id;
				const pick = which === 'avail' ? selectedAvailId : selectedConnId;
				if (row.id === pick) tr.classList.add('selected');
				const cells = [row.userName || '', row.typeDisplay || row.targetType || '', seanceCell(row)];
				for (const text of cells) {
					const td = document.createElement('vscode-table-cell');
					td.textContent = text;
					tr.appendChild(td);
				}
				tr.addEventListener('click', () => {
					if (which === 'avail') {
						selectedAvailId = row.id;
						selectedConnId = '';
					} else {
						selectedConnId = row.id;
						selectedAvailId = '';
					}
					clearSelection();
					tr.classList.add('selected');
				});
				tb.appendChild(tr);
			}
		}

		function setEndpointFields(host, port, force) {
			const h = document.getElementById('dbgHost');
			const p = document.getElementById('dbgPort');
			if (force || !h.value) h.value = host || '';
			if (force || !p.value) p.value = port != null && port !== '' ? String(port) : '';
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'data') {
				if (msg.debugServerHost != null || msg.debugServerPort != null) {
					setEndpointFields(msg.debugServerHost, msg.debugServerPort, !!msg.fillEndpoint);
				}
				renderRows('tblAvail', msg.available || [], 'avail');
				renderRows('tblConn', msg.connected || [], 'conn');
				const st = document.getElementById('status');
				st.textContent = msg.status || '';
				st.className = 'status' + (msg.error ? ' err' : '');
				document.querySelectorAll('#tblAvail vscode-table-row').forEach((tr) => {
					if (tr.dataset.id === selectedAvailId) tr.classList.add('selected');
				});
				document.querySelectorAll('#tblConn vscode-table-row').forEach((tr) => {
					if (tr.dataset.id === selectedConnId) tr.classList.add('selected');
				});
			}
		});

		document.getElementById('btnApplyEndpoint').addEventListener('click', () => {
			const host = (document.getElementById('dbgHost').value || '').trim();
			const port = parseInt(String(document.getElementById('dbgPort').value || '').trim(), 10);
			vscode.postMessage({ type: 'setEndpoint', host, port });
		});
		document.getElementById('btnRefresh').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh' });
		});
		document.getElementById('btnConnect').addEventListener('click', () => {
			if (!selectedAvailId) return;
			vscode.postMessage({ type: 'connect', id: selectedAvailId });
		});
		document.getElementById('btnDisconnect').addEventListener('click', () => {
			if (!selectedConnId) return;
			vscode.postMessage({ type: 'disconnect', id: selectedConnId });
		});
		document.getElementById('btnSuspend').addEventListener('click', () => {
			if (!selectedConnId) return;
			vscode.postMessage({ type: 'suspend', id: selectedConnId });
		});
		document.getElementById('btnTerminate').addEventListener('click', () => {
			if (!selectedConnId) return;
			vscode.postMessage({ type: 'terminate', id: selectedConnId });
		});

		vscode.postMessage({ type: 'ready' });
	`;

	return wrapWebviewHtml(webview, body, '', extraScript);
}

/** VS Code отдаёт либо тело ответа, либо объект с полем body — нормализуем. */
function normalizePickerPayload(raw: unknown): {
	available: PickerTargetRow[];
	connected: PickerTargetRow[];
	debugServerHost?: string;
	debugServerPort?: number;
} {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
	const inner =
		o && 'body' in o && o.body !== null && typeof o.body === 'object'
			? (o.body as Record<string, unknown>)
			: o;
	const a = inner?.available;
	const c = inner?.connected;
	const host = typeof inner?.debugServerHost === 'string' ? inner.debugServerHost : undefined;
	const portRaw = inner?.debugServerPort;
	const port = typeof portRaw === 'number' ? portRaw : undefined;
	return {
		available: Array.isArray(a) ? (a as PickerTargetRow[]) : [],
		connected: Array.isArray(c) ? (c as PickerTargetRow[]) : [],
		debugServerHost: host,
		debugServerPort: port,
	};
}

function postPicker(
	panel: vscode.WebviewPanel,
	session: vscode.DebugSession,
	available: PickerTargetRow[],
	connected: PickerTargetRow[],
	debugServerHost: string | undefined,
	debugServerPort: number | undefined,
	status: string | undefined,
	isError: boolean,
	fillEndpoint: boolean,
): void {
	const cfg = session.configuration;
	const host = debugServerHost || String(cfg.debugServerHost ?? 'localhost');
	const port = debugServerPort ?? cfg.debugServerPort ?? '';
	const counts = `Доступно: ${available.length}, подключено: ${connected.length}.`;
	const hint =
		available.length === 0 && connected.length === 0
			? ` Сервер ${host}:${port}. Если предметы на другом порту диапазона — укажите его и нажмите «Применить».`
			: '';
	panel.webview.postMessage({
		type: 'data',
		available,
		connected,
		debugServerHost: host,
		debugServerPort: port,
		fillEndpoint,
		status: [status, counts + hint].filter(Boolean).join(' '),
		error: isError,
	});
}

async function fetchAndPost(
	panel: vscode.WebviewPanel,
	session: vscode.DebugSession,
	status?: string,
	isError?: boolean,
	fillEndpoint = false,
): Promise<void> {
	try {
		const raw = await session.customRequest('onec.getDebugTargets', {});
		const { available, connected, debugServerHost, debugServerPort } = normalizePickerPayload(raw);
		postPicker(panel, session, available, connected, debugServerHost, debugServerPort, status, !!isError, fillEndpoint);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		panel.webview.postMessage({
			type: 'data',
			available: [],
			connected: [],
			status: msg,
			error: true,
		});
	}
}

/**
 * Открывает или показывает панель выбора целей для сессии отладки 1С (attach).
 */
export function showDebugTargetsPicker(_context: vscode.ExtensionContext, session: vscode.DebugSession): void {
	if (session.type !== 'onec' || session.configuration?.request !== 'attach') {
		void vscode.window.showWarningMessage('Панель доступна только для конфигурации отладки 1С с request: attach.');
		return;
	}

	boundSession = session;

	if (currentPanel) {
		currentPanel.title = 'Предметы отладки (1С)';
		currentPanel.reveal(vscode.ViewColumn.Beside);
		void fetchAndPost(currentPanel, session);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'onecDebugTargetsPicker',
		'Предметы отладки (1С)',
		vscode.ViewColumn.Beside,
		getWebviewPanelOptions(true),
	);
	currentPanel = panel;

	panel.onDidDispose(() => {
		currentPanel = undefined;
		boundSession = undefined;
	});

	panel.webview.html = getPickerHtml(panel.webview);

	panel.webview.onDidReceiveMessage(
		async (msg: { type?: string; id?: string; host?: string; port?: number }) => {
			const sess = boundSession;
			if (!sess || !sess.configuration || sess.type !== 'onec') {
				void vscode.window.showWarningMessage('Сессия отладки 1С не активна.');
				return;
			}
			const active = vscode.debug.activeDebugSession;
			if (active && active.id !== sess.id) {
				boundSession = active.type === 'onec' && active.configuration?.request === 'attach' ? active : sess;
			}
			const s = boundSession!;
			try {
				switch (msg.type) {
					case 'ready':
						await fetchAndPost(panel, s, undefined, false, true);
						break;
					case 'setEndpoint': {
						const host = (msg.host ?? '').trim();
						const port = typeof msg.port === 'number' ? msg.port : parseInt(String(msg.port ?? ''), 10);
						await s.customRequest('onec.setDebugServer', { host, port });
						await fetchAndPost(panel, s, `Сервер отладки: ${host}:${port}`, false, true);
						break;
					}
					case 'refresh':
						await fetchAndPost(panel, s, 'Список обновлён');
						break;
					case 'connect': {
						const id = (msg.id ?? '').trim();
						if (!id) return;
						await s.customRequest('onec.connectTargets', { ids: [id] });
						await fetchAndPost(panel, s, 'Цель подключена');
						break;
					}
					case 'disconnect': {
						const id = (msg.id ?? '').trim();
						if (!id) return;
						await s.customRequest('onec.disconnectTarget', { id });
						await fetchAndPost(panel, s, 'Цель отключена');
						break;
					}
					case 'suspend': {
						const id = (msg.id ?? '').trim();
						if (!id) return;
						await s.customRequest('onec.suspendTarget', { id });
						await fetchAndPost(panel, s, 'Запрошена остановка на следующей инструкции');
						break;
					}
					case 'terminate': {
						const id = (msg.id ?? '').trim();
						if (!id) return;
						const chk = (await s.customRequest('onec.checkTargetCanTerminate', { id })) as { canTerminate?: boolean };
						if (chk.canTerminate === false) {
							const go = await vscode.window.showWarningMessage(
								'Платформа сообщает, что завершение этой цели недоступно. Продолжить?',
								{ modal: true },
								'Да',
								'Нет',
							);
							if (go !== 'Да') {
								await fetchAndPost(panel, s);
								return;
							}
						} else {
							const ok = await vscode.window.showWarningMessage(
								'Завершить предмет отладки (сеанс 1С)?',
								{ modal: true },
								'Завершить',
								'Отмена',
							);
							if (ok !== 'Завершить') {
								await fetchAndPost(panel, s);
								return;
							}
						}
						await s.customRequest('onec.terminateTarget', { id });
						await fetchAndPost(panel, s, 'Запрос на завершение отправлен');
						break;
					}
					default:
						break;
				}
			} catch (e) {
				const err = e instanceof Error ? e.message : String(e);
				await fetchAndPost(panel, s, err, true);
			}
		},
		undefined,
		[],
	);
}

/**
 * Снимок текущей сессии отладки 1С для агента (MCP и файл).
 * Адаптер inline живёт в том же процессе, что и MCP.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StackItemViewInfoData } from './rdbgTypes';
import {
	getExtendingModules,
	getModulePathByModuleIdStr,
	getModulePathByObjectProperty,
	getModulePathFromStackPresentation,
} from './metadataProvider';

/** Кадр стека, понятный агенту (путь к .bsl и строка). */
export interface AgentDebugFrame {
	threadId: number;
	presentation: string;
	line: number;
	sourcePath: string;
	extensionName: string;
}

/** Снимок остановленной сессии отладки. */
export interface AgentDebugSnapshot {
	updatedAt: string;
	attached: boolean;
	rootProject: string;
	snapshotFile: string;
	threads: Array<{ id: number; label: string }>;
	frames: AgentDebugFrame[];
}

const SNAPSHOT_FILE = path.join(os.tmpdir(), '1c-dev-tools-debug-snapshot.json');

let current: AgentDebugSnapshot | null = null;

/** Путь к JSON-снимку (можно читать из любого чата агента на этой машине). */
export function getAgentDebugSnapshotFile(): string {
	return SNAPSHOT_FILE;
}

/** Последний снимок или null, если сессии нет / ещё не было останова. */
export function getAgentDebugSnapshot(): AgentDebugSnapshot | null {
	return current;
}

/** Сбрасывает снимок при отключении отладки. */
export function clearAgentDebugSnapshot(): void {
	current = null;
	try {
		if (fs.existsSync(SNAPSHOT_FILE)) fs.unlinkSync(SNAPSHOT_FILE);
	} catch {
		// игнорируем
	}
}

function resolveSourcePath(root: string, item: StackItemViewInfoData): string {
	const objectId = (item.moduleId?.objectId ?? '').trim();
	const propertyId = (item.moduleId?.propertyId ?? '').trim();
	const extensionName = (item.moduleId?.extensionName ?? '').trim();
	let sourcePath = '';
	if (objectId && propertyId) {
		sourcePath = getModulePathByObjectProperty(root, objectId, propertyId, extensionName);
	}
	if (!sourcePath && item.moduleIdStr?.trim()) {
		sourcePath = getModulePathByModuleIdStr(root, item.moduleIdStr, extensionName);
	}
	if (sourcePath && propertyId === 'a637f77f-3840-441d-a1c3-699c8c5cb7e0') {
		const presentation = (item.presentation ?? '').trim();
		if (presentation && extensionName === '') {
			for (const em of getExtendingModules(root, objectId)) {
				if (presentation.toLowerCase().startsWith(em.extension.toLowerCase() + '_')) {
					sourcePath = em.bslPath;
					break;
				}
			}
		}
	}
	if (!sourcePath) {
		sourcePath = getModulePathFromStackPresentation(root, item.presentation ?? '', extensionName);
	}
	if (sourcePath && !path.isAbsolute(sourcePath)) sourcePath = path.resolve(root, sourcePath);
	return sourcePath;
}

/**
 * Публикует снимок после CallStackFormed / обновления стека.
 */
export function publishAgentDebugSnapshot(args: {
	attached: boolean;
	rootProject: string;
	targets: Array<{ userName?: string; targetType?: string }>;
	stacks: Map<number, StackItemViewInfoData[]>;
}): void {
	const frames: AgentDebugFrame[] = [];
	const threads: AgentDebugSnapshot['threads'] = [];
	const root = args.rootProject || '';
	for (const [threadId, stack] of args.stacks) {
		const t = args.targets[threadId - 1];
		threads.push({
			id: threadId,
			label: [t?.targetType, t?.userName].filter(Boolean).join(', ') || `thread ${threadId}`,
		});
		for (const item of stack) {
			const line = typeof item.lineNo === 'number' ? item.lineNo : parseInt(String(item.lineNo ?? 0), 10) || 0;
			frames.push({
				threadId,
				presentation: String(item.presentation ?? '').trim(),
				line,
				sourcePath: resolveSourcePath(root, item),
				extensionName: (item.moduleId?.extensionName ?? '').trim(),
			});
		}
	}
	current = {
		updatedAt: new Date().toISOString(),
		attached: args.attached,
		rootProject: root,
		snapshotFile: SNAPSHOT_FILE,
		threads,
		frames,
	};
	try {
		fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
		fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(current, null, 2), 'utf8');
	} catch {
		// игнорируем ошибку записи
	}
}

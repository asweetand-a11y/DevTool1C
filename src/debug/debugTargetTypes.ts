/**
 * Типы целей отладки 1С (targetType в RDBG, setAutoAttachSettings).
 * Синхронизировать enum в package.json (launch/attach) при изменении списка.
 */

/** Полный перечень типов, поддерживаемых платформой для автоподключения. */
export const RDBG_AUTO_ATTACH_TARGET_TYPES = [
	'Client',
	'ManagedClient',
	'WebClient',
	'ComConnector',
	'Server',
	'ServerEmulation',
	'WebService',
	'HttpService',
	'OData',
	'Job',
	'JobFileMode',
	'MobileClient',
	'MobileServer',
	'MobileJobFileMode',
	'MobileManagedClient',
	'MobileManagedServer',
] as const;

export type RdbgAutoAttachTargetType = (typeof RDBG_AUTO_ATTACH_TARGET_TYPES)[number];

const KNOWN_TYPE_SET = new Set<string>(RDBG_AUTO_ATTACH_TARGET_TYPES as readonly string[]);

/** Подтипы, на которые распространяется пресет Client в конфигурации. */
const CLIENT_CONCRETE_TYPES = ['Client', 'ManagedClient', 'WebClient', 'MobileClient'] as const;

/** Подтипы, на которые распространяется пресет Server в конфигурации. */
const SERVER_CONCRETE_TYPES = ['Server', 'ServerEmulation', 'MobileServer'] as const;

/**
 * Строки в XML targetType для setAutoAttachSettings (XmlEnum у DebugTargetType в Messages.cs onec-debug-adapter).
 * В launch.json по-прежнему канонические имена: WebClient, Job, …
 */
const SET_AUTO_ATTACH_XML_ENUM: Record<string, string> = {
	Client: 'Client',
	ManagedClient: 'ManagedClient',
	WebClient: 'WEBClient',
	ComConnector: 'COMConnector',
	Server: 'Server',
	ServerEmulation: 'ServerEmulation',
	WebService: 'WEBService',
	HttpService: 'HTTPService',
	OData: 'OData',
	Job: 'JOB',
	JobFileMode: 'JobFileMode',
	MobileClient: 'MobileClient',
	MobileServer: 'MobileServer',
	MobileJobFileMode: 'MobileJobFileMode',
	MobileManagedClient: 'MobileManagedClient',
	MobileManagedServer: 'MobileManagedServer',
};

/** Значение текста внутри &lt;targetType&gt; для RDBG (не совпадает с именами в launch.json для части типов). */
export function toSetAutoAttachTargetTypeXmlValue(canonicalType: string): string {
	return SET_AUTO_ATTACH_XML_ENUM[canonicalType] ?? canonicalType;
}

/** Нормализация targetType из getDbgTargets к имени как в launch.json. */
export function canonicalizeDbgTargetType(targetType: string): string {
	const t = targetType.trim();
	const hit = Object.entries(SET_AUTO_ATTACH_XML_ENUM).find(([, xml]) => xml === t);
	return hit ? hit[0] : t;
}

/** Отображаемое имя типа цели в Call Stack (русский). */
export const TARGET_TYPE_LABELS: Record<string, string> = {
	Client: 'Клиент',
	ManagedClient: 'Клиент (менеджер приложения)',
	WebClient: 'Веб-клиент',
	ComConnector: 'COM-соединитель',
	Server: 'Сервер',
	ServerEmulation: 'Сервер (файловый режим)',
	WebService: 'Веб-сервис',
	HttpService: 'HTTP-сервис',
	OData: 'OData',
	Job: 'Фоновое задание',
	JobFileMode: 'Фоновое задание (файловый режим)',
	MobileClient: 'Мобильный клиент',
	MobileServer: 'Мобильный сервер',
	MobileJobFileMode: 'Мобильное фоновое задание (файловый режим)',
	MobileManagedClient: 'Мобильный клиент (менеджер)',
	MobileManagedServer: 'Мобильный сервер (менеджер)',
};

/**
 * Совпадение типа цели с фильтром из launch.json: точное имя или пресеты Client/Server.
 */
export function matchesAutoAttachType(targetType: string, autoAttachTypes: string[]): boolean {
	const t = canonicalizeDbgTargetType(targetType);
	for (const a of autoAttachTypes) {
		const type = a.trim();
		if (!type) continue;
		if (type === t) return true;
		if (type === 'Client' && /^(Client|ManagedClient|WebClient|MobileClient)$/i.test(t)) return true;
		if (type === 'Server' && /^(Server|ServerEmulation|MobileServer)$/i.test(t)) return true;
	}
	return false;
}

/**
 * Разворачивает пресеты Client/Server в конкретные targetType для setAutoAttachSettings (с дедупликацией).
 */
export function expandAutoAttachTypesForRdbg(configTypes: string[]): Array<{ type: string; autoAttach: boolean }> {
	const seen = new Set<string>();
	const out: Array<{ type: string; autoAttach: boolean }> = [];
	for (const raw of configTypes) {
		const a = raw.trim();
		if (!a) continue;
		const expanded =
			a === 'Client'
				? [...CLIENT_CONCRETE_TYPES]
				: a === 'Server'
					? [...SERVER_CONCRETE_TYPES]
					: [a];
		for (const t of expanded) {
			if (!seen.has(t)) {
				seen.add(t);
				out.push({ type: t, autoAttach: true });
			}
		}
	}
	return out;
}

/** Значения из конфигурации, отсутствующие в справочнике платформы (возможная опечатка). */
export function findUnknownAutoAttachTypes(configTypes: string[]): string[] {
	const unk: string[] = [];
	for (const raw of configTypes) {
		const a = raw.trim();
		if (!a) continue;
		if (!KNOWN_TYPE_SET.has(a)) unk.push(a);
	}
	return unk;
}

export function getTargetTypeDisplayName(targetType: string): string {
	const t = canonicalizeDbgTargetType(targetType ?? '');
	const label = TARGET_TYPE_LABELS[t];
	return label !== undefined ? label : t;
}

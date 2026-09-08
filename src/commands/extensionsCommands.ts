import * as vscode from 'vscode';
import * as path from 'node:path';
import { VRunnerManager } from '../vrunnerManager';
import { BaseCommand } from './baseCommand';
import {
	getLoadExtensionFromSrcCommandName,
	getLoadExtensionFromCfeCommandName,
	getDumpExtensionToSrcCommandName,
	getDumpExtensionToCfeCommandName,
	getDumpUpdateExtensionToSrcCommandName,
	getUpdateExtensionFromSrcWithCommitCommandName,
	getBuildExtensionCommandName,
	getDecompileExtensionCommandName
} from '../commandNames';
import { parseCommitPathLine, toDesignerListFilePath } from '../utils/commitPath';

/**
 * Команды для работы с расширениями конфигурации
 * 
 * Предоставляет методы для загрузки, выгрузки, сборки и разбора расширений конфигурации 1С
 */
export class ExtensionsCommands extends BaseCommand {

	/**
	 * Получает список папок расширений из исходников
	 * 
	 * Расширение 1С определяется по наличию файла Configuration.xml в корне папки.
	 * Метод фильтрует все директории, оставляя только те, которые содержат этот файл.
	 * 
	 * @param workspaceRoot - Корневая директория workspace
	 * @returns Промис, который разрешается массивом имен папок расширений или undefined при ошибке
	 */
	/**
	 * Фильтрует строки из Commit.txt для указанного расширения и приводит пути к формату -listFile
	 * (относительно src/cfe/<имя>), учитывая абсолютные, относительные и «от корня выгрузки» варианты.
	 * 
	 * Путь к файлу расширения должен содержать подстроку `src/cfe/<ИмяРасширения>/`.
	 * Пути могут быть относительными (от workspace root) или абсолютными.
	 * 
	 * @param commitPath - Путь к исходному файлу Commit.txt
	 * @param extensionName - Имя расширения
	 * @param workspaceRoot - Корневая директория workspace
	 * @returns Путь к временному файлу с отфильтрованными строками
	 * @throws Ошибка, если не удалось прочитать исходный файл или создать временный файл
	 */
	private async filterCommitFileByExtension(
		commitPath: string,
		extensionName: string,
		workspaceRoot: string
	): Promise<string> {
		const fs = await import('node:fs/promises');

		let commitContent: string;
		try {
			commitContent = await fs.readFile(commitPath, 'utf-8');
		} catch (error) {
			throw new Error(`Не удалось прочитать файл Commit.txt: ${(error as Error).message}`);
		}

		const context = {
			workspaceRoot,
			srcPath: this.vrunner.getSrcPath(),
			cfePath: this.vrunner.getCfePath()
		};

		const lines = commitContent.split(/\r?\n/);
		const filteredLines: string[] = [];
		const seen = new Set<string>();

		for (const line of lines) {
			const parsed = parseCommitPathLine(line, context);
			if (!parsed || parsed.kind !== 'cfe') {
				continue;
			}
			if (parsed.extensionName?.toLowerCase() !== extensionName.toLowerCase()) {
				continue;
			}

			const listPath = toDesignerListFilePath(parsed.relativePath);
			const key = listPath.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			filteredLines.push(listPath);
		}

		const buildCommitDir = path.join(workspaceRoot, 'build', 'commit');

		try {
			await fs.mkdir(buildCommitDir, { recursive: true });
		} catch (error) {
			throw new Error(`Не удалось создать папку build/commit: ${(error as Error).message}`);
		}

		const tempFileName = `Commit_${extensionName}.txt`;
		const tempFilePath = path.join(buildCommitDir, tempFileName);

		try {
			await fs.writeFile(tempFilePath, filteredLines.join('\n'), 'utf-8');
		} catch (error) {
			throw new Error(`Не удалось создать временный файл ${tempFileName}: ${(error as Error).message}`);
		}

		return tempFilePath;
	}

	private async getExtensionFoldersFromSrc(workspaceRoot: string, silent = false): Promise<string[] | undefined> {
		const cfePath = this.vrunner.getCfePath();
		const extensionsSrcPath = path.isAbsolute(cfePath)
			? cfePath
			: path.join(workspaceRoot, cfePath);

		const fs = await import('node:fs/promises');
		try {
			const stat = await fs.stat(extensionsSrcPath);
			if (!stat.isDirectory()) {
				if (!silent) {
					vscode.window.showErrorMessage(`Папка ${cfePath} не является директорией`);
				}
				return silent ? [] : undefined;
			}
		} catch {
			if (!silent) {
				vscode.window.showErrorMessage(`Папка ${cfePath} не является директорией`);
			}
			return silent ? [] : undefined;
		}

		const allDirectories = await this.getDirectories(extensionsSrcPath, silent ? undefined : `Ошибка при чтении папки ${cfePath}`);
		if (allDirectories.length === 0) {
			if (!silent) {
				vscode.window.showInformationMessage(`В папке ${cfePath} не найдено расширений`);
			}
			return silent ? [] : undefined;
		}

		const extensionFolders: string[] = [];

		for (const dir of allDirectories) {
			const configXmlPath = path.join(extensionsSrcPath, dir, 'Configuration.xml');
			try {
				await fs.access(configXmlPath);
				extensionFolders.push(dir);
			} catch {
				continue;
			}
		}

		if (extensionFolders.length === 0) {
			if (!silent) {
				vscode.window.showInformationMessage(`В папке ${cfePath} не найдено расширений (папки с файлом Configuration.xml)`);
			}
			return silent ? [] : undefined;
		}

		return extensionFolders;
	}

	/**
	 * Возвращает один элемент списка: без вопроса, если он единственный, иначе Quick Pick.
	 * @param items - Имена расширений или файлов .cfe
	 * @param placeHolder - Подсказка в поле выбора
	 * @param title - Заголовок панели выбора
	 * @returns Выбранный элемент или undefined при отмене
	 */
	private async pickOne(items: string[], placeHolder: string, title: string): Promise<string | undefined> {
		const sorted = [...items].sort((a, b) => a.localeCompare(b, 'ru'));
		if (sorted.length === 1) {
			return sorted[0];
		}

		return vscode.window.showQuickPick(sorted, {
			placeHolder,
			title
		});
	}

	/**
	 * Определяет имя расширения для выгрузки из ИБ: папки src/cfe, иначе .cfe в build, иначе ввод имени.
	 * @param workspaceRoot - Корень проекта
	 * @param commandTitle - Заголовок команды для панели выбора
	 * @returns Имя расширения или undefined
	 */
	private async resolveExtensionNameForDump(workspaceRoot: string, commandTitle: string): Promise<string | undefined> {
		const fromSrc = await this.getExtensionFoldersFromSrc(workspaceRoot, true);
		if (fromSrc && fromSrc.length > 0) {
			return this.pickOne(fromSrc, 'Выберите расширение', commandTitle);
		}

		const buildPath = this.vrunner.getBuildPath();
		const cfeBuildPath = path.join(workspaceRoot, buildPath, 'cfe');
		const fs = await import('node:fs/promises');
		try {
			await fs.access(cfeBuildPath);
			const cfeFiles = await this.getFilesByExtension(cfeBuildPath, '.cfe');
			if (cfeFiles.length > 0) {
				const names = cfeFiles.map(file => file.replace(/\.cfe$/i, ''));
				return this.pickOne(names, 'Выберите расширение', commandTitle);
			}
		} catch {
			// Каталога build/out/cfe ещё нет — имя расширения запросим вручную
		}

		const typed = await vscode.window.showInputBox({
			title: commandTitle,
			prompt: 'Введите имя расширения',
			placeHolder: 'ИмяРасширения'
		});
		const name = typed?.trim();
		return name === '' ? undefined : name;
	}

	/**
	 * Загружает расширения из исходников в информационную базу
	 * 
	 * Находит все подпапки в папке расширений и для каждой выполняет команду `compileext`.
	 * Расширения загружаются в информационную базу, указанную в параметрах подключения.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Загружает расширения из исходников в информационную базу
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и загружает их
	 * через v8runner-cli.os. Если расширений несколько — предлагает выбрать одно.
	 * одним вызовом.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Загружает расширения из исходников в информационную базу
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду загрузки через v8runner-cli.os. Каждое расширение загружается из
	 * своего каталога (например, src/cfe/IBS или src/cfe/MOD).
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async loadFromSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const allExtensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!allExtensionFolders) {
			return;
		}

		const cfePath = this.vrunner.getCfePath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadExtensionFromSrcCommandName();

		const selectedExtension = await this.pickOne(allExtensionFolders, 'Выберите расширение', commandName.title);
		if (!selectedExtension) {
			return;
		}
		const extensionFolders = [selectedExtension];

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		const logDir = this.vrunner.getDesignerLoadLogDir();
		const logTs = VRunnerManager.formatDesignerLoadLogTimestamp();
		try {
			await fs.mkdir(logDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(
				`Не удалось создать каталог логов Конфигуратора: ${(error as Error).message}`
			);
			return;
		}

		// Формируем команды для всех расширений
		const commands: string[] = [];

		for (const extensionFolder of extensionFolders) {
			// Формируем абсолютный путь к каталогу конкретного расширения
			const extensionSrcPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionFolder)
				: path.join(workspaceRoot, cfePath, extensionFolder);

			const logFileName =
				extensionFolders.length === 1
					? `load_${logTs}.log`
					: VRunnerManager.buildExtensionDesignerLoadLogFileName(logTs, extensionFolder);
			const loadLogFile = path.join(logDir, logFileName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'loadExtensionFromFiles',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--src', extensionSrcPath,
				'--extension', extensionFolder,
				'--out', loadLogFile
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Загружает расширения из .cfe файлов в информационную базу
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду загрузки
	 * через EPF обработку vanessa-runner. Имена файлов .cfe должны соответствовать именам расширений
	 * (например, Расширение1.cfe для расширения "Расширение1").
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Загружает расширения из .cfe файлов в информационную базу
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду загрузки
	 * через v8runner-cli.os. Имена файлов .cfe должны соответствовать именам расширений
	 * (например, Расширение1.cfe для расширения "Расширение1").
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async loadFromCfe(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const cfePath = path.join(workspaceRoot, buildPath, 'cfe');

		if (!(await this.checkDirectoryExists(cfePath, `Папка ${buildPath}/cfe не является директорией`))) {
			return;
		}

		const allCfeFiles = await this.getFilesByExtension(cfePath, '.cfe', `Ошибка при чтении папки ${buildPath}/cfe`);
		if (allCfeFiles.length === 0) {
			vscode.window.showInformationMessage(`В папке ${buildPath}/cfe не найдено файлов .cfe`);
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadExtensionFromCfeCommandName();

		const selectedCfeFile = await this.pickOne(allCfeFiles, 'Выберите расширение', commandName.title);
		if (!selectedCfeFile) {
			return;
		}
		const cfeFiles = [selectedCfeFile];

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		// Формируем команды для всех .cfe файлов
		const commands: string[] = [];

		for (const cfeFile of cfeFiles) {
			// Извлекаем имя расширения из имени файла (убираем расширение .cfe)
			const extensionName = cfeFile.replace(/\.cfe$/i, '');
			const cfeFilePath = path.join(cfePath, cfeFile);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'loadExtensionFromFile',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--file', cfeFilePath,
				'--extension', extensionName
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Выгружает расширения из информационной базы в исходники
	 * 
	 * Выгружает выбранное расширение командой конфигуратора /DumpConfigToFiles -Extension
	 * для автоматической выгрузки всех расширений из конфигурации 1С в отдельные каталоги.
	 * Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Выгружает расширения из информационной базы в исходники
	 * 
	 * Выгружает выбранное расширение командой конфигуратора /DumpConfigToFiles -Extension
	 * для автоматической выгрузки всех расширений из конфигурации 1С в отдельные каталоги.
	 * Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpToSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpExtensionToSrcCommandName();

		const extensionName = await this.resolveExtensionNameForDump(workspaceRoot, commandName.title);
		if (!extensionName) {
			return;
		}

		const cfePath = this.vrunner.getCfePath();
		const absoluteCfeRoot = path.isAbsolute(cfePath)
			? cfePath
			: path.join(workspaceRoot, cfePath);
		const absoluteCfePath = path.join(absoluteCfeRoot, extensionName);
		
		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		try {
			await fs.mkdir(absoluteCfePath, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(`Ошибка при создании папки ${absoluteCfePath}: ${(error as Error).message}`);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Аргументы для универсального CLI с абсолютными путями
		const args = [
			scriptPath,
			'dumpExtensionToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteCfePath,
			'--extension', extensionName
		];
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}

	/**
	 * Выгружает обновление расширений из информационной базы в исходники
	 * 
	 * Выгружает выбранное расширение командой /DumpConfigToFiles -Extension с параметром -update
	 * для автоматической выгрузки только измененных файлов всех расширений из конфигурации 1С
	 * в отдельные каталоги. Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Выгружает обновление расширений из информационной базы в исходники
	 * 
	 * Выгружает выбранное расширение командой /DumpConfigToFiles -Extension с параметром -update
	 * для автоматической выгрузки только измененных файлов всех расширений из конфигурации 1С
	 * в отдельные каталоги. Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpUpdateToSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpUpdateExtensionToSrcCommandName();

		const extensionName = await this.resolveExtensionNameForDump(workspaceRoot, commandName.title);
		if (!extensionName) {
			return;
		}

		const cfePath = this.vrunner.getCfePath();
		const absoluteCfeRoot = path.isAbsolute(cfePath)
			? cfePath
			: path.join(workspaceRoot, cfePath);
		const absoluteCfePath = path.join(absoluteCfeRoot, extensionName);
		
		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		try {
			await fs.mkdir(absoluteCfePath, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(`Ошибка при создании папки ${absoluteCfePath}: ${(error as Error).message}`);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Аргументы для универсального CLI с абсолютными путями
		const args = [
			scriptPath,
			'dumpExtensionToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteCfePath,
			'--extension', extensionName,
			'--update'
		];
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}

	/**
	 * Обновляет расширения из исходников с использованием файла Commit.txt
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой:
	 * 1. Создает временный файл Commit_<ИмяРасширения>.txt с отфильтрованными строками из Commit.txt
	 * 2. Выполняет команду загрузки расширения через vrunner run --command
	 * 3. Удаляет временный файл
	 * 
	 * После загрузки всех расширений выполняет обновление конфигурации БД через v8runner-cli.os.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Обновляет расширения из исходников с использованием файла Commit.txt
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой:
	 * 1. Создает временный файл Commit_<ИмяРасширения>.txt с отфильтрованными строками из Commit.txt
	 * 2. Выполняет команду загрузки расширения через v8runner-cli.os
	 * 3. Удаляет временный файл
	 * 
	 * После загрузки всех расширений выполняет обновление конфигурации БД через v8runner-cli.os.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async updateFromSrcWithCommit(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const allExtensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!allExtensionFolders) {
			return;
		}

		const commitPath = this.vrunner.getCommitPath();
		const absoluteCommitPath = path.isAbsolute(commitPath)
			? commitPath
			: path.join(workspaceRoot, commitPath);
		
		const cfePath = this.vrunner.getCfePath();
		const absoluteCfePath = path.isAbsolute(cfePath) 
			? cfePath 
			: path.join(workspaceRoot, cfePath);
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getUpdateExtensionFromSrcWithCommitCommandName();

		const selectedExtension = await this.pickOne(allExtensionFolders, 'Выберите расширение', commandName.title);
		if (!selectedExtension) {
			return;
		}
		const extensionFolders = [selectedExtension];

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		const logDir = this.vrunner.getDesignerLoadLogDir();
		const logTs = VRunnerManager.formatDesignerLoadLogTimestamp();
		try {
			await fs.mkdir(logDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(
				`Не удалось создать каталог логов Конфигуратора: ${(error as Error).message}`
			);
			return;
		}

		// Формируем команды для всех расширений
		const commands: string[] = [];
		const tempFiles: string[] = [];

		for (const extensionFolder of extensionFolders) {
			// Создаем временный файл с отфильтрованными строками для расширения
			let tempCommitPath: string;
			try {
				tempCommitPath = await this.filterCommitFileByExtension(
					absoluteCommitPath,
					extensionFolder,
					workspaceRoot
				);
				tempFiles.push(tempCommitPath);
			} catch (error) {
				vscode.window.showErrorMessage(
					`Ошибка при фильтрации Commit.txt для расширения ${extensionFolder}: ${(error as Error).message}`
				);
				// Удаляем уже созданные временные файлы
				for (const tempFile of tempFiles) {
					try {
						await fs.unlink(tempFile);
					} catch {
						// Игнорируем ошибку удаления
					}
				}
				return;
			}

			// Формируем абсолютный путь к каталогу конкретного расширения
			const extensionSrcPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionFolder)
				: path.join(workspaceRoot, cfePath, extensionFolder);

			const logFileName =
				extensionFolders.length === 1
					? `load_${logTs}.log`
					: VRunnerManager.buildExtensionDesignerLoadLogFileName(logTs, extensionFolder);
			const loadLogFile = path.join(logDir, logFileName);

			// Формируем команду загрузки расширения через v8runner-cli.os
			const args = [
				scriptPath,
				'loadExtensionFromFiles',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--src', extensionSrcPath,
				'--extension', extensionFolder,
				'--listFile', tempCommitPath,
				'--out', loadLogFile
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);

			// Добавляем команду удаления временного файла после загрузки
			// На Windows всегда используем PowerShell команду, так как VS Code по умолчанию использует PowerShell
			// Для Unix-систем используем rm
			let deleteCommand: string;
			if (process.platform === 'win32') {
				// На Windows всегда используем PowerShell команду для надежности
				deleteCommand = `Remove-Item -LiteralPath "${tempCommitPath}" -Force -ErrorAction SilentlyContinue`;
			} else {
				// Unix-системы (Linux, macOS)
				deleteCommand = `rm -f "${tempCommitPath}"`;
			}
			commands.push(deleteCommand);
		}

		// После загрузки всех расширений выполняем обновление конфигурации БД
		const updateDbArgs = [
			scriptPath,
			'updateDB',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password
		];

		const escapedUpdateDbArgs = updateDbArgs.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			if (arg === '') {
				return '""';
			}
			return arg;
		});

		const updateDbCommand = `${onescriptPath} ${escapedUpdateDbArgs.join(' ')}`;
		commands.push(updateDbCommand);

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Выгружает расширения из информационной базы в .cfe файлы
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду `unloadext`. Расширения выгружаются из информационной базы в бинарные
	 * .cfe файлы в папку сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Выгружает расширения в .cfe файлы
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду выгрузки через v8runner-cli.os. Каждое расширение выгружается
	 * в отдельный .cfe файл в папке сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async dumpToCfe(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const allExtensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!allExtensionFolders) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpExtensionToCfeCommandName();

		const selectedExtension = await this.pickOne(allExtensionFolders, 'Выберите расширение', commandName.title);
		if (!selectedExtension) {
			return;
		}
		const extensionFolders = [selectedExtension];

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		// Создаем каталог для .cfe файлов, если его нет
		const cfeOutputDir = path.join(workspaceRoot, buildPath, 'cfe');
		try {
			await fs.mkdir(cfeOutputDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(
				`Ошибка при создании папки ${buildPath}/cfe: ${(error as Error).message}`
			);
			return;
		}

		// Формируем команды для всех расширений
		const commands: string[] = [];

		for (const extensionFolder of extensionFolders) {
			const extensionFileName = `${extensionFolder}.cfe`;
			const cfeFilePath = path.join(workspaceRoot, buildPath, 'cfe', extensionFileName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'dumpExtensionToFile',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--file', cfeFilePath,
				'--extension', extensionFolder
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Собирает .cfe файл из исходников
	 * 
	 * Находит все подпапки в папке расширений и для каждой выполняет команду `compileexttocfe`.
	 * Исходники расширений компилируются в бинарные .cfe файлы в папку сборки.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Собирает .cfe файлы из исходников расширений
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду `compileexttocfe`. Исходники расширений компилируются в бинарные
	 * .cfe файлы в папку сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Собирает .cfe файлы из исходников расширений
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду сборки через v8runner-cli.os. Исходники расширений компилируются в бинарные
	 * .cfe файлы в папку сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async compile(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const allExtensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!allExtensionFolders) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getBuildExtensionCommandName();

		const selectedExtension = await this.pickOne(allExtensionFolders, 'Выберите расширение', commandName.title);
		if (!selectedExtension) {
			return;
		}
		const extensionFolders = [selectedExtension];
		const cfePath = this.vrunner.getCfePath();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		// Создаем каталог для .cfe файлов, если его нет
		const cfeOutputDir = path.join(workspaceRoot, buildPath, 'cfe');
		try {
			await fs.mkdir(cfeOutputDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(
				`Ошибка при создании папки ${buildPath}/cfe: ${(error as Error).message}`
			);
			return;
		}

		// Формируем команды для всех расширений
		const commands: string[] = [];

		for (const extensionFolder of extensionFolders) {
			const extensionFileName = `${extensionFolder}.cfe`;
			const srcPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionFolder)
				: path.join(workspaceRoot, cfePath, extensionFolder);
			const outPath = path.join(workspaceRoot, buildPath, 'cfe', extensionFileName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'compileExtensionToCfe',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--src', srcPath,
				'--out', outPath,
				'--extension', extensionFolder
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Разбирает .cfe файлы в исходники расширений
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду `decompileext`.
	 * Бинарные .cfe файлы разбираются в исходники в формате XML в папку расширений (src/cfe).
	 * Имя расширения извлекается из имени файла (без расширения .cfe), и исходники выгружаются
	 * в папку с этим именем. Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Разбирает .cfe файлы в исходники расширений
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду разбора
	 * через v8runner-cli.os. Бинарные .cfe файлы разбираются в исходники в формате XML в папку расширений (src/cfe).
	 * Имя расширения извлекается из имени файла (без расширения .cfe), и исходники выгружаются
	 * в папку с этим именем. Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async decompile(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const cfeBuildPath = path.join(workspaceRoot, buildPath, 'cfe');

		if (!(await this.checkDirectoryExists(cfeBuildPath, `Папка ${buildPath}/cfe не является директорией`))) {
			return;
		}

		const allCfeFiles = await this.getFilesByExtension(cfeBuildPath, '.cfe', `Ошибка при чтении папки ${buildPath}/cfe`);
		if (allCfeFiles.length === 0) {
			vscode.window.showInformationMessage(`В папке ${buildPath}/cfe не найдено файлов .cfe`);
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDecompileExtensionCommandName();

		const selectedCfeFile = await this.pickOne(allCfeFiles, 'Выберите расширение', commandName.title);
		if (!selectedCfeFile) {
			return;
		}
		const cfeFiles = [selectedCfeFile];
		const cfePath = this.vrunner.getCfePath();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}

		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		// Формируем команды для всех .cfe файлов
		const commands: string[] = [];

		for (const cfeFile of cfeFiles) {
			const extensionName = cfeFile.replace(/\.cfe$/i, '');
			const cfeFilePath = path.join(cfeBuildPath, cfeFile);
			const outputPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionName)
				: path.join(workspaceRoot, cfePath, extensionName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'decompileExtension',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--file', cfeFilePath,
				'--out', outputPath,
				'--extension', extensionName
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}
}

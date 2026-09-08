/**
 * Сборка расширения через esbuild.
 * Объединяет все исходники и зависимости в один файл.
 */

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Копирует VSCode Elements и Codicons в media/webview для webview (не node_modules).
 */
function copyWebviewAssets() {
	const destDir = path.join(__dirname, 'media', 'webview');
	fs.mkdirSync(destDir, { recursive: true });
	const copies = [
		['node_modules/@vscode-elements/elements/dist/bundled.js', 'bundled.js'],
		['node_modules/@vscode/codicons/dist/codicon.css', 'codicon.css'],
		['node_modules/@vscode/codicons/dist/codicon.ttf', 'codicon.ttf'],
	];
	for (const [srcRel, name] of copies) {
		const src = path.join(__dirname, srcRel);
		if (!fs.existsSync(src)) {
			throw new Error(`Webview asset not found: ${srcRel}`);
		}
		const dest = path.join(destDir, name);
		if (name === 'codicon.css') {
			// Query-string у ttf ломает загрузку шрифта в webview (CSP / vscode-resource).
			const css = fs.readFileSync(src, 'utf8').replace(
				/url\("\.\/codicon\.ttf\?[^"]+"\)/g,
				'url("./codicon.ttf")',
			);
			fs.writeFileSync(dest, css);
		} else {
			fs.copyFileSync(src, dest);
		}
	}
}

async function main() {
	copyWebviewAssets();
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		target: 'node20',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'warning',
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

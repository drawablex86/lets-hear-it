import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

/**
 * esbuild plugin to copy and sanitize onnxruntime-web WASM and MJS files for Obsidian
 */
const copyAndSanitizeWasmPlugin = {
	name: "copy-wasm-plugin",
	setup(build) {
		build.onEnd(() => {
			try {
				const ortDistPath = path.resolve("node_modules/onnxruntime-web/dist");
				if (!fs.existsSync(ortDistPath)) return;

				const files = fs.readdirSync(ortDistPath);
				const targetDirs = [path.resolve(".")];

				for (const targetDir of targetDirs) {
					if (!fs.existsSync(targetDir)) {
						fs.mkdirSync(targetDir, { recursive: true });
					}
				}

				for (const file of files) {
					const src = path.join(ortDistPath, file);

					// 1. Copy raw WASM binary files
					if (file.endsWith(".wasm")) {
						for (const targetDir of targetDirs) {
							fs.copyFileSync(src, path.join(targetDir, file));
						}
					} 
					// 2. Sanitize and copy Emscripten MJS glue scripts
					else if (file.endsWith(".mjs")) {
						let content = fs.readFileSync(src, "utf8");

						// Remove Node-specific imports that cause browser errors in Electron
						content = content.replace(/await\s+import\s*\(\s*["']module["']\s*\)/g, "{ createRequire: () => () => ({}) }");
						content = content.replace(/await\s+import\s*\(\s*["']worker_threads["']\s*\)/g, "{ workerData: undefined }");
						content = content.replace(/require\s*\(\s*["']worker_threads["']\s*\)/g, "{}");

						// Patch Emscripten async XMLHttpRequest to read local files via Node fs
						const xhrAsyncPattern = /if\(na\(a\)\)return new Promise\(\(d,c\)=>\{var e=new XMLHttpRequest;e\.open\("GET",a,!0\);e\.responseType="arraybuffer";e\.onload=\(\)=>\{200==e\.status\|\|0==e\.status&&e\.response\?d\(e\.response\):c\(e\.status\)\};e\.onerror=c;e\.send\(null\)\}\);/g;
						const fsAsyncReplacement = `if (typeof require === "function" && typeof a === "string" && a.startsWith("file://")) {
							const fs = require("fs");
							const p = decodeURIComponent(a.replace(/^file:\\/\\//, ""));
							if (fs.existsSync(p)) {
								const buf = fs.readFileSync(p);
								return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
							}
						}`;
						content = content.replace(xhrAsyncPattern, fsAsyncReplacement);

						// Patch Emscripten Ta(a) WASM binary resolver
						const taPattern = /async function Ta\(a\)\{if\(!ta\)try\{var b=await la\(a\);return new Uint8Array\(b\)\}catch\{\}if\(a==Sa&&ta\)a=new Uint8Array\(ta\);else if\(ma\)a=ma\(a\);else throw"both async and sync fetching of the wasm failed";return a\}/g;
						const taReplacement = `async function Ta(a) {
							if (typeof require === "function" && typeof a === "string" && a.startsWith("file://")) {
								const fs = require("fs");
								const p = decodeURIComponent(a.replace(/^file:\\/\\//, ""));
								if (fs.existsSync(p)) {
									const buf = fs.readFileSync(p);
									return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
								}
							}
							if (!ta) try { var b = await la(a); return new Uint8Array(b); } catch {}
							if (a == Sa && ta) a = new Uint8Array(ta);
							else if (ma) a = ma(a);
							else throw "both async and sync fetching of the wasm failed";
							return a;
						}`;
						content = content.replace(taPattern, taReplacement);

						for (const targetDir of targetDirs) {
							fs.writeFileSync(path.join(targetDir, file), content, "utf8");
						}
					}
				}

				// 3. Post-process main.js to intercept dynamic import(r) for file:// URLs
				const mainJsPath = path.resolve("main.js");
				if (fs.existsSync(mainJsPath)) {
					let mainJs = fs.readFileSync(mainJsPath, "utf8");
					const search = `(await import(r)).default`;
					const replacement = `(await (async (specifier) => {
						if (typeof require === "function" && typeof specifier === "string") {
							if (specifier.startsWith("file://")) {
								const fs = require("fs");
								const filePath = decodeURIComponent(specifier.replace(/^file:\\/\\//, ""));
								if (fs.existsSync(filePath)) {
									const fileContent = fs.readFileSync(filePath);
									const base64 = Buffer.from(fileContent).toString("base64");
									return import(\`data:text/javascript;base64,\${base64}\`);
								}
							}
						}
						return import(specifier);
					})(r)).default`;

					if (mainJs.includes(search)) {
						mainJs = mainJs.replaceAll(search, replacement);
					}

					// Neutralize CDN wasmPaths override in transformers.js if present
					const cdnSearch = `!x.wasm.wasmPaths&&(x.wasm.wasmPaths=\`https://cdn.jsdelivr.net/npm/@huggingface/transformers@\${c.env.version}/dist/\`)`;
					if (mainJs.includes(cdnSearch)) {
						mainJs = mainJs.replace(cdnSearch, `true`);
					}

					fs.writeFileSync(mainJsPath, mainJs, "utf8");
				}
			} catch (err) {
				console.error("[copy-wasm-plugin] Error during post-processing:", err);
			}
		});
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	plugins: [copyAndSanitizeWasmPlugin],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}

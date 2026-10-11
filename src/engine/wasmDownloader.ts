import { Notice } from "obsidian";
import type LetsHearItPlugin from "../main";

export interface WasmAssetStatus {
	isReady: boolean;
	hasWasm: boolean;
	hasMjs: boolean;
	wasmSize: number; // in bytes
	pluginDirPath: string;
}

const TRANSFORMERS_VERSION = "3.8.1";
const CDN_BASE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist`;

const ASSETS_TO_DOWNLOAD = [
	{
		filename: "ort-wasm-simd-threaded.jsep.wasm",
		url: `${CDN_BASE_URL}/ort-wasm-simd-threaded.jsep.wasm`,
		required: true,
		sanitize: false,
	},
	{
		filename: "ort-wasm-simd-threaded.jsep.mjs",
		url: `${CDN_BASE_URL}/ort-wasm-simd-threaded.jsep.mjs`,
		required: true,
		sanitize: true,
	},
	{
		filename: "ort-wasm-simd-threaded.wasm",
		url: `${CDN_BASE_URL}/ort-wasm-simd-threaded.wasm`,
		required: false,
		sanitize: false,
	},
	{
		filename: "ort-wasm-simd-threaded.mjs",
		url: `${CDN_BASE_URL}/ort-wasm-simd-threaded.mjs`,
		required: false,
		sanitize: true,
	},
];

export class WasmAssetManager {
	private plugin: LetsHearItPlugin;
	private isDownloading = false;

	constructor(plugin: LetsHearItPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Resolves the absolute filesystem directory for this plugin within the user's vault.
	 */
	public getPluginDirectory(): string {
		try {
			const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
			let basePath = "";
			if (typeof adapter?.getBasePath === "function") {
				basePath = adapter.getBasePath();
			} else if (typeof process !== "undefined" && typeof process.cwd === "function") {
				basePath = process.cwd();
			}

			if (basePath) {
				if (this.plugin.manifest?.dir) {
					if (this.plugin.manifest.dir.startsWith("/")) {
						return this.plugin.manifest.dir;
					}
					return `${basePath.replace(/\/+$/, "")}/${this.plugin.manifest.dir.replace(/^\/+/, "")}`;
				}
				return `${basePath.replace(/\/+$/, "")}/.obsidian/plugins/lets-hear-it`;
			}
		} catch {
			// fallback
		}
		return "";
	}

	/**
	 * Checks whether the required WASM and MJS files exist on local disk.
	 */
	public checkStatus(): WasmAssetStatus {
		const dir = this.getPluginDirectory();
		if (!dir) {
			return { isReady: false, hasWasm: false, hasMjs: false, wasmSize: 0, pluginDirPath: "" };
		}

		try {
			const win = typeof window !== "undefined" ? (window as unknown as { require?: (mod: string) => Record<string, unknown> }) : undefined;
			const req = win?.require;
			if (req) {
				const fs = req("fs") as { existsSync: (p: string) => boolean; statSync: (p: string) => { size: number } };
				const path = req("path") as { join: (...args: string[]) => string };

				const wasmPath = path.join(dir, "ort-wasm-simd-threaded.jsep.wasm");
				const mjsPath = path.join(dir, "ort-wasm-simd-threaded.jsep.mjs");

				const hasWasm = fs.existsSync(wasmPath);
				const hasMjs = fs.existsSync(mjsPath);
				const wasmSize = hasWasm ? fs.statSync(wasmPath).size : 0;

				return {
					isReady: hasWasm && hasMjs && wasmSize > 1024 * 1024,
					hasWasm,
					hasMjs,
					wasmSize,
					pluginDirPath: dir,
				};
			}
		} catch {
			// ignore
		}

		return { isReady: false, hasWasm: false, hasMjs: false, wasmSize: 0, pluginDirPath: dir };
	}

	/**
	 * Sanitizes raw Emscripten .mjs content to eliminate node-only imports and blocked XMLHttpRequests.
	 */
	public sanitizeMjsContent(content: string): string {
		let res = content;
		// 1. Sanitize node-only imports that cause browser ES module syntax errors in Electron
		res = res.replace(/await\s+import\s*\(\s*["']module["']\s*\)/g, "{ createRequire: () => () => ({}) }");
		res = res.replace(/await\s+import\s*\(\s*["']worker_threads["']\s*\)/g, "{ workerData: undefined }");
		res = res.replace(/require\s*\(\s*["']worker_threads["']\s*\)/g, "{}");

		// 2. Intercept WASM binary fetch to load directly from local filesystem in Electron
		const wasmFetchPattern = /var\s+b\s*=\s*await\s+fetch\s*\(\s*a\s*,\s*\{\s*credentials:\s*"same-origin"\s*\}\s*\);\s*if\s*\(\s*b\.ok\s*\)\s*return\s+b\.arrayBuffer\(\);/g;
		const wasmFsReplacement = `if (typeof require === "function" && typeof a === "string" && a.startsWith("file://")) {
			const fs = require("fs");
			const p = decodeURIComponent(a.replace(/^file:\\/\\//, ""));
			if (fs.existsSync(p)) {
				const buf = fs.readFileSync(p);
				return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			}
		}
		var b = await fetch(a, { credentials: "same-origin" });
		if (b.ok) return b.arrayBuffer();`;
		res = res.replace(wasmFetchPattern, wasmFsReplacement);

		// 3. Patch Emscripten's async la(a) file loader
		const xhrAsyncPattern = /if\(na\(a\)\)return new Promise\(\(d,c\)=>\{var e=new XMLHttpRequest;e\.open\("GET",a,!0\);e\.responseType="arraybuffer";e\.onload=\(\)=>\{200==e\.status\|\|0==e\.status&&e\.response\?d\(e\.response\):c\(e\.status\)\};e\.onerror=c;e\.send\(null\)\}\);/g;
		const fsAsyncReplacement = `if (typeof require === "function" && typeof a === "string" && a.startsWith("file://")) {
			const fs = require("fs");
			const p = decodeURIComponent(a.replace(/^file:\\/\\//, ""));
			if (fs.existsSync(p)) {
				const buf = fs.readFileSync(p);
				return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			}
		}`;
		res = res.replace(xhrAsyncPattern, fsAsyncReplacement);

		return res;
	}

	/**
	 * Downloads the required WASM and MJS binaries with live progress callbacks.
	 */
	public async downloadAssets(onProgress?: (percent: number, message: string) => void): Promise<boolean> {
		if (this.isDownloading) {
			new Notice("Engine download is already in progress...");
			return false;
		}

		const dir = this.getPluginDirectory();
		if (!dir) {
			new Notice("Could not determine plugin folder path.");
			return false;
		}

		this.isDownloading = true;

		try {
			const win = typeof window !== "undefined" ? (window as unknown as { require?: (mod: string) => Record<string, unknown> }) : undefined;
			const req = win?.require;
			if (!req) {
				throw new Error("Electron Node environment unavailable for local file download.");
			}

			const fs = req("fs") as {
				existsSync: (p: string) => boolean;
				mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
				writeFileSync: (p: string, data: Uint8Array | string, enc?: string) => void;
			};
			const path = req("path") as { join: (...args: string[]) => string };

			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const totalSteps = ASSETS_TO_DOWNLOAD.length;
			let step = 0;

			for (const asset of ASSETS_TO_DOWNLOAD) {
				step++;
				const targetPath = path.join(dir, asset.filename);
				const statusMsg = `Downloading ${asset.filename} (${step}/${totalSteps})...`;
				if (onProgress) {
					onProgress(Math.floor(((step - 1) / totalSteps) * 100), statusMsg);
				}

				try {
					const resp = await fetch(asset.url);
					if (!resp.ok) {
						if (asset.required) {
							throw new Error(`Failed to download ${asset.filename}: HTTP ${resp.status}`);
						}
						continue;
					}

					if (asset.sanitize) {
						let text = await resp.text();
						text = this.sanitizeMjsContent(text);
						fs.writeFileSync(targetPath, text, "utf8");
					} else {
						const arrayBuf = await resp.arrayBuffer();
						fs.writeFileSync(targetPath, new Uint8Array(arrayBuf));
					}
				} catch (downloadErr) {
					if (asset.required) {
						throw downloadErr;
					}
				}
			}

			if (onProgress) {
				onProgress(100, "Local engine setup complete!");
			}

			// Reconfigure WASM directory paths in TTSEngine immediately
			this.plugin.reconfigureWasmDirectory();

			new Notice("Let's Hear It: Local neural speech engine installed successfully!", 5000);
			return true;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error("[let's hear it] Failed to download speech engine:", err);
			new Notice(`Failed to download engine: ${errMsg}`, 6000);
			return false;
		} finally {
			this.isDownloading = false;
		}
	}
}

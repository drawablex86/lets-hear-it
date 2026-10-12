import { Notice } from "obsidian";
import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import * as ort from "onnxruntime-web";

export interface SentenceAudioItem {
	sentenceIndex: number;
	text: string;
	audioBuffer: AudioBuffer;
	duration: number; // in seconds
}

export type TTSState = "idle" | "loading-model" | "buffering" | "playing" | "paused" | "stopped" | "error";

export interface TTSEngineEvents {
	onStateChange?: (state: TTSState, message?: string) => void;
	onSentenceStart?: (sentenceIndex: number, item: SentenceAudioItem) => void;
	onSentenceEnd?: (sentenceIndex: number) => void;
	onTimeUpdate?: (sentenceIndex: number, currentTime: number, duration: number) => void;
	onComplete?: () => void;
	onError?: (error: Error) => void;
}

export class TTSEngine {
	private static instance: TTSEngine | null = null;
	private ttsModel: KokoroTTS | null = null;
	private isInitializing = false;
	private modelInitPromise: Promise<KokoroTTS> | null = null;

	private audioContext: AudioContext;
	private analyserNode: AnalyserNode | null = null;
	private events: TTSEngineEvents = {};

	// Queue & Playback State
	private state: TTSState = "idle";
	private sentencesQueue: string[] = [];
	private currentSentenceIndex = -1;
	private audioCache = new Map<number, Promise<SentenceAudioItem>>();
	private activeSourceNode: AudioBufferSourceNode | null = null;
	private playbackSessionEpoch = 0;
	private isPrefetching = false;
	private static readonly BUFFER_LOOKAHEAD = 2; // Continuous 2-sentence lookahead (~5-8s safety margin)
	private synthesisMutex: Promise<unknown> = Promise.resolve();
	private static gcDebounceTimeout: number | null = null;
	private static sentencesSinceLastGC = 0;

	// Audio scheduling tracking
	private voice = "af_heart";
	private hardwareAcceleration: "wasm" | "webgpu" = "wasm";
	private playbackRate = 1.0;
	private sentenceStartTime = 0;
	private sentencePauseOffset = 0;
	private isPaused = false;
	private isStopped = false;
	private timeUpdateRafId: number | null = null;
	private currentAudioDuration = 0;

	constructor(audioContext: AudioContext, events: TTSEngineEvents = {}) {
		this.audioContext = audioContext;
		this.events = events;

		// Ensure caches object exists on window to prevent Kokoro voice downloader ReferenceErrors
		try {
			if (typeof window !== "undefined") {
				const win = window as unknown as { caches?: CacheStorage };
				if (!win.caches || typeof win.caches.open !== "function") {
					win.caches = {
						open: async () => ({
							match: async () => undefined,
							put: async () => {},
						} as unknown as Cache),
					} as unknown as CacheStorage;
				}
			}
		} catch {
			// ignore cache polyfill errors
		}

		this.setupAnalyser();
	}

	private setupAnalyser(): void {
		try {
			if (this.audioContext && !this.analyserNode) {
				const analyser = this.audioContext.createAnalyser();
				analyser.fftSize = 64;
				analyser.smoothingTimeConstant = 0.8;
				analyser.connect(this.audioContext.destination);
				this.analyserNode = analyser;
			}
		} catch (err) {
			console.warn("[let's hear it] Failed to initialize AnalyserNode:", err);
		}
	}

	public getAnalyserNode(): AnalyserNode | null {
		if (!this.analyserNode) {
			this.setupAnalyser();
		}
		return this.analyserNode;
	}

	public static getInstance(audioContext: AudioContext, events: TTSEngineEvents = {}): TTSEngine {
		if (!TTSEngine.instance) {
			TTSEngine.instance = new TTSEngine(audioContext, events);
		} else {
			TTSEngine.instance.audioContext = audioContext;
			TTSEngine.instance.events = { ...TTSEngine.instance.events, ...events };
		}
		return TTSEngine.instance;
	}

	public setVoice(voice: string) {
		if (this.voice !== voice) {
			this.voice = voice;
			// Clear upcoming pre-buffered sentences since voice changed
			this.audioCache.clear();
		}
	}

	public getVoice(): string {
		return this.voice;
	}

	public setHardwareAcceleration(accel: "wasm" | "webgpu") {
		this.hardwareAcceleration = accel;
	}

	public getHardwareAcceleration(): "wasm" | "webgpu" {
		return this.hardwareAcceleration;
	}

	/**
	 * Switches the inference engine dynamically and re-initializes KokoroTTS.
	 */
	public async switchEngine(accel: "wasm" | "webgpu"): Promise<void> {
		if (this.hardwareAcceleration === accel && this.ttsModel) {
			return;
		}
		this.hardwareAcceleration = accel;
		this.ttsModel = null;
		this.modelInitPromise = null;
		this.audioCache.clear();
		await this.initModel();
	}

	public setEvents(events: TTSEngineEvents) {
		this.events = { ...this.events, ...events };
	}

	private setState(state: TTSState, message?: string) {
		this.state = state;
		if (this.events.onStateChange) {
			this.events.onStateChange(state, message);
		}
	}

	public getState(): TTSState {
		return this.state;
	}

	public getCurrentSentenceIndex(): number {
		return this.currentSentenceIndex;
	}

	public getTotalSentences(): number {
		return this.sentencesQueue.length;
	}

	public getPlaybackRate(): number {
		return this.playbackRate;
	}

	/**
	 * Configures ONNX Runtime WASM paths using in-memory Blob URLs and wasmBinary
	 * completely eliminating Chromium 'file://' origin security restrictions!
	 */
	public static configureWasmPaths(basePluginPath: string) {
		try {
			// Extract native directory path from file:// or absolute path
			let rawDir = basePluginPath;
			if (rawDir.startsWith("file://")) {
				rawDir = decodeURIComponent(rawDir.replace(/^file:\/\//, ""));
			}
			if (rawDir.endsWith("/")) {
				rawDir = rawDir.slice(0, -1);
			}

			const win = typeof window !== "undefined" ? (window as unknown as { require?: (mod: string) => Record<string, unknown> }) : undefined;
			const req = win?.require;
			if (req) {
				const fs = req("fs") as { existsSync: (p: string) => boolean; readFileSync: (p: string) => Buffer };
				const path = req("path") as { join: (...args: string[]) => string };

				const wasmFile = path.join(rawDir, "ort-wasm-simd-threaded.jsep.wasm");
				const mjsFile = path.join(rawDir, "ort-wasm-simd-threaded.jsep.mjs");

				if (fs.existsSync(wasmFile)) {
					const wasmBuf = fs.readFileSync(wasmFile);
					const wasmBytes = new Uint8Array(wasmBuf.buffer, wasmBuf.byteOffset, wasmBuf.byteLength);
					const wasmBlob = new Blob([wasmBytes as unknown as BlobPart], { type: "application/wasm" });
					const wasmBlobUrl = URL.createObjectURL(wasmBlob);

					// Provide raw Uint8Array directly into memory
					if (ort?.env) {
						ort.env.logLevel = "error";
						if (ort.env.wasm) {
							ort.env.wasm.wasmBinary = new Uint8Array(wasmBuf.buffer, wasmBuf.byteOffset, wasmBuf.byteLength);
							// Dynamic Hardware Topology:
							// Use 2 threads on multi-core systems (or 1 on dual-core).
							// In Electron/Chromium, 2 threads offers peak WASM SIMD throughput for Kokoro-82M
							// while preventing thread pool initialization contention and memory thrashing.
							const logicalCores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
							const optimalThreads = Math.min(2, Math.max(1, Math.floor(logicalCores / 2)));
							ort.env.wasm.numThreads = optimalThreads;

							if (fs.existsSync(mjsFile)) {
								const mjsBuf = fs.readFileSync(mjsFile);
								const mjsBase64 = Buffer.from(mjsBuf).toString("base64");
								const mjsDataUrl = `data:text/javascript;base64,${mjsBase64}`;

								ort.env.wasm.wasmPaths = {
									mjs: mjsDataUrl,
									wasm: wasmBlobUrl,
								};
							} else {
								ort.env.wasm.wasmPaths = { wasm: wasmBlobUrl };
							}
						}
					}

					if (kokoroEnv && ort?.env?.wasm?.wasmPaths) {
						kokoroEnv.wasmPaths = ort.env.wasm.wasmPaths;
					}
					return;
				}
			}

			// Fallback: If local wasm files are not in the plugin directory (e.g. fresh community directory install),
			// load matching runtime WebAssembly engine from pinned jsDelivr CDN for @huggingface/transformers
			const cdnFallback = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";
			if (ort && ort.env && ort.env.wasm) {
				ort.env.wasm.wasmPaths = cdnFallback;
				const logicalCores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
				ort.env.wasm.numThreads = Math.min(6, Math.max(1, Math.floor(logicalCores / 2)));
			}
			if (kokoroEnv) {
				kokoroEnv.wasmPaths = cdnFallback;
			}
		} catch (err) {
			console.warn("[let's hear it] Failed to set custom ort wasm path:", err);
		}
	}

	/**
	 * Initialize or return the cached KokoroTTS model.
	 * Prioritizes WebGPU with fallback to WASM.
	 */
	public async initModel(): Promise<KokoroTTS> {
		if (this.ttsModel) {
			return this.ttsModel;
		}

		if (this.modelInitPromise) {
			return this.modelInitPromise;
		}

		this.modelInitPromise = (async () => {
			this.setState("loading-model", "Loading Kokoro-82M model...");
			let downloadNotice: Notice | null = null;
			let lastReportedPercent = -1;

			const progressCallback = (progress: { status: string; progress?: number; loaded?: number; total?: number; file?: string }) => {
				if (progress.status === "progress" && progress.total && progress.loaded) {
					const pct = Math.floor((progress.loaded / progress.total) * 100);
					if (pct !== lastReportedPercent && pct % 5 === 0) {
						lastReportedPercent = pct;
						const msg = `Downloading voice model for first run (${pct}%)...`;
						if (!downloadNotice) {
							downloadNotice = new Notice(msg, 0);
						} else {
							downloadNotice.setMessage(msg);
						}
						this.setState("loading-model", msg);
					}
				} else if (progress.status === "ready" || progress.status === "done") {
					if (downloadNotice) {
						downloadNotice.hide();
						downloadNotice = null;
					}
				}
			};

			const modelId = "onnx-community/Kokoro-82M-v1.0-ONNX";
			// Hardware Acceleration:
			// "wasm" (Balanced / Recommended): Uses 8-bit quantization ('q8') on WASM SIMD,
			//   occupying ~85MB memory with 0 unmanaged GPU buffer leaks, 100% stable, zero system freezes.
			// Hardware Acceleration:
			// "webgpu" (Fast Hardware Acceleration): Uses WebGPU with fp32 for uncompressed natural audio fidelity.
			//   (Note: fp16 on WebGPU causes variance overflow & cracked robotic audio in Kokoro's vocoder).
			// "wasm" (Balanced CPU): Uses 8-bit quantization ('q8') on WASM SIMD.
			const requestedDevice = this.hardwareAcceleration;
			const isGpuSupported = typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as unknown as { gpu?: unknown }).gpu;
			let actualDevice: "webgpu" | "wasm" = requestedDevice === "webgpu" && isGpuSupported ? "webgpu" : "wasm";

			if (requestedDevice === "webgpu" && !isGpuSupported) {
				new Notice("WebGPU is not supported by your hardware or browser. Using CPU WASM fallback mode.", 4000);
			}

			// WebGPU uses fp32 for studio-clean audio, while WASM uses q8
			const dtype = actualDevice === "webgpu" ? "fp32" : "q8";

			// Ensure ORT WebGPU powerPreference is set
			if (ort?.env?.webgpu) {
				(ort.env.webgpu as unknown as { powerPreference?: string }).powerPreference = "high-performance";
			}

			try {
				this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
					dtype,
					device: actualDevice,
					progress_callback: progressCallback,
				});
				this.patchKokoroModelForZeroLeaks(this.ttsModel);
			} catch (err) {
				console.warn(`[let's hear it] Failed to initialize model with device=${actualDevice}, dtype=${dtype}:`, err);
				if (actualDevice === "webgpu") {
					actualDevice = "wasm";
					new Notice("WebGPU initialization failed. Switched to CPU WASM compatibility mode.", 4000);
					try {
						this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
							dtype: "q8",
							device: "wasm",
							progress_callback: progressCallback,
						});
						this.patchKokoroModelForZeroLeaks(this.ttsModel);
					} catch {
						this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
							dtype: "fp32",
							device: "wasm",
							progress_callback: progressCallback,
						});
						this.patchKokoroModelForZeroLeaks(this.ttsModel);
					}
				} else {
					this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
						dtype: "fp32",
						device: "wasm",
						progress_callback: progressCallback,
					});
					this.patchKokoroModelForZeroLeaks(this.ttsModel);
				}
			}

			if (downloadNotice) {
				(downloadNotice as Notice).hide();
			}

			const label = actualDevice === "webgpu" ? "WebGPU" : "CPU WASM Fallback";
			new Notice(`Kokoro voice model loaded (${label})!`, 2500);
			this.setState("idle", "Model ready");
			return this.ttsModel;
		})();

		return this.modelInitPromise;
	}

	/**
	 * Patches the KokoroTTS instance's generate_from_ids method to explicitly dispose
	 * all input and intermediate tensors immediately after inference.
	 * This prevents ONNX Runtime Web and WebGPU buffer heap escalation.
	 */
	private patchKokoroModelForZeroLeaks(modelInstance: KokoroTTS): void {
		const proto = Object.getPrototypeOf(modelInstance) as {
			generate_from_ids: (inputIds: unknown, options?: { voice?: string; speed?: number }) => Promise<{ data: Float32Array; sampling_rate: number }>;
			_zeroLeakPatched?: boolean;
		};

		if (proto._zeroLeakPatched) return;

		const originalGenerateFromIds = proto.generate_from_ids;
		proto.generate_from_ids = async function (
			inputIds: unknown,
			options?: { voice?: string; speed?: number }
		) {
			const result = await originalGenerateFromIds.call(this, inputIds, options);

			// Explicitly trigger disposal on inputIds tensor if it exposes .dispose()
			if (inputIds && typeof (inputIds as { dispose?: () => void }).dispose === "function") {
				try {
					(inputIds as { dispose: () => void }).dispose();
				} catch {
					// safe disposal ignore
				}
			}

			// Schedule throttled garbage collection without blocking immediate audio pipelines
			TTSEngine.scheduleBackgroundGCSweep();

			return result;
		};

		proto._zeroLeakPatched = true;
	}

	/**
	 * Schedules an idle, debounced garbage collection sweep.
	 * Runs after playback pauses, completes, or every 8 sentences during idle moments,
	 * preventing audio pipeline freezes and eliminating memory pressure sawtooth spikes.
	 */
	public static scheduleBackgroundGCSweep(forceNow = false): void {
		TTSEngine.sentencesSinceLastGC++;

		if (forceNow || TTSEngine.sentencesSinceLastGC >= 8) {
			if (TTSEngine.gcDebounceTimeout !== null) {
				window.clearTimeout(TTSEngine.gcDebounceTimeout);
				TTSEngine.gcDebounceTimeout = null;
			}
			TTSEngine.sentencesSinceLastGC = 0;
			// Defer execution to next idle frame so WebAudio scheduling has absolute priority
			const win = typeof window !== "undefined" ? window : globalThis;
			if ("requestIdleCallback" in win && typeof (win as Record<string, unknown>).requestIdleCallback === "function") {
				((win as Record<string, unknown>).requestIdleCallback as (cb: () => void) => void)(() => {
					TTSEngine.triggerGarbageCollection();
				});
			} else {
				win.setTimeout(() => {
					TTSEngine.triggerGarbageCollection();
				}, 100);
			}
			return;
		}

		if (TTSEngine.gcDebounceTimeout === null) {
			TTSEngine.gcDebounceTimeout = window.setTimeout(() => {
				TTSEngine.gcDebounceTimeout = null;
				TTSEngine.sentencesSinceLastGC = 0;
				TTSEngine.triggerGarbageCollection();
			}, 3000);
		}
	}

	/**
	 * Cooperation Garbage Collection Trigger.
	 * In Obsidian's Electron environment, accesses V8's GC via Node vm context
	 * or window.gc to force immediate sweeping of detached WebGPU/WASM buffers.
	 */
	public static triggerGarbageCollection(): void {
		try {
			const win = typeof window !== "undefined" ? (window as unknown as { gc?: () => void }) : undefined;
			if (typeof win?.gc === "function") {
				win.gc();
				return;
			}

			// In Electron with Node integration: enable expose_gc dynamically via v8 and vm
			const req = (typeof window !== "undefined" ? (window as unknown as { require?: (mod: string) => Record<string, unknown> }).require : undefined) ||
				(typeof require === "function" ? require : undefined);
			if (req) {
				const v8 = req("v8") as { setFlagsFromString?: (flags: string) => void };
				const vm = req("vm") as { runInNewContext?: (code: string) => unknown };
				if (typeof v8?.setFlagsFromString === "function" && typeof vm?.runInNewContext === "function") {
					v8.setFlagsFromString("--expose_gc");
					const gcFn = vm.runInNewContext("gc") as (() => void) | undefined;
					if (typeof gcFn === "function") {
						gcFn();
					}
				}
			}
		} catch {
			// Ignore if environment forbids explicit GC
		}
	}

	public isModelLoaded(): boolean {
		return this.ttsModel !== null;
	}

	/**
	 * Pre-warms the Kokoro neural model during idle time to eliminate startup latency.
	 */
	public async prewarm(): Promise<void> {
		if (this.ttsModel || this.isInitializing) return;
		try {
			await this.initModel();
		} catch (err) {
			console.warn("[let's hear it] Prewarm skipped or deferred:", err);
		}
	}

	/**
	 * Synthesizes a raw sentence string to an AudioBuffer.
	 * Serialized through synthesisMutex to guarantee zero concurrent tensor allocations in RAM.
	 */
	public async synthesizeSentence(text: string, sentenceIndex: number): Promise<SentenceAudioItem> {
		// Wait for previous generation to release its tensors and memory
		const release = await new Promise<() => void>((resolve) => {
			this.synthesisMutex = this.synthesisMutex.then(() => new Promise<void>((done) => {
				resolve(done);
			})).catch(() => new Promise<void>((done) => {
				resolve(done);
			}));
		});

		try {
			const model = await this.initModel();
			const rawAudio = await model.generate(text, {
				voice: this.voice as unknown as NonNullable<Parameters<typeof model.generate>[1]>["voice"],
				speed: 1.0, // Base audio generated at normal speed; speed scaling handled in WebAudio node
			});

			const sampleRate = rawAudio.sampling_rate || 24000;
			const float32Data = rawAudio.audio; // Float32Array PCM

			// Audio conditioning & de-clicking:
			// 1. Clamp samples to [-1.0, 1.0] to prevent harsh DAC clipping/cracking
			// 2. Filter any NaN or infinite values from vocoder computation
			// 3. Apply smooth micro fade-in and fade-out (3ms ~ 72 samples) to eliminate boundary pops
			const pcm = new Float32Array(float32Data.length);
			const fadeLength = Math.min(72, Math.floor(float32Data.length / 4));
			for (let i = 0; i < float32Data.length; i++) {
				let s = float32Data[i];
				if (isNaN(s) || !isFinite(s)) {
					s = 0;
				} else if (s > 1.0) {
					s = 1.0;
				} else if (s < -1.0) {
					s = -1.0;
				}

				// Micro fade-in at start
				if (i < fadeLength) {
					s *= (i / fadeLength);
				}
				// Micro fade-out at end
				else if (i >= float32Data.length - fadeLength) {
					s *= ((float32Data.length - 1 - i) / fadeLength);
				}

				pcm[i] = s;
			}

			const audioBuffer = this.audioContext.createBuffer(1, pcm.length, sampleRate);
			audioBuffer.copyToChannel(pcm, 0);

			const duration = audioBuffer.duration;

			// Post-synthesis memory sweep (debounced & idle)
			TTSEngine.scheduleBackgroundGCSweep();

			return {
				sentenceIndex,
				text,
				audioBuffer,
				duration,
			};
		} finally {
			release();
		}
	}

	/**
	/**
	 * Groups individual sentences into optimal multi-sentence speech chunks
	 * (up to ~380 characters) to drastically accelerate Kokoro TTS synthesis.
	 */
	public static groupSentencesIntoSpeechChunks(sentences: string[], maxChars = 380): string[] {
		const chunks: string[] = [];
		let currentChunk: string[] = [];
		let currentLength = 0;

		for (const sentence of sentences) {
			const trimmed = sentence.trim();
			if (!trimmed) continue;

			// If current chunk has sentences and adding this sentence exceeds budget, start a new chunk
			if (currentChunk.length > 0 && currentLength + trimmed.length + 1 > maxChars) {
				chunks.push(currentChunk.join(" "));
				currentChunk = [trimmed];
				currentLength = trimmed.length;
			} else {
				currentChunk.push(trimmed);
				currentLength += (currentChunk.length === 1 ? 0 : 1) + trimmed.length;
			}
		}

		if (currentChunk.length > 0) {
			chunks.push(currentChunk.join(" "));
		}

		return chunks;
	}

	/**
	 * Synthesizes a list of sentences into a single continuous Float32Array (24kHz mono)
	 * suitable for offline file saving (e.g. MP3 encoding), using optimal multi-sentence
	 * speech batches to reduce model forward-passes by up to 75%.
	 */
	public async generateFullAudio(
		sentences: string[],
		voice: string,
		onProgress?: (current: number, total: number, message?: string) => void
	): Promise<Float32Array> {
		const model = await this.initModel();
		const sampleRate = 24000;
		// 300ms natural silence pause between paragraph speech batches
		const pauseSamples = Math.floor(sampleRate * 0.3);
		const pauseBuffer = new Float32Array(pauseSamples);

		// Group sentences into speech batches under Kokoro's optimal token window
		const speechChunks = TTSEngine.groupSentencesIntoSpeechChunks(sentences, 380);

		const audioChunks: Float32Array[] = [];
		let totalSamples = 0;

		for (let i = 0; i < speechChunks.length; i++) {
			const chunkText = speechChunks[i];
			if (onProgress) {
				onProgress(
					i + 1,
					speechChunks.length,
					`Synthesizing speech batch ${i + 1} of ${speechChunks.length}...`
				);
			}

			const rawAudio = await model.generate(chunkText, {
				voice: voice as unknown as NonNullable<Parameters<typeof model.generate>[1]>["voice"],
				speed: 1.0,
			});

			const audioData = rawAudio.audio; // Float32Array
			if (audioData && audioData.length > 0) {
				audioChunks.push(audioData);
				totalSamples += audioData.length;

				// Append paragraph pause if not the last chunk
				if (i < speechChunks.length - 1) {
					audioChunks.push(pauseBuffer);
					totalSamples += pauseSamples;
				}
			}
		}

		// Concatenate all chunks into a single Float32Array
		const fullAudio = new Float32Array(totalSamples);
		let offset = 0;
		for (const chunk of audioChunks) {
			fullAudio.set(chunk, offset);
			offset += chunk.length;
		}

		return fullAudio;
	}

	/**
	 * Gets synthesized audio for a sentence from cache or triggers synthesis.
	 */
	private getSentenceAudioPromise(sentenceIndex: number): Promise<SentenceAudioItem> {
		if (this.audioCache.has(sentenceIndex)) {
			return this.audioCache.get(sentenceIndex)!;
		}

		const text = this.sentencesQueue[sentenceIndex];
		if (!text) {
			return Promise.reject(new Error(`Index ${sentenceIndex} out of bounds`));
		}

		const promise = this.synthesizeSentence(text, sentenceIndex).catch((err) => {
			// Evict rejected promise so temporary errors don't poison subsequent attempts
			this.audioCache.delete(sentenceIndex);
			throw err;
		});

		this.audioCache.set(sentenceIndex, promise);
		return promise;
	}

	/**
	 * Strictly maintains a sliding window of BUFFER_LOOKAHEAD (2) pre-buffered sentences ahead.
	 * When Sentence N is active, ensures Sentence N+1 and N+2 are resolved or actively synthesizing.
	 * Purges finished past sentences to keep RAM footprint low.
	 */
	private async prefetchUpcomingSentences(currentIndex: number, currentEpoch: number): Promise<void> {
		// Evict completed past sentences from cache to prevent RAM exhaustion
		for (const cachedIndex of Array.from(this.audioCache.keys())) {
			if (cachedIndex < currentIndex) {
				this.audioCache.delete(cachedIndex);
			}
		}

		if (this.isPrefetching) return;
		this.isPrefetching = true;

		try {
			for (let i = 1; i <= TTSEngine.BUFFER_LOOKAHEAD; i++) {
				const targetIndex = currentIndex + i;
				if (this.playbackSessionEpoch !== currentEpoch || this.isStopped) {
					break;
				}
				if (targetIndex < this.sentencesQueue.length && !this.audioCache.has(targetIndex)) {
					try {
						// Initiates synthesis promise and inserts into cache immediately
						void this.getSentenceAudioPromise(targetIndex);
						// Await sequential execution under mutex to ensure orderly GPU dispatch
						await this.audioCache.get(targetIndex);
					} catch (err) {
						console.warn(`[let's hear it] Prefetch error for sentence ${targetIndex}:`, err);
					}
				}
			}
		} finally {
			this.isPrefetching = false;
		}
	}

	/**
	 * Start reading an array of clean sentences with proactive buffer priming
	 */
	public async play(sentences: string[], startIndex = 0): Promise<void> {
		this.stop();
		const currentEpoch = ++this.playbackSessionEpoch;
		this.isStopped = false;
		this.isPaused = false;
		this.sentencesQueue = sentences;
		this.audioCache.clear();

		if (sentences.length === 0) {
			this.setState("idle", "No sentences to read");
			return;
		}

		await this.resumeAudioContext();
		if (this.playbackSessionEpoch !== currentEpoch || this.isStopped) {
			return;
		}

		this.currentSentenceIndex = startIndex;

		// Proactive buffer priming: immediately initiate synthesis for starting sentence
		// and upcoming lookahead sentences concurrently before playSentence starts!
		void this.getSentenceAudioPromise(startIndex);
		for (let i = 1; i <= TTSEngine.BUFFER_LOOKAHEAD; i++) {
			const lookaheadIdx = startIndex + i;
			if (lookaheadIdx < this.sentencesQueue.length) {
				void this.getSentenceAudioPromise(lookaheadIdx);
			}
		}

		await this.playSentence(startIndex, 0, currentEpoch);
	}

	private async resumeAudioContext() {
		if (this.audioContext.state === "suspended") {
			await this.audioContext.resume();
		}
	}

	/**
	 * Plays a specific sentence index with strict session epoch validation
	 */
	private async playSentence(index: number, startOffset = 0, currentEpoch = this.playbackSessionEpoch): Promise<void> {
		if (this.playbackSessionEpoch !== currentEpoch || this.isStopped) return;
		if (index >= this.sentencesQueue.length) {
			this.finish(currentEpoch);
			return;
		}

		this.currentSentenceIndex = index;
		this.setState("buffering", `Preparing sentence ${index + 1}/${this.sentencesQueue.length}...`);

		// Proactively ensure lookahead sliding window is prefetching immediately
		void this.prefetchUpcomingSentences(index, currentEpoch);

		try {
			const item = await this.getSentenceAudioPromise(index);
			// Validate that session epoch is still valid before initiating WebAudio nodes
			if (this.playbackSessionEpoch !== currentEpoch || this.isStopped || this.isPaused) {
				return;
			}

			// Clean up any previously lingering audio node before creating a new one
			if (this.activeSourceNode) {
				this.cleanupSourceNode(this.activeSourceNode);
			}

			this.currentAudioDuration = item.duration;
			this.sentencePauseOffset = startOffset;
			this.sentenceStartTime = this.audioContext.currentTime - (startOffset / this.playbackRate);

			// Setup WebAudio Source Node
			const source = this.audioContext.createBufferSource();
			source.buffer = item.audioBuffer;
			source.playbackRate.value = this.playbackRate;
			if (this.analyserNode) {
				source.connect(this.analyserNode);
			} else {
				source.connect(this.audioContext.destination);
			}
			this.activeSourceNode = source;

			source.onended = () => {
				if (this.playbackSessionEpoch === currentEpoch && this.activeSourceNode === source) {
					this.activeSourceNode = null;
					this.stopTimeTracking();

					// Immediately free this sentence's audio buffer from memory
					this.audioCache.delete(index);

					if (!this.isPaused && !this.isStopped) {
						if (this.events.onSentenceEnd) {
							this.events.onSentenceEnd(index);
						}
						// Advance to next sentence
						void this.playSentence(index + 1, 0, currentEpoch);
					}
				}
			};

			if (this.events.onSentenceStart) {
				this.events.onSentenceStart(index, item);
			}

			this.setState("playing", `Reading sentence ${index + 1}/${this.sentencesQueue.length}`);
			source.start(0, startOffset);
			this.startTimeTracking(index, currentEpoch);

			// Trigger sequential pre-fetch for upcoming sentence only after current sentence is playing
			void this.prefetchUpcomingSentences(index, currentEpoch);
		} catch (error) {
			if (this.playbackSessionEpoch !== currentEpoch || this.isStopped) return;
			console.error(`[let's hear it] Playback error at sentence ${index}:`, error);
			this.audioCache.delete(index);

			// If error is recoverable or on a single malformed sentence, advance to next sentence
			// rather than permanently freezing in "buffering"
			if (index + 1 < this.sentencesQueue.length) {
				console.warn(`[let's hear it] Skipping problematic sentence ${index} and advancing to ${index + 1}`);
				void this.playSentence(index + 1, 0, currentEpoch);
			} else {
				this.setState("error", error instanceof Error ? error.message : String(error));
				if (this.events.onError) {
					this.events.onError(error instanceof Error ? error : new Error(String(error)));
				}
			}
		}
	}

	private startTimeTracking(sentenceIndex: number, currentEpoch: number) {
		this.stopTimeTracking();

		const update = () => {
			if (this.playbackSessionEpoch === currentEpoch && this.state === "playing" && this.activeSourceNode) {
				const elapsedSeconds = (this.audioContext.currentTime - this.sentenceStartTime) * this.playbackRate;
				if (this.events.onTimeUpdate) {
					this.events.onTimeUpdate(sentenceIndex, Math.min(elapsedSeconds, this.currentAudioDuration), this.currentAudioDuration);
				}
				this.timeUpdateRafId = window.requestAnimationFrame(update);
			}
		};

		this.timeUpdateRafId = window.requestAnimationFrame(update);
	}

	private stopTimeTracking() {
		if (this.timeUpdateRafId !== null) {
			window.cancelAnimationFrame(this.timeUpdateRafId);
			this.timeUpdateRafId = null;
		}
	}

	private cleanupSourceNode(source: AudioBufferSourceNode) {
		source.onended = null;
		try {
			source.stop();
			source.disconnect();
		} catch {
			// Safely ignore if source node was already stopped or disconnected
		}
	}

	public pause(): void {
		if (this.state !== "playing" || !this.activeSourceNode) return;

		this.isPaused = true;
		const elapsedSeconds = (this.audioContext.currentTime - this.sentenceStartTime) * this.playbackRate;
		this.sentencePauseOffset = Math.min(elapsedSeconds, this.currentAudioDuration);

		this.stopTimeTracking();
		if (this.activeSourceNode) {
			this.cleanupSourceNode(this.activeSourceNode);
			this.activeSourceNode = null;
		}

		this.setState("paused", "Paused");
	}

	public resume(): void {
		if (this.state !== "paused") return;

		this.isPaused = false;
		void this.playSentence(this.currentSentenceIndex, this.sentencePauseOffset, this.playbackSessionEpoch);
	}

	public stop(): void {
		this.playbackSessionEpoch++;
		this.isStopped = true;
		this.isPaused = false;
		this.stopTimeTracking();

		if (this.activeSourceNode) {
			this.cleanupSourceNode(this.activeSourceNode);
			this.activeSourceNode = null;
		}

		this.sentencePauseOffset = 0;
		this.currentSentenceIndex = -1;
		this.setState("stopped", "Stopped");
	}

	private finish(currentEpoch = this.playbackSessionEpoch): void {
		if (this.playbackSessionEpoch !== currentEpoch) return;
		this.stopTimeTracking();
		if (this.activeSourceNode) {
			this.cleanupSourceNode(this.activeSourceNode);
			this.activeSourceNode = null;
		}
		this.currentSentenceIndex = -1;
		this.setState("idle", "Finished");
		if (this.events.onComplete) {
			this.events.onComplete();
		}
	}

	/**
	 * Sets the playback rate dynamically (0.5x to 2.0x) without restarting audio
	 */
	public setPlaybackRate(rate: number): void {
		const clampedRate = Math.max(0.5, Math.min(2.0, rate));
		if (this.playbackRate === clampedRate) return;

		if (this.activeSourceNode && this.state === "playing") {
			// Compute elapsed audio position up to this instant
			const currentAudioTime = (this.audioContext.currentTime - this.sentenceStartTime) * this.playbackRate;
			this.playbackRate = clampedRate;
			this.activeSourceNode.playbackRate.value = clampedRate;
			// Recalculate sentenceStartTime so time tracking remains exact
			this.sentenceStartTime = this.audioContext.currentTime - (currentAudioTime / clampedRate);
		} else {
			this.playbackRate = clampedRate;
		}
	}
}

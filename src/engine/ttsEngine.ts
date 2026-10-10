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
	private events: TTSEngineEvents = {};

	// Queue & Playback State
	private state: TTSState = "idle";
	private sentencesQueue: string[] = [];
	private currentSentenceIndex = -1;
	private audioCache = new Map<number, Promise<SentenceAudioItem>>();
	private activeSourceNode: AudioBufferSourceNode | null = null;
	private playbackSessionEpoch = 0;
	private isPrefetching = false;
	private static readonly BUFFER_LOOKAHEAD = 2; // Strict 2-sentence lookahead buffer

	// Audio scheduling tracking
	private voice = "af_heart";
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

		// Ensure global caches object exists to prevent Kokoro voice downloader ReferenceErrors
		try {
			const target = (typeof window !== "undefined" ? window : globalThis) as any;
			if (!target.caches || typeof target.caches.open !== "function") {
				target.caches = {
					open: async () => ({
						match: async () => undefined,
						put: async () => {},
					}),
				};
			}
		} catch (e) {}
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

			const req = (globalThis as any).require || (window as any).require;
			if (req) {
				const fs = req("fs");
				const path = req("path");

				const wasmFile = path.join(rawDir, "ort-wasm-simd-threaded.jsep.wasm");
				const mjsFile = path.join(rawDir, "ort-wasm-simd-threaded.jsep.mjs");

				if (fs.existsSync(wasmFile)) {
					const wasmBuf = fs.readFileSync(wasmFile);
					const wasmBlob = new Blob([wasmBuf], { type: "application/wasm" });
					const wasmBlobUrl = URL.createObjectURL(wasmBlob);

					// Provide raw Uint8Array directly into memory
					if (ort && ort.env) {
						ort.env.logLevel = "error";
						if (ort.env.wasm) {
							ort.env.wasm.wasmBinary = new Uint8Array(wasmBuf.buffer, wasmBuf.byteOffset, wasmBuf.byteLength);
							ort.env.wasm.numThreads = Math.min(4, Math.max(1, navigator.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 2));

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

					if (kokoroEnv) {
						kokoroEnv.wasmPaths = (ort?.env?.wasm?.wasmPaths as any);
					}
					console.log("[let's hear it] Successfully configured in-memory wasmBinary and Data URLs!");
					return;
				}
			}

			// Fallback if fs not available
			const formattedPath = basePluginPath.endsWith("/") ? basePluginPath : `${basePluginPath}/`;
			if (ort && ort.env && ort.env.wasm) {
				ort.env.wasm.wasmPaths = formattedPath;
				ort.env.wasm.numThreads = Math.min(4, Math.max(1, navigator.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 2));
			}
			if (kokoroEnv) {
				kokoroEnv.wasmPaths = formattedPath;
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
			// Use fp32 for uncompressed natural audio fidelity (Kokoro-82M is lightweight ~300MB)
			// falling back to q8 if needed.
			const dtype = "fp32";

			// Try WebGPU first if supported, then fall back to WASM
			let device: "webgpu" | "wasm" = "wasm";
			if (typeof navigator !== "undefined" && "gpu" in navigator && (navigator as unknown as { gpu?: unknown }).gpu) {
				device = "webgpu";
			}

			try {
				console.log(`[let's hear it] Initializing KokoroTTS with device: ${device}, dtype: ${dtype}`);
				this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
					dtype,
					device,
					progress_callback: progressCallback,
				});
			} catch (firstError) {
				console.warn(`[let's hear it] Failed to initialize with ${device} (${dtype}):`, firstError);
				if (device === "webgpu") {
					console.log(`[let's hear it] Retrying with device: wasm, dtype: ${dtype}`);
					try {
						this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
							dtype,
							device: "wasm",
							progress_callback: progressCallback,
						});
					} catch (secondError) {
						console.log(`[let's hear it] Retrying with device: wasm, dtype: q8`);
						this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
							dtype: "q8" as any,
							device: "wasm",
							progress_callback: progressCallback,
						});
					}
				} else {
					console.log(`[let's hear it] Retrying with device: wasm, dtype: q8`);
					this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
						dtype: "q8" as any,
						device: "wasm",
						progress_callback: progressCallback,
					});
				}
			}

			if (downloadNotice) {
				(downloadNotice as Notice).hide();
			}

			new Notice("Kokoro voice model loaded successfully!", 2500);
			this.setState("idle", "Model ready");
			return this.ttsModel;
		})();

		return this.modelInitPromise;
	}

	/**
	 * Synthesizes a raw sentence string to an AudioBuffer.
	 */
	public async synthesizeSentence(text: string, sentenceIndex: number): Promise<SentenceAudioItem> {
		const model = await this.initModel();
		const rawAudio = await model.generate(text, {
			voice: this.voice as any,
			speed: 1.0, // Base audio generated at normal speed; speed scaling handled in WebAudio node
		});

		const sampleRate = rawAudio.sampling_rate || 24000;
		const float32Data = rawAudio.audio; // Float32Array PCM

		const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, sampleRate);
		audioBuffer.copyToChannel(float32Data, 0);

		const duration = audioBuffer.duration;

		return {
			sentenceIndex,
			text,
			audioBuffer,
			duration,
		};
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
				voice: voice as any,
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

		const promise = this.synthesizeSentence(text, sentenceIndex);
		this.audioCache.set(sentenceIndex, promise);
		return promise;
	}

	/**
	 * Strictly pre-buffers at most 2 sentences ahead sequentially to avoid RAM overload & WASM spikes.
	 * Also purges past sentences from the cache to keep memory consumption low.
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
						await this.getSentenceAudioPromise(targetIndex);
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
	 * Start reading an array of clean sentences
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

		// Trigger strict 2-sentence sequential pre-fetch in background
		this.prefetchUpcomingSentences(index, currentEpoch);

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
			source.connect(this.audioContext.destination);
			this.activeSourceNode = source;

			source.onended = () => {
				if (this.playbackSessionEpoch === currentEpoch && this.activeSourceNode === source) {
					this.activeSourceNode = null;
					this.stopTimeTracking();

					if (!this.isPaused && !this.isStopped) {
						if (this.events.onSentenceEnd) {
							this.events.onSentenceEnd(index);
						}
						// Advance to next sentence
						this.playSentence(index + 1, 0, currentEpoch);
					}
				}
			};

			if (this.events.onSentenceStart) {
				this.events.onSentenceStart(index, item);
			}

			this.setState("playing", `Reading sentence ${index + 1}/${this.sentencesQueue.length}`);
			source.start(0, startOffset);
			this.startTimeTracking(index, currentEpoch);
		} catch (error) {
			if (this.playbackSessionEpoch !== currentEpoch || this.isStopped) return;
			console.error(`[let's hear it] Playback error at sentence ${index}:`, error);
			this.setState("error", error instanceof Error ? error.message : String(error));
			if (this.events.onError) {
				this.events.onError(error instanceof Error ? error : new Error(String(error)));
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
				this.timeUpdateRafId = requestAnimationFrame(update);
			}
		};

		this.timeUpdateRafId = requestAnimationFrame(update);
	}

	private stopTimeTracking() {
		if (this.timeUpdateRafId !== null) {
			cancelAnimationFrame(this.timeUpdateRafId);
			this.timeUpdateRafId = null;
		}
	}

	private cleanupSourceNode(source: AudioBufferSourceNode) {
		source.onended = null;
		try {
			source.stop();
			source.disconnect();
		} catch (_) {}
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
		this.playSentence(this.currentSentenceIndex, this.sentencePauseOffset, this.playbackSessionEpoch);
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

import { Notice } from "obsidian";
import { KokoroTTS } from "kokoro-js";
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

	// Audio scheduling tracking
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
	 * Configures ONNX Runtime WASM paths for Obsidian Electron environment
	 */
	public static configureWasmPaths(basePluginPath: string) {
		try {
			if (ort && ort.env && ort.env.wasm) {
				ort.env.wasm.wasmPaths = basePluginPath.endsWith("/") ? basePluginPath : `${basePluginPath}/`;
				ort.env.wasm.numThreads = Math.min(4, Math.max(1, navigator.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 2));
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
			const dtype = "q4f16";

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
			} catch (gpuError) {
				console.warn(`[let's hear it] Failed to initialize with ${device}, falling back to wasm:`, gpuError);
				device = "wasm";
				this.ttsModel = await KokoroTTS.from_pretrained(modelId, {
					dtype,
					device: "wasm",
					progress_callback: progressCallback,
				});
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
			voice: "af_heart",
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
	 * Pre-buffers up to `prefetchCount` upcoming sentences in background
	 */
	private prefetchUpcomingSentences(currentIndex: number, prefetchCount = 3) {
		for (let i = 1; i <= prefetchCount; i++) {
			const targetIndex = currentIndex + i;
			if (targetIndex < this.sentencesQueue.length && !this.audioCache.has(targetIndex)) {
				this.getSentenceAudioPromise(targetIndex).catch((err) => {
					console.warn(`[let's hear it] Prefetch error for sentence ${targetIndex}:`, err);
				});
			}
		}
	}

	/**
	 * Start reading an array of clean sentences
	 */
	public async play(sentences: string[], startIndex = 0): Promise<void> {
		this.stop();
		this.isStopped = false;
		this.isPaused = false;
		this.sentencesQueue = sentences;
		this.audioCache.clear();

		if (sentences.length === 0) {
			this.setState("idle", "No sentences to read");
			return;
		}

		await this.resumeAudioContext();
		this.currentSentenceIndex = startIndex;
		await this.playSentence(startIndex);
	}

	private async resumeAudioContext() {
		if (this.audioContext.state === "suspended") {
			await this.audioContext.resume();
		}
	}

	/**
	 * Plays a specific sentence index, pre-buffering subsequent sentences
	 */
	private async playSentence(index: number, startOffset = 0): Promise<void> {
		if (this.isStopped) return;
		if (index >= this.sentencesQueue.length) {
			this.finish();
			return;
		}

		this.currentSentenceIndex = index;
		this.setState("buffering", `Preparing sentence ${index + 1}/${this.sentencesQueue.length}...`);

		// Kick off background pre-fetch for next sentences concurrently
		this.prefetchUpcomingSentences(index, 2);

		try {
			const item = await this.getSentenceAudioPromise(index);
			if (this.isStopped) return;

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
				if (this.activeSourceNode === source) {
					this.activeSourceNode = null;
					this.stopTimeTracking();

					if (!this.isPaused && !this.isStopped) {
						if (this.events.onSentenceEnd) {
							this.events.onSentenceEnd(index);
						}
						// Advance to next sentence
						this.playSentence(index + 1);
					}
				}
			};

			if (this.events.onSentenceStart) {
				this.events.onSentenceStart(index, item);
			}

			this.setState("playing", `Reading sentence ${index + 1}/${this.sentencesQueue.length}`);
			source.start(0, startOffset);
			this.startTimeTracking(index);
		} catch (error) {
			console.error(`[let's hear it] Playback error at sentence ${index}:`, error);
			this.setState("error", error instanceof Error ? error.message : String(error));
			if (this.events.onError) {
				this.events.onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private startTimeTracking(sentenceIndex: number) {
		this.stopTimeTracking();

		const update = () => {
			if (this.state === "playing" && this.activeSourceNode) {
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

	public pause(): void {
		if (this.state !== "playing" || !this.activeSourceNode) return;

		this.isPaused = true;
		const elapsedSeconds = (this.audioContext.currentTime - this.sentenceStartTime) * this.playbackRate;
		this.sentencePauseOffset = Math.min(elapsedSeconds, this.currentAudioDuration);

		this.stopTimeTracking();
		if (this.activeSourceNode) {
			try {
				this.activeSourceNode.stop();
			} catch (_) {}
			this.activeSourceNode = null;
		}

		this.setState("paused", "Paused");
	}

	public resume(): void {
		if (this.state !== "paused") return;

		this.isPaused = false;
		this.playSentence(this.currentSentenceIndex, this.sentencePauseOffset);
	}

	public stop(): void {
		this.isStopped = true;
		this.isPaused = false;
		this.stopTimeTracking();

		if (this.activeSourceNode) {
			try {
				this.activeSourceNode.stop();
			} catch (_) {}
			this.activeSourceNode = null;
		}

		this.sentencePauseOffset = 0;
		this.currentSentenceIndex = -1;
		this.setState("stopped", "Stopped");
	}

	private finish(): void {
		this.stopTimeTracking();
		this.activeSourceNode = null;
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

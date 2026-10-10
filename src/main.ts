import { Plugin, addIcon, MarkdownView, Notice, FileSystemAdapter } from "obsidian";
import { EAR_ICON_ID, EAR_ICON_SVG } from "./ui/icons";
import { TTSEngine, TTSState } from "./engine/ttsEngine";
import { cleanMarkdownForSpeech, SentenceChunk } from "./engine/cleaner";
import { FloatingPlayer } from "./ui/player";
import { WordHighlighter } from "./ui/highlighter";
import { LetsHearItSettings, DEFAULT_SETTINGS, LetsHearItSettingTab } from "./settings";

export default class LetsHearItPlugin extends Plugin {
	public settings: LetsHearItSettings = DEFAULT_SETTINGS;
	private audioContext: AudioContext | null = null;
	private ttsEngine: TTSEngine | null = null;
	private player: FloatingPlayer | null = null;
	private highlighter: WordHighlighter | null = null;
	private currentSentences: SentenceChunk[] = [];

	async onload() {
		// Load plugin settings
		await this.loadSettings();

		// Ensure Electron renderer flag is set so onnxruntime doesn't treat context as Node CLI
		if (typeof process !== "undefined" && !process.type) {
			process.type = "renderer";
		}

		// Expose require globally so any module or blob can use Node fs
		if (typeof window !== "undefined" && typeof require !== "undefined") {
			(window as any).require = require;
			(globalThis as any).require = require;
		}

		// 1. Configure ONNX WASM asset directory path for Electron sandbox
		this.configureWasmDirectory();

		// 2. Register custom ear icon
		addIcon(EAR_ICON_ID, EAR_ICON_SVG);

		// 3. Register Settings Tab
		this.addSettingTab(new LetsHearItSettingTab(this.app, this));

		// 4. Initialize components
		this.highlighter = new WordHighlighter();

		// 5. Add ribbon icon to left sidebar with autoplay-safe resume
		this.addRibbonIcon(
			EAR_ICON_ID,
			"let's hear it",
			async () => {
				await this.ensureAudioContext();
				await this.togglePlayback();
			}
		);

		// 5. Register commands
		this.addCommand({
			id: "read-current-note",
			name: "Read current note",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					if (!checking) {
						this.ensureAudioContext().then(() => this.readCurrentNote());
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "stop-reading",
			name: "Stop reading",
			callback: () => {
				this.stopReading();
			},
		});

		// 6. Track view changes to clear highlights or update active leaf
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (this.highlighter) {
					this.highlighter.setActiveView(activeView);
				}
			})
		);
	}

	onunload() {
		this.stopReading();
		if (this.player) {
			this.player.destroy();
			this.player = null;
		}
		if (this.highlighter) {
			this.highlighter.clearHighlight();
			this.highlighter = null;
		}
		if (this.audioContext && this.audioContext.state !== "closed") {
			this.audioContext.close().catch(console.error);
			this.audioContext = null;
		}
	}

	/**
	 * Configures ONNX Runtime WASM resolution to locate binaries inside the plugin directory
	 */
	private configureWasmDirectory() {
		try {
			const adapter = this.app?.vault?.adapter as any;
			let basePath = "";
			if (adapter && typeof adapter.getBasePath === "function") {
				basePath = adapter.getBasePath();
			} else if (typeof process !== "undefined" && typeof process.cwd === "function") {
				basePath = process.cwd();
			}

			if (basePath) {
				let pluginDir = basePath;
				if (this.manifest?.dir) {
					if (this.manifest.dir.startsWith("/")) {
						pluginDir = this.manifest.dir;
					} else {
						pluginDir = `${basePath.replace(/\/+$/, "")}/${this.manifest.dir.replace(/^\/+/, "")}`;
					}
				}
				const fileUrl = pluginDir.startsWith("/") ? `file://${pluginDir}/` : `file:///${pluginDir}/`;
				TTSEngine.configureWasmPaths(fileUrl);
			}
		} catch (err) {
			console.warn("[let's hear it] Could not configure custom wasm paths:", err);
		}
	}

	/**
	 * Ensures AudioContext exists and resumes on user gesture
	 */
	public async ensureAudioContext(): Promise<AudioContext> {
		if (!this.audioContext || this.audioContext.state === "closed") {
			const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			// Use default system hardware sample rate. WebAudio's AudioBufferSourceNode
			// cleanly upsamples Kokoro's 24kHz audio without CoreAudio hardware distortion or crackling.
			this.audioContext = new AudioContextClass();
		}
		if (this.audioContext.state === "suspended") {
			await this.audioContext.resume();
		}

		if (!this.ttsEngine) {
			this.ttsEngine = TTSEngine.getInstance(this.audioContext, {
				onStateChange: (state: TTSState, message?: string) => {
					this.player?.updateState(state, message);
				},
				onSentenceStart: (sentenceIndex: number, item) => {
					if (this.highlighter && this.currentSentences[sentenceIndex]) {
						this.highlighter.updateSentenceDuration(sentenceIndex, this.currentSentences[sentenceIndex], item.duration);
					}
					this.player?.setSentenceProgress(sentenceIndex, this.currentSentences.length);
				},
				onSentenceEnd: () => {
					this.highlighter?.clearHighlight();
				},
				onTimeUpdate: (sentenceIndex: number, currentTime: number) => {
					this.highlighter?.updateHighlight(sentenceIndex, currentTime);
				},
				onComplete: () => {
					this.highlighter?.clearHighlight();
				},
				onError: (err: Error) => {
					new Notice(`let's hear it error: ${err.message}`, 4000);
					this.highlighter?.clearHighlight();
				},
			});
			this.ttsEngine.setVoice(this.settings.voice);
			this.ttsEngine.setPlaybackRate(this.settings.playbackSpeed);
		}

		if (!this.player) {
			this.player = new FloatingPlayer({
				ttsEngine: this.ttsEngine,
				onClose: () => {
					this.highlighter?.clearHighlight();
				},
				onVoiceChange: async (voice: string) => {
					this.settings.voice = voice;
					await this.saveSettings();
				},
				onPlay: async () => {
					await this.readCurrentNote();
				},
			});
		}

		return this.audioContext;
	}

	public async togglePlayback(): Promise<void> {
		if (!this.ttsEngine) {
			await this.readCurrentNote();
			return;
		}

		const state = this.ttsEngine.getState();
		if (state === "playing") {
			this.ttsEngine.pause();
		} else if (state === "paused") {
			this.ttsEngine.resume();
		} else {
			await this.readCurrentNote();
		}
	}

	public async readCurrentNote(): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			new Notice("No active markdown note to read.");
			return;
		}

		await this.ensureAudioContext();

		if (this.highlighter) {
			this.highlighter.setActiveView(activeView);
			this.highlighter.clearHighlight();
		}

		// Show floating player
		if (this.player) {
			this.player.show();
		}

		// Extract note content from editor or view
		const rawMarkdown = activeView.editor ? activeView.editor.getValue() : activeView.getViewData();
		if (!rawMarkdown || !rawMarkdown.trim()) {
			new Notice("Current note is empty.");
			return;
		}

		const { sentences } = cleanMarkdownForSpeech(rawMarkdown);
		if (sentences.length === 0) {
			new Notice("No speakable text found in current note.");
			return;
		}

		this.currentSentences = sentences;
		const sentenceTexts = sentences.map((s) => s.text);

		new Notice(`let's hear it: Reading "${activeView.file?.basename ?? "note"}" (${sentences.length} sentences)`);
		await this.ttsEngine?.play(sentenceTexts, 0);
	}

	public stopReading(): void {
		if (this.ttsEngine) {
			this.ttsEngine.stop();
		}
		if (this.highlighter) {
			this.highlighter.clearHighlight();
		}
		if (this.player) {
			this.player.hide();
		}
	}

	public async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	public getTTSEngine(): TTSEngine | null {
		return this.ttsEngine;
	}
}

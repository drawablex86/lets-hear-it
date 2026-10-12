import { Plugin, addIcon, MarkdownView, Notice, TFile, MenuItem } from "obsidian";
import { EAR_ICON_ID, EAR_ICON_SVG, GLASSES_ICON_ID, GLASSES_ICON_SVG, RECORD_ICON_ID, RECORD_ICON_SVG } from "./ui/icons";
import { TTSEngine, TTSState } from "./engine/ttsEngine";
import { cleanMarkdownForSpeech, SentenceChunk } from "./engine/cleaner";
import { FloatingPlayer } from "./ui/player";
import { WordHighlighter } from "./ui/highlighter";
import { LetsHearItSettings, DEFAULT_SETTINGS, LetsHearItSettingTab } from "./settings";
import { ExportMp3Modal } from "./ui/recordModal";
import { WasmAssetManager } from "./engine/wasmDownloader";

export default class LetsHearItPlugin extends Plugin {
	public settings: LetsHearItSettings = DEFAULT_SETTINGS;
	public wasmAssetManager: WasmAssetManager = new WasmAssetManager(this);
	private audioContext: AudioContext | null = null;
	private ttsEngine: TTSEngine | null = null;
	private player: FloatingPlayer | null = null;
	private highlighter: WordHighlighter | null = null;
	private currentSentences: SentenceChunk[] = [];
	private ribbonEarEl: HTMLElement | null = null;

	async onload() {
		// Load plugin settings
		await this.loadSettings();

		// Ensure Electron renderer flag is set so onnxruntime doesn't treat context as Node CLI
		const setRendererFlag = (p: unknown) => {
			if (p && typeof p === "object") {
				const proc = p as { type?: string };
				if (proc.type !== "renderer") {
					try {
						proc.type = "renderer";
					} catch {
						try {
							Object.defineProperty(proc, "type", {
								value: "renderer",
								writable: true,
								configurable: true,
								enumerable: true,
							});
						} catch {
							// Ignore if property is frozen
						}
					}
				}
			}
		};

		if (typeof process !== "undefined") {
			setRendererFlag(process);
		}
		const win = typeof window !== "undefined" ? (window as unknown as { process?: unknown }) : undefined;
		if (win?.process) {
			setRendererFlag(win.process);
		}

		// Expose require on window so in-memory modules can access Node fs
		if (typeof window !== "undefined" && typeof require !== "undefined") {
			(window as unknown as { require?: typeof require }).require = require;
		}

		// 1. Configure ONNX WASM asset directory path for Electron sandbox
		this.configureWasmDirectory();

		// 2. Register custom ear icon, glasses icon, and record icon
		addIcon(EAR_ICON_ID, EAR_ICON_SVG);
		addIcon(GLASSES_ICON_ID, GLASSES_ICON_SVG);
		addIcon(RECORD_ICON_ID, RECORD_ICON_SVG);

		// 3. Register Settings Tab
		this.addSettingTab(new LetsHearItSettingTab(this.app, this));

		// 4. Initialize components
		this.highlighter = new WordHighlighter();
		this.highlighter.setAutoScroll(this.settings.autoScroll);

		// 5. Add ribbon icon to left sidebar with playback toggle
		this.ribbonEarEl = this.addRibbonIcon(
			EAR_ICON_ID,
			"let's hear it: Read current note",
			async () => {
				await this.ensureAudioContext();
				await this.togglePlayback();
			}
		);

		// 6. Add record ribbon icon on the left to export note as MP3
		this.addRibbonIcon(
			RECORD_ICON_ID,
			"let's hear it: Export note as MP3",
			() => {
				this.openExportModalForActiveNote();
			}
		);

		// 7. Register context menu item on files in the file explorer
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item: MenuItem) => {
						item.setTitle("Export as MP3 with let's hear it")
							.setIcon(RECORD_ICON_ID)
							.onClick(() => {
								new ExportMp3Modal(this.app, this, file).open();
							});
					});
				}
			})
		);

		// 8. Register editor context menu item
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				const selectedText = editor.getSelection();
				if (selectedText && selectedText.trim().length > 0) {
					menu.addItem((item: MenuItem) => {
						item.setTitle("Read selected text")
							.setIcon(EAR_ICON_ID)
							.onClick(async () => {
								await this.ensureAudioContext();
								await this.readSelection();
							});
					});

					if (view.file && view.file.extension === "md") {
						menu.addItem((item: MenuItem) => {
							item.setTitle("Export selected text to MP3")
								.setIcon(RECORD_ICON_ID)
								.onClick(() => {
									new ExportMp3Modal(this.app, this, view.file!, selectedText).open();
								});
						});
					}
				}

				if (view.file && view.file.extension === "md") {
					menu.addItem((item: MenuItem) => {
						item.setTitle("Export note to MP3")
							.setIcon(RECORD_ICON_ID)
							.onClick(() => {
								new ExportMp3Modal(this.app, this, view.file!).open();
							});
					});
				}
			})
		);

		// 9. Register commands
		this.addCommand({
			id: "read-selected-text",
			name: "Read selected text",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const hasSelection = !!this.getActiveSelection(activeView);
				if (activeView && hasSelection) {
					if (!checking) {
						void this.ensureAudioContext()
							.then(() => this.readSelection())
							.catch((err) => console.error("[let's hear it] Failed to start audio:", err));
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "export-selection-to-mp3",
			name: "Export selected text to MP3",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const selection = this.getActiveSelection(activeView);
				if (activeView && activeView.file && selection) {
					if (!checking) {
						new ExportMp3Modal(this.app, this, activeView.file, selection).open();
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "read-current-note",
			name: "Read current note",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					if (!checking) {
						void this.ensureAudioContext()
							.then(() => this.readCurrentNote())
							.catch((err) => console.error("[let's hear it] Failed to start audio:", err));
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "export-note-to-mp3",
			name: "Export current note to MP3",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file) {
					if (!checking) {
						new ExportMp3Modal(this.app, this, activeView.file).open();
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

		// 10. Track view changes to clear highlights or update active leaf
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (this.highlighter) {
					this.highlighter.setActiveView(activeView);
				}
			})
		);

		// 11. Deferred background model pre-warming during idle time
		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => {
				const status = this.wasmAssetManager.checkStatus();
				if (status.isReady) {
					void this.ensureAudioContext()
						.then(() => this.ttsEngine?.prewarm())
						.catch(() => {});
				}
			}, 3000);
		});
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
	public reconfigureWasmDirectory() {
		this.configureWasmDirectory();
	}

	private configureWasmDirectory() {
		try {
			const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
			let basePath = "";
			if (typeof adapter?.getBasePath === "function") {
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
	 * Ensures local WASM speech engine files are downloaded before attempting playback
	 */
	public async ensureEngineReady(): Promise<boolean> {
		const status = this.wasmAssetManager.checkStatus();
		if (status.isReady) {
			return true;
		}

		new Notice("Let's Hear It: Downloading offline speech engine files (~21 MB)...", 5000);
		let notice: Notice | null = null;
		const success = await this.wasmAssetManager.downloadAssets((pct, msg) => {
			if (!notice) {
				notice = new Notice(msg, 0);
			} else {
				notice.setMessage(`[let's hear it] ${msg} (${pct}%)`);
			}
		});

		if (notice) {
			(notice as Notice).hide();
		}

		return success;
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
						this.highlighter.setActiveSentence(sentenceIndex, this.currentSentences[sentenceIndex]);
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
				onVoiceChange: (voice: string) => {
					this.settings.voice = voice;
					void this.saveSettings();
				},
				onPlay: () => {
					const selection = this.getActiveSelection();
					if (selection) {
						void this.readSelection();
					} else {
						void this.readCurrentNote();
					}
				},
				onToggleHearingMode: () => {
					void this.toggleHearingMode();
				},
			});
		}

		return this.audioContext;
	}

	private previousViewMode: string | null = null;

	public async toggleHearingMode(): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		const currentMode = activeView.getMode();
		const targetMode = currentMode === "preview" ? "source" : "preview";
		await activeView.leaf.setViewState({
			...activeView.leaf.getViewState(),
			state: {
				...activeView.leaf.getViewState().state,
				mode: targetMode,
			},
		});

		new Notice(`Switched to ${targetMode === "preview" ? "Hearing Mode (Reading View)" : "Editing Mode"}`);
		if (this.highlighter) {
			this.highlighter.setActiveView(activeView);
		}
	}

	public async togglePlayback(): Promise<void> {
		if (!this.ttsEngine) {
			const selection = this.getActiveSelection();
			if (selection) {
				await this.readSelection();
			} else {
				await this.readCurrentNote();
			}
			return;
		}

		const state = this.ttsEngine.getState();
		if (state === "playing") {
			this.ttsEngine.pause();
		} else if (state === "paused") {
			this.ttsEngine.resume();
		} else {
			const selection = this.getActiveSelection();
			if (selection) {
				await this.readSelection();
			} else {
				await this.readCurrentNote();
			}
		}
	}

	public getActiveSelection(view?: MarkdownView | null): string | null {
		const activeView = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return null;

		// 1. Editor selection (source / live-preview)
		if (activeView.editor) {
			const selection = activeView.editor.getSelection();
			if (selection && selection.trim().length > 0) {
				return selection;
			}
		}

		// 2. DOM selection fallback (preview / reading view)
		if (typeof window !== "undefined") {
			const sel = window.getSelection();
			const text = sel ? sel.toString().trim() : "";
			if (text.length > 0) {
				return text;
			}
		}

		return null;
	}

	public async readSelection(): Promise<void> {
		if (this.isStartingPlayback) return;
		this.isStartingPlayback = true;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			this.isStartingPlayback = false;
			new Notice("No active markdown note to read from.");
			return;
		}

		const selectedText = this.getActiveSelection(activeView);
		if (!selectedText || !selectedText.trim()) {
			this.isStartingPlayback = false;
			new Notice("No text selected to read.");
			return;
		}

		// 1. Instant UI Feedback: Mount/unhide player immediately with preparing state
		const noteTitle = activeView.file?.basename ?? "Note";
		await this.ensureAudioContext();
		this.ribbonEarEl?.addClass("lets-hear-it-loading-pulse");
		this.player?.showPreparing("selection", noteTitle);

		try {
			const engineReady = await this.ensureEngineReady();
			if (!engineReady) {
				this.player?.hide();
				return;
			}

			if (this.highlighter) {
				this.highlighter.setActiveView(activeView);
				this.highlighter.clearHighlight();
			}

			const { sentences } = cleanMarkdownForSpeech(selectedText);
			if (sentences.length === 0) {
				new Notice("No speakable text found in selection.");
				this.player?.hide();
				return;
			}

			this.currentSentences = sentences;
			const sentenceTexts = sentences.map((s) => s.text);

			new Notice(`let's hear it: Reading selected portion (${sentences.length} sentences)`);
			await this.ttsEngine?.play(sentenceTexts, 0);
		} finally {
			this.ribbonEarEl?.removeClass("lets-hear-it-loading-pulse");
			this.isStartingPlayback = false;
		}
	}

	public async readCurrentNote(): Promise<void> {
		if (this.isStartingPlayback) return;
		this.isStartingPlayback = true;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			this.isStartingPlayback = false;
			new Notice("No active markdown note to read.");
			return;
		}

		// 1. Instant UI Feedback: Mount/unhide player immediately with preparing state
		const noteTitle = activeView.file?.basename ?? "Note";
		await this.ensureAudioContext();
		this.ribbonEarEl?.addClass("lets-hear-it-loading-pulse");
		this.player?.showPreparing("note", noteTitle);

		try {
			const engineReady = await this.ensureEngineReady();
			if (!engineReady) {
				this.player?.hide();
				return;
			}

			// If hearingModeOnPlay setting is enabled and not already in preview mode, switch to preview
			if (this.settings.hearingModeOnPlay) {
				const currentMode = activeView.getMode();
				if (currentMode !== "preview") {
					this.previousViewMode = currentMode;
					await activeView.leaf.setViewState({
						...activeView.leaf.getViewState(),
						state: {
							...activeView.leaf.getViewState().state,
							mode: "preview",
						},
					});
				}
			}

			if (this.highlighter) {
				this.highlighter.setActiveView(activeView);
				this.highlighter.clearHighlight();
			}

			// Extract note content from editor or view
			const rawMarkdown = activeView.editor ? activeView.editor.getValue() : activeView.getViewData();
			if (!rawMarkdown || !rawMarkdown.trim()) {
				new Notice("Current note is empty.");
				this.player?.hide();
				return;
			}

			const { sentences } = cleanMarkdownForSpeech(rawMarkdown);
			if (sentences.length === 0) {
				new Notice("No speakable text found in current note.");
				this.player?.hide();
				return;
			}

			this.currentSentences = sentences;
			const sentenceTexts = sentences.map((s) => s.text);

			new Notice(`let's hear it: Reading "${activeView.file?.basename ?? "note"}" (${sentences.length} sentences)`);
			await this.ttsEngine?.play(sentenceTexts, 0);
		} finally {
			this.ribbonEarEl?.removeClass("lets-hear-it-loading-pulse");
			this.isStartingPlayback = false;
		}
	}

	public openExportModalForActiveNote(): void {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView || !activeView.file) {
			new Notice("Please open a markdown note to export as MP3.");
			return;
		}

		new ExportMp3Modal(this.app, this, activeView.file).open();
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

		// Restore previous mode if user was switched automatically
		if (this.previousViewMode) {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && activeView.getMode() !== this.previousViewMode) {
				activeView.leaf.setViewState({
					...activeView.leaf.getViewState(),
					state: {
						...activeView.leaf.getViewState().state,
						mode: this.previousViewMode,
					},
				}).catch(() => {});
			}
			this.previousViewMode = null;
		}
	}

	public async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<LetsHearItSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	public getTTSEngine(): TTSEngine | null {
		return this.ttsEngine;
	}

	public getHighlighter(): WordHighlighter | null {
		return this.highlighter;
	}
}

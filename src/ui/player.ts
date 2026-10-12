import { setIcon } from "obsidian";
import { TTSEngine, TTSState } from "../engine/ttsEngine";
import { GLASSES_ICON_ID } from "./icons";
import { WaveformVisualizer } from "./waveform";

export type PlaybackScope = "note" | "selection";

export interface FloatingPlayerOptions {
	ttsEngine: TTSEngine;
	onClose?: () => void;
	onVoiceChange?: (voice: string) => void;
	onPlay?: () => void;
	onToggleHearingMode?: () => void;
}

export class FloatingPlayer {
	private containerEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private subtextEl: HTMLElement | null = null;
	private waveform: WaveformVisualizer | null = null;
	private playPauseBtn: HTMLButtonElement | null = null;
	private stopBtn: HTMLButtonElement | null = null;
	private modeBtn: HTMLButtonElement | null = null;
	private speedSelect: HTMLSelectElement | null = null;
	private voiceSelect: HTMLSelectElement | null = null;
	private isVisible = false;
	private playbackScope: PlaybackScope = "note";

	private ttsEngine: TTSEngine;
	private onClose?: () => void;
	private onVoiceChange?: (voice: string) => void;
	private onPlay?: () => void;
	private onToggleHearingMode?: () => void;

	constructor(options: FloatingPlayerOptions) {
		this.ttsEngine = options.ttsEngine;
		this.onClose = options.onClose;
		this.onVoiceChange = options.onVoiceChange;
		this.onPlay = options.onPlay;
		this.onToggleHearingMode = options.onToggleHearingMode;
	}

	public setPlaybackScope(scope: PlaybackScope): void {
		this.playbackScope = scope;
		if (this.isVisible) {
			this.updateState(this.ttsEngine.getState());
		}
	}

	public getPlaybackScope(): PlaybackScope {
		return this.playbackScope;
	}

	/**
	 * Mounts the floating player into the active document body or workspace leaf
	 */
	public show(): void {
		if (this.isVisible && this.containerEl) {
			this.containerEl.removeClass("is-hidden");
			return;
		}

		if (!this.containerEl) {
			this.createDOM();
		}

		if (this.containerEl) {
			this.containerEl.removeClass("is-hidden");
			this.isVisible = true;
			this.updateState(this.ttsEngine.getState());
		}
	}

	/**
	 * Instantly mounts and displays the player with an immediate preparing status
	 */
	public showPreparing(scope: PlaybackScope, noteTitle = "Note"): void {
		this.playbackScope = scope;
		if (!this.containerEl) {
			this.createDOM();
		}

		if (this.containerEl) {
			this.containerEl.removeClass("is-hidden");
			this.isVisible = true;

			if (this.statusEl) {
				this.statusEl.textContent = scope === "selection" ? "Preparing selection..." : "Preparing note...";
			}
			if (this.subtextEl) {
				this.subtextEl.textContent = `Loading voice model for "${noteTitle}"...`;
			}
			if (this.playPauseBtn) {
				setIcon(this.playPauseBtn, "loader-2");
				this.playPauseBtn.addClass("lets-hear-it-loading-pulse");
			}
			this.waveform?.start();
		}
	}

	public hide(): void {
		if (this.containerEl) {
			this.containerEl.addClass("is-hidden");
		}
		this.waveform?.stop();
		this.isVisible = false;
	}

	public destroy(): void {
		if (this.waveform) {
			this.waveform.destroy();
			this.waveform = null;
		}
		if (this.containerEl) {
			this.containerEl.remove();
			this.containerEl = null;
		}
		this.isVisible = false;
	}

	private createDOM(): void {
		const container = document.body.createDiv({ cls: "lets-hear-it-player" });
		this.containerEl = container;

		// 1. Info / Status Text Area
		const infoEl = container.createDiv({ cls: "lets-hear-it-player-info" });
		this.statusEl = infoEl.createDiv({ cls: "lets-hear-it-player-status", text: "let's hear it" });
		this.subtextEl = infoEl.createDiv({ cls: "lets-hear-it-player-subtext", text: "Ready" });

		// 2. Waveform Visualizer
		this.waveform = new WaveformVisualizer(container, this.ttsEngine, 5);

		// 3. Playback Controls Group
		const controlsEl = container.createDiv({ cls: "lets-hear-it-player-controls" });

		// Play/Pause Button
		const playPauseBtn = controlsEl.createEl("button", {
			cls: "lets-hear-it-btn lets-hear-it-btn-primary",
			attr: { "aria-label": "Play / Pause", title: "Play / Pause" },
		});
		setIcon(playPauseBtn, "play");
		let lastClickTime = 0;
		playPauseBtn.addEventListener("click", () => {
			const now = Date.now();
			if (now - lastClickTime < 300) return; // Prevent double-click race conditions
			lastClickTime = now;

			const state = this.ttsEngine.getState();
			if (state === "playing") {
				this.ttsEngine.pause();
			} else if (state === "paused") {
				this.ttsEngine.resume();
			} else {
				if (this.onPlay) {
					this.onPlay();
				}
			}
		});
		this.playPauseBtn = playPauseBtn;

		// Stop Button
		const stopBtn = controlsEl.createEl("button", {
			cls: "lets-hear-it-btn",
			attr: { "aria-label": "Stop", title: "Stop" },
		});
		setIcon(stopBtn, "square");
		stopBtn.addEventListener("click", () => {
			this.ttsEngine.stop();
		});
		this.stopBtn = stopBtn;

		// Hearing Mode View Toggle Button (Glasses / Reading Mode)
		const modeBtn = controlsEl.createEl("button", {
			cls: "lets-hear-it-btn",
			attr: { "aria-label": "Toggle Hearing Mode (Reading View)", title: "Toggle Hearing Mode (Reading View)" },
		});
		setIcon(modeBtn, GLASSES_ICON_ID);
		modeBtn.addEventListener("click", () => {
			if (this.onToggleHearingMode) {
				this.onToggleHearingMode();
			}
		});
		this.modeBtn = modeBtn;

		// Speed Selector
		const speedSelect = controlsEl.createEl("select", {
			cls: "lets-hear-it-speed-select",
			attr: { "aria-label": "Playback Speed", title: "Playback Speed" },
		});

		const speeds = [
			{ label: "0.75x", value: "0.75" },
			{ label: "1.0x", value: "1.0" },
			{ label: "1.25x", value: "1.25" },
			{ label: "1.5x", value: "1.5" },
			{ label: "2.0x", value: "2.0" },
		];

		const currentRate = this.ttsEngine.getPlaybackRate().toString();
		for (const s of speeds) {
			const opt = speedSelect.createEl("option", { value: s.value, text: s.label });
			if (s.value === currentRate || (currentRate === "1" && s.value === "1.0")) {
				opt.selected = true;
			}
		}

		speedSelect.addEventListener("change", () => {
			const val = parseFloat(speedSelect.value);
			this.ttsEngine.setPlaybackRate(val);
		});
		this.speedSelect = speedSelect;

		// Voice Selector
		const voiceSelect = controlsEl.createEl("select", {
			cls: "lets-hear-it-voice-select",
			attr: { "aria-label": "Select Voice", title: "Select Voice" },
		});

		const quickVoices = [
			{ id: "af_heart", label: "Heart (US Female)" },
			{ id: "af_bella", label: "Bella (US Female)" },
			{ id: "af_nicole", label: "Nicole (US Female)" },
			{ id: "af_aoede", label: "Aoede (US Female)" },
			{ id: "af_sarah", label: "Sarah (US Female)" },
			{ id: "am_michael", label: "Michael (US Male)" },
			{ id: "am_fenrir", label: "Fenrir (US Male)" },
			{ id: "am_puck", label: "Puck (US Male)" },
			{ id: "am_echo", label: "Echo (US Male)" },
			{ id: "bf_emma", label: "Emma (UK Female)" },
			{ id: "bf_isabella", label: "Isabella (UK Female)" },
			{ id: "bm_george", label: "George (UK Male)" },
			{ id: "bm_fable", label: "Fable (UK Male)" },
		];

		const activeVoice = this.ttsEngine.getVoice();
		for (const v of quickVoices) {
			const opt = voiceSelect.createEl("option", { value: v.id, text: v.label });
			if (v.id === activeVoice) {
				opt.selected = true;
			}
		}

		voiceSelect.addEventListener("change", () => {
			const selectedVoice = voiceSelect.value;
			this.ttsEngine.setVoice(selectedVoice);
			if (this.onVoiceChange) {
				this.onVoiceChange(selectedVoice);
			}
		});
		this.voiceSelect = voiceSelect;

		// Close / Dismiss Button
		const closeBtn = container.createEl("button", {
			cls: "lets-hear-it-btn-close",
			attr: { "aria-label": "Close player", title: "Close player" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => {
			this.ttsEngine.stop();
			this.hide();
			if (this.onClose) {
				this.onClose();
			}
		});
	}

	public updateState(state: TTSState, message?: string): void {
		if (!this.containerEl) return;

		if (this.playPauseBtn) {
			this.playPauseBtn.removeClass("lets-hear-it-loading-pulse");
			if (state === "playing") {
				setIcon(this.playPauseBtn, "pause");
			} else {
				setIcon(this.playPauseBtn, "play");
			}
		}

		if (state === "playing" || state === "buffering" || state === "loading-model") {
			this.waveform?.start();
		} else {
			this.waveform?.stop();
		}

		if (this.statusEl) {
			switch (state) {
				case "loading-model":
					this.statusEl.textContent = "Loading Model...";
					break;
				case "buffering":
					this.statusEl.textContent = "Buffering...";
					break;
				case "playing":
					this.statusEl.textContent = this.playbackScope === "selection" ? "Reading Selection" : "Reading Note";
					break;
				case "paused":
					this.statusEl.textContent = "Paused";
					break;
				case "stopped":
				case "idle":
					this.statusEl.textContent = "let's hear it";
					break;
				case "error":
					this.statusEl.textContent = "Error";
					break;
			}
		}

		if (this.subtextEl) {
			if (message) {
				this.subtextEl.textContent = message;
			} else if (state === "playing" || state === "paused") {
				const current = this.ttsEngine.getCurrentSentenceIndex() + 1;
				const total = this.ttsEngine.getTotalSentences();
				const scopeSuffix = this.playbackScope === "selection" ? " (Selection)" : "";
				this.subtextEl.textContent = `Sentence ${current} of ${total}${scopeSuffix}`;
			} else if (state === "idle" || state === "stopped") {
				this.subtextEl.textContent = "Ready";
			}
		}
	}

	public setSentenceProgress(current: number, total: number): void {
		if (this.subtextEl) {
			const scopeSuffix = this.playbackScope === "selection" ? " (Selection)" : "";
			this.subtextEl.textContent = `Sentence ${current + 1} of ${total}${scopeSuffix}`;
		}
	}
}

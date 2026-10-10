import { setIcon } from "obsidian";
import { TTSEngine, TTSState } from "../engine/ttsEngine";

export interface FloatingPlayerOptions {
	ttsEngine: TTSEngine;
	onClose?: () => void;
}

export class FloatingPlayer {
	private containerEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private subtextEl: HTMLElement | null = null;
	private playPauseBtn: HTMLButtonElement | null = null;
	private stopBtn: HTMLButtonElement | null = null;
	private speedSelect: HTMLSelectElement | null = null;
	private isVisible = false;

	private ttsEngine: TTSEngine;
	private onClose?: () => void;

	constructor(options: FloatingPlayerOptions) {
		this.ttsEngine = options.ttsEngine;
		this.onClose = options.onClose;
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

	public hide(): void {
		if (this.containerEl) {
			this.containerEl.addClass("is-hidden");
		}
		this.isVisible = false;
	}

	public destroy(): void {
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

		// 2. Playback Controls Group
		const controlsEl = container.createDiv({ cls: "lets-hear-it-player-controls" });

		// Play/Pause Button
		const playPauseBtn = controlsEl.createEl("button", {
			cls: "lets-hear-it-btn lets-hear-it-btn-primary",
			attr: { "aria-label": "Play / Pause", title: "Play / Pause" },
		});
		setIcon(playPauseBtn, "play");
		playPauseBtn.addEventListener("click", () => {
			const state = this.ttsEngine.getState();
			if (state === "playing") {
				this.ttsEngine.pause();
			} else if (state === "paused") {
				this.ttsEngine.resume();
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

		for (const s of speeds) {
			const opt = speedSelect.createEl("option", { value: s.value, text: s.label });
			if (s.value === "1.0") {
				opt.selected = true;
			}
		}

		speedSelect.addEventListener("change", () => {
			const val = parseFloat(speedSelect.value);
			this.ttsEngine.setPlaybackRate(val);
		});
		this.speedSelect = speedSelect;

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
			if (state === "playing") {
				setIcon(this.playPauseBtn, "pause");
			} else {
				setIcon(this.playPauseBtn, "play");
			}
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
					this.statusEl.textContent = "Reading Note";
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
				this.subtextEl.textContent = `Sentence ${current} of ${total}`;
			} else if (state === "idle" || state === "stopped") {
				this.subtextEl.textContent = "Ready";
			}
		}
	}

	public setSentenceProgress(current: number, total: number): void {
		if (this.subtextEl) {
			this.subtextEl.textContent = `Sentence ${current + 1} of ${total}`;
		}
	}
}

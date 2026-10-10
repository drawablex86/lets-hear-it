import { Plugin, addIcon, MarkdownView, Notice } from "obsidian";
import { EAR_ICON_ID, EAR_ICON_SVG } from "./ui/icons";

export default class LetsHearItPlugin extends Plugin {
	private audioContext: AudioContext | null = null;
	private ribbonIconEl: HTMLElement | null = null;

	async onload() {
		// Register custom ear icon
		addIcon(EAR_ICON_ID, EAR_ICON_SVG);

		// Add ribbon icon to left sidebar
		this.ribbonIconEl = this.addRibbonIcon(
			EAR_ICON_ID,
			"let's hear it",
			async () => {
				await this.ensureAudioContext();
				await this.togglePlayback();
			}
		);

		// Register commands
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
	}

	onunload() {
		this.stopReading();
		if (this.audioContext && this.audioContext.state !== "closed") {
			this.audioContext.close().catch(console.error);
			this.audioContext = null;
		}
	}

	/**
	 * Ensures AudioContext exists and resumes on user gesture to adhere to Chromium autoplay policies.
	 */
	public async ensureAudioContext(): Promise<AudioContext> {
		if (!this.audioContext || this.audioContext.state === "closed") {
			const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			this.audioContext = new AudioContextClass();
		}
		if (this.audioContext.state === "suspended") {
			await this.audioContext.resume();
		}
		return this.audioContext;
	}

	public getAudioContext(): AudioContext | null {
		return this.audioContext;
	}

	public async togglePlayback(): Promise<void> {
		new Notice("let's hear it: Toggling playback");
	}

	public async readCurrentNote(): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			new Notice("No active markdown note to read.");
			return;
		}
		new Notice(`let's hear it: Reading "${activeView.file?.basename ?? "note"}"`);
	}

	public stopReading(): void {
		new Notice("let's hear it: Stopped reading");
	}
}

import { Modal, App, Setting, Notice, TFile } from "obsidian";
import { KOKORO_VOICES } from "../settings";
import type LetsHearItPlugin from "../main";
import { cleanMarkdownForSpeech } from "../engine/cleaner";
import { encodeFloat32ToMp3 } from "../engine/mp3Encoder";
import { TTSEngine } from "../engine/ttsEngine";

export class ExportMp3Modal extends Modal {
	private plugin: LetsHearItPlugin;
	private targetFile: TFile;
	private selectedVoice: string;
	private sentences: string[] = [];

	private statusEl: HTMLElement | null = null;
	private progressBarEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private generateBtn: HTMLButtonElement | null = null;
	private isGenerating = false;

	constructor(app: App, plugin: LetsHearItPlugin, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.targetFile = file;
		this.selectedVoice = plugin.settings.voice || "af_heart";
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("lets-hear-it-record-modal");

		contentEl.createEl("h2", { text: "Create MP3 Audio from Note" });

		// Read and clean the target note
		const rawContent = await this.app.vault.read(this.targetFile);
		const { sentences } = cleanMarkdownForSpeech(rawContent);
		this.sentences = sentences.map((s) => s.text);

		// Note Summary Card
		const noteSummary = contentEl.createDiv({ cls: "lets-hear-it-modal-summary" });
		noteSummary.createEl("div", {
			cls: "lets-hear-it-modal-filename",
			text: `📄 Note: ${this.targetFile.basename}`,
		});
		const speechBatches = TTSEngine.groupSentencesIntoSpeechChunks(this.sentences, 380);
		noteSummary.createEl("div", {
			cls: "lets-hear-it-modal-sentence-count",
			text: `Found ${this.sentences.length} sentences (optimized into ${speechBatches.length} speech batches for fast generation)`,
		});

		// Destination preview
		const destFolder = this.plugin.settings.exportFolder
			? this.plugin.settings.exportFolder.replace(/^\/+|\/+$/g, "")
			: "(vault root)";
		const destPathPreview = `${destFolder}/${this.targetFile.basename}.mp3`;
		noteSummary.createEl("div", {
			cls: "lets-hear-it-modal-dest",
			text: `Output destination: ${destPathPreview}`,
		});

		if (this.sentences.length === 0) {
			contentEl.createEl("p", {
				cls: "lets-hear-it-modal-warning",
				text: "This note contains no speakable text to generate audio from.",
			});
			return;
		}

		// Voice Selector
		new Setting(contentEl)
			.setName("Speech voice")
			.setDesc("Choose the neural Kokoro voice for this MP3")
			.addDropdown((dropdown) => {
				for (const v of KOKORO_VOICES) {
					dropdown.addOption(v.id, `${v.name} (${v.accent} ${v.gender})`);
				}
				dropdown.setValue(this.selectedVoice);
				dropdown.onChange((val) => {
					this.selectedVoice = val;
				});
			});

		// Progress Area
		const progressContainer = contentEl.createDiv({ cls: "lets-hear-it-modal-progress is-hidden" });
		this.progressBarEl = progressContainer.createDiv({ cls: "lets-hear-it-progress-track" });
		this.progressFillEl = this.progressBarEl.createDiv({ cls: "lets-hear-it-progress-fill" });
		this.statusEl = progressContainer.createDiv({
			cls: "lets-hear-it-modal-status-text",
			text: "Ready to generate...",
		});

		// Action Buttons Container
		const btnContainer = contentEl.createDiv({ cls: "lets-hear-it-modal-buttons" });

		const cancelBtn = btnContainer.createEl("button", {
			text: "Cancel",
			cls: "mod-cancel",
		});
		cancelBtn.addEventListener("click", () => {
			if (!this.isGenerating) {
				this.close();
			} else {
				new Notice("Generation in progress. Please wait...");
			}
		});

		this.generateBtn = btnContainer.createEl("button", {
			text: "Generate MP3",
			cls: "mod-cta",
		});
		this.generateBtn.addEventListener("click", async () => {
			await this.startGeneration(progressContainer);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private async startGeneration(progressContainer: HTMLElement): Promise<void> {
		if (this.isGenerating) return;
		this.isGenerating = true;

		if (this.generateBtn) {
			this.generateBtn.disabled = true;
			this.generateBtn.textContent = "Generating...";
		}
		progressContainer.removeClass("is-hidden");

		try {
			await this.plugin.ensureAudioContext();
			const ttsEngine = this.plugin.getTTSEngine();
			if (!ttsEngine) {
				throw new Error("TTS Engine is not initialized");
			}

			if (this.statusEl) {
				this.statusEl.textContent = "Loading Kokoro neural voice model...";
			}
			if (this.progressFillEl) {
				this.progressFillEl.style.width = "5%";
			}

			// 1. Synthesize all sentences into a Float32Array PCM
			const totalSentences = this.sentences.length;
			const pcmData = await ttsEngine.generateFullAudio(
				this.sentences,
				this.selectedVoice,
				(current, total, msg) => {
					if (this.statusEl && msg) {
						this.statusEl.textContent = msg;
					}
					if (this.progressFillEl) {
						const pct = Math.floor((current / total) * 85);
						this.progressFillEl.style.width = `${Math.max(5, pct)}%`;
					}
				}
			);

			// 2. Encode to MP3
			if (this.statusEl) {
				this.statusEl.textContent = "Encoding audio to MP3 format...";
			}
			if (this.progressFillEl) {
				this.progressFillEl.style.width = "90%";
			}

			// Let UI re-render before blocking CPU with encode
			await new Promise((r) => setTimeout(r, 20));

			const mp3ArrayBuffer = encodeFloat32ToMp3(pcmData, 24000, 128);

			// 3. Save to Obsidian Vault
			if (this.statusEl) {
				this.statusEl.textContent = "Saving MP3 to vault...";
			}
			if (this.progressFillEl) {
				this.progressFillEl.style.width = "98%";
			}

			const savedFile = await this.saveMp3ToVault(mp3ArrayBuffer);

			if (this.progressFillEl) {
				this.progressFillEl.style.width = "100%";
			}

			new Notice(`MP3 successfully created: ${savedFile.path}`, 6000);
			this.close();
		} catch (error) {
			console.error("[let's hear it] MP3 generation failed:", error);
			const errorMsg = error instanceof Error ? error.message : String(error);
			new Notice(`MP3 Generation Error: ${errorMsg}`, 6000);
			if (this.statusEl) {
				this.statusEl.textContent = `Error: ${errorMsg}`;
			}
			if (this.generateBtn) {
				this.generateBtn.disabled = false;
				this.generateBtn.textContent = "Retry Generation";
			}
			this.isGenerating = false;
		}
	}

	/**
	 * Saves the MP3 ArrayBuffer to the designated vault folder, avoiding overwriting.
	 */
	private async saveMp3ToVault(buffer: ArrayBuffer): Promise<TFile> {
		const rawFolder = (this.plugin.settings.exportFolder || "").trim();
		// Normalize folder path: trim slashes
		const folderPath = rawFolder.replace(/^\/+|\/+$/g, "");

		// Ensure directory exists
		if (folderPath.length > 0) {
			const folderExists = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folderExists) {
				await this.app.vault.createFolder(folderPath);
			}
		}

		// Compute available filename
		const baseName = this.targetFile.basename;
		let fileName = `${baseName}.mp3`;
		let fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;
		let counter = 1;

		while (this.app.vault.getAbstractFileByPath(fullPath)) {
			fileName = `${baseName} (${counter}).mp3`;
			fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;
			counter++;
		}

		return await this.app.vault.createBinary(fullPath, buffer);
	}
}

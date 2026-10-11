import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type LetsHearItPlugin from "./main";

export interface LetsHearItSettings {
	voice: string;
	playbackSpeed: number;
	hearingModeOnPlay: boolean;
	autoScroll: boolean;
	exportFolder: string;
}

export const DEFAULT_SETTINGS: LetsHearItSettings = {
	voice: "af_heart",
	playbackSpeed: 1.0,
	hearingModeOnPlay: true,
	autoScroll: true,
	exportFolder: "",
};

export interface VoiceOption {
	id: string;
	name: string;
	gender: "Female" | "Male";
	accent: "American" | "British";
	description: string;
}

export const KOKORO_VOICES: VoiceOption[] = [
	// American Female
	{ id: "af_heart", name: "Heart (Recommended)", gender: "Female", accent: "American", description: "Warm, natural, clear tone" },
	{ id: "af_bella", name: "Bella", gender: "Female", accent: "American", description: "Expressive, dynamic" },
	{ id: "af_nicole", name: "Nicole", gender: "Female", accent: "American", description: "Crisp, podcast-style" },
	{ id: "af_aoede", name: "Aoede", gender: "Female", accent: "American", description: "Smooth, articulate" },
	{ id: "af_kore", name: "Kore", gender: "Female", accent: "American", description: "Balanced, calm" },
	{ id: "af_sarah", name: "Sarah", gender: "Female", accent: "American", description: "Clear, friendly" },
	{ id: "af_alloy", name: "Alloy", gender: "Female", accent: "American", description: "Neutral, steady" },
	{ id: "af_nova", name: "Nova", gender: "Female", accent: "American", description: "Brisk, energetic" },
	{ id: "af_sky", name: "Sky", gender: "Female", accent: "American", description: "Airy, soft" },
	{ id: "af_jessica", name: "Jessica", gender: "Female", accent: "American", description: "Casual" },
	{ id: "af_river", name: "River", gender: "Female", accent: "American", description: "Smooth" },

	// American Male
	{ id: "am_michael", name: "Michael (Recommended)", gender: "Male", accent: "American", description: "Deep, articulate, narrator" },
	{ id: "am_fenrir", name: "Fenrir", gender: "Male", accent: "American", description: "Authoritative, resonant" },
	{ id: "am_puck", name: "Puck", gender: "Male", accent: "American", description: "Engaging, conversational" },
	{ id: "am_echo", name: "Echo", gender: "Male", accent: "American", description: "Clear, neutral" },
	{ id: "am_eric", name: "Eric", gender: "Male", accent: "American", description: "Casual, friendly" },
	{ id: "am_liam", name: "Liam", gender: "Male", accent: "American", description: "Warm, gentle" },
	{ id: "am_onyx", name: "Onyx", gender: "Male", accent: "American", description: "Rich, deep" },
	{ id: "am_adam", name: "Adam", gender: "Male", accent: "American", description: "Direct" },
	{ id: "am_santa", name: "Santa", gender: "Male", accent: "American", description: "Jovial, hearty" },

	// British Female
	{ id: "bf_emma", name: "Emma (Recommended)", gender: "Female", accent: "British", description: "Refined, articulate RP" },
	{ id: "bf_isabella", name: "Isabella", gender: "Female", accent: "British", description: "Elegant, crisp" },
	{ id: "bf_alice", name: "Alice", gender: "Female", accent: "British", description: "Polite, structured" },
	{ id: "bf_lily", name: "Lily", gender: "Female", accent: "British", description: "Gentle" },

	// British Male
	{ id: "bm_george", name: "George (Recommended)", gender: "Male", accent: "British", description: "Distinguished, classic narration" },
	{ id: "bm_fable", name: "Fable", gender: "Male", accent: "British", description: "Warm, storytelling" },
	{ id: "bm_lewis", name: "Lewis", gender: "Male", accent: "British", description: "Direct, clear" },
	{ id: "bm_daniel", name: "Daniel", gender: "Male", accent: "British", description: "Calm, steady" },
];

export class LetsHearItSettingTab extends PluginSettingTab {
	plugin: LetsHearItPlugin;

	constructor(app: App, plugin: LetsHearItPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const voiceOptions: Record<string, string> = {};
		for (const v of KOKORO_VOICES) {
			voiceOptions[v.id] = `${v.name} (${v.accent} ${v.gender})`;
		}

		return [
			{
				name: "Voice",
				desc: "Choose your preferred neural speech voice. Kokoro includes 28 natural voices.",
				control: {
					type: "dropdown",
					key: "voice",
					options: voiceOptions,
				},
			},
			{
				name: "Default playback speed",
				desc: "Default speed rate for speech synthesis.",
				control: {
					type: "dropdown",
					key: "playbackSpeed",
					options: {
						"0.75": "0.75x",
						"1": "1.0x (Normal)",
						"1.25": "1.25x",
						"1.5": "1.5x",
						"1.75": "1.75x",
						"2": "2.0x",
					},
				},
			},
			{
				name: "Auto-scroll during playback",
				desc: "Smoothly centers the current sentence in the viewport when it nears the top or bottom edges.",
				control: {
					type: "toggle",
					key: "autoScroll",
				},
			},
			{
				name: "Audio export folder",
				desc: "The vault folder path where generated MP3 files will be saved. Leave empty to save directly to the root of the vault.",
				control: {
					type: "text",
					key: "exportFolder",
					placeholder: "e.g. Audio/Recordings (leave blank for vault root)",
				},
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Local Speech Engine Setup Section
		new Setting(containerEl).setName("Local Speech Engine Setup").setHeading();

		const status = this.plugin.wasmAssetManager.checkStatus();
		const mbSize = (status.wasmSize / (1024 * 1024)).toFixed(1);
		const statusDesc = status.isReady
			? `🟢 Ready for offline neural synthesis (${mbSize} MB local engine installed).`
			: "🟠 Setup required. Offline ONNX WebAssembly engine files (~21 MB) are not yet downloaded in the plugin folder.";

		const engineSetting = new Setting(containerEl)
			.setName("Offline neural engine")
			.setDesc(statusDesc);

		engineSetting.addButton((btn) => {
			btn.setButtonText(status.isReady ? "Re-download / Verify Engine" : "Download Local Engine (~21 MB)")
				.setCta(!status.isReady)
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText("Downloading engine...");
					const originalDesc = engineSetting.descEl.textContent ?? "";
					
					const success = await this.plugin.wasmAssetManager.downloadAssets((pct, msg) => {
						engineSetting.setDesc(`⏳ ${msg} (${pct}%)`);
					});

					btn.setDisabled(false);
					if (success) {
						const updatedStatus = this.plugin.wasmAssetManager.checkStatus();
						const updatedMb = (updatedStatus.wasmSize / (1024 * 1024)).toFixed(1);
						engineSetting.setDesc(`🟢 Ready for offline neural synthesis (${updatedMb} MB local engine installed).`);
						btn.setButtonText("Re-download / Verify Engine");
						btn.setCta(false);
					} else {
						engineSetting.setDesc(originalDesc);
						btn.setButtonText("Retry Download");
					}
				});
		});

		new Setting(containerEl).setName("Speech & Voice").setHeading();

		// Voice Selector
		new Setting(containerEl)
			.setName("Voice")
			.setDesc("Choose your preferred neural speech voice. Kokoro includes 28 natural voices.")
			.addDropdown((dropdown) => {
				for (const v of KOKORO_VOICES) {
					dropdown.addOption(v.id, `${v.name} (${v.accent} ${v.gender})`);
				}
				dropdown.setValue(this.plugin.settings.voice);
				dropdown.onChange(async (val) => {
					this.plugin.settings.voice = val;
					await this.plugin.saveSettings();
					this.plugin.getTTSEngine()?.setVoice(val);
				});
			});

		// Default Playback Speed
		new Setting(containerEl)
			.setName("Default playback speed")
			.setDesc("Default speed rate for speech synthesis.")
			.addDropdown((dropdown) => {
				const speeds = ["0.75", "1.0", "1.25", "1.5", "1.75", "2.0"];
				for (const s of speeds) {
					dropdown.addOption(s, `${s}x`);
				}
				dropdown.setValue(this.plugin.settings.playbackSpeed.toString());
				dropdown.onChange(async (val) => {
					const speed = parseFloat(val);
					this.plugin.settings.playbackSpeed = speed;
					await this.plugin.saveSettings();
					this.plugin.getTTSEngine()?.setPlaybackRate(speed);
				});
			});

		// Hearing Mode Setting
		new Setting(containerEl)
			.setName("Auto-switch to hearing mode (reading view)")
			.setDesc("Automatically switches the active note to Reading View during playback for distraction-free listening and rock-solid highlight tracking.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.hearingModeOnPlay);
				toggle.onChange(async (val) => {
					this.plugin.settings.hearingModeOnPlay = val;
					await this.plugin.saveSettings();
				});
			});

		// Auto-Scroll Setting
		new Setting(containerEl)
			.setName("Auto-scroll during playback")
			.setDesc("Smoothly centers the current sentence in the viewport when it nears the top or bottom edges.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoScroll);
				toggle.onChange(async (val) => {
					this.plugin.settings.autoScroll = val;
					await this.plugin.saveSettings();
					this.plugin.getHighlighter()?.setAutoScroll(val);
				});
			});

		// Audio Export Folder Setting
		new Setting(containerEl)
			.setName("Audio export folder")
			.setDesc("The vault folder path where generated MP3 files will be saved. Leave empty to save directly to the root of the vault.")
			.addText((text) => {
				text.setPlaceholder("e.g. Audio/Recordings (leave blank for vault root)")
					.setValue(this.plugin.settings.exportFolder)
					.onChange(async (val) => {
						this.plugin.settings.exportFolder = val.trim();
						await this.plugin.saveSettings();
					});
			});
	}
}

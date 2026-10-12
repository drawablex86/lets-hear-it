import { TTSEngine } from "../engine/ttsEngine";

export class WaveformVisualizer {
	private containerEl: HTMLElement | null = null;
	private bars: HTMLElement[] = [];
	private animFrameId: number | null = null;
	private ttsEngine: TTSEngine;
	private dataArray: Uint8Array | null = null;
	private isRunning = false;
	private barCount = 5;

	constructor(parentEl: HTMLElement, ttsEngine: TTSEngine, barCount = 5) {
		this.ttsEngine = ttsEngine;
		this.barCount = barCount;
		this.createDOM(parentEl);
	}

	private createDOM(parentEl: HTMLElement): void {
		const container = parentEl.createDiv({ cls: "lets-hear-it-waveform" });
		this.containerEl = container;

		for (let i = 0; i < this.barCount; i++) {
			const bar = container.createDiv({ cls: "lets-hear-it-wave-bar" });
			this.bars.push(bar);
		}
	}

	public start(): void {
		if (this.isRunning) return;
		this.isRunning = true;
		this.animate();
	}

	public stop(): void {
		this.isRunning = false;
		if (this.animFrameId !== null) {
			window.cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
		this.resetBars();
	}

	public destroy(): void {
		this.stop();
		if (this.containerEl) {
			this.containerEl.remove();
			this.containerEl = null;
		}
		this.bars = [];
	}

	private resetBars(): void {
		for (const bar of this.bars) {
			bar.setCssProps({
				"--wave-height": "3px",
				"--wave-opacity": "0.5",
			});
		}
	}

	private animate = (): void => {
		if (!this.isRunning) return;

		const state = this.ttsEngine.getState();
		const analyser = this.ttsEngine.getAnalyserNode();

		if (state === "playing" && analyser) {
			if (!this.dataArray || this.dataArray.length !== analyser.frequencyBinCount) {
				this.dataArray = new Uint8Array(analyser.frequencyBinCount);
			}

			analyser.getByteFrequencyData(this.dataArray as unknown as Uint8Array<ArrayBuffer>);

			// Calculate average energy across sub-bands
			const binStep = Math.max(1, Math.floor(this.dataArray.length / this.barCount));
			for (let i = 0; i < this.barCount; i++) {
				let sum = 0;
				let count = 0;
				for (let j = i * binStep; j < (i + 1) * binStep && j < this.dataArray.length; j++) {
					sum += this.dataArray[j];
					count++;
				}
				const avg = count > 0 ? sum / count : 0;
				// Map 0-255 to 3px - 18px
				const minHeight = 3;
				const maxHeight = 18;
				const height = Math.min(maxHeight, Math.max(minHeight, minHeight + (avg / 255) * (maxHeight - minHeight)));
				const opacity = 0.5 + (avg / 255) * 0.5;

				const bar = this.bars[i];
				if (bar) {
					bar.setCssProps({
						"--wave-height": `${height.toFixed(1)}px`,
						"--wave-opacity": opacity.toFixed(2),
					});
				}
			}
		} else if (state === "buffering" || state === "loading-model") {
			// Subtle rhythmic pulse while buffering or loading
			const time = Date.now() / 200;
			for (let i = 0; i < this.barCount; i++) {
				const wave = (Math.sin(time + i * 0.8) + 1) / 2;
				const height = 4 + wave * 8;
				const bar = this.bars[i];
				if (bar) {
					bar.setCssProps({
						"--wave-height": `${height.toFixed(1)}px`,
						"--wave-opacity": (0.4 + wave * 0.4).toFixed(2),
					});
				}
			}
		} else {
			this.resetBars();
		}

		this.animFrameId = window.requestAnimationFrame(this.animate);
	};
}

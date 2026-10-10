import { MarkdownView } from "obsidian";
import { SentenceChunk, WordOffset } from "../engine/cleaner";

export const HIGHLIGHT_NAME = "lets-hear-it-active-word";

interface WordTimeRange {
	word: string;
	startTime: number;
	endTime: number;
}

export class WordHighlighter {
	private activeView: MarkdownView | null = null;
	private sentenceWordTimes: WordTimeRange[][] = [];
	private currentSentenceChunks: SentenceChunk[] = [];
	private currentHighlightRange: Range | null = null;

	constructor() {}

	/**
	 * Precomputes proportional word duration offsets for all sentences based on synthesized audio duration.
	 * Word Duration = Audio Duration * (Word Length / Total Sentence Length)
	 */
	public setSentenceAudioDurations(sentences: SentenceChunk[], durations: number[]): void {
		this.currentSentenceChunks = sentences;
		this.sentenceWordTimes = sentences.map((sentence, idx) => {
			const audioDuration = durations[idx] || 1.0;
			return this.computeWordTimings(sentence.words, audioDuration);
		});
	}

	/**
	 * Registers a single sentence's duration when synthesized
	 */
	public updateSentenceDuration(sentenceIndex: number, sentence: SentenceChunk, duration: number): void {
		if (this.currentSentenceChunks.length <= sentenceIndex) {
			this.currentSentenceChunks[sentenceIndex] = sentence;
		}
		this.sentenceWordTimes[sentenceIndex] = this.computeWordTimings(sentence.words, duration);
	}

	private computeWordTimings(words: WordOffset[], totalDuration: number): WordTimeRange[] {
		if (words.length === 0) return [];

		const totalChars = words.reduce((acc, w) => acc + w.word.length, 0);
		if (totalChars === 0) return [];

		let accumulatedTime = 0;
		return words.map((w, index) => {
			const fraction = w.word.length / totalChars;
			const wordDuration = totalDuration * fraction;
			const startTime = accumulatedTime;
			const endTime = index === words.length - 1 ? totalDuration : accumulatedTime + wordDuration;
			accumulatedTime = endTime;

			return {
				word: w.word,
				startTime,
				endTime,
			};
		});
	}

	public setActiveView(view: MarkdownView | null): void {
		this.activeView = view;
	}

	/**
	 * Updates the active word highlight based on current sentence elapsed time
	 */
	public updateHighlight(sentenceIndex: number, currentElapsedSeconds: number): void {
		const wordTimings = this.sentenceWordTimes[sentenceIndex];
		const sentenceChunk = this.currentSentenceChunks[sentenceIndex];
		if (!wordTimings || !sentenceChunk || wordTimings.length === 0) {
			this.clearHighlight();
			return;
		}

		// Find which word corresponds to currentElapsedSeconds
		let activeWordIndex = 0;
		for (let i = 0; i < wordTimings.length; i++) {
			if (currentElapsedSeconds >= wordTimings[i].startTime && currentElapsedSeconds < wordTimings[i].endTime) {
				activeWordIndex = i;
				break;
			}
			if (currentElapsedSeconds >= wordTimings[i].endTime) {
				activeWordIndex = i;
			}
		}

		const targetWord = sentenceChunk.words[activeWordIndex];
		if (!targetWord) {
			this.clearHighlight();
			return;
		}

		this.applyHighlightForWord(targetWord.word, sentenceChunk.text);
	}

	/**
	 * Locates target word in active Markdown reading view and sets CSS Custom Highlight
	 */
	private applyHighlightForWord(targetWord: string, sentenceContext: string): void {
		if (!this.activeView || !this.isCssHighlightSupported()) {
			return;
		}

		// Look inside the reading mode container
		const container = this.activeView.containerEl.querySelector(".markdown-reading-view") as HTMLElement | null;
		if (!container) {
			this.clearHighlight();
			return;
		}

		const range = this.findTextNodeRange(container, targetWord, sentenceContext);
		if (range) {
			this.currentHighlightRange = range;
			try {
				const HighlightConstructor = (window as unknown as { Highlight: typeof Range }).Highlight as unknown as new (range: Range) => unknown;
				const highlight = new HighlightConstructor(range);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.set(HIGHLIGHT_NAME, highlight);
			} catch (err) {
				console.warn("[let's hear it] Failed to set CSS Highlight:", err);
			}
		} else {
			this.clearHighlight();
		}
	}

	/**
	 * Searches DOM text nodes for the matching word within local context
	 */
	private findTextNodeRange(root: HTMLElement, word: string, contextSentence: string): Range | null {
		const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let currentNode = treeWalker.nextNode();

		// Clean target word for punctuation matching
		const cleanWord = word.replace(/^[^\w]+|[^\w]+$/g, "");
		if (!cleanWord) return null;

		let bestRange: Range | null = null;

		while (currentNode) {
			const nodeText = currentNode.textContent || "";
			const index = nodeText.indexOf(cleanWord);

			if (index !== -1) {
				const range = document.createRange();
				range.setStart(currentNode, index);
				range.setEnd(currentNode, index + cleanWord.length);
				bestRange = range;
				break;
			}
			currentNode = treeWalker.nextNode();
		}

		return bestRange;
	}

	public clearHighlight(): void {
		this.currentHighlightRange = null;
		if (this.isCssHighlightSupported()) {
			try {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(HIGHLIGHT_NAME);
			} catch (_) {}
		}
	}

	private isCssHighlightSupported(): boolean {
		return typeof CSS !== "undefined" && "highlights" in CSS && typeof (window as unknown as { Highlight?: unknown }).Highlight !== "undefined";
	}
}

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
	private lastHighlightedSentence = -1;
	private lastHighlightedWord = -1;

	// Fallback DOM highlight elements if CSS Custom Highlight API is unavailable or non-rendering
	private fallbackSpanEl: HTMLElement | null = null;

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
		if (this.activeView !== view) {
			this.clearHighlight();
			this.activeView = view;
		}
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

		if (this.lastHighlightedSentence === sentenceIndex && this.lastHighlightedWord === activeWordIndex) {
			return; // Avoid unnecessary re-computations for the exact same word
		}

		const targetWord = sentenceChunk.words[activeWordIndex];
		if (!targetWord) {
			this.clearHighlight();
			return;
		}

		this.lastHighlightedSentence = sentenceIndex;
		this.lastHighlightedWord = activeWordIndex;

		this.applyHighlight(sentenceIndex, activeWordIndex, targetWord.word, sentenceChunk.text);
	}

	/**
	 * Finds the active target container (Reading view or Live Preview/Editing view)
	 * and highlights the matching word in context.
	 */
	private applyHighlight(sentenceIndex: number, wordIndex: number, targetWord: string, sentenceContext: string): void {
		if (!this.activeView) {
			return;
		}

		// 1. Locate root view container (support Reading mode, Live Preview, and Source view)
		const containerEl = this.activeView.containerEl;
		if (!containerEl) {
			this.clearHighlight();
			return;
		}

		// Check for Live Preview / Editor view first, or Reading view
		const readingView = containerEl.querySelector(".markdown-reading-view") as HTMLElement | null;
		const editorView = containerEl.querySelector(".cm-content") as HTMLElement | null;

		// Prioritize visible container
		let searchRoot: HTMLElement | null = null;
		if (editorView && editorView.offsetParent !== null) {
			searchRoot = editorView;
		} else if (readingView && readingView.offsetParent !== null) {
			searchRoot = readingView;
		} else {
			searchRoot = editorView || readingView || containerEl;
		}

		if (!searchRoot) {
			this.clearHighlight();
			return;
		}

		const range = this.findContextualRange(searchRoot, targetWord, sentenceContext, wordIndex);
		if (range) {
			this.currentHighlightRange = range;
			this.applyRangeHighlight(range);

			// Scroll element into view smoothly if needed
			try {
				const nodeParent = range.commonAncestorContainer.parentElement;
				if (nodeParent && typeof nodeParent.scrollIntoView === "function") {
					nodeParent.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
				}
			} catch (_) {}
		} else {
			this.clearHighlight();
		}
	}

	/**
	 * Contextual range search that locates the sentence first, then the word occurrence in context
	 */
	private findContextualRange(root: HTMLElement, word: string, sentenceContext: string, wordIndex: number): Range | null {
		// Clean target word for punctuation matching
		const cleanWord = word.replace(/^[^\w]+|[^\w]+$/g, "");
		if (!cleanWord) return null;

		// 1. Collect text nodes
		const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let currentNode = treeWalker.nextNode();
		while (currentNode) {
			if (currentNode.nodeType === Node.TEXT_NODE && currentNode.textContent?.trim()) {
				textNodes.push(currentNode as Text);
			}
			currentNode = treeWalker.nextNode();
		}

		if (textNodes.length === 0) return null;

		// 2. Extract leading clean tokens of sentenceContext for contextual matching
		const cleanSentenceWords = sentenceContext
			.split(/\s+/)
			.map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ""))
			.filter(Boolean);

		const anchorWord = cleanSentenceWords[0] || cleanWord;

		// Find candidate nodes that match anchor or target word
		let candidateNodeIndex = -1;
		if (anchorWord) {
			for (let i = 0; i < textNodes.length; i++) {
				if (textNodes[i].textContent?.includes(anchorWord)) {
					candidateNodeIndex = i;
					break;
				}
			}
		}

		// Search from the sentence candidate node forward, or fall back to scanning all nodes
		const searchStartIndex = candidateNodeIndex >= 0 ? candidateNodeIndex : 0;
		for (let i = searchStartIndex; i < textNodes.length; i++) {
			const node = textNodes[i];
			const text = node.textContent || "";
			const wordRegex = new RegExp(`\\b${this.escapeRegExp(cleanWord)}\\b`, "i");
			const match = wordRegex.exec(text);

			if (match) {
				const range = document.createRange();
				range.setStart(node, match.index);
				range.setEnd(node, match.index + match[0].length);
				return range;
			}
		}

		// Secondary fallback: substring search if word boundary regex didn't match (e.g. non-latin or hyphenated)
		for (let i = searchStartIndex; i < textNodes.length; i++) {
			const node = textNodes[i];
			const text = node.textContent || "";
			const idx = text.indexOf(cleanWord);
			if (idx !== -1) {
				const range = document.createRange();
				range.setStart(node, idx);
				range.setEnd(node, idx + cleanWord.length);
				return range;
			}
		}

		return null;
	}

	private escapeRegExp(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/**
	 * Applies CSS Custom Highlight or fallback DOM decoration
	 */
	private applyRangeHighlight(range: Range): void {
		if (this.isCssHighlightSupported()) {
			try {
				const HighlightConstructor = (window as unknown as { Highlight: typeof Range }).Highlight as unknown as new (range: Range) => unknown;
				const highlight = new HighlightConstructor(range);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.set(HIGHLIGHT_NAME, highlight);
				return;
			} catch (err) {
				console.warn("[let's hear it] CSS Custom Highlight failed, using DOM fallback:", err);
			}
		}

		// Fallback: DOM Span Highlight
		this.removeFallbackSpan();
		try {
			const span = document.createElement("span");
			span.className = "lets-hear-it-active-word";
			range.surroundContents(span);
			this.fallbackSpanEl = span;
		} catch (_) {
			// surroundContents may fail if range crosses node boundaries; safely ignore
		}
	}

	private removeFallbackSpan(): void {
		if (this.fallbackSpanEl && this.fallbackSpanEl.parentNode) {
			const parent = this.fallbackSpanEl.parentNode;
			while (this.fallbackSpanEl.firstChild) {
				parent.insertBefore(this.fallbackSpanEl.firstChild, this.fallbackSpanEl);
			}
			parent.removeChild(this.fallbackSpanEl);
			parent.normalize();
			this.fallbackSpanEl = null;
		}
	}

	public clearHighlight(): void {
		this.currentHighlightRange = null;
		this.lastHighlightedSentence = -1;
		this.lastHighlightedWord = -1;

		if (this.isCssHighlightSupported()) {
			try {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(HIGHLIGHT_NAME);
			} catch (_) {}
		}

		this.removeFallbackSpan();
	}

	private isCssHighlightSupported(): boolean {
		return typeof CSS !== "undefined" && "highlights" in CSS && typeof (window as unknown as { Highlight?: unknown }).Highlight !== "undefined";
	}
}

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

	// Block-anchored tracking
	private activeBlockEl: HTMLElement | null = null;
	private activeBlockTextNodes: Text[] = [];
	private activeBlockSentenceIndex = -1;

	// Viewport auto-scroll settings & throttle
	private autoScrollEnabled = true;
	private lastScrollTimestamp = 0;

	// Fallback DOM highlight elements if CSS Custom Highlight API is unavailable
	private fallbackSpanEl: HTMLElement | null = null;

	constructor() {}

	public setAutoScroll(enabled: boolean): void {
		this.autoScrollEnabled = enabled;
	}

	public getAutoScroll(): boolean {
		return this.autoScrollEnabled;
	}

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
			this.activeBlockEl = null;
			this.activeBlockTextNodes = [];
			this.activeBlockSentenceIndex = -1;
		}
	}

	/**
	 * Pins the specific DOM block container (<p>, <li>, <h*>, blockquote, or .cm-line)
	 * for the active sentence and checks viewport visibility.
	 */
	public setActiveSentence(sentenceIndex: number, sentenceChunk: SentenceChunk): void {
		this.activeBlockSentenceIndex = sentenceIndex;
		this.activeBlockEl = null;
		this.activeBlockTextNodes = [];

		if (!this.activeView) return;

		const containerEl = this.activeView.containerEl;
		if (!containerEl) return;

		const readingView = containerEl.querySelector<HTMLElement>(".markdown-reading-view");
		const editorView = containerEl.querySelector<HTMLElement>(".cm-content");

		let searchRoot: HTMLElement | null = null;
		if (readingView && readingView.offsetParent !== null) {
			searchRoot = readingView;
		} else if (editorView && editorView.offsetParent !== null) {
			searchRoot = editorView;
		} else {
			searchRoot = readingView || editorView || containerEl;
		}

		if (!searchRoot) return;

		// 1. Locate candidate block elements (<p>, <li>, <h1>-<h6>, blockquote, or .cm-line)
		const blockSelectors = "p, li, h1, h2, h3, h4, h5, h6, blockquote, .cm-line";
		const candidateBlocks = Array.from(searchRoot.querySelectorAll<HTMLElement>(blockSelectors));

		// Find block containing key snippet of the sentence
		const cleanSnippet = sentenceChunk.words
			.slice(0, 4)
			.map((w) => w.word.replace(/^[^\w]+|[^\w]+$/g, ""))
			.filter((w) => w.length >= 2)
			.join(" ");

		let matchedBlock: HTMLElement | null = null;

		if (cleanSnippet.length > 0) {
			for (const block of candidateBlocks) {
				const blockText = (block.textContent || "").toLowerCase();
				if (blockText.includes(cleanSnippet.toLowerCase())) {
					matchedBlock = block;
					break;
				}
			}
		}

		// Fallback: match by first word if snippet was not found
		if (!matchedBlock && sentenceChunk.words.length > 0) {
			const firstWord = sentenceChunk.words[0].word.replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase();
			if (firstWord.length >= 2) {
				for (const block of candidateBlocks) {
					const blockText = (block.textContent || "").toLowerCase();
					if (blockText.includes(firstWord)) {
						matchedBlock = block;
						break;
					}
				}
			}
		}

		this.activeBlockEl = matchedBlock || searchRoot;

		// 2. Cache text nodes strictly inside this active block
		const walker = document.createTreeWalker(this.activeBlockEl, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim().length > 0) {
				this.activeBlockTextNodes.push(node as Text);
			}
			node = walker.nextNode();
		}

		// 3. Smoothly center the block in viewport if autoScroll is enabled
		if (this.autoScrollEnabled && this.activeBlockEl) {
			this.ensureVisibleInViewport(this.activeBlockEl, true);
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

		// Ensure active block is pinned
		if (this.activeBlockSentenceIndex !== sentenceIndex || !this.activeBlockEl) {
			this.setActiveSentence(sentenceIndex, sentenceChunk);
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

		this.applyHighlight(activeWordIndex, targetWord.word, sentenceChunk);
	}

	/**
	 * Highlights targetWord strictly within the pinned active block container.
	 */
	private applyHighlight(wordIndex: number, targetWord: string, sentenceChunk: SentenceChunk): void {
		if (!this.activeView || !this.activeBlockEl) {
			return;
		}

		const cleanWord = targetWord.replace(/^[^\w]+|[^\w]+$/g, "");
		if (!cleanWord) return;

		// Calculate occurrence index of cleanWord in sentence up to wordIndex
		let targetOccurrence = 0;
		for (let i = 0; i < wordIndex; i++) {
			const prev = sentenceChunk.words[i]?.word.replace(/^[^\w]+|[^\w]+$/g, "");
			if (prev && prev.toLowerCase() === cleanWord.toLowerCase()) {
				targetOccurrence++;
			}
		}

		// Search strictly inside cached text nodes of active block
		let currentOccurrence = 0;
		let targetRange: Range | null = null;

		for (const textNode of this.activeBlockTextNodes) {
			const text = textNode.textContent || "";
			const wordRegex = new RegExp(`\\b${this.escapeRegExp(cleanWord)}\\b`, "gi");
			let match: RegExpExecArray | null;

			while ((match = wordRegex.exec(text)) !== null) {
				if (currentOccurrence === targetOccurrence) {
					const range = document.createRange();
					range.setStart(textNode, match.index);
					range.setEnd(textNode, match.index + match[0].length);
					targetRange = range;
					break;
				}
				currentOccurrence++;
			}
			if (targetRange) break;
		}

		// Fallback: substring matching if punctuation/formatting broke boundary
		if (!targetRange) {
			currentOccurrence = 0;
			for (const textNode of this.activeBlockTextNodes) {
				const text = textNode.textContent || "";
				let searchPos = 0;

				while (searchPos < text.length) {
					const idx = text.toLowerCase().indexOf(cleanWord.toLowerCase(), searchPos);
					if (idx === -1) break;

					if (currentOccurrence === targetOccurrence) {
						const range = document.createRange();
						range.setStart(textNode, idx);
						range.setEnd(textNode, idx + cleanWord.length);
						targetRange = range;
						break;
					}
					currentOccurrence++;
					searchPos = idx + cleanWord.length;
				}
				if (targetRange) break;
			}
		}

		if (targetRange) {
			this.currentHighlightRange = targetRange;
			this.applyRangeHighlight(targetRange);

			// Viewport threshold check: only scroll if the word nears top/bottom margins
			if (this.autoScrollEnabled) {
				const nodeParent = targetRange.commonAncestorContainer.parentElement;
				if (nodeParent) {
					this.ensureVisibleInViewport(nodeParent, false);
				}
			}
		}
	}

	/**
	 * Checks if an element is comfortably inside the visible viewport.
	 * Only scrolls if element is near the edges or outside, rate-limited to avoid jitter.
	 */
	private ensureVisibleInViewport(element: HTMLElement, forceScroll = false): void {
		const now = Date.now();
		// Throttle viewport scrolling to avoid micro-jitter during speech
		if (!forceScroll && now - this.lastScrollTimestamp < 1200) {
			return;
		}

		try {
			const rect = element.getBoundingClientRect();
			const windowHeight = window.innerHeight || document.documentElement.clientHeight;

			// Define comfortable top and bottom padding zones (120px)
			const topMargin = 120;
			const bottomMargin = windowHeight - 120;

			const isComfortablyVisible = rect.top >= topMargin && rect.bottom <= bottomMargin;

			if (!isComfortablyVisible || forceScroll) {
				this.lastScrollTimestamp = now;
				element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
			}
		} catch {
			// Expected: Element may be detached from active viewport DOM
		}
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

		// Fallback: DOM Span Highlight using Obsidian helper
		this.removeFallbackSpan();
		try {
			const span = createSpan({ cls: "lets-hear-it-active-word" });
			range.surroundContents(span);
			this.fallbackSpanEl = span;
		} catch {
			// Expected: Range may cross node boundaries
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
		this.activeBlockEl = null;
		this.activeBlockTextNodes = [];
		this.activeBlockSentenceIndex = -1;

		if (this.isCssHighlightSupported()) {
			try {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(HIGHLIGHT_NAME);
			} catch {
				// Expected: Highlight registration was already cleared
			}
		}

		this.removeFallbackSpan();
	}

	private isCssHighlightSupported(): boolean {
		return typeof CSS !== "undefined" && "highlights" in CSS && typeof (window as unknown as { Highlight?: unknown }).Highlight !== "undefined";
	}
}

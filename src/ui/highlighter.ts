import { MarkdownView } from "obsidian";
import { SentenceChunk, WordOffset } from "../engine/cleaner";

export const WORD_HIGHLIGHT_NAME = "lets-hear-it-active-word";
export const SENTENCE_HIGHLIGHT_NAME = "lets-hear-it-active-sentence";

interface WordTimeRange {
	word: string;
	startTime: number;
	endTime: number;
}

interface TextNodeSegment {
	node: Text;
	startOffset: number; // Start char offset in block's flattened text
	endOffset: number;   // End char offset in block's flattened text
	text: string;
}

interface BlockTextMap {
	blockEl: HTMLElement;
	segments: TextNodeSegment[];
	flattenedText: string;
}

export class WordHighlighter {
	private activeView: MarkdownView | null = null;
	private sentenceWordTimes: WordTimeRange[][] = [];
	private currentSentenceChunks: SentenceChunk[] = [];
	private lastHighlightedSentence = -1;
	private lastHighlightedWord = -1;

	// Precomputed sentence & word DOM ranges for the currently active sentence
	private activeSentenceIndex = -1;
	private activeSentenceRange: Range | null = null;
	private activeWordRanges = new Map<number, Range>();
	private activeBlockEl: HTMLElement | null = null;

	// Viewport auto-scroll settings & throttle
	private autoScrollEnabled = true;
	private lastScrollTimestamp = 0;

	// Fallback DOM highlight elements if CSS Custom Highlight API is unavailable
	private fallbackWordSpan: HTMLElement | null = null;
	private fallbackSentenceSpan: HTMLElement | null = null;

	constructor() {}

	public setAutoScroll(enabled: boolean): void {
		this.autoScrollEnabled = enabled;
	}

	public getAutoScroll(): boolean {
		return this.autoScrollEnabled;
	}

	/**
	 * Precomputes proportional word duration offsets for all sentences based on synthesized audio duration.
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
			this.activeSentenceIndex = -1;
			this.activeSentenceRange = null;
			this.activeWordRanges.clear();
			this.activeBlockEl = null;
		}
	}

	/**
	 * Locates the exact DOM container for the active sentence and precomputes
	 * rock-solid, strictly forward Range objects for both the whole sentence
	 * and each individual word.
	 */
	public setActiveSentence(sentenceIndex: number, sentenceChunk: SentenceChunk): void {
		this.activeSentenceIndex = sentenceIndex;
		this.lastHighlightedSentence = sentenceIndex;
		this.lastHighlightedWord = -1;
		this.activeWordRanges.clear();
		this.activeSentenceRange = null;

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

		// 1. Locate candidate block elements (<p>, <li>, <h1>-<h6>, blockquote, .cm-line)
		const blockSelectors = "p, li, h1, h2, h3, h4, h5, h6, blockquote, .cm-line";
		const candidateBlocks = Array.from(searchRoot.querySelectorAll<HTMLElement>(blockSelectors));

		// Find block containing key snippet of this sentence
		const wordsList = sentenceChunk.words.map((w) => w.word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "").toLowerCase());
		const cleanSnippet = wordsList.slice(0, 4).filter((w) => w.length >= 2).join(" ");

		let matchedBlock: HTMLElement | null = null;
		if (cleanSnippet.length > 0) {
			for (const block of candidateBlocks) {
				const blockText = (block.textContent || "").toLowerCase();
				if (blockText.includes(cleanSnippet)) {
					matchedBlock = block;
					break;
				}
			}
		}

		// Fallback: match by first significant word
		if (!matchedBlock) {
			const firstSignificant = wordsList.find((w) => w.length >= 3);
			if (firstSignificant) {
				for (const block of candidateBlocks) {
					const blockText = (block.textContent || "").toLowerCase();
					if (blockText.includes(firstSignificant)) {
						matchedBlock = block;
						break;
					}
				}
			}
		}

		this.activeBlockEl = matchedBlock || searchRoot;

		// 2. Build flat text segment map of the matched block
		const blockMap = this.buildBlockTextMap(this.activeBlockEl);

		// 3. Pin exact sentence boundary inside this block
		this.pinSentenceAndWordRanges(blockMap, sentenceChunk);

		// 4. Apply sentence-level highlight
		if (this.activeSentenceRange) {
			this.applySentenceHighlight(this.activeSentenceRange);
		}

		// 5. Smoothly center the block in viewport if autoScroll is enabled
		if (this.autoScrollEnabled && this.activeBlockEl) {
			this.ensureVisibleInViewport(this.activeBlockEl, true);
		}
	}

	/**
	 * Flattens all text nodes in the block into a single contiguous string with character offsets.
	 */
	private buildBlockTextMap(blockEl: HTMLElement): BlockTextMap {
		const segments: TextNodeSegment[] = [];
		let flattenedText = "";

		const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();

		while (node) {
			if (node.nodeType === Node.TEXT_NODE && node.textContent) {
				const text = node.textContent;
				const startOffset = flattenedText.length;
				flattenedText += text;
				const endOffset = flattenedText.length;

				segments.push({
					node: node as Text,
					startOffset,
					endOffset,
					text,
				});
			}
			node = walker.nextNode();
		}

		return {
			blockEl,
			segments,
			flattenedText,
		};
	}

	/**
	 * Locates sentence boundary and precomputes monotonic DOM ranges for every word in the sentence.
	 */
	private pinSentenceAndWordRanges(blockMap: BlockTextMap, sentenceChunk: SentenceChunk): void {
		const fullBlockText = blockMap.flattenedText;
		if (!fullBlockText || sentenceChunk.words.length === 0) return;

		// Extract first and last significant words to locate sentence boundary in this block
		const firstWordClean = sentenceChunk.words[0].word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "").toLowerCase();
		const lastWordClean = sentenceChunk.words[sentenceChunk.words.length - 1].word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "").toLowerCase();

		let sentenceStartChar = -1;
		let searchPos = 0;

		// Search for first word matching sentence start
		while (searchPos < fullBlockText.length) {
			const idx = fullBlockText.toLowerCase().indexOf(firstWordClean, searchPos);
			if (idx === -1) break;

			// Verify if the second word also follows within reasonable range
			if (sentenceChunk.words.length > 1) {
				const secondWordClean = sentenceChunk.words[1].word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "").toLowerCase();
				const nextSnippet = fullBlockText.slice(idx, idx + 80).toLowerCase();
				if (nextSnippet.includes(secondWordClean)) {
					sentenceStartChar = idx;
					break;
				}
			} else {
				sentenceStartChar = idx;
				break;
			}
			searchPos = idx + firstWordClean.length;
		}

		if (sentenceStartChar === -1) {
			sentenceStartChar = 0;
		}

		// Traverse strictly forward across sentence words starting from sentenceStartChar
		let currentPos = sentenceStartChar;
		let sentenceEndChar = sentenceStartChar;

		for (let i = 0; i < sentenceChunk.words.length; i++) {
			const w = sentenceChunk.words[i];
			const clean = w.word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "");
			if (!clean) continue;

			// Search strictly forward from currentPos
			const wordIdx = fullBlockText.toLowerCase().indexOf(clean.toLowerCase(), currentPos);
			if (wordIdx !== -1) {
				const startChar = wordIdx;
				const endChar = wordIdx + clean.length;

				// Create DOM Range for this specific word
				const range = this.createRangeFromOffsets(blockMap.segments, startChar, endChar);
				if (range) {
					this.activeWordRanges.set(i, range);
				}

				currentPos = endChar;
				sentenceEndChar = endChar;
			}
		}

		// Set active sentence range spanning from sentenceStartChar to sentenceEndChar
		if (sentenceEndChar > sentenceStartChar) {
			this.activeSentenceRange = this.createRangeFromOffsets(blockMap.segments, sentenceStartChar, sentenceEndChar);
		}
	}

	/**
	 * Converts character start/end offsets in flattened block text into a DOM Range spanning Text nodes.
	 */
	private createRangeFromOffsets(segments: TextNodeSegment[], startChar: number, endChar: number): Range | null {
		let startNode: Text | null = null;
		let startOffsetInNode = 0;
		let endNode: Text | null = null;
		let endOffsetInNode = 0;

		for (const seg of segments) {
			if (!startNode && startChar >= seg.startOffset && startChar < seg.endOffset) {
				startNode = seg.node;
				startOffsetInNode = startChar - seg.startOffset;
			}
			if (endChar > seg.startOffset && endChar <= seg.endOffset) {
				endNode = seg.node;
				endOffsetInNode = endChar - seg.startOffset;
				break;
			}
		}

		// If endChar reached exactly the end of the block
		if (startNode && !endNode && segments.length > 0) {
			const last = segments[segments.length - 1];
			endNode = last.node;
			endOffsetInNode = last.text.length;
		}

		if (startNode && endNode) {
			try {
				const range = document.createRange();
				range.setStart(startNode, Math.min(startOffsetInNode, startNode.textContent?.length || 0));
				range.setEnd(endNode, Math.min(endOffsetInNode, endNode.textContent?.length || 0));
				return range;
			} catch {
				return null;
			}
		}

		return null;
	}

	/**
	 * Updates the active word highlight based on current sentence elapsed time.
	 * Performs an instant O(1) dictionary lookup of the precomputed monotonic Range.
	 */
	public updateHighlight(sentenceIndex: number, currentElapsedSeconds: number): void {
		const wordTimings = this.sentenceWordTimes[sentenceIndex];
		const sentenceChunk = this.currentSentenceChunks[sentenceIndex];
		if (!wordTimings || !sentenceChunk || wordTimings.length === 0) {
			this.clearWordHighlight();
			return;
		}

		// Ensure active sentence and its word ranges are mapped
		if (this.activeSentenceIndex !== sentenceIndex) {
			this.setActiveSentence(sentenceIndex, sentenceChunk);
		}

		// Find which word index corresponds to currentElapsedSeconds
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
			return; // Avoid redundant repaint on the identical word
		}

		this.lastHighlightedSentence = sentenceIndex;
		this.lastHighlightedWord = activeWordIndex;

		// Instant O(1) range lookup: guarantees zero backtracking, zero preposition skipping
		const targetRange = this.activeWordRanges.get(activeWordIndex);
		if (targetRange) {
			this.applyWordHighlight(targetRange);

			if (this.autoScrollEnabled) {
				const nodeParent = targetRange.commonAncestorContainer.parentElement;
				if (nodeParent) {
					this.ensureVisibleInViewport(nodeParent, false);
				}
			}
		}
	}

	/**
	 * Highlights the active sentence container
	 */
	private applySentenceHighlight(range: Range): void {
		if (this.isCssHighlightSupported()) {
			try {
				const HighlightConstructor = (window as unknown as { Highlight: typeof Range }).Highlight as unknown as new (range: Range) => unknown;
				const highlight = new HighlightConstructor(range);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.set(SENTENCE_HIGHLIGHT_NAME, highlight);
				return;
			} catch (err) {
				console.warn("[let's hear it] CSS sentence highlight failed:", err);
			}
		}

		// Fallback: DOM Span
		this.removeFallbackSentenceSpan();
		try {
			const span = createSpan({ cls: "lets-hear-it-active-sentence" });
			range.surroundContents(span);
			this.fallbackSentenceSpan = span;
		} catch {
			// Expected if range crosses complex node boundaries
		}
	}

	/**
	 * Highlights the active word
	 */
	private applyWordHighlight(range: Range): void {
		if (this.isCssHighlightSupported()) {
			try {
				const HighlightConstructor = (window as unknown as { Highlight: typeof Range }).Highlight as unknown as new (range: Range) => unknown;
				const highlight = new HighlightConstructor(range);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.set(WORD_HIGHLIGHT_NAME, highlight);
				return;
			} catch (err) {
				console.warn("[let's hear it] CSS word highlight failed, using DOM fallback:", err);
			}
		}

		// Fallback: DOM Span
		this.removeFallbackWordSpan();
		try {
			const span = createSpan({ cls: "lets-hear-it-active-word" });
			range.surroundContents(span);
			this.fallbackWordSpan = span;
		} catch {
			// Range may cross element boundaries
		}
	}

	private removeFallbackWordSpan(): void {
		if (this.fallbackWordSpan && this.fallbackWordSpan.parentNode) {
			const parent = this.fallbackWordSpan.parentNode;
			while (this.fallbackWordSpan.firstChild) {
				parent.insertBefore(this.fallbackWordSpan.firstChild, this.fallbackWordSpan);
			}
			parent.removeChild(this.fallbackWordSpan);
			parent.normalize();
			this.fallbackWordSpan = null;
		}
	}

	private removeFallbackSentenceSpan(): void {
		if (this.fallbackSentenceSpan && this.fallbackSentenceSpan.parentNode) {
			const parent = this.fallbackSentenceSpan.parentNode;
			while (this.fallbackSentenceSpan.firstChild) {
				parent.insertBefore(this.fallbackSentenceSpan.firstChild, this.fallbackSentenceSpan);
			}
			parent.removeChild(this.fallbackSentenceSpan);
			parent.normalize();
			this.fallbackSentenceSpan = null;
		}
	}

	public clearWordHighlight(): void {
		this.lastHighlightedWord = -1;
		if (this.isCssHighlightSupported()) {
			try {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(WORD_HIGHLIGHT_NAME);
			} catch {}
		}
		this.removeFallbackWordSpan();
	}

	public clearHighlight(): void {
		this.lastHighlightedSentence = -1;
		this.lastHighlightedWord = -1;
		this.activeSentenceIndex = -1;
		this.activeSentenceRange = null;
		this.activeWordRanges.clear();
		this.activeBlockEl = null;

		if (this.isCssHighlightSupported()) {
			try {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(WORD_HIGHLIGHT_NAME);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(SENTENCE_HIGHLIGHT_NAME);
			} catch {}
		}

		this.removeFallbackWordSpan();
		this.removeFallbackSentenceSpan();
	}

	private ensureVisibleInViewport(element: HTMLElement, forceScroll = false): void {
		const now = Date.now();
		if (!forceScroll && now - this.lastScrollTimestamp < 1200) {
			return;
		}

		try {
			const rect = element.getBoundingClientRect();
			const windowHeight = window.innerHeight || document.documentElement.clientHeight;

			const topMargin = 120;
			const bottomMargin = windowHeight - 120;
			const isComfortablyVisible = rect.top >= topMargin && rect.bottom <= bottomMargin;

			if (!isComfortablyVisible || forceScroll) {
				this.lastScrollTimestamp = now;
				element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
			}
		} catch {}
	}

	private isCssHighlightSupported(): boolean {
		return typeof CSS !== "undefined" && "highlights" in CSS && typeof (window as unknown as { Highlight?: unknown }).Highlight !== "undefined";
	}
}

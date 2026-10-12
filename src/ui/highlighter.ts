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
	private lastMatchedBlock: HTMLElement | null = null;
	private lastMatchedSentenceEndOffset = 0;

	// Viewport auto-scroll settings & throttle
	private autoScrollEnabled = true;
	private lastScrollTimestamp = 0;

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
			this.lastMatchedBlock = null;
			this.lastMatchedSentenceEndOffset = 0;
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

		// Extract clean words from sentence for robust matching
		const wordsList = sentenceChunk.words.map((w) => w.word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "").toLowerCase());
		const fullSentenceClean = wordsList.filter((w) => w.length > 0).join(" ");
		const anchorSnippet4 = wordsList.slice(0, 4).filter((w) => w.length > 0).join(" ");
		const anchorSnippet2 = wordsList.slice(0, 2).filter((w) => w.length > 0).join(" ");

		let matchedBlock: HTMLElement | null = null;

		// If this sentence follows a previously matched block, check if it's still in that same block first!
		if (this.lastMatchedBlock && candidateBlocks.includes(this.lastMatchedBlock)) {
			const currentBlockText = (this.lastMatchedBlock.textContent || "").toLowerCase();
			if (
				(anchorSnippet4.length > 0 && currentBlockText.includes(anchorSnippet4)) ||
				(fullSentenceClean.length > 0 && currentBlockText.includes(fullSentenceClean)) ||
				(anchorSnippet2.length > 0 && currentBlockText.includes(anchorSnippet2))
			) {
				matchedBlock = this.lastMatchedBlock;
			}
		}

		// Otherwise, search candidate blocks for 4-word anchor phrase
		if (!matchedBlock && anchorSnippet4.length > 0) {
			for (const block of candidateBlocks) {
				const blockText = (block.textContent || "").toLowerCase();
				if (blockText.includes(anchorSnippet4)) {
					matchedBlock = block;
					break;
				}
			}
		}

		// Fallback: search for full sentence or 2-word anchor
		if (!matchedBlock) {
			for (const block of candidateBlocks) {
				const blockText = (block.textContent || "").toLowerCase();
				if (
					(fullSentenceClean.length > 0 && blockText.includes(fullSentenceClean)) ||
					(anchorSnippet2.length > 0 && blockText.includes(anchorSnippet2))
				) {
					matchedBlock = block;
					break;
				}
			}
		}

		// Fallback: match by first significant word
		if (!matchedBlock) {
			const firstSignificant = wordsList.find((w) => w.length >= 4);
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

		// If block changed from previous sentence, reset sequential sentence offset within block
		if (this.lastMatchedBlock !== matchedBlock) {
			this.lastMatchedSentenceEndOffset = 0;
			this.lastMatchedBlock = matchedBlock;
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

		// Extract clean words from this sentence
		const wordsClean = sentenceChunk.words
			.map((w) => w.word.replace(/^[^\w\u00C0-\u024F]+|[^\w\u00C0-\u024F]+$/g, "").toLowerCase())
			.filter((w) => w.length > 0);

		if (wordsClean.length === 0) return;

		// Try to match the longest unique anchor phrase from the sentence start
		const anchor4 = wordsClean.slice(0, 4).join(" ");
		const anchor3 = wordsClean.slice(0, 3).join(" ");
		const anchor2 = wordsClean.slice(0, 2).join(" ");
		const firstWordClean = wordsClean[0];

		let sentenceStartChar = -1;

		// Strategy A: Search forward from last matched sentence end in this block
		// (Prevents duplicate phrases like 'how do you' in sentence 3 from matching sentence 2)
		const searchFromOffset = Math.max(0, this.lastMatchedSentenceEndOffset);
		const lowerBlock = fullBlockText.toLowerCase();

		if (anchor4.length > 0) {
			const idx = lowerBlock.indexOf(anchor4, searchFromOffset);
			if (idx !== -1) sentenceStartChar = idx;
		}
		if (sentenceStartChar === -1 && anchor3.length > 0) {
			const idx = lowerBlock.indexOf(anchor3, searchFromOffset);
			if (idx !== -1) sentenceStartChar = idx;
		}
		if (sentenceStartChar === -1 && anchor2.length > 0) {
			const idx = lowerBlock.indexOf(anchor2, searchFromOffset);
			if (idx !== -1) sentenceStartChar = idx;
		}
		if (sentenceStartChar === -1 && firstWordClean.length > 0) {
			const idx = lowerBlock.indexOf(firstWordClean, searchFromOffset);
			if (idx !== -1) sentenceStartChar = idx;
		}

		// Strategy B: If not found after searchFromOffset (e.g. out of order jump), search from 0
		if (sentenceStartChar === -1) {
			if (anchor4.length > 0) {
				const idx = lowerBlock.indexOf(anchor4);
				if (idx !== -1) sentenceStartChar = idx;
			}
			if (sentenceStartChar === -1 && anchor3.length > 0) {
				const idx = lowerBlock.indexOf(anchor3);
				if (idx !== -1) sentenceStartChar = idx;
			}
			if (sentenceStartChar === -1 && anchor2.length > 0) {
				const idx = lowerBlock.indexOf(anchor2);
				if (idx !== -1) sentenceStartChar = idx;
			}
			if (sentenceStartChar === -1) {
				sentenceStartChar = Math.max(0, lowerBlock.indexOf(firstWordClean));
			}
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
			this.lastMatchedSentenceEndOffset = sentenceEndChar;
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
			} catch (err) {
				console.warn("[let's hear it] CSS sentence highlight failed:", err);
			}
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
			} catch (err) {
				console.warn("[let's hear it] CSS word highlight failed:", err);
			}
		}
	}

	public clearWordHighlight(): void {
		this.lastHighlightedWord = -1;
		if (this.isCssHighlightSupported()) {
			try {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(WORD_HIGHLIGHT_NAME);
			} catch {
				// Safely ignore highlight deletion failure
			}
		}
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
			} catch {
				// Safely ignore highlight deletion failure
			}
		}
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
		} catch {
			// Ignore element measurement or scrolling errors
		}
	}

	private isCssHighlightSupported(): boolean {
		return typeof CSS !== "undefined" && "highlights" in CSS && typeof (window as unknown as { Highlight?: unknown }).Highlight !== "undefined";
	}
}

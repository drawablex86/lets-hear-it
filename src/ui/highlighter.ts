import { MarkdownView } from "obsidian";
import { SentenceChunk, WordOffset } from "../engine/cleaner";

export const HIGHLIGHT_NAME = "lets-hear-it-active-word";

interface WordTimeRange {
	word: string;
	startTime: number;
	endTime: number;
}

interface TextNodeSegment {
	node: Text;
	charStart: number;
	charEnd: number;
}

interface SentenceMapEntry {
	sentenceIndex: number;
	charStart: number;
	charEnd: number;
}

export class WordHighlighter {
	private activeView: MarkdownView | null = null;
	private sentenceWordTimes: WordTimeRange[][] = [];
	private currentSentenceChunks: SentenceChunk[] = [];
	private currentHighlightRange: Range | null = null;
	private lastHighlightedSentence = -1;
	private lastHighlightedWord = -1;

	// Global Document Position Map
	private fullDocText = "";
	private textNodeSegments: TextNodeSegment[] = [];
	private sentenceMap: SentenceMapEntry[] = [];
	private isMapBuilt = false;

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
	 */
	public setSentenceAudioDurations(sentences: SentenceChunk[], durations: number[]): void {
		this.currentSentenceChunks = sentences;
		this.sentenceWordTimes = sentences.map((sentence, idx) => {
			const audioDuration = durations[idx] || 1.0;
			return this.computeWordTimings(sentence.words, audioDuration);
		});
		// Rebuild document position map whenever sentences are set
		this.buildDocumentPositionMap();
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
			this.invalidateMap();
		}
	}

	public invalidateMap(): void {
		this.fullDocText = "";
		this.textNodeSegments = [];
		this.sentenceMap = [];
		this.isMapBuilt = false;
	}

	/**
	 * Scans the active document view ONCE to build a single global character-level map.
	 * All sentences are anchored monotonically forward from 0 to N.
	 */
	public buildDocumentPositionMap(): void {
		if (!this.activeView || this.currentSentenceChunks.length === 0) {
			return;
		}

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

		// 1. Flatten all text nodes in reading container into a unified document string
		const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		let accumulatedText = "";
		const segments: TextNodeSegment[] = [];

		while (node) {
			if (node.nodeType === Node.TEXT_NODE && node.textContent) {
				const text = node.textContent;
				const start = accumulatedText.length;
				accumulatedText += text;
				const end = accumulatedText.length;
				segments.push({
					node: node as Text,
					charStart: start,
					charEnd: end,
				});
			}
			node = walker.nextNode();
		}

		this.fullDocText = accumulatedText;
		this.textNodeSegments = segments;

		// 2. Map every sentence monotonically forward
		// Sentence K strictly begins searching at or after where Sentence K-1 matched.
		const sentenceEntries: SentenceMapEntry[] = [];
		let globalDocCursor = 0;
		const docLower = accumulatedText.toLowerCase();

		for (const sentence of this.currentSentenceChunks) {
			const cleanSentence = sentence.text.trim();
			if (!cleanSentence) {
				sentenceEntries.push({ sentenceIndex: sentence.sentenceIndex, charStart: globalDocCursor, charEnd: globalDocCursor });
				continue;
			}

			// Try matching full sentence starting strictly from globalDocCursor
			let matchedStart = docLower.indexOf(cleanSentence.toLowerCase(), globalDocCursor);

			// If exact full sentence punctuation differed, search by first 3 words
			if (matchedStart === -1 && sentence.words.length >= 2) {
				const anchorWords = sentence.words
					.slice(0, 3)
					.map((w) => w.word.replace(/^[^\w]+|[^\w]+$/g, ""))
					.filter((w) => w.length >= 2)
					.join(" ");

				if (anchorWords) {
					matchedStart = docLower.indexOf(anchorWords.toLowerCase(), globalDocCursor);
				}
			}

			// Fallback: search by single first word if still not found
			if (matchedStart === -1 && sentence.words.length > 0) {
				const firstWord = sentence.words[0].word.replace(/^[^\w]+|[^\w]+$/g, "");
				if (firstWord.length >= 2) {
					matchedStart = docLower.indexOf(firstWord.toLowerCase(), globalDocCursor);
				}
			}

			// If match was found forward, lock it in and advance cursor
			if (matchedStart !== -1) {
				const matchedEnd = matchedStart + cleanSentence.length;
				sentenceEntries.push({
					sentenceIndex: sentence.sentenceIndex,
					charStart: matchedStart,
					charEnd: matchedEnd,
				});
				globalDocCursor = matchedStart; // Advance search head forward
			} else {
				// Anchor at current cursor without regressing
				sentenceEntries.push({
					sentenceIndex: sentence.sentenceIndex,
					charStart: globalDocCursor,
					charEnd: globalDocCursor + cleanSentence.length,
				});
			}
		}

		this.sentenceMap = sentenceEntries;
		this.isMapBuilt = true;
	}

	/**
	 * Called when a new sentence starts playback to prime the viewport.
	 */
	public setActiveSentence(sentenceIndex: number, sentenceChunk: SentenceChunk): void {
		if (!this.isMapBuilt || this.sentenceMap.length <= sentenceIndex) {
			this.buildDocumentPositionMap();
		}

		const entry = this.sentenceMap[sentenceIndex];
		if (!entry) return;

		// Center the sentence in the viewport smoothly if needed
		if (this.autoScrollEnabled) {
			const sentenceRange = this.createRangeFromOffsets(entry.charStart, entry.charEnd);
			if (sentenceRange) {
				this.ensureRangeVisibleInViewport(sentenceRange, false);
			}
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

		if (!this.isMapBuilt || this.sentenceMap.length === 0) {
			this.buildDocumentPositionMap();
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

		this.applyHighlight(sentenceIndex, activeWordIndex, targetWord, sentenceChunk);
	}

	/**
	 * Highlights targetWord monotonically using the Global Document Position Map.
	 */
	private applyHighlight(sentenceIndex: number, wordIndex: number, targetWord: WordOffset, sentenceChunk: SentenceChunk): void {
		if (!this.activeView || this.textNodeSegments.length === 0) {
			return;
		}

		const sentenceEntry = this.sentenceMap[sentenceIndex];
		if (!sentenceEntry) {
			return;
		}

		const cleanWord = targetWord.word.replace(/^[^\w]+|[^\w]+$/g, "");
		if (!cleanWord) return;

		// Calculate exact global target character range
		const sentenceStart = sentenceEntry.charStart;
		const targetCharStart = sentenceStart + targetWord.charStart;
		const targetCharEnd = sentenceStart + targetWord.charEnd;

		// 1. Try direct global character range first
		let targetRange = this.createRangeFromOffsets(targetCharStart, targetCharEnd);

		// Verify the mapped range contains the target word
		if (targetRange) {
			const rangeText = targetRange.toString().trim().toLowerCase();
			if (!rangeText.includes(cleanWord.toLowerCase())) {
				targetRange = null; // Minor offset drift; fall through to forward scan within sentence bounds
			}
		}

		// 2. Fallback: Search forward within the sentence's global character bounds
		if (!targetRange) {
			const sentenceSlice = this.fullDocText.slice(sentenceStart, sentenceEntry.charEnd + 40);
			const localIdx = sentenceSlice.toLowerCase().indexOf(cleanWord.toLowerCase());
			if (localIdx !== -1) {
				const resolvedStart = sentenceStart + localIdx;
				const resolvedEnd = resolvedStart + cleanWord.length;
				targetRange = this.createRangeFromOffsets(resolvedStart, resolvedEnd);
			}
		}

		if (targetRange) {
			this.currentHighlightRange = targetRange;
			this.applyRangeHighlight(targetRange);

			// Viewport threshold check: check bounding box of the WORD
			if (this.autoScrollEnabled) {
				this.ensureRangeVisibleInViewport(targetRange, false);
			}
		}
	}

	/**
	 * Builds a DOM Range from absolute character offsets within fullDocText in O(N) or binary search.
	 */
	private createRangeFromOffsets(startChar: number, endChar: number): Range | null {
		let startNode: Text | null = null;
		let startOffset = 0;
		let endNode: Text | null = null;
		let endOffset = 0;

		for (const seg of this.textNodeSegments) {
			if (!startNode && startChar >= seg.charStart && startChar <= seg.charEnd) {
				startNode = seg.node;
				startOffset = Math.min(seg.node.length, startChar - seg.charStart);
			}
			if (!endNode && endChar >= seg.charStart && endChar <= seg.charEnd) {
				endNode = seg.node;
				endOffset = Math.min(seg.node.length, endChar - seg.charStart);
			}
			if (startNode && endNode) break;
		}

		if (!startNode || !endNode) {
			return null;
		}

		try {
			const range = document.createRange();
			range.setStart(startNode, startOffset);
			range.setEnd(endNode, endOffset);
			return range;
		} catch (_) {
			return null;
		}
	}

	/**
	 * Checks if the highlighted WORD range is comfortably inside the viewport.
	 * Only scrolls if the word moves into the top 15% or bottom 15% margin.
	 */
	private ensureRangeVisibleInViewport(range: Range, forceScroll = false): void {
		const now = Date.now();
		// Throttle viewport scrolling to avoid micro-jitter during continuous speech
		if (!forceScroll && now - this.lastScrollTimestamp < 1500) {
			return;
		}

		try {
			const rect = range.getBoundingClientRect();
			if (!rect || (rect.width === 0 && rect.height === 0)) return;

			const windowHeight = window.innerHeight || document.documentElement.clientHeight;
			// 15% margins on top and bottom for smooth reading comfort
			const topMargin = Math.max(80, windowHeight * 0.15);
			const bottomMargin = Math.min(windowHeight - 80, windowHeight * 0.85);

			const isComfortablyVisible = rect.top >= topMargin && rect.bottom <= bottomMargin;

			if (!isComfortablyVisible || forceScroll) {
				this.lastScrollTimestamp = now;
				const parentEl = range.commonAncestorContainer.parentElement;
				if (parentEl && typeof parentEl.scrollIntoView === "function") {
					parentEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
				}
			}
		} catch (_) {}
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
			// Safely ignore if range crosses node boundaries
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

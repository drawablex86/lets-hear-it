export interface WordOffset {
	word: string;
	charStart: number;
	charEnd: number;
}

export interface SentenceChunk {
	sentenceIndex: number;
	text: string;
	words: WordOffset[];
	startOffsetInCleanText: number;
	endOffsetInCleanText: number;
}

export interface CleanMarkdownResult {
	cleanText: string;
	sentences: SentenceChunk[];
}

/**
 * Sanitizes raw Markdown into clean spoken text and segments it into sentences
 * with word-level character offsets for audio synchronization and visual tracking.
 */
export function cleanMarkdownForSpeech(markdown: string): CleanMarkdownResult {
	if (!markdown || !markdown.trim()) {
		return { cleanText: "", sentences: [] };
	}

	let text = markdown;

	// 1. Strip YAML frontmatter (--- ... ---) at start of file
	text = text.replace(/^---[\s\S]*?---\n*/m, "");

	// 2. Strip code blocks (``` ... ``` or ~~~ ... ~~~)
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/~~~[\s\S]*?~~~/g, " ");

	// 3. Strip inline code (`...`)
	text = text.replace(/`([^`]+)`/g, "$1");

	// 4. Strip HTML comments (<!-- ... -->)
	text = text.replace(/<!--[\s\S]*?-->/g, " ");

	// 5. Strip block math ($$ ... $$) and inline math ($ ... $)
	text = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
	text = text.replace(/\$([^$\n]+)\$/g, "$1");

	// 6. Strip image embeds (![[...]] or ![alt](url))
	text = text.replace(/!\[\[[^\]]+\]\]/g, " ");
	text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");

	// 7. Resolve wikilinks: [[link|alias]] -> alias, [[link]] -> link
	text = text.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");
	text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

	// 8. Resolve standard Markdown links: [text](url) -> text
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

	// 9. Strip raw HTML tags (e.g., <div>, <span>, <br>)
	text = text.replace(/<[^>]+>/g, " ");

	// 10. Remove markdown headings (# Heading -> Heading)
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");

	// 11. Remove blockquotes (> quote -> quote)
	text = text.replace(/^\s{0,3}>\s?/gm, "");

	// 12. Remove task list markers and list bullets (- [ ] text, * text, 1. text)
	text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\d+\.\s+/gm, "");

	// 13. Remove horizontal rules (---, ***, ___)
	text = text.replace(/^\s*[-*_]{3,}\s*$/gm, " ");

	// 14. Strip markdown bold/italic/strikethrough/highlight/footnote formatting characters:
	// **bold**, *italic*, __bold__, _italic_, ~~strikethrough~~, ==highlight==
	text = text.replace(/==([^=]+)==/g, "$1");
	text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
	text = text.replace(/__([^_]+)__/g, "$1");
	text = text.replace(/\*([^*]+)\*/g, "$1");
	text = text.replace(/_([^_]+)_/g, "$1");
	text = text.replace(/~~([^~]+)~~/g, "$1");
	text = text.replace(/\[\^[^\]]+\]/g, ""); // footnote references [^1]

	// 15. Normalize whitespace: replace multiple blank lines/spaces with single spaces
	text = text.replace(/\r\n/g, "\n");
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n\s*\n/g, "\n");
	text = text.trim();

	const sentences = segmentIntoSentences(text);

	return {
		cleanText: text,
		sentences,
	};
}

/**
 * Splits text into individual sentences while preserving common abbreviations,
 * and extracts word-level character boundaries per sentence.
 */
export function segmentIntoSentences(text: string): SentenceChunk[] {
	if (!text || !text.trim()) {
		return [];
	}

	// Regex to split on sentence-ending punctuation (. ? !) followed by whitespace or line breaks,
	// while avoiding splits on common abbreviations (e.g. Mr., Mrs., Dr., vs., etc., i.e., e.g.).
	const commonAbbreviations = ["mr", "mrs", "ms", "dr", "prof", "vs", "etc", "fig", "inc", "ltd", "i.e", "e.g"];

	// Split using a token scanner to ensure exact character positions
	const sentenceTexts: { text: string; start: number; end: number }[] = [];
	let currentStart = 0;
	let i = 0;

	while (i < text.length) {
		const char = text[i];
		const nextChar = i + 1 < text.length ? text[i + 1] : "";

		// Check for sentence terminator
		if (char === "." || char === "?" || char === "!" || char === "\n") {
			// If this period is part of an abbreviation or decimal number
			let isAbbr = false;

			if (char === ".") {
				// Check decimal numbers: e.g. 3.14
				const prevChar = i > 0 ? text[i - 1] : "";
				if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
					isAbbr = true;
				}

				// Check abbreviation words preceding the period
				if (!isAbbr) {
					const wordBeforeMatch = text.slice(Math.max(0, i - 10), i).match(/([a-zA-Z.]+)$/);
					if (wordBeforeMatch) {
						const candidate = wordBeforeMatch[1].toLowerCase().replace(/^\./, "");
						if (commonAbbreviations.includes(candidate)) {
							isAbbr = true;
						}
					}
				}
			}

			if (!isAbbr) {
				// Scan past any immediate closing punctuation, quotes, brackets, or markdown formatting
				// e.g., '."', '?"', '!"', '?”', '.”', ')]', '**', etc.
				let peek = i + 1;
				while (peek < text.length && /['"’”\)\]\}\*_~]/.test(text[peek])) {
					peek++;
				}

				const isAtEnd = peek >= text.length;
				const isFollowedBySpaceOrNewline = isAtEnd || /\s/.test(text[peek]) || char === "\n";

				if (isFollowedBySpaceOrNewline) {
					const rawSentence = text.slice(currentStart, peek).trim();
					if (rawSentence.length > 0) {
						// Split overlong sentences (> 320 chars) at natural clause boundaries
						// to ensure Kokoro-82M never exceeds its ~500 phoneme context window.
						const subChunks = splitOverlongSentence(rawSentence, currentStart, text);
						sentenceTexts.push(...subChunks);
					}

					// Advance past trailing whitespace to start of next sentence
					while (peek < text.length && /\s/.test(text[peek])) {
						peek++;
					}
					currentStart = peek;
					i = peek;
					continue;
				}
			}
		}
		i++;
	}

	// Capture any leftover text
	if (currentStart < text.length) {
		const rawSentence = text.slice(currentStart).trim();
		if (rawSentence.length > 0) {
			const subChunks = splitOverlongSentence(rawSentence, currentStart, text);
			sentenceTexts.push(...subChunks);
		}
	}

	// Build SentenceChunk with word-level offsets
	return sentenceTexts.map((item, idx) => {
		const words = extractWordOffsets(item.text);
		return {
			sentenceIndex: idx,
			text: item.text,
			words,
			startOffsetInCleanText: item.start,
			endOffsetInCleanText: item.end,
		};
	});
}

/**
 * Splits sentences longer than maxChars (default 320) into natural clause chunks
 * on semicolons, colons, em-dashes, or commas, guaranteeing Kokoro-82M never stalls
 * or overflows its token context window.
 */
function splitOverlongSentence(
	rawSentence: string,
	currentStart: number,
	fullText: string,
	maxChars = 320
): { text: string; start: number; end: number }[] {
	const leadingSpaces = fullText.slice(currentStart).search(/\S/);
	const baseStart = currentStart + (leadingSpaces > 0 ? leadingSpaces : 0);

	if (rawSentence.length <= maxChars) {
		return [{
			text: rawSentence,
			start: baseStart,
			end: baseStart + rawSentence.length,
		}];
	}

	// Clause-splitting regex: look for ; : — – or comma followed by space
	const results: { text: string; start: number; end: number }[] = [];
	let searchPos = 0;

	while (searchPos < rawSentence.length) {
		const remaining = rawSentence.slice(searchPos);
		if (remaining.length <= maxChars) {
			const trimChunk = remaining.trim();
			if (trimChunk.length > 0) {
				const chunkStart = searchPos + remaining.search(/\S/);
				results.push({
					text: trimChunk,
					start: baseStart + chunkStart,
					end: baseStart + chunkStart + trimChunk.length,
				});
			}
			break;
		}

		// Look for natural clause boundary (; : — or comma) within maxChars
		const windowStr = remaining.slice(0, maxChars);
		let splitIndex = -1;

		// 1. Try semicolons, colons, or em-dashes
		const clauseBreakMatch = windowStr.match(/([;:—–])\s+/g);
		if (clauseBreakMatch) {
			const lastBreak = windowStr.lastIndexOf(clauseBreakMatch[clauseBreakMatch.length - 1]);
			if (lastBreak > 40) {
				splitIndex = lastBreak + 1; // Include the punctuation mark
			}
		}

		// 2. Fall back to commas followed by space
		if (splitIndex === -1) {
			const commaMatch = windowStr.match(/,\s+/g);
			if (commaMatch) {
				const lastComma = windowStr.lastIndexOf(commaMatch[commaMatch.length - 1]);
				if (lastComma > 40) {
					splitIndex = lastComma + 1;
				}
			}
		}

		// 3. Fall back to any word boundary space
		if (splitIndex === -1) {
			const lastSpace = windowStr.lastIndexOf(" ");
			if (lastSpace > 40) {
				splitIndex = lastSpace;
			} else {
				// Hard break if no whitespace found
				splitIndex = maxChars;
			}
		}

		const chunkText = remaining.slice(0, splitIndex).trim();
		if (chunkText.length > 0) {
			const chunkStart = searchPos + remaining.slice(0, splitIndex).search(/\S/);
			results.push({
				text: chunkText,
				start: baseStart + chunkStart,
				end: baseStart + chunkStart + chunkText.length,
			});
		}

		// Skip trailing whitespace after the split point
		let nextPos = searchPos + splitIndex;
		while (nextPos < rawSentence.length && /\s/.test(rawSentence[nextPos])) {
			nextPos++;
		}
		searchPos = nextPos;
	}

	return results.length > 0 ? results : [{
		text: rawSentence,
		start: baseStart,
		end: baseStart + rawSentence.length,
	}];
}

/**
 * Extracts each word in a sentence with its relative character start and end offsets.
 */
export function extractWordOffsets(sentence: string): WordOffset[] {
	const words: WordOffset[] = [];
	// Matches non-whitespace word tokens
	const regex = /\S+/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(sentence)) !== null) {
		words.push({
			word: match[0],
			charStart: match.index,
			charEnd: match.index + match[0].length,
		});
	}

	return words;
}

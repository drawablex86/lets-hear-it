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
			// Check if this period is part of an abbreviation or decimal number
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

			// If it's a real sentence terminator and followed by space/newline/EOF
			if (!isAbbr && (char === "\n" || /\s/.test(nextChar) || i === text.length - 1)) {
				// Consume any closing quotes or brackets attached to the punctuation (e.g. '."', ?")
				let end = i + 1;
				while (end < text.length && /['"’”)]/.test(text[end])) {
					end++;
				}

				const rawSentence = text.slice(currentStart, end).trim();
				if (rawSentence.length > 0) {
					// Find actual start after leading whitespace
					const leadingSpaces = text.slice(currentStart, end).search(/\S/);
					const actualStart = currentStart + (leadingSpaces > 0 ? leadingSpaces : 0);
					const actualEnd = actualStart + rawSentence.length;

					sentenceTexts.push({
						text: rawSentence,
						start: actualStart,
						end: actualEnd,
					});
				}

				// Move past the whitespace for next sentence
				while (end < text.length && /\s/.test(text[end])) {
					end++;
				}
				currentStart = end;
				i = end;
				continue;
			}
		}
		i++;
	}

	// Capture any leftover text
	if (currentStart < text.length) {
		const rawSentence = text.slice(currentStart).trim();
		if (rawSentence.length > 0) {
			const leadingSpaces = text.slice(currentStart).search(/\S/);
			const actualStart = currentStart + (leadingSpaces > 0 ? leadingSpaces : 0);
			sentenceTexts.push({
				text: rawSentence,
				start: actualStart,
				end: actualStart + rawSentence.length,
			});
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

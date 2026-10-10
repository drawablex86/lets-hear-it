# Task 4: Markdown Cleaner & Sentence Segmenter

## Objectives
Implement `src/engine/cleaner.ts` to sanitize Markdown note content into clean natural spoken text and segment it into sentence chunks with character offsets for synchronization with word tracking.

## Checklist
- [x] Implement `cleanMarkdownForSpeech(markdown: string)`:
  - Strip YAML frontmatter (`--- ... ---`).
  - Strip code blocks (````...```` and `...`).
  - Strip HTML comments (`<!-- ... -->`) and raw HTML tags.
  - Strip block math (`$$ ... $$`) and inline math (`$ ... $`).
  - Resolve wikilinks (`[[link|alias]]` -> `alias`, `[[link]]` -> `link`).
  - Resolve standard markdown links (`[text](url)` -> `text`).
  - Strip image embeds (`![alt](url)` and `![[image.png]]`).
  - Remove formatting characters (`#`, `**`, `*`, `_`, `~~`, `>`, `-`, `+`, `1.`, checkboxes `[ ]`/`[x]`).
  - Normalize whitespace and retain meaningful punctuation.
- [x] Sentence Chunking & Offset Tracking:
  - Define `SentenceChunk` interface with `text`, `sentenceIndex`, `words` array (`{ word: string, charStart: number, charEnd: number }`).
  - Handle abbreviations (e.g., `Mr.`, `Dr.`, `e.g.`, `i.e.`, `vs.`) without prematurely breaking sentences.
  - Return ordered list of sentences suitable for `TTSEngine`.
- [x] Add unit test / verification helper script to validate edge cases in note content.

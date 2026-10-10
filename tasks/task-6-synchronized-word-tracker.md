# Task 6: Synchronized Word Tracker

## Objectives
Implement zero-DOM-mutation word-level visual tracking in Obsidian Reading Mode using the modern CSS Custom Highlight API (`::highlight(lets-hear-it-active-word)`) in `src/ui/highlighter.ts` and `styles.css`.

## Checklist
- [x] Implement `WordHighlighter` in `src/ui/highlighter.ts`:
  - Calculate proportional word timestamps for each sentence:
    $$\text{Word Duration} = \text{Audio Duration} \times \left(\frac{\text{Word Length}}{\text{Total Sentence Length}}\right)$$
  - Build cumulative start and end time markers per word.
- [x] DOM Range Mapping & Highlight Registration:
  - On frame update (`requestAnimationFrame` synchronized with `AudioContext.currentTime`):
    - Identify current sentence and active word index.
    - Locate matching text nodes inside active `.markdown-reading-view`.
    - Create a DOM `Range` covering the active word boundary.
    - Register range using `CSS.highlights.set('lets-hear-it-active-word', new Highlight(range))`.
- [x] Dynamic Rate Synchronization:
  - Account for dynamic `playbackRate` changes so highlight position remains strictly in sync with audible speech.
- [x] Clear / Fallback:
  - Clear highlights on stop, pause, or note change (`CSS.highlights.delete('lets-hear-it-active-word')`).
  - Provide fallback behavior when CSS Highlight API is unsupported or view is not in Reading Mode.
- [x] Styling in `styles.css`:
  ```css
  ::highlight(lets-hear-it-active-word) {
    background-color: var(--text-highlight-bg, #ffd54f);
    color: var(--text-normal);
    border-radius: 2px;
  }
  ```

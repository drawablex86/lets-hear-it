# Reference: CSS Custom Highlight API for Zero-DOM Highlighting

Synchronizing audio/speech playback with visual text highlighting in Obsidian Reading or Editing view can easily cause performance degradation if implemented with DOM mutations.

---

## 1. Why `<span>` Injection & `parent.normalize()` Freeze Obsidian

Attempting to highlight text by injecting DOM wrappers (e.g. `<span class="active-word">` via `range.surroundContents(span)`):
1. **Layout Thrashing**: Causes synchronous browser layout recalculation and reflow on every spoken word or state change.
2. **The Catastrophic `parent.normalize()` Trap**:
   When removing temporary highlight spans, developers frequently call `parent.normalize()` to merge adjacent Text nodes.
   In Obsidian's Reading View and Live Preview (CodeMirror 6), calling `.normalize()` directly mutates CodeMirror's internally managed Text nodes. CodeMirror's MutationObservers intercept this and trigger synchronous document re-parsing and layout recalculation on every word update (every 50-100ms).
   This throws the Electron renderer into an infinite layout thrash loop, causing the **entire Obsidian application window to freeze completely**.
3. **Editor State Disruption**: Breaks typing, active selections, search matches, and CodeMirror internal range trees.

> [!CAUTION] Never Call `normalize()` or `surroundContents()` Inside Obsidian Leaf DOM
> Treat the active note's DOM as read-only for text synchronization. Never inject DOM elements or normalize Text nodes inside `.markdown-reading-view`, `.cm-content`, or active leaf containers.

---

## 2. The CSS Custom Highlight API Solution (Zero-DOM Mutations)

The modern **CSS Custom Highlight API** (`CSS.highlights`) allows you to style arbitrary text ranges directly on the browser's compositing layer without modifying a single DOM node. Supported natively in Obsidian's Chromium engine.

### Step 1: Register CSS Highlight Styles
In your plugin's `styles.css`:
```css
::highlight(active-word-highlight) {
  background-color: var(--text-highlight-bg, #ffe082);
  color: var(--text-normal);
  border-radius: 2px;
}
```

### Step 2: Index Note Text Nodes
Traverse the active Markdown leaf once when playback begins:
```typescript
interface TextSegment {
  node: Text;
  charStart: number;
  charEnd: number;
}

function buildTextNodeIndex(rootElement: HTMLElement): TextSegment[] {
  const segments: TextSegment[] = [];
  let currentOffset = 0;

  const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();

  while (currentNode) {
    const textNode = currentNode as Text;
    const len = textNode.textContent?.length || 0;
    if (len > 0) {
      segments.push({
        node: textNode,
        charStart: currentOffset,
        charEnd: currentOffset + len,
      });
      currentOffset += len;
    }
    currentNode = walker.nextNode();
  }

  return segments;
}
```

### Step 3: Highlight Without DOM Mutations
On every animation frame or time-update event:
```typescript
function highlightWordRange(segments: TextSegment[], startChar: number, endChar: number) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) {
    return; // Provide fallback if CSS highlights are unsupported
  }

  // Find start and end text nodes
  const startSegment = segments.find(s => startChar >= s.charStart && startChar < s.charEnd);
  const endSegment = segments.find(s => endChar > s.charStart && endChar <= s.charEnd);

  if (!startSegment || !endSegment) return;

  const range = new Range();
  range.setStart(startSegment.node, startChar - startSegment.charStart);
  range.setEnd(endSegment.node, endChar - endSegment.charStart);

  // Register in browser highlights registry (zero DOM reflows)
  // @ts-ignore (Highlight API typing)
  CSS.highlights.set("active-word-highlight", new Highlight(range));
}

function clearHighlight() {
  if (typeof CSS !== "undefined" && "highlights" in CSS) {
    CSS.highlights.delete("active-word-highlight");
  }
}
```

---

## 3. Sequential Offset Tracking & Multi-Word Anchor Matching

A frequent pitfall in documents with repetitive dialogue or questions (e.g. `"How do you keep yourself accountable? How do you stop snacking?"`) is **prefix collision**: searching for words like `"How"` or `"do"` matches the earlier sentence in the paragraph.

### The Sequential Search Pattern
To ensure sentences and words resolve to the correct character ranges without regression:

1. **Track Last Matched Block & End Offset**:
   Maintain `lastMatchedBlock` and `lastMatchedSentenceEndOffset`. Within the same container paragraph/block, always search forward from the previous sentence's ending offset:
   ```typescript
   const searchFromOffset = Math.max(0, this.lastMatchedSentenceEndOffset);
   const idx = blockText.toLowerCase().indexOf(anchorPhrase, searchFromOffset);
   ```
2. **Multi-Word Anchor Phrases**:
   Search for a 3-to-4 word anchor phrase first (e.g. `anchorSnippet4` $\rightarrow$ `anchorSnippet3` $\rightarrow$ `anchorSnippet2`) before falling back to single words:
   ```typescript
   const wordsClean = sentenceWords.map(w => w.replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase());
   const anchor4 = wordsClean.slice(0, 4).join(" ");
   const anchor2 = wordsClean.slice(0, 2).join(" ");
   ```
3. **Reset on Block Changes**:
   When the target sentence transitions to a new paragraph (`matchedBlock !== lastMatchedBlock`), reset `lastMatchedSentenceEndOffset = 0` and update `lastMatchedBlock`.


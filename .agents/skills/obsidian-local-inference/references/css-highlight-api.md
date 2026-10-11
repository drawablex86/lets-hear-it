# Reference: CSS Custom Highlight API for Zero-DOM Highlighting

Synchronizing audio/speech playback with visual text highlighting in Obsidian Reading or Editing view can easily cause performance degradation if implemented with DOM mutations.

---

## 1. Why `<span>` Injection Fails

Wrapping words in `<span class="active-word">`:
- Causes DOM layout reflows on every spoken word.
- Breaks Obsidian's internal Markdown parsing and preview caches.
- Collides with search, selection, and CodeMirror editor state.

---

## 2. The CSS Custom Highlight API Solution

The modern **CSS Custom Highlight API** (`CSS.highlights`) allows you to style text ranges directly on the browser's compositing layer without modifying the DOM.

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

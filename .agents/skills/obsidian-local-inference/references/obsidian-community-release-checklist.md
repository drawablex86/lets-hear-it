# Reference: Obsidian Community Plugin Release & Review Checklist

This checklist consolidates all official requirements, automated audit checks, and reviewer guidelines from the official [Obsidian Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and `community.obsidian.md` review system.

---

## 1. Manifest Hygiene (`manifest.json`)

| Field | Rule | Example / Note |
|---|---|---|
| `id` | Lowercase kebab-case matching repository directory | `"lets-hear-it"` |
| `name` | Basic Latin alphanumeric and spaces ONLY. **NO apostrophes or punctuation**. | `"Lets Hear It"` (NOT `"Let's Hear It"`) |
| `version` | Strict 3-digit SemVer. Matches git tag exactly. | `"1.0.5"` (NOT `"v1.0.5"` or `"1.0.5.0"`) |
| `minAppVersion` | Must match APIs used. Use `"1.7.0"` or higher. | `"1.7.0"` (never declare older than your utilized APIs) |
| `description` | Concise, English, descriptive without marketing fluff. | Maximum 1-2 clean sentences. |
| `isDesktopOnly` | Set to `true` if using Node modules, WebGPU, or desktop-only APIs. | `true` |

---

## 2. Dependencies & Strict Lockfile Hygiene

Obsidian's review bot runs `npm ci` in strict mode in an isolated review container:
- **Lockfile Out-of-Date Error**: If you bump versions in `package.json` or add `overrides` without running `npm install` locally, `package-lock.json` will desynchronize. The bot will reject the release with:
  ```
  The npm lockfile is out of date. Please run npm install locally and commit the updated package-lock.json.
  Source review dependency installation failed
  ```
- **Action**: Always run `npm install` and verify with `npm ci` before committing and tagging.
- **Vulnerability Advisories**: Review transitive dependencies (`npm audit`). If transitive sub-dependencies (e.g. `sharp`, `sprintf-js`) trigger advisories, use `overrides` in `package.json` to bump safe versions (e.g. `"overrides": { "sharp": "^0.35.0" }`).

---

## 3. Security & DOM Construction Standards

### A. Avoid `innerHTML`, `outerHTML`, and `insertAdjacentHTML`
- ❌ **Security Risk**: Building DOM elements from strings or user-defined input using `innerHTML` or `outerHTML` enables arbitrary code execution (XSS) inside Electron.
- ✅ **Use DOM API and Obsidian Helpers**:
  ```typescript
  // Programmatic element creation
  const container = containerEl.createDiv({ cls: "my-container" });
  const label = container.createSpan({ text: "Hello", cls: "my-label" });
  
  // Clear container contents safely
  container.empty();
  ```
- ❌ **Do NOT use `document.createElement("span")`**: Triggers `obsidianmd/prefer-create-el`. Use `createSpan()`, `createDiv()`, or `containerEl.createEl("span")`.

---

## 4. UI Text, Headings, and Styling Guidelines

### A. Strict Sentence Case for UI Text
All text across settings, commands, and buttons must use **sentence case** (only the first word and proper nouns capitalized):
- ✅ Prefer: `"Template folder location"`, `"Create new note"`, `"Speech rate"`
- ❌ Avoid: `"Template Folder Location"`, `"Create New Note"`, `"Speech Rate"`

### B. Settings Headings Standards
- ❌ **Never use HTML headings**: `containerEl.createEl("h2", { text: "Section" })` triggers:
  `For a consistent UI use new Setting(containerEl).setName(...).setHeading() instead of creating HTML heading elements directly.`
- ❌ **Avoid "settings" or "options" in headings**:
  - Prefer `"Advanced"` over `"Advanced settings"`.
  - Prefer `"Speech & voice"` over `"Voice settings"`.
- ❌ **No top-level heading for general settings**: If general settings are at the top of your settings tab, do not add a heading above them. Only add headings when separating subsequent sections.
- ❌ **Do NOT call `this.display()` recursively**: `this.display()` is deprecated as of Obsidian 1.13.0. Update UI elements in-place:
  ```typescript
  statusSetting.setDesc("🟢 Engine ready");
  btn.setButtonText("Verify");
  ```

### C. Declarative Settings Dual-Support (`getSettingDefinitions`)
Obsidian 1.13.0 introduced global search indexing for settings. Provide both declarative definitions and imperative fallback:
```typescript
import { PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";

export class MySettingTab extends PluginSettingTab {
  // 1. Declarative definitions for search indexing in Obsidian 1.13.0+
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Voice model",
        desc: "Neural speech model.",
        control: {
          type: "dropdown",
          key: "voice",
          options: { default_voice: "Default voice" },
        },
      },
    ];
  }

  // 2. Imperative display for backward compatibility with minAppVersion
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Voice model")
      .setDesc("Neural speech model.")
      .addDropdown((d) => d.setValue(this.plugin.settings.voice));
  }
}
```

### D. No Hardcoded Styling
- ❌ **Never hardcode inline styles**:
  ```typescript
  el.style.color = "white"; // ❌ BREAKS USER THEMES
  el.style.backgroundColor = "red";
  ```
- ✅ **Use CSS classes and Obsidian theme variables**:
  ```typescript
  const el = containerEl.createDiv({ cls: "warning-banner" });
  ```
  ```css
  /* styles.css */
  .warning-banner {
    color: var(--text-normal);
    background-color: var(--background-modifier-error);
    border-radius: var(--radius-s);
  }
  ```

---

## 5. Workspace, Editor, & Leaf Management

### A. Accessing the Active View
- ❌ **Avoid `workspace.activeLeaf` directly**:
- ✅ **Use `getActiveViewOfType` or `activeEditor`**:
  ```typescript
  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
  if (view) {
    // view is guaranteed to be an open MarkdownView
  }

  const editor = this.app.workspace.activeEditor?.editor;
  ```

### B. Custom View Lifecycles
- ❌ **Do NOT store custom view instances directly on the plugin**:
  ```typescript
  this.registerView(VIEW_TYPE, () => this.myView = new MyCustomView()); // ❌ Memory leak
  ```
- ✅ **Register view factory and query leaves dynamically**:
  ```typescript
  this.registerView(VIEW_TYPE, () => new MyCustomView());

  for (const leaf of this.app.workspace.getActiveLeavesOfType(VIEW_TYPE)) {
    if (leaf.view instanceof MyCustomView) {
      // Use active instance safely
    }
  }
  ```

### C. Do NOT Detach Leaves in `onunload`
When a user updates a plugin, leaves are re-initialized. Detaching leaves in `onunload` forces them back to their default position and erases user layout customizations.

---

## 6. Vault & File Operations

### A. Active Note Modifications: Prefer Editor API
When modifying an actively open note, use the `Editor` API instead of `Vault.modify()`. `Editor` preserves the user's cursor position, selection range, and folded headings:
```typescript
const editor = this.app.workspace.activeEditor?.editor;
if (editor) {
  editor.replaceSelection("Inserted text");
}
```

### B. Background File Modifications: Use `Vault.process`
For notes not currently active, `Vault.process()` modifies files atomically to eliminate race conditions between multiple plugins:
```typescript
await this.app.vault.process(tfile, (data) => {
  return data + "\nAppended content";
});
```

### C. Frontmatter Modifications: Use `processFrontMatter`
Avoid regex-based YAML parsing. Use `FileManager.processFrontMatter()` to ensure atomic, syntax-preserving frontmatter updates:
```typescript
await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
  frontmatter["reviewed"] = true;
  frontmatter["rating"] = 5;
});
```

### D. File Retrieval & Path Normalization
- ❌ Avoid array filtering: `this.app.vault.getFiles().find(f => f.path === p)`
- ✅ Use direct lookup: `this.app.vault.getFileByPath(normalizePath(p))`
- Always use `normalizePath()` on user input to resolve slashes and Unicode characters.

---

## 7. Commands & Hotkey Etiquette

### A. Avoid Default Hotkeys
Never set default hotkeys for commands. Default hotkeys cause collisions between plugins and break across different operating systems. Allow users to configure their own hotkeys in Obsidian Settings.

### B. Appropriate Command Callbacks
- `callback`: Runs unconditionally.
- `checkCallback`: Runs conditionally (returns boolean in check mode).
- `editorCallback`: Runs when an editor is active.
- `editorCheckCallback`: Conditional execution requiring an active editor.

---

## 8. Runtime & Environment Standards

### A. Network Requests: Always Use `requestUrl`
- ❌ **Do NOT use `fetch()`**: Triggers `obsidianmd/no-fetch`.
- ✅ **Use `requestUrl`**:
  ```typescript
  import { requestUrl } from "obsidian";

  const res = await requestUrl({ url: "https://example.com/asset.wasm" });
  const bytes = new Uint8Array(res.arrayBuffer);
  ```

### B. Popout Window Compatibility: Avoid `globalThis`
- ❌ **Do NOT use `globalThis`**: Use `window` or `activeWindow`.
  ```typescript
  if (typeof window !== "undefined" && typeof require !== "undefined") {
    (window as unknown as { require?: typeof require }).require = require;
  }
  ```

### C. Promise & TypeScript Hygiene
- ❌ **Floating Promises**: Mark un-awaited async calls with `void`:
  ```typescript
  void this.startPlayback();
  ```
- ❌ **Empty Catch Blocks**: Document all catch blocks:
  ```typescript
  try {
    node.disconnect();
  } catch {
    // Expected: Audio node may already be detached
  }
  ```
- Prefer `const` and `let` over `var`.
- Prefer `async`/`await` over `.then()`/`.catch()` chaining.
- Remove all `console.log` in production builds.

---

## 9. Review Bot Rescan & Pre-Release Testing

1. **Scan Results Caching**:
   Obsidian caches automated scan results by release version (`1.0.8`). If a release failed, re-tagging or re-uploading under the exact same version string does **not** trigger a fresh scan.
2. **Instant Pre-Release Testing ("Review branch")**:
   You do not need to create a release to verify your plugin! Click the **"Review branch"** button on `community.obsidian.md` and enter your feature branch name (e.g. `fix-synchronized-word-highlighter`). The review bot will run the full test suite against your branch immediately.
3. **Publishing the Release**:
   Once verified, bump to the next patch version, update `package-lock.json`, tag, and release.

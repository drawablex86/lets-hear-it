# Reference: Obsidian Community Plugin Release & Review Checklist

This checklist consolidates all official requirements, automated audit checks, and reviewer bot expectations for submitting and updating Obsidian community plugins on `community.obsidian.md`.

---

## 1. Manifest Hygiene (`manifest.json`)

| Field | Rule | Example / Note |
|---|---|---|
| `id` | Lowercase kebab-case matching repo directory | `"lets-hear-it"` |
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

## 3. Obsidian Coding & Linter Standards

### A. Declarative Settings API (`getSettingDefinitions`) Dual-Support
Obsidian 1.13.0 introduced global search indexing for settings. If a plugin only provides the legacy `display()` method, the bot warns:
`This PluginSettingTab does not implement getSettingDefinitions(); its settings will not appear in Obsidian's settings search for users on 1.13.0 or later.`

**Solution: Dual-Support Pattern**
Implement both `getSettingDefinitions()` and `display()`:
```typescript
import { PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";

export class MySettingTab extends PluginSettingTab {
  // 1. Declarative definitions for Obsidian 1.13.0+ search indexing
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Model",
        desc: "Neural model selection.",
        control: {
          type: "dropdown",
          key: "model",
          options: { default_model: "Default Model" },
        },
      },
    ];
  }

  // 2. Imperative display for backward compatibility with minAppVersion 1.7.0
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Neural model selection.")
      .addDropdown((d) => d.setValue(this.plugin.settings.model));
  }
}
```

### B. Settings Headings & In-Place Updates
- ❌ **Do NOT use HTML heading elements**: `containerEl.createEl("h2", { text: "My Section" })` triggers:
  `For a consistent UI use new Setting(containerEl).setName(...).setHeading() instead of creating HTML heading elements directly.`
- ❌ **Do NOT include "setting" or "option" in headings**: `setName("Model Settings").setHeading()` triggers:
  `Avoid using "settings" in settings headings.` (Headings should be concise, e.g. `"Model Configuration"`, `"Speech & Voice"`, `"Storage & Cache"`).
- ❌ **Do NOT recursively call `this.display()`**: `this.display()` is deprecated as of Obsidian 1.13.0. When toggling states or finishing downloads, update existing UI elements in-place:
  ```typescript
  // In-place UI update
  statusSetting.setDesc("🟢 Ready");
  btn.setButtonText("Verify");
  ```

### C. Network Requests: Always Use `requestUrl`
- ❌ **Do NOT use `fetch()`**: Native browser `fetch()` triggers:
  `Unexpected use of 'fetch'. Use the built-in requestUrl function instead of fetch for network requests in Obsidian.`
- ✅ **Use Obsidian's `requestUrl`**:
  ```typescript
  import { requestUrl } from "obsidian";

  const response = await requestUrl({ url: "https://example.com/asset.wasm" });
  if (response.status === 200) {
    const bytes = new Uint8Array(response.arrayBuffer);
    const text = response.text;
  }
  ```

### D. Popout Window Compatibility: Avoid `globalThis`
- ❌ **Do NOT use `globalThis`**: `globalThis.require` or `globalThis.process` triggers:
  `Avoid using 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility.`
- ✅ **Use `window` or `activeWindow`**:
  ```typescript
  if (typeof window !== "undefined" && typeof require !== "undefined") {
    (window as unknown as { require?: typeof require }).require = require;
  }
  ```

### E. Promise & Catch Block Hygiene
- ❌ **Floating Promises**: Any asynchronous function called without `await` must be explicitly marked with `void`:
  ```typescript
  void this.processQueue(); // ✅ Explicitly ignored floating promise
  ```
- ❌ **Empty Catch Blocks**: Empty catch blocks (`catch {}` or `catch (_) {}`) trigger linter warnings:
  ```typescript
  try {
    audioNode.stop();
  } catch {
    // Expected: Audio node may already be detached or completed
  }
  ```

### F. DOM Construction Helpers
- ❌ Do NOT use: `document.createElement("span")` (Triggers `obsidianmd/prefer-create-el`).
- ✅ Use Obsidian's built-in helpers: `createSpan({ cls: "my-class" })`, `createDiv()`, or `containerEl.createEl("span")`.

### G. Clean Type Assertions
- ❌ Avoid redundant type assertions that don't change the inferred expression type (e.g., asserting `as string` on a variable that `path.join()` already typed as `string`, or `as Buffer` on `fs.readFileSync()`).

### H. Console Logging
- Remove all debugging `console.log` statements in production builds.
- Only leave actionable warnings or critical errors prefixed with the plugin name:
  ```typescript
  console.warn("[my-plugin] Failed to initialize hardware acceleration:", err);
  ```

---

## 4. Release Assets & Provenance

When creating a GitHub Release:
1. **Required Assets**: Attach exactly:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. **Tag Format**: Strict 3-digit version without `v` prefix (`1.0.5`).
3. **Artifact Attestations**:
   To eliminate OpenSSF / GitHub provenance recommendations (`Missing GitHub artifact attestations for release assets`), use GitHub Actions with `actions/attest-build-provenance` when building from CI.

---

## 5. Review Bot Rescan & Pre-Release Testing

1. **Scan Results Caching**:
   Obsidian caches automated scan results by release version (`1.0.4`). If a release failed, re-tagging or re-uploading under the exact same version string does **not** trigger a fresh scan.
2. **Instant Pre-Release Testing ("Review branch")**:
   You do not need to create a release to see if your code passes the audit! Click the **"Review branch"** button on `community.obsidian.md` and enter your branch name (e.g. `master`). The review bot will run the full test suite against your latest commit immediately.
3. **Publishing the Fix**:
   Once verified, bump to the next patch version (e.g., `1.0.5`), update `package-lock.json`, tag, and release.

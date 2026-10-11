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
        name: "Voice",
        desc: "Neural voice model selection.",
        control: {
          type: "dropdown",
          key: "voice",
          options: { af_heart: "Heart (US Female)", bm_george: "George (UK Male)" },
        },
      },
    ];
  }

  // 2. Imperative display for backward compatibility with minAppVersion 1.7.0
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Voice")
      .setDesc("Neural voice model selection.")
      .addDropdown((d) => d.setValue(this.plugin.settings.voice));
  }
}
```

### B. DOM Construction: Use Obsidian Helpers
- ❌ Do NOT use: `document.createElement("span")` (Triggers `obsidianmd/prefer-create-el`).
- ✅ Use Obsidian's built-in helpers: `createSpan({ cls: "my-class" })`, `createDiv()`, or `containerEl.createEl("span")`.

### C. Popout Window Compatibility: Avoid `globalThis`
- ❌ Do NOT use: `(globalThis as any).require`.
- ✅ Use `window` or `activeWindow`:
  ```typescript
  if (typeof window !== "undefined" && typeof require !== "undefined") {
    (window as unknown as { require?: typeof require }).require = require;
  }
  ```

### D. Clean Catch Blocks & Unused Variables
- ❌ Do NOT leave empty catch blocks without comments (`catch (_) {}`).
- ❌ Do NOT define unused error variables (`catch (firstError)`).
- ✅ Use ES2019+ optional catch binding with comments:
  ```typescript
  try {
    source.stop();
  } catch {
    // Safely ignore if audio node was already detached
  }
  ```

### E. Console Logging
- Remove all `console.log` statements in production code.
- Only leave actionable warnings or critical errors prefixed with the plugin name:
  ```typescript
  console.warn("[my-plugin] Failed to initialize WebGPU:", err);
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

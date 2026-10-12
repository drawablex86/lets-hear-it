---
name: obsidian-local-inference
description: >-
  Expert guide and architectural patterns for building Obsidian plugins that run local AI models
  (ONNX Runtime Web, Kokoro, Whisper, Transformers.js, embeddings) inside Obsidian's Electron sandbox.
  Use this skill whenever building, modifying, or debugging an Obsidian plugin with on-device AI inference,
  WASM SIMD, WebGPU, local audio generation, or non-destructive editor text tracking.
---

# Obsidian Local Inference & Official Plugin Development Guide

Running modern neural models directly inside Obsidian desktop plugins offers total privacy, zero cloud latency, and zero recurring API costs. However, Obsidian executes inside an Electron sandbox with strict Chromium security origins, Node integration boundaries, and hardware audio constraints. Furthermore, submitting or updating plugins for the Obsidian Community Store requires strict adherence to official [Obsidian Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).

This skill documents the exact architectural patterns, build transformations, official guidelines, and debugging fixes required to build, test, and release reliable plugins.

---

## ⚡ The 8 Critical Traps & Battle-Tested Solutions

### Trap 1: Dynamic ESM Import Failures on `file://` Protocols
- **The Issue**: Libraries like `onnxruntime-web` or `@huggingface/transformers` dynamically call `import(fileUrl)` for `.mjs` helper scripts. In Electron's renderer, Chromium blocks dynamic `import()` on `file://` or `app://` URLs with CORS/protocol errors.
- **The Solution**: In `esbuild.config.mjs`, post-process the bundled `main.js` to intercept dynamic imports. If the specifier is a `file://` URL, read the script via Node's `fs` module, convert it to a Base64-encoded Data URL, and dynamically import it as `data:text/javascript;base64,...`.
  *See [references/esbuild-wasm-patching.md](./references/esbuild-wasm-patching.md) for full implementation details.*

---

### Trap 2: Emscripten WASM Loader Blocking on `XMLHttpRequest`
- **The Issue**: Emscripten-compiled `.mjs` runners use `XMLHttpRequest` or `fetch({ credentials: "same-origin" })` in functions `la`, `ma`, and `Ta` to download `.wasm` binaries. In Electron, `XMLHttpRequest` calls to local files fail with status `0`.
- **The Solution**: Patch the copied `ort-wasm*.mjs` files in your esbuild build pipeline. Replace Emscripten's `la`, `ma`, and `Ta` functions with direct Node `fs.readFileSync` calls that return a `Uint8Array`. Additionally, pass the buffer into `ort.env.wasm.wasmBinary` during plugin startup.
  *See [references/esbuild-wasm-patching.md](./references/esbuild-wasm-patching.md) for exact regex patterns.*

---

### Trap 3: Node CLI vs. Browser Environment Confusion
- **The Issue**: In Obsidian's Electron environment, `process` exists, but `process.type` might not be set to `"renderer"` at module initialization. Libraries like `transformers.js` or `onnxruntime` might assume they are running in a headless Node CLI and attempt to spawn worker threads or load native Node addons, throwing syntax errors.
- **The Solution**: In your plugin's `onload()` method, explicitly configure environment flags and expose `require` on `window` (avoiding `globalThis` to pass Obsidian's ESLint rules) before loading any neural libraries:
  ```typescript
  async onload() {
    const electronProc = typeof process !== "undefined" ? (process as unknown as { type?: string }) : undefined;
    if (electronProc && !electronProc.type) {
      electronProc.type = "renderer";
    }
    if (typeof window !== "undefined" && typeof require !== "undefined") {
      (window as unknown as { require?: typeof require }).require = require;
    }
  }
  ```
  *See [references/electron-sandbox-rules.md](./references/electron-sandbox-rules.md).*

---

### Trap 4: CoreAudio Sample Rate Mismatch & Audio Popping
- **The Issue**: TTS or speech models frequently output at 16kHz or 24kHz PCM (e.g., Kokoro-82M outputs 24kHz). If you force the `AudioContext` to match the model (`new AudioContext({ sampleRate: 24000 })`), macOS DACs running at 44.1kHz or 48kHz trigger buffer under-runs, audible clicks, and sample dropouts.
- **The Solution**: 
  1. Initialize `AudioContext` with system default parameters so it matches hardware rate (44.1kHz/48kHz).
  2. Create audio buffers with the model's native rate: `audioContext.createBuffer(1, pcmSamples.length, 24000)`.
  3. Let WebAudio's hardware resampler upsample the audio cleanly.
  *See [references/webaudio-resampling.md](./references/webaudio-resampling.md).*

---

### Trap 5: DOM Thrashing During Live Word Tracking
- **The Issue**: Injecting `<span class="active-word">` into Obsidian's markdown view invalidates CodeMirror/Live-Preview state, disrupts typing, and causes severe layout reflows and frame drops during fast speech.
- **The Solution**: Use the modern **CSS Custom Highlight API** (`CSS.highlights`):
  1. Pin candidate block elements (`p`, `li`, `h1`-`h6`, `.cm-line`) using multi-word anchor snippets.
  2. Compute occurrence-aware word indices (`targetOccurrence`) to handle duplicate words in a sentence without regression.
  3. Update a single DOM `Range` and register it with `CSS.highlights.set("my-active-word", new Highlight(range))` inside a `requestAnimationFrame` loop.
  4. Style with `::highlight(my-active-word) { background-color: var(--text-highlight-bg); }`.
  *This provides 60 FPS real-time text tracking with **zero DOM mutations**.*
  *See [references/css-highlight-api.md](./references/css-highlight-api.md).*

---

### Trap 6: High Per-Sentence Inference Overhead & Buffer Starvation
- **The Issue**: Processing text sentence-by-sentence incurs large model setup and graph dispatch overhead. On CPU WASM fallback, short sentences finish playing before the next one synthesizes, creating audible gaps.
- **The Solution**: Multi-sentence chunking with instant start:
  1. Group sentences into speech batches up to $\sim 350\text{--}400$ characters.
  2. Synthesize Batch 0 immediately to start audio in **$<200\text{ms}$**.
  3. Asynchronously pre-buffer Batch 1, Batch 2, etc., in the background queue.

---

### Trap 7: Obsidian Community Review Bot & Lockfile Failures
- **The Issue**: Obsidian's automated reviewer runs strict `npm ci` and static AST analyzers. Common failures include:
  1. **Lockfile Desync**: Bumping versions or overrides in `package.json` without running `npm install` causes `package-lock.json` desync and immediate CI failure.
  2. **Security**: Using `innerHTML` or `outerHTML` triggers automatic rejection.
  3. **Settings Headings**: Creating HTML heading elements directly (`containerEl.createEl("h2")`) or using the words "setting" or "option" in heading names triggers review errors.
  4. **Network Calls**: Using browser `fetch()` instead of Obsidian's `requestUrl()` triggers warnings.
  5. **Declarative Settings Missing**: Not providing `getSettingDefinitions()` for Obsidian 1.13.0+ search indexing triggers review warnings.
  6. **Scanner Result Caching**: Obsidian caches results per version string; re-tagging the same version will not re-scan. Use the **"Review branch"** button or bump the patch version.
- **The Solution**: Follow the comprehensive [Obsidian Community Release Checklist](./references/obsidian-community-release-checklist.md) before publishing any release tag.

---

### Trap 8: Community Store 3-File Limitation & The In-Settings Downloader
- **The Issue**: Obsidian's marketplace strictly distributes only 3 files: `main.js`, `manifest.json`, and `styles.css`. Local `.wasm`, `.mjs`, and neural weights are **never** distributed by the store. Falling back to public unpinned CDNs causes Emscripten signature mismatches and Node worker crashes.
- **The Solution**: Build an **In-Settings Asset Downloader & First-Run Guard**:
  1. Check if required runtime assets exist inside the plugin's vault directory (`<vault>/.obsidian/plugins/<plugin-id>/`).
  2. If missing, present an in-settings download button and auto-prompt first-run users.
  3. Use Obsidian's `requestUrl` to download matching, version-pinned binaries directly into the plugin directory.
  4. Execute models 100% offline from local disk once downloaded.
  *See [references/electron-sandbox-rules.md](./references/electron-sandbox-rules.md).*

---

## 📁 Skill Reference Index

- [Obsidian Community Release Checklist](./references/obsidian-community-release-checklist.md) — Comprehensive guide to passing automated review audits and adhering to official plugin guidelines.
- [esbuild WASM Patching Guide](./references/esbuild-wasm-patching.md) — Exact AST/regex replacers for local WASM in Electron.
- [Electron Sandbox Rules](./references/electron-sandbox-rules.md) — Permissions, renderer flags, Direct Filesystem disclosures, and In-Settings Asset Downloaders.
- [WebAudio Resampling & Audio Graph](./references/webaudio-resampling.md) — DAC synchronization and gapless playback.
- [CSS Custom Highlight API](./references/css-highlight-api.md) — Zero-mutation text tracking implementation.
- [esbuild.config.template.mjs](./examples/esbuild.config.template.mjs) — Complete boilerplate build script for Obsidian + ONNX plugins.

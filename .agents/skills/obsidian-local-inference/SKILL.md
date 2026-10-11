---
name: obsidian-local-inference
description: >-
  Expert guide and architectural patterns for building Obsidian plugins that run local AI models
  (ONNX Runtime Web, Kokoro, Whisper, Transformers.js, embeddings) inside Obsidian's Electron sandbox.
  Use this skill whenever building, modifying, or debugging an Obsidian plugin with on-device AI inference,
  WASM SIMD, WebGPU, local audio generation, or non-destructive editor text tracking.
---

# Obsidian Local Inference Engineering Guide

Running modern neural models directly inside Obsidian desktop plugins offers total privacy, zero cloud latency, and zero recurring API costs. However, Obsidian executes inside an Electron sandbox with strict Chromium security origins, node integration boundaries, and hardware audio constraints.

This skill documents the exact architectural patterns, build transformations, and debugging fixes required to run local AI models smoothly inside Obsidian without running into protocol, CORS, WASM, or audio pitfalls.

---

## ⚡ The 6 Critical Traps & Battle-Tested Solutions

### Trap 1: Dynamic ESM Import Failures on `file://` Protocols
- **The Issue**: Libraries like `onnxruntime-web` or `@huggingface/transformers` dynamically call `import(fileUrl)` for `.mjs` helper scripts. In Electron's renderer, Chromium blocks dynamic `import()` on `file://` or `app://` URLs with CORS/protocol errors:
  ```
  TypeError: Failed to fetch dynamically imported module: file:///.../ort-wasm-simd-threaded.mjs
  ```
- **The Solution**: In `esbuild.config.mjs`, post-process the bundled `main.js` to intercept dynamic imports. If the specifier is a `file://` URL, read the script via Node's `fs` module, convert it to a Base64-encoded Data URL, and dynamically import it as `data:text/javascript;base64,...`:
  ```javascript
  const search = `(await import(r)).default`;
  const replacement = `(await (async (specifier) => {
    if (typeof require === "function" && typeof specifier === "string" && specifier.startsWith("file://")) {
      const fs = require("fs");
      const filePath = decodeURIComponent(specifier.replace(/^file:\\/\\//, ""));
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath);
        const base64 = Buffer.from(fileContent).toString("base64");
        return import(\`data:text/javascript;base64,\${base64}\`);
      }
    }
    return import(specifier);
  })(r)).default`;
  ```
  *See [references/esbuild-wasm-patching.md](./references/esbuild-wasm-patching.md) for full implementation details.*

---

### Trap 2: Emscripten WASM Loader Blocking on `XMLHttpRequest`
- **The Issue**: Emscripten-compiled `.mjs` runners use `XMLHttpRequest` or `fetch({ credentials: "same-origin" })` in functions `la`, `ma`, and `Ta` to download `.wasm` binaries. In Electron, `XMLHttpRequest` calls to local files fail with status `0`, causing:
  ```
  both async and sync fetching of the wasm failed
  ```
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
    // Now initialize ONNX or local models...
  }
  ```
  *See [references/electron-sandbox-rules.md](./references/electron-sandbox-rules.md).*

---

### Trap 4: CoreAudio Sample Rate Mismatch & Audio Popping
- **The Issue**: TTS or speech models frequently output at 16kHz or 24kHz PCM (e.g., Kokoro-82M outputs 24kHz). If you force the `AudioContext` to match the model:
  ```typescript
  new AudioContext({ sampleRate: 24000 }); // ❌ CAUSES BUFFER POPPING ON MACOS
  ```
  On macOS, DACs run natively at 44.1kHz or 48kHz. Forcing 24kHz creates buffer under-runs, audible clicks, and sample dropouts at chunk transitions.
- **The Solution**: 
  1. Initialize `AudioContext` with system default parameters so it matches hardware rate (44.1kHz/48kHz).
  2. Create audio buffers with the model's native rate: `audioContext.createBuffer(1, pcmSamples.length, 24000)`.
  3. Let WebAudio's hardware-accelerated resampler upsample the audio cleanly.
  *See [references/webaudio-resampling.md](./references/webaudio-resampling.md).*

---

### Trap 5: DOM Thrashing During Live Word Tracking
- **The Issue**: Injecting `<span class="active-word">` into Obsidian's markdown view invalidates CodeMirror/Live-Preview state, disrupts typing, and causes severe layout reflows and frame drops during fast speech.
- **The Solution**: Use the modern **CSS Custom Highlight API** (`CSS.highlights`):
  1. Build a one-time global character-to-node index mapping text nodes.
  2. Estimate word duration markers proportionally:
     $$\text{Word Duration} = \text{Sentence Duration} \times \left(\frac{\text{Word Length}}{\text{Sentence Length}}\right)$$
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
  4. This eliminates per-sentence overhead while preserving instant playback response.

---

### Trap 7: Obsidian Community Review Bot & Lockfile Failures
- **The Issue**: Obsidian's automated reviewer runs strict `npm ci` and static AST analyzers. Common failures include:
  1. **Lockfile Desync**: Bumping versions or overrides in `package.json` without running `npm install` causes `package-lock.json` desync and immediate CI failure.
  2. **Tag Format**: Using `v1.0.0` instead of `1.0.0` causes release detection failures.
  3. **Punctuation in Names**: Using apostrophes or punctuation in `manifest.json` (`"name": "Let's Hear It"`) fails review.
  4. **Declarative Settings Missing**: Not providing `getSettingDefinitions()` for Obsidian 1.13.0+ search indexing triggers review warnings.
  5. **Direct Filesystem Access**: Using Node `fs` without a disclosure section in `README.md` triggers warnings.
  6. **Scanner Result Caching**: Obsidian caches results per version string; re-tagging the same version will not re-scan. Use the **"Review branch"** button or bump the patch version.
- **The Solution**: Follow the comprehensive [Obsidian Community Release Checklist](./references/obsidian-community-release-checklist.md) before publishing any release tag.

---

## 📁 Skill Reference Index

- [Obsidian Community Release Checklist](./references/obsidian-community-release-checklist.md) — Comprehensive guide to passing automated review audits.
- [esbuild WASM Patching Guide](./references/esbuild-wasm-patching.md) — Exact AST/regex replacers for local WASM in Electron.
- [Electron Sandbox Rules](./references/electron-sandbox-rules.md) — Permissions, renderer flags, Direct Filesystem disclosures, and CDN fallbacks.
- [WebAudio Resampling & Audio Graph](./references/webaudio-resampling.md) — DAC synchronization and gapless playback.
- [CSS Custom Highlight API](./references/css-highlight-api.md) — Zero-mutation text tracking implementation.
- [esbuild.config.template.mjs](./examples/esbuild.config.template.mjs) — Complete boilerplate build script for Obsidian + ONNX plugins.

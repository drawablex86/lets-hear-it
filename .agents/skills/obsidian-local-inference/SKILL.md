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

## ⚡ The 10 Critical Traps & Battle-Tested Solutions

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

### Trap 5: DOM Thrashing, Prefix Collision & Sequential Text Tracking
- **The Issue**: Injecting `<span class="active-word">` into Obsidian's markdown view invalidates CodeMirror/Live-Preview state, disrupts typing, and causes severe layout reflows. Furthermore, in notes with repetitive phrases (e.g. dialogue, questions like `"How do you...?"`), naive word searches match earlier occurrences in the block, corrupting character offsets.
- **The Solution**: 
  1. Exclusively use the **CSS Custom Highlight API** (`CSS.highlights`) for zero-mutation text tracking.
  2. Implement **Sequential Offset Tracking** (`lastMatchedSentenceEndOffset`): within any container block, subsequent sentences must search strictly forward from the previous sentence's ending offset.
  3. Use **Multi-Word Anchor Phrases** (3-4 words, e.g. `anchorSnippet4` $\rightarrow$ `anchorSnippet3` $\rightarrow$ `anchorSnippet2`) before falling back to individual word tokens, eliminating prefix collisions.
  *See [references/css-highlight-api.md](./references/css-highlight-api.md).*

---

### Trap 6: Small-Context Model Token Overflows & Delimiter Lookahead
- **The Issue**: Local on-device models (audio, embedding, translation) have strict context limits (e.g. 500 phoneme tokens / 256-512 tokens). Splitting text by simple punctuation-plus-whitespace (`/\s/.test(nextChar)`) fails when punctuation is followed by closing quotes (`?”`), parentheses (`)`), brackets (`]`), footnotes (`[^1]`), or markdown formatting (`**`, `==`), merging entire paragraphs into monster chunks that overflow model context windows and stall inference.
- **The Solution**: 
  1. Tokenizers must look past all closing delimiters (`['"’”\)\]\}\*_~]`) before checking for whitespace boundaries.
  2. Implement a **Hard-Ceiling Clause Fallback**: split run-on sentences exceeding $\sim 300\text{--}350$ characters at natural clause boundaries (semicolons, colons, em-dashes, commas), guaranteeing the model never exceeds its context window.

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

### Trap 9: The CPU WASM Fallback Trap (Why CPU Inference Freezes Electron)
- **The Issue**: In theory, running small neural models (e.g. 50-100M parameter models) on CPU WASM seems like a solid universal fallback. In practice, inside Obsidian's Electron sandbox:
  1. Spawning WASM SIMD threads (`SharedArrayBuffer` workers) causes severe thread contention with Electron's UI/renderer thread pool and audio scheduling.
  2. On Apple Silicon (macOS unified memory), CPU SIMD lacks direct access to the GPU/Neural Engine, resulting in $\ge 15\times$ slower token generation than WebGPU.
  3. Even at low compute loads, CPU tensor passes monopolize execution cores, causing UI input freezes, audio buffer starvation (crackling/stuttering), and system lag. Dynamic CPU core heuristics fail to resolve this because Electron shares thread scheduling with the UI.
- **The Solution**:
  1. **WebGPU is mandatory for real-time, interactive local inference** (TTS, live transcription, real-time embeddings).
  2. Treat CPU WASM strictly as a non-real-time offline fallback for asynchronous batch processing (e.g. background file export) where processing occurs decoupled from the active UI.
  *See [references/electron-sandbox-rules.md](./references/electron-sandbox-rules.md).*

---

### Trap 10: CodeMirror Mutation Thrashing & The Catastrophic `normalize()` Freeze
- **The Issue**: When attempting fallback DOM highlighting (e.g. wrapping text nodes in temporary `<span>` tags via `range.surroundContents(span)`), developers frequently clean up elements by calling `parent.normalize()`.
  In Obsidian's Reading View and Live Preview (CodeMirror 6), calling `.normalize()` directly mutates CodeMirror's internally managed Text nodes. CodeMirror's DOM MutationObservers intercept this and trigger synchronous layout re-computations and document re-parsing on every word update (every 50-100ms).
  This throws the Electron renderer into an infinite layout thrash loop, causing the **entire Obsidian application window to freeze completely**.
- **The Solution**:
  1. **NEVER call `normalize()` or `surroundContents()`** on DOM elements inside Obsidian view containers (`.markdown-reading-view`, `.cm-content`).
  2. **Exclusively use the CSS Custom Highlight API (`CSS.highlights`)**: it operates entirely on the browser's compositing layer, leaving the DOM tree untouched with zero CodeMirror mutations.
  3. If CSS Custom Highlight is unsupported, gracefully skip inline visual tracking rather than risking destructive DOM mutations that can lock up the user's workspace.
  *See [references/css-highlight-api.md](./references/css-highlight-api.md).*

---

### Trap 11: WebGPU Unmanaged VRAM Heap Leaks & The Throttled Cooperative GC Pattern
- **The Issue**: V8's garbage collector only monitors small JavaScript object wrappers (tens of bytes) and has zero awareness of multi-megabyte native GPU buffers (`GPUBuffer`, unmanaged C++ driver arenas). In iterative inference (TTS, Whisper, token streaming), dangling tensors accumulate in driver memory without triggering V8 GC, causing RAM/VRAM to escalate rapidly into gigabytes and crashing the application.
  Conversely, calling full synchronous garbage collection (`gc()`) on every single inference cycle blocks the JS thread for 50-150ms, starving WebAudio timers and producing severe memory pressure sawtooth spikes.
- **The Solution**:
  1. **Explicit Input/Intermediate Tensor Disposal**: Always intercept execution to invoke `.dispose()` on input tensors (`tensor.dispose()`) immediately after inference.
  2. **Safe Dynamic Electron GC Activation**: Enable V8's GC in Electron via Node integration:
     ```typescript
     v8.setFlagsFromString("--expose_gc");
     const gcFn = vm.runInNewContext("gc");
     ```
  3. **Debounced & Idle Sweep Scheduling**: NEVER run synchronous GC per-inference cycle. Throttle sweeps to idle frames (`requestIdleCallback`) or natural transition boundaries (pause, stop, batch completion) to maintain flat, steady memory curves with zero UI/audio lag.
  *See [references/webgpu-memory-lifecycle.md](./references/webgpu-memory-lifecycle.md).*

---

### Trap 12: Half-Precision (`fp16`) Shader Hazards in WebGPU Vocoders & Normalization Heads
- **The Issue**: While `fp16` accelerates matrix multiplications on compatible GPUs, transformer vocoders and normalization blocks (AdaIN, LayerNorm, RMSNorm) compute variance sums that exceed half-precision limits ($65,504$). Under Chromium's WGSL/WebGPU implementation, this produces numerical overflow (`NaN`/`+Inf`), resulting in heavily distorted, robotic, or cracked audio.
- **The Solution**:
  1. **Force `fp32` on WebGPU for Generative Audio**: Small models (50-100M parameters) occupy only $\sim 300\text{MB}$ in `fp32`—modern GPUs execute this effortlessly with studio-quality acoustics.
  2. **Audio Sample Conditioning**: Clamp raw output PCM samples to `[-1.0, 1.0]` and apply a 3ms micro fade-in/fade-out to prevent DAC clipping and boundary click transients.
  *See [references/webgpu-memory-lifecycle.md](./references/webgpu-memory-lifecycle.md) and [references/webaudio-resampling.md](./references/webaudio-resampling.md).*

---

### Trap 13: Release Asset Tampering Warnings & Missing GitHub Artifact Attestations
- **The Issue**: When publishing Obsidian releases, Obsidian's automated reviewer checks whether release assets (`main.js`, `manifest.json`, `styles.css`) have verified build provenance. If release files are built locally on a developer machine and attached manually via `gh release create` or web upload, the scanner flags:
  `Warning: Missing GitHub artifact attestations for release assets: main.js, styles.css`.
- **The Solution**:
  1. Never manually upload release binaries.
  2. Implement an automated GitHub Actions release workflow triggered on Git tag push (`tags: ['*']`) with `id-token: write` and `attestations: write` permissions.
  3. Use `actions/attest-build-provenance@v2` immediately after building the production bundle.
  4. Always verify the published assets via `gh attestation verify main.js -R <owner>/<repo>`.
  *See [references/github-cryptographic-release-pipeline.md](./references/github-cryptographic-release-pipeline.md).*

---

## 📁 Skill Reference Index

- [Obsidian Community Release Checklist](./references/obsidian-community-release-checklist.md) — Comprehensive guide to passing automated review audits and adhering to official plugin guidelines.
- [GitHub Cryptographic Release Pipeline](./references/github-cryptographic-release-pipeline.md) — Complete protocol for Sigstore artifact attestations and automated tag-based releases.
- [WebGPU Memory Lifecycle & Pipelining](./references/webgpu-memory-lifecycle.md) — Complete guide to zero-leak WebGPU inference, cooperative V8 GC, and sliding lookahead queues.
- [esbuild WASM Patching Guide](./references/esbuild-wasm-patching.md) — Exact AST/regex replacers for local WASM in Electron.
- [Electron Sandbox Rules](./references/electron-sandbox-rules.md) — Permissions, renderer flags, Direct Filesystem disclosures, and In-Settings Asset Downloaders.
- [WebAudio Resampling & Audio Graph](./references/webaudio-resampling.md) — DAC synchronization, sample conditioning, and gapless playback.
- [CSS Custom Highlight API](./references/css-highlight-api.md) — Zero-mutation text tracking implementation.
- [esbuild.config.template.mjs](./examples/esbuild.config.template.mjs) — Complete boilerplate build script for Obsidian + ONNX plugins.

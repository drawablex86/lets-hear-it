# Reference: Electron Sandbox & Obsidian Plugin Environment Rules

Obsidian plugins run in a hybrid environment where Chromium's renderer process has partial access to Node.js built-ins (`fs`, `path`), but executes pages under origin-restricted schemes (`app://obsidian.md` or `file://`).

To ensure neural libraries behave properly, apply the following environment configurations.

---

## 1. Renderer Flag Initialization

Many JavaScript AI libraries (Transformers.js, ONNX Runtime Web, TensorFlow.js) detect the environment via `process`:
- If `typeof process !== "undefined"` and `process.versions.node` exists, they may assume they are running in Node CLI.
- This leads them to use Node native workers (`worker_threads`) or attempt loading `.node` C++ native addons rather than WASM / WebGPU.

**Best Practice:** In your plugin's `onload()` lifecycle hook, explicitly set the renderer flag before importing model code:

```typescript
// src/main.ts
async onload() {
  if (typeof process !== "undefined" && !process.type) {
    process.type = "renderer";
  }

  // Ensure require is available globally for Emscripten glue scripts
  if (typeof window !== "undefined" && typeof require !== "undefined") {
    (window as any).require = require;
    (globalThis as any).require = require;
  }
}
```

---

## 2. Configuring Local WASM Paths at Runtime

Instead of letting libraries download multi-megabyte WASM files from public CDNs on each run, resolve them relative to the plugin's vault directory.

```typescript
import { FileSystemAdapter } from "obsidian";
import * as ort from "onnxruntime-web";

function configureLocalWasmDirectory(plugin: Plugin) {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return;

  // Resolve absolute path to plugin folder: <Vault>/.obsidian/plugins/<plugin-id>/
  const pluginDirPath = adapter.getFullPath(plugin.manifest.dir ?? "");
  
  // Configure ONNX wasmPaths to point to local files
  ort.env.wasm.wasmPaths = {
    "ort-wasm-simd-threaded.wasm": `${pluginDirPath}/ort-wasm-simd-threaded.wasm`,
    "ort-wasm-simd-threaded.mjs": `${pluginDirPath}/ort-wasm-simd-threaded.mjs`,
    "ort-wasm-simd-threaded.jsep.wasm": `${pluginDirPath}/ort-wasm-simd-threaded.jsep.wasm`,
    "ort-wasm-simd-threaded.jsep.mjs": `${pluginDirPath}/ort-wasm-simd-threaded.jsep.mjs`,
  };

  // Optional: Read the wasm binary directly into memory for instant startup
  try {
    const fs = require("fs");
    const wasmFile = `${pluginDirPath}/ort-wasm-simd-threaded.wasm`;
    if (fs.existsSync(wasmFile)) {
      const buffer = fs.readFileSync(wasmFile);
      ort.env.wasm.wasmBinary = new Uint8Array(buffer);
    }
  } catch (err) {
    console.warn("Could not pre-load WASM binary into memory:", err);
  }
}
```

---

## 3. WebGPU vs. WASM Fallback

WebGPU provides 3x-10x speedups for local model execution in Obsidian (available in modern Electron builds on macOS/Windows/Linux).

Always configure engine execution providers to try WebGPU first, then gracefully fall back to WASM SIMD:

```typescript
// Prefer WebGPU, gracefully fall back to WASM
const executionProviders = [
  { name: "webgpu", deviceType: "default" },
  { name: "wasm", numThreads: 4, simd: true }
];
```

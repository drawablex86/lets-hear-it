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
  const electronProc = typeof process !== "undefined" ? (process as unknown as { type?: string }) : undefined;
  if (electronProc && !electronProc.type) {
    electronProc.type = "renderer";
  }

  // Ensure require is available on window for Emscripten glue scripts (avoid globalThis to pass Obsidian ESLint)
  if (typeof window !== "undefined" && typeof require !== "undefined") {
    (window as unknown as { require?: typeof require }).require = require;
  }
}
```

> [!IMPORTANT] Direct Filesystem Access Disclosure Required in README.md
> If your plugin accesses Node's `fs` or `path` modules outside the Obsidian Vault API (`app.vault`), Obsidian's review bot will flag:
> `Direct Filesystem Access: Uses the Node.js fs module to access the filesystem outside of the Obsidian vault API.`
> To pass automated & human review, you MUST include a dedicated section in `README.md` (e.g. under **Network & Privacy Disclosures**) explaining exactly why direct filesystem access is used (e.g., loading local in-memory WASM runtimes from the plugin directory without cloud roundtrips).

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

---

## 4. Community Directory Distribution & CDN Fallback

Obsidian's official Community Plugin installer only downloads **three files**:
- `main.js`
- `manifest.json`
- `styles.css`

It does **not** copy `.wasm`, `.mjs`, or model asset weights when users install or update the plugin through Obsidian's settings UI.

**Required Architectural Pattern:**
Always implement an automatic fallback to a pinned public CDN (e.g. jsDelivr) if the local `.wasm` files do not exist in the plugin directory:

```typescript
const wasmLocalFile = path.join(pluginDirPath, "ort-wasm-simd-threaded.jsep.wasm");
if (fs.existsSync(wasmLocalFile)) {
  // 1. Fast local execution from disk
  ort.env.wasm.wasmBinary = new Uint8Array(fs.readFileSync(wasmLocalFile));
} else {
  // 2. Fresh Community Directory install fallback
  const cdnFallback = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
  ort.env.wasm.wasmPaths = cdnFallback;
}
```
This guarantees zero crashes when newly installed from the Obsidian Community Marketplace.

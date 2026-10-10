# let's hear it 🎧
> **Local, private, neural text-to-speech for Obsidian notes.**  
> Powered by [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) & ONNX Runtime Web. Zero API keys, zero cloud latency, zero external servers.

---

## Features

- 🧠 **100% Local Neural TTS**: Runs directly inside Obsidian using ONNX Runtime WebAssembly SIMD and WebGPU. Your notes never leave your machine.
- 🗣️ **28 Distinct Neural Voices**: American and British male/female voices with varied accents, styles, and tones (e.g. Heart, Bella, Nicole, Michael, Emma, George).
- ⚡ **Chunked Sentence Pipeline**: Instant playback start! Sentences are cleaned, split, and pre-buffered in the background so you never wait for an entire document to synthesize.
- 🎛️ **Floating Audio Player**: Sleek, non-intrusive floating control bar with play/pause, restart, speed control (`0.75x` - `2.0x`), quick voice selector, and progress indicators.
- 🎨 **Real-Time Word Highlighting**: Uses the modern, non-destructive **CSS Custom Highlight API** to highlight words and sentences as they are spoken without modifying note content or DOM elements.
- 🧹 **Intelligent Markdown Cleaner**: Strips YAML frontmatter, code blocks, URLs, HTML tags, Obsidian wiki links, callout tags, and math notation, converting notes into clean, natural-sounding prose.

---

## Architecture Overview

```
                      ┌────────────────────────┐
                      │   Obsidian Markdown    │
                      │         Note           │
                      └───────────┬────────────┘
                                  │
                                  ▼
                      ┌────────────────────────┐
                      │    Markdown Cleaner    │
                      │  (src/engine/cleaner)  │
                      └───────────┬────────────┘
                                  │ Sentence Chunks & Ranges
                                  ▼
                      ┌────────────────────────┐
                      │       TTS Engine       │
                      │ (src/engine/ttsEngine) │
                      └─────┬────────────┬─────┘
                            │            │
            Audio Buffering │            │ Word & Sentence
               & Synthesis  │            │ Timing Events
                            ▼            ▼
         ┌─────────────────────┐   ┌─────────────────────┐
         │ KokoroTTS (ONNX)    │   │  Word Highlighter   │
         │ - WASM SIMD / WebGPU│   │(CSS Highlight API)  │
         │ - 24kHz PCM Output  │   └─────────────────────┘
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │ WebAudio Pipeline   │
         │ - AudioContext DAC  │
         │ - SourceNode Buffer │
         │ - Floating Player UI│
         └─────────────────────┘
```

### Core Components

1. **`src/engine/cleaner.ts` (Markdown Parser & Boundary Chunker)**:
   - Sanitizes raw markdown text into readable English speech.
   - Detects sentence boundaries while preserving character offsets into the editor document for accurate word-level highlighting.
   - Converts dates, numbers, currencies, and technical punctuation into spoken words.

2. **`src/engine/ttsEngine.ts` (Neural Synthesis & Streaming)**:
   - Manages model lifecycle (`KokoroTTS.from_pretrained`), memory-mapped WASM binaries, and voice embedding vectors.
   - Handles background pre-buffering (fetching 2–3 upcoming sentences ahead of current playback).
   - Generates 24kHz single-channel float PCM audio and feeds it into the WebAudio graph.
   - Dispatches state updates, duration tracking, and sentence boundaries.

3. **`src/ui/highlighter.ts` (Non-destructive Word Highlighter)**:
   - Uses the browser's native `CSS.highlights` (`Highlight` API) when supported.
   - Creates document ranges mapped to editor tokens, avoiding DOM mutations or editor disruptions.
   - Falls back gracefully if CSS highlights are unsupported.

4. **`src/ui/player.ts` & `src/settings.ts` (UI & User Configuration)**:
   - Floating widget attached to the active Obsidian workspace.
   - Persistent settings tab allowing selection of default voice and playback speed.
   - Quick-switch dropdowns directly on the floating player bar for on-the-fly adjustment.

---

## Electron & Chromium Origin Solutions

Because Obsidian runs inside an Electron environment with strict sandbox origin policies (`app://` or `file://` protocols):
1. **ESM Dynamic Import Isolation**: Modern ONNX Runtime WebAssembly scripts utilize ES modules (`.mjs`). Directly importing `file://` URLs in Electron workers is blocked by Chromium CORS/protocol policies.
2. **In-Memory Base64 Data URL ESM Loader**: Custom esbuild transforms (`esbuild.config.mjs`) intercept dynamic imports and convert local `.mjs` code into `data:text/javascript;base64,...` modules.
3. **In-Memory WASM Binary Injection**: Instead of network fetches, `TTSEngine.configureWasmPaths()` loads the ONNX runtime `.wasm` binary into an in-memory `Uint8Array` buffer and passes it directly to `ort.env.wasm.wasmBinary`.
4. **Natural Hardware Audio Resampling**: Instead of locking `AudioContext` to a forced sample rate (which causes macOS CoreAudio buffer clicks and crackles), WebAudio runs at native hardware rate (44.1kHz/48kHz) and dynamically upsamples Kokoro's 24kHz PCM without audio artifacts.

---

## Automated Testing Suite

The repository includes a standalone headless simulation test runner: [`test-obsidian-simulator.mjs`](file:///Users/rahulrajeev/Downloads/lets-hear-it/test-obsidian-simulator.mjs).

### Testing Paradigms

- **Headless Obsidian Environment Simulation**: Mocks Obsidian's `Plugin`, `SettingTab`, `Notice`, `addIcon`, and DOM APIs without requiring manual desktop launch.
- **WebAudio & PCM Buffer Verification**: Tests `AudioContext` initialization, audio buffer construction, duration calculations, and verifies that synthesized samples contain **0 NaN values** and valid dynamic amplitude.
- **Neural Model Inference**: Validates that Kokoro-82M loads under WASM/WebGPU, resolves voice embeddings, and produces intelligible speech audio.
- **Lifecycle & Replay Verification**: Simulates player interactions, verifying that clicking play when finished or idle properly restarts note playback.

### Running the Tests

```bash
# Run automated simulation test suite
node test-obsidian-simulator.mjs
```

---

## Installation & Development

### Prerequisites
- Node.js >= 18
- npm

### Installation
```bash
# 1. Clone repository
git clone https://github.com/your-username/lets-hear-it.git
cd lets-hear-it

# 2. Install dependencies
npm install

# 3. Build production bundle (outputs to root and v0/)
npm run build
```

### Manual Installation into Obsidian Vault
1. Copy the contents of the `v0/` directory into your Obsidian vault:
   `<VaultPath>/.obsidian/plugins/lets-hear-it/`
2. In Obsidian: Go to **Settings** > **Community plugins** > Enable **let's hear it**.
3. Open any markdown note and click the **Ear icon** in the left ribbon or run the command: `let's hear it: Read current note`.

---

## License
MIT License.

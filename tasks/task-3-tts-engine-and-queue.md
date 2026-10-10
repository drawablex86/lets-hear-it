# Task 3: Zero-Setup Kokoro Engine & Queue

## Objectives
Implement the `TTSEngine` in `src/engine/ttsEngine.ts` that runs Kokoro-82M locally inside Obsidian's JS/Electron context with WebGPU / WASM fallback, download progress tracking, and an asynchronous audio queue for sub-200ms initial response.

## Checklist
- [ ] Implement `TTSEngine` initialization:
  - Model: `onnx-community/Kokoro-82M-v1.0-ONNX`.
  - Dtype: `q4f16` (~150MB).
  - Hardware backend: prioritize `"webgpu"`, gracefully fallback to `"wasm"`.
  - Progress callback reporting download percentage via Obsidian `Notice` (`"Downloading voice model for first run (45%)..."`).
  - Cache / singleton instance to avoid reloading weights across playback sessions.
- [ ] Sentence Audio Generation:
  - Synthesize sentence text to PCM / `AudioBuffer`.
  - Extract audio duration and sample rate.
- [ ] Queueing & Pre-buffering Pipeline:
  - Receive array of sanitized sentences.
  - Synthesize sentence 0 immediately and start playback without waiting for later sentences.
  - Concurrently pre-fetch sentence 1, sentence 2, etc., in background queue.
  - Seamlessly transition playback between sentence buffers without audible gaps.
- [ ] Playback State Management:
  - WebAudio `AudioContext` management.
  - Play, pause, resume, stop methods.
  - Dynamic speed adjustment (`playbackRate.value`) across active and queued buffers.
  - Events / callbacks for: `onSentenceStart`, `onSentenceEnd`, `onTimeUpdate`, `onStateChange`, `onError`.

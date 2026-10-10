# Agent Instructions & Execution Plan: "let's hear it"

## Overview
"let's hear it" is a zero-setup local neural text-to-speech (TTS) Obsidian plugin utilizing `kokoro-js` (`onnx-community/Kokoro-82M-v1.0-ONNX`, dtype: `q4f16`), WebAudio API, ONNX Runtime Web, and CSS Custom Highlight API for live word tracking.

---

## Task Index & Status

Each task is documented in a dedicated markdown specification file under `tasks/` with granular step-by-step checkboxes.

- [x] [tasks/task-1-project-setup.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-1-project-setup.md) — **Task 1: Project Setup & Config** (`package.json`, `esbuild.config.mjs`, `manifest.json`, `tsconfig.json`)
- [x] [tasks/task-2-ribbon-and-commands.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-2-ribbon-and-commands.md) — **Task 2: Custom Ribbon Icon & Command Registration** (`src/ui/icons.ts`, `src/main.ts`)
- [x] [tasks/task-3-tts-engine-and-queue.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-3-tts-engine-and-queue.md) — **Task 3: Zero-Setup Kokoro Engine & Queue** (`src/engine/ttsEngine.ts`)
- [x] [tasks/task-4-markdown-cleaner.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-4-markdown-cleaner.md) — **Task 4: Markdown Cleaner & Sentence Segmenter** (`src/engine/cleaner.ts`)
- [x] [tasks/task-5-floating-player-ui.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-5-floating-player-ui.md) — **Task 5: Floating Audio Player UI** (`src/ui/player.ts`, `styles.css`)
- [ ] [tasks/task-6-synchronized-word-tracker.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-6-synchronized-word-tracker.md) — **Task 6: Synchronized Word Tracker** (`src/ui/highlighter.ts`, `styles.css`)
- [ ] [tasks/task-7-verification-and-integration.md](file:///Users/rahulrajeev/Downloads/lets-hear-it/tasks/task-7-verification-and-integration.md) — **Task 7: Build Verification & End-to-End Integration**

---

## Operating Guidelines
1. **No Auto-Processing:** Do not auto-proceed across tasks without discrete user confirmation or check-in.
2. **Atomic Commits:** Commit work to git upon completion of each task.
3. **Verification First:** Validate code compilation (`npm run build` / type checking) before marking tasks complete.

# Task 1: Project Setup & Config

## Objectives
Set up the build tooling, Obsidian plugin manifest, TypeScript configuration, and dependency graph for `lets-hear-it`. Ensure `onnxruntime-web` WASM files are properly bundled/copied into the output distribution directory.

## Checklist
- [x] Initialize `manifest.json`:
  - `id`: `lets-hear-it`
  - `name`: `let's hear it`
  - `version`: `1.0.0`
  - `minAppVersion`: `1.0.0`
  - `description`: `Zero-setup local neural text-to-speech with live word tracking.`
  - `isDesktopOnly`: `true`
- [x] Initialize `package.json` with dependencies:
  - `obsidian`
  - `kokoro-js`
  - `onnxruntime-web`
  - Dev dependencies: `typescript`, `esbuild`, `@types/node`, etc.
- [x] Create `tsconfig.json` for Obsidian plugin development (target ES2022/ESNext, module ESNext, bundler module resolution).
- [x] Create `esbuild.config.mjs`:
  - Output single bundle `main.js`.
  - Externalize `obsidian`, `electron`, Node built-ins.
  - Setup asset copy plugin or script to copy `onnxruntime-web` `.wasm` binaries directly to plugin output directory.
- [x] Install dependencies via npm.
- [x] Verify initial build step (`npm run build`).

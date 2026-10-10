# Task 7: Build Verification & End-to-End Integration

## Objectives
Perform end-to-end integration across all components, compile the production bundle, inspect generated assets, verify WASM distribution, and validate against all user criteria.

## Checklist
- [ ] Run `npm run build` with zero TypeScript or bundling errors.
- [ ] Verify output directory contains:
  - `main.js`
  - `manifest.json`
  - `styles.css`
  - `ort-wasm-simd-threaded.wasm` / `ort-wasm*.wasm` binaries.
- [ ] Verify zero external CLI dependencies (no Python, no espeak).
- [ ] Verify model download progress notice mechanism.
- [ ] Verify AudioContext resume triggers on user gestures.
- [ ] Verify CSS Highlight API definitions and styling.
- [ ] Final git commit for release readiness.

# Task 5: Floating Audio Player UI

## Objectives
Implement the floating audio player docked at the bottom-right of active Markdown views in `src/ui/player.ts` with controls for Play, Pause, Stop, Speed adjustment, and status feedback, styled cleanly in `styles.css`.

## Checklist
- [x] Implement `FloatingPlayer` in `src/ui/player.ts`:
  - Mount cleanly to the active Markdown leaf / view container without breaking layout.
  - Buttons: Play/Pause toggle with icon/label, Stop button.
  - Speed selector dropdown (`0.75x`, `1.0x`, `1.25x`, `1.5x`, `2.0x`).
  - Status indicator (e.g. `"Downloading model..."`, `"Buffering..."`, `"Reading..."`, `"Paused"`, `"Finished"`).
  - Sentence progress indicator (e.g., `Sentence 2 / 14`).
  - Close / minimize handle.
- [x] Event Wiring:
  - Connect Play/Pause/Stop to `TTSEngine` actions.
  - Connect Speed change to `TTSEngine.setPlaybackRate()`.
  - Handle view switching / tab closing to auto-detach or persist player appropriately.
- [x] CSS Styling in `styles.css`:
  - Obsidian theme-adaptive styling using native css variables (`--background-primary`, `--text-normal`, `--interactive-accent`, etc.).
  - Bottom-right fixed floating layout with shadow and smooth transitions.

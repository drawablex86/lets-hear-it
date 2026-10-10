# Task 2: Custom Ribbon Icon & Command Registration

## Objectives
Implement the ear-shaped SVG icon and wire up the main plugin lifecycle, ribbon icon, and Obsidian commands in `src/main.ts`.

## Checklist
- [ ] Create `src/ui/icons.ts`:
  - Export `EAR_ICON_ID = 'ear-icon'`.
  - Export `EAR_ICON_SVG`:
    ```xml
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10.5" />
      <path d="M10 12a2.5 2.5 0 0 0 5 0" />
    </svg>
    ```
- [ ] Implement `LetsHearItPlugin` in `src/main.ts`:
  - Register custom icon via `addIcon(EAR_ICON_ID, EAR_ICON_SVG)`.
  - Add ribbon icon: `this.addRibbonIcon(EAR_ICON_ID, "let's hear it", () => this.togglePlayback())`.
  - Explicitly invoke `audioContext.resume()` on ribbon click / command execution to comply with Chromium autoplay policy.
  - Register command: `"let's hear it: Read current note"` (`readCurrentNote`).
  - Register command: `"let's hear it: Stop reading"` (`stopReading`).
- [ ] Wire cleanup on plugin `onunload()` (stop audio context, detach UI, clean highlight state).

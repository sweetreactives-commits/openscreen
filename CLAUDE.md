# OpenScreen

Free, open-source screen recorder / demo editor — an alternative to Screen Studio. Cross-platform desktop app (macOS, Windows, Linux) built with Electron + React.

- **Version:** 1.5.0 · **License:** MIT
- **Primary dev machine here:** Windows (`C:\workfolder\OpenScreen`)

## Tech stack

- **Runtime:** Electron 41, Node **22.22.1** (pinned via `.nvmrc` + `engines`), npm **10.9.4**
- **Frontend:** React 18 + TypeScript 5.9, Vite 7 (`vite-plugin-electron`)
- **UI:** Tailwind CSS 3 + Radix UI primitives + shadcn-style components (`components.json`), lucide/react-icons, motion/gsap for animation
- **Canvas / media:** PixiJS 8 (+ filters) for the editor canvas, mediabunny / mp4box / web-demuxer for video, gif.js for GIF export, `@xenova/transformers` for on-device captions
- **Lint/format:** **Biome** (not ESLint/Prettier) — `biome.json`
- **Tests:** Vitest (unit + browser), Playwright (e2e), fast-check (property tests)
- **Git hooks:** Husky + lint-staged (Biome on staged files)

## Common commands

```bash
npm run dev          # Vite dev server + Electron
npm run build        # tsc + vite build + electron-builder (current OS)
npm run build:win    # Windows build (builds native WGC helper first)
npm run lint         # biome check .
npm run lint:fix     # biome check --write .
npm run format       # biome format --write .
npm test             # vitest --run (unit)
npm run test:browser # vitest browser config
npm run test:e2e     # playwright
npm run i18n:check   # verify translation completeness
```

Windows-native capture (Windows Graphics Capture) test helpers live under `test:wgc-*:win` scripts.

## Architecture

Electron two-process split:

- **`electron/`** — main process (Node side)
  - `main.ts` — app entry, window lifecycle
  - `ipc/` — IPC handlers (main ↔ renderer bridge); `preload.ts` exposes the API
  - `recording/` — capture pipeline
  - `native/`, `native-bridge/` — native OS capture: **ScreenCaptureKit** (macOS), **Windows Graphics Capture / WGC** (Windows). Native helpers are built by `scripts/build-*-helper.mjs`
  - `globalShortcut.ts`, `windows.ts`, `i18n.ts`
- **`src/`** — renderer (React app)
  - `App.tsx` / `main.tsx` — entry
  - `components/` — UI (editor, timeline, panels)
  - `contexts/`, `hooks/`, `lib/`, `utils/` — state and logic
  - `native/` — renderer-side native interop
  - `i18n/` — 13 languages (Arabic, English, Spanish, French, Italian, Japanese, Korean, Portuguese-BR, Russian, Turkish, Vietnamese, zh-Hans, zh-Hant)
- **`dist-electron/`** — build output (`main.js` is the packaged entry); do not edit by hand
- **`docs/`** — `architecture/`, `engineering/`, `testing/` notes worth checking before deep changes

### Platform note on capture
The editor/export is identical across OSes. Differences are only in **capture**: macOS/Windows use a native high-quality pipeline with real cursor capture; Linux falls back to the browser pipeline (cursor position only, no cursor themes/click effects). Keep this in mind when touching recording code.

## Conventions

- Format & lint with **Biome** — tabs for indentation (see `.editorconfig`), run `npm run lint:fix` before committing.
- TypeScript strict; keep the main/renderer boundary clean — cross-process calls go through IPC (`electron/ipc` + `preload.ts`), never import main-process modules directly into `src/`.
- When adding user-facing strings, update all locales and run `npm run i18n:check`.
- Native capture changes should be validated with the relevant `test:wgc-*:win` (Windows) or ScreenCaptureKit helper scripts.

> Note: upstream README marks the original repo as archived in favor of a community fork. This local copy is the working project.

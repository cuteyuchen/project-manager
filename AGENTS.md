# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Cross-platform project management desktop app for managing projects, Git repos, Node.js versions, and system integration. Built as a **Tauri v2** desktop app with **Vue 3 + TypeScript** frontend. Also ships as **uTools** and **ZTools** launcher plugins.

## Common Commands

```bash
# Development
npm run dev              # Vite dev server (port 1420, frontend only)
npm run tauri dev        # Full Tauri desktop dev (frontend + Rust backend)
npm run build            # Type-check (vue-tsc) + Vite production build
npm run tauri build      # Build Tauri desktop app for production

# Plugin builds
npm run build:utools     # Build for uTools plugin (dist-utools/)
npm run build:ztools     # Build for ZTools plugin (dist-ztools/)

# Release
npm run bump <version>       # Bump versions across all files + git tag + ZTools publish
npm run bump:version <version>  # Version bump + git tag only (no publish)

# Tests (no test framework, standalone TS files)
npx tsx tests/<file>.test.ts
```

## Architecture

### Multi-Target Deployment

Three deployment targets share one frontend codebase, selected via `VITE_TARGET` env var:

| Target | Build Mode | Output | Adapter |
|---|---|---|---|
| Tauri desktop | default | `dist/` | `TauriAdapter` (invoke → Rust) |
| uTools plugin | `utools` | `dist-utools/` | `UToolsAdapter` (window.services) |
| ZTools plugin | `ztools` | `dist-ztools/` | `UToolsAdapter` (window.services) |

### Platform API Abstraction

The core pattern: `src/api/types.ts` defines the `PlatformAPI` interface (~140 methods). Two adapters implement it:
- `src/api/adapters/tauri.ts` — calls Rust via Tauri `invoke()`
- `src/api/adapters/utools.ts` — delegates to `window.services` (uTools/ZTools runtime)

`src/api/index.ts` selects the adapter at runtime based on `VITE_TARGET`.

### Rust Backend (`src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `lib.rs` | App builder, plugin registration, command handler registration |
| `git.rs` | Git operations via `std::process::Command` (~48K, largest module) |
| `runner.rs` | Command/project execution, process management, terminal/editor launching |
| `system.rs` | Platform info, terminal detection, port listing, context menu, process kill |
| `project.rs` | Project scanning (package.json, lockfiles, .nvmrc detection) |
| `nvm.rs` | NVM list/install/uninstall/use operations |
| `updater.rs` | Auto-update download and install |

### Frontend State (Pinia Stores in `src/stores/`)

- `project.ts` — project list, running state, logs (buffered flushing), command execution
- `git.ts` — git status, history, branches, diffs; TTL cache + request deduplication + cold storage mode
- `node.ts` — NVM node versions, system node detection
- `settings.ts` — editors, terminals, theme, locale, AI config, layout state

### Data Persistence

All user data persists to `data.json` via the Rust backend's `readConfigFile`/`writeConfigFile`. The persistence layer (`src/utils/persistence.ts`) uses debounced saves with `requestIdleCallback`.

### Key Large Files

- `src/App.vue` (~27K) — root component, main app shell
- `src/views/Settings.vue` (~50K) — settings page
- `src/views/Dashboard.vue` (~34K) — project list + workspace
- `src/components/FileManager.vue` (~48K) — file manager
- `src-tauri/src/git.rs` (~48K) — Git backend implementation

## Tech Stack

- **Frontend**: Vue 3 (Composition API, `<script setup>`), TypeScript (strict), Vite 6, Element Plus, UnoCSS, Pinia 3, vue-i18n 9 (zh primary, en secondary)
- **Backend**: Tauri v2, Rust 2021
- **Key deps**: diff2html (diff rendering), marked (markdown), pinyin-pro (Chinese search), ansi_up (console ANSI), reqwest (Rust HTTP)
- **Crate registry**: rsproxy.cn mirror (configured in `.cargo/config.toml`)
- **Window**: Frameless with custom title bar (`decorations: false` in tauri.conf.json)

## Version Bump

Version numbers live in 7+ files: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `utools/plugin.json`, `utools/preload.js`, `ztools/plugin.json`, `ztools/preload.js`. Use `npm run bump <version>` to update all at once.

## CI/CD

GitHub Actions (`.github/workflows/release.yml`) triggers on `v*` tags and builds for Windows (NSIS), Ubuntu (deb + appimage), macOS arm64 (dmg), macOS x86_64 (dmg) using `tauri-apps/tauri-action@v0`.

## Notes

- No ESLint/Prettier configured
- No formal test runner — tests are standalone `.test.ts` files using raw `assert()`
- Vite dev server runs on fixed port 1420 for Tauri compatibility
- Rust commands must be registered in both `lib.rs` (tauri::generate_handler!) and exposed through the PlatformAPI interface

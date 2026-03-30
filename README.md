# Project Manager

A modern, cross-platform desktop application for managing frontend projects, Node.js versions, and Git repositories — in one unified interface. Built with Tauri v2 + Vue 3 + TypeScript.

Also available as a **uTools plugin** and **ZTools plugin**.

---

## Features

### Project Management

Manage all your frontend projects from a single sidebar. Run `npm`/`yarn`/`pnpm` scripts (`dev`, `build`, etc.) directly, with real-time console output per script.

> Screenshot placeholder

- Add projects by selecting a folder — `package.json` scripts are auto-detected
- Support for **Node.js projects** (npm/yarn/pnpm) and **general projects** (custom commands)
- **Pin** frequently used projects to the top
- Open in your preferred editor, terminal, or file manager with one click
- Pinyin search support for Chinese project names
- **Project memo**: Markdown-formatted notes for each project
- **Project files**: Associate important files/folders with projects for quick access and preview

---

### Git Management

Full Git GUI with a SourceTree-style layout, directly embedded in the project workspace.

> Screenshot placeholder — Git file status view

**File Status (Changes Tab)**

- Staged / Unstaged / Untracked file lists with visual indicators
- Stage, unstage, discard individual files or all at once
- Resizable split panes (file list | diff viewer | commit area)
- Syntax-highlighted diff view powered by diff2html

> Screenshot placeholder — Diff view

**Commit & Push**

- Write commit messages in the built-in textarea (persists across tab switches)
- One-click **Commit** or **Commit & Push** in a single action
- **AI commit message generation** using any OpenAI-compatible API (see below)

> Screenshot placeholder — Commit area

**Commit History Tab**

- Full commit graph with author, date, short hash, and branch/tag refs
- Click a commit to browse its changed files and diff
- Load more history on demand

> Screenshot placeholder — Commit history

**Branch Management**

- View local and remote branches
- Switch, create, rename, delete branches
- Tracking information (ahead/behind remote)

> Screenshot placeholder — Branch dialog

**Remote Operations**

- Pull, Push, Fetch with one click from the toolbar
- Manage remote URLs

---

### AI Commit Messages

Generate commit messages automatically from your staged diff using any OpenAI-compatible API.

> Screenshot placeholder

- Configure Base URL, API Key, and model (supports OpenAI, DeepSeek, Qwen, etc.)
- Default prompt follows **Conventional Commits** format with Chinese body
- Fully customizable prompt template
- Built-in connection test

---

### Node Version Management

> Screenshot placeholder

Manage NVM-installed Node.js versions visually:

- Install, uninstall, and switch Node.js versions
- Set the **system default** Node.js version (handles environment variables automatically)
- Detect and use the system-installed Node.js (outside NVM)
- Add custom Node.js executables

---

### Terminal & Editor Integration

- Detect available system terminals automatically (CMD, PowerShell, Git Bash, Windows Terminal, iTerm2, etc.)
- Add **custom terminal executables** from any path
- Configure your preferred code editors (supports **multiple editors**, e.g., VS Code, Cursor, WebStorm)
- Projects can **override their editor** individually; defaults to the first editor in settings
- Open projects in editor, terminal, or file manager from the project card

---

### Settings

> Screenshot placeholder

| Option | Values |
|---|---|
| Theme | Dark / Light / System |
| Language | 简体中文 / English |
| Default Terminal | Auto-detected + custom |
| Editor Path | Multiple editors, per-project override |
| Auto-update | Enabled / Disabled |
| Auto-launch | On system startup |
| Context Menu | Right-click integration (Windows) |

Data export/import for backups and migration.

---

### uTools Plugin

The app is also packaged as a **uTools plugin** (`dist-utools/`), providing the same project management and Git functionality inside the uTools launcher — without requiring a standalone window.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Core | Tauri v2, Rust |
| Frontend | Vue 3, TypeScript, Vite |
| UI | Element Plus, UnoCSS (Tailwind-compatible) |
| State | Pinia |
| i18n | vue-i18n |
| Search | pinyin-pro |
| Diff | diff2html |

---

## Getting Started

```bash
# Install dependencies
npm install

# Development (Tauri desktop)
npm run tauri dev

# Build desktop app
npm run tauri build

# Build uTools plugin
npm run build:utools
```

---

## License

[MIT](LICENSE)

---

## Changelog

### New Features
- **Multi-Editor Configuration**: Support adding multiple editors in settings; each project can independently select its editor
- **Project Memo**: Markdown-based memo for each project, supporting preview and editing
- **Project Files**: Built-in file manager panel for quickly browsing project directory structure
- **Page Transition Animations**: Apple-style smooth transitions for page and tab switching

### Optimizations
- **Tab Bar Redesign**: macOS-style segmented control replacing underline tabs
- **Dark Mode Fixes**: Fixed button and text visibility issues in dark mode
- **Unified Color Palette**: Migrated all gray colors to slate palette for consistency
- **Global Style Polish**: Optimized fonts, scrollbars, focus-visible, reduced-motion support
- **Compact Layout**: Reduced spacing and padding for more efficient screen usage
- **Git Diff Auto-Clear**: Diff view now clears automatically after committing

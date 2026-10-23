# Contributing to Haze

Issues and pull requests are welcome. Please run the checks in [Tests](#tests) before opening a PR.

## Building from source

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)
- `git` on `PATH`
- Linux only: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` (see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

For C# support:

- .NET SDK (the Roslyn Language Server requires the .NET 10 runtime)
- `dotnet tool install --global roslyn-language-server --prerelease`

### Build and run

```bash
git clone https://github.com/aprius/Haze.git
cd Haze
npm install
npm run tauri dev        # run in development mode
npm run tauri build      # build installers for the current platform
```

*Log In via GitHub…* needs a GitHub OAuth App with Device Flow enabled: build with `HAZE_GITHUB_CLIENT_ID=<client id>`. Without it, Settings offers token login only.

### Tests

```bash
npm run build && npm test                       # TypeScript typecheck + Vite build + Vitest
cd src-tauri && cargo test && cargo clippy      # Rust tests and lints
```

CI runs the same checks on Windows, macOS and Linux.

### Releasing

```bash
scripts/bump-version.sh 0.2.0           # bumps package.json, tauri.conf.json and Cargo.toml
git commit -am "Release v0.2.0"
git tag v0.2.0 && git push --follow-tags
```

A `v*` tag runs the [Release](.github/workflows/release.yml) workflow: it builds installers for macOS (universal), Windows and Linux, publishes a GitHub Release, and updates `version`/`sha256` in [Casks/haze.rb](Casks/haze.rb) on the default branch. Running the workflow manually (Actions → Release → Run workflow) only builds and uploads the installers as artifacts.

macOS builds are ad-hoc signed by default; the cask removes the quarantine flag so Gatekeeper does not block the app. To sign and notarize with an Apple Developer ID, add the secrets `APPLE_CERTIFICATE` (base64-encoded Developer ID Application `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`.

## Architecture

Haze is a [Tauri 2](https://tauri.app/) app: a Rust backend that owns the file system, Git, search, language servers and terminals, and a React frontend rendered in the system webview. They talk over Tauri IPC commands and events.

```text
┌──────────────────────── Haze window (webview) ───────────────────────┐
│  React 19 + TypeScript + zustand                                     │
│  FileTree · Monaco editor · Search · Git/Commit/Merge · xterm.js     │
│  LSP client (JSON-RPC) for C#                                        │
└───────────────┬──────────────────────────────────────────────────────┘
                │ Tauri IPC (commands + events)
┌───────────────▼────────────────── haze (Rust) ───────────────────────┐
│  fs_ops · watcher · git / git_log / git_ops · search · file_index    │
│  syntax (tree-sitter) · lsp · dotnet · agent_hooks · pty client      │
└───────┬───────────────────────┬───────────────────────┬──────────────┘
        │ stdio (LSP)           │ local socket          │ git CLI
┌───────▼─────────┐   ┌─────────▼──────────────┐   ┌────▼─────┐
│ Roslyn Language │   │ PTY host               │   │ system   │
│ Server          │   │ (haze --pty-host)      │   │ git      │
└─────────────────┘   │ shells, agents, status │   └──────────┘
                      └─────────▲──────────────┘
                                │ haze --agent-hook
                      Claude Code / Codex hooks
```

### Key design decisions

- **Out-of-process terminals.** The PTY host is the same `haze` binary started with `--pty-host`. It owns every shell (via `portable-pty`) and keeps a 4 MB replay buffer per session. The UI connects to it over a local socket (`interprocess`), so the app can close, crash or update without killing the agent. The host exits by itself 60 seconds after the last window disconnects and no shells are left running.
- **Agent status via hooks.** Claude Code and Codex hooks invoke `haze --agent-hook`, which reads `HAZE_TERMINAL_ID` and reports the agent state to the PTY host. The state is held there, so badges survive restarts.
- **Disk is the source of truth.** A `notify` watcher pushes changes to the tree, editor buffers, file index and Roslyn. Writes are atomic and preserve encoding and line endings; saves and replacements are verified against current disk content before writing.
- **System git, not libgit2.** All Git operations shell out to the user's `git`, so behavior, config, hooks and credentials match the command line. Every command is logged in the Git Console.
- **Errors from builds, not the language server.** Roslyn is used for navigation and refactoring only; diagnostics come from parsing real `dotnet build` output.

### Tech stack

| Area | Technology |
|---|---|
| App shell | Tauri 2 (Rust) |
| UI | React 19, TypeScript, zustand, Vite |
| Editor | Monaco |
| Terminal | xterm.js, `portable-pty`, `interprocess` |
| File watching | `notify` |
| Git | system `git` CLI |
| C# | Roslyn Language Server over LSP (stdio), custom JSON-RPC client |
| Search | `ignore` (ripgrep's walker), `fancy-regex`, `globset`, `nucleo-matcher`, `tree-sitter-c-sharp` |

### Project layout

```text
src/                         frontend (React)
  components/                FileTree, EditorArea, TerminalPanel, SearchEverywhere, FindInFiles,
                             CommitPanel, GitPanel, GitDialogs, DiffView, MergeView, RebaseDialog,
                             BuildPanel, UsagesPopup, FindPanel, UnityPanel, SettingsDialog, ...
  assets/jb/                 JetBrains file and folder icons (Apache 2.0)
  lib/                       ipc (Rust bindings), buffers (open files), monaco, merge, lineChanges,
                             termLinks, worktrees, keymap, theme
  lib/lsp/                   JSON-RPC client, C# session and Monaco providers
  store/                     zustand stores: workspace, tree, terminals, git, dotnet, unity, updates, ui, persist
src-tauri/src/               backend (Rust)
  main.rs, lib.rs            entry point: app, --pty-host, --agent-hook or CLI mode; Tauri commands
  cli.rs, cli_open.rs        haze agent/run/list/send/wait/read, and haze <folder> [<file>]
  state.rs                   workspace state (projects, tabs, drafts, layout)
  fs_ops.rs, text.rs         file operations, encoding-preserving read/write
  nesting.rs                 Rider-style file nesting rules
  watcher.rs                 disk change notifications
  git.rs                     git status for the file tree
  git_log.rs                 git log and branch graph lanes
  git_ops.rs                 changes, commit, rollback, branches, stash, blame, rebase, checkpoints
  git_auth.rs                GitHub / GitLab accounts, keychain tokens, credential helper
  search.rs                  Find/Replace in Files with undo
  syntax.rs                  C# comment/string ranges and declarations for Code Vision (tree-sitter)
  file_index.rs              file list and fuzzy matching for Search Everywhere
  lsp.rs                     language server process and message relay
  dotnet.rs                  solutions, projects, launch profiles, dotnet build parsing
  agent_hooks.rs             Claude Code / Codex hook install and the --agent-hook mode
  unity.rs, unity_index.rs   live link to the Unity Editor; Unity classes, event functions and asset usages
  updates.rs                 Check for Updates against the latest GitHub release
  shell_env.rs               PATH from the login shell (macOS)
  procinfo.rs                shell working directory and child-process detection for terminals
  pty/                       PTY host (host.rs), client (client.rs), wire protocol (protocol.rs)
unity/com.aprius.ide.haze/   Unity package: External Script Editor, project generation, live link
scripts/                     bump-version.sh
Casks/                       Homebrew cask (updated by the release workflow)
docs/                        screenshots
```

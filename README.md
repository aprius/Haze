<p align="center">
  <img src="assets/logo.svg" width="72" alt="Haze logo">
</p>

<h1 align="center">Haze</h1>

<p align="center">
  A lightweight, AI-first workspace for coding alongside agents like Claude Code and Codex.<br>
  Rider-style project view and Git tooling, a capable editor, and terminals that survive restarts.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-24c8db.svg" alt="Tauri 2">
</p>

![Haze](docs/screenshot.png)

## Why Haze?

When an AI agent writes most of the code, a full IDE becomes heavy and noisy, while a plain terminal is too bare. Haze sits in between. It is aimed at .NET developers used to JetBrains Rider and keeps the parts of Rider that matter most in an agent-driven workflow:

- **Review what the agent did**: Rider-style commit window, diffs, log graph, 3-way merge, AI checkpoints and per-file "reviewed" marks.
- **Navigate code quickly**: Search Everywhere, Find/Replace in Files, and C# navigation through the Roslyn Language Server.
- **Never lose a session**: shells and agents run in a separate PTY host process, so closing or updating Haze does not kill them.
- **Never overwrite the agent's work silently**: files changed on disk reload automatically, and conflicting edits are always surfaced.
- **No phantom errors**: C# errors come only from a real `dotnet build`, not from a language server that is out of sync.

> Status: early development (v0.1.0).

## Features

### Projects and file tree

- Multiple projects in a sidebar with favorites, ordering and a Welcome screen of recent projects.
- Full session restore: open projects, expanded folders, editor tabs, panel sizes and terminals.
- Lazy-loaded, virtualized file tree that updates live when files change on disk.
- Rider-like Git status colors (modified, added, untracked, ignored, conflicted), propagated to parent folders.
- Rider-style file nesting: `appsettings.Development.json` under `appsettings.json`, `Index.razor.cs` under `Index.razor`, `Strings.Designer.cs` under `Strings.resx`, and so on.
- New File/Directory (`Alt+Insert`), Rename (`Shift+F6`/`F2`), Delete to trash, Cut/Copy/Paste, drag and drop (hold `Ctrl` to copy), Copy Path, Open in Terminal, Reveal in File Manager.

### Editor (Monaco)

- Preview tabs (single click opens a temporary tab; double-click or editing pins it).
- Preserves encoding (UTF-8, UTF-8 BOM, UTF-16; legacy non-UTF-8 files are read and written as Windows-1252, and stray invalid bytes in UTF-8 files are kept, so no byte is ever lost) and line endings (LF/CRLF); writes atomically via a temp file.
- **No silent overwrites**: clean buffers reload when the agent edits the file; dirty buffers show *Load disk version* / *Overwrite with mine*; saving is blocked if the file changed on disk.
- Unsaved drafts survive app restarts.
- **Copy Context** (`Ctrl+Shift+C`): copies the selection with `path/to/File.cs:7-9` and a Markdown code fence, ready to paste into an agent.
- Rider keymap: `Ctrl+D` duplicate line, `Ctrl+Y` delete line, `Ctrl+W`/`Ctrl+Shift+W` extend/shrink selection, `Alt+J` next occurrence, `Alt+Shift+↑/↓` move line, `Alt+F1` select in Project view.
- Markdown preview and image viewer.

### Search

- **Search Everywhere** (double `Shift`) with All / Files / Symbols / Actions / Text tabs. Rider-like fuzzy matching (`ordcon` → `OrdersController.cs`), `Name.cs:12` jumps to a line. Also `Ctrl+Shift+N` Go to File, `Ctrl+Shift+A` Find Action, `Ctrl+E` Recent Files.
- **Find in Files** (`Ctrl+Shift+F`) / **Replace in Files** (`Ctrl+Shift+R`):
  - Full regex (lookaround, backreferences), `$1` / `${name}` replacements, Match case, Words, Preserve case.
  - Scopes: Project / Solution / Directory / Open Files; file masks like `*.cs, !*.Designer.cs`; skips `bin/`, `obj/`, `node_modules/` and `.gitignore`d files by default.
  - C# context filter powered by tree-sitter: anywhere, only in comments, only in string literals, or everything except those.
  - Open files are searched and replaced in their unsaved buffers (undoable); other files are written on disk with encoding, BOM and CRLF preserved.
  - Every match is re-checked before writing: files that changed since the search (for example, edited by the agent) are skipped and reported.
  - Per-match preview with checkboxes and a one-click **Undo** for the whole replace.

![Replace in Files](docs/replace-in-files.png)

### C# and .NET

- Uses Microsoft's **Roslyn Language Server** (`roslyn-language-server` .NET tool), with `csharp-ls` as a fallback. If it is missing, Haze offers a one-click **Install**.
- Rider-style navigation: `Ctrl+B`/`Ctrl+Click` Go to Definition, `Alt+F7`/`Shift+F12` Find Usages, `Ctrl+Alt+B` Go to Implementation, `Ctrl+F12` File Structure, `Shift+F6` cross-file Rename (single undo), `Alt+Enter` Roslyn quick fixes and refactorings, `Ctrl+Alt+L` format, plus hover, completion, signature help and highlights.
- `Ctrl+Click` on a declaration lists its usages, like Rider.
- **Inline completions**: as you type a name, the rest of Roslyn's best completion shows as ghost text; `Tab` accepts it, with the `using` it needs.
- **Other languages** (TypeScript/JavaScript, Python, C/C++, Go, Rust, Java, shaders…), and C# while Roslyn is still loading or not installed: `Ctrl+Click`/`Ctrl+B` and `Alt+F7` work from a fast text search of the project. The current file is checked first (so local variables resolve to the nearest declaration above), then the project; no types are resolved, so a name declared in several places shows them all.
- **Real build errors only**: `Ctrl+Shift+B` runs `dotnet build`; the Build panel lists MSBuild errors and warnings and the editor shows squiggles, which clear for a file as soon as you edit it.
- **Run bar** built from each project's `launchSettings.json` (and `dotnet test` for test projects). `Shift+F10` runs in its own terminal tab, which survives closing Haze.
- Files created, changed or deleted by the agent are reported to Roslyn (`workspace/didChangeWatchedFiles`), so navigation always reflects the latest code. Even a huge change (a branch checkout, a Unity reimport) still reports its sources; if the OS dropped file events, Roslyn reloads the projects.
- If Roslyn finds no definition (for example a new Unity script that Unity has not added to its `.csproj` yet), `Ctrl+Click` falls back to the text search. A crashed server restarts on its own (up to 3 times in a row).
- **Unity**: add the [`com.haze.ide`](unity/com.haze.ide) package (*Package Manager → Add package from git URL* → `https://github.com/aprius/Haze.git?path=/unity/com.haze.ide`) and pick Haze as External Script Editor. Unity then generates the `.sln`/`.csproj` files for Haze and opens scripts and console errors in Haze at the right line.
- Command line: `haze <folder> [<file>] [--line N] [--column N]` opens a project or file; a running Haze is reused.

![C# navigation](docs/csharp.png)

### Git

A Rider/Rebased-style Git client built on top of the system `git` CLI.

- **Commit** (`Alt+0`, `Ctrl+K`): a floating window with the changes and message beside the selected file's diff (`Ctrl+D` opens the diff in a floating window of its own); check the files to commit without staging; Changes / Unversioned Files / Merge Conflicts groups; Amend, Commit and Push, Rollback, Add to VCS, Add to `.gitignore`; Continue/Abort banner during merge or rebase.
- **Git log** (`Alt+9`): branch graph, branch/tag/remote labels, filters by text, hash, author, branch, path and first parent; commit details; a **Console** tab with every git command Haze ran.
- Commit actions: Checkout, New Branch, New Tag, Cherry-Pick, Revert, Undo Commit, Reset to Here (Soft/Mixed/Hard), **Interactive Rebase from Here** (pick / reword / edit / squash / fixup / drop, no text editor needed).
- **Branches** popup (status bar or ``Ctrl+Shift+` ``): checkout with **Smart Checkout** (auto-stash), new, merge, rebase, compare, push, rename, delete, delete remote; Fetch.
- **Push** (`Ctrl+Shift+K`) with a preview of outgoing commits and `--force-with-lease`; **Update Project** (`Ctrl+T`) via merge or rebase with auto-stash.
- **Diff** tabs in Rider style: no filler lines, curved connectors between matching blocks, scrolling kept in step block by block, word-level highlights, `F7`/`Shift+F7` to jump between changes; editable on the working-copy side, where the `>>` gutter icon reverts a block to the left side (hold `Ctrl` on a modified block to append the left lines below it instead). Annotate with Git Blame, Show History for File, Compare with HEAD.
- **Conflict resolution**: Accept Yours / Accept Theirs, or a **3-way merge view** (Yours | Result | Theirs) with non-conflicting changes pre-merged.
- **Stashes**: view, apply, pop, drop, unstash as branch, stash including untracked files.
- **AI checkpoints**: snapshot the whole working tree (including new files, without touching index or branches) before letting an agent run; *Since checkpoint* lists every file it changed, with diffs.
- **Reviewed marks** per file, cleared automatically when the file changes again.
- **GitHub / GitLab accounts** (Settings), like Rider: log in with a token (GitHub, GitHub Enterprise, GitLab.com or self-hosted GitLab; *Generate…* opens the token page with the right scopes) or *Log In via GitHub…* in the browser. Tokens are kept in the system keychain, and push/pull/fetch to that server use the account through Haze's own credential helper, ahead of any stored credential (other hosts keep your git setup). A push rejected for credentials offers *Log In…*.
- Never blocks on a password prompt (`GIT_TERMINAL_PROMPT=0`); other hosts use your credential helper or SSH agent.

![Git](docs/git.png)
![3-way merge](docs/merge.png)

### Terminal

- Shells run in a separate **PTY host** process: closing or updating Haze does not kill shells or running agents. On reopen Haze reattaches and replays recent output (4 MB per session).
- Multiple tabs, search in output (`Ctrl+F`), `Ctrl+C` copies when there is a selection. Closing a tab only asks for confirmation when a program is running in it.
- `Ctrl+Click` on paths opens the file at line/column, including MSBuild format (`Program.cs(12,5): error CS1002`) and `file:line:col`. Relative paths resolve against the shell's current directory (after `cd`; on Windows the shell must report it via OSC 7 / OSC 9;9, as Starship or oh-my-posh do).
- `Alt+F12` toggles the terminal, `Alt+1` toggles the Project view.
- `HAZE_TERMINAL_ID` is set in every terminal so agent hooks know which tab they run in.

### AI agents

- **Settings** (`Ctrl+Alt+S`) installs status hooks, keeping your other settings and hooks (a `.haze-backup` copy is made on the first write; remove them anytime):
  - **Claude Code**: hooks in `~/.claude/settings.json`.
  - **Codex**: lifecycle hooks in `~/.codex/hooks.json` (Codex may ask you to trust them in `/hooks`), plus `notify` in `config.toml` for older versions unless you use it already.
  - **Gemini CLI** (0.26+): hooks in `~/.gemini/settings.json`.
  - **OpenCode**: a `haze.js` plugin in `~/.config/opencode/plugins/`.
- **No hook needed** for agents that print their state: Haze reads its own `OSC 6973;<state>[;<agent>[;<message>]]`, which any script can print (`printf '\e]6973;working;mybot\a'`; states: idle, working, waiting, done, error, clear), and notifications (`OSC 9`, `OSC 777`) that name Claude, Codex, Gemini or OpenCode. Once an agent is known, the progress sequence `OSC 9;4` updates it while that program is in front; a progress bar alone (`dotnet build` draws one) does not count. An installed hook takes precedence.
- Terminal tabs running an agent show a badge (**CC** Claude Code, **CX** Codex, **GM** Gemini, **OC** OpenCode): pulsing blue = working, yellow = waiting for you (permission, question), green = done, red = error. Projects in the sidebar show a matching dot.
- **Desktop notifications** when an agent needs you or finishes in a terminal you are not looking at.
- Status lives in the PTY host, so it survives Haze restarts. Prompts and transcripts are never stored.
- **Worktrees**: *New Worktree…* in the Branches popup creates `<repo>-<branch>` on a new branch and opens it as a separate project, so each agent gets its own worktree.
- **Command line** (`haze` on `PATH`), for scripts and for agents that hand work to other agents:

  ```bash
  haze agent claude --worktree fix/login "Fix the login redirect"   # new worktree, new terminal, prints its id
  haze agent codex -p "Write tests for OrderService"                # also gemini, opencode, or any command name
  haze run --dir src/Api -- dotnet watch                            # any command in a new terminal
  haze list                                                         # terminals and their agent state
  haze send 3f2a "Also update the docs"                             # type into a terminal and press Enter
  haze wait 3f2a --timeout 600                                      # until its agent is done, waiting or failed
  haze read 3f2a --lines 40                                         # the end of its output
  ```

  `agent` and `run` start your shell in the new terminal and type the command into it, then show the terminal in Haze (`--no-ui` to skip). Ids may be shortened to any unique prefix; inside a Haze terminal, `$HAZE_TERMINAL_ID` is its own.

![AI agents](docs/agents.png)

## Installation

**macOS (Homebrew)**: a single universal `.dmg` for Apple Silicon and Intel.

```bash
brew tap aprius/haze https://github.com/aprius/Haze
brew install --cask haze
brew upgrade --cask haze   # update
```

**Windows / Linux**: download from [Releases](https://github.com/aprius/Haze/releases): `-setup.exe` or `.msi` (Windows), `.deb`, `.rpm` or `.AppImage` (Linux).

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

## Usage

1. Launch Haze and open a folder from the Welcome screen (or the *Open Folder…* button in the project sidebar).
2. Open a terminal (`Alt+F12`) and start your agent, e.g. `claude` or `codex`.
3. Optional: open **Settings** (`Ctrl+Alt+S`) and install the agent hook to get status badges and notifications.
4. Before a big task, take an **AI checkpoint** from the Commit window. While the agent works, edits on disk show up live in the tree and editor.
5. Review the result in the Commit window (`Alt+0`): open diffs, mark files as reviewed, roll back what you do not want, then commit and push.
6. For parallel agents, create a **worktree** per task from the Branches popup.

### Key shortcuts

| Action | Shortcut |
|---|---|
| Search Everywhere | `Shift` `Shift` |
| Go to File / Find Action / Recent Files | `Ctrl+Shift+N` / `Ctrl+Shift+A` / `Ctrl+E` |
| Find / Replace in Files | `Ctrl+Shift+F` / `Ctrl+Shift+R` |
| Go to Definition / Implementation | `Ctrl+B` / `Ctrl+Alt+B` |
| Find Usages | `Alt+F7` |
| Rename | `Shift+F6` |
| Quick fix | `Alt+Enter` |
| Build / Run | `Ctrl+Shift+B` / `Shift+F10` |
| Commit / Git log | `Alt+0` (`Ctrl+K`) / `Alt+9` |
| Push / Update Project | `Ctrl+Shift+K` / `Ctrl+T` |
| Branches | ``Ctrl+Shift+` `` |
| Terminal / Project view | `Alt+F12` / `Alt+1` |
| Copy Context for AI | `Ctrl+Shift+C` |
| Settings | `Ctrl+Alt+S` |

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
                             CommitPanel, GitPanel, DiffView, MergeView, RebaseDialog, BuildPanel, ...
  lib/                       ipc (Rust bindings), buffers (open files), monaco, merge, termLinks, worktrees
  lib/lsp/                   JSON-RPC client, C# session and Monaco providers
  store/                     zustand stores: workspace, tree, terminals, git, dotnet, ui, persist
src-tauri/src/               backend (Rust)
  main.rs                    entry point: app, --pty-host or --agent-hook mode
  fs_ops.rs, text.rs         file operations, encoding-preserving read/write
  nesting.rs                 Rider-style file nesting rules
  watcher.rs                 disk change notifications
  git.rs                     git status for the file tree
  git_log.rs                 git log and branch graph lanes
  git_ops.rs                 changes, commit, rollback, branches, stash, blame, rebase, checkpoints
  search.rs                  Find/Replace in Files with undo
  syntax.rs                  C# comment/string ranges (tree-sitter)
  file_index.rs              file list and fuzzy matching for Search Everywhere
  lsp.rs                     language server process and message relay
  dotnet.rs                  solutions, projects, launch profiles, dotnet build parsing
  agent_hooks.rs             Claude Code / Codex hook install and the --agent-hook mode
  procinfo.rs                shell working directory and child-process detection for terminals
  pty/                       PTY host (host.rs), client (client.rs), wire protocol (protocol.rs)
scripts/                     bump-version.sh
Casks/                       Homebrew cask (updated by the release workflow)
docs/                        screenshots
```

## Contributing

Issues and pull requests are welcome. Please run the checks in [Tests](#tests) before opening a PR.

## License

Haze is released under the [MIT License](LICENSE).

Haze takes **ideas** from Tervia (AGPL-3.0) but contains none of its code.

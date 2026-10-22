# Haze Editor Support for Unity

Makes Haze a Unity **External Script Editor**:

- Haze appears in *Preferences → External Tools → External Script Editor*.
- Unity keeps the `.sln` and `.csproj` files up to date for Haze (SDK-style
  projects, the format the Roslyn C# language server loads), so code
  completion, Find Usages and Rename work in Haze.
- Double-clicking a script or a console error opens it in Haze at the right
  line. A running Haze is reused.
- A live link to Haze, as Rider's: Build in Haze compiles in Unity, the
  Console, Play, Pause and Step are in Haze, and Unity imports files changed
  in Haze (or by an agent) without waiting for its window to be focused.

## Install

In Unity: *Window → Package Manager → + → Add package from git URL…*

```
https://github.com/aprius/Haze.git?path=/unity/com.aprius.ide.haze
```

Then pick **Haze** in *Preferences → External Tools → External Script Editor*.
If Haze is not listed, choose *Browse…* and select `Haze.app` (macOS) or
`haze.exe` (Windows). Project files are generated right away; *Regenerate
project files* in the same panel forces it.

## Live link

While Haze is the External Script Editor, the package listens on
`127.0.0.1` (a port kept across script reloads) and writes the port and a
random token to `Library/Haze/EditorInstance.json`. Haze reads it and
connects for each open Unity project; the connection drops on every script
reload and Haze reconnects within a second. One JSON object per line:

- Unity → Haze: `state` (Unity version, Play Mode, paused), `compileStarted`,
  `compileFinished` (the compiler's errors and warnings, kept across the
  reload), `log` (Console messages with their stack traces; package paths
  resolved to files on disk).
- Haze → Unity: `hello` (the token), `refresh` (`AssetDatabase.Refresh`,
  not in Play Mode), `compile` (refresh, then the compiler's result; the
  last one again when nothing changed), `play`, `pause`, `step`, `show`
  (select an asset, or the GameObject of a component in it when its scene is
  open or it is a prefab), `runTests` (a regex of test full names).
- Unity → Haze during a test run: `testRunStarted`, `testStarted`,
  `testFinished` (status, duration, message, stack trace, output),
  `testRunFinished`.

Running tests needs the Test Framework package (`com.unity.test-framework`,
in Unity's default templates): the `Haze.Ide.Editor.Tests` assembly that
drives it compiles only when the package is installed.

## Project generation

The External Tools page, as in Rider:

- **Generate .csproj files for** embedded, local, registry, git, built-in,
  local tarball packages or packages from unknown sources. Scripts in
  `Assets/` always get projects; by default embedded and local packages do
  too, and the others are referenced as compiled assemblies.
- **Player projects**: an extra `Name.Player.csproj` per player assembly,
  compiled without `UNITY_EDITOR`, so editor-only code used at runtime shows
  up before a player build.
- **Microsoft.Unity.Analyzers** (on by default): Unity's Roslyn analyzers and
  suppressors (bundled, MIT) are added to the generated projects, for Haze
  only. Unity's own compilation is unchanged.
- A link to *Project Settings → Editor → Additional extensions to include*,
  so Unity opens shaders, USS, UXML and other files in Haze too.

The projects follow Unity's compilation: defines (including the build
target's), response files such as `csc.rsp` (`-define`, `-r`, `-unsafe`, `-nowarn`,
`-nullable`, `-langversion`, `-warnaserror`, `-analyzer`, `-ruleset`,
`-additionalfile`) and *Additional Compiler Arguments* (the same, except `-r`), analyzers, rulesets,
`AdditionalFiles` and the global analyzer config. They are refreshed after
every script reload, so switching the build target or editing *Scripting
Define Symbols* updates them; unchanged files are not rewritten. Projects a
previous sync wrote and that are no longer needed are deleted.

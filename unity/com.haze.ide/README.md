# Haze Editor Support for Unity

Makes Haze a Unity **External Script Editor**:

- Haze appears in *Preferences → External Tools → External Script Editor*.
- Unity keeps the `.sln` and `.csproj` files up to date for Haze (SDK-style
  projects, the format the Roslyn C# language server loads), so code
  completion, Find Usages and Rename work in Haze.
- Double-clicking a script or a console error opens it in Haze at the right
  line. A running Haze is reused.

## Install

In Unity: *Window → Package Manager → + → Add package from git URL…*

```
https://github.com/aprius/Haze.git?path=/unity/com.haze.ide
```

Then pick **Haze** in *Preferences → External Tools → External Script Editor*.
If Haze is not listed, choose *Browse…* and select `Haze.app` (macOS) or
`haze.exe` (Windows). Project files are generated right away; *Regenerate
project files* in the same panel forces it.

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

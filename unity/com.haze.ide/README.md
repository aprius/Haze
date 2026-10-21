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

Projects are generated for scripts in `Assets/` and in embedded or local
packages. Other packages are referenced as compiled assemblies.

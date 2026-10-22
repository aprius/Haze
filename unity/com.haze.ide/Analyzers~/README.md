`Microsoft.Unity.Analyzers.dll` 1.28.0 from NuGet
(https://www.nuget.org/packages/Microsoft.Unity.Analyzers, MIT license,
https://github.com/microsoft/Microsoft.Unity.Analyzers).

Added to the generated `.csproj` files only, so Haze's build and language
server see Unity-specific diagnostics and suppressors. The `~` keeps Unity
from importing it: Unity's own compilation is unchanged.

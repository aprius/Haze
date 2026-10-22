using System;
using UnityEditor;
using PackageSource = UnityEditor.PackageManager.PackageSource;

namespace Haze.Ide.Editor
{
    /// <summary>What the generated projects cover, as in Rider's External Tools page.</summary>
    [Flags]
    enum GenerationFlags
    {
        None = 0,
        Embedded = 1,
        Local = 2,
        Registry = 4,
        Git = 8,
        BuiltIn = 16,
        Unknown = 32,
        PlayerProjects = 64,
        LocalTarball = 128,
        UnityAnalyzers = 256,
    }

    static class Settings
    {
        const string k_Key = "Haze.Ide.GenerationFlags";
        const GenerationFlags k_Default = GenerationFlags.Embedded | GenerationFlags.Local | GenerationFlags.UnityAnalyzers;

        public static GenerationFlags Flags
        {
            get => (GenerationFlags)EditorPrefs.GetInt(k_Key, (int)k_Default);
            set => EditorPrefs.SetInt(k_Key, (int)value);
        }

        /// <summary>Whether scripts from packages of this source get a project of their own.</summary>
        public static bool Generates(PackageSource? source)
        {
            switch (source)
            {
                case PackageSource.Embedded: return Flags.HasFlag(GenerationFlags.Embedded);
                case PackageSource.Local: return Flags.HasFlag(GenerationFlags.Local);
                case PackageSource.Registry: return Flags.HasFlag(GenerationFlags.Registry);
                case PackageSource.Git: return Flags.HasFlag(GenerationFlags.Git);
                case PackageSource.BuiltIn: return Flags.HasFlag(GenerationFlags.BuiltIn);
                case PackageSource.LocalTarball: return Flags.HasFlag(GenerationFlags.LocalTarball);
                default: return Flags.HasFlag(GenerationFlags.Unknown);
            }
        }
    }
}

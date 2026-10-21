using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Haze.Ide.Editor
{
    /// <summary>Where Haze is installed, and its executable.</summary>
    static class Discovery
    {
        public static IEnumerable<string> Find()
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var candidates = new[]
            {
                // macOS
                "/Applications/Haze.app",
                Path.Combine(home, "Applications", "Haze.app"),
                // Windows
                Path.Combine(local, "Haze", "haze.exe"),
                Path.Combine(local, "Programs", "Haze", "haze.exe"),
                Path.Combine(programs, "Haze", "haze.exe"),
                // Linux
                "/usr/bin/haze",
                "/usr/local/bin/haze",
                Path.Combine(home, ".local", "bin", "haze"),
            };
            return candidates.Where(p => Executable(p) != null).Distinct();
        }

        public static bool IsHaze(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            var name = Path.GetFileNameWithoutExtension(path.TrimEnd('/', '\\'));
            return string.Equals(name, "haze", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The program to run for an installation (an .app bundle or an executable).</summary>
        public static string Executable(string installation)
        {
            if (string.IsNullOrEmpty(installation)) return null;
            if (installation.TrimEnd('/').EndsWith(".app", StringComparison.OrdinalIgnoreCase))
            {
                var dir = Path.Combine(installation, "Contents", "MacOS");
                if (!Directory.Exists(dir)) return null;
                var files = Directory.GetFiles(dir);
                return files.FirstOrDefault(IsHaze) ?? files.FirstOrDefault();
            }
            return File.Exists(installation) ? installation : null;
        }
    }
}

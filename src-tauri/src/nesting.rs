//! Rider-style file nesting: companion files are shown under their parent,
//! e.g. `appsettings.Development.json` under `appsettings.json` and
//! `Index.razor.cs` under `Index.razor`.

use std::collections::{HashMap, HashSet};

const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
];

/// Maps a file name to the name of the file it nests under. Only files in the
/// same directory are considered; directories never nest.
pub fn compute(files: &[&str]) -> HashMap<String, String> {
    let present: HashSet<&str> = files.iter().copied().collect();
    let mut out = HashMap::new();
    for &name in files {
        if let Some(parent) = parent_of(name, &present) {
            out.insert(name.to_string(), parent);
        }
    }
    out
}

fn parent_of(name: &str, present: &HashSet<&str>) -> Option<String> {
    let exists = |c: &str| c != name && present.contains(c);

    if LOCKFILES.contains(&name) && exists("package.json") {
        return Some("package.json".into());
    }

    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let n = parts.len();

    // Resources designer files belong to the .resx they are generated from.
    if n >= 3 && parts[n - 2].eq_ignore_ascii_case("designer") {
        let resx = format!("{}.resx", parts[..n - 2].join("."));
        if exists(&resx) {
            return Some(resx);
        }
    }

    // `Foo.razor.cs` -> `Foo.razor`, `.env.local` -> `.env`, `App.csproj.user` -> `App.csproj`.
    // (`a.b` dropping its last part leaves `a`, a different kind of file.)
    let drop_last = parts[..n - 1].join(".");
    if n >= 3 && exists(&drop_last) {
        return Some(drop_last);
    }

    // `appsettings.Development.json` -> `appsettings.json`, `Foo.Designer.cs` -> `Foo.cs`.
    if n >= 3 {
        let drop_middle = format!("{}.{}", parts[..n - 2].join("."), parts[n - 1]);
        if exists(&drop_middle) {
            return Some(drop_middle);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nest(files: &[&str]) -> Vec<(String, String)> {
        let mut v: Vec<_> = compute(files).into_iter().collect();
        v.sort();
        v
    }

    fn pair(a: &str, b: &str) -> (String, String) {
        (a.into(), b.into())
    }

    #[test]
    fn dotnet_rules() {
        let got = nest(&[
            "appsettings.json",
            "appsettings.Development.json",
            "Index.razor",
            "Index.razor.cs",
            "Index.razor.css",
            "Strings.resx",
            "Strings.Designer.cs",
            "Strings.vi.resx",
            "App.csproj",
            "App.csproj.user",
            "Program.cs",
        ]);
        assert_eq!(
            got,
            vec![
                pair("App.csproj.user", "App.csproj"),
                pair("Index.razor.cs", "Index.razor"),
                pair("Index.razor.css", "Index.razor"),
                pair("Strings.Designer.cs", "Strings.resx"),
                pair("Strings.vi.resx", "Strings.resx"),
                pair("appsettings.Development.json", "appsettings.json"),
            ]
        );
    }

    #[test]
    fn misc_rules() {
        let got = nest(&[
            ".env",
            ".env.local",
            "package.json",
            "package-lock.json",
            "README.md",
        ]);
        assert_eq!(
            got,
            vec![
                pair(".env.local", ".env"),
                pair("package-lock.json", "package.json")
            ]
        );
    }

    #[test]
    fn no_parent_no_nesting() {
        assert!(nest(&["Foo.Designer.cs", "a.b.c"]).is_empty());
    }
}

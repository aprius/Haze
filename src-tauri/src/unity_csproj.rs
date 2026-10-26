//! Scripts Unity has not added to its generated `.csproj` files yet (a file
//! just created by Haze or an agent, Unity closed or not reimported yet).
//! Roslyn treats such a file as a loose file: no references, so no errors and
//! no "using UnityEngine;" fix. Like Rider, Haze adds the file to the project
//! Unity will put it in; Unity's next generation writes the same line.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use anyhow::Result;
use parking_lot::Mutex;

use crate::dotnet::project_items;
use crate::unity::is_unity_project;

/// Folders whose scripts (outside an assembly definition) compile into the
/// `-firstpass` assemblies, before the rest.
const FIRSTPASS: &[&str] = &["Plugins", "Standard Assets", "Pro Standard Assets"];

fn key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// The files the generated projects list, per Unity project, with the
/// projects' times they were read at: a large project has hundreds of them.
struct Listed {
    stamps: Vec<(PathBuf, Option<SystemTime>)>,
    /// None when a project compiles its whole folder (not one of Unity's).
    files: Option<HashSet<String>>,
}

static LISTED: LazyLock<Mutex<HashMap<PathBuf, Listed>>> = LazyLock::new(Default::default);

fn stamps(projects: &[PathBuf]) -> Vec<(PathBuf, Option<SystemTime>)> {
    projects
        .iter()
        .map(|p| {
            (
                p.clone(),
                std::fs::metadata(p).and_then(|m| m.modified()).ok(),
            )
        })
        .collect()
}

/// Whether some project lists `file` (true too when a project globs its folder).
fn listed(root: &Path, projects: &[PathBuf], file: &Path) -> bool {
    let now = stamps(projects);
    let mut cache = LISTED.lock();
    let fresh = cache.get(root).is_some_and(|l| l.stamps == now);
    if !fresh {
        let mut files = Some(HashSet::new());
        for p in projects {
            match project_items(p) {
                Some(items) => files
                    .iter_mut()
                    .for_each(|f| f.extend(items.iter().map(|i| key(i)))),
                None => files = None,
            }
        }
        cache.insert(root.to_path_buf(), Listed { stamps: now, files });
    }
    cache[root]
        .files
        .as_ref()
        .is_none_or(|f| f.contains(&key(file)))
}

/// The generated projects in the Unity project's folder.
fn projects(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("csproj"))
        })
        .collect()
}

/// The assembly an `.asmdef` (or an `.asmref` naming one) in `dir` defines, if any.
fn assembly_in(dir: &Path) -> Option<Option<String>> {
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let path = e.path();
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
        let key = match ext.as_deref() {
            Some("asmdef") => "name",
            Some("asmref") => "reference",
            _ => continue,
        };
        let json: serde_json::Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_default();
        // An `.asmref` may name its assembly by GUID; that needs Unity's asset database.
        let name = json[key]
            .as_str()
            .filter(|n| !n.is_empty() && !n.starts_with("GUID:"))
            .map(str::to_string);
        return Some(name);
    }
    None
}

/// The assembly Unity compiles `file` into, from the assembly definitions
/// above it, else from Unity's predefined assemblies. None when it cannot tell.
pub fn assembly_for(root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let top = parts.first()?;
    if top != "Assets" && top != "Packages" {
        return None;
    }
    let mut dir = file.parent()?;
    while dir.starts_with(root) && dir != root {
        if let Some(found) = assembly_in(dir) {
            return found;
        }
        dir = dir.parent()?;
    }
    // Packages always come with an assembly definition.
    if top != "Assets" {
        return None;
    }
    let folders = &parts[1..parts.len() - 1];
    let editor = folders.iter().any(|f| f == "Editor");
    let firstpass = folders
        .first()
        .is_some_and(|f| FIRSTPASS.contains(&f.as_str()));
    Some(
        match (editor, firstpass) {
            (false, false) => "Assembly-CSharp",
            (true, false) => "Assembly-CSharp-Editor",
            (false, true) => "Assembly-CSharp-firstpass",
            (true, true) => "Assembly-CSharp-Editor-firstpass",
        }
        .to_string(),
    )
}

/// `file` spelled from `root` on, when it is inside it: the editor's paths
/// may differ in case (Monaco writes `c:\` for `C:\`).
fn under_root(root: &Path, file: &Path) -> Option<PathBuf> {
    if file.starts_with(root) {
        return Some(file.to_path_buf());
    }
    let r: Vec<_> = root.components().collect();
    let f: Vec<_> = file.components().collect();
    let same = |a: &Component, b: &Component| {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    };
    if f.len() <= r.len() || !r.iter().zip(&f).all(|(a, b)| same(a, b)) {
        return None;
    }
    Some(
        f[r.len()..]
            .iter()
            .fold(root.to_path_buf(), |p, c| p.join(c)),
    )
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Adds a script to the generated project of its assembly when no project
/// lists it. Returns the project changed, or None when nothing was done.
pub fn add_to_project(root: &Path, file: &Path) -> Result<Option<PathBuf>> {
    let Some(file) = under_root(root, file) else {
        return Ok(None);
    };
    let file = file.as_path();
    if !is_unity_project(root)
        || !file
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("cs"))
        || !file.is_file()
    {
        return Ok(None);
    }
    let all = projects(root);
    if listed(root, &all, file) {
        return Ok(None);
    }
    let Some(assembly) = assembly_for(root, file) else {
        return Ok(None);
    };
    let Some(project) = all.into_iter().find(|p| {
        p.file_stem()
            .is_some_and(|s| s.to_string_lossy() == assembly)
    }) else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&project)?;
    // Next to the project's first source file, in the same item group and indent.
    let Some(at) = text.find("<Compile Include=") else {
        return Ok(None);
    };
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let indent = &text[line_start..at];
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let rel = file
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");
    let line = format!("{indent}<Compile Include=\"{}\" />{eol}", escape(&rel));
    let updated = format!("{}{line}{}", &text[..line_start], &text[line_start..]);
    let meta = std::fs::metadata(&project).ok();
    crate::fs_ops::atomic_write(&project, updated.as_bytes(), meta.as_ref())?;
    Ok(Some(project))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "<Project>\n  <ItemGroup>\n    <Compile Include=\"Assets/Old.cs\" />\n  </ItemGroup>\n</Project>\n";

    fn unity_project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for d in [
            "Assets/Scripts/Editor",
            "Assets/Plugins",
            "Assets/Game",
            "ProjectSettings",
        ] {
            std::fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn picks_unity_assemblies() {
        let dir = unity_project();
        let root = dir.path();
        let a = |p: &str| assembly_for(root, &root.join(p));
        assert_eq!(
            a("Assets/Scripts/Player.cs").as_deref(),
            Some("Assembly-CSharp")
        );
        assert_eq!(
            a("Assets/Scripts/Editor/Tool.cs").as_deref(),
            Some("Assembly-CSharp-Editor")
        );
        assert_eq!(
            a("Assets/Plugins/Lib.cs").as_deref(),
            Some("Assembly-CSharp-firstpass")
        );
        write(
            &root.join("Assets/Game/Game.asmdef"),
            r#"{ "name": "Game.Runtime" }"#,
        );
        assert_eq!(
            a("Assets/Game/Sub/Enemy.cs").as_deref(),
            Some("Game.Runtime")
        );
        assert_eq!(a("Packages/com.x/Runtime/X.cs"), None);
        assert_eq!(a("Library/PackageCache/X.cs"), None);
    }

    #[test]
    fn adds_a_missing_script_once() {
        let dir = unity_project();
        let root = dir.path();
        write(&root.join("Assembly-CSharp.csproj"), PROJECT);
        let script = root.join("Assets/Scripts/New & Shiny.cs");
        write(&script, "class A {}");
        let changed = add_to_project(root, &script).unwrap();
        assert_eq!(changed, Some(root.join("Assembly-CSharp.csproj")));
        let text = std::fs::read_to_string(root.join("Assembly-CSharp.csproj")).unwrap();
        assert!(text.contains("    <Compile Include=\"Assets/Scripts/New &amp; Shiny.cs\" />\n    <Compile Include=\"Assets/Old.cs\" />"));
        // Listed now.
        assert_eq!(add_to_project(root, &script).unwrap(), None);
    }

    #[test]
    fn takes_paths_spelled_in_another_case() {
        let root = Path::new("/Work/Game");
        assert_eq!(
            under_root(root, Path::new("/work/game/Assets/A.cs")),
            Some(PathBuf::from("/Work/Game/Assets/A.cs"))
        );
        assert_eq!(under_root(root, Path::new("/work/other/A.cs")), None);
    }

    #[test]
    fn leaves_listed_and_unknown_files_alone() {
        let dir = unity_project();
        let root = dir.path();
        write(&root.join("Assembly-CSharp.csproj"), PROJECT);
        let old = root.join("Assets/Old.cs");
        write(&old, "class A {}");
        assert_eq!(add_to_project(root, &old).unwrap(), None);
        // No Assembly-CSharp-Editor.csproj to add it to.
        let tool = root.join("Assets/Scripts/Editor/Tool.cs");
        write(&tool, "class T {}");
        assert_eq!(add_to_project(root, &tool).unwrap(), None);
        // Not saved yet.
        assert_eq!(
            add_to_project(root, &root.join("Assets/Missing.cs")).unwrap(),
            None
        );
    }
}

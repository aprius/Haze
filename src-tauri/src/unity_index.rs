//! What Rider's Unity support knows without Unity running, from the project's
//! files: the C# classes and their base classes (to tell which derive from
//! MonoBehaviour, through user and package code), and which scenes, prefabs
//! and assets use a script or call a method from a UnityEvent.
//!
//! Built on first use per project and kept up to date from file changes:
//! changed files are read again on the next query.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;

use crate::watcher::FsChange;

/// Text-serialized Unity files that reference scripts.
const ASSET_EXTS: &[&str] = &["unity", "prefab", "asset", "controller", "overridecontroller", "playable"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClassDecl {
    pub name: String,
    /// Base types and interfaces, without namespace or type arguments.
    pub bases: Vec<String>,
}

/// A place in a scene, prefab or asset file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUsage {
    pub path: String,
    pub line: u32,
    /// The GameObject it is on, when the file names it.
    pub object: Option<String>,
    /// The local file id of the component, to find it in Unity. Text: ids
    /// pass 2^53, beyond what JavaScript numbers hold exactly.
    pub file_id: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUsages {
    /// Components and assets of the script (by the GUID in its `.meta`).
    pub scripts: Vec<AssetUsage>,
    /// UnityEvent calls to methods of the script's classes, by method name.
    pub methods: HashMap<String, Vec<AssetUsage>>,
}

#[derive(Debug, Default, Clone, PartialEq)]
struct ScriptRef {
    guid: String,
    line: u32,
    object: Option<String>,
    file_id: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
struct EventCall {
    /// The target type's name ("m_TargetAssemblyTypeName", Unity 2020.1+).
    type_name: Option<String>,
    method: String,
    line: u32,
    object: Option<String>,
    file_id: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
struct AssetFile {
    scripts: Vec<ScriptRef>,
    calls: Vec<EventCall>,
}

#[derive(Default)]
struct Index {
    built: bool,
    classes: HashMap<PathBuf, Vec<ClassDecl>>,
    assets: HashMap<PathBuf, AssetFile>,
    /// Files changed since they were read.
    stale: HashSet<PathBuf>,
}

#[derive(Default)]
pub struct UnityIndexes {
    roots: Mutex<HashMap<PathBuf, Arc<Mutex<Index>>>>,
}

fn ext_of(path: &Path) -> Option<String> {
    path.extension().and_then(OsStr::to_str).map(str::to_ascii_lowercase)
}

fn is_asset(path: &Path) -> bool {
    ext_of(path).is_some_and(|e| ASSET_EXTS.contains(&e.as_str()))
}

fn is_script(path: &Path) -> bool {
    ext_of(path).as_deref() == Some("cs")
}

/// Where Unity reads scripts and assets from: Assets, embedded packages and the package cache.
fn source_dirs(root: &Path) -> [PathBuf; 3] {
    [root.join("Assets"), root.join("Packages"), root.join("Library").join("PackageCache")]
}

/// Files under `dir` Unity imports: not hidden, not `name~`.
fn walk(dir: &Path, mut f: impl FnMut(&Path)) {
    if !dir.is_dir() {
        return;
    }
    let walker = ignore::WalkBuilder::new(dir)
        .standard_filters(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name.starts_with('.') || name.ends_with('~'))
        })
        .build();
    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|t| t.is_file()) {
            f(entry.path());
        }
    }
}

impl Index {
    fn build(&mut self, root: &Path) {
        self.classes.clear();
        self.assets.clear();
        self.stale.clear();
        for dir in source_dirs(root) {
            // Assets in the package cache are read-only and rarely matter; scripts there do (base classes).
            let assets = !dir.ends_with("PackageCache");
            walk(&dir, |p| {
                if is_script(p) || (assets && is_asset(p)) {
                    self.read(p);
                }
            });
        }
        self.built = true;
    }

    fn read(&mut self, path: &Path) {
        let Ok(bytes) = std::fs::read(path) else {
            self.classes.remove(path);
            self.assets.remove(path);
            return;
        };
        let text = String::from_utf8_lossy(&bytes);
        if is_script(path) {
            self.classes.insert(path.to_path_buf(), parse_classes(&text));
        } else if text.starts_with("%YAML") {
            // Binary-serialized assets (Force Binary) cannot be read.
            self.assets.insert(path.to_path_buf(), parse_asset(&text));
        }
    }

    fn refresh(&mut self, root: &Path) {
        if !self.built {
            self.build(root);
            return;
        }
        for path in std::mem::take(&mut self.stale) {
            self.read(&path);
        }
    }
}

impl UnityIndexes {
    fn index(&self, root: &Path) -> Arc<Mutex<Index>> {
        self.roots.lock().entry(root.to_path_buf()).or_default().clone()
    }

    /// Marks changed scripts and assets of a project indexed before, to be read again.
    pub fn changed(&self, change: &FsChange) {
        let Some(index) = self.roots.lock().get(Path::new(&change.root)).cloned() else {
            return;
        };
        let mut index = index.lock();
        if change.overflow || change.lost {
            // Too much changed (a checkout, a reimport) to trust the lists.
            index.built = false;
            return;
        }
        for f in change.files.iter().chain(&change.created).chain(&change.removed) {
            let p = Path::new(f);
            if is_script(p) || is_asset(p) {
                index.stale.insert(p.to_path_buf());
            }
        }
    }

    pub fn forget(&self, root: &Path) {
        self.roots.lock().remove(root);
    }

    /// Every class of the project and its packages, with the bases each declaration lists.
    pub fn classes(&self, root: &Path) -> HashMap<String, Vec<String>> {
        let index = self.index(root);
        let mut index = index.lock();
        index.refresh(root);
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for c in index.classes.values().flatten() {
            let bases = out.entry(c.name.clone()).or_default();
            for b in &c.bases {
                if !bases.contains(b) {
                    bases.push(b.clone());
                }
            }
        }
        out
    }

    /// Scenes, prefabs and assets that use `script` (a .cs file), and the
    /// UnityEvent calls to methods of `classes` (declared in it).
    pub fn asset_usages(&self, root: &Path, script: &Path, classes: &[String]) -> AssetUsages {
        let guid = script_guid(script);
        let index = self.index(root);
        let mut index = index.lock();
        index.refresh(root);
        let mut out = AssetUsages::default();
        let mut paths: Vec<&PathBuf> = index.assets.keys().collect();
        paths.sort();
        for path in paths {
            let file = &index.assets[path];
            let usage = |line, object: &Option<String>, file_id: &Option<String>| AssetUsage {
                path: path.to_string_lossy().into_owned(),
                line,
                object: object.clone(),
                file_id: file_id.clone(),
            };
            if let Some(guid) = &guid {
                for s in file.scripts.iter().filter(|s| &s.guid == guid) {
                    out.scripts.push(usage(s.line, &s.object, &s.file_id));
                }
            }
            for c in &file.calls {
                // Before Unity 2020.1 calls name no type: the method name alone decides.
                if c.type_name.as_ref().is_none_or(|t| classes.contains(t)) {
                    out.methods
                        .entry(c.method.clone())
                        .or_default()
                        .push(usage(c.line, &c.object, &c.file_id));
                }
            }
        }
        out
    }
}

/// The GUID Unity gave a file, from its `.meta`.
fn script_guid(path: &Path) -> Option<String> {
    let mut meta = path.as_os_str().to_owned();
    meta.push(".meta");
    let text = std::fs::read_to_string(PathBuf::from(meta)).ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("guid: "))
        .map(|g| g.trim().to_string())
}

/// `<...>` removed, nested ones too: "Base<List<int>, T>" is "Base".
fn strip_type_args(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0;
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Classes and structs declared in C# source, with the bases they list.
pub fn parse_classes(text: &str) -> Vec<ClassDecl> {
    static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)//[^\n]*|/\*.*?\*/"#).unwrap());
    static DECL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\b(?:class|struct|record)\s+(?P<name>[A-Za-z_]\w*)(?P<rest>[^{;]*)[{;]").unwrap()
    });
    let code = COMMENTS.replace_all(text, " ");
    DECL.captures_iter(&code)
        .map(|c| {
            let rest = strip_type_args(&c["rest"]);
            // Constraints come last: "where T : Component" lists no base.
            let rest = rest.split(" where ").next().unwrap_or(&rest).to_string();
            // Primary constructor parameters (records), then " : Bases where ...".
            let rest = match (rest.find('('), rest.find(':')) {
                (Some(p), Some(colon)) if p < colon => rest[rest.find(')').map_or(0, |i| i + 1)..].to_string(),
                _ => rest,
            };
            let bases = rest
                .split_once(':')
                .map(|(_, b)| {
                    b.split(',')
                        .map(|t| {
                            let t = t.split('(').next().unwrap_or(t).trim();
                            t.rsplit(['.', ':']).next().unwrap_or(t).trim().to_string()
                        })
                        .filter(|t| !t.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            ClassDecl {
                name: c["name"].to_string(),
                bases,
            }
        })
        .collect()
}

/// Script references and UnityEvent calls in a text-serialized scene, prefab or asset.
fn parse_asset(text: &str) -> AssetFile {
    static HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^--- !u!(\d+) &(-?\d+)").unwrap());
    static SCRIPT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*m_Script: \{fileID: -?\d+, guid: ([0-9a-f]{32}), type: \d\}").unwrap());
    static GAME_OBJECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^  m_GameObject: \{fileID: (-?\d+)\}").unwrap());

    // Refs first point at their component's GameObject id; names are filled in at the end.
    let mut out = AssetFile::default();
    let mut names: HashMap<i64, String> = HashMap::new();
    let mut doc_class = 0u32;
    let mut doc_id: Option<i64> = None;
    let mut doc_id_text: Option<String> = None;
    let mut doc_object: Option<i64> = None;
    let mut script_owner: Vec<Option<i64>> = Vec::new();
    let mut call_owner: Vec<Option<i64>> = Vec::new();
    let mut call_type: Option<String> = None;

    for (i, line) in text.lines().enumerate() {
        let n = i as u32 + 1;
        if line.starts_with("---") {
            if let Some(c) = HEADER.captures(line) {
                doc_class = c[1].parse().unwrap_or(0);
                doc_id = c[2].parse().ok();
                doc_id_text = Some(c[2].to_string());
                doc_object = if doc_class == 1 { doc_id } else { None };
            }
            continue;
        }
        if !line.contains("m_") {
            continue;
        }
        if doc_class == 1 {
            if let Some(name) = line.strip_prefix("  m_Name: ") {
                if let Some(id) = doc_id {
                    names.insert(id, name.trim().to_string());
                }
            }
            continue;
        }
        if let Some(c) = GAME_OBJECT.captures(line) {
            doc_object = c[1].parse().ok().filter(|id| *id != 0);
        } else if let Some(c) = SCRIPT.captures(line) {
            out.scripts.push(ScriptRef {
                guid: c[1].to_string(),
                line: n,
                object: None,
                file_id: doc_id_text.clone(),
            });
            script_owner.push(doc_object);
        } else if line.trim_start().starts_with("- m_Target:") {
            call_type = None;
        } else if let Some(t) = line.trim_start().strip_prefix("m_TargetAssemblyTypeName: ") {
            // "Game.UI.Menu+Panel, Assembly-CSharp" is "Panel".
            let t = t.split(',').next().unwrap_or(t).trim();
            call_type = Some(t.rsplit(['.', '+']).next().unwrap_or(t).to_string()).filter(|t| !t.is_empty());
        } else if let Some(m) = line.trim_start().strip_prefix("m_MethodName: ") {
            let method = m.trim();
            if !method.is_empty() {
                out.calls.push(EventCall {
                    type_name: call_type.clone(),
                    method: method.to_string(),
                    line: n,
                    object: None,
                    file_id: doc_id_text.clone(),
                });
                call_owner.push(doc_object);
            }
        }
    }
    for (s, owner) in out.scripts.iter_mut().zip(script_owner) {
        s.object = owner.and_then(|id| names.get(&id).cloned());
    }
    for (c, owner) in out.calls.iter_mut().zip(call_owner) {
        c.object = owner.and_then(|id| names.get(&id).cloned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_classes_and_bases() {
        let src = r#"
            // class Commented : Nope {}
            namespace Game {
                public sealed class Enemy : Character, IDamageable { }
                class Pool<T> : UnityEngine.MonoBehaviour where T : Component { }
                class Cache<T> where T : class { }
                public partial class Plain { }
                struct Point : IEquatable<Point> { }
                public record Hit(int Damage) : Event(Damage);
                class Grid : Base<List<int>, Dictionary<int, string>>, global::IFoo { }
            }"#;
        let got = parse_classes(src);
        let get = |n: &str| got.iter().find(|c| c.name == n).map(|c| c.bases.clone());
        assert_eq!(get("Commented"), None);
        assert_eq!(get("Enemy"), Some(vec!["Character".into(), "IDamageable".into()]));
        assert_eq!(get("Pool"), Some(vec!["MonoBehaviour".into()]));
        assert_eq!(get("Plain"), Some(vec![]));
        assert_eq!(get("Cache"), Some(vec![]));
        assert_eq!(get("Point"), Some(vec!["IEquatable".into()]));
        assert_eq!(get("Hit"), Some(vec!["Event".into()]));
        assert_eq!(get("Grid"), Some(vec!["Base".into(), "IFoo".into()]));
    }

    const SCENE: &str = "%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Player
--- !u!114 &200
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: 0123456789abcdef0123456789abcdef, type: 3}
--- !u!1 &300
GameObject:
  m_Name: PlayButton
--- !u!114 &400
MonoBehaviour:
  m_GameObject: {fileID: 300}
  m_Script: {fileID: 11500000, guid: ffffffffffffffffffffffffffffffff, type: 3}
  m_OnClick:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 200}
        m_TargetAssemblyTypeName: Game.Player, Assembly-CSharp
        m_MethodName: Jump
      - m_Target: {fileID: 0}
        m_MethodName:
";

    #[test]
    fn parses_script_refs_and_event_calls() {
        let file = parse_asset(SCENE);
        assert_eq!(file.scripts.len(), 2);
        assert_eq!(file.scripts[0].guid, "0123456789abcdef0123456789abcdef");
        assert_eq!((file.scripts[0].line, file.scripts[0].file_id.as_deref()), (9, Some("200")));
        assert_eq!(file.scripts[0].object.as_deref(), Some("Player"));
        assert_eq!(file.calls.len(), 1);
        let call = &file.calls[0];
        assert_eq!((call.type_name.as_deref(), call.method.as_str(), call.line), (Some("Player"), "Jump", 22));
        assert_eq!(call.object.as_deref(), Some("PlayButton"));
    }

    #[test]
    fn indexes_a_project_and_follows_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Assets/Scripts")).unwrap();
        std::fs::create_dir_all(root.join("Assets/Ignored~")).unwrap();
        std::fs::create_dir_all(root.join("Library/PackageCache/com.unity.ugui/Runtime")).unwrap();
        let player = root.join("Assets/Scripts/Player.cs");
        std::fs::write(&player, "class Player : Character {}").unwrap();
        std::fs::write(root.join("Assets/Scripts/Player.cs.meta"), "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n").unwrap();
        std::fs::write(root.join("Assets/Ignored~/X.cs"), "class Hidden : MonoBehaviour {}").unwrap();
        std::fs::write(root.join("Library/PackageCache/com.unity.ugui/Runtime/UIBehaviour.cs"), "abstract class UIBehaviour : MonoBehaviour {}").unwrap();
        let scene = root.join("Assets/Main.unity");
        std::fs::write(&scene, SCENE).unwrap();

        let indexes = UnityIndexes::default();
        let classes = indexes.classes(root);
        assert_eq!(classes["Player"], vec!["Character".to_string()]);
        assert_eq!(classes["UIBehaviour"], vec!["MonoBehaviour".to_string()]);
        assert!(!classes.contains_key("Hidden"));

        let usages = indexes.asset_usages(root, &player, &["Player".into()]);
        assert_eq!(usages.scripts.len(), 1);
        assert_eq!(usages.scripts[0].path, scene.to_string_lossy());
        assert_eq!(usages.methods["Jump"].len(), 1);

        // The scene loses the component: read again once reported.
        std::fs::write(&scene, "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Empty\n").unwrap();
        indexes.changed(&FsChange {
            root: root.to_string_lossy().into_owned(),
            dirs: vec![],
            files: vec![scene.to_string_lossy().into_owned()],
            created: vec![],
            removed: vec![],
            overflow: false,
            lost: false,
            git: false,
        });
        let usages = indexes.asset_usages(root, &player, &["Player".into()]);
        assert!(usages.scripts.is_empty() && usages.methods.is_empty());
    }
}

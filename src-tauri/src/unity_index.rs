//! What Haze knows of a Unity project without Unity running, from the project's
//! files: the C# classes and their base classes (to tell which derive from
//! MonoBehaviour, through user and package code), and which scenes, prefabs
//! and assets use a script or call a method from a UnityEvent; also what the
//! project's settings and assets name (unity_data.rs).
//!
//! Built when the project opens (or on first use) and kept up to date from
//! file changes: changed files are read again on the next query.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use parking_lot::{Mutex, MutexGuard};
use regex::Regex;
use serde::Serialize;

use crate::unity_data::{self, DataFile, ProjectData};
use crate::watcher::FsChange;

/// Text-serialized Unity files that reference scripts.
const ASSET_EXTS: &[&str] = &[
    "unity",
    "prefab",
    "asset",
    "controller",
    "overridecontroller",
    "playable",
];

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

fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
}

fn is_asset(path: &Path) -> bool {
    ext_of(path).is_some_and(|e| ASSET_EXTS.contains(&e.as_str()))
}

fn is_script(path: &Path) -> bool {
    ext_of(path).as_deref() == Some("cs")
}

/// Where Unity reads scripts and assets from: Assets, embedded packages and the package cache.
fn source_dirs(root: &Path) -> [PathBuf; 3] {
    [
        root.join("Assets"),
        root.join("Packages"),
        root.join("Library").join("PackageCache"),
    ]
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

/// A file's text; nothing for a file gone or unreadable.
fn read_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Parses files on all cores: a Unity project has thousands of scripts in its
/// package cache and scenes of tens of megabytes.
fn parse_files<T: Send>(
    paths: Vec<PathBuf>,
    parse: fn(&Path) -> Option<T>,
) -> Vec<(PathBuf, Option<T>)> {
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(16);
    if paths.len() < 64 || threads == 1 {
        return paths
            .into_iter()
            .map(|p| {
                let parsed = parse(&p);
                (p, parsed)
            })
            .collect();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let paths = &paths;
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    let mut out = Vec::new();
                    // Work stealing by index: one big scene does not hold up a whole chunk.
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(p) = paths.get(i) else { break };
                        out.push((p.clone(), parse(p)));
                    }
                    out
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|w| w.join().unwrap_or_default())
            .collect()
    })
}

/// The files of one kind (scripts or assets) and what each holds.
struct Files<T> {
    built: bool,
    parsed: HashMap<PathBuf, T>,
}

#[derive(Default)]
struct Stale {
    /// Changed since they were read.
    files: HashSet<PathBuf>,
    /// Too much changed (a checkout, a reimport) to trust the lists: read everything again.
    all: bool,
}

/// One kind of file of a project. `files` stays locked while they are read
/// (seconds in a big project); changes only touch `stale`, so reporting them
/// never waits for that (the watcher reports to the UI on the same thread).
struct Part<T> {
    files: Mutex<Files<T>>,
    stale: Mutex<Stale>,
}

impl<T> Default for Part<T> {
    fn default() -> Self {
        Part {
            files: Mutex::new(Files {
                built: false,
                parsed: HashMap::new(),
            }),
            stale: Mutex::default(),
        }
    }
}

impl<T: Send> Part<T> {
    /// The files, read first, or again where they changed.
    fn current(
        &self,
        list: impl FnOnce() -> Vec<PathBuf>,
        parse: fn(&Path) -> Option<T>,
    ) -> MutexGuard<'_, Files<T>> {
        let mut files = self.files.lock();
        let stale = std::mem::take(&mut *self.stale.lock());
        let paths = if stale.all || !files.built {
            files.parsed.clear();
            files.built = true;
            list()
        } else {
            stale.files.into_iter().collect()
        };
        for (path, parsed) in parse_files(paths, parse) {
            match parsed {
                Some(p) => files.parsed.insert(path, p),
                None => files.parsed.remove(&path),
            };
        }
        files
    }

    fn changed(&self, path: &Path) {
        self.stale.lock().files.insert(path.to_path_buf());
    }

    fn changed_all(&self) {
        self.stale.lock().all = true;
    }
}

/// A project's index: scripts and assets apart, so base classes never wait
/// for the scenes.
#[derive(Default)]
struct Index {
    scripts: Part<Vec<ClassDecl>>,
    assets: Part<AssetFile>,
    data: Part<DataFile>,
}

impl Index {
    fn scripts(&self, root: &Path) -> MutexGuard<'_, Files<Vec<ClassDecl>>> {
        let list = || {
            let mut paths = Vec::new();
            for dir in source_dirs(root) {
                walk(&dir, |p| {
                    if is_script(p) {
                        paths.push(p.to_path_buf());
                    }
                });
            }
            paths
        };
        self.scripts
            .current(list, |p| Some(parse_classes(&read_text(p)?)))
    }

    fn assets(&self, root: &Path) -> MutexGuard<'_, Files<AssetFile>> {
        let list = || {
            let mut paths = Vec::new();
            // Assets in the package cache are read-only and rarely matter; scripts there do (base classes).
            for dir in &source_dirs(root)[..2] {
                walk(dir, |p| {
                    if is_asset(p) {
                        paths.push(p.to_path_buf());
                    }
                });
            }
            paths
        };
        self.assets.current(list, |p| {
            let text = read_text(p)?;
            // A binary-serialized asset (Force Binary) holds nothing readable.
            text.starts_with("%YAML").then(|| parse_asset(&text))
        })
    }

    fn data(&self, root: &Path) -> MutexGuard<'_, Files<DataFile>> {
        self.data.current(
            || unity_data::list(root, |d, f| walk(d, f)),
            unity_data::parse,
        )
    }
}

#[derive(Default)]
pub struct UnityIndexes {
    roots: Mutex<HashMap<PathBuf, Arc<Index>>>,
}

impl UnityIndexes {
    fn index(&self, root: &Path) -> Arc<Index> {
        self.roots
            .lock()
            .entry(root.to_path_buf())
            .or_default()
            .clone()
    }

    /// Marks changed scripts and assets of a project indexed before, to be read again.
    pub fn changed(&self, change: &FsChange) {
        let Some(index) = self.roots.lock().get(Path::new(&change.root)).cloned() else {
            return;
        };
        if change.overflow || change.lost {
            index.scripts.changed_all();
            index.assets.changed_all();
            index.data.changed_all();
            return;
        }
        let root = Path::new(&change.root);
        for f in change
            .files
            .iter()
            .chain(&change.created)
            .chain(&change.removed)
        {
            let p = Path::new(f);
            if is_script(p) {
                index.scripts.changed(p);
            } else if is_asset(p) {
                index.assets.changed(p);
            }
            if unity_data::is_data_file(root, p) {
                index.data.changed(p);
            } else if let Some(asmdef) = f.strip_suffix(".meta").filter(|a| a.ends_with(".asmdef"))
            {
                // A new GUID for the assembly.
                index.data.changed(Path::new(asmdef));
            }
        }
    }

    pub fn forget(&self, root: &Path) {
        self.roots.lock().remove(root);
    }

    /// Reads a project's scripts, its settings, then its assets, so that queries answer at once.
    pub fn warm(&self, root: &Path) {
        let index = self.index(root);
        drop(index.scripts(root));
        drop(index.data(root));
        drop(index.assets(root));
    }

    /// What the project's settings and assets name: tags, layers, scenes, assemblies…
    pub fn project_data(&self, root: &Path) -> ProjectData {
        let index = self.index(root);
        let data = index.data(root);
        unity_data::collect(root, data.parsed.iter(), |d, f| walk(d, f))
    }

    /// Every class of the project and its packages, with the bases each declaration lists.
    pub fn classes(&self, root: &Path) -> HashMap<String, Vec<String>> {
        let index = self.index(root);
        let scripts = index.scripts(root);
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for c in scripts.parsed.values().flatten() {
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
        let assets = index.assets(root);
        let mut out = AssetUsages::default();
        let mut paths: Vec<&PathBuf> = assets.parsed.keys().collect();
        paths.sort();
        for path in paths {
            let file = &assets.parsed[path];
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
    static COMMENTS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?s)//[^\n]*|/\*.*?\*/"#).unwrap());
    static DECL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\b(?:class|struct|record)\s+(?P<name>[A-Za-z_]\w*)(?P<rest>[^{;]*)[{;]")
            .unwrap()
    });
    let code = COMMENTS.replace_all(text, " ");
    DECL.captures_iter(&code)
        .map(|c| {
            let rest = strip_type_args(&c["rest"]);
            // Constraints come last: "where T : Component" lists no base.
            let rest = rest.split(" where ").next().unwrap_or(&rest).to_string();
            // Primary constructor parameters (records), then " : Bases where ...".
            let rest = match (rest.find('('), rest.find(':')) {
                (Some(p), Some(colon)) if p < colon => {
                    rest[rest.find(')').map_or(0, |i| i + 1)..].to_string()
                }
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
    static HEADER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^--- !u!(\d+) &(-?\d+)").unwrap());
    static SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^m_Script: \{fileID: -?\d+, guid: ([0-9a-f]{32}), type: \d\}").unwrap()
    });

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
        // Most lines are other properties: told apart by their first bytes, no regex.
        let t = line.trim_start();
        if !(t.starts_with("m_") || t.starts_with("- m_Target:")) {
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
        if let Some(id) = line.strip_prefix("  m_GameObject: {fileID: ") {
            doc_object = id
                .trim_end_matches('}')
                .trim()
                .parse()
                .ok()
                .filter(|id| *id != 0);
        } else if let Some(c) = t
            .starts_with("m_Script:")
            .then(|| SCRIPT.captures(t))
            .flatten()
        {
            out.scripts.push(ScriptRef {
                guid: c[1].to_string(),
                line: n,
                object: None,
                file_id: doc_id_text.clone(),
            });
            script_owner.push(doc_object);
        } else if t.starts_with("- m_Target:") {
            call_type = None;
        } else if let Some(t) = t.strip_prefix("m_TargetAssemblyTypeName: ") {
            // "Game.UI.Menu+Panel, Assembly-CSharp" is "Panel".
            let t = t.split(',').next().unwrap_or(t).trim();
            call_type = Some(t.rsplit(['.', '+']).next().unwrap_or(t).to_string())
                .filter(|t| !t.is_empty());
        } else if let Some(m) = t.strip_prefix("m_MethodName: ") {
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
        assert_eq!(
            get("Enemy"),
            Some(vec!["Character".into(), "IDamageable".into()])
        );
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
        assert_eq!(
            (file.scripts[0].line, file.scripts[0].file_id.as_deref()),
            (9, Some("200"))
        );
        assert_eq!(file.scripts[0].object.as_deref(), Some("Player"));
        assert_eq!(file.calls.len(), 1);
        let call = &file.calls[0];
        assert_eq!(
            (call.type_name.as_deref(), call.method.as_str(), call.line),
            (Some("Player"), "Jump", 22)
        );
        assert_eq!(call.object.as_deref(), Some("PlayButton"));
    }

    /// `HAZE_BENCH_UNITY=/path/to/UnityProject cargo test --release --lib bench_index -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_index() {
        let Ok(root) = std::env::var("HAZE_BENCH_UNITY") else {
            return;
        };
        let root = Path::new(&root);
        let indexes = UnityIndexes::default();
        let started = std::time::Instant::now();
        let classes = indexes.classes(root);
        let scripts = started.elapsed();
        let started = std::time::Instant::now();
        let any = root.join("Assets/Bench/S0.cs");
        let _ = indexes.asset_usages(root, &any, &["S0".into()]);
        let assets = started.elapsed();
        let index = indexes.index(root);
        let (n_scripts, n_assets) = (
            index.scripts.files.lock().parsed.len(),
            index.assets.files.lock().parsed.len(),
        );
        let started = std::time::Instant::now();
        let _ = indexes.asset_usages(root, &any, &["S0".into()]);
        println!(
            "{n_scripts} scripts ({} classes) in {scripts:?}, {n_assets} assets in {assets:?}, query in {:?}",
            classes.len(),
            started.elapsed()
        );
    }

    #[test]
    fn indexes_a_project_and_follows_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Assets/Scripts")).unwrap();
        std::fs::create_dir_all(root.join("Assets/Ignored~")).unwrap();
        std::fs::create_dir_all(root.join("Library/PackageCache/com.unity.ugui/Runtime")).unwrap();
        let player = root.join("Assets").join("Scripts").join("Player.cs");
        std::fs::write(&player, "class Player : Character {}").unwrap();
        std::fs::write(
            root.join("Assets/Scripts/Player.cs.meta"),
            "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n",
        )
        .unwrap();
        std::fs::write(
            root.join("Assets/Ignored~/X.cs"),
            "class Hidden : MonoBehaviour {}",
        )
        .unwrap();
        std::fs::write(
            root.join("Library/PackageCache/com.unity.ugui/Runtime/UIBehaviour.cs"),
            "abstract class UIBehaviour : MonoBehaviour {}",
        )
        .unwrap();
        // Native separators: the index reports paths as the OS spells them.
        let scene = root.join("Assets").join("Main.unity");
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
        std::fs::write(
            &scene,
            "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Empty\n",
        )
        .unwrap();
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

        // Too much changed to list (a checkout): everything is read again.
        std::fs::write(
            root.join("Assets/Scripts/Enemy.cs"),
            "class Enemy : MonoBehaviour {}",
        )
        .unwrap();
        indexes.changed(&FsChange {
            root: root.to_string_lossy().into_owned(),
            dirs: vec![],
            files: vec![],
            created: vec![],
            removed: vec![],
            overflow: true,
            lost: false,
            git: false,
        });
        assert_eq!(
            indexes.classes(root)["Enemy"],
            vec!["MonoBehaviour".to_string()]
        );
    }

    #[test]
    fn reads_project_data_and_follows_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |rel: &str, text: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write(
            "ProjectSettings/TagManager.asset",
            "%YAML 1.1\nTagManager:\n  tags:\n  - Enemy\n  layers:\n  - Default\n  - Ground\n",
        );
        write(
            "ProjectSettings/EditorBuildSettings.asset",
            "%YAML 1.1\nEditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Menu.unity\n",
        );
        write("Assets/Scenes/Menu.unity", "%YAML 1.1\n");
        write("Assets/Scenes/Test.unity", "%YAML 1.1\n");
        write("Assets/Resources/UI/Icon.png", "png");
        write("Assets/Resources/UI/Icon.png.meta", "guid: 1");
        write(
            "Assets/Art/Hero.controller",
            "%YAML 1.1\n--- !u!1102 &1\nAnimatorState:\n  m_Name: Run\n",
        );
        write("Assets/Shaders/Water.shader", "Shader \"Custom/Water\" {}");
        write(
            "Assets/Game/Game.asmdef",
            r#"{"name": "Game", "references": []}"#,
        );
        write(
            "Assets/Game/Game.asmdef.meta",
            "guid: 0123456789abcdef0123456789abcdef\n",
        );
        write(
            "Library/PackageCache/com.unity.textmeshpro/Resources/TMP Settings.asset",
            "%YAML 1.1\n",
        );
        write("Library/ScriptAssemblies/Unity.TextMeshPro.dll", "");
        // A built-in package of the Unity Editor the projects reference.
        let editor = root.join("Editor/Data");
        write(
            "Editor/Data/Resources/PackageManager/BuiltInPackages/com.unity.ugui/Runtime/UnityEngine.UI.asmdef",
            r#"{"name": "UnityEngine.UI"}"#,
        );
        let dll = editor.join("Managed/UnityEngine/UnityEngine.dll");
        write(
            "Game.csproj",
            &format!(
                "<Project><Reference><HintPath>{}</HintPath></Reference></Project>",
                dll.display()
            ),
        );

        let indexes = UnityIndexes::default();
        let data = indexes.project_data(root);
        assert!(data.tags.as_ref().unwrap().contains(&"Enemy".to_string()));
        assert!(data
            .tags
            .as_ref()
            .unwrap()
            .contains(&"Untagged".to_string()));
        assert_eq!(data.layers.as_deref().unwrap(), ["Default", "Ground"]);
        assert_eq!(data.axes, None);
        assert_eq!(data.build_scenes.as_ref().unwrap().len(), 1);
        assert_eq!(
            data.scenes,
            ["Assets/Scenes/Menu.unity", "Assets/Scenes/Test.unity"]
        );
        assert_eq!(data.resources, ["TMP Settings.asset", "UI/Icon.png"]);
        assert_eq!(data.animator_states.as_deref().unwrap(), ["Run"]);
        assert_eq!(data.shaders, ["Custom/Water"]);
        let names: Vec<_> = data.assemblies.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"Game") && names.contains(&"UnityEngine.UI"));
        let game = data.assemblies.iter().find(|a| a.name == "Game").unwrap();
        assert_eq!(
            game.guid.as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(data.compiled, ["Unity.TextMeshPro"]);
        assert!(data.assemblies_complete);

        // A tag added in Unity, a scene deleted.
        write(
            "ProjectSettings/TagManager.asset",
            "%YAML 1.1\nTagManager:\n  tags:\n  - Enemy\n  - Boss\n  layers:\n  - Default\n",
        );
        std::fs::remove_file(root.join("Assets/Scenes/Test.unity")).unwrap();
        let path = |rel: &str| root.join(rel).to_string_lossy().into_owned();
        indexes.changed(&FsChange {
            root: root.to_string_lossy().into_owned(),
            dirs: vec![],
            files: vec![path("ProjectSettings/TagManager.asset")],
            created: vec![],
            removed: vec![path("Assets/Scenes/Test.unity")],
            overflow: false,
            lost: false,
            git: false,
        });
        let data = indexes.project_data(root);
        assert!(data.tags.as_ref().unwrap().contains(&"Boss".to_string()));
        assert_eq!(data.scenes, ["Assets/Scenes/Menu.unity"]);
    }
}

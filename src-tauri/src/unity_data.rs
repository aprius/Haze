//! What a Unity project's settings and assets name, to check the strings
//! scripts pass to Unity (tags, layers, input axes, scenes, Resources paths,
//! Animator states, shaders) and the references of assembly definitions.
//! Read from the project's text-serialized files, without Unity running; kept
//! up to date by the index in unity_index.rs.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

/// Tags every project has; TagManager.asset lists only the project's own.
const BUILTIN_TAGS: &[&str] = &[
    "Untagged",
    "Respawn",
    "Finish",
    "EditorOnly",
    "MainCamera",
    "Player",
    "GameController",
];

const SETTINGS: &[&str] = &[
    "TagManager.asset",
    "InputManager.asset",
    "EditorBuildSettings.asset",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BuildScene {
    /// "Assets/Scenes/Main.unity".
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Assembly {
    pub name: String,
    /// From the `.asmdef.meta`.
    pub guid: Option<String>,
    pub path: String,
}

/// What one file contributes.
#[derive(Debug, Clone, PartialEq)]
pub enum DataFile {
    Tags {
        tags: Vec<String>,
        layers: Vec<String>,
    },
    Axes(Vec<String>),
    BuildScenes(Vec<BuildScene>),
    Scene,
    /// The states of an Animator Controller.
    Controller(Vec<String>),
    Shader(String),
    AsmDef(Assembly),
    /// A file only its path matters for: an asset in a Resources folder.
    Other,
}

/// What the strings in scripts are checked against. A list that is `None`
/// could not be read (the file is missing, or serialized as binary): its
/// check is skipped rather than reporting everything.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    pub tags: Option<Vec<String>>,
    /// Named layers, by index order.
    pub layers: Option<Vec<String>>,
    pub axes: Option<Vec<String>>,
    pub build_scenes: Option<Vec<BuildScene>>,
    /// Every scene in Assets and embedded packages: "Assets/Scenes/Main.unity".
    pub scenes: Vec<String>,
    /// Assets in Resources folders, by their path inside the folder, extension kept: "UI/Icon.png".
    pub resources: Vec<String>,
    /// None when the project has no Animator Controller to read.
    pub animator_states: Option<Vec<String>>,
    /// Shaders and Shader Graphs of the project and its packages (built-in ones are not files).
    pub shaders: Vec<String>,
    /// Assembly definitions of the project, its packages and Unity's built-in packages.
    pub assemblies: Vec<Assembly>,
    /// Assemblies Unity compiled (Library/ScriptAssemblies).
    pub compiled: Vec<String>,
    /// Whether every assembly a definition can reference is in `assemblies`
    /// or `compiled`: false when the project uses built-in packages with code
    /// whose folder (in the Unity Editor's install) was not found.
    pub assemblies_complete: bool,
}

fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
}

fn parts(root: &Path, path: &Path) -> Option<Vec<String>> {
    let rel = path.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect(),
    )
}

/// The path of an asset inside its Resources folder (the innermost one), if it is in one.
fn resource_path(parts: &[String]) -> Option<String> {
    let at = parts[..parts.len().saturating_sub(1)]
        .iter()
        .rposition(|p| p == "Resources")?;
    Some(parts[at + 1..].join("/"))
}

/// Whether a file of a Unity project (`root`) holds something `ProjectData` lists.
pub fn is_data_file(root: &Path, path: &Path) -> bool {
    let Some(parts) = parts(root, path) else {
        return false;
    };
    let (Some(first), Some(name)) = (parts.first(), parts.last()) else {
        return false;
    };
    if first == "ProjectSettings" {
        return parts.len() == 2 && SETTINGS.contains(&name.as_str());
    }
    let cache = first == "Library" && parts.get(1).is_some_and(|p| p == "PackageCache");
    if !(first == "Assets" || first == "Packages" || cache) {
        return false;
    }
    // Unity skips hidden folders and `name~` ones.
    if parts.iter().any(|p| p.starts_with('.') || p.ends_with('~')) {
        return false;
    }
    let ext = ext_of(Path::new(name));
    let ext = ext.as_deref().unwrap_or("");
    if matches!(ext, "shader" | "shadergraph" | "asmdef") {
        return true;
    }
    // Scenes and controllers in the package cache are read-only and rarely matter.
    if !cache && matches!(ext, "unity" | "controller") {
        return true;
    }
    !matches!(ext, "meta" | "cs") && resource_path(&parts).is_some()
}

/// Lists the files `is_data_file` accepts.
pub fn list(root: &Path, walk: impl Fn(&Path, &mut dyn FnMut(&Path))) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = SETTINGS
        .iter()
        .map(|f| root.join("ProjectSettings").join(f))
        .filter(|p| p.is_file())
        .collect();
    for dir in [
        root.join("Assets"),
        root.join("Packages"),
        root.join("Library").join("PackageCache"),
    ] {
        walk(&dir, &mut |p| {
            if is_data_file(root, p) {
                out.push(p.to_path_buf());
            }
        });
    }
    out
}

/// Reads what a data file holds; None when it is gone or unreadable.
pub fn parse(path: &Path) -> Option<DataFile> {
    if !path.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy();
    let read = || {
        std::fs::read(path)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    // Force Binary serialization: nothing readable.
    let yaml = || read().filter(|t| t.starts_with("%YAML"));
    Some(match name.as_ref() {
        "TagManager.asset" => {
            let (tags, layers) = parse_tag_manager(&yaml()?);
            DataFile::Tags { tags, layers }
        }
        "InputManager.asset" => DataFile::Axes(parse_input_manager(&yaml()?)),
        "EditorBuildSettings.asset" => DataFile::BuildScenes(parse_build_settings(&yaml()?)),
        _ => match ext_of(path).as_deref() {
            Some("unity") => DataFile::Scene,
            Some("controller") => DataFile::Controller(parse_controller(&yaml()?)),
            Some("shader") => parse_shader(&read()?).map_or(DataFile::Other, DataFile::Shader),
            Some("shadergraph") => DataFile::Shader(shader_graph_name(path, &read()?)),
            Some("asmdef") => DataFile::AsmDef(parse_asmdef(path, &read()?)?),
            _ => DataFile::Other,
        },
    })
}

/// A list item of a YAML sequence: `  - Enemy`, quotes removed.
fn item(line: &str) -> Option<String> {
    let v = line.trim_start().strip_prefix('-')?.trim();
    let v = v
        .strip_prefix('\'')
        .and_then(|v| v.strip_suffix('\''))
        .or_else(|| v.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
        .unwrap_or(v);
    Some(v.to_string())
}

fn parse_tag_manager(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut tags, mut layers) = (vec![], vec![]);
    let mut section = "";
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('-') {
            if let Some(v) = item(t).filter(|v| !v.is_empty()) {
                match section {
                    "tags" => tags.push(v),
                    "layers" => layers.push(v),
                    _ => {}
                }
            }
            continue;
        }
        section = match t {
            "tags:" => "tags",
            "layers:" => "layers",
            _ => "",
        };
    }
    (tags, layers)
}

fn parse_input_manager(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("m_Name:"))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

fn parse_build_settings(text: &str) -> Vec<BuildScene> {
    let mut out: Vec<BuildScene> = vec![];
    let mut in_scenes = false;
    for line in text.lines() {
        let t = line.trim();
        if !line.starts_with("  ") || line.starts_with("  m_") {
            in_scenes = t == "m_Scenes:";
            continue;
        }
        if !in_scenes {
            continue;
        }
        // A new item starts with `- `, its keys in any order.
        let (start, kv) = match t.strip_prefix("- ") {
            Some(rest) => (true, rest),
            None => (false, t),
        };
        if start {
            out.push(BuildScene {
                path: String::new(),
                enabled: true,
            });
        }
        let Some(scene) = out.last_mut() else {
            continue;
        };
        if let Some(v) = kv.strip_prefix("enabled:") {
            scene.enabled = v.trim() != "0";
        } else if let Some(v) = kv.strip_prefix("path:") {
            scene.path = v.trim().to_string();
        }
    }
    out.retain(|s| !s.path.is_empty());
    out
}

/// The names of an Animator Controller's states (class 1102), in every layer and sub-state machine.
fn parse_controller(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut state = false;
    for line in text.lines() {
        if line.starts_with("---") {
            state = line.starts_with("--- !u!1102 ");
        } else if state {
            if let Some(name) = line.strip_prefix("  m_Name: ") {
                out.push(name.trim().to_string());
            }
        }
    }
    out
}

/// `Shader "Custom/Water" {`: the name, unless it is in a comment.
fn parse_shader(text: &str) -> Option<String> {
    static NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?m)^\s*Shader\s*"([^"]+)""#).unwrap());
    static BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
    let code = BLOCK.replace_all(text, "");
    NAME.captures(&code).map(|c| c[1].to_string())
}

/// A Shader Graph's shader is named by the graph's path setting and its file name.
fn shader_graph_name(path: &Path, text: &str) -> String {
    static PATH: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""m_Path"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match PATH.captures(text).map(|c| c[1].replace("\\/", "/")) {
        Some(p) if !p.is_empty() => format!("{}/{stem}", p.trim_end_matches('/')),
        Some(_) => stem,
        None => format!("Shader Graphs/{stem}"),
    }
}

fn parse_asmdef(path: &Path, text: &str) -> Option<Assembly> {
    let json: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let name = json["name"].as_str()?.to_string();
    let mut meta = path.as_os_str().to_owned();
    meta.push(".meta");
    let guid = std::fs::read_to_string(PathBuf::from(meta))
        .ok()
        .and_then(|t| {
            t.lines()
                .find_map(|l| l.strip_prefix("guid: "))
                .map(|g| g.trim().to_string())
        });
    Some(Assembly {
        name,
        guid,
        path: path.to_string_lossy().into_owned(),
    })
}

/// `<Editor>/Data/Resources/PackageManager/BuiltInPackages` of the Unity Editor
/// the generated projects reference (`.../Managed/UnityEngine/UnityEngine.dll`).
fn builtin_packages_dir(root: &Path) -> Option<PathBuf> {
    static HINT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<HintPath>([^<]*?)[\\/]Managed[\\/]UnityEngine[\\/][^<]*\.dll</HintPath>")
            .unwrap()
    });
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if ext_of(&path).as_deref() != Some("csproj") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(c) = HINT.captures(&text) {
            let dir = Path::new(&c[1])
                .join("Resources")
                .join("PackageManager")
                .join("BuiltInPackages");
            return dir.is_dir().then_some(dir);
        }
    }
    None
}

/// Whether the project uses built-in packages that have code (all but Unity's modules).
fn uses_builtin_code(root: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join("Packages").join("packages-lock.json")) else {
        // Unknown: assume so.
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    json["dependencies"].as_object().is_some_and(|deps| {
        deps.iter().any(|(name, d)| {
            d["source"].as_str() == Some("builtin") && !name.starts_with("com.unity.modules.")
        })
    })
}

/// Puts together what the data files hold.
pub fn collect<'a>(
    root: &Path,
    files: impl Iterator<Item = (&'a PathBuf, &'a DataFile)>,
    walk: impl Fn(&Path, &mut dyn FnMut(&Path)),
) -> ProjectData {
    let mut out = ProjectData::default();
    let mut scenes = BTreeSet::new();
    let mut resources = BTreeSet::new();
    let mut states: Option<BTreeSet<String>> = None;
    let mut shaders = BTreeSet::new();
    for (path, file) in files {
        let parts = parts(root, path).unwrap_or_default();
        if let Some(r) = resource_path(&parts) {
            resources.insert(r);
        }
        match file {
            DataFile::Tags { tags, layers } => {
                let mut all: Vec<String> = BUILTIN_TAGS.iter().map(|t| t.to_string()).collect();
                all.extend(
                    tags.iter()
                        .filter(|t| !BUILTIN_TAGS.contains(&t.as_str()))
                        .cloned(),
                );
                out.tags = Some(all);
                out.layers = Some(layers.clone());
            }
            DataFile::Axes(axes) => out.axes = Some(axes.clone()),
            DataFile::BuildScenes(s) => out.build_scenes = Some(s.clone()),
            DataFile::Scene => {
                scenes.insert(parts.join("/"));
            }
            DataFile::Controller(s) => states.get_or_insert_default().extend(s.iter().cloned()),
            DataFile::Shader(s) => {
                shaders.insert(s.clone());
            }
            DataFile::AsmDef(a) => out.assemblies.push(a.clone()),
            DataFile::Other => {}
        }
    }
    let builtin = builtin_packages_dir(root);
    if let Some(dir) = &builtin {
        walk(dir, &mut |p| {
            if ext_of(p).as_deref() == Some("asmdef") {
                if let Some(a) = std::fs::read_to_string(p)
                    .ok()
                    .and_then(|t| parse_asmdef(p, &t))
                {
                    out.assemblies.push(a);
                }
            } else if ext_of(p).as_deref() == Some("shader") {
                if let Some(s) = std::fs::read_to_string(p)
                    .ok()
                    .and_then(|t| parse_shader(&t))
                {
                    shaders.insert(s);
                }
            }
        });
    }
    out.assemblies.sort_by(|a, b| a.path.cmp(&b.path));
    out.assemblies_complete = builtin.is_some() || !uses_builtin_code(root);
    if let Ok(dir) = std::fs::read_dir(root.join("Library").join("ScriptAssemblies")) {
        let mut names: Vec<String> = dir
            .flatten()
            .map(|e| e.path())
            .filter(|p| ext_of(p).as_deref() == Some("dll"))
            .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .collect();
        names.sort();
        out.compiled = names;
    }
    out.scenes = scenes.into_iter().collect();
    out.resources = resources.into_iter().collect();
    out.animator_states = states.map(|s| s.into_iter().collect());
    out.shaders = shaders.into_iter().collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tags_and_layers() {
        let text = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!78 &1\nTagManager:\n  serializedVersion: 2\n  tags:\n  - Enemy\n  - 'Boss Room'\n  layers:\n  - Default\n  - TransparentFX\n  - Ignore Raycast\n  - \n  - Water\n  - UI\n  - Ground\n  m_SortingLayers:\n  - name: Default\n    uniqueID: 0\n";
        let (tags, layers) = parse_tag_manager(text);
        assert_eq!(tags, ["Enemy", "Boss Room"]);
        assert_eq!(
            layers,
            [
                "Default",
                "TransparentFX",
                "Ignore Raycast",
                "Water",
                "UI",
                "Ground"
            ]
        );
        assert_eq!(
            parse_tag_manager("TagManager:\n  tags: []\n  layers:\n  - Default\n"),
            (vec![], vec!["Default".to_string()])
        );
    }

    #[test]
    fn reads_axes_scenes_states_and_shaders() {
        let input = "InputManager:\n  m_Axes:\n  - serializedVersion: 3\n    m_Name: Horizontal\n    descriptiveName: \n  - serializedVersion: 3\n    m_Name: Fire1\n";
        assert_eq!(parse_input_manager(input), ["Horizontal", "Fire1"]);

        let build = "EditorBuildSettings:\n  serializedVersion: 2\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Menu.unity\n    guid: 1\n  - enabled: 0\n    path: Assets/Scenes/Test.unity\n    guid: 2\n  m_configObjects: {}\n";
        assert_eq!(
            parse_build_settings(build),
            [
                BuildScene {
                    path: "Assets/Scenes/Menu.unity".into(),
                    enabled: true
                },
                BuildScene {
                    path: "Assets/Scenes/Test.unity".into(),
                    enabled: false
                }
            ]
        );
        assert!(parse_build_settings("EditorBuildSettings:\n  m_Scenes: []\n").is_empty());

        let controller = "%YAML 1.1\n--- !u!1107 &1\nAnimatorStateMachine:\n  m_Name: Base Layer\n--- !u!1102 &2\nAnimatorState:\n  m_Name: Run\n  m_Speed: 1\n--- !u!1102 &3\nAnimatorState:\n  m_Name: Jump Start\n";
        assert_eq!(parse_controller(controller), ["Run", "Jump Start"]);

        assert_eq!(
            parse_shader(
                "// Shader \"Old\"\n/* Shader \"Older\" */\nShader \"Custom/Water\"\n{\n}"
            ),
            Some("Custom/Water".into())
        );
        let graph = Path::new("Assets/Lava.shadergraph");
        assert_eq!(
            shader_graph_name(graph, r#"{"m_Type": "GraphData", "m_Path": "FX\/Hot"}"#),
            "FX/Hot/Lava"
        );
        assert_eq!(shader_graph_name(graph, "{}"), "Shader Graphs/Lava");
    }

    #[test]
    fn tells_data_files_apart() {
        let root = Path::new("/p");
        let yes = [
            "/p/ProjectSettings/TagManager.asset",
            "/p/Assets/Scenes/Main.unity",
            "/p/Assets/Art/Hero.controller",
            "/p/Assets/Resources/UI/Icon.png",
            "/p/Packages/com.a/Runtime/A.asmdef",
            "/p/Library/PackageCache/com.unity.ugui/Shaders/UI.shader",
            "/p/Library/PackageCache/com.unity.textmeshpro/Resources/TMP Settings.asset",
        ];
        let no = [
            "/p/ProjectSettings/ProjectSettings.asset",
            "/p/Assets/Resources/UI/Icon.png.meta",
            "/p/Assets/Resources/Loader.cs",
            "/p/Assets/Art/Icon.png",
            "/p/Assets/Resources",
            "/p/Assets/.hidden/Resources/A.png",
            "/p/Assets/Samples~/Resources/A.png",
            "/p/Library/PackageCache/com.a/Scenes/Demo.unity",
            "/p/Library/ScriptAssemblies/A.dll",
        ];
        for p in yes {
            assert!(is_data_file(root, Path::new(p)), "{p}");
        }
        for p in no {
            assert!(!is_data_file(root, Path::new(p)), "{p}");
        }
        let parts: Vec<String> = ["Assets", "Resources", "UI", "Resources", "Icon.png"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(resource_path(&parts).as_deref(), Some("Icon.png"));
    }
}

//! Rider's merge for Unity scenes, prefabs and other Unity YAML: UnityYAMLMerge
//! (Unity's Smart Merge, shipped with the Editor) merges them by meaning
//! first, as Rider does by default; only what it cannot resolve is left to the
//! merge window.
//!
//! With `--fallback none` UnityYAMLMerge writes a clean-looking file even when
//! conflicts remain (exit 2 or 3), filling each with one side's value. So it
//! runs three times: conflicts filled from mine (`-r`), from theirs (`-l`) and
//! from the base (no flag). These are Unity's "premerged" versions, which
//! differ only at the remaining conflicts; a three-way merge of them in the
//! merge window shows exactly those.

use crate::text::{self, Decoded};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Longest a UnityYAMLMerge run may take before the merge window falls back to its own merge.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Extensions of the YAML files Unity serializes (it merges .unity, .prefab
/// and .meta by default; `--force` takes the rest).
const EXTENSIONS: &[&str] = &[
    "unity",
    "prefab",
    "meta",
    "asset",
    "mat",
    "controller",
    "overridecontroller",
    "anim",
    "mask",
    "playable",
    "physicmaterial",
    "physicsmaterial2d",
    "preset",
    "spriteatlas",
    "lighting",
    "mixer",
    "rendertexture",
    "terrainlayer",
    "signal",
    "brush",
    "flare",
    "guiskin",
    "fontsettings",
    "cubemap",
];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnityPremerge {
    /// The UnityYAMLMerge that ran.
    pub tool: String,
    /// Conflicts remain; without them `mine`, `base` and `theirs` are all the merged file.
    pub conflicts: bool,
    pub mine: String,
    pub base: String,
    pub theirs: String,
}

pub fn is_unity_yaml(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Text serialization only: a binary-serialized asset is not YAML.
fn is_yaml(bytes: &[u8]) -> bool {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes).starts_with(b"%YAML")
}

/// UnityYAMLMerge's merge of conflicted `rel`; `None` when it does not apply
/// (not Unity YAML, a side deleted, no Unity installed), so the merge window
/// falls back to its own line merge.
pub fn premerge(root: &Path, rel: &str) -> Result<Option<UnityPremerge>> {
    if !is_unity_yaml(rel) {
        return Ok(None);
    }
    let stage = |n: &str| crate::git_ops::bytes_at(root, &format!(":{n}"), rel);
    let (Some(base), Some(mine), Some(theirs)) = (stage("1")?, stage("2")?, stage("3")?) else {
        return Ok(None);
    };
    if ![&base, &mine, &theirs].iter().all(|b| is_yaml(b)) {
        return Ok(None);
    }
    let Some(tool) = find_tool(&project_of_file(root, rel)) else {
        return Ok(None);
    };
    let ext = Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("unity");
    run_three(&tool, ext, &base, &mine, &theirs).map(Some)
}

fn decode(bytes: &[u8]) -> Result<String> {
    match text::decode(bytes) {
        Decoded::Text { content, .. } => Ok(content),
        Decoded::Binary => bail!("UnityYAMLMerge wrote a binary file"),
    }
}

/// Runs `tool` on the three versions: once if it merges cleanly, else three times (see the module doc).
fn run_three(tool: &Path, ext: &str, base: &[u8], mine: &[u8], theirs: &[u8]) -> Result<UnityPremerge> {
    let dir = tempfile::tempdir()?;
    // Same extension as the file: UnityYAMLMerge goes by it.
    let file = |name: &str| dir.path().join(format!("{name}.{ext}"));
    let (base_f, mine_f, theirs_f) = (file("base"), file("mine"), file("theirs"));
    std::fs::write(&base_f, base)?;
    std::fs::write(&mine_f, mine)?;
    std::fs::write(&theirs_f, theirs)?;
    let run = |flag: Option<&str>, out: &Path| -> Result<i32> {
        let mut cmd = Command::new(tool);
        cmd.args(["merge", "-h", "--fallback", "none", "--force"]);
        if let Some(flag) = flag {
            cmd.arg(flag);
        }
        // Argument order: base, theirs, mine, output.
        cmd.arg(&base_f).arg(&theirs_f).arg(&mine_f).arg(out);
        // Its report goes to a file, not a pipe: a full pipe would stall it while it is waited on.
        let log_path = out.with_extension("log");
        let log = std::fs::File::create(&log_path)?;
        cmd.stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().with_context(|| format!("running {}", tool.display()))?;
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if started.elapsed() > TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                bail!("UnityYAMLMerge did not finish in {} s", TIMEOUT.as_secs());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let code = status.code().unwrap_or(-1);
        if !matches!(code, 0 | 2 | 3) {
            let why = std::fs::read(&log_path).unwrap_or_default();
            bail!("UnityYAMLMerge failed (exit {code}): {}", String::from_utf8_lossy(&why).trim());
        }
        Ok(code)
    };
    let mine_out = file("merged-mine");
    let tool_name = tool.display().to_string();
    if run(Some("-r"), &mine_out)? == 0 {
        let merged = decode(&std::fs::read(&mine_out)?)?;
        return Ok(UnityPremerge { tool: tool_name, conflicts: false, mine: merged.clone(), base: merged.clone(), theirs: merged });
    }
    let theirs_out = file("merged-theirs");
    let base_out = file("merged-base");
    // Independent of each other: side by side.
    let (theirs_run, base_run) = std::thread::scope(|s| {
        let theirs = s.spawn(|| run(Some("-l"), &theirs_out));
        let base = run(None, &base_out);
        (theirs.join().unwrap_or_else(|_| Err(anyhow::anyhow!("UnityYAMLMerge run panicked"))), base)
    });
    theirs_run?;
    base_run?;
    Ok(UnityPremerge {
        tool: tool_name,
        conflicts: true,
        mine: decode(&std::fs::read(&mine_out)?)?,
        base: decode(&std::fs::read(&base_out)?)?,
        theirs: decode(&std::fs::read(&theirs_out)?)?,
    })
}

/// The Unity project holding `rel`: the nearest folder up from it that is one, else `root`.
fn project_of_file(root: &Path, rel: &str) -> PathBuf {
    let mut dir = root.join(rel);
    while dir.pop() && dir.starts_with(root) {
        if crate::unity::is_unity_project(&dir) {
            return dir;
        }
    }
    root.to_path_buf()
}

/// `m_EditorVersion` of the project's `ProjectSettings/ProjectVersion.txt`.
fn project_version(project: &Path) -> Option<String> {
    let text = std::fs::read_to_string(project.join("ProjectSettings/ProjectVersion.txt")).ok()?;
    text.lines()
        .find_map(|l| l.trim().strip_prefix("m_EditorVersion:"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// UnityYAMLMerge inside an Editor: `editor` is `Unity.app` on macOS, else the folder holding `Unity(.exe)`.
fn tool_in(editor: &Path) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![editor.join("Contents/Helpers/UnityYAMLMerge"), editor.join("Contents/Tools/UnityYAMLMerge")]
    } else if cfg!(windows) {
        vec![editor.join("Data/Tools/UnityYAMLMerge.exe")]
    } else {
        vec![editor.join("Data/Tools/UnityYAMLMerge")]
    };
    candidates.into_iter().find(|p| p.is_file())
}

/// The Editor inside a Unity Hub version folder.
fn editor_of_version(version_dir: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        version_dir.join("Unity.app")
    } else {
        version_dir.join("Editor")
    }
}

/// Folders where Unity Hub installs Editors: its default and the one set in Hub.
fn hub_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(target_os = "macos") {
        roots.push(PathBuf::from("/Applications/Unity/Hub/Editor"));
    } else if cfg!(windows) {
        roots.push(PathBuf::from(r"C:\Program Files\Unity\Hub\Editor"));
    } else if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Unity/Hub/Editor"));
    }
    // Hub keeps a custom install folder as a JSON string.
    if let Some(custom) = dirs::config_dir()
        .and_then(|c| std::fs::read(c.join("UnityHub/secondaryInstallPath.json")).ok())
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .filter(|p| !p.is_empty())
    {
        roots.insert(0, PathBuf::from(custom));
    }
    roots
}

/// The UnityYAMLMerge of the Editor the project last ran, else of its Unity
/// version in Unity Hub, else of the newest Editor installed.
fn find_tool(project: &Path) -> Option<PathBuf> {
    if let Some(app) = crate::unity_worktree::editor_instance(project)
        .and_then(|i| i.get("app_path").and_then(|a| a.as_str()).map(PathBuf::from))
    {
        let editor = if cfg!(target_os = "macos") { app.clone() } else { app.parent().map(Path::to_path_buf).unwrap_or(app.clone()) };
        if let Some(tool) = tool_in(&editor) {
            return Some(tool);
        }
    }
    find_in_roots(&hub_roots(), project_version(project).as_deref()).or_else(|| {
        cfg!(target_os = "macos").then(|| tool_in(Path::new("/Applications/Unity/Unity.app"))).flatten()
    })
}

/// `6000.6.10f1` → [6000, 6, 10, 1]: numbers compare as numbers, so 6000.6.10 is newer than 6000.6.5.
fn version_key(name: &str) -> Vec<u64> {
    name.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect()
}

fn find_in_roots(roots: &[PathBuf], version: Option<&str>) -> Option<PathBuf> {
    if let Some(v) = version {
        if let Some(tool) = roots.iter().find_map(|r| tool_in(&editor_of_version(&r.join(v)))) {
            return Some(tool);
        }
    }
    // Any installed Editor, newest version first.
    let mut versions: Vec<PathBuf> = roots
        .iter()
        .filter_map(|r| std::fs::read_dir(r).ok())
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort_by_key(|v| std::cmp::Reverse(version_key(&v.file_name().unwrap_or_default().to_string_lossy())));
    versions.iter().find_map(|v| tool_in(&editor_of_version(v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_unity_yaml_files() {
        assert!(is_unity_yaml("Assets/Scenes/Main.unity"));
        assert!(is_unity_yaml("Assets/Prefabs/Player.PREFAB"));
        assert!(is_unity_yaml("Assets/Data/Config.asset"));
        assert!(!is_unity_yaml("Assets/Scripts/Player.cs"));
        assert!(!is_unity_yaml("README"));
        assert!(is_yaml(b"%YAML 1.1\n"));
        assert!(is_yaml(b"\xEF\xBB\xBF%YAML 1.1\n"));
        assert!(!is_yaml(b"\x00\x01binary"));
    }

    #[test]
    fn reads_the_project_version_and_finds_the_project_of_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("Game");
        std::fs::create_dir_all(project.join("Assets/Scenes")).unwrap();
        std::fs::create_dir_all(project.join("ProjectSettings")).unwrap();
        std::fs::write(project.join("ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: x\n").unwrap();
        assert_eq!(project_version(&project).as_deref(), Some("2022.3.10f1"));
        assert_eq!(project_of_file(dir.path(), "Game/Assets/Scenes/Main.unity"), project);
        assert_eq!(project_of_file(dir.path(), "Other/x.prefab"), dir.path());
    }

    #[test]
    fn finds_the_tool_of_the_projects_version_else_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        let place = |v: &str| {
            let editor = editor_of_version(&dir.path().join(v));
            let tool = if cfg!(target_os = "macos") {
                editor.join("Contents/Helpers/UnityYAMLMerge")
            } else if cfg!(windows) {
                editor.join("Data/Tools/UnityYAMLMerge.exe")
            } else {
                editor.join("Data/Tools/UnityYAMLMerge")
            };
            std::fs::create_dir_all(tool.parent().unwrap()).unwrap();
            std::fs::write(&tool, "").unwrap();
            tool
        };
        let old = place("2021.3.1f1");
        place("2023.2.5f1");
        let new = place("2023.2.10f1");
        let roots = [dir.path().to_path_buf()];
        assert_eq!(find_in_roots(&roots, Some("2021.3.1f1")), Some(old));
        assert_eq!(find_in_roots(&roots, Some("6000.0.1f1")), Some(new.clone()));
        assert_eq!(find_in_roots(&roots, None), Some(new));
    }

    /// A stand-in UnityYAMLMerge: conflicts (exit 2) unless mine equals theirs,
    /// filling them from the side its flag names.
    #[cfg(unix)]
    fn fake_tool(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let tool = dir.join("UnityYAMLMerge");
        std::fs::write(
            &tool,
            r#"#!/bin/sh
flag=""
for a in "$@"; do case "$a" in -r|-l) flag="$a";; esac; done
eval "out=\${$#}"
n=$#; base=$(eval echo \${$((n-3))}); theirs=$(eval echo \${$((n-2))}); mine=$(eval echo \${$((n-1))})
if cmp -s "$mine" "$theirs"; then cp "$mine" "$out"; exit 0; fi
case "$flag" in -r) cp "$mine" "$out";; -l) cp "$theirs" "$out";; *) cp "$base" "$out";; esac
exit 2
"#,
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        tool
    }

    #[cfg(unix)]
    #[test]
    fn premerges_with_each_side_filling_the_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let tool = fake_tool(dir.path());
        let p = run_three(&tool, "prefab", b"%YAML\nx: 0\n", b"%YAML\nx: 1\n", b"%YAML\nx: 2\n").unwrap();
        assert!(p.conflicts);
        assert_eq!((p.mine.as_str(), p.base.as_str(), p.theirs.as_str()), ("%YAML\nx: 1\n", "%YAML\nx: 0\n", "%YAML\nx: 2\n"));
        let clean = run_three(&tool, "unity", b"%YAML\nx: 0\n", b"%YAML\nx: 1\n", b"%YAML\nx: 1\n").unwrap();
        assert!(!clean.conflicts);
        assert_eq!(clean.mine, "%YAML\nx: 1\n");
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_failing_tool() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("UnityYAMLMerge");
        std::fs::write(&tool, "#!/bin/sh\necho 'cannot parse' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = run_three(&tool, "unity", b"a", b"b", b"c").unwrap_err().to_string();
        assert!(err.contains("exit 1") && err.contains("cannot parse"), "{err}");
    }

    /// Against the UnityYAMLMerge installed here, if any: `cargo test -- --ignored real_unity`.
    #[test]
    #[ignore]
    fn real_unity_yaml_merge() {
        let Some(tool) = find_in_roots(&hub_roots(), None) else {
            eprintln!("no Unity Editor installed: skipped");
            return;
        };
        let scene = |name: &str, x: i32, y: i32| {
            format!(
                "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &100\nGameObject:\n  m_ObjectHideFlags: 0\n  serializedVersion: 6\n  m_Component:\n  - component: {{fileID: 200}}\n  m_Layer: 0\n  m_Name: {name}\n  m_TagString: Untagged\n  m_IsActive: 1\n--- !u!4 &200\nTransform:\n  m_ObjectHideFlags: 0\n  m_GameObject: {{fileID: 100}}\n  serializedVersion: 2\n  m_LocalRotation: {{x: 0, y: 0, z: 0, w: 1}}\n  m_LocalPosition: {{x: {x}, y: {y}, z: 0}}\n  m_LocalScale: {{x: 1, y: 1, z: 1}}\n  m_Children: []\n  m_Father: {{fileID: 0}}\n"
            )
        };
        // Mine renames and moves to (5, 1); theirs moves to x 7: the position conflicts, the name does not.
        let p = run_three(&tool, "unity", scene("Player", 0, 0).as_bytes(), scene("Hero", 5, 1).as_bytes(), scene("Player", 7, 0).as_bytes()).unwrap();
        assert!(p.conflicts);
        for (text, pos) in [(&p.mine, "{x: 5, y: 1, z: 0}"), (&p.theirs, "{x: 7, y: 0, z: 0}"), (&p.base, "{x: 0, y: 0, z: 0}")] {
            assert!(text.contains("m_Name: Hero"), "{text}");
            assert!(text.contains(&format!("m_LocalPosition: {pos}")), "{text}");
        }
        let clean = run_three(&tool, "unity", scene("Player", 0, 0).as_bytes(), scene("Hero", 0, 0).as_bytes(), scene("Player", 7, 0).as_bytes()).unwrap();
        assert!(!clean.conflicts);
        assert!(clean.mine.contains("m_Name: Hero") && clean.mine.contains("m_LocalPosition: {x: 7, y: 0, z: 0}"), "{}", clean.mine);
    }
}

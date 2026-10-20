//! .NET project discovery (solutions, projects, launch profiles) and builds
//! whose MSBuild diagnostics become the Problems list — the source of truth
//! for errors, instead of language-server guesses.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;

use crate::search::walker;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfile {
    pub name: String,
    pub command_name: String,
    pub application_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DotnetProject {
    pub path: String,
    pub name: String,
    pub is_test: bool,
    /// An app (`OutputType` Exe/WinExe, or a Web/Worker SDK project) rather than a library.
    pub runnable: bool,
    pub launch_profiles: Vec<LaunchProfile>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DotnetInfo {
    pub dotnet_version: Option<String>,
    pub solutions: Vec<String>,
    pub projects: Vec<DotnetProject>,
}

fn is_project_file(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("csproj" | "fsproj" | "vbproj")
    )
}

/// Project paths listed in a `.sln` file, relative to it.
pub fn parse_sln(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.trim_start().starts_with("Project("))
        .filter_map(|l| l.split(',').nth(1))
        .map(|p| p.trim().trim_matches('"').replace('\\', "/"))
        .filter(|p| is_project_file(Path::new(p)))
        .collect()
}

/// Project paths listed in a `.slnx` file, relative to it.
pub fn parse_slnx(text: &str) -> Vec<String> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"<Project\b[^>]*\bPath="([^"]+)""#).unwrap());
    RE.captures_iter(text)
        .map(|c| c[1].replace('\\', "/"))
        .filter(|p| is_project_file(Path::new(p)))
        .collect()
}

pub fn solution_projects(solution: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(solution) else {
        return vec![];
    };
    let rel = if solution
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("slnx"))
    {
        parse_slnx(&text)
    } else {
        parse_sln(&text)
    };
    let dir = solution.parent().unwrap_or(Path::new("."));
    rel.into_iter()
        .map(|r| r.split('/').fold(dir.to_path_buf(), |p, part| p.join(part)))
        .filter(|p| p.is_file())
        .collect()
}

fn launch_profiles(project: &Path) -> Vec<LaunchProfile> {
    let file = project
        .parent()
        .unwrap_or(Path::new("."))
        .join("Properties")
        .join("launchSettings.json");
    let Ok(text) = std::fs::read_to_string(file) else {
        return vec![];
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    let Some(profiles) = json.get("profiles").and_then(|p| p.as_object()) else {
        return vec![];
    };
    profiles
        .iter()
        .map(|(name, p)| LaunchProfile {
            name: name.clone(),
            command_name: p
                .get("commandName")
                .and_then(|v| v.as_str())
                .unwrap_or("Project")
                .to_string(),
            application_url: p
                .get("applicationUrl")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        })
        .collect()
}

fn describe(project: &Path) -> DotnetProject {
    let text = std::fs::read_to_string(project).unwrap_or_default();
    DotnetProject {
        path: project.to_string_lossy().into_owned(),
        name: project
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        is_test: text.contains("Microsoft.NET.Test.Sdk") || text.contains("<IsTestProject>true"),
        runnable: text.contains("<OutputType>Exe")
            || text.contains("<OutputType>WinExe")
            || text.contains("Microsoft.NET.Sdk.Web")
            || text.contains("Microsoft.NET.Sdk.Worker"),
        launch_profiles: launch_profiles(project),
    }
}

pub fn dotnet_command() -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new("dotnet");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.env("DOTNET_NOLOGO", "1")
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1");
    cmd
}

pub fn info(root: &Path) -> DotnetInfo {
    let mut solutions = Vec::new();
    let mut loose_projects = Vec::new();
    let mut w = walker(root, false);
    w.max_depth(Some(6));
    for e in w.build().flatten() {
        let p = e.path();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        match ext.as_deref() {
            Some("sln" | "slnx") if e.depth() <= 2 => solutions.push(p.to_path_buf()),
            _ if is_project_file(p) => loose_projects.push(p.to_path_buf()),
            _ => {}
        }
    }
    solutions.sort();
    loose_projects.sort();
    // Projects from the solution(s) first, then any not referenced by one.
    let mut projects: Vec<PathBuf> = solutions
        .iter()
        .flat_map(|s| solution_projects(s))
        .collect();
    for p in loose_projects {
        if !projects.contains(&p) {
            projects.push(p);
        }
    }
    let dotnet_version = dotnet_command()
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    DotnetInfo {
        dotnet_version,
        solutions: solutions
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect(),
        projects: projects.iter().map(|p| describe(p)).collect(),
    }
}

// ---------------------------------------------------------------- builds

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: String,
    pub code: Option<String>,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub project: Option<String>,
}

/// Parses one MSBuild output line, e.g.
/// `/src/A.cs(12,5): error CS1002: ; expected [/src/A.csproj]`.
pub fn parse_diagnostic(line: &str) -> Option<Diagnostic> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^\s*(?P<origin>.+?)(?:\((?P<l>\d+)(?:,(?P<c>\d+)(?:,(?P<el>\d+),(?P<ec>\d+))?)?\))?\s*:\s*(?P<sev>error|warning)\s*(?P<code>[A-Za-z]+\d+)?\s*:\s*(?P<msg>.*?)(?:\s+\[(?P<proj>[^\]]+)\])?\s*$",
        )
        .unwrap()
    });
    let c = RE.captures(line)?;
    let num = |n: &str| c.name(n).and_then(|m| m.as_str().parse().ok());
    let origin = c["origin"].trim().to_string();
    // `CSC : error ...` and `MSBUILD : error ...` have no file.
    let has_file = origin.contains('/') || origin.contains('\\') || origin.contains('.');
    Some(Diagnostic {
        severity: c["sev"].to_string(),
        code: c.name("code").map(|m| m.as_str().to_string()),
        message: c["msg"].to_string(),
        file: has_file.then_some(origin),
        line: num("l"),
        column: num("c"),
        end_line: num("el"),
        end_column: num("ec"),
        project: c.name("proj").map(|m| m.as_str().to_string()),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "t")]
pub enum BuildEvent {
    Line {
        id: u64,
        text: String,
        diagnostic: Option<Diagnostic>,
    },
    Done {
        id: u64,
        code: Option<i32>,
        cancelled: bool,
        millis: u64,
    },
}

pub type BuildSink = Arc<dyn Fn(BuildEvent) + Send + Sync>;

#[derive(Default)]
pub struct Builds {
    next: AtomicU64,
    running: Arc<Mutex<HashMap<u64, Arc<Mutex<Child>>>>>,
    cancelled: Arc<Mutex<HashSet<u64>>>,
}

impl Builds {
    /// Runs `dotnet <verb> <target>` in `cwd`, streaming output lines.
    pub fn start(
        &self,
        verb: &str,
        target: Option<&str>,
        extra: &[&str],
        cwd: &Path,
        sink: BuildSink,
    ) -> Result<u64> {
        let mut cmd = dotnet_command();
        cmd.arg(verb);
        if let Some(t) = target {
            cmd.arg(t);
        }
        cmd.args(extra);
        cmd.args(["-nologo", "-clp:NoSummary;ForceNoAlign", "-tl:off"])
            .current_dir(cwd)
            .env("MSBUILDTERMINALLOGGER", "off")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .context("starting dotnet (is the .NET SDK installed?)")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let stderr = child.stderr.take().context("no stderr")?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let child = Arc::new(Mutex::new(child));
        self.running.lock().insert(id, child.clone());
        let started = Instant::now();

        let err_sink = sink.clone();
        let err_thread = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let diagnostic = parse_diagnostic(&line);
                err_sink(BuildEvent::Line {
                    id,
                    text: line,
                    diagnostic,
                });
            }
        });
        let running = self.running.clone();
        let cancelled = self.cancelled.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let diagnostic = parse_diagnostic(&line);
                sink(BuildEvent::Line {
                    id,
                    text: line,
                    diagnostic,
                });
            }
            let _ = err_thread.join();
            let code = child.lock().wait().ok().and_then(|s| s.code());
            running.lock().remove(&id);
            let cancelled = cancelled.lock().remove(&id);
            sink(BuildEvent::Done {
                id,
                code,
                cancelled,
                millis: started.elapsed().as_millis() as u64,
            });
        });
        Ok(id)
    }

    pub fn cancel(&self, id: u64) {
        let child = self.running.lock().get(&id).cloned();
        if let Some(child) = child {
            self.cancelled.lock().insert(id);
            let _ = child.lock().kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_msbuild_lines() {
        let d = parse_diagnostic("/r/ShopApi/Program.cs(3,15): error CS0103: The name 'X' does not exist [/r/ShopApi/ShopApi.csproj]").unwrap();
        assert_eq!(d.severity, "error");
        assert_eq!(d.code.as_deref(), Some("CS0103"));
        assert_eq!(d.file.as_deref(), Some("/r/ShopApi/Program.cs"));
        assert_eq!((d.line, d.column), (Some(3), Some(15)));
        assert_eq!(d.message, "The name 'X' does not exist");
        assert_eq!(d.project.as_deref(), Some("/r/ShopApi/ShopApi.csproj"));

        let w =
            parse_diagnostic(r"C:\src\A.cs(10,1,10,8): warning CS0168: unused [C:\src\A.csproj]")
                .unwrap();
        assert_eq!(w.file.as_deref(), Some(r"C:\src\A.cs"));
        assert_eq!((w.end_line, w.end_column), (Some(10), Some(8)));

        let csc =
            parse_diagnostic("CSC : error CS5001: Program does not contain a static 'Main' method")
                .unwrap();
        assert_eq!(csc.file, None);

        let nu =
            parse_diagnostic("/r/A.csproj : error NU1101: Unable to find package Foo.").unwrap();
        assert_eq!(nu.file.as_deref(), Some("/r/A.csproj"));
        assert_eq!(nu.line, None);

        assert!(parse_diagnostic("  ShopApi -> /r/bin/Debug/net10.0/ShopApi.dll").is_none());
        assert!(parse_diagnostic("Build succeeded.").is_none());
    }

    #[test]
    fn parses_solutions() {
        let sln = "Project(\"{FAE04EC0}\") = \"ShopApi\", \"src\\ShopApi\\ShopApi.csproj\", \"{1}\"\nEndProject\nProject(\"{2150E333}\") = \"Docs\", \"Docs\", \"{2}\"\n";
        assert_eq!(parse_sln(sln), vec!["src/ShopApi/ShopApi.csproj"]);
        let slnx = "<Solution>\n  <Folder Name=\"/src/\">\n    <Project Path=\"src/ShopApi/ShopApi.csproj\" />\n  </Folder>\n  <Project Path=\"tests\\T.csproj\" />\n</Solution>";
        assert_eq!(
            parse_slnx(slnx),
            vec!["src/ShopApi/ShopApi.csproj", "tests/T.csproj"]
        );
    }

    #[test]
    fn discovers_projects_and_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Api/Properties")).unwrap();
        std::fs::create_dir_all(root.join("Tests")).unwrap();
        std::fs::write(
            root.join("Api/Api.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk.Web\"/>",
        )
        .unwrap();
        std::fs::write(
            root.join("Api/Properties/launchSettings.json"),
            r#"{"profiles":{"http":{"commandName":"Project","applicationUrl":"http://localhost:5000"}}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("Tests/Tests.csproj"),
            "<PackageReference Include=\"Microsoft.NET.Test.Sdk\"/>",
        )
        .unwrap();
        std::fs::write(
            root.join("All.slnx"),
            "<Solution><Project Path=\"Api/Api.csproj\"/></Solution>",
        )
        .unwrap();
        let info = info(root);
        assert_eq!(info.solutions.len(), 1);
        let names: Vec<_> = info.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Api", "Tests"]);
        assert_eq!(
            info.projects[0].launch_profiles[0]
                .application_url
                .as_deref(),
            Some("http://localhost:5000")
        );
        assert!(info.projects[1].is_test);
        assert!(info.projects[0].runnable && !info.projects[1].runnable);
    }

    /// Builds a broken library with the real SDK (skipped when `dotnet` is missing).
    #[test]
    fn build_reports_compiler_errors() {
        let Some(version) = dotnet_command()
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        else {
            eprintln!("dotnet not installed; skipping");
            return;
        };
        // Target whatever SDK is installed (CI machines differ).
        let major = version.split('.').next().unwrap_or("8").to_string();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Lib.csproj"),
            format!("<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net{major}.0</TargetFramework></PropertyGroup></Project>"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("A.cs"),
            "class A { void M() { int x = \"s\"; } }",
        )
        .unwrap();
        let builds = Builds::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        builds
            .start(
                "build",
                None,
                &[],
                dir.path(),
                Arc::new(move |e| {
                    let _ = tx.lock().unwrap().send(e);
                }),
            )
            .unwrap();
        let mut diags = Vec::new();
        let code = loop {
            match rx
                .recv_timeout(std::time::Duration::from_secs(240))
                .expect("build hung")
            {
                BuildEvent::Line {
                    diagnostic: Some(d),
                    ..
                } => diags.push(d),
                BuildEvent::Line { .. } => {}
                BuildEvent::Done { code, .. } => break code,
            }
        };
        assert_ne!(code, Some(0));
        let err = diags
            .iter()
            .find(|d| d.code.as_deref() == Some("CS0029"))
            .expect("CS0029 reported");
        assert!(err.file.as_deref().unwrap().ends_with("A.cs"));
        assert_eq!(err.line, Some(1));
    }
}

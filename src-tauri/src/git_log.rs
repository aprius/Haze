//! Git log with a commit graph, like the Log tab of Rider / Rebased.
//!
//! Lanes are computed over everything loaded so far, so connections stay
//! right when more history is loaded or the list is scrolled.

use std::path::Path;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::git::git_command;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    /// Maximum number of commits.
    pub limit: usize,
    /// Branches/refs to show; empty = all refs (`--all`).
    #[serde(default)]
    pub refs: Vec<String>,
    /// Message or hash text (`--grep`, case-insensitive).
    pub text: Option<String>,
    pub author: Option<String>,
    /// Only commits touching this path.
    pub path: Option<String>,
    #[serde(default)]
    pub first_parent: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Unix seconds.
    pub time: i64,
    pub refs: Vec<String>,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: u16,
    pub to: u16,
    pub color: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub lane: u16,
    pub color: u16,
    /// Segments from this row's center to the next row's center.
    pub edges: Vec<Edge>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<Commit>,
    pub graph: Vec<GraphRow>,
    /// More commits exist beyond `limit`.
    pub has_more: bool,
}

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split(RECORD)
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.split(FIELD).collect();
            if f.len() < 7 {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                refs: f[5]
                    .split(", ")
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                subject: f[6].to_string(),
            })
        })
        .collect()
}

/// Lays out lanes for commits in topological order (children before parents).
pub fn layout(commits: &[Commit]) -> Vec<GraphRow> {
    // Each slot holds the hash expected next in that lane, with the lane's color.
    let mut lanes: Vec<Option<(String, u16)>> = Vec::new();
    let mut next_color: u16 = 0;
    let mut rows = Vec::with_capacity(commits.len());
    let expects = |l: &Option<(String, u16)>, h: &str| l.as_ref().is_some_and(|(x, _)| x == h);

    for (i, c) in commits.iter().enumerate() {
        // The commit sits in the leftmost lane expecting it, else in a free slot.
        let (lane, color) = match lanes.iter().position(|l| expects(l, &c.hash)) {
            Some(p) => (p, lanes[p].as_ref().unwrap().1),
            None => {
                let p = lanes
                    .iter()
                    .position(Option::is_none)
                    .unwrap_or(lanes.len());
                if p == lanes.len() {
                    lanes.push(None);
                }
                next_color = next_color.wrapping_add(1);
                (p, next_color - 1)
            }
        };
        // Every lane waiting for this commit ends here.
        for l in lanes.iter_mut().filter(|l| expects(l, &c.hash)) {
            *l = None;
        }
        // Lanes still running past this row.
        let passing: Vec<usize> = (0..lanes.len()).filter(|&j| lanes[j].is_some()).collect();

        // Parents: the first continues this lane, others join a lane already
        // expecting them or open a new one to the right.
        let mut edges = Vec::new();
        for (pi, p) in c.parents.iter().enumerate() {
            let slot = match lanes.iter().position(|l| expects(l, p)) {
                Some(k) => k,
                None => {
                    let k = if pi == 0 && lanes[lane].is_none() {
                        lane
                    } else {
                        lanes
                            .iter()
                            .enumerate()
                            .position(|(j, l)| l.is_none() && j > lane)
                            .unwrap_or_else(|| {
                                lanes.push(None);
                                lanes.len() - 1
                            })
                    };
                    let col = if k == lane {
                        color
                    } else {
                        next_color = next_color.wrapping_add(1);
                        next_color - 1
                    };
                    lanes[k] = Some((p.clone(), col));
                    k
                }
            };
            let col = lanes[slot].as_ref().unwrap().1;
            edges.push(Edge {
                from: lane as u16,
                to: slot as u16,
                color: col,
            });
        }
        for &j in &passing {
            edges.push(Edge {
                from: j as u16,
                to: j as u16,
                color: lanes[j].as_ref().unwrap().1,
            });
        }

        // Lanes carrying the next commit converge into the lane it will occupy.
        if let Some(next) = commits.get(i + 1) {
            if let Some(nl) = lanes.iter().position(|l| expects(l, &next.hash)) {
                for e in edges.iter_mut() {
                    if expects(&lanes[e.to as usize], &next.hash) {
                        e.to = nl as u16;
                    }
                }
            }
        }
        edges.sort_by_key(|e| (e.from, e.to));
        edges.dedup();
        while lanes.last().is_some_and(Option::is_none) {
            lanes.pop();
        }
        rows.push(GraphRow {
            lane: lane as u16,
            color,
            edges,
        });
    }
    rows
}

pub fn log(root: &Path, q: &LogQuery) -> Result<LogPage> {
    let limit = q.limit.clamp(1, 100_000);
    let mut cmd = git_command();
    cmd.arg("-C").arg(root).args([
        "log",
        "--topo-order",
        "--date-order",
        "-z",
        &format!("--max-count={}", limit + 1),
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e",
    ]);
    if q.first_parent {
        cmd.arg("--first-parent");
    }
    if let Some(t) = q.text.as_deref().filter(|t| !t.is_empty()) {
        cmd.arg("-i").arg(format!("--grep={t}"));
    }
    if let Some(a) = q.author.as_deref().filter(|a| !a.is_empty()) {
        cmd.arg(format!("--author={a}"));
    }
    if q.refs.is_empty() {
        cmd.arg("--all");
    } else {
        cmd.args(&q.refs);
    }
    cmd.arg("--");
    if let Some(p) = q.path.as_deref().filter(|p| !p.is_empty()) {
        cmd.arg(p);
    }
    let out = cmd.output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // An empty repository has no history yet.
        if err.contains("does not have any commits") || err.contains("bad default revision") {
            return Ok(LogPage {
                commits: vec![],
                graph: vec![],
                has_more: false,
            });
        }
        bail!("{}", err.trim());
    }
    let text = String::from_utf8_lossy(&out.stdout).replace('\0', "");
    let mut commits = parse_log(&text);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let graph = layout(&commits);
    Ok(LogPage {
        commits,
        graph,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(hash: &str, parents: &[&str]) -> Commit {
        Commit {
            hash: hash.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: String::new(),
            email: String::new(),
            time: 0,
            refs: vec![],
            subject: String::new(),
        }
    }

    fn edges(r: &GraphRow) -> Vec<(u16, u16)> {
        r.edges.iter().map(|e| (e.from, e.to)).collect()
    }

    #[test]
    fn linear_history_is_one_lane() {
        let rows = layout(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert!(rows.iter().all(|r| r.lane == 0));
        assert_eq!(edges(&rows[0]), vec![(0, 0)]);
        assert_eq!(edges(&rows[2]), vec![]);
    }

    #[test]
    fn branch_and_merge() {
        //  m        merge of b2 into main
        //  |\
        //  | b2
        //  a2 |
        //  | b1
        //  |/
        //  a1
        let rows = layout(&[
            c("m", &["a2", "b2"]),
            c("b2", &["b1"]),
            c("a2", &["a1"]),
            c("b1", &["a1"]),
            c("a1", &[]),
        ]);
        assert_eq!(rows[0].lane, 0);
        assert_eq!(edges(&rows[0]), vec![(0, 0), (0, 1)]);
        assert_eq!(rows[1].lane, 1);
        assert_eq!(rows[2].lane, 0);
        assert_eq!(rows[3].lane, 1);
        // b1 and a2's lanes both end at a1, which sits in lane 0.
        assert_eq!(edges(&rows[3]), vec![(0, 0), (1, 0)]);
        assert_eq!(rows[4].lane, 0);
        assert_ne!(rows[0].edges[1].color, rows[0].edges[0].color);
    }

    #[test]
    fn parses_git_output() {
        let out = "h1\u{1f}p1 p2\u{1f}Ann\u{1f}a@x\u{1f}1700000000\u{1f}HEAD -> main, origin/main\u{1f}Merge\u{1e}\nh2\u{1f}\u{1f}Bob\u{1f}b@x\u{1f}1\u{1f}\u{1f}init\u{1e}";
        let commits = parse_log(out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["p1", "p2"]);
        assert_eq!(commits[0].refs, vec!["HEAD -> main", "origin/main"]);
        assert!(commits[1].parents.is_empty() && commits[1].refs.is_empty());
    }

    #[test]
    fn log_of_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let out = git_command()
                .arg("-C")
                .arg(root)
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "first"]);
        git(&["checkout", "-q", "-b", "feature"]);
        git(&["commit", "-q", "--allow-empty", "-m", "on feature"]);
        git(&["checkout", "-q", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "on main"]);
        git(&["merge", "-q", "--no-ff", "feature", "-m", "merge feature"]);
        let page = log(
            root,
            &LogQuery {
                limit: 100,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.commits.len(), 4);
        assert_eq!(page.commits[0].subject, "merge feature");
        assert!(page.commits[0].refs.iter().any(|r| r == "HEAD -> main"));
        assert_eq!(page.graph[0].edges.len(), 2);
        assert!(!page.has_more);
        let limited = log(
            root,
            &LogQuery {
                limit: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(limited.has_more);
        let filtered = log(
            root,
            &LogQuery {
                limit: 100,
                text: Some("FEATURE".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.commits.len(), 2);
    }
}

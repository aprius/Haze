//! "Check for Updates": compares this build's version with the latest GitHub
//! release. Haze does not install anything itself; the UI links to the release
//! (or `brew upgrade`).

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const LATEST_RELEASE: &str = "https://api.github.com/repos/aprius/Haze/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    /// The release page on GitHub.
    pub url: String,
    pub available: bool,
}

#[derive(Deserialize)]
struct ReleaseJson {
    tag_name: String,
    html_url: String,
}

/// `v1.2.3` → `[1, 2, 3]`; anything after `-` or `+` (pre-release, build) is ignored.
fn parse(version: &str) -> Vec<u64> {
    let v = version.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next().unwrap_or_default();
    core.split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

fn newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse(latest), parse(current));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a > b
}

pub fn check() -> Result<UpdateInfo> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    // Short: a slow network should not hold a blocking thread for long.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .user_agent("Haze")
        .build()
        .into();
    let mut resp = agent
        .get(LATEST_RELEASE)
        .header("Accept", "application/vnd.github+json")
        .call()
        .context("cannot reach GitHub")?;
    match resp.status().as_u16() {
        200 => {}
        404 => bail!("no release has been published yet"),
        403 | 429 => bail!("GitHub is rate limiting requests, try again later"),
        s => bail!("GitHub answered HTTP {s}"),
    }
    let release: ReleaseJson = resp.body_mut().read_json().context("unexpected answer from GitHub")?;
    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    Ok(UpdateInfo {
        available: newer(&latest, &current),
        current,
        latest,
        url: release.html_url,
    })
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compares_versions() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("v1.0.0", "0.9.0"));
        assert!(newer("1.10.0", "1.9.0"));
        assert!(newer("1.0.1", "1.0"));
        assert!(!newer("1.0.0", "1.0.0"));
        assert!(!newer("1.0", "1.0.0"));
        assert!(!newer("0.1.0", "0.2.0"));
        assert!(!newer("1.0.0-beta", "1.0.0"));
    }
}

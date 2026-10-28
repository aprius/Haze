//! OpenCode's global config (`~/.config/opencode/opencode.json`): the model
//! providers and default models that Settings › AI Models edits.
//!
//! OpenCode knows the models of most providers (from models.dev), so a
//! built-in provider only needs a key; an OpenAI-compatible server (Ollama,
//! LM Studio, a proxy…) also needs its package, address and models. Keys are
//! written to files beside the config that only the user can read, and the
//! config names them with `{file:…}`, so opencode.json holds no secret.
//! Everything else in the config is kept.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::agent_hooks::write_with_backup;

/// Key files, relative to the config directory (as `{file:…}` resolves them).
const KEY_DIR: &str = "haze-keys";

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: Option<String>,
    /// The AI SDK package, e.g. `@ai-sdk/openai-compatible`; none for built-in providers.
    pub npm: Option<String>,
    pub base_url: Option<String>,
    /// Where the key comes from: "haze" (a key file Haze wrote), "env",
    /// "file" (another file), "inline" (in the config) or "none" (OpenCode's
    /// own `/connect` credentials or environment, if any).
    pub key: &'static str,
    /// The variable, for "env".
    pub key_env: Option<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeConfig {
    pub path: String,
    pub providers: Vec<Provider>,
    pub model: Option<String>,
    pub small_model: Option<String>,
    /// Why Haze will not write the file.
    pub conflict: Option<String>,
}

/// A provider to add or change. `None` keeps a field as it is; an empty
/// string (or list) removes it.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: String,
    pub name: Option<String>,
    pub npm: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub models: Option<Vec<String>>,
}

/// OpenCode's global config directory (it uses XDG paths on every platform).
pub fn config_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENCODE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()
            .context("no home directory")?
            .join(".config"),
    };
    Ok(config.join("opencode"))
}

/// The file OpenCode reads, or opencode.json for a new one. (OpenCode 1 also
/// read config.json; OpenCode 2 does not, so that one is never written.)
fn config_file(dir: &Path) -> PathBuf {
    ["opencode.json", "opencode.jsonc"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .unwrap_or_else(|| dir.join("opencode.json"))
}

/// The config, and whether it has comments (which writing it would drop).
fn read_doc(path: &Path) -> Result<(Value, bool)> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((json!({}), false)),
        Err(e) => return Err(e.into()),
    };
    if text.trim().is_empty() {
        return Ok((json!({}), false));
    }
    if let Ok(v) = serde_json::from_str(&text) {
        return Ok((v, false));
    }
    let plain = strip_jsonc(&text);
    let v = serde_json::from_str(&plain)
        .with_context(|| format!("{} is not valid JSON", path.display()))?;
    Ok((v, true))
}

/// JSON from JSONC: comments and trailing commas removed, strings untouched.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                while let Some(c) = chars.next() {
                    out.push(c);
                    match c {
                        '\\' => out.extend(chars.next()),
                        '"' => break,
                        _ => {}
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                while chars.peek().is_some_and(|&c| c != '\n') {
                    chars.next();
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
                out.push(' ');
            }
            // Dropped when only whitespace or comments separate it from `}` or `]`.
            ',' if !matches!(next_token(chars.clone()), Some('}' | ']')) => out.push(c),
            ',' => {}
            _ => out.push(c),
        }
    }
    out
}

/// The next character that is not whitespace or inside a comment.
fn next_token(mut chars: std::iter::Peekable<std::str::Chars>) -> Option<char> {
    loop {
        match chars.next()? {
            c if c.is_whitespace() => {}
            '/' if chars.peek() == Some(&'/') => {
                chars.find(|&c| c == '\n');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                chars.find(|&c| std::mem::replace(&mut last, c) == '*' && c == '/');
            }
            c => return Some(c),
        }
    }
}

fn key_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(KEY_DIR).join(id)
}

fn key_ref(id: &str) -> String {
    format!("{{file:{KEY_DIR}/{id}}}")
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn provider_of(id: &str, p: &Value) -> Provider {
    let options = p.get("options").cloned().unwrap_or_default();
    let api_key = str_of(&options, "apiKey").unwrap_or("");
    let (key, key_env) = if api_key.is_empty() {
        ("none", None)
    } else if api_key == key_ref(id) {
        ("haze", None)
    } else if let Some(var) = api_key
        .strip_prefix("{env:")
        .and_then(|s| s.strip_suffix('}'))
    {
        ("env", Some(var.to_string()))
    } else if api_key.starts_with("{file:") {
        ("file", None)
    } else {
        ("inline", None)
    };
    Provider {
        id: id.to_string(),
        name: str_of(p, "name").map(str::to_string),
        npm: str_of(p, "npm").map(str::to_string),
        base_url: str_of(&options, "baseURL")
            .or_else(|| str_of(p, "api"))
            .map(str::to_string),
        key,
        key_env,
        models: p
            .get("models")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default(),
    }
}

fn summary(path: &Path, doc: &Value, comments: bool) -> OpenCodeConfig {
    OpenCodeConfig {
        path: path.to_string_lossy().into_owned(),
        providers: doc
            .get("provider")
            .and_then(Value::as_object)
            .map(|ps| ps.iter().map(|(id, p)| provider_of(id, p)).collect())
            .unwrap_or_default(),
        model: str_of(doc, "model").map(str::to_string),
        small_model: str_of(doc, "small_model").map(str::to_string),
        conflict: comments.then(|| {
            format!(
                "{} has comments or trailing commas, which Haze would drop; edit it by hand",
                path.display()
            )
        }),
    }
}

pub fn read(dir: &Path) -> Result<OpenCodeConfig> {
    let path = config_file(dir);
    let (doc, comments) = read_doc(&path)?;
    Ok(summary(&path, &doc, comments))
}

/// Reads the config, lets `f` change it and writes it back.
fn update(
    dir: &Path,
    f: impl FnOnce(&mut Map<String, Value>) -> Result<()>,
) -> Result<OpenCodeConfig> {
    let path = config_file(dir);
    let (mut doc, comments) = read_doc(&path)?;
    if comments {
        bail!(
            "{} has comments or trailing commas, which Haze would drop; edit it by hand",
            path.display()
        );
    }
    let obj = doc
        .as_object_mut()
        .with_context(|| format!("{} is not a JSON object", path.display()))?;
    if obj.is_empty() {
        obj.insert("$schema".into(), "https://opencode.ai/config.json".into());
    }
    f(obj)?;
    write_with_backup(&path, &(serde_json::to_string_pretty(&doc)? + "\n"))?;
    Ok(summary(&path, &doc, false))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !id.starts_with('.')
}

/// Sets `key` in `obj`, or removes it for an empty value. Keys keep their
/// place in the file (`remove` would move the last key into the gap).
fn set_or_remove(obj: &mut Map<String, Value>, key: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        obj.shift_remove(key);
    } else {
        obj.insert(key.into(), value.into());
    }
}

fn write_key(dir: &Path, id: &str, key: &str) -> Result<()> {
    let path = key_path(dir, id);
    let parent = path.parent().context("no key directory")?;
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let _ = std::fs::remove_file(&path);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        f.write_all(key.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, key)?;
    Ok(())
}

pub fn save_provider(dir: &Path, input: ProviderInput) -> Result<OpenCodeConfig> {
    let id = input.id.trim().to_string();
    if !valid_id(&id) {
        bail!("Provider id may only use letters, digits, '-', '_' and '.'");
    }
    let config = update(dir, |doc| {
        let providers = doc
            .entry("provider")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .context("`provider` is not an object")?;
        let p = providers
            .entry(id.clone())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .with_context(|| format!("provider `{id}` is not an object"))?;
        if let Some(name) = &input.name {
            set_or_remove(p, "name", name);
        }
        if let Some(npm) = &input.npm {
            set_or_remove(p, "npm", npm);
        }
        let mut options = p
            .get("options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(url) = &input.base_url {
            set_or_remove(&mut options, "baseURL", url.trim().trim_end_matches('/'));
        }
        match input.api_key.as_deref().map(str::trim) {
            Some("") => {
                options.shift_remove("apiKey");
            }
            Some(key) => {
                write_key(dir, &id, key)?;
                options.insert("apiKey".into(), key_ref(&id).into());
            }
            None => {}
        }
        // `insert` keeps an existing key where it is.
        if options.is_empty() {
            p.shift_remove("options");
        } else {
            p.insert("options".into(), options.into());
        }
        if let Some(ids) = &input.models {
            let old = p
                .get("models")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut models = Map::new();
            for m in ids.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
                let entry = old.get(m).cloned().unwrap_or_else(|| json!({ "name": m }));
                models.insert(m.to_string(), entry);
            }
            if models.is_empty() {
                p.shift_remove("models");
            } else {
                p.insert("models".into(), models.into());
            }
        }
        Ok(())
    })?;
    if input.api_key.as_deref().map(str::trim) == Some("") {
        let _ = std::fs::remove_file(key_path(dir, &id));
    }
    Ok(config)
}

/// Removes the provider, its key file, and default models that use it.
pub fn remove_provider(dir: &Path, id: &str) -> Result<OpenCodeConfig> {
    let config = update(dir, |doc| {
        if let Some(ps) = doc.get_mut("provider").and_then(Value::as_object_mut) {
            ps.shift_remove(id);
            if ps.is_empty() {
                doc.shift_remove("provider");
            }
        }
        let prefix = format!("{id}/");
        for key in ["model", "small_model"] {
            if doc
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|m| m.starts_with(&prefix))
            {
                doc.shift_remove(key);
            }
        }
        Ok(())
    })?;
    if valid_id(id) {
        let _ = std::fs::remove_file(key_path(dir, id));
    }
    Ok(config)
}

/// Sets the default and small models (`provider/model`); empty removes one.
pub fn set_models(dir: &Path, model: &str, small_model: &str) -> Result<OpenCodeConfig> {
    for m in [model, small_model].map(str::trim) {
        if !m.is_empty() && !m.contains('/') {
            bail!("A model is written provider/model, e.g. anthropic/claude-sonnet-4-5");
        }
    }
    update(dir, |doc| {
        set_or_remove(doc, "model", model);
        set_or_remove(doc, "small_model", small_model);
        Ok(())
    })
}

/// Model ids a server lists at `<base>/models`, sending the key the way its
/// package (`npm`) does: Anthropic's header for `@ai-sdk/anthropic`, a bearer
/// token otherwise. Without `api_key`, uses the key Haze saved for `id`, if any.
pub fn fetch_models(
    dir: &Path,
    base_url: &str,
    api_key: Option<&str>,
    id: &str,
    npm: &str,
) -> Result<Vec<String>> {
    let base = base_url.trim().trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        bail!("Enter the server's address, e.g. http://localhost:11434/v1");
    }
    let saved = (valid_id(id))
        .then(|| std::fs::read_to_string(key_path(dir, id)).ok())
        .flatten();
    let key = api_key
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .or(saved.map(|k| k.trim().to_string()));
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
    let mut req = agent.get(format!("{base}/models"));
    if npm == "@ai-sdk/anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            req = req.header("x-api-key", k);
        }
    } else if let Some(k) = key.filter(|k| !k.is_empty()) {
        req = req.header("Authorization", format!("Bearer {k}"));
    }
    let mut resp = req
        .call()
        .with_context(|| format!("could not reach {base}"))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("{base}/models answered {status}");
    }
    let body: Value = resp.body_mut().read_json()?;
    Ok(model_ids(&body))
}

/// `{"data": [{"id": …}]}` (OpenAI) or `{"models": [{"name": …}]}` (Ollama's own API).
fn model_ids(body: &Value) -> Vec<String> {
    let list = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(Value::as_array);
    let mut ids: Vec<String> = list
        .into_iter()
        .flatten()
        .filter_map(|m| {
            str_of(m, "id")
                .or_else(|| str_of(m, "name"))
                .map(str::to_string)
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str) -> ProviderInput {
        ProviderInput {
            id: id.into(),
            ..Default::default()
        }
    }

    #[test]
    fn strips_comments_and_trailing_commas_but_not_strings() {
        let text = r#"{
  // a comment
  "url": "http://x//y", /* block */
  "list": [1, 2,],
  "s": "a,}",
  "o": {"k": 1, /* x */ },
}"#;
        let v: Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(
            v,
            json!({ "url": "http://x//y", "list": [1, 2], "s": "a,}", "o": { "k": 1 } })
        );
    }

    #[test]
    fn adds_a_compatible_provider_with_a_key_file_keeping_other_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        std::fs::write(&path, r#"{"theme":"tokyonight","provider":{"anthropic":{"options":{"apiKey":"{env:ANTHROPIC_KEY}"}}}}"#).unwrap();
        let cfg = save_provider(
            dir.path(),
            ProviderInput {
                name: Some("Ollama".into()),
                npm: Some("@ai-sdk/openai-compatible".into()),
                base_url: Some("http://localhost:11434/v1/".into()),
                api_key: Some("sk-secret".into()),
                models: Some(vec!["qwen3".into(), " ".into(), "llama4".into()]),
                ..input("ollama")
            },
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["theme"], "tokyonight");
        assert_eq!(
            doc["provider"]["ollama"]["options"]["baseURL"],
            "http://localhost:11434/v1"
        );
        assert_eq!(
            doc["provider"]["ollama"]["options"]["apiKey"],
            "{file:haze-keys/ollama}"
        );
        assert_eq!(
            doc["provider"]["ollama"]["models"]["qwen3"],
            json!({ "name": "qwen3" })
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("haze-keys/ollama")).unwrap(),
            "sk-secret"
        );
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("sk-secret"));
        let ollama = cfg.providers.iter().find(|p| p.id == "ollama").unwrap();
        assert_eq!(
            (ollama.key, ollama.models.clone()),
            ("haze", vec!["qwen3".to_string(), "llama4".to_string()])
        );
        let anthropic = cfg.providers.iter().find(|p| p.id == "anthropic").unwrap();
        assert_eq!(
            (anthropic.key, anthropic.key_env.as_deref()),
            ("env", Some("ANTHROPIC_KEY"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("haze-keys/ollama"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn edits_keep_what_is_not_given_and_removal_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        save_provider(
            dir.path(),
            ProviderInput {
                api_key: Some("k1".into()),
                models: Some(vec!["a".into()]),
                ..input("openrouter")
            },
        )
        .unwrap();
        set_models(dir.path(), "openrouter/a", "").unwrap();
        // A model's own settings survive a new list; the key is kept.
        let path = dir.path().join("opencode.json");
        let mut doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc["provider"]["openrouter"]["models"]["a"] =
            json!({ "name": "A", "limit": { "context": 1000 } });
        std::fs::write(&path, doc.to_string()).unwrap();
        let cfg = save_provider(
            dir.path(),
            ProviderInput {
                models: Some(vec!["a".into(), "b".into()]),
                ..input("openrouter")
            },
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            doc["provider"]["openrouter"]["models"]["a"]["limit"]["context"],
            1000
        );
        assert_eq!(cfg.providers[0].key, "haze");
        assert_eq!(cfg.model.as_deref(), Some("openrouter/a"));

        let cfg = remove_provider(dir.path(), "openrouter").unwrap();
        assert!(cfg.providers.is_empty());
        assert_eq!(cfg.model, None);
        assert!(!dir.path().join("haze-keys/openrouter").exists());
    }

    #[test]
    fn keeps_the_order_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        std::fs::write(
            &path,
            r#"{"provider":{"a":{"name":"A","options":{"baseURL":"http://a"},"models":{"m":{}},"npm":"x"},"b":{},"c":{}},"theme":"t"}"#,
        )
        .unwrap();
        save_provider(
            dir.path(),
            ProviderInput {
                api_key: Some("k".into()),
                models: Some(vec!["m".into(), "n".into()]),
                ..input("a")
            },
        )
        .unwrap();
        remove_provider(dir.path(), "b").unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&doc), ["provider", "theme"]);
        assert_eq!(keys(&doc["provider"]), ["a", "c"]);
        assert_eq!(
            keys(&doc["provider"]["a"]),
            ["name", "options", "models", "npm"]
        );
    }

    #[test]
    fn refuses_bad_input_and_files_with_comments() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_provider(dir.path(), input("../x")).is_err());
        assert!(set_models(dir.path(), "no-provider", "").is_err());
        std::fs::write(
            dir.path().join("opencode.jsonc"),
            "{ // mine\n \"model\": \"a/b\" }",
        )
        .unwrap();
        let cfg = read(dir.path()).unwrap();
        assert_eq!(cfg.model.as_deref(), Some("a/b"));
        assert!(cfg.conflict.is_some());
        assert!(save_provider(dir.path(), input("x")).is_err());
        assert!(!dir.path().join("opencode.json").exists());
    }

    /// Answers one request with a model list; returns the port and the request's head.
    fn serve_models_once() -> (u16, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (stream, _) = server.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                head.push(line.trim().to_lowercase());
            }
            let body = r#"{"object":"list","data":[{"id":"qwen3:8b"},{"id":"gemma3"}]}"#;
            write!(
                &stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            head
        });
        (port, handle)
    }

    #[test]
    fn fetches_models_with_the_saved_key() {
        let dir = tempfile::tempdir().unwrap();
        write_key(dir.path(), "local", "sk-local").unwrap();
        let (port, handle) = serve_models_once();
        let base = format!("http://127.0.0.1:{port}/v1/");
        let ids = fetch_models(
            dir.path(),
            &base,
            None,
            "local",
            "@ai-sdk/openai-compatible",
        )
        .unwrap();
        assert_eq!(ids, ["gemma3", "qwen3:8b"]);
        let head = handle.join().unwrap();
        assert_eq!(head[0], "get /v1/models http/1.1");
        assert!(head.iter().any(|h| h == "authorization: bearer sk-local"));

        // Anthropic-style servers take the key in their own header.
        let (port, handle) = serve_models_once();
        let base = format!("http://127.0.0.1:{port}/v1");
        fetch_models(dir.path(), &base, Some("sk-ant"), "x", "@ai-sdk/anthropic").unwrap();
        let head = handle.join().unwrap();
        assert!(head.iter().any(|h| h == "x-api-key: sk-ant"));
        assert!(head.iter().any(|h| h == "anthropic-version: 2023-06-01"));
        assert!(!head.iter().any(|h| h.starts_with("authorization")));
    }

    #[test]
    fn reads_model_lists() {
        assert_eq!(
            model_ids(&json!({ "data": [{ "id": "b" }, { "id": "a" }] })),
            ["a", "b"]
        );
        assert_eq!(
            model_ids(&json!({ "models": [{ "name": "qwen3:8b" }] })),
            ["qwen3:8b"]
        );
        assert!(model_ids(&json!({})).is_empty());
    }
}

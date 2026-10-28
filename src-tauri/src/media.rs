//! Background videos (Settings > Appearance): a copy kept in the app's cache,
//! so the background survives the file moving, played from a loopback HTTP
//! server. WebKit plays a video over HTTP with half the CPU it takes from a
//! blob: or custom-scheme URL, which feed the player through the web process
//! (measured in a WKWebView, 1080p at 30 fps: 5% against 10–12%). The server
//! answers only for the file registered last, under a random token, on
//! 127.0.0.1.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};

/// Copies `path` into `dir` (emptied first: one background at a time) and
/// returns the copy; with no path, only empties it.
pub fn cache(dir: &Path, path: Option<&Path>) -> Result<Option<PathBuf>> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let Some(path) = path else { return Ok(None) };
    let meta = std::fs::metadata(path)?;
    anyhow::ensure!(
        meta.len() <= 2 * 1024 * 1024 * 1024,
        "the file is too large (over 2 GB)"
    );
    std::fs::create_dir_all(dir)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let out = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4().simple()));
    std::fs::copy(path, &out).context("could not copy the video")?;
    Ok(Some(out))
}

/// What a background folder holds (Settings > Appearance, Rotate): the images
/// and videos at its top, and in its `days` and `nights` folders (also `day`,
/// `night`, any case), each sorted by name. Not deeper, and no hidden files.
#[derive(serde::Serialize, Default, Debug, PartialEq)]
pub struct Folder {
    pub root: Vec<String>,
    pub day: Vec<String>,
    pub night: Vec<String>,
}

/// The extensions a background can be, as src/lib/backdrop.ts takes them.
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "mp4", "webm", "mov", "m4v"];

pub fn list_folder(dir: &Path) -> Result<Folder> {
    let entries = std::fs::read_dir(dir).context("cannot read the folder")?;
    let mut out = Folder::default();
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            match name.as_str() {
                "day" | "days" => out.day.extend(media_files(&path)),
                "night" | "nights" => out.night.extend(media_files(&path)),
                _ => {}
            }
        } else if is_media(&path) {
            out.root.push(path.to_string_lossy().into_owned());
        }
    }
    for list in [&mut out.root, &mut out.day, &mut out.night] {
        list.sort();
    }
    Ok(out)
}

fn is_media(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .is_some_and(|e| EXTENSIONS.contains(&e.as_str()))
}

fn media_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) && is_media(p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

struct Server {
    port: u16,
    files: Mutex<HashMap<String, PathBuf>>,
}

static SERVER: OnceLock<Server> = OnceLock::new();

fn server() -> Result<&'static Server> {
    if let Some(s) = SERVER.get() {
        return Ok(s);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let s = SERVER.get_or_init(|| Server {
        port,
        files: Mutex::default(),
    });
    // Another thread may have started it first: its listener is the one.
    if s.port == port {
        std::thread::Builder::new()
            .name("media-server".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    std::thread::spawn(move || {
                        let _ = serve(stream);
                    });
                }
            })?;
    }
    Ok(s)
}

/// A URL the web view can play `path` from, in place of any served before; the
/// same one again for the same file, so what plays it keeps playing.
pub fn url(path: &Path) -> Result<String> {
    anyhow::ensure!(path.is_file(), "the video is gone");
    let s = server()?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut files = s.files.lock().unwrap();
    let token = match files.iter().find(|(_, p)| p.as_path() == path) {
        Some((t, _)) => t.clone(),
        None => {
            let t = uuid::Uuid::new_v4().simple().to_string();
            files.clear();
            files.insert(t.clone(), path.to_path_buf());
            t
        }
    };
    Ok(format!("http://127.0.0.1:{}/{token}/{name}", s.port))
}

const MAX_LINE: usize = 8 * 1024;

fn serve(stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;
    // Keep-alive: the player asks for range after range.
    loop {
        let Some(request) = read_line(&mut reader)? else { return Ok(()) };
        let mut parts = request.split_whitespace();
        let method = parts.next().unwrap_or("").to_owned();
        let target = parts.next().unwrap_or("").to_owned();
        let mut range = None;
        loop {
            let Some(line) = read_line(&mut reader)? else { return Ok(()) };
            if line.is_empty() {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("range") {
                    range = Some(v.trim().to_owned());
                }
            }
        }
        let token = target.trim_start_matches('/').split('/').next().unwrap_or("");
        let file = SERVER.get().and_then(|s| s.files.lock().unwrap().get(token).cloned());
        match (method.as_str(), file) {
            ("GET" | "HEAD", Some(path)) => send_file(&mut out, &path, range.as_deref(), method == "HEAD")?,
            ("OPTIONS", _) => write!(
                out,
                "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nContent-Length: 0\r\n\r\n"
            )?,
            _ => write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?,
        }
    }
}

/// A header line without its line break; None once the client is done.
fn read_line(r: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut line = String::new();
    let n = r.take(MAX_LINE as u64).read_line(&mut line)?;
    if n == 0 || !line.ends_with('\n') {
        return Ok(None);
    }
    Ok(Some(line.trim_end().to_owned()))
}

/// The bytes a Range header asks for, first to last, or None if it cannot be met.
fn byte_range(range: &str, size: u64) -> Option<(u64, u64)> {
    let spec = range.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (first, last) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (size.saturating_sub(n), size.checked_sub(1)?)
    } else {
        let first: u64 = a.parse().ok()?;
        let last = if b.is_empty() { size.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(size.checked_sub(1)?) };
        (first, last)
    };
    (first <= last).then_some((first, last))
}

fn mime(path: &Path) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

fn send_file(out: &mut TcpStream, path: &Path, range: Option<&str>, head: bool) -> std::io::Result<()> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let common = format!(
        "Content-Type: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store",
        mime(path)
    );
    let (first, last, status) = match range {
        None => (0, size.saturating_sub(1), "200 OK"),
        Some(r) => match byte_range(r, size) {
            Some((a, b)) => (a, b, "206 Partial Content"),
            None => {
                return write!(
                    out,
                    "HTTP/1.1 416 Range Not Satisfiable\r\n{common}\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\n\r\n"
                );
            }
        },
    };
    let len = if size == 0 { 0 } else { last - first + 1 };
    let mut head_text = format!("HTTP/1.1 {status}\r\n{common}\r\nContent-Length: {len}\r\n");
    if range.is_some() {
        head_text += &format!("Content-Range: bytes {first}-{last}/{size}\r\n");
    }
    head_text += "\r\n";
    out.write_all(head_text.as_bytes())?;
    if !head {
        f.seek(SeekFrom::Start(first))?;
        // The player drops the connection once it has what it wants: not an error worth more.
        std::io::copy(&mut f.take(len), out)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(byte_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(byte_range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(byte_range("bytes=10-500", 100), Some((10, 99)));
        assert_eq!(byte_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=100-", 100), None);
        assert_eq!(byte_range("bytes=5-2", 100), None);
        assert_eq!(byte_range("bytes=0-", 0), None);
        assert_eq!(byte_range("items=0-", 100), None);
    }

    #[test]
    fn lists_a_folder_by_day_and_night() {
        let dir = std::env::temp_dir().join(format!("haze-folder-{}", uuid::Uuid::new_v4().simple()));
        for d in ["Days", "nights", "other"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in ["b.jpg", "a.MP4", "notes.txt", ".hidden.png", "Days/sun.png", "nights/moon.webm", "nights/x.gif", "other/no.png"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let s = |p: &str| dir.join(p).to_string_lossy().into_owned();
        let got = list_folder(&dir).unwrap();
        assert_eq!(got.root, vec![s("a.MP4"), s("b.jpg")]);
        assert_eq!(got.day, vec![s("Days/sun.png")]);
        assert_eq!(got.night, vec![s("nights/moon.webm")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serves_ranges_of_the_registered_file_only() {
        let dir = std::env::temp_dir().join(format!("haze-media-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.mp4");
        std::fs::write(&src, (0..=255u8).collect::<Vec<_>>()).unwrap();
        let copy = cache(&dir.join("cache"), Some(&src)).unwrap().unwrap();
        let u = url(&copy).unwrap();
        let rest = u.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let get = |path: &str, extra: &str| {
            let mut s = TcpStream::connect(host).unwrap();
            write!(s, "GET /{path} HTTP/1.1\r\nHost: x\r\n{extra}Connection: close\r\n\r\n").unwrap();
            let mut buf = Vec::new();
            // One request on this connection: read until the body's length is in.
            let mut r = BufReader::new(s);
            let mut head = String::new();
            loop {
                let mut l = String::new();
                r.read_line(&mut l).unwrap();
                if l == "\r\n" {
                    break;
                }
                head += &l;
            }
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .unwrap()
                .parse()
                .unwrap();
            buf.resize(len, 0);
            r.read_exact(&mut buf).unwrap();
            (head, buf)
        };
        let (head, body) = get(path, "Range: bytes=10-13\r\n");
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 10-13/256"));
        assert_eq!(body, vec![10, 11, 12, 13]);
        let (head, body) = get(path, "");
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body.len(), 256);
        let (head, _) = get("nottoken/in.mp4", "");
        assert!(head.starts_with("HTTP/1.1 404"));
        assert_eq!(url(&copy).unwrap(), u);
        // A new file takes the old one's place.
        url(&src).unwrap();
        let (head, _) = get(path, "");
        assert!(head.starts_with("HTTP/1.1 404"));
        cache(&dir.join("cache"), None).unwrap();
        assert_eq!(std::fs::read_dir(dir.join("cache")).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

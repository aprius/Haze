//! Text decoding/encoding that round-trips a file's encoding, BOM and line
//! endings, so saving never rewrites bytes the user did not touch.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16le,
    Utf16be,
    /// Legacy single-byte text (not valid UTF-8). Windows-1252 maps every
    /// byte to a character and back, so such files round-trip unchanged.
    Windows1252,
    /// UTF-8 with a few invalid bytes, kept as escape characters (see
    /// `ESCAPE_BASE`) and written back as the same bytes.
    Utf8Invalid,
    /// The same, after a UTF-8 BOM.
    Utf8BomInvalid,
}

/// Invalid bytes 0x80–0xFF of an otherwise UTF-8 file are shown as the
/// private-use characters U+F780–U+F7FF and saved as the original bytes
/// again, like Python's `surrogateescape` (Rust strings cannot hold lone
/// surrogates).
const ESCAPE_BASE: u32 = 0xF700;

fn is_escape(c: char) -> bool {
    (ESCAPE_BASE + 0x80..=ESCAPE_BASE + 0xFF).contains(&(c as u32))
}

/// The text with its invalid bytes escaped; `None` when it already holds
/// escape characters, which could not be told apart from escaped bytes.
fn escape_invalid(bytes: &[u8]) -> Option<String> {
    let mut out = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        if chunk.valid().chars().any(is_escape) {
            return None;
        }
        out.push_str(chunk.valid());
        for &b in chunk.invalid() {
            out.push(char::from_u32(ESCAPE_BASE + u32::from(b))?);
        }
    }
    Some(out)
}

fn unescape_invalid(content: &str, out: &mut Vec<u8>) {
    let mut buf = [0u8; 4];
    for c in content.chars() {
        if is_escape(c) {
            out.push((c as u32 - ESCAPE_BASE) as u8);
        } else {
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    Text {
        content: String,
        encoding: TextEncoding,
        eol: Eol,
    },
    Binary,
}

pub fn decode(bytes: &[u8]) -> Decoded {
    let (content, encoding) = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        match std::str::from_utf8(rest) {
            Ok(s) => (s.to_owned(), TextEncoding::Utf8Bom),
            Err(_) => match escape_invalid(rest) {
                Some(s) => (s, TextEncoding::Utf8BomInvalid),
                None => (
                    String::from_utf8_lossy(rest).into_owned(),
                    TextEncoding::Utf8Bom,
                ),
            },
        }
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        (s.into_owned(), TextEncoding::Utf16le)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        (s.into_owned(), TextEncoding::Utf16be)
    } else {
        if looks_binary(bytes) {
            return Decoded::Binary;
        }
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_owned(), TextEncoding::Utf8),
            Err(_) => match mostly_utf8(bytes).then(|| escape_invalid(bytes)).flatten() {
                // UTF-8 text with a stray byte: show it as UTF-8, keeping the byte.
                Some(s) => (s, TextEncoding::Utf8Invalid),
                // A legacy file (Latin-1 comments in old C# code…): decoding it as
                // lossy UTF-8 would turn every accented letter into U+FFFD on save.
                None => (
                    encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
                    TextEncoding::Windows1252,
                ),
            },
        }
    };
    let eol = detect_eol(&content);
    Decoded::Text {
        content,
        encoding,
        eol,
    }
}

/// More valid multi-byte UTF-8 characters than invalid sequences.
fn mostly_utf8(bytes: &[u8]) -> bool {
    let (mut valid, mut invalid) = (0usize, 0usize);
    for chunk in bytes.utf8_chunks() {
        valid += chunk.valid().chars().filter(|c| !c.is_ascii()).count();
        invalid += usize::from(!chunk.invalid().is_empty());
    }
    valid > invalid
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Majority line ending, LF when there are none.
pub fn detect_eol(s: &str) -> Eol {
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count() - crlf;
    if crlf > lf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

pub fn encode(content: &str, encoding: TextEncoding) -> Result<Vec<u8>> {
    Ok(match encoding {
        TextEncoding::Utf8 => content.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        TextEncoding::Utf16le => {
            let mut v = vec![0xFF, 0xFE];
            v.extend(content.encode_utf16().flat_map(u16::to_le_bytes));
            v
        }
        TextEncoding::Utf16be => {
            let mut v = vec![0xFE, 0xFF];
            v.extend(content.encode_utf16().flat_map(u16::to_be_bytes));
            v
        }
        TextEncoding::Windows1252 => {
            let (bytes, _, unmappable) = encoding_rs::WINDOWS_1252.encode(content);
            if unmappable {
                // encoding_rs would write `&#7879;` for them: refuse instead.
                bail!(
                    "the file is saved as Windows-1252, which cannot hold some of its characters"
                );
            }
            bytes.into_owned()
        }
        TextEncoding::Utf8Invalid => {
            let mut v = Vec::with_capacity(content.len());
            unescape_invalid(content, &mut v);
            v
        }
        TextEncoding::Utf8BomInvalid => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            unescape_invalid(content, &mut v);
            v
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(bytes: &[u8]) {
        match decode(bytes) {
            Decoded::Text {
                content, encoding, ..
            } => assert_eq!(encode(&content, encoding).unwrap(), bytes),
            Decoded::Binary => panic!("unexpected binary"),
        }
    }

    #[test]
    fn round_trips_encodings() {
        round_trip(b"namespace A;\nclass B {}\n");
        round_trip(b"\xEF\xBB\xBFnamespace A;\r\nclass B {}\r\n");
        round_trip(&encode("xin chào\r\n", TextEncoding::Utf16le).unwrap());
        round_trip(&encode("xin chào\n", TextEncoding::Utf16be).unwrap());
    }

    #[test]
    fn legacy_single_byte_files_round_trip() {
        // "// Größe" in Windows-1252, plus bytes 1252 leaves undefined.
        let latin1 = b"// Gr\xF6\xDFe\r\nclass A {} // \x81\x8D\x8F\x90\x9D\r\n";
        let Decoded::Text {
            content, encoding, ..
        } = decode(latin1)
        else {
            panic!()
        };
        assert_eq!(encoding, TextEncoding::Windows1252);
        assert!(content.starts_with("// Größe"));
        round_trip(latin1);
        assert!(encode("xin chào ệ", TextEncoding::Windows1252).is_err());
    }

    #[test]
    fn stray_bytes_in_utf8_files_survive_saving() {
        let mut stray = "// xin chào thế giới ".as_bytes().to_vec();
        stray.extend_from_slice(b"\xFF\xE2\x82\n");
        let Decoded::Text {
            content, encoding, ..
        } = decode(&stray)
        else {
            panic!()
        };
        assert_eq!(encoding, TextEncoding::Utf8Invalid);
        assert!(content.starts_with("// xin chào thế giới "));
        round_trip(&stray);
        // An edit elsewhere keeps the bytes as they were.
        let edited = content.replace("xin", "chào");
        let saved = encode(&edited, encoding).unwrap();
        assert!(saved.ends_with(b"\xFF\xE2\x82\n"));

        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice(&stray);
        round_trip(&bom);
        // Text that already holds an escape character cannot be escaped unambiguously.
        let mut ambiguous = "thế giới \u{F7A0} ".as_bytes().to_vec();
        ambiguous.extend_from_slice(b"\xFF");
        assert!(escape_invalid(&ambiguous).is_none());
        round_trip(&ambiguous);
    }

    #[test]
    fn detects_eol_and_bom() {
        let Decoded::Text {
            encoding,
            eol,
            content,
        } = decode(b"\xEF\xBB\xBFa\r\nb\r\nc\n")
        else {
            panic!()
        };
        assert_eq!(encoding, TextEncoding::Utf8Bom);
        assert_eq!(eol, Eol::Crlf);
        assert_eq!(content, "a\r\nb\r\nc\n");
    }

    #[test]
    fn detects_binary() {
        assert_eq!(decode(b"MZ\x90\x00\x03"), Decoded::Binary);
    }
}

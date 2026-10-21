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
        (
            String::from_utf8_lossy(rest).into_owned(),
            TextEncoding::Utf8Bom,
        )
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
            // UTF-8 text with a stray byte: show it as UTF-8.
            Err(_) if mostly_utf8(bytes) => (
                String::from_utf8_lossy(bytes).into_owned(),
                TextEncoding::Utf8,
            ),
            // A legacy file (Latin-1 comments in old C# code…): decoding it as
            // lossy UTF-8 would turn every accented letter into U+FFFD on save.
            Err(_) => (
                encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
                TextEncoding::Windows1252,
            ),
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
        // UTF-8 with one stray byte stays UTF-8.
        let mut stray = "// xin chào thế giới ".as_bytes().to_vec();
        stray.extend_from_slice(b"\xFF\n");
        let Decoded::Text { encoding, .. } = decode(&stray) else {
            panic!()
        };
        assert_eq!(encoding, TextEncoding::Utf8);
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
